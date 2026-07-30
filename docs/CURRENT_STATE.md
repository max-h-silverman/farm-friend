# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only **verified** facts
> (test counts from a real run, files read); replace stale lines, don't append. The *why* behind past
> changes lives in [SESSION_LOG.md](SESSION_LOG.md) — open it deliberately, never to orient.
>
> This is the **only** place build status lives. The architecture docs carry none.

**Verified 2026-07-29** (`main` @ `c3810da`, pushed): `npm test` **596/596** (61 files);
`npm run test:integration` **334/334** (20 files) on real Postgres 16, all 8 migrations from empty;
typecheck and lint exit 0; `infra/test_deploy_assertions.py` **10/10**. Evals **not** re-run — no
seam projection, schema, or output contract changed; last results stand (`evals` critical 11/11,
advisory 4/4, adversarial 29/29; `evals:live` containment 4/4, quality 6/6 on Mistral Small 24B).

**Deployed 2026-07-30** — revisions `farm-friend-web-00007-4mb` / `farm-friend-worker-00008-gg2`,
one digest `sha256:79ff89e8…` on both. `plan-assertions.py` **29/29**, `deploy_assertions.py`
PASSED (both revisions newer than every secret version). Verified by effect: health `{"ok":true}`,
`/api/public/stands` **34** stands, webhook **401** (config resolves), `/api/internal/cron` **404**
on the public service, `/admin` 200. The plan diff was read field by field — only the image digest
and the known non-converging `scaling` block changed.

## What works end to end

- **SMS round trip, on a real handset, on this runtime.** Inbound → deterministic route → queued
  reply → Telnyx dispatch with a real provider message ID → delivery callbacks back through the
  webhook. Compliance keywords, `FLAG`, context-bound `YES`/`NO`, then free text
  (`apps/web/lib/routing.ts`); model seams are reachable only through a `freeText` callback after
  `parseCommand` returns `none`, so "no model on the compliance path" is structural.
- **Public map**, model-free in its module graph, reading the same published records as SMS.
  35 stands seeded, **34 public** (see B-024), **212 offering tags** across 33.
- **Operator surface** — farm approval, flag review, stock-out triage, stand-data questions. Built
  and deployed, but **unreachable**: see B-023.
- **One-tap add-to-contacts** (F-039) — `GET /api/public/contact-card` serves a vCard built from
  `TELNYX_FROM_NUMBER`. **Deployed and serving 200**, but the wire bytes lose their CRLF line
  endings — see B-025.
- **Deployed on Cloud Run**: https://farm-friend-web-p5mfxfp5za-uw.a.run.app — one image, two
  services (`farm-friend-web` public, `farm-friend-worker` internal+IAM) differing only by
  `DEPLOYMENT_ROLE`. Cloud Scheduler drives four bounded passes (inbound, outbound, delivery,
  retention); Cloud Tasks drives the per-sender kick. Vercel is gone.
