variable "project_id" {
  description = "The GCP project. This is the migration target, not the stray farm-friend-497422."
  type        = string
  default     = "farm-friend-vashon"
}

variable "region" {
  description = "Region for Cloud Run, Tasks, Scheduler, and Artifact Registry. Neon is us-west-2; us-west1 keeps the database round trip short."
  type        = string
  default     = "us-west1"
}

variable "image_digest" {
  description = <<-EOT
    The container image digest to deploy, as `sha256:...`.

    A DIGEST, never a tag. Both services are pinned to the same one, which is what makes
    "the web service and the worker run identical code" a fact rather than a hope. A tag
    can be repointed between two applies and would let the two drift apart silently.
  EOT
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be a full sha256 digest, e.g. sha256:abc... (64 hex chars). A tag is not accepted."
  }
}

variable "public_max_instances" {
  description = <<-EOT
    Maximum instances for the PUBLIC service. Deliberately 1 at launch.

    The abuse and sign-in throttles are intentionally in-memory and non-durable
    (`createPublicActionThrottle`). With more than one instance those budgets multiply by the
    instance count, because each process keeps its own map — a 5-per-minute limit becomes
    5N-per-minute with no code change and nothing reporting it. Raising this requires a
    deliberate distributed-throttle design, not just a bigger number here.
  EOT
  type        = number
  default     = 1
}

variable "worker_max_instances" {
  description = <<-EOT
    Maximum instances for the WORKER service.

    Bounded so that five Postgres connections per process cannot exhaust Neon. The worker is
    the only service that runs the passes, and each pass holds row locks, so concurrency here
    is contention on the same rows rather than throughput.
  EOT
  type        = number
  default     = 2
}

variable "scheduler_schedule" {
  description = <<-EOT
    Cron expression for the recovery pass.

    Every minute. This is the durable net for anything the Cloud Tasks fast path misses, and
    the ONLY trigger for F-026's retention purge — which is why it is not tuned down to save
    invocations. It replaces the GitHub Actions `*/5` workflow, whose schedule was observed to
    fire roughly HOURLY because GitHub drops most slots.
  EOT
  type        = string
  default     = "* * * * *"
}

variable "billing_alert_amount" {
  description = "USD threshold for the budget alert. The whole point of this migration is that the steady state is near zero, so any real spend is a signal."
  type        = number
  default     = 5
}

variable "billing_account_id" {
  description = "Billing account for the budget alert. Empty disables the budget resource, since the alert needs billing-account-level permission the deploying identity may not hold."
  type        = string
  default     = ""
}
