# Farm Friend — Go-live guide

This is the working guide from the July 28, 2026 whole-codebase architectural review to a safe,
complete Phase 1 launch. Work through it in priority order. It is deliberately more operational
than the product and architecture documents: those describe the intended product and its enduring
rules; this document says what remains between the current repository and go-live.

## Review record

The July 28 review baseline and autonomous decision rationale are historical; see SESSION_LOG.
Enduring outcomes live in their owning product/architecture docs. Current build, deployment, data,
and open-item status lives only in [CURRENT_STATE.md](CURRENT_STATE.md).

## How to use this guide

1. Start with the first incomplete item in Priority 0.
2. Complete the documentation and architecture housekeeping checkpoint after P0, before broad
   acceptance testing.
3. Continue through P1 and then P2. Resolve P3 when its decision becomes relevant; P3 does not block
   launch unless the underlying product assumption changes.
4. Treat each item as a small tranche with its own tests and documentation update.
5. Do not mark an item complete because a unit test exercises a helper. Prove the production wiring
   or the relevant platform behavior too.
6. Run the verification ladder at the end of this document after each tranche in proportion to its
   risk.
7. Keep this guide current as findings are resolved. Enduring decisions belong in the appropriate
   product or architecture document; this file should eventually become a short release checklist,
   not another historical archive.

Every `GL-###` item is open unless it has a `**Completed:** YYYY-MM-DD — commit/evidence` line
immediately below its heading. A partial implementation remains open; record partial evidence in the
item without marking it complete.

Priority means:

- **P0 — must precede broad hands-on testing:** a security, compliance, recovery, or verification
  defect could make test results misleading or leave consequential work in the wrong state.
- **P1 — required for Phase 1 acceptance testing:** a canonical launch journey or operational
  capability is absent or disconnected.
- **P2 — required before go-live:** the journey exists, but quality, resilience, observability, or
  repeatability is below the launch bar.
- **P3 — explicitly deferred or future-facing:** important architectural alignment that does not
  block the first useful test or launch unless its product assumption changes.

---

## Priority 0 — make the system safe and the checks truthful

### GL-001 — Rotate every exposed credential

**Completed:** 2026-07-29 — provider credentials rotated, old values rejected, and both Cloud Run
services verified newer than every consumed secret version. `PHONE_HASH_SALT` was preserved and
`CRON_SECRET` was removed with the GCP migration. Procedure: RUNBOOK §Credential rotation.

### GL-002 — Ensure a delayed `STOP` always reaches consent ordering

**Completed:** 2026-07-28 — reconfirmed against the code, fixed test-first, and sabotage-verified in
both directions. Compliance parsing now precedes conversation staleness; delayed `STOP` still
updates consent and suppresses dispatch, while stale free text and confirmations remain refused.
Owned by ARCHITECTURE §SMS ingress and SMS_COMPLIANCE.

### GL-003 — Recover abandoned outbound dispatch claims

**Completed:** 2026-07-28 — reconfirmed against the code, fixed test-first, sabotage-verified three
ways. Abandoned dispatch leases become `ambiguous`, never queued for resend; failures are isolated
per row. Operator visibility remains with GL-016/GL-018.

### GL-004 — Protect administrator sign-in

**Superseded by F-056:** administrator access is one fixed database identity plus a configured
password, with durable client and account-wide throttles. Pre-cutover sessions are revoked by the
cutover migration; no retired authentication path remains active.

### GL-005 — Make the typecheck cover what its name claims

**Completed:** 2026-07-28 — `72bdac8`. Root typecheck covers packages and web with no
suppressions; `typecheck-coverage.test.ts` prevents future workspace drift. Production build
remains a separate check. Operational contract: RUNBOOK §Local dev.

### GL-006 — Repair migration generator metadata

**Completed:** 2026-07-28 — `1a5d525`. Current schema snapshot restored without changing applied
SQL; a no-op generation produces no migration. `migration-metadata.test.ts` requires the newest
migration/snapshot pair. Operational contract: RUNBOOK §Migrations.

---

## Priority 1 — complete the canonical Phase 1 journeys

### GL-007 — Connect stock-out reports to a farmer alert

**Confirmed gap**

The public stock-out workflow records the report and resolves an authorized farmer hash, but the
HTTP handler discards that hash. No production path creates `stock_out_alert` outbox work.

