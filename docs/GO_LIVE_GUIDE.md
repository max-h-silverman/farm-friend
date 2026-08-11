# Farm Friend — Go-live guide

The working guide from the July 28, 2026 whole-codebase architectural review to a safe, complete
Phase 1 launch. Work through it in priority order. It is deliberately more operational than the
product and architecture documents: those describe the intended product and its enduring rules; this
says what remains between the current repository and go-live.

Enduring outcomes live in their owning product/architecture docs. Current build, deployment, data,
and open-item status lives only in [CURRENT_STATE.md](CURRENT_STATE.md).

## How to use this guide

1. Start with the first incomplete item in the lowest open priority band.
2. Treat each item as a small tranche with its own tests and documentation update.
3. Do not mark an item complete because a unit test exercises a helper. Prove the production wiring or
   the relevant platform behavior too.
4. Run the verification ladder at the end of this document after each tranche, in proportion to its
   risk.
5. Keep this guide current. Enduring decisions belong in the appropriate product or architecture
   document; this file should eventually become a short release checklist.

Every `GL-###` item is open unless it carries a **Completed** or **Superseded** line. A partial
implementation remains open; record partial evidence in the item without marking it complete.

Priority means:

- **P0 — must precede broad hands-on testing:** a security, compliance, recovery, or verification
  defect could make test results misleading or leave consequential work in the wrong state.
- **P1 — required for Phase 1 acceptance testing:** a canonical launch journey or operational
  capability is absent or disconnected.
- **P2 — required before go-live:** the journey exists, but quality, resilience, observability, or
  repeatability is below the launch bar.
- **P3 — explicitly deferred:** important architectural alignment that does not block launch unless its
  product assumption changes.

---

## Closed items

Retained as a record of what the review found and how it was answered. Each is closed; none needs
reading to do current work.

**Priority 0 — safety and truthful checks**

| Item | Outcome |
|---|---|
| GL-001 Rotate exposed credentials | **Completed** 2026-07-29 — provider credentials rotated, old values rejected, both services verified newer than every consumed secret version. `PHONE_HASH_SALT` preserved; `CRON_SECRET` removed with the GCP migration. Procedure: RUNBOOK §Credential rotation |
| GL-002 Delayed `STOP` reaches consent ordering | **Completed** 2026-07-28 — compliance parsing precedes conversation staleness; sabotage-verified both directions. Owned by ARCHITECTURE §SMS ingress and SMS_COMPLIANCE |
| GL-003 Recover abandoned dispatch claims | **Completed** 2026-07-28 — abandoned leases become `ambiguous`, never queued for resend; failures isolated per row. Operator visibility remains GL-016/GL-018 |
| GL-004 Protect administrator sign-in | **Superseded by F-056** — one fixed database identity plus a configured password, with durable client and account-wide throttles. Pre-cutover sessions revoked by the cutover migration |
| GL-005 Typecheck covers what its name claims | **Completed** 2026-07-28 (`72bdac8`) — root typecheck covers packages and web with no suppressions; `typecheck-coverage.test.ts` prevents drift |
| GL-006 Repair migration generator metadata | **Completed** 2026-07-28 (`1a5d525`) — schema snapshot restored without changing applied SQL; `migration-metadata.test.ts` requires the newest migration/snapshot pair |

**Priority 1 — canonical journeys**

