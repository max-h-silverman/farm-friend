# Farm Friend — Go-live guide

This is the working guide from the July 28, 2026 whole-codebase architectural review to a safe,
complete Phase 1 launch. Work through it in priority order. It is deliberately more operational
than the product and architecture documents: those describe the intended product and its enduring
rules; this document says what remains between the current repository and go-live.

## Status and baseline

- **Review baseline:** `e96d362b4071d7fea783aaf1593fcc0dec6d44e8` on `main`, matching
  `origin/main` when reviewed.
- **Review scope:** all 212 tracked files were accounted for. Source, tests, documentation,
  configuration, migrations, workflows, and data artifacts were read; generated lock and snapshot
  files were inspected structurally.
- **Current usage:** nobody is using Farm Friend. There is no customer or farmer reliance on current
  public inventory, and production was deliberately left unseeded.
- **Consequence:** compatibility with current public inventory is not a go-live constraint. Database
  and seed corrections may prefer the cleanest design over preserving unused state. This is not
  blanket authorization for destructive operations; confirm the exact target before deleting or
  resetting data.
- **Hard operational blocker already known:** exposed credentials must be rotated before production
  data is loaded or live testing begins (F-034).
- **Review changes:** the review itself made no repository changes.

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

**Problem**

The current-state documentation records exposure of `DATABASE_URL`, `CRON_SECRET`,
`TELNYX_API_KEY`, and the DeepInfra key. There may be no production user data, but exposed
credentials still permit unauthorized provider use or infrastructure access.

**Required outcome**

- Rotate every credential enumerated by F-034.
- Update the production environment, GitHub Actions secret, and any local secret store that
  legitimately needs the replacements.
- Verify the old values no longer authenticate.
- Do not copy new values into logs, documentation, issue text, or shell history.
- Load no real production data before this is complete.

**Scope verified 2026-07-28 against the live environment.** The procedure, order, and
proof-by-effect tables are `RUNBOOK.md` §"Credential rotation". Two corrections to the problem
statement above, both found by inspecting the real environment rather than the notes:

- **The DeepInfra key is not a production credential.** `LLM_PROVIDER`, `DEEPINFRA_API_KEY`, and
  `DEEPINFRA_MODEL` are absent from Vercel entirely, so the deployment runs the deterministic stub
  and the key lives only in the local `.env`. It stays in rotation scope — it authorizes DeepInfra
  spend — but it rotates in the DeepInfra console, not Vercel. That production silently runs the
  stub is the defect **GL-019** tracks.
- **The repository is clean; no history rewrite is needed.** `git grep` over the tracked tree finds
  no real connection string, key, or Neon host — every secret-shaped literal is a test fixture, and
  `.env` is gitignored and never committed. Exposure was confined to working transcripts.

**Decided 2026-07-28 — rotate in place.** The current Vercel project and Neon database become
production, so the throwaway-teardown line in F-034 no longer applies to them. The stale
`throwaway/hobby-deploy-test` branch is still owed a deletion.

**Deferred by Max 2026-07-28 — OPEN, and still a hard blocker on go-live.** The remaining work is
entirely provider-console action Max performs (Neon, Telnyx, and DeepInfra consoles, plus `vercel
env add` and `gh secret set`), followed by a redeploy and the proof-by-effect tables. Nothing else
in this guide depends on it, so later items proceed — but **no real farmer or customer data may be
loaded, and no live testing with real numbers may begin, until this closes.** That constraint is the
whole reason the deferral is safe: it holds only while the database stays unseeded.

Ready when Max is: `RUNBOOK.md` §"Credential rotation" carries the order, the two-place
`CRON_SECRET` requirement, the never-rotate `PHONE_HASH_SALT` rule, and the proofs that must pass
before this item is marked complete.

### GL-002 — Ensure a delayed `STOP` always reaches consent ordering

**Confirmed defect**

`claimNextInboundEvent` marks an event stale against the ordinary conversation watermark.
`runInboundPass` rejects a stale event before `routeInboundMessage` parses it. A delayed `STOP`
older than a subsequently processed ordinary message therefore never reaches
`applyConsentTransition`, even though STOP/START are documented as using an independent consent
watermark.

Relevant code:

- `packages/db/src/transactions.ts` — `claimNextInboundEvent`
- `apps/web/lib/workers.ts` — early stale-event rejection in `runInboundPass`
- `apps/web/lib/routing.ts` — deterministic compliance routing

**Required outcome**

- Parse or otherwise identify deterministic consent commands before applying the ordinary
  conversation-staleness rejection.