**Required outcome**

- Commit the private report and unique farmer-alert outbox work durably.
- Keep the reporter opaque: never expose whether a farmer was resolved.
- The alert asks the farmer to send current inventory; it creates no separate `OUT`/`IGNORE`
  commitment.
- A farmer reply enters the ordinary inventory proposal and `YES`/`NO` confirmation flow.
- Add idempotency and consent-dispatch tests.

### GL-008 — Build the customer stock-out surface

**Confirmed gap**

There is a POST API but no stand page, public form, or QR destination through which a normal
customer can use it.

**Required outcome**

- Provide a location-bound reporting route or stand-page form.
- Generate or document stable QR destinations for sales locations.
- Bind the sales-location identifier in the surface rather than asking the model to choose it.
- Provide honest success, malformed-input, throttled, and unavailable states without revealing
  private farmer information.

### GL-009 — Make administrator sign-in operable

**Superseded by F-056:** no mail provider is part of the launch architecture. Go-live proof is the
fixed account signing in with its password, receiving a hashed durable session, reaching the admin
surface, signing out, and having the copied cookie refused.

### GL-010 — Build farmer onboarding and number verification

**Completed:** 2026-08-07 — three doors exist and are deployed: invited (`JOIN <token>`),
grandfathered (`/farmer/start`, F-072), and the emailed-code migration door
(`/farmer/start/<secret>`, F-079). Consent is established by the one existing writer; authorization
and consent stay separate records; onboarding still grants no approval. F-081 closed the last
sub-item, the default reminder schedule an approved farmer starts on.

### GL-011 — Build farmer web profile, listing, preferences, and inventory

**Completed:** 2026-08-07 — `/stand/<token>/listing` (F-073) and `/stand/<token>/settings` are
live behind the standing farmer link, whose auth shape is separate from administrator authority and
resolved per request. The listing form is prefilled and writes hours, address, payments, offerings,
and F-066 standing items; inventory text still goes through the shared interpretation and
confirmation mechanism. **Farm Bucks and offering type remain editable by nobody** — a VIGA
eligibility fact with its own admin workflow. Attribution for who wrote a listing change is the one
piece not built, tracked as F-065 rather than here.

### GL-012 — Build proactive inventory prompts and preference scheduling

**Completed:** 2026-08-07 — `inventory_prompt_preferences` stores the per-stand cadence;
`packages/db/src/scheduled-prompts.ts` creates at most one due prompt per sender in deterministic
stand order on the existing scheduled-work mechanism, at the 10:00 AM stand-local slot. Consent is
rechecked at dispatch through `authorizeDispatch`, delayed schedules advance without catch-up
bursts, and no work queues while paused or actively closed. F-081 supplied the missing piece — a
farmer approved through any onboarding door now starts on a `weekly` schedule, where before the
candidate query selected against an empty table and the machinery reached nobody.

### GL-013 — Turn the public stand list into the required discovery product

**Completed:** 2026-08-06 — the map is a real geographic view (F-043's drawn island, F-070's twelve
roads) beside a listing view, with toggle filters over structured facts, stand detail, honest
recency and stale warnings, closures, participant names, transient browser proximity, and
destination-only links. Browsing stays model-free and no runtime geocoder was reintroduced: the one
approved geocode call site is the onboarding address lookup (F-069), and `architecture.test.ts`
fails on a second caller.

**Open in a narrower form:** whether `?hidden=true` needs to survive the Squarespace embed (F-044
owns the embed check).

### GL-014 — Complete the canonical listing-data pipeline

**Confirmed gap**

The schema can hold structured availability, offerings, payments, and Farm Bucks, but the current
seed/read paths do not carry them end to end:

- `open_days` is never populated;
- a parsed stocking qualifier is discarded;
- payment methods are never loaded;
- Farm Bucks defaults to `false`, conflating “no” with “not loaded”;
- approved offerings have no public reader;
- public web and SMS read only a narrow subset of listing facts.

**Required outcome**

- Preserve unknown separately from a truthful negative where the source does not state a fact.
- Parse and load open weekdays where the source supports them.
- Preserve stocking caveats as display-only farmer/source wording.
- Load approved offerings, payment methods, and Farm Bucks facts.
- Read the same canonical listing facts from web and SMS.
- Add corpus-level tests over the real approved artifact, including the suspicious Venison Valley /
  Aeggy's cross-row-looking text in `maps/offerings-proposals.json`.