| Item | Outcome |
|---|---|
| GL-007 Stock-out reports → farmer alert | **Completed** 2026-08-10 — `recordStockOutReport` commits the report and its `stock_out_alert` outbox work in ONE transaction, so "recorded" and "the farmer was prompted" cannot diverge. Idempotent on `logical_key` and on `stock_out_reports.report_key` (migration `0038`). The alert body is code-rendered from two typed facts — the bound stand's name and, for a listed entry, the stand's own item name; **an unlisted report names no item at all**, because model output derived from a stranger's SMS reached the farmer verbatim before the shape changed, and a publication gate that asks the author to retry cannot ask someone who has walked away |
| GL-008 Customer stock-out surface | **Superseded by F-104** (max, 2026-08-10) — the customer surface is **SMS**, not a QR/web form. `POST /api/public/stock-out` and its throttle remain as the entry point should a web surface ever be wanted; its retained spec is below |
| GL-009 Administrator sign-in operable | **Superseded by F-056** — no mail provider in the launch architecture. Go-live proof is the fixed account signing in, receiving a hashed durable session, reaching admin, signing out, and having the copied cookie refused |
| GL-010 Farmer onboarding and number verification | **Completed** 2026-08-07 — three doors deployed: invited, grandfathered (`/farmer/start`, F-072), and the emailed-code migration door (F-079). F-081 closed the last sub-item, the default reminder schedule. **Launch cannot rely on email onboarding until B-045 is resolved** — see CURRENT_STATE.md |
| GL-011 Farmer web profile, listing, preferences, inventory | **Completed** 2026-08-07 — `/stand/<token>/listing` (F-073) and `/stand/<token>/settings` live behind the standing farmer link. Attribution for who wrote a listing change is tracked as F-065 |
| GL-012 Proactive inventory prompts and scheduling | **Completed** 2026-08-07 — `inventory_prompt_preferences` stores the per-stand cadence; `packages/db/src/scheduled-prompts.ts` creates at most one due prompt per sender at the 10:00 AM stand-local slot. Consent rechecked at dispatch; delayed schedules advance without catch-up bursts |
| GL-013 Public stand list → discovery product | **Completed** 2026-08-06 — a real geographic view beside a listing view, with toggle filters, stand detail, honest recency and stale warnings, closures, participant names, transient proximity, and destination-only links. **Open in a narrower form:** whether `?hidden=true` survives the Squarespace embed (F-044) |
| GL-014 Canonical listing-data pipeline | **Completed** 2026-08-09 — F-061 → F-064 carry structured availability, payment methods, Farm Bucks, and approved offerings through the shared seed/read path. Web and SMS read the same canonical facts |
| GL-015 Real listing-correction path | **Largely met** 2026-08-07 — `/stand/<token>/listing` (F-073) lets an onboarded farmer fix address, hours, type, payments, and items, and re-running the seed never overwrites a later correction. **Still open:** resolving a `stand_data_flag` records the decision without applying a correction, so an operator closing a review item has no documented route to finish the fix for a farm with no farmer yet |

**Priority 2 and housekeeping**

| Item | Outcome |
|---|---|
| GL-019 Fail closed on model configuration | **Completed** 2026-07-29 — `LLM_PROVIDER` required everywhere with no default; production explicitly selects the attested provider. Provider visibility in readiness remains GL-018 |
| GL-031 Retire "clean-room" as living authority | **Completed** 2026-07-28 — enduring decisions moved to their owning docs; both handoffs explicitly historical |
| GL-032 Remove stale status claims | **Completed** 2026-07-28 — contract docs carry enduring requirements only and point to CURRENT_STATE |
| GL-033 Add the environment template | **Completed** 2026-07-28 — `.env.example` names required variables with safe placeholders and the never-rotate salt warning |
| GL-034 Align JOIN/START compliance copy | **Completed (repo half)** 2026-07-28 — repository copy consistently says `JOIN` for first-time opt-in and `START` after opt-out; `return-after-optout-copy.test.ts` pins both. **Two console edits remain and are max's** — see below |
| GL-035 Remove dead parallel mechanisms | **Completed** 2026-07-28 — administrator identity narrowed to one direct authority; dead SMS delivery types removed; proposal activation has one shared writer. Segment estimation remains for GL-021 |
| GL-036 Keep historical logs out of the reading path | **Completed** 2026-07-28 — session logs and handoffs indexed as historical and excluded from cold-start reading |

### GL-008 — retained web-surface spec (not built)

Should a web reporting surface ever be wanted:

- Provide a location-bound reporting route or stand-page form.
- Generate or document stable QR destinations for sales locations.
- Bind the sales-location identifier in the surface rather than asking the model to choose it.
- Provide honest success, malformed-input, throttled, and unavailable states without revealing private
  farmer information.

