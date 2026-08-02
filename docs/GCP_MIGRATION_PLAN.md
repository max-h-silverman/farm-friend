# Transition Farm Friend from Vercel to GCP

**Status:** **COMPLETE — cutover and retirement both done 2026-07-29.** This document is now a
historical record of the migration's reasoning, not a work order. Build status lives in CLAUDE.md
"Current State"; the operating procedure lives in RUNBOOK §Deploy. Two notes for anyone reading it
as evidence: the "Retirement" section's premise that the legacy project held no real data was
**wrong** — reading Firestore found 37 documents, archived before deletion — and the seven legacy
schedulers were already `PAUSED` by the time retirement ran, not still firing as recorded below.  
**Prepared:** 2026-07-28  
**Reviewed:** 2026-07-28 (claims verified against the live projects; see "Verification of this plan")

## Why this migration happens

The driver is a **fixed monthly cost VIGA has no budget for**, not a technical defect on Vercel.

Vercel's Fair Use Guidelines restrict Hobby teams to "non-commercial personal use only," and
define commercial usage as any deployment serving "the purpose of financial gain of **anyone**
involved in **any part of the production** of the project," explicitly listing "advertising the
sale of a product or service." Farm Friend is operated for an association whose members sell
produce, and its purpose is directing customers to those stands. Donations are named as commercial
usage too, so nonprofit status is not an exemption. Vercel may disable a Hobby deployment
**without notice, at its discretion** — an unacceptable failure mode for a system farmers rely on
for SMS. Hobby is therefore not a legitimate indefinite home, and Pro is a standing ~$20/month
charge against a zero budget.
[Vercel fair use](https://vercel.com/docs/limits/fair-use-guidelines)

Two independent gains, which would justify the move at equal cost:

- **Durability.** `waitUntil` shares the function timeout and is cancelled when it elapses, so the
  kick is best-effort *by construction*. Cloud Tasks is a durable, retryable queue. The
  architecture wants a durable trigger and currently settles for a cancellable one.
- **Deploy hygiene.** Hobby rejects `vercel.json`'s one-minute cron, so every production deploy
  strips the `crons` block from the working tree by hand and GitHub's Vercel check is permanently
  red on `main`. A manual step with a silent failure mode leaves the deploy path.

**Nothing in Farm Friend's architecture resists the move.** Every guarantee is enforced in
Postgres, not the platform — deduplication (unique provider event ID), per-sender serialization
(`sender_states` row lock), exactly-once confirmation (`on conflict … do nothing returning`),
consent ordering (the watermark), the dispatch claim (`for update skip locked` + lease), and
duplicate delivery events (a migration-0001 trigger *and* `applyDeliveryEvent`). Neon does not
move, so the correctness core migrates untouched.

## Summary

Move the current application to `farm-friend-vashon` while retaining Neon PostgreSQL:

- One container image deployed as two Cloud Run services in `us-west1`:
  - Public web/API/webhook service.
  - Private scheduled/task worker.
- Cloud Tasks replaces Vercel `waitUntil` for immediate SMS processing.
- Cloud Scheduler invokes recovery/delivery/retention every minute.
- Both services use request-based billing, zero minimum instances, and bounded scaling.
- Terraform owns infrastructure; production deploys are manual and approval-gated.
- After verified cutover, archive and remove Vercel plus the obsolete Firebase/Cloud Functions
  system.

At launch traffic, the new GCP runtime should remain around $0/month, excluding Neon, Telnyx,
DeepInfra, and any billing-account-wide free-tier consumption.

## Review Findings and Target Architecture

- The codebase is portable Node/Next.js:
  - Production build passes.
  - No Edge runtime, WebSockets, file persistence, Vercel storage, CDN dependency, or Vercel
    database integration.
  - PostgreSQL transactions, locks, triggers, and constraints remain unchanged on Neon.
- Vercel-specific dependencies are limited to:
  - `@vercel/functions` and `waitUntil` in the SMS webhook.
  - `apps/web/vercel.json`.
  - Vercel/GitHub scheduler tests, deployment documentation, and hard-coded deployment URL.
- Runtime constraints to preserve:
  - Five PostgreSQL connections per process.
  - Immediate SMS processing plus an independent recovery schedule.
  - Exactly-once inbox/outbox behavior and ambiguous-send protection.
  - Privacy-safe logs and coarse abuse throttling.
- Existing GCP infrastructure is obsolete:
  - 17 Python functions, seven schedules, Firestore, Firebase Hosting/Auth resources, six secrets,
    and old build artifacts.
  - **Two functions are always-warm** — `inbound-sms` and `simulate-inbound-sms` carry `minScale=1`
    at 0.33 vCPU / 512 MiB each (verified 2026-07-28 by `gcloud run services list`; the other
    fifteen are unset). Measured, not inferred: both held exactly 1 idle instance across 180 of 180
    consecutive monitoring intervals, while `health` (no `minScale`) reports no instance data at
    all. Traffic over the same window was **1 request in 30 days** on `inbound-sms` and **0** on
    `simulate-inbound-sms`.
  - **CORRECTED 2026-07-28 against the actual bill: this costs $1.57/month, not $15–25.** The
    billing console attributes it to the SKU *"Cloud Run functions Min-Instance **Memory**
    (Request-based billing)"* — memory only, with **no** matching Min-Instance CPU line. Under
    request-based billing, idle CPU on a held instance is not charged; only held memory is. Every
    earlier estimate here assumed idle CPU billed at some rate and was wrong by roughly 13×.
    Whole-billing-account spend is $12.22/month across all projects, of which Farm Friend is $1.57.
  - **This is housekeeping, not a driver.** An earlier draft called setting `minScale=0` "the single
    highest-value action in this document"; at $1.57/month it is not, and the migration's case never
    rested on it. **It also cannot be performed** — see below.
  - **The legacy services are unredeployable zombies.** `gcf-artifacts` lists **zero images** for 17
    functions; the container images were garbage-collected. The running instances survive only on
    Cloud Run's cached layers — they still serve (403/400, not connection errors), but every attempt
    to create a revision fails `image not found`, including one pinned to the exact digest the live
    revision reports. So `minScale=0` is impossible; the only way to stop the charge is to **delete
    the services**, which is a destructive step requiring approval. Related inconsistency: the live
    `inbound-sms` revision runs an image named `approve__pending__user`.
  - **Seven Cloud Scheduler jobs are still firing into these dead services** every 5–30 minutes.
    Disabling them is reversible and non-destructive.
  - Two of the six legacy secrets are `TELNYX_API_KEY` and `TELNYX_PUBLIC_KEY` — the same
    credentials F-034 lists as exposed and awaiting rotation. See "Rotation" below.
  - Current code has no Firestore or legacy-function dependency.
- **A second, stray project exists: `farm-friend-497422`** ("Farm Friend", created 2026-05-25,
  ACTIVE). It carries only default APIs and no deployed resources — Cloud Functions is not even
  enabled. It is not the migration target and holds nothing, but it must be confirmed empty and
  deleted during retirement rather than left as a second project sharing the name.

Target:

- `farm-friend-web`: public ingress, one maximum instance initially, concurrency 20,
  1 vCPU/512 MiB, zero minimum instances.
- `farm-friend-worker`: internal ingress plus IAM authentication, maximum two instances, low
  concurrency, 1 vCPU/512 MiB, zero minimum instances.
- One Cloud Tasks queue for immediate sender processing.
- One Cloud Scheduler job calling the worker every minute.
- Runtime and worker share the same immutable image digest and pooled Neon URL.
- No load balancer, VPC connector, Cloud SQL, minimum instance, CDN, or custom domain in this
  migration.

Cloud Scheduler and Cloud Tasks can reach an internal Cloud Run service through its default URL
from the same project, keeping the worker off the public internet.
[Cloud Run ingress documentation](https://docs.cloud.google.com/run/docs/securing/ingress)

## Implementation Changes

### Containerization and configuration

- Add Next.js standalone output, monorepo tracing, a multi-stage Node 20 container,
  `.dockerignore`, non-root runtime, `$PORT` support, and graceful database-pool shutdown.
- Remove `@vercel/functions`, `vercel.json`, `CRON_SECRET`, and the GitHub scheduled-worker
  workflow.
- Add explicit `DEPLOYMENT_ROLE=web|worker`; internal routes return 404 from the public deployment
  before constructing application context.
- Store five sensitive values in new, prefixed Secret Manager secrets: Neon URL, phone-hash salt,
  administrator-password verifier, Telnyx API key, and DeepInfra API key. Pin Cloud Run revisions to numbered
  versions; secret values never enter Terraform state.
- Keep model name, Telnyx public key/profile/from-number, region, queue name, and service URLs as
  non-secret configuration.

### Immediate and scheduled work

- Introduce an injected immediate-work queue seam.
- After verified SMS ingress commits, synchronously enqueue a bounded Cloud Task before returning
  the already-prepared 200 response.
- Use a deterministic task name derived from provider event ID; duplicate creation counts as
  success.
- If enqueueing fails or times out, still return 200 because the inbox event is durable and the
  minute worker recovers it.
- Add private `POST /api/internal/kick` accepting only the sender hash and provider event ID. It
  awaits bounded inbound/outbound passes and returns non-2xx for retryable infrastructure failure.
- Make `POST /api/internal/cron` worker-only and remove GET/shared-secret authentication. Preserve
  inbound → outbound → delivery → retention ordering.
- Configure task retries with bounded exponential backoff and a 30-second dispatch deadline.
  Configure Scheduler with OIDC, a 300-second deadline, and one retry.
- Use dedicated runtime and internal-invoker service accounts with only secret access, task
  creation, token minting, and worker invocation permissions.

### Platform correctness

- Replace the Vercel-specific client-signal parser with Cloud Run's trusted proxy shape: ignore
  caller-supplied leading `X-Forwarded-For` values and select the Google-appended client hop from the
  right. Malformed or absent headers use the existing shared fallback bucket.
- Keep the public service at one maximum instance initially so the intentionally non-durable
  in-memory abuse budgets cannot multiply across instances. Raising this limit later requires a
  deliberate distributed-throttle design.
- Cap total service instances so five database connections per process cannot exhaust Neon.
- Add structured operational events containing counts, opaque provider IDs, or approved hashes
  only—never raw phones, bodies, credentials, or complete provider errors.

### Infrastructure and delivery

- Add Terraform for APIs, Artifact Registry, two Cloud Run services, queue, scheduler, service
  accounts/IAM, five secret resources, remote state, artifact cleanup, monitoring, and a $5 billing
  alert.
- Create a dedicated Artifact Registry repository rather than reusing Firebase-managed
  `gcf-artifacts`; retain only the current and previous release images.
- Add a manual GitHub deployment workflow using Workload Identity Federation—no service-account
  key. It accepts a commit SHA, runs all checks, publishes one image, resolves its digest, shows the
  Terraform plan, and applies only through a protected production environment requiring Max's
  approval.
- PR workflows build and validate but never publish or deploy automatically.
- Update architecture, runbook, environment template, and current-state documentation so GCP—not
  Vercel—is the sole deployment contract.

## Test and Rollout Plan

### TDD and local verification

- First add failing tests for deterministic task creation, duplicate tasks, enqueue failure after
  durable commit, worker-only routes, and scheduler recovery without a task.
- Prove task retries and concurrent task/schedule execution cannot double-process or double-send.
- Sabotage each lifecycle/configuration test: remove queue creation, expose the worker publicly,
  expose internal routes through the web role, or restore an unregistered background promise;
  confirm the relevant test fails.
- Run unit, integration, typecheck, lint, evals where applicable, isolated workspace installation,
  Next production build, container build, and a locally running container smoke test.
- Run `terraform fmt -check`, `validate`, security/IAM assertions, and a plan test proving zero
  minimum instances, bounded maximums, internal worker ingress, OIDC callers, and no secret values
  in state.

### Pre-cutover

- Provision only after explicit approval because it enables billable services.
- Copy the exact existing phone-hash salt; never rotate it while Neon retains current phone hashes.
  **`PHONE_HASH_SALT` must never be rotated at all** — it is the input to the only lookup key for
  every phone in the system, and rotating it orphans every hash with no way back. Record it, carry
  it across unchanged.
- Obtain the Neon pooled runtime URL directly from Neon/password manager; verify TLS and migration
  fingerprint. **The production `DATABASE_URL` must come from max** — Vercel values are write-only
  and `vercel env pull` returns `[SENSITIVE]`, so this is never self-service. **Fingerprint the
  target before any migration**: `neondb`, 21 `sms_messages` / 21 `outbox_work` rows, 0 stands is
  production. Use the **direct (non-pooled)** Neon string for DDL.

**Rotation: do it as part of this cutover, not beside it (F-034 / GL-001).** F-034 is a hard
blocker on go-live and this plan already says to rotate rather than copy exposed values, so the two
are the same act — performed once, against the new environment, rather than twice.

> **DEFERRED AGAIN by max, 2026-07-28** (the third such deferral). The migration proceeds carrying
> the existing exposed credentials across to GCP, and rotation happens later as its own act.
>
> The deferral is **sound today and its soundness is conditional, not permanent**: production holds
> no real farmer or customer phone numbers (`/api/public/stands` returns `{"stands":[]}`, 0 stands
> seeded), so an exposed `DATABASE_URL` currently reaches a database with nothing personal in it.
> **B-002 seeding 28 real stands does not by itself change this** — stand data is public — but the
> first real inbound SMS does, because that writes a real number into `contacts`. At that moment
> this stops being a deferral and becomes an incident waiting to happen.
>
> The cost of deferring is that the work is done twice: once now (carry the values across) and once
> later (rotate them), rather than once during cutover. That is the trade max accepted, recorded so
> the next session does not re-argue it.
>
> **Still a hard blocker on F-029 go-live.** Nothing here relaxes that.

- Scope: `DATABASE_URL`, `TELNYX_API_KEY`, `DEEPINFRA_API_KEY`, and `ADMIN_PASSWORD_HASH` on the
  web service only.
  `CRON_SECRET` **disappears** rather than rotating: the internal cron route stops using a shared
  secret and becomes worker-only under IAM, which also removes the GitHub-secret/Vercel-var pair
  that had to be kept in sync or every scheduled run 401s.
- **Confirm each variable's presence in the live environment before rotating it**, not from any
  table including this one. A documented "local `.env` only" claim about `DEEPINFRA_API_KEY` was
  already stale once — GL-019 put `LLM_PROVIDER=deepinfra` in production, so following the written
  procedure would have revoked a key production was actively using.
- The legacy project's `TELNYX_API_KEY` / `TELNYX_PUBLIC_KEY` secrets hold the same exposed
  credentials. Rotating the live values does not clear those; they are removed in retirement.
- Verify every rotation **behaviourally**. Vercel and Secret Manager values are write-only, and
  `vercel env ls`'s timestamp column is not a last-updated field. The webhook returning **401**
  (not 500) proves configuration still resolves; a deliberately malformed signature returning
  `malformed_signature` proves `TELNYX_PUBLIC_KEY` decoded to a valid 32-byte ed25519 key rather
  than merely being non-empty.
- Full checklist, order, and proof-by-effect tables: RUNBOOK §"Credential rotation" and `/pm show
  F-034`.
- Deploy a simulator/stub revision against a temporary Neon branch, verify every HTTP surface and
  forced cold start, then remove the temporary environment.
- Deploy the production revision with zero traffic changes and verify health, public stands, admin
  rejection, webhook signature rejection, worker IAM denial, task execution, scheduled retention
  effect, and database connection counts.

**Re-prove the B-009 class against Cloud Run — it is not inherited.** B-009 was a floating promise
the Vercel runtime never knew about: every inbound message was committed, acknowledged, and then
silently abandoned, while the whole kick suite stayed green because Node resolves floating promises.
The repo's standing rule is that a property belonging to the *platform* is proven only **by effect
in the deployment**. Cloud Run's container lifecycle is a different runtime for exactly that
property, so it starts unproven again — the enqueue-then-return design is *structurally* safer
(the task is durable before the response returns, where `waitUntil` was cancellable), but "safer by
design" is a claim, not evidence.

Required proof, by effect on the database, before cutover completes:

- A signed inbound message returns 200, and its Cloud Task is then observed to execute and drive
  that sender's inbound pass to completion — `provider_inbox_events.claimed_at` non-NULL and the
  downstream rows present. A committed, acknowledged, never-processed message is the exact B-009
  signature and must be searched for, not assumed absent.
- The same, immediately after a forced cold start, so container startup cannot swallow the task.
- The scheduled pass independently recovers a message whose task was never created (simulate by
  disabling enqueueing for one message), proving the recovery net still works when the fast path
  does not.

### Cutover and rollback

- Enable and prove the GCP minute schedule by database effect, then remove the GitHub schedule.
- Update `PUBLIC_BASE_URL` and Telnyx's webhook to the stable public Cloud Run URL.
- With separate approval for provider charges, execute a signed inbound SMS through task
  processing, outbound Telnyx delivery, callback application, and final database state.
- Keep the frozen Vercel deployment for 72 hours as rollback. Rollback means restoring the
  Telnyx/public URL while leaving the GCP worker operating against the same Neon database.
- Monitor Cloud Run 5xxs/latency, task retry depth and oldest age, scheduler failures, Neon
  connections, outbound ambiguity, and spend.

### Retirement

- Inventory Firebase Hosting, Auth users, Firestore collections, function configuration, schedules,
  secrets, and stored images.
- Export Firestore/Auth and non-secret resource manifests to a private archive; never archive
  credential values.
- After the 72-hour window, request explicit destructive-action approval, then remove:
  - Vercel project and environment values.
  - The stale `throwaway/hobby-deploy-test` branch, still owed a deletion.
  - The `scheduled-worker.yml` GitHub workflow and the `CRON_SECRET` repository secret.
  - Legacy functions and seven schedules.
  - Legacy Firebase Hosting/Auth/Firestore resources after archive verification.
  - Obsolete secret versions and `gcf-artifacts` images.
  - The stray `farm-friend-497422` project, after confirming it is empty.

**Archive before deleting.** The standing caution here came from a real incident: a reset script
written for a database *assumed* empty in fact found 6 volunteers, 17 messages, and 2 farms with
phone numbers, and only its row-count guard prevented the loss.

> **max states the legacy project holds no real data (2026-07-28).** Recorded as the owner's
> decision, which is what authorizes deletion. It is deliberately **not** recorded as a verified
> fact — nothing in this session read Firestore or Auth to confirm it, and the incident above is
> precisely a case where "assumed empty" was wrong.
>
> So the procedure is unchanged in the one way that matters: **read the actual contents
> immediately before deleting, and let a non-empty result stop the deletion** rather than proceed
> on the assumption. That costs one query and converts an assumption into an observation. Make the
> destructive step require explicit confirmation **and** fingerprint its target, so a mistyped
> project fails instead of erasing something else.
- Verify zero legacy invocations, no remaining always-warm instances, no external endpoint still
  references Vercel/legacy functions, and the expected monthly billing baseline.

## Cost Assumptions

- Neon remains the database; its cost does not move into GCP.
- Cloud Run request-based free tier includes 2 million requests, 180,000 vCPU-seconds, and 360,000
  GiB-seconds monthly; zero minimum instances avoid idle compute billing.
  [Cloud Run pricing](https://cloud.google.com/run/pricing)
- Cloud Tasks' first million monthly operations are free.
  [Cloud Tasks pricing](https://cloud.google.com/tasks/pricing)
- One Scheduler job is free if the billing account has an unused three-job allowance; otherwise it
  costs $0.10/month. [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing)
- Artifact Registry includes 0.5 GiB free, then costs about $0.10/GiB-month.
  [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing)
- Secret Manager includes six active versions per billing account, then costs
  $0.06/version-month. Existing legacy versions may cause a temporary overlap charge until approved
  cleanup. [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)
- Free tiers are billing-account-wide, so MycoFile or other projects may consume part of them.
  Budget alerts report overruns but do not impose a hard spending cap.
- **The legacy spend is $1.57/month** (actual bill, 2026-07-28) — see the two always-warm functions
  above. It is rounding error against the ~$20/month Vercel Pro charge this migration exists to
  avoid, and it is **not** available today by setting `minScale=0`, because the images backing those
  services no longer exist. Do not credit it to the migration either way.

**What the migration is actually worth, stated once.** Vercel Pro ~$20/month → GCP ~$0/month at
launch volume. That is the financial case, and it stands entirely on the Vercel side of the ledger;
the legacy GCP cleanup contributes $1.57. The non-financial case — a durable Cloud Tasks queue in
place of a cancellable `waitUntil`, and removing the manual `crons`-strip from the deploy path —
would justify the move at equal cost.

## Verification of this plan

Reviewed 2026-07-28 against the live projects and the working tree. Recorded so the next session
knows which claims are evidence and which are still assertions.

**Verified true by direct check:**

- 17 legacy functions, seven Firebase schedules, six secrets, and a live Firestore database in
  `farm-friend-vashon` (`gcloud functions list`, `scheduler jobs list`, `secrets list`,
  `firestore databases list`).
- `inbound-sms` and `simulate-inbound-sms` carry `minScale=1`; the other fifteen are unset. Note
  that a per-function loop over `gcloud functions list` names returns **empty for every service**,
  because the underlying Cloud Run services are hyphenated (`inbound-sms`) while the functions are
  underscored (`inbound_sms`) — a check written that way silently reports "no warm instances" and
  contradicts the real state. Query `gcloud run services list` instead.
- Vercel coupling is exactly three things: `waitUntil` imported in
  `apps/web/app/api/sms/webhook/route.ts`, `apps/web/vercel.json`, and source-asserting tests
  (`kick-survival`, `kick-wiring`, `cron-schedule`, `external-scheduler`).
- Pool sizing is 5 connections per process (`SQL_POOL_SIZE = 3` + ORM remainder) in
  `packages/db/src/index.ts`.
- Vercel's commercial-use restriction, quoted above from the live fair-use page.

**Checked against the actual bill 2026-07-28 — and one claim was wrong:**

- **The $15–25/month warm-instance estimate was wrong. The real figure is $1.57/month** — off by
  roughly 13×. Cause of the error, worth keeping because it will recur: the arithmetic assumed idle
  CPU on a held instance bills at *some* rate, and bracketed $10–43 by varying that rate. Under
  request-based billing it bills at **none** — the console shows only *"Cloud Run functions
  Min-Instance Memory (Request-based billing)"*, with no CPU counterpart. Two plausible bounds
  computed from a pricing page both missed the answer, because the disputed term was zero.
  Account-wide spend is $12.22/month across all projects.
- **The lesson generalizes to the rest of this section**: a figure derived from a pricing page is
  not a cost. The remaining Cloud Run / Tasks / Scheduler / Artifact Registry / Secret Manager
  numbers below are still page-derived and still unconfirmed, and the "$0/month at launch traffic"
  conclusion inherits that. It is *directionally* well-supported — launch volume sits far inside the
  free tiers — but treat it as an estimate until a real bill exists.

**Asserted but NOT verified — confirm before relying on them:**

- The cost figures for Cloud Run, Tasks, Scheduler, Artifact Registry, and Secret Manager are from
  the linked pricing pages as read at authoring time; none were checked against an actual bill.
  The "$0/month at launch traffic" conclusion follows from them and inherits their uncertainty.
- No `output: "standalone"` exists in `apps/web/next.config.mjs` today, so containerization is real
  work rather than a config toggle.

**Known-stale documentation this migration must correct.** RUNBOOK, GO_LIVE_GUIDE, and CLAUDE.md's
"Current State" all describe Vercel as the deployment contract, including the Hobby `crons`-strip
workaround and the GitHub scheduler. Updating them is in scope; leaving two live deployment stories
in the docs is the failure mode GL-031/032/036 just finished removing.