- Continue ordering STOP/START by their own provider-time watermark, with STOP winning an exact tie.
- Keep all model seams unreachable from this path.
- Add a real-Postgres test where:
  1. a newer ordinary message is fully processed and advances the conversation watermark;
  2. an older `STOP` arrives afterward;
  3. STOP still changes consent and suppresses later proactive dispatch.
- Preserve the intended refusal of stale ordinary conversation and confirmation messages.

### GL-003 — Recover abandoned outbound dispatch claims

**Confirmed defect**

`authorizeDispatch` commits `outbox_work.state = 'dispatching'` and an `authorized` attempt before
the worker reads the body, resolves a phone number, calls Telnyx, and records the result. A crash or
throw in that interval leaves the row permanently `dispatching`. The recovery worker resets only
inbound claims, and outbound enumeration selects only `queued` work.

Relevant code:

- `packages/db/src/transactions.ts` — `authorizeDispatch`, `recordDispatchResult`,
  `releaseAbandonedClaims`
- `apps/web/lib/workers.ts` — `queuedOutboxWorkIds`, `runOutboundPass`

**Required outcome**

- Give dispatch authorization an explicit recovery deadline or equivalent durable lease.
- After the deadline, quarantine abandoned authorized attempts as **ambiguous**, because the
  provider may have accepted the send.
- Never automatically resend an abandoned authorized attempt unless verified provider
  idempotency makes that safe.
- Handle throws from body lookup, redaction, recipient resolution, provider transport, and result
  recording.
- Add tests for process death or simulated throws at every boundary after authorization.
- Surface stuck/ambiguous work in operator diagnostics.

### GL-004 — Make admin magic links genuinely one-use

**Confirmed defect**

The magic-link token is a stateless signed email plus issued/expiry timestamps. Every callback
within 15 minutes can mint a fresh session. The email and architecture explicitly promise one-use
credentials and replay prevention.

Relevant code:

- `packages/core/src/auth/magic-link.ts`
- `apps/web/app/api/auth/callback/route.ts`
- `packages/core/src/auth/sign-in-email.ts`

**Required outcome**

- Add a random token identifier or hashed one-time credential record.
- Atomically consume it when the callback creates a session.
- A second use, including a concurrent second use, must fail without creating another session.
- Keep token bodies out of database storage, response bodies, and logs.
- Preserve the current short expiry and server-side administrator authorization lookup.

### GL-005 — Make the typecheck cover what its name claims

**Confirmed defect**

The root `npm run typecheck` runs `tsc -b`, but the root `tsconfig.json` references only
`packages/core`, `packages/db`, `packages/sms`, and `packages/ai`. It never checks `apps/web`.
A direct `npx tsc -p apps/web/tsconfig.json --noEmit` currently fails across web test files.

**Required outcome**

- Give the web workspace a supported typecheck command.
- Make the root typecheck invoke or reference it.
- Fix the current web type errors rather than excluding the affected tests.
- Preserve Next's production build check as a separate verification layer.
- Update the runbook so “typecheck across workspaces” becomes true.

### GL-006 — Repair migration generator metadata

**Confirmed defect**

Six migrations (`0000`–`0005`) are journaled, but Drizzle snapshots stop at `0001`. A safe
generation trial against a temporary copy immediately asked whether already-migrated schema
concepts were newly created or renamed. Migration application is currently correct; future
generation is not trustworthy.

**Required outcome**

- Reconstruct or regenerate correct snapshot metadata through the current schema without changing
  the meaning of already-applied migrations.
- Generate the next no-op/schema-diff trial in a temporary location and confirm it does not attempt
  to recreate or rename changes from `0002`–`0005`.
- Keep the empty-database migration and journal-idempotency integration tests green.

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

### GL-009 — Deliver admin sign-in email

**Confirmed gap**

The request form, enumeration-resistant response, throttle, token, callback, session, and admin
guard exist. The mail seam deliberately refuses to send pending F-031, so an operator cannot
actually receive the link.

**Required outcome**

- Select and configure a mail provider under an explicit data-handling review.
- Send the repository-rendered plain-text message without provider-authored templates or tracking.
- Verify request → email → one-use callback → session → logout end to end.
- Add delivery diagnostics that do not reveal which email addresses are administrators.

### GL-010 — Build farmer onboarding and number verification

**Confirmed gap**

The schema has contacts, farmer authorization, onboarding consent provenance, and separate VIGA
approval, but there is no farmer-facing onboarding journey.

**Required outcome**

- Farmer creates or claims the correct farm.
- Farmer verifies control of the SMS number.
- The authorization and consent evidence are recorded separately and truthfully.
- Completing onboarding never grants VIGA approval.
- VIGA approves publication through the existing admin authority path.
- The flow is at least as easy as the current form.

