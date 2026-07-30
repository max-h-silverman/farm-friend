# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only **verified** facts
> (test counts from a real run, files read); replace stale lines, don't append. The *why* behind past
> changes lives in [SESSION_LOG.md](SESSION_LOG.md) — open it deliberately, never to orient.
>
> This is the **only** place build status lives. The architecture docs carry none.

**Verified 2026-07-30** (`main`, F-040 merged): `npm test` **643/643** (65 files);
`npm run test:integration` **396/396** (22 files) on real Postgres 16, all **9** migrations from
empty; typecheck and lint exit 0; `evals` critical 11/11, advisory 4/4, adversarial 29/29.
`evals:live` **not** re-run and not required — F-040 touched no seam projection, schema, or output
contract; the farmer web path reuses `applyInterpretedInventory` unchanged. The real model was
nonetheless driven through the real web route by hand (see F-040 below). Last live results stand
(containment 4/4, quality 6/6 on Mistral Small 24B). The infra assertion suites were not re-run —
no infra file changed.

> One integration run hit **B-020**'s known `40P01` truncate deadlock; it passed on rerun, which is
> what marks it environmental rather than a defect in this work.

**Merged but NOT deployed — TWO items now.** F-042 and F-040 are both on `main`; the deployed
revisions below predate both, so production still serves the map without the offering tags and has
no farmer onboarding at all. **F-040 also needs its migration applied** — `neondb` is still at 8
migrations and has neither `farmer_onboarding_requests` nor `farmer_links`, so deploying the image
alone would ship code whose tables do not exist. Migration first, then deploy; both are separate
authorized steps (RUNBOOK §Deploy).

> **`.next/` is a shared artifact.** `contact-card-build.test.ts` (B-025) reads the **production
> build output**, so running `next dev` clobbers it and the test fails with "no built chunk
> containing BEGIN:VCARD". That failure is environmental. Run
> `npm run build --workspace @farm-friend/web` and re-run before treating it as a defect.

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
  35 stands seeded, **34 public** (see B-024), **212 offering tags** across 33. The tags are read
  and rendered as of F-042 — **merged, not yet deployed**: production still serves the map without
  them.
- **Operator surface** — farm approval, flag review, stock-out triage, stand-data questions, and
  (F-040, unmerged) farmer access: grant, see, revoke, re-issue a link. Built,
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
  farmer authorizations / farm approvals, 4 `stand_data_flags`. **F-040's migration 0009 is NOT
  applied** — it is on an unmerged branch, and production has neither `farmer_onboarding_requests`
  nor `farmer_links`.

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
- **F-042 — BUILT and MERGED to `main` 2026-07-29 (`2b35955`). NOT DEPLOYED.**
  The 212 tags now reach customers *in the code*; production has not been deployed, so the live map
  still shows none of them. `listPublicStands` selects them through an **aggregated
  subquery** — a second LEFT JOIN would cross-product and repeat each confirmed item once per tag —
  and serves them as `usuallySells`, **always present, `[]` when empty**. That asymmetry with the
  absent-when-empty recency fields is load-bearing: it is what distinguishes "no tags and no
  confirmation" from "tags, nothing confirmed".
  **Where the rule lives**: `standListingLines` (`apps/web/lib/map-view.ts`) decides which lines a
  stand gets; `stand-map.tsx` prints them and chooses nothing. This repo has **no
  component-rendering harness**, so "Usually sells never takes a timestamp" had to leave the JSX to
  be testable at all — `detail` is settable only on a confirmed line. Sabotage-verified.
  `renderElapsed` was split out of `renderRecency` in core so the map's "Confirmed X ago" and SMS's
  "updated X ago" share one arithmetic; **`renderRecency` output is byte-identical** to the previous
  implementation across 57,601 minute-by-minute cases, so no seam contract changed and `evals:live`
  was correctly not required. Also fixed: `page.tsx` held a **second copy of the wire format that
  had already diverged** (it sent `updated: undefined` as a present key where the API omitted it);
  both readers now call `serializePublicStand`.
  **Verified by effect** against the real corpus (34 stands / 33 tagged / 212 tags, matching
  production) served through the real app: rendered bytes carry 33 "Usually sells:" + 33 "Nothing
  confirmed recently.", exactly **1** "No listing yet", and **no elapsed phrase within 400 chars of
  any usual label**. A real revision published through the real proposal→confirmation chain rendered
  "Confirmed 4 hours ago: flowers, duck eggs" over "Also usually sells: …" with the confirmed items
  subtracted case-insensitively.
  **Owed: nobody has looked at the styling.** The two voices are styled to differ at a glance
  (filled chips vs. outlined) but that CSS has **not been seen rendered** — the browser extension
  was not connected. **20 sabotages, all caught**; one initially survived (omitting `usuallySells`
  when empty passed the whole suite, since the renderer treats absent and empty alike by design) and
  now has its own assertion.
