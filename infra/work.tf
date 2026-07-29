# The two triggers: the durable fast path, and the recovery net.
#
# They are deliberately different mechanisms with different jobs, and the distinction is the
# one B-009 was filed over. The queue makes a reply FAST. The schedule makes the system
# CORRECT. Neither substitutes for the other, and if the queue were deleted entirely only
# latency tests should fail.

# ---------------------------------------------------------------------------
# Cloud Tasks — the fast path
# ---------------------------------------------------------------------------
resource "google_cloud_tasks_queue" "inbound" {
  name     = "farm-friend-inbound"
  location = var.region

  rate_limits {
    # Bounded well below what Neon or the worker could absorb. A burst of inbound SMS should
    # queue, not stampede: the worker holds row locks per sender, so arrival rate above this
    # buys contention rather than throughput.
    max_dispatches_per_second = 10
    max_concurrent_dispatches = 5
  }

  retry_config {
    # Retries matter because this is the DURABLE path — a task that fails must come back.
    # Five attempts over an hour covers a worker restart, a deploy, and a brief Neon blip.
    max_attempts       = 5
    min_backoff        = "5s"
    max_backoff        = "300s"
    max_retry_duration = "3600s"
    max_doublings      = 4
  }

  depends_on = [google_project_service.required]
}

# ---------------------------------------------------------------------------
# Cloud Scheduler — the recovery net
# ---------------------------------------------------------------------------
# THE durable guarantee, and the only trigger for F-026's retention purge.
#
# This replaces two things at once: Vercel's `vercel.json` cron (which the Hobby plan rejected,
# so every production deploy stripped the block by hand and the deployed system ran NO
# scheduled pass at all), and the GitHub Actions workflow added to cover that gap — whose
# `*/5` schedule was observed firing roughly HOURLY, because GitHub drops most slots.
#
# A real minute schedule, enforced by the platform, is the point.
resource "google_cloud_scheduler_job" "recovery" {
  name        = "farm-friend-recovery"
  region      = var.region
  description = "Runs the four bounded passes: inbound, outbound, delivery, retention."
  schedule    = var.scheduler_schedule
  time_zone   = "Etc/UTC"

  # Matches the worker's own 300s timeout. A shorter deadline here would abandon a pass the
  # worker is still legitimately running and retry work already in flight.
  attempt_deadline = "300s"

  retry_config {
    # ONE retry, deliberately. Unlike a task, a missed scheduled pass is not lost work — the
    # next minute's run does the same enumeration and picks up everything still pending. Piling
    # up retries of a failing pass would multiply load on whatever is already failing.
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "${local.worker_url}/api/internal/cron"

    # OIDC, not a shared secret. This is what replaced `CRON_SECRET` — a credential that lived
    # in two places that had to match, where a mismatch returned 401 and 401 looks identical to
    # success in any scheduler's UI. An identity Google mints and verifies cannot drift out of
    # sync with itself.
    oidc_token {
      service_account_email = google_service_account.invoker.email
      audience              = local.worker_url
    }
  }

  depends_on = [
    google_project_service.required,
    google_cloud_run_v2_service_iam_member.worker_invoker,
  ]
}

# ---------------------------------------------------------------------------
# Budget alert
# ---------------------------------------------------------------------------
# The steady state of this deployment is meant to be near zero, so any real spend is a signal
# rather than a threshold to tune. Created only when a billing account is supplied, because
# budgets need billing-account-level permission the deploying identity may not hold — and a
# missing permission should not block the whole apply.
#
# An alert REPORTS overruns; it does not cap spending. There is no hard spending limit on GCP.
resource "google_billing_budget" "alert" {
  count = var.billing_account_id == "" ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "Farm Friend spend"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.billing_alert_amount)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 1.0
  }
}
