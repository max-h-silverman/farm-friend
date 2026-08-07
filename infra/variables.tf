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

    The stock-out model-cost throttle is intentionally in-memory (`createPublicActionThrottle`).
    With more than one instance that budget multiplies by the instance count, because each process
    keeps its own map. Administrator login has its own durable Postgres throttle. Raising this
    requires a deliberate distributed design for the remaining stock-out budget.
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
# SMTP non-secret configuration (F-078)
# ---------------------------------------------------------------------------
# The relay host, the port, the authenticating account, and the visible sender. None is a
# credential — only the app password is, and it lives in Secret Manager.

variable "smtp_host" {
  description = "SMTP relay host. `smtp-relay.gmail.com` for the Google Workspace relay."
  type        = string
  default     = "smtp-relay.gmail.com"
}

variable "smtp_port" {
  description = <<-EOT
    SMTP submission port. 587 (STARTTLS) — Google Cloud BLOCKS OUTBOUND PORT 25 with no way to
    open it, so a relay reached on 25 fails from Cloud Run no matter how it is configured.
  EOT
  type        = number
  default     = 587

  validation {
    condition     = var.smtp_port != 25
    error_message = "Port 25 is blocked outbound on Google Cloud and can never work from Cloud Run. Use 587."
  }
}

variable "smtp_username" {
  description = <<-EOT
    The Workspace account that AUTHENTICATES to the relay — `board@vigavashon.org`.

    Distinct from `smtp_from_address` on purpose, even though they are the same account today.
    The relay is configured for "only addresses in my domains", under which the authenticating
    account need not match the visible From. Keeping them separate is what makes moving to a
    dedicated sending address later a configuration change rather than a code change.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$", var.smtp_username))
    error_message = "smtp_username must be a single email address with no whitespace."
  }
}

variable "smtp_from_name" {
  description = <<-EOT
    The display name recipients see in their mail client — `VIGA` (max, 2026-08-06).

    Without it a farmer sees the bare mailbox, "board", which says nothing about who is
    writing and is exactly the kind of unfamiliar sender that gets a reply asking what it is.

    OPTIONAL, unlike the address: only the address is load-bearing, since it is what the relay
    authorizes and where replies return. `resolveEmailConfig` refuses quotes, angle brackets,
    and line breaks here, because a display name is folded into the From header and those
    characters can restructure it.
  EOT
  type        = string
  default     = ""
}

variable "smtp_from_address" {
  description = <<-EOT
    The visible From address on every message Farm Friend sends — `board@vigavashon.org`.

    max's call (2026-08-06), and the reason is replies: a farmer who gets a verification code
    and is confused will reply to it, and a dedicated `farmfriend@` address would be a mailbox
    nobody watches, so the reply would land nowhere. `board@` is the address VIGA already reads.

    CONFIGURATION, never a hard-coded string — that is what makes moving to a dedicated address
    a config change. Its absence must fail the deployment plan rather than fall back to a
    default, because a wrong sender is not a visible failure: mail simply arrives from the wrong
    place, or is rejected by the relay's allowed-senders rule.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$", var.smtp_from_address))
    error_message = "smtp_from_address must be a single email address with no whitespace."
  }
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