What shipped instead: a customer texts that something is sold out, a `customer-message-intent` seam
classifies report-vs-question, and code resolves which stand from the customer's own words. The stand
match is against real rows and must be UNAMBIGUOUS — no match, or two stands matching equally, both
produce "Which stand are you at?" rather than a guess, because a customer has no farm affiliation to
disambiguate against and a wrong guess texts an unrelated farmer. ARCHITECTURE.md §routing owns the
current ladder.

### GL-034 — owed in the Telnyx console (max's action, may require campaign re-approval)

Note first how much of this is **not ours**: Telnyx auto-answers `STOP`/`START` in *its own* copy, and
enforces its block list independently of the profile's auto-response fields. So the registered opt-out
auto-response is not necessarily the message a real opted-out user reads. Both edits are for
**consistency of the registration with the published page**, not for delivery.

**1. `Opt In Workflow Description` (Content Details).** It quotes the public page verbatim, and the
page has changed, so the quote is stale.

- *Current* — the quoted block ends: `… Reply HELP for help. Reply STOP to unsubscribe. Terms: …`
- *Desired* — insert one sentence after `Reply STOP to unsubscribe.`:
  `If you have unsubscribed before, reply START to resume messaging.`

**2. `Opt out message` (Auto-Responses).** Names no way back.

- *Current:* `VIGA Farm Friend: You have been unsubscribed and will no longer receive messages from us. Reply HELP for assistance.`
- *Desired:* `VIGA Farm Friend: You have been unsubscribed and will no longer receive messages from us. Reply START to resubscribe, HELP for assistance.`
- **Caveat:** the lower-value of the two. Telnyx's own STOP handling may answer first, and it is
  160-character sensitive — the desired text measures **138**, so it still fits one GSM-7 segment.

After either edit lands: transcribe the result into `docs/TELNYX_10DLC_FIELD_VALUES.txt`.
`auto-responses.test.ts` and `commands.test.ts` will fail until `packages/core/src/sms/auto-responses.ts`
matches, which is the intended order.

---

## Priority 2 — open: resilience, quality, operational readiness

### GL-016 — Record worker failures and poison work

**Confirmed risk.** `runInboundPass` catches all routing errors, leaves the claim to lapse, and still
increments its `processed` count. The cron route may return HTTP 200 while no consequence completed,
and a permanently failing event can retry forever without an operator-visible reason.

**Required outcome**

- Distinguish attempted, completed, recovered, failed, and deferred counts.
- Store or emit bounded content-free failure diagnostics.
- Define a bounded poison-work policy and an operator recovery action.
- Preserve durable retry for transient failure without silently losing the event.

**Inherited from GL-003:** the outbound pass already returns `failed` and `recovered` counts, and
quarantined dispatches are durable and queryable (`outbox_work.state = 'ambiguous'` with
`outbox_dispatch_attempts.error_code = 'dispatch_lease_expired'`). Nowhere for an operator to *read*
that belongs here and in GL-018, not in a third bespoke surface.

### GL-017 — Prove scheduler capacity and choose one production scheduler

**Confirmed risk.** Inbound, outbound, delivery, and retention passes run sequentially; model repair
can multiply provider latency. Cloud Scheduler is the sole production recovery trigger, but
bounded-batch capacity and backlog recovery still need proof against the deployed request deadline.

**Required outcome**

- Calculate and test bounded work that fits the actual runtime limit.
- Ensure backlog recovery makes forward progress under provider timeouts and poison events.
- Keep Cloud Scheduler as the single recovery trigger and verify it by database effect.
- Alert on missed/stale scheduled work.

### GL-018 — Add meaningful readiness and operational diagnostics

**Confirmed risk.** `GET /api/health` always returns success without checking configuration, database
access, providers, or worker state.

**Required outcome**

- Keep a cheap liveness response if useful.
- Add an authenticated readiness/diagnostic path verifying database connectivity, migration level,
  required configuration, scheduler freshness, and stuck work without exposing secrets or message
  content.
- Alert on abandoned dispatches, poison inbound work, growing pending queues, repeated provider
  failures, and retention not running.

**Inherited from GL-003:** abandoned dispatches are already quarantined durably and identifiable by
`error_code = 'dispatch_lease_expired'`. This item owns exposing them.

### GL-020 — Implement real model repair and output ceilings

