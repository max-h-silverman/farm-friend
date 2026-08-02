# The two Cloud Run services.
#
# ONE IMAGE, TWO SERVICES, ONE DIGEST. `DEPLOYMENT_ROLE` is the only difference in what they
# run; everything else about the container is identical, and both are pinned to the same
# `var.image_digest`. That is what makes "the web service and the worker run the same code" a
# structural fact rather than a deployment convention — a tag could be repointed between two
# applies and let them drift silently.

locals {
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/farm-friend@${var.image_digest}"

  # Service URLs, built from an EXPLICIT host suffix.
  #
  # This looks like the mistake it replaces, so the difference matters. The first version GUESSED
  # the format as `SERVICE-PROJECTNUMBER.REGION.run.app`; Cloud Run actually assigns
  # `farm-friend-worker-p5mfxfp5za-uw.a.run.app` — a per-project opaque suffix and a SHORTENED
  # region. That guess was wrong and would have pointed the queue and the scheduler at nothing.
  #
  # Reading `.uri` off the resources is the obvious fix and it cannot work here: every service
  # needs `PUBLIC_BASE_URL` (the worker's `resolveConfig` requires it), so any URL read from a
  # service and fed back into shared config makes that service depend on itself. Two applies hit
  # that cycle from different directions.
  #
  # So the suffix is an INPUT, verified against the live services rather than assumed
  # (`cloud_run_host_suffix` in variables.tf, checked by `infra/plan-assertions.py`). It is stable
  # for the life of the project — Cloud Run derives it per project+region — and if it were ever
  # wrong, the assertions fail at plan time instead of the fast path silently 404ing forever.
  worker_url = "https://farm-friend-worker-${var.cloud_run_host_suffix}.a.run.app"
  web_url    = "https://farm-friend-web-${var.cloud_run_host_suffix}.a.run.app"

  # Configuration shared by both roles. Non-secret values only; the five sensitive ones are
  # mounted from Secret Manager below.
  common_env = {
    LLM_PROVIDER                = "deepinfra"
    DEEPINFRA_MODEL             = "mistralai/Mistral-Small-24B-Instruct-2501"
    SMS_PROVIDER                = "telnyx"
    TELNYX_MESSAGING_PROFILE_ID = var.telnyx_messaging_profile_id
    TELNYX_FROM_NUMBER          = var.telnyx_from_number
    TELNYX_PUBLIC_KEY           = var.telnyx_public_key
    PUBLIC_BASE_URL             = local.web_url

    # ROTATION_APPLIED_AT — the reason a rotated secret reaches running containers at all.
    #
    # The application never reads this. Its only job is to be part of the revision template:
    # `version = "latest"` is resolved when a container STARTS, so adding a secret version
    # changes nothing that is already running, and an apply that leaves the template identical
    # creates no revision to re-read it. Bumping this value changes the template, which forces
    # a new revision, which re-resolves every secret. See `variables.tf` for the B-021 outage
    # this comes from.
    ROTATION_APPLIED_AT = var.rotation_applied_at
  }

  # PUBLIC_BASE_URL — BOTH services need it, and it is always the PUBLIC service's URL.
  #
  # The worker requires it too: `resolveConfig` demands it before any pass runs, and it fails
  # closed. An earlier revision here set it only on the web service, on the reasoning that it is
  # "the public service's own identity" — the worker then crashed every scheduled run with
  # `ConfigurationError: PUBLIC_BASE_URL is required`. Caught by reading the worker's logs after
  # forcing a scheduled run, not by any check that passed.
  #
  # It is derived from the worker's real URL rather than read from the web service's own `uri`,
  # because a service referencing itself is a dependency self-cycle. Both services share one
  # per-project host suffix, so substituting the name is exact.
  #
  # Configuration rather than a derived `Host:` header on purpose: farmer links are bearer
  # credentials and must never be built against an attacker-controlled origin.

  shared_secret_env = {
    DATABASE_URL      = google_secret_manager_secret.app["database-url"].secret_id
    PHONE_HASH_SALT   = google_secret_manager_secret.app["phone-hash-salt"].secret_id
    TELNYX_API_KEY    = google_secret_manager_secret.app["telnyx-api-key"].secret_id
    DEEPINFRA_API_KEY = google_secret_manager_secret.app["deepinfra-api-key"].secret_id
  }

  # Password verification is a public-service concern. The worker neither mounts nor can
  # accidentally read this value from its process environment.
  web_secret_env = merge(local.shared_secret_env, {
    ADMIN_PASSWORD_HASH = google_secret_manager_secret.app["admin-password-hash"].secret_id
  })
}

# ---------------------------------------------------------------------------
# The public service
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "web" {
  name     = "farm-friend-web"
  location = var.region

  # The map, the QR stock-out form, and the Telnyx webhook are all reached by anonymous
  # callers, so ingress is genuinely open. Each route carries its own authentication.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email

    scaling {
      # ZERO minimum. The whole cost case rests on this: an idle service bills nothing, and
      # the legacy system's $1.57/month was two functions held warm for 1 request in 30 days.
      min_instance_count = 0
      max_instance_count = var.public_max_instances
    }

    # Request-based billing. CPU is allocated only while a request is in flight, which is
    # also why the legacy min-instance charge was memory-only.
    max_instance_request_concurrency = 20

    containers {
      image = local.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # CPU throttled between requests, which is what request-based billing means.
        cpu_idle = true
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "DEPLOYMENT_ROLE"
        value = "web"
      }

      # The queue this service enqueues into. The worker does not enqueue, so it gets none of
      # these — a partial configuration is a startup error by design, and absent is the
      # legitimate "no queue here" case.
      env {
        name  = "CLOUD_TASKS_PROJECT"
        value = var.project_id
      }
      env {
        name  = "CLOUD_TASKS_LOCATION"
        value = var.region
      }
      env {
        name  = "CLOUD_TASKS_QUEUE"
        value = google_cloud_tasks_queue.inbound.name
      }
      env {
        name  = "CLOUD_TASKS_TARGET_URL"
        value = "${local.worker_url}/api/internal/kick"
      }
      env {
        name  = "CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT"
        value = google_service_account.invoker.email
      }


      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.web_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret = env.value
              # `latest`, so adding a new version and restarting picks it up. Rotation is
              # then "add a version, redeploy" rather than "edit Terraform".
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/api/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
        timeout_seconds       = 3
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_iam_member.runtime_reads,
  ]
}

# ---------------------------------------------------------------------------
# The worker
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "worker" {
  name     = "farm-friend-worker"
  location = var.region

  # INTERNAL ONLY. This is the primary control on the routes that drive consent transitions
  # and outbound SMS — enforced by Google before a request reaches the container. Cloud Tasks
  # and Cloud Scheduler reach it from within the project; nothing on the public internet can.
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = 0
      # Bounded so five Postgres connections per process cannot exhaust Neon. The passes hold
      # row locks, so more instances here is contention on the same rows, not throughput.
      max_instance_count = var.worker_max_instances
    }

    # One request at a time. A pass is a bounded unit of work holding database locks;
    # overlapping them inside one process buys nothing and makes lock contention harder to
    # reason about. Concurrency across senders comes from the queue, not from this number.
    max_instance_request_concurrency = 1

    # Long enough for a full scheduled pass — four bounded passes, each of which may make
    # model and provider calls — with room to spare. Cloud Scheduler's own deadline is set to
    # match in work.tf.
    timeout = "300s"

    containers {
      image = local.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "DEPLOYMENT_ROLE"
        value = "worker"
      }

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.shared_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/api/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
        timeout_seconds       = 3
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_iam_member.runtime_reads,
  ]
}