**Code complete (2026-08-06); the production ingest run is what remains.** The F-059 audit
([archived](archive/LISTING_INGESTION_AUDIT_2026-08-04.md)) superseded this item's bullets and
produced F-061 → F-064, all merged and deployed. Every bullet above is now met in code: `open_days`
and stocking qualifiers are written, payment methods and Farm Bucks load, offerings have a public
reader, and web and SMS read the same canonical facts. The invented `EXPECTED_COLUMNS` parser the
audit found is gone.

**Still owed, and it is a data run rather than a build:** F-064's production ingest — a re-export of
all three CSVs, a `neondb` snapshot (with an insert-only utility the snapshot *is* the rollback),
max's explicit approval for the bulk write, and a render check on a real card afterwards. Until it
runs, production serves the pre-tranche listing content through the new code. Tracked in
CURRENT_STATE.

### GL-015 — Provide a real listing-correction path

**Largely met (2026-08-07); one half remains.** The correction route now belongs to the **farmer
surface**: `/stand/<token>/listing` (F-073) lets an onboarded farmer fix address, hours, type,
payments, and items themselves, and re-running the seed never overwrites a farmer's later
correction — the batch is skip-only by stand name.

**Still open:** resolving a `stand_data_flag` still records the decision without applying a
correction, so an operator closing a review item has no documented route to finish the fix for a
farm with no farmer yet. Attribution for whoever does apply it is F-065.

---

## Priority 2 — resilience, quality, and operational readiness

### GL-016 — Record worker failures and poison work

**Confirmed risk**

`runInboundPass` catches all routing errors, leaves the claim to lapse, and still increments its
`processed` count. The cron route may return HTTP 200 while no consequence completed, and a
permanently failing event can retry forever without an operator-visible reason.

**Required outcome**

- Distinguish attempted, completed, recovered, failed, and deferred counts.
- Store or emit bounded content-free failure diagnostics.
- Define a bounded poison-work policy and an operator recovery action.
- Preserve durable retry for transient failure without silently losing the event.

**Inherited from GL-003:** the outbound pass already returns `failed` and `recovered` counts, and
quarantined dispatches are durable and queryable (`outbox_work.state = 'ambiguous'` with
`outbox_dispatch_attempts.error_code = 'dispatch_lease_expired'`). What GL-003 deliberately did not
build is anywhere for an operator to *read* that — it belongs here and in GL-018, not in a third
bespoke surface.

### GL-017 — Prove scheduler capacity and choose one production scheduler

**Confirmed risk**

Inbound, outbound, delivery, and retention passes run sequentially; model repair can multiply
provider latency. Cloud Scheduler is the sole production recovery trigger, but bounded-batch
capacity and backlog recovery still need proof against the deployed request deadline.

**Required outcome**

- Calculate and test bounded work that fits the actual runtime limit.
- Ensure backlog recovery makes forward progress under provider timeouts and poison events.
- Keep Cloud Scheduler as the single recovery trigger and verify it by database effect.
- Alert on missed/stale scheduled work.

### GL-018 — Add meaningful readiness and operational diagnostics

**Confirmed risk**

`GET /api/health` always returns success without checking configuration, database access, providers,
or worker state.

**Required outcome**

- Keep a cheap liveness response if useful.
- Add an authenticated readiness/diagnostic path that verifies database connectivity, migration
  level, required configuration, scheduler freshness, and stuck work without exposing secrets or
  message content.
- Alert on abandoned dispatches, poison inbound work, growing pending queues, repeated provider
  failures, and retention not running.

**Inherited from GL-003:** abandoned dispatches are already quarantined durably and identifiable by
`outbox_dispatch_attempts.error_code = 'dispatch_lease_expired'`. This item owns exposing them.

### GL-019 — Fail closed on production model configuration

**Completed:** 2026-07-29 — `LLM_PROVIDER` is required everywhere with no default; production
explicitly selects the attested DeepInfra provider, while stub use must be deliberate. Public map
browsing remains structurally model-free. Provider visibility in readiness remains GL-018.

### GL-020 — Implement real model repair and output ceilings

**Confirmed risk**

