# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only **verified** facts
> (test counts from a real run, files read); replace stale lines, don't append. The *why* behind past
> changes lives in [SESSION_LOG.md](SESSION_LOG.md) — open it deliberately, never to orient.
>
> This is the **only** place build status lives. The architecture docs carry none.

**Verified 2026-07-30** (`main` @ `8c4b570`, pushed): `npm test` **598/598** (62 files);
`npm run test:integration` **334/334** (20 files) on real Postgres 16, all 8 migrations from empty;
typecheck and lint exit 0; `infra/test_deploy_assertions.py` **10/10**;
`infra/test_served_card_assertions.py` **18/18**. Evals **not** re-run — no seam projection, schema,
or output contract changed; last results stand (`evals` critical 11/11, advisory 4/4, adversarial
29/29; `evals:live` containment 4/4, quality 6/6 on Mistral Small 24B).

**Deployed 2026-07-30** — revisions `farm-friend-web-00008-bkl` / `farm-friend-worker-00009-bwj`,
one digest `sha256:c91bfbb0…` on both. `plan-assertions.py` **29/29**, `deploy_assertions.py`
PASSED (both revisions newer than every secret version). Verified by effect: health `{"ok":true}`,
`/api/public/stands` **34** stands, webhook **401** (config resolves), `/api/internal/cron` **404**
on the public service (on `POST`, the only method it exports — a `GET` is **405** from the framework
before any handler runs), `/admin` 200, and the contact card **153 bytes / 6 CRLF** by hex dump on
both HTTP/1.1 and HTTP/2. The plan diff was read leaf by leaf — exactly one leaf changed per service
(`containers[0].image`), plus the known non-converging `scaling` block.

## What works end to end

- **SMS round trip, on a real handset, on this runtime.** Inbound → deterministic route → queued
  reply → Telnyx dispatch with a real provider message ID → delivery callbacks back through the
  webhook. Compliance keywords, `FLAG`, context-bound `YES`/`NO`, then free text
  (`apps/web/lib/routing.ts`); model seams are reachable only through a `freeText` callback after
  `parseCommand` returns `none`, so "no model on the compliance path" is structural.
- **Public map**, model-free in its module graph, reading the same published records as SMS.
  35 stands seeded, **34 public** (see B-024), **212 offering tags** across 33.
- **Operator surface** — farm approval, flag review, stock-out triage, stand-data questions. Built,
  deployed, and now **reachable in principle**: one administrator exists
  (`board@vigavashon.org`, authorized 2026-07-30). No link is *delivered* until F-031, so signing in
  means minting a token out of band.
- **One-tap add-to-contacts** (F-039) — `GET /api/public/contact-card` serves a vCard built from
  `TELNYX_FROM_NUMBER`. **Deployed and correct on the wire**: 153 bytes, 6 CRLF, `file(1)` reads
  "vCard visiting card, version 3.0". A **physical-handset tap is still owed** — a malformed card
  fails by opening nothing, so only a real phone proves the sheet appears.
- **Deployed on Cloud Run**: https://farm-friend-web-p5mfxfp5za-uw.a.run.app — one image, two
  services (`farm-friend-web` public, `farm-friend-worker` internal+IAM) differing only by
  `DEPLOYMENT_ROLE`. Cloud Scheduler drives four bounded passes (inbound, outbound, delivery,
  retention); Cloud Tasks drives the per-sender kick. Vercel is gone.
- **Production data**: `neondb`, 8 migrations, **1 contact** (max's real number), 35
  `sales_locations`, 212 offerings, **1 administrator**, **0** inventory revisions / entries /
  farmer authorizations / farm approvals, 4 `stand_data_flags`.

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

- **B-023 — CLOSED 2026-07-30.** `board@vigavashon.org` is the first administrator (a VIGA *org*
  address, max's choice, so authority sits with the organization). Verified by reading the row and
  by resolving it through `findAdministratorByEmail` in production — exact address, mixed case, and
  stray whitespace all resolve; an unrelated address still finds nothing. **No link is delivered
  until F-031**, so signing in today means minting a token out of band.
- **B-024 (HIGH) — a farmer's address we should not have published.** Handpicked Homestead is
  `is_public = false` in production (interim, max-approved): her form `extraNotes` said *"I don't
  have my own farmstand … do not add my address"*, yet the seed gave her a pin at her home. Address
  and coordinates preserved; the permanent shape (a *producer* whose goods sell at another farm's
  stand) is an open product question, and **no producer/host relationship was invented for one row**.
  **`extraNotes` is read only by `offering-type.ts`** — nothing consults it for visibility, so a
  second such instruction would republish. Exactly one instance corpus-wide.
- **F-042 (HIGH) — the offering tags are unread; copy now APPROVED, nothing built.**
  `listPublicStands` never selects `sales_location_offerings`, so the API exposes no offerings field
  and all 33 tagged stands still render *"No listing yet."* Seeding was necessary, not sufficient.
  **The vocabulary is settled (max approved 2026-07-30)**: tags render as
  **"Usually sells: …"** followed by **"Nothing confirmed recently."**; a farmer's confirmation
  renders as **"Confirmed X ago: …"** with **"Also usually sells: …"** beneath. Three rules —
  **"Usually sells" never takes a timestamp** (a date beside it reads as a confirmation, the exact
  failure this guards); the stock-out flow attaches to **confirmed items only**; *"No listing yet"*
  survives for the 2 untagged stands. "Sells" not "carries" — these are unattended tables, not shops.
- **F-040 (HIGH) — farmer onboarding; design settled, nothing built.**
  `farmer_authorizations` has **no writer outside tests**, so a real farmer who texts an update
  falls through to the *customer* branch and nothing reports why. Identity is separate from channel:
  **VIGA always approves** (a phone proves possession of a phone, not ownership of a farm), either
  side may start it, and on approval Farm Friend texts the farmer. Channels — SMS, a texted link, a
  bookmarked form — all land on the **same confirmation gate**, no bypass. No passwords. max chose a
  link that never expires until revoked, so **revocation is the only safety net**: it must take
  effect on the next request, VIGA must see and revoke every farmer, and a leaked link must at worst
  propose a wrong listing on ONE stand. **B-023 is CLOSED, so this is now unblocked.**
- **B-025 — CLOSED 2026-07-30. Cause was the MINIFIER, not the network.** The filed diagnosis was
  wrong in both directions and is recorded here so it is not re-derived: it reproduces on a **local
  standalone build**, and all three Next.js body forms plus the Cloud Run wire pass CRLF through
  byte-for-byte — the suggested Buffer-with-content-length fix would have changed nothing. The build
  folded `.join("\r\n")` into a template literal written with **raw CR/LF bytes**, which ECMA-262
  normalizes to a bare LF at *parse* time. Fixed with `String.fromCharCode(13, 10)`, which emits no
  newline byte to normalize. Verified by hex dump in production: **153 bytes / 6 CRLF**, `file(1)`
  reads "vCard visiting card, version 3.0", on HTTP/1.1 and HTTP/2.
  **Still owed: a physical-handset tap** — a malformed card fails by opening nothing, so only a real
  phone proves the add-contact sheet appears.
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