- **Production data**: `neondb`, 8 migrations, **1 contact** (max's real number), 35
  `sales_locations`, 212 offerings, **0** inventory revisions / entries / farmer authorizations /
  farm approvals / administrators, 4 `stand_data_flags`.

## Live invariants worth knowing before you touch anything

- **`LLM_PROVIDER` is required with no default** and no environment-dependent exemption — production
  once ran the deterministic stub its entire life, silently, with every suite green. Now
  `deepinfra` + `mistralai/Mistral-Small-24B-Instruct-2501`, so **model calls cost money on real
  traffic**.
- **The model authors no customer-facing factual text and writes no durable state.** Five seams have
  explicit disjoint projections; the low-level provider call is unexported. `ambiguous` /
  `clarification` / `outOfScopeRequest` / `originDependent` are **bare signals carrying no words** —
  code renders the text.
- **Consent**: `isProactiveSendPermitted` is the single predicate. **`JOIN` enrolls only a
  first-time sender; once a consent record exists only `START` restores** — the carrier owns
  STOP/START and 409s our reply while its block is active, so our record must not claim consent the
  carrier will not honour. No provider response ever drives a consent transition.
- **Privacy**: phones hashed, raw E.164 in one column read only by the send path; the admin surface
  masks at the **query** (`right(phone_e164, 4)`). `purgeExpiredBodies` clears expired bodies;
  flags/audit survive; the flagged-thread exemption fails safe and terminates on resolve *or*
  dismiss.
- **`PHONE_HASH_SALT` must never be rotated** — it is the input to the only lookup key for every
  phone; rotating it orphans every hash with no way back.
- **Post-response work is a durable queue, not a platform primitive.** The webhook commits,
  **enqueues a Cloud Task, and awaits that enqueue** before returning 200. `enqueueSenderWork` never
  throws and never retries — a queue outage must not turn a successful ingress into a 5xx.
- **An abandoned dispatch claim is quarantined, never resent** — recovery resolves to `ambiguous`,
  never `queued`, because a resend could duplicate an SMS someone already holds.
- **Registered keywords and auto-response copy** are stated once in `packages/core/src/sms/` and
  pinned character-for-character to `TELNYX_10DLC_FIELD_VALUES.txt`, a **transcript of live
  console state** — change the console first, then transcribe. `ALREADY_JOINED_RESPONSE` lives
  beside them but is **not** registered copy and must never be transcribed into that block.
- **Architecture tripwires** (`packages/core/src/architecture.test.ts`) fail if: a `MapProvider` /
  `geocode(` call returns; `packages/config` or `packages/contracts` reappears; the tenancy
  identifier reappears; a fixture uses a date literal; or a publication-path source compares against
  a location-type enum **value**.
- **Seeding**: `npm run db:seed -- --form <f.csv> --map <m.csv>` (both required — the form has 2026
  details and no coordinates, the map has coordinates). The join is an **exact normalized key**
  (`matchStandName`), never a similarity score: a fuzzy matcher measured over the real corpus ranked
  Lavender Hill against Flora Hill. Offerings are a separate step,
  `npm run db:seed-offerings -- maps/offerings-proposals.json [--dry-run]`, keyed through that same
  normalization; an ambiguous name refuses the whole batch, and `--dry-run` resolves against the
  database.
- **Deploy** = `gcloud builds submit --config cloudbuild.yaml
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)`, then `tofu plan`, then
  `infra/plan-assertions.py` (29 checks), then apply, then `infra/deploy_assertions.py` — RUNBOOK
  §Deploy. **Read a plan's CONTENTS, never its count**: a permanent 2-resource diff on the top-level
  `scaling` block never converges and is expected steady state. Terraform owns infrastructure but
  **never secret values or the image**.

## Open work — each needs separate implementation authorization

Do not read a passing suite as a working product: several gaps hide behind green tests whose
fixtures supply what production never creates.

- **B-023 (HIGH) — production has no administrator.** `administrators` is 0 rows, so the whole
  operator surface is unreachable by anyone; a verified link for an address with no administrator row
  renders 401, correctly and permanently. The 4 seeded stand-data flags have nobody who can see
  them. **Not F-031 and not blocked by it** — that is mail transport, this is the authority row the
  link resolves against. `bootstrap-administrator.ts` exists and has never run against production.
  Needs a decision on whose address is first.
- **B-024 (HIGH) — a farmer's address we should not have published.** Handpicked Homestead is
  `is_public = false` in production (interim, max-approved): her form `extraNotes` said *"I don't
  have my own farmstand … do not add my address"*, yet the seed gave her a pin at her home. Address
  and coordinates preserved; the permanent shape (a *producer* whose goods sell at another farm's
  stand) is an open product question, and **no producer/host relationship was invented for one row**.
  **`extraNotes` is read only by `offering-type.ts`** — nothing consults it for visibility, so a
  second such instruction would republish. Exactly one instance corpus-wide.
- **F-042 (HIGH) — the offering tags are unread.** `listPublicStands` never selects
  `sales_location_offerings`, so the API exposes no offerings field and all 33 tagged stands still
  render *"No listing yet."* Seeding was necessary, not sufficient. The design question is the
  **vocabulary**: "usually carries" must never render as a confirmation.
- **F-040 (HIGH) — farmer onboarding; design settled, nothing built.**
  `farmer_authorizations` has **no writer outside tests**, so a real farmer who texts an update
  falls through to the *customer* branch and nothing reports why. Identity is separate from channel:
  **VIGA always approves** (a phone proves possession of a phone, not ownership of a farm), either
  side may start it, and on approval Farm Friend texts the farmer. Channels — SMS, a texted link, a
  bookmarked form — all land on the **same confirmation gate**, no bypass. No passwords. max chose a
  link that never expires until revoked, so **revocation is the only safety net**: it must take
  effect on the next request, VIGA must see and revoke every farmer, and a leaked link must at worst
  propose a wrong listing on ONE stand. **B-023 is upstream of this.**
- **B-025 (HIGH) — the served vCard loses its CRLF line endings.** `/api/public/contact-card` returns
  **147 bytes, 0 CRLF, 6 bare LF** in production where the renderer produces 153/6/0, and `file(1)`
  rejects it ("lines not separated by CRLF"). The handler applies no transform and it reproduces on
  HTTP/1.1 and HTTP/2, so the Next.js response path or the proxy layer is normalizing the body.
  **No local test can see it** — the renderer's CRLF assertion is correct and passes. Textbook
  "local runtime ≠ deployed runtime"; verify any fix by hex-dumping the wire bytes, not by a unit
  test. Display name `VIGA Farm Friend` (max, confirmed). A physical-handset check is now the
  deciding test, since a malformed card fails by opening **nothing**.
- **F-031 — no mail provider, so no sign-in link is delivered.** Everything up to the wire is built;
  what remains is a vendor, credentials, **attested** data-handling terms, and SPF/DKIM/DMARC.
  Blocked on what email infrastructure VIGA runs. **GCP has no first-party transactional email
  API** — "email on GCP" means SendGrid via Marketplace, whose terms are Twilio's. Never infer the
  attestation values.
- **F-036 — where the model may run.** Seed-time: built and run. Query-time on the public map:
  **blocked** (`public-surface-model-free.test.ts` polices the import graph). Farmer-authored web
  submission is a **third case**, needing farmer web auth that does not exist plus the same
  confirmation gate.
- **B-008 — lint does not run in deployed builds.** `apps/web` omits the `@typescript-eslint`
  plugin/parser, so Next skips lint non-fatally and the build goes green with the gate absent. The
  real work is extending `workspace-manifests.test.ts` to config-file dependency references.
- **B-020 — integration deadlock** (`40P01`) on a fixture `truncate`, between suites' truncates
  rather than Farm Friend's locking. Has not reproduced across many runs.
- **B-001** stays open pending its caveat. `model_runs` has **no production writer**. No per-stand
  pages or filter/search UI. Message classification has no consumer. SMS inquiry has no HTTP route
  **by design** — reached from the webhook worker.