The “repair retry” repeats the identical provider call with identical projected context and schema.
It does not include the rejected output or validation failure. With deterministic decoding it is
likely to repeat the same answer while doubling latency and cost. Several schemas also lack useful
string/array bounds, and the live request has no output-token limit.

**Required outcome**

- Either implement a genuine bounded repair prompt or remove the misleading retry.
- Bound output tokens, item counts, identifier counts, and user-facing string lengths.
- Preserve strict schemas and evidence/membership validation.
- Record content-free model-run latency, repair, token, and cost evidence in `model_runs`.
- Keep raw prompts and completions out of durable evidence.

### GL-021 — Connect SMS segment metrics and cost limits to production sending

**Confirmed risk**

Production uses `createLastMileSender` and does not estimate, log, or cap segments. Long
model-derived confirmation text can therefore create unexpected billable messages.

GL-035 removed the unused `SmsSimulator` the estimator and metrics logger used to hang off, and
deleted the metrics logger with it — it had no other caller. `estimateSmsSegments` and
`normalizeAvoidableSmsUnicode` survive in `packages/sms/src/segments.ts` and are the machinery this
item attaches to the real send path; the normalizer is already on it, via the outbound guard.
There is now exactly one send seam to attach to.

**Required outcome**

- Estimate segments after outbound normalization/redaction on the real send path.
- Record content-free segment/cost metrics by recipient hash.
- Set product-appropriate maximum lengths or segment counts by message category.
- Clarify rather than silently truncate a confirmation whose full content the farmer must review.

### GL-022 — Retry only genuinely retryable provider rejections

**Confirmed risk**

The transport classifies 400, 401, 403, 404, and 422 as definite rejection, and the database retries
every definite rejection up to the attempt ceiling. This includes invalid credentials, invalid
requests, and `recipient_unresolved`, which the last-mile sender explicitly calls non-retryable.

**Required outcome**

- Carry a retryable/permanent distinction into `recordDispatchResult`.
- Retry only errors with a plausible transient correction.
- Apply bounded delay/backoff rather than immediate repeated attempts.
- Keep ambiguous outcomes quarantined.

### GL-023 — Improve inquiry matching without a hard-coded food taxonomy

**Confirmed quality risk**

The interpretation model sees the customer's question but not the database vocabulary. Code then
requires exact normalized item and farm strings. Ordinary plural, spelling, or synonym differences
can yield a false “no current listing.”

**Required outcome**

- Give semantic interpretation access to a bounded, typed vocabulary derived from current
  canonical offerings/inventory, or introduce a code-owned alias/normalization layer sourced from
  data rather than farm/product policy constants.
- Preserve code-owned retrieval, identifier membership validation, and code-rendered factual text.
- Add live-quality fixtures for plurals, spelling variants, and common synonym cases.

### GL-024 — Replace the in-process throttle with a launch-honest control

**Confirmed risk**

The anonymous public throttle is a per-process `Map`. Cold starts and concurrent instances each
receive a fresh budget. The client signal is deliberately spoofable. This is acceptable as casual
friction but not as a system-wide model/mail cost ceiling.

**Required outcome**

- Decide the real launch threat/cost ceiling.
- If a hard ceiling is required, enforce it through shared state or a provider/platform limit.
- Keep stock-out and sign-in budgets separate.
- Keep the coarse client signal out of authorization and durable customer profiling.

### GL-025 — Make deployment and CI reproducible

**Confirmed risk**

The manual Cloud Build/OpenTofu deploy path is asserted, but no repository workflow runs the
verification ladder on proposed changes. Isolated web installs also omit the TypeScript ESLint
parser/plugin that root dependency hoisting supplies.

**Required outcome**

- Make `apps/web` declare every dependency its lint/build requires.
- Add CI for unit tests, full typecheck, lint, real-Postgres integration tests, offline evals, and
  production build.
- Make the production source state match the committed source state.
- Do not push, deploy, or publish automatically without Max's explicit approval.

---

## Priority 3 — decisions and future alignment

### GL-026 — Define multiple-sales-location SMS interaction

The schema correctly allows a farm to have several sales locations. Today, an authorized farmer
with more than one receives a generic clarification with no way to choose a location, so every reply
repeats the same dead end.

Define a deterministic selection interaction or a default-location preference before onboarding a
multi-location farm. A model must not choose the authoritative location identifier.