**Confirmed risk.** The "repair retry" repeats the identical provider call with identical projected
context and schema. It does not include the rejected output or validation failure. With deterministic
decoding it is likely to repeat the same answer while doubling latency and cost. Several schemas also
lack useful string/array bounds, and the live request has no output-token limit.

**Required outcome**

- Either implement a genuine bounded repair prompt or remove the misleading retry.
- Bound output tokens, item counts, identifier counts, and user-facing string lengths.
- Preserve strict schemas and evidence/membership validation.
- Record content-free model-run latency, repair, token, and cost evidence in `model_runs`.
- Keep raw prompts and completions out of durable evidence.

### GL-021 — Connect SMS segment metrics and cost limits to production sending

**Confirmed risk.** Production uses `createLastMileSender` and does not estimate, log, or cap segments.
Long model-derived confirmation text can create unexpected billable messages.

`estimateSmsSegments` and `normalizeAvoidableSmsUnicode` in `packages/sms/src/segments.ts` are the
machinery this item attaches to the real send path; the normalizer is already on it via the outbound
guard. There is exactly one send seam to attach to.

**Required outcome**

- Estimate segments after outbound normalization/redaction on the real send path.
- Record content-free segment/cost metrics by recipient hash.
- Set product-appropriate maximum lengths or segment counts by message category.
- Clarify rather than silently truncate a confirmation whose full content the farmer must review.

### GL-022 — Retry only genuinely retryable provider rejections

**Confirmed risk.** The transport classifies 400, 401, 403, 404, and 422 as definite rejection, and the
database retries every definite rejection up to the attempt ceiling. This includes invalid credentials,
invalid requests, and `recipient_unresolved`, which the last-mile sender explicitly calls
non-retryable.

**Required outcome**

- Carry a retryable/permanent distinction into `recordDispatchResult`.
- Retry only errors with a plausible transient correction.
- Apply bounded delay/backoff rather than immediate repeated attempts.
- Keep ambiguous outcomes quarantined.

### GL-023 — Improve inquiry matching without a hard-coded food taxonomy

**Confirmed quality risk.** The interpretation model sees the customer's question but not the database
vocabulary. Code then requires exact normalized item and farm strings. Ordinary plural, spelling, or
synonym differences can yield a false "no current listing."

**Required outcome**

- Give semantic interpretation access to a bounded, typed vocabulary derived from current canonical
  offerings/inventory, or introduce a code-owned alias/normalization layer sourced from data rather
  than farm/product policy constants.
- Preserve code-owned retrieval, identifier membership validation, and code-rendered factual text.
- Add live-quality fixtures for plurals, spelling variants, and common synonym cases.

### GL-024 — Replace the in-process throttle with a launch-honest control

**Confirmed risk.** The anonymous public throttle is a per-process `Map`. Cold starts and concurrent
instances each receive a fresh budget. The client signal is deliberately spoofable. Acceptable as
casual friction but not as a system-wide model/mail cost ceiling.

**Required outcome**

- Decide the real launch threat/cost ceiling.
- If a hard ceiling is required, enforce it through shared state or a provider/platform limit.
- Keep stock-out and sign-in budgets separate.
- Keep the coarse client signal out of authorization and durable customer profiling.

### GL-025 — Make deployment and CI reproducible

**Confirmed risk.** The manual Cloud Build/OpenTofu deploy path is asserted, but no repository workflow
runs the verification ladder on proposed changes. Isolated web installs also omit the TypeScript
ESLint parser/plugin that root dependency hoisting supplies.

**Required outcome**

- Make `apps/web` declare every dependency its lint/build requires.
- Add CI for unit tests, full typecheck, lint, real-Postgres integration tests, offline evals, and
  production build.
- Make the production source state match the committed source state.
- Do not push, deploy, or publish automatically without Max's explicit approval.

---

## Priority 3 — open: decisions and future alignment

### GL-026 — Define multiple-sales-location SMS interaction

The schema correctly allows a farm to have several sales locations. Today, an authorized farmer with
more than one receives a generic clarification with no way to choose a location, so every reply repeats
the same dead end. Define a deterministic selection interaction or a default-location preference before
onboarding a multi-location farm. A model must not choose the authoritative location identifier.

