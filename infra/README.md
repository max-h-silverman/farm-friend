# Farm Friend infrastructure

Terraform for the Cloud Run deployment. Runs against `farm-friend-vashon` in `us-west1`.

## What this owns, and what it deliberately does not

**Owns:** the APIs, the Artifact Registry repository, two Cloud Run services, the Cloud Tasks
queue, the Cloud Scheduler job, service accounts and their IAM, and the *existence* of five
Secret Manager secrets.

Those containers are database URL, phone-hash salt, administrator-password verifier, Telnyx API
key, and DeepInfra API key. `ADMIN_PASSWORD_HASH` mounts on the web service only; the worker cannot
read it.

**Does not own — on purpose:**

- **Secret VALUES.** Terraform creates each secret as an empty container; versions are added
  out of band with `gcloud secrets versions add`. A value passed through Terraform lands in
  state, and state is a file that gets copied, backed up, and read. `PHONE_HASH_SALT` in
  particular can never be rotated (it is the input to the only lookup key for every phone in
  the system), so leaking it into state is permanent.
- **The container image.** Built by Cloud Build and referenced BY DIGEST. Terraform never
  builds, and a deploy is always an explicit digest change — never "whatever `:latest` points
  at now", which is how two services end up running different code against one database.
- **The database.** Neon does not move. Every correctness guarantee in Farm Friend lives in
  Postgres, so the schema is migrated by `npm run db:migrate`, not from here.

## Layout

    main.tf                     providers, APIs, and the Artifact Registry repository
    iam.tf                      the two service accounts and every role binding
    secrets.tf                  the five secret containers (never their values)
    services.tf                 the two Cloud Run services
    work.tf                     the Cloud Tasks queue and the Cloud Scheduler job
    variables.tf                inputs
    outputs.tf                  the URLs and identities the app needs configured
    plan-assertions.py          safety properties of a PLAN, run before apply
    deploy_assertions.py        secret freshness of what is SERVING, run after apply
    test_deploy_assertions.py   tests for the above (its failure case cannot occur live)

## Rotating a secret

Adding a version is not enough. Cloud Run resolves `version = "latest"` when a container
**starts**, so a running container never re-reads it, and an apply that leaves the revision
template unchanged creates no new revision. That is B-021: production served a pre-rotation
`DATABASE_URL` against an already-reset Neon password for ~25 minutes, while the apply meant to
fix it reported "2 to change" and succeeded.

So a rotation is always two edits and two checks:

    printf %s "$VALUE" | gcloud secrets versions add farm-friend-<name> \
      --project farm-friend-vashon --data-file=-
    # then bump rotation_applied_at in terraform.tfvars — this forces the new revision
    tofu plan -var="image_digest=..." -out=/tmp/tf.plan
    tofu show -json /tmp/tf.plan | python3 plan-assertions.py   # marker present on both services
    tofu apply /tmp/tf.plan
    python3 deploy_assertions.py                                # revisions newer than versions

`plan-assertions.py` proves the mechanism is configured; `deploy_assertions.py` proves a revision
actually happened. Neither substitutes for the other — a forgotten `rotation_applied_at` bump
passes the first and fails the second.

## Landing an optional gated credential (geocoding, SMTP)

Two secrets are **gated behind a variable** rather than mounted unconditionally:
`mount_geocoding_key` (F-069) and `mount_smtp_password` (F-078). The gate is not ceremony. A
secret with **no versions** resolves to nothing when a container starts, and Cloud Run then
**refuses the revision** — so an unconditional mount would take the public map down in order to
add an optional feature, which is precisely backwards.

So landing one is three applies, not one:

    # 1. apply with the flag false — creates the EMPTY container and its IAM grant
    tofu apply ...

    # 2. add the version OUT OF BAND. Never through Terraform: a value given to Terraform is
    #    written to state in cleartext.
    printf %s "<value>" | gcloud secrets versions add farm-friend-smtp-password \
      --project farm-friend-vashon --data-file=-

    # 3. bump rotation_applied_at, then apply with the flag true
    tofu apply -var="mount_smtp_password=true" ...