variable "public_map_url" {
  description = "Canonical public page hosting Farm Friend's live map. MAP returns this exact URL; an absent value must fail the deployment plan rather than sending an old link."
  type        = string

  validation {
    condition     = can(regex("^https://[^[:space:]]+$", var.public_map_url))
    error_message = "public_map_url must be an absolute HTTPS URL without whitespace."
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

variable "mount_geocoding_key" {
  description = <<-EOT
    Whether the WEB service mounts `GEOCODING_API_KEY` (F-069).

    False until the secret actually holds a version. `version = "latest"` is resolved when a
    container STARTS, and a secret with no versions resolves to nothing — Cloud Run then refuses
    the revision. Mounting the empty container would take the public map down in order to add an
    optional feature, which is the exact opposite of the intended property: geocoding's absence is
    a supported deployment, and the form degrades to pin-dropping.

    So the order is three steps, not one:

      1. apply with this false — creates the empty secret container
      2. printf %s "<key>" | gcloud secrets versions add farm-friend-geocoding-api-key \
           --project farm-friend-vashon --data-file=-
      3. apply with this true — the web service mounts it and a new revision picks it up

    Setting it back to false is also the kill switch: apply, and address lookup stops without
    touching the key or the application.
  EOT
  type        = bool
  default     = false
}

variable "mount_smtp_password" {
  description = <<-EOT
    Whether the WEB service mounts `SMTP_PASSWORD` (F-078).

    Exactly the same three-step gate as `mount_geocoding_key`, and for exactly the same reason:
    `version = "latest"` is resolved when a container STARTS, and a secret with no versions
    resolves to nothing — Cloud Run then refuses the revision. Mounting the empty container
    would take the public map down in order to add email verification.

      1. apply with this false — creates the empty secret container
      2. printf %s "<16-char app password>" | gcloud secrets versions add farm-friend-smtp-password \
           --project farm-friend-vashon --data-file=-
      3. apply with this true — the web service mounts it and a new revision picks it up

    Note `printf %s`, not `echo`: Google displays the app password in four space-separated
    groups, and a trailing newline (or a retained space) produces a credential that looks right
    in every listing and fails SMTP authentication.

    Setting it back to false is the kill switch: apply, and email sending stops without touching
    the credential. Revoking the app password in the Google account is the other half, and is
    what to do if it is believed exposed — it authenticates as the board mailbox.
  EOT
  type        = bool
  default     = false
}

variable "mount_email_verification" {
  description = <<-EOT
    Whether the WEB service mounts F-079's three values: `EMAIL_HASH_SALT`,
    `VERIFICATION_CODE_SALT`, and `FARMER_START_SECRET`.

    Same three-step gate as `mount_geocoding_key` and `mount_smtp_password`, for the same
    platform reason: `version = "latest"` resolves when a container STARTS, and a secret with no
    versions resolves to nothing — Cloud Run refuses the revision. Mounting empty containers
    would take the public map down in order to add the farmer migration door.

      1. apply with this false — creates the three empty containers
      2. add a version to each, out of band (see below)
      3. apply with this true — the web service mounts them and a new revision picks them up

    **ALL THREE MOVE TOGETHER, deliberately.** The two salts are REQUIRED by the verify routes,
    so a deployment holding the door secret without them serves a door that 500s on a farmer's
    first use. One flag makes that state unrepresentable.

    **`EMAIL_HASH_SALT` MUST EQUAL WHATEVER THE ROSTER INGEST USED** (max, 2026-08-07: the
    ingest runs first and decides this value). A mismatch is this feature's quietest failure —
    every farmer's correct address fails to match, nothing raises an error, and the door appears
    to work while verifying nobody. It can NEVER be rotated afterwards without re-ingesting the
    roster.

      printf %s "<salt the ingest used>" | gcloud secrets versions add farm-friend-email-hash-salt \
        --project farm-friend-vashon --data-file=-
      printf %s "$(openssl rand -hex 32)" | gcloud secrets versions add farm-friend-verification-code-salt \
        --project farm-friend-vashon --data-file=-
      printf %s "$(openssl rand -hex 24)" | gcloud secrets versions add farm-friend-farmer-start-secret \
        --project farm-friend-vashon --data-file=-

    Note `printf %s`, not `echo`: a trailing newline in a salt produces hashes that look right
    in every listing and match nothing at runtime.

    Setting it back to false is the kill switch: apply, and the migration door closes and
    verification stops, without touching any stored value. Rotating
    `farmer-start-secret` alone is safe and cheap — it only invalidates links VIGA has already
    sent out.
  EOT
  type        = bool
  default     = false
}