### GL-011 — Build farmer web profile, listing, preferences, and inventory

**Confirmed gap**

Phase 1 requires web access for broader listing changes, communication preferences, and inventory
updates. None of those farmer-authenticated surfaces exist.

**Required outcome**

- Farmer web authentication is separate from administrator authority.
- Farmer can edit only farms and sales locations they currently control.
- Inventory text uses the same interpretation and confirmation mechanism as SMS.
- Profile/listing facts include hours, offerings, payment methods, Farm Bucks, links, optional photo,
  and biography.
- Consequential changes are audited at an appropriate level without retaining unnecessary raw
  content.

### GL-012 — Build proactive inventory prompts and preference scheduling

**Confirmed gap**

`inventory_prompt` exists as a consent category, but there is no preference store/flow or scheduler
that creates prompts.

**Required outcome**

- Store the farmer's chosen cadence and relevant quiet-time/rate preferences.
- Create unique prompt outbox work on the existing scheduled-work mechanism.
- Recheck active consent at dispatch.
- Prevent duplicate prompts under concurrent or delayed schedules.
- Make a missed schedule recoverable without sending a burst of stale prompts.

### GL-013 — Turn the public stand list into the required discovery product

**Confirmed gap**

The component named `StandMap` renders cards and directions links, not a geographic map. There is no
filter/search, stand detail page, or farm-without-stand layer.

**Required outcome**

- Provide a real geographic view and a usable listing view.
- Keep actionable purchase locations as the default.
- Make other farm layers prominent and easy to view.
- Add useful filters over structured facts, not prose.
- Add stand details with current inventory, recency, hours, offerings, payments, Farm Bucks, and
  farmer-selected public profile facts.
- Preserve model-free browsing, transient browser-origin proximity, stale warnings, and
  destination-only routing links.
- Do not reintroduce a runtime geocoder or coordinate-inventing stub.

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

### GL-015 — Provide a real listing-correction path

**Confirmed gap**

The seed utility is insert-only. Resolving a `stand_data_flag` records the decision but deliberately
does not apply a correction. Until farmer editing exists, initial address, hours, type, payment, and
offering errors require direct SQL.

**Required outcome**

- Choose whether each correction belongs to the farmer surface or a narrowly audited VIGA
  exception path.
- Applying a stand-data decision must be separate from merely closing the review item, but the
  operator must have a documented route to finish the correction.
- Re-running the seed must never overwrite farmer-owned live facts.

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

### GL-017 — Prove scheduler capacity and choose one production scheduler

**Confirmed risk**

Inbound, outbound, delivery, and retention passes run sequentially. Model calls may take 20 seconds
and the current “repair” may double that. The external trigger has a 120-second request ceiling. The
repository contains a one-minute Vercel cron that Hobby deployments cannot use and a GitHub schedule
that requests five-minute execution but has been observed running much less frequently.

**Required outcome**

- Calculate and test bounded work that fits the actual runtime limit.
- Ensure backlog recovery makes forward progress under provider timeouts and poison events.
- Select one durable production scheduler before launch.
- Commit a deployable configuration rather than stripping cron configuration during deploy.
- Remove the dormant second trigger once the chosen scheduler is proven.

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

### GL-019 — Fail closed on production model configuration

**Confirmed risk**

An absent `LLM_PROVIDER` selects the deterministic stub. A production deployment can therefore look
healthy while every model-backed journey degrades into clarification.

**Required outcome**

- Require an explicit provider selection in production.
- Keep the stub available only for tests and deliberate local development.
- Readiness must show which provider class is active without revealing credentials.
- Do not make any model call part of ordinary public map/list browsing.

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

The GSM/UCS-2 estimator and metrics logger are attached to the legacy `SmsSimulator`. Production
uses `createLastMileSender` and does not estimate, log, or cap segments. Long model-derived
confirmation text can therefore create unexpected billable messages.

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

Production deployment currently depends on locally stripping cron configuration, and there is no
repository workflow that runs the verification ladder on proposed changes. Isolated web installs
also omit the TypeScript ESLint parser/plugin that root dependency hoisting currently supplies.

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
already-current inventory visible. Because nobody is using the system, this is not presently an
inventory incident.

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

`CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md` was valuable as a reset artifact. It now combines an
enduring product contract, a historical audit, refactor instructions, mutable implementation
status, and session-resumption procedure in 872 lines. Several sections describe code that has
already been deleted or built.

**Target document ownership**

- `PRODUCT_BRIEF.md` — product authority: current requirements, launch scope, non-goals, and future
  vision.