### GL-027 — Resolve farm-related service businesses (F-038)

`sales_location_kind` admits only `farm_stand` and `farmers_market`. Seedrain / Garden Cycles offers
services rather than current stock. Forcing it into a stand makes the inventory and stock-out
workflows nonsensical.

Settle whether service businesses appear as a new public location/farm-profile type and whether they
participate in SMS at all. Do not hard-code a particular business name into behavior.

### GL-028 — Set approval-revocation visibility semantics

Current behavior blocks a farm's next publication after VIGA approval is revoked but leaves its
already-current inventory visible.

Recommended launch rule:

- keep the basic reference stand listing visible when appropriate;
- immediately hide farmer-confirmed current inventory from web and SMS while approval is revoked;
- retain immutable revision and approval history;
- restore visibility only through an explicit reapproval/current-publication rule, not by mutating
  history.

### GL-029 — Align flagged-thread retention wording and behavior

The purge protects only the exact message carrying an open flag. The thread viewer loads every
retained inbound message from that sender, so surrounding context may already be purged while the
flag remains open.

Choose one honest contract:

- retain a bounded sender-thread window while any flag is open; or
- preserve only the flagged evidence and make the UI/documentation stop promising a fully readable
  thread.

Privacy minimization favors the second unless operators need surrounding context to make the review
meaningful.

### GL-030 — Reconcile the DeepInfra retention attestation

The provider gate requires a finite approved maximum. The declaration records zero days while the
same source acknowledges a discretionary, unbounded exception for a small portion of requests.
That caveat was explicitly reviewed and accepted, so this is governance clarity rather than a
hidden implementation vulnerability.

Make the gate express “accepted documented exception” honestly instead of reporting that a finite
zero-day guarantee was proven.

---

## Documentation and architecture housekeeping

Do this after the P0 recovery defects are understood, and before broad acceptance testing creates
more status history.

### GL-031 — Retire “clean-room” as the living design authority

**Completed:** 2026-07-28 — enduring decisions moved to their owning product/architecture docs;
both handoffs are explicitly historical and no longer sit in the startup path. Document ownership
is indexed in README and CLAUDE.md.

### GL-032 — Remove stale and contradictory status claims

**Completed:** 2026-07-28 — contract docs carry enduring requirements only and point to
CURRENT_STATE for build/deployment status. Pinned carrier-console copy was left untouched.

### GL-033 — Add the missing environment template

**Completed:** 2026-07-28 — `.env.example` names required variables with safe placeholders,
explicit-provider rules, the never-rotate salt warning, and deliberately unconfigured mail.

### GL-034 — Align JOIN/START compliance copy

**Completed (repo half):** 2026-07-28 — the code was already right; the words were not. Reviewed
every place a human is told how to start or resume messages. **Two console edits remain and are
max's to make** — see "Owed in the Telnyx console" below.

Repository copy now consistently says `JOIN` for first-time opt-in and `START` after opt-out;
`return-after-optout-copy.test.ts` pins both rules. `TELNYX_10DLC_FIELD_VALUES.txt` remains a
transcript of live console state and changes only after the console.

#### Owed in the Telnyx console — max's action, may require campaign re-approval

Note first how much of this is **not ours**: Telnyx auto-answers `STOP`/`START` in *its own* copy,
not ours, and enforces its block list independently of the profile's auto-response fields. So the
registered opt-out auto-response below is not the message a real opted-out user necessarily reads,
and changing it may not change their experience. Both edits are for **consistency of the
registration with the published page**, not for delivery. Weigh that against the cost of a
re-review before making them.

**1. `Opt In Workflow Description` (Content Details).** It quotes the public page verbatim, and the
page has now changed, so the quote is stale.

- *Current* — the quoted block ends: `… Reply HELP for help. Reply STOP to unsubscribe. Terms: …`
- *Desired* — insert one sentence after `Reply STOP to unsubscribe.`:
  `If you have unsubscribed before, reply START to resume messaging.`

**2. `Opt out message` (Auto-Responses).** Names no way back.