`printf %s`, not `echo`. For the SMTP app password this bites harder than usual: Google displays
it as **four space-separated groups**, and both the spaces and a trailing newline must be stripped
— a credential carrying either looks right in every listing and fails SMTP authentication.

Setting the flag back to `false` and applying is the **kill switch** for either feature, and it
stops the capability without touching the credential. For SMTP the other half is revoking the app
password in the Google account, which is what to do if it is believed exposed: it authenticates as
VIGA's board mailbox.

For the administrator password, do not use the generic `printf` command. Run
`npm run admin:provision-password --workspace @farm-friend/web` from a private terminal; it reads
without echo and streams only the Argon2id verifier to Secret Manager. After deploying and proving
the new password, revoke every old administrator session per the main runbook.

## `terraform.tfvars` is gitignored

It holds non-secret Telnyx identifiers, the SMTP sender configuration, and three deployment
inputs. None of it is a credential — `TELNYX_API_KEY` and the SMTP app password both live in
Secret Manager — but it is environment-specific, so it is not committed. A fresh checkout must
recreate it with all eight values:

    telnyx_public_key           = "..."   # ed25519 webhook key, base64, MUST decode to 32 bytes
    telnyx_messaging_profile_id = "..."
    telnyx_from_number          = "+1..." # EXACT E.164 — anything else 400s on every send
    public_map_url              = "https://www.vigavashon.org/farm-stand-map"
    cloud_run_host_suffix       = "..."   # e.g. p5mfxfp5za-uw; see the bootstrapping note below
    rotation_applied_at         = "..."   # e.g. 2026-07-29T17-35; see "Rotating a secret"
    smtp_username               = "board@vigavashon.org"  # authenticates to the relay
    smtp_from_address           = "board@vigavashon.org"  # the visible From (F-078)
    smtp_from_name              = "VIGA"                  # display name; optional

`smtp_username` and `smtp_from_address` also have **no default**, for a reason specific to mail:
a wrong sender is not a visible failure. Mail either arrives from the wrong place or is rejected
by the relay's allowed-senders rule, and neither looks like a misconfiguration from inside the
app. `smtp_host` and `smtp_port` do carry defaults, because those are properties of the Google
relay rather than of this deployment — and `smtp_port` refuses 25, which Google Cloud blocks
outbound with no way to open it.

`public_map_url` and `rotation_applied_at` deliberately have **no default**. A default would be a value that silently
goes stale, and a stale marker reverts the revision template — un-restarting the containers a
rotation was supposed to restart, which is the B-021 failure wearing a different hat. Every one of
these fails at plan time when absent, which is the right failure.

## First run

Requires an `image_digest`, which means Cloud Build has already published one:

    gcloud builds submit --config cloudbuild.yaml --project farm-friend-vashon

Then:

    cd infra
    tofu init
    tofu plan -var="image_digest=sha256:..."

`plan` is free and reads nothing billable. `apply` provisions, so it needs explicit approval.

## The one bootstrapping wrinkle

The Cloud Tasks queue needs the worker's URL, and the worker needs the queue's name. Reading
`.uri` back off a service cannot break that cycle, because every service needs `PUBLIC_BASE_URL`
— including the worker — so a service ends up depending on itself.

So `services.tf` constructs the URL from an explicit `cloud_run_host_suffix` input. The format is
`https://SERVICE-<opaque>-<shortregion>.a.run.app`, e.g.
`farm-friend-worker-p5mfxfp5za-uw.a.run.app` — a per-project opaque suffix and a **shortened**
region, **not** the project number and not the full region name. An earlier version guessed
`SERVICE-PROJECTNUMBER.REGION.run.app` and would have pointed the queue and the scheduler at
nothing.

A wrong suffix fails **silently** — tasks and scheduled runs 404 forever while every service
looks healthy — which is why three assertions in `plan-assertions.py` pin it. Verify it against
the live services after any apply:

    gcloud run services list --project farm-friend-vashon --format='value(status.url)'
