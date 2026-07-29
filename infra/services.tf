# The two Cloud Run services.
#
# ONE IMAGE, TWO SERVICES, ONE DIGEST. `DEPLOYMENT_ROLE` is the only difference in what they
# run; everything else about the container is identical, and both are pinned to the same
# `var.image_digest`. That is what makes "the web service and the worker run the same code" a
# structural fact rather than a deployment convention — a tag could be repointed between two
# applies and let them drift silently.

locals {
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/farm-friend@${var.image_digest}"

  # Cloud Run URLs are deterministic, which breaks the bootstrap cycle: the Cloud Tasks queue
  # needs the worker's URL, and the worker's environment needs the queue's name. Constructing
  # the URL avoids a two-stage apply.
  #
  # If Google ever changes this format, `plan` fails loudly rather than producing a wrong URL
  # — and a wrong target URL is the bad failure here, because tasks would 404 forever while
  # the scheduled pass quietly carried all the traffic and nothing looked broken.
  worker_url = "https://farm-friend-worker-${data.google_project.this.number}.${var.region}.run.app"

  # Configuration shared by both roles. Non-secret values only; the five sensitive ones are
  # mounted from Secret Manager below.
  common_env = {
    LLM_PROVIDER                = "deepinfra"
    DEEPINFRA_MODEL             = "mistralai/Mistral-Small-24B-Instruct-2501"
    SMS_PROVIDER                = "telnyx"
    TELNYX_MESSAGING_PROFILE_ID = "" # set from the live console value at apply time
    TELNYX_FROM_NUMBER          = ""
    TELNYX_PUBLIC_KEY           = ""
    PUBLIC_BASE_URL             = ""
  }

  secret_env = {
    DATABASE_URL      = google_secret_manager_secret.app["database-url"].secret_id
    PHONE_HASH_SALT   = google_secret_manager_secret.app["phone-hash-salt"].secret_id
    MAGIC_LINK_SECRET = google_secret_manager_secret.app["magic-link-secret"].secret_id
    TELNYX_API_KEY    = google_secret_manager_secret.app["telnyx-api-key"].secret_id
    DEEPINFRA_API_KEY = google_secret_manager_secret.app["deepinfra-api-key"].secret_id
  }
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
        for_each = local.secret_env
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
        for_each = local.secret_env
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
