# Farm Friend infrastructure

Terraform for the Cloud Run deployment. Runs against `farm-friend-vashon` in `us-west1`.

## What this owns, and what it deliberately does not

**Owns:** the APIs, the Artifact Registry repository, two Cloud Run services, the Cloud Tasks
queue, the Cloud Scheduler job, service accounts and their IAM, and the *existence* of five
Secret Manager secrets.

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

    main.tf        providers, APIs, and the Artifact Registry repository
    iam.tf         the two service accounts and every role binding
    secrets.tf     the five secret containers (never their values)
    services.tf    the two Cloud Run services
    work.tf        the Cloud Tasks queue and the Cloud Scheduler job
    variables.tf   inputs
    outputs.tf     the URLs and identities the app needs configured

## First run

Requires an `image_digest`, which means Cloud Build has already published one:

    gcloud builds submit --config cloudbuild.yaml --project farm-friend-vashon

Then:

    cd infra
    tofu init
    tofu plan -var="image_digest=sha256:..."

`plan` is free and reads nothing billable. `apply` provisions, so it needs explicit approval.

## The one bootstrapping wrinkle

The Cloud Tasks queue needs the worker's URL, and the worker needs the queue's name. Cloud Run
URLs are deterministic (`https://SERVICE-PROJECTNUMBER.REGION.run.app`), so `services.tf`
constructs the worker URL rather than reading it back — breaking the cycle without a two-stage
apply. If Google ever changes that URL format this breaks loudly at plan time, which is the
right failure: a wrong URL means tasks 404 forever and the fast path is silently dead.