### GL-027 — Resolve farm-related service businesses (F-038)

`sales_location_kind` admits only `farm_stand` and `farmers_market`. A services business offers no
current stock; forcing it into a stand makes the inventory and stock-out workflows nonsensical. Settle
whether service businesses appear as a new public location/farm-profile type and whether they
participate in SMS at all. Do not hard-code a particular business name into behavior.

### GL-028 — Set approval-revocation visibility semantics

Current behavior blocks a farm's next publication after VIGA approval is revoked but leaves its
already-current inventory visible. Recommended launch rule:

- keep the basic reference stand listing visible when appropriate;
- immediately hide farmer-confirmed current inventory from web and SMS while approval is revoked;
- retain immutable revision and approval history;
- restore visibility only through an explicit reapproval/current-publication rule, not by mutating
  history.

### GL-029 — Align flagged-thread retention wording and behavior

The purge protects only the exact message carrying an open flag. The thread viewer loads every retained
inbound message from that sender, so surrounding context may already be purged while the flag remains
open. Choose one honest contract: retain a bounded sender-thread window while any flag is open; or
preserve only the flagged evidence and make the UI/documentation stop promising a fully readable
thread. Privacy minimization favors the second unless operators need surrounding context to make the
review meaningful.

### GL-030 — Reconcile the DeepInfra retention attestation

The provider gate requires a finite approved maximum. The declaration records zero days while the same
source acknowledges a discretionary, unbounded exception for a small portion of requests. That caveat
was explicitly reviewed and accepted, so this is governance clarity rather than a hidden implementation
vulnerability. Make the gate express "accepted documented exception" honestly instead of reporting that
a finite zero-day guarantee was proven.

---

## Architecture strengths to preserve

The review found substantial strengths. Do not lose these while closing the gaps:

- Four-package dependency direction is small, clear, and architecture-tested.
- The model receives narrow task projections and no database/repository capability.
- Code owns recipient resolution, authority, consent, retrieval, identifier membership, factual
  rendering, and every durable consequence.
- Publication requires a version-bound, provider-activated farmer confirmation and rechecks current
  farmer authority plus VIGA approval.
- Database constraints enforce deduplication, one current revision, one open proposal, coherent state,
  immutable publication history, and minimized contact handling.
- STOP is rechecked at dispatch and required replies remain possible.
- Raw phone containment, exact-body webhook signature verification, minimized provider events, and body
  retention expiry are structurally strong.
- Public browsing is model-free and browser location remains transient.
- Admin pages resolve the session before reading; mutation routes and the flag-thread GET share the
  server-side guard; the acting administrator comes from the session, not the request body; write
  transactions recheck authority and audit the action.
- The repository correctly avoids speculative tenancy, future-program enrollment, gleaning, volunteer,
  Farm Bucks transaction, native-app, and multi-organization machinery.

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
11. Verify scheduler execution, queue recovery, retention, provider delivery callbacks, readiness, and
    alerts by observed effect rather than configuration alone.
12. Rotate/verify production credentials, load approved seed data, migrate the production database, and
    deploy only with Max's explicit approval.

Never carry old test counts forward as current evidence; CURRENT_STATE holds the latest verified
baseline.

## Go-live exit criteria

Farm Friend is ready for a go-live decision only when:

- every P0 and P1 item is complete;
- every P2 item is complete or explicitly accepted with a documented owner and contingency;
- no exposed credential remains valid;
- the complete automated ladder is green under the declared runtime;
- the deployed scheduler and all four worker passes are proven by effect;
- the fixed administrator can sign in, reach every admin surface, sign out, and have the copied cookie
  refused;
- a farmer can onboard, be approved, set preferences, publish confirmed inventory by SMS and web, and
  receive a stock-out prompt;
- a customer can use the real map/listing, ask a grounded SMS question, and submit a private
  location-bound report;
- web and SMS read the same canonical listing and current-inventory facts;
- STOP, ambiguous dispatch, worker recovery, retention, and revocation behavior survive deliberate
  failure-path testing;
- operational diagnostics reveal stuck work without revealing message content, raw phones, or
  credentials;
- current documentation describes the system that is actually deployed.