- *Current:* `VIGA Farm Friend: You have been unsubscribed and will no longer receive messages from us. Reply HELP for assistance.`
- *Desired:* `VIGA Farm Friend: You have been unsubscribed and will no longer receive messages from us. Reply START to resubscribe, HELP for assistance.`
- **Caveat:** this is the lower-value of the two. Telnyx's own STOP handling may answer first, and
  it is 160-character sensitive — the desired text measures **138** characters, so it still fits one
  GSM-7 segment.

After either edit lands in the console: transcribe the result into
`docs/TELNYX_10DLC_FIELD_VALUES.txt`. `auto-responses.test.ts` and `commands.test.ts` will fail
until `packages/core/src/sms/auto-responses.ts` matches, which is the intended order.

### GL-035 — Remove or reconnect dead parallel mechanisms

**Completed:** 2026-07-28 — administrator identity narrowed to one direct authority; dead SMS
delivery types removed and the provenance test re-anchored to the live last-mile type; proposal
activation now has one shared writer. Segment estimation remains for GL-021.

### GL-036 — Keep historical logs out of the normal reading path

**Completed:** 2026-07-28 — session logs and handoffs remain unchanged for forensic use but are
indexed as historical and excluded from cold-start reading. Rotation behavior remains owned by
`/session-wrap`.

---

## Architecture strengths to preserve

The review found substantial strengths. Do not lose these while closing the gaps:

- Four-package dependency direction is small, clear, and architecture-tested.
- The model receives narrow task projections and no database/repository capability.
- Code owns recipient resolution, authority, consent, retrieval, identifier membership, factual
  rendering, and every durable consequence.
- Publication requires a version-bound, provider-activated farmer confirmation and rechecks current
  farmer authority plus VIGA approval.
- Database constraints enforce deduplication, one current revision, one open proposal, coherent
  state, immutable publication history, and minimized contact handling.
- STOP is rechecked at dispatch and required replies remain possible.
- Raw phone containment, exact-body webhook signature verification, minimized provider events, and
  body retention expiry are structurally strong.
- Public browsing is model-free and browser location remains transient.
- Admin pages resolve the session before reading; mutation routes and the flag-thread GET share the
  server-side guard; the acting administrator comes from the session, not the request body; write
  transactions recheck authority and audit the action.
- The repository correctly avoids speculative tenancy, future-program enrollment, gleaning,
  volunteer, Farm Bucks transaction, native-app, and multi-organization machinery.

---

## Verification baseline from the review

Historical July 28 results and limitations are in SESSION_LOG. Use CURRENT_STATE for the latest
verified baseline; never carry old test counts forward as current evidence.

## Required verification ladder

For ordinary changes:

1. Focused tests for the affected behavior.
2. `npm test`
3. `npm run typecheck`
4. `npm run lint`

For database, worker, authorization, consent, delivery, or public-data changes, also run:

5. `npm run test:integration` against a role that can create/drop the suite's throwaway databases.
6. `npm run evals` for model seam or projection changes.
7. `npm run build --workspace @farm-friend/web`

Before go-live:

8. Run the full ladder under the declared Node 20 runtime.
9. Run approved live-provider quality evals with explicit authorization for network/cost.
10. Exercise the complete customer, farmer, and administrator journeys hands-on in a disposable
    environment.
11. Verify scheduler execution, queue recovery, retention, provider delivery callbacks, readiness,
    and alerts by observed effect rather than configuration alone.
12. Rotate/verify production credentials, load approved seed data, migrate the production database,
    and deploy only with Max's explicit approval.

## Go-live exit criteria

Farm Friend is ready for a go-live decision only when:

- every P0 and P1 item is complete;
- every P2 item is complete or explicitly accepted with a documented owner and contingency;
- no exposed credential remains valid;
- the complete automated ladder is green under the declared runtime;
- the deployed scheduler and all four worker passes are proven by effect;
- the fixed administrator can sign in, reach every admin surface, sign out, and have the copied
  cookie refused;
- a farmer can onboard, be approved, set preferences, publish confirmed inventory by SMS and web,
  and receive a stock-out prompt;
- a customer can use the real map/listing, ask a grounded SMS question, and submit a private
  location-bound report;
- web and SMS read the same canonical listing and current-inventory facts;
- STOP, ambiguous dispatch, worker recovery, retention, and revocation behavior survive deliberate
  failure-path testing;
- operational diagnostics reveal stuck work without revealing message content, raw phones, or
  credentials;
- current documentation describes the system that is actually deployed.