- `ARCHITECTURE.md` — living system contract and runtime/data-flow ownership.
- `DATA_ARCHITECTURE.md` — living durable-data, constraint, privacy, and retention contract.
- `AI_ARCHITECTURE.md` — living model trust boundary and seam contract.
- `SMS_COMPLIANCE.md` — living consent and carrier behavior.
- `GO_LIVE_GUIDE.md` — temporary work order and release gates.
- Clean-room handoff and architecture audits — dated historical decision/review records, explicitly
  not current status or design authority.
- `CLAUDE.md` — concise current state and repository working rules, not a second product brief or
  session archive.

### GL-032 — Remove stale and contradictory status claims

Known examples:

- `ARCHITECTURE.md` says customer inquiry, stock-out, retention, authentication, and model privacy
  are not implemented even though substantial portions now exist.
- `AI_ARCHITECTURE.md` says no live vendor adapter exists, then later documents the configured
  DeepInfra adapter.
- `RUNBOOK.md` predates the stand-data admin surface and DeepInfra attestation.
- `maps/README.md` still describes the seed utility as future work.
- `PRODUCT_BRIEF.md` lists several decisions as unresolved that code or later decisions have made.
- PM statuses and feature notes do not consistently match `CLAUDE.md`.

Status should live in one place. Contract documents may identify a capability as required without
carrying rapidly stale build banners.

### GL-033 — Add the missing environment template

The runbook instructs developers to copy `.env.example`, and `.gitignore` explicitly permits that
file, but it does not exist.

Create a content-free template naming every required variable, safe local values where appropriate,
which variables must be explicit in production, and which providers are deliberately unconfigured.
Never include a real credential.

### GL-034 — Align JOIN/START compliance copy

The implementation correctly treats `JOIN` as first-time enrollment only and `START` as the word
that restores consent after STOP because the carrier owns its own block list. Review every public
10DLC page, onboarding instruction, auto-response, and runbook so returning users are consistently
told to use `START`.

Do not change registered wording without rechecking the approved carrier campaign.

### GL-035 — Remove or reconnect dead parallel mechanisms

Candidates identified by the review:

- `packages/core/src/auth/roles.ts` defines admin/staff/farmer hierarchy and “admin implies staff,”
  despite the launch contract's dedicated single-level administrator model. Production admin routes
  use the durable administrator/session guard instead.
- `SmsSimulator`, `SmsTransport`, and segment metrics form a legacy delivery path while production
  uses `createLastMileSender`.
- `openOrReviseProposal().activate()` synthesizes a sent prompt for tests while production
  activation belongs to the outbound worker.

Delete dead mechanisms or make the production path their real consumer. Do not preserve duplicate
concepts merely because tests use them.

### GL-036 — Keep historical logs out of the normal reading path

`SESSION_LOG.md` and `SESSION_LOG_ARCHIVE.md` contain useful forensic history but are too large and
mutable to function as startup context. Archive them by date or milestone and keep current
operational facts in the go-live guide/current-state snapshot.

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
- Admin routes share a server-side session guard; the acting administrator comes from the session,
  not the request body; write transactions recheck authority and audit the action.
- The repository correctly avoids speculative tenancy, future-program enrollment, gleaning,
  volunteer, Farm Bucks transaction, native-app, and multi-organization machinery.

---

## Verification baseline from the review

Run on July 28, 2026:

- `npm test` — **479/479 passed** across 50 unit-test files.
- `npm run test:integration` — **285/285 passed** across 18 files on local Postgres 16.12.
- `npm run lint` — passed.
- `npm run evals` — critical **11/11**, adversarial **29/29**, advisory **4/4**.
- `npm run build --workspace @farm-friend/web` — production build passed.
- `npm run typecheck` — passed, but this result is incomplete because the root references omit web.
- `npx tsc -p apps/web/tsconfig.json --noEmit` — failed across web test files.
- `drizzle-kit check` — passed for the committed migrations.
- Safe migration-generation trial — exposed stale snapshot metadata after `0001`.

Limitations:

- The machine ran Node 23.5.0 because the repository's preferred Node 20 runtime was not installed.
- No live model eval, paid provider call, deploy, publication, or hands-on acceptance test was run.
- Green existing tests do not cover the delayed-STOP, abandoned-dispatch, reusable-magic-link, or
  discarded-stock-out-alert defects above.

## Required verification ladder

For ordinary changes:

1. Focused tests for the affected behavior.
2. `npm test`
3. Full root typecheck, once GL-005 makes it truthful.
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
- an administrator can request and consume one sign-in link;
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
