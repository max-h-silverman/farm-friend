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

# ---------------------------------------------------------------------------
# Telnyx non-secret configuration
# ---------------------------------------------------------------------------
# Identifiers and a public verification key — NOT secrets, so they are plain variables rather
# than Secret Manager entries. The ed25519 public key is verification material; disclosing it
# grants nothing. Only `TELNYX_API_KEY` is a credential, and that lives in Secret Manager.

variable "telnyx_public_key" {
  description = "ed25519 webhook verification key, base64. MUST decode to exactly 32 bytes — a merely non-empty value passes startup and then fails every signature check."
  type        = string
}

variable "telnyx_messaging_profile_id" {
  description = "The messaging profile the from-number belongs to. A mismatch is rejected at send time."
  type        = string
}

variable "telnyx_from_number" {
  description = "Sending number in EXACT E.164. A non-E.164 value returns 400 on every send — this cost a long debugging session on 2026-07-27."
  type        = string

  validation {
    condition     = can(regex("^\\+[1-9][0-9]{7,14}$", var.telnyx_from_number))
    error_message = "telnyx_from_number must be exact E.164, e.g. +12065550123 — no spaces, dashes, or parentheses."
  }
}

variable "rotation_applied_at" {
  description = <<-EOT
    A rotation marker, e.g. `2026-07-29T17-35`. Bumped whenever a secret VERSION is added.

    Cloud Run binds `version = "latest"` at CONTAINER START, so `gcloud secrets versions add`
    changes nothing about what is serving and an apply only helps if it alters the revision
    template. On 2026-07-29 it did not: the apply reported "2 to change", applied cleanly, and
    produced no new revision after the secrets landed. Both services kept the pre-rotation
    `DATABASE_URL` against an already-reset Neon password and production was down ~25 minutes
    (B-021). Changing this value changes the template, which forces a new revision, which is
    what makes the container re-read every secret.

    It exists as a VARIABLE rather than a hand-run `gcloud run services update` because the
    emergency fix used exactly that command, and the env var it injected then existed only on
    the live services — so every subsequent `tofu plan` reported "2 to change" wanting to strip
    it. That standing drift is what made a no-op apply look like a real one. Declared here, the
    config round-trips and a clean tree plans clean.

    This does NOT replace `infra/deploy_assertions.py`, which verifies by effect that each
    serving revision is newer than every secret version it consumes. This forces the revision;
    that proves one happened. A forgotten bump here is precisely what the assertion catches.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}$", var.rotation_applied_at))
    error_message = "rotation_applied_at must look like 2026-07-29T17-35 (UTC, colons replaced by dashes, as `date -u +%Y-%m-%dT%H-%M` produces)."
  }
}

variable "cloud_run_host_suffix" {
  description = <<-EOT
    The per-project Cloud Run host suffix, e.g. `p5mfxfp5za-uw` in
    `farm-friend-web-p5mfxfp5za-uw.a.run.app`.

    An explicit input rather than a construction or a read-back, and both alternatives were tried:
    constructing it from the project number produced a URL Cloud Run does not use, and reading
    `.uri` off a service creates a self-cycle because every service needs `PUBLIC_BASE_URL`.

    Verify it against the live services after any apply:
      gcloud run services list --project farm-friend-vashon --format='value(status.url)'
  EOT
  type        = string
}
