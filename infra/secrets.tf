# The five sensitive values, as CONTAINERS ONLY.
#
# Terraform creates each secret and never its versions. A value supplied to Terraform is
# written to state in cleartext, and state is a file that gets copied to a bucket, pulled to
# laptops, and read by anyone who can read the bucket. That is a worse exposure than the one
# F-034 already exists to clean up.
#
# `PHONE_HASH_SALT` is the sharpest case: it is the input to the only lookup key for every
# phone in the system and CAN NEVER BE ROTATED — changing it orphans every hash with no way
# back. A leak of that value into state is therefore permanent and unfixable.
#
# Add versions out of band:
#
#   printf %s "$VALUE" | gcloud secrets versions add farm-friend-phone-hash-salt \
#     --project farm-friend-vashon --data-file=-
#
# Note `printf %s`, not `echo` — echo appends a newline, and a trailing newline in a salt or
# an API key produces a value that looks right in every listing and fails at runtime.

locals {
  # Prefixed so these never collide with the six legacy Firebase secrets still in this
  # project (TELNYX_API_KEY, TELNYX_PUBLIC_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY,
  # LLM_API_KEY, SMOKE_TEST_TOKEN). Two of those hold the SAME exposed Telnyx credentials
  # F-034 tracks; they are removed during retirement, not reused here.
  app_secrets = {
    database-url        = "Neon connection string. Pooled URL for the runtime; DDL uses the direct one."
    phone-hash-salt     = "NEVER ROTATE. Input to the only lookup key for every phone in the system."
    admin-password-hash = "Argon2id verifier for the fixed administrator. Web service only."
    telnyx-api-key      = "Telnyx delivery credential."
    deepinfra-api-key   = "DeepInfra model provider credential."
    # F-069. OPTIONAL, and the only secret here whose absence is a supported deployment: with no
    # version the onboarding form asks the farmer to tap the map, which is the pre-F-069
    # behaviour. Web service only — the worker never geocodes. BILLED PER CALL, so restrict the
    # key to the Geocoding API in the console; an unrestricted Maps key bills across every Maps
    # product. Rotatable, unlike the salt: a new version and a redeploy is the whole procedure.
    geocoding-api-key = "Google Geocoding key for the onboarding draft pin. Optional; web only; billed per call."
    # F-078. The 16-character Google Workspace app password for `board@vigavashon.org`, used to
    # authenticate to `smtp-relay.gmail.com`. Web service only — the worker sends no email.
    #
    # This is a REAL CREDENTIAL TO VIGA'S BOARD MAILBOX, not a scoped API key: an app password
    # authenticates as the account. That is the trade max accepted so replies reach a mailbox
    # VIGA actually reads. It is revocable from the same Google account page that issued it,
    # which is the containment — rotation is "revoke, generate, add a version, redeploy".
    #
    # Optional at the application layer for the same reason as geocoding: with no version the
    # email seam is unconfigured and email verification is simply unavailable, rather than the
    # deployment failing.
    smtp-password = "Google Workspace app password for the SMTP relay. Optional; web only; authenticates as the board mailbox."
  }
}

// The prior collection was protected by `prevent_destroy`. F-056 must retire exactly one
// member (the magic-link secret) while preserving that protection for every desired secret.
// Terraform evaluates lifecycle rules from the configuration at a resource address, so
// removing one `for_each` key from that protected address makes its required destruction
// impossible. Move the four existing survivors to a new protected address; the unmoved magic
// key is then an explicit deletion in the plan, subject to the production approval gate.
moved {
  from = google_secret_manager_secret.app["database-url"]
  to   = google_secret_manager_secret.protected["database-url"]
}

moved {
  from = google_secret_manager_secret.app["phone-hash-salt"]
  to   = google_secret_manager_secret.protected["phone-hash-salt"]
}

moved {
  from = google_secret_manager_secret.app["telnyx-api-key"]
  to   = google_secret_manager_secret.protected["telnyx-api-key"]
}

moved {
  from = google_secret_manager_secret.app["deepinfra-api-key"]
  to   = google_secret_manager_secret.protected["deepinfra-api-key"]
}

resource "google_secret_manager_secret" "protected" {
  for_each = local.app_secrets

  secret_id = "farm-friend-${each.key}"

  labels = {
    app        = "farm-friend"
    managed-by = "terraform"
  }

  replication {
    auto {}
  }

  # A secret is not something to lose to a `tofu destroy` that was meant to remove a service.
  # Deleting the container deletes every version in it, and `PHONE_HASH_SALT` is
  # unrecoverable by design — there is no re-derivation, only an orphaned database.
  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}