- **F-040 — BUILT and MERGED to `main` 2026-07-30. NOT deployed, and its MIGRATION IS NOT APPLIED.**
  All five pieces in one tranche. `farmer_authorizations` now has a real writer (`packages/db/src/farmer.ts`), so a
  farmer who texts an update no longer falls through to the *customer* branch.
  **Migration 0009** adds two records, and the split is load-bearing: `farmer_onboarding_requests`
  is what a farmer *asked* for — no farm, no grant column, no message text, nothing reads it as
  authority — and `farmer_links` is a **pointer to** an authorization, never authority itself.
  **The link is not a signed claim**, deliberately: max chose one that never expires, so a
  signature would keep verifying after revocation. It is 32 random bytes, hash-only in the database,
  and `resolveFarmerLink` re-reads **both** revocation columns every request, so there is nothing
  cached to reach around.
  **Channels**: `SIGNUP`/`LINK` are farmer product keywords parsed **last** among the keyword
  branches (so neither can shadow `STOP`) and **before** free text (so no model sees them);
  `/admin/farmers` is VIGA's grant/see/revoke surface; `/stand/<token>` is the farmer's form. Every
  channel lands on `confirmInventoryPublication` — **the web path has no bypass**, and no function
  on that surface writes `inventory_revisions`.
  **Approval is not consent**: the "you're all set" text is queued inside the authorization
  transaction as a *proactive* category, so `authorizeDispatch` suppresses it for a farmer who never
  texted JOIN/START. Asserted at the dispatch claim, plus the complement so it is not passing
  because the message is undeliverable to everyone.
  **Verified by effect** end to end against real Postgres and the running app: SIGNUP → masked
  queue → authorize (text queued, `inventory_prompt`, `queued`) → LINK → resolve → propose (0
  revisions) → confirm (published) → revoke (link resolves null on the **next** request, form
  refuses, published listing untouched). Then the same round trip through the **real HTTP route and
  the real model** — worth knowing: Mistral rendered "plum jam" twice, once bare and once priced.
  That is interpretation quality, not a code defect, and it is precisely what the confirmation gate
  lets a farmer catch.
  **~35 sabotages; SIX survived and exposed real gaps in the tests**, all now closed — the
  resolver's authorization check (revoking via the writer also kills links, so the link clause did
  all the work), the one-stand-per-link guard (no fixture had a two-stand farm), a `contactHash`
  leak into the pending-request projection (that array was empty in the fixture), the cross-farmer
  confirmation (asserting "refused" and "still open" was satisfiable by the exact attack it
  forbids), the two independent cross-farmer defenses being indistinguishable, and the token shape
  guard (null with or without it — now asserted by query count).
  **Owed: nobody has looked at the screens.** `/stand/<token>` and `/admin/farmers` serve correct
  markup and classes, but the CSS has **not been seen rendered** — the browser extension was not
  connected. Same debt F-042 carries.
  **Owed: migration 0009 on production.** Deploying the image without it would ship code whose
  tables do not exist — `npx tsx packages/db/scripts/migrate.ts` against `neondb` comes first.
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
  submission was the **third case**, and F-040 (unmerged) now answers it: the farmer web auth that
  did not exist is the standing link, and the submission runs the *same* interpreter seam through
  the *same* confirmation gate as SMS rather than a second path. The model-free tripwire still
  passes — the farmer form is its own entry point and is not reachable from the public map's graph.
- **B-008 — lint does not run in deployed builds.** `apps/web` omits the `@typescript-eslint`
  plugin/parser, so Next skips lint non-fatally and the build goes green with the gate absent. The
  real work is extending `workspace-manifests.test.ts` to config-file dependency references.
- **B-020 — integration deadlock** (`40P01`) on a fixture `truncate`, between suites' truncates
  rather than Farm Friend's locking. Has not reproduced across many runs.
- **B-001** stays open pending its caveat. `model_runs` has **no production writer**. No per-stand
  pages or filter/search UI. Message classification has no consumer. SMS inquiry has no HTTP route
  **by design** — reached from the webhook worker.
