# Farm Friend — Go-live guide

This is the working guide from the July 28, 2026 whole-codebase architectural review to a safe,
complete Phase 1 launch. Work through it in priority order. It is deliberately more operational
than the product and architecture documents: those describe the intended product and its enduring
rules; this document says what remains between the current repository and go-live.

## Decisions made without Max

Product and design calls made autonomously while working this guide, newest last. One line each, so
they can be reviewed and reversed in one place.

- **GL-004 (2026-07-28) — single-use links are a column on `admin_sessions`, not a new credential
  table.** The session row *is* the record that the link was spent, so consume and session are one
  insert with nothing to reconcile. Rejected the separate-table design because it would have to be
  written when a link is *minted* — an unauthenticated write from the internet, and a per-address row
  that recreates the membership oracle the sign-in path exists to deny. Reversible: it would mean a
  new table plus a mint-time write path.
- **GL-004 (2026-07-28) — a replayed link and a non-administrator return the same 401.** Naming the
  difference would tell an attacker holding a copied link that it had been genuine.
- **GL-031 (2026-07-28) — the frequency-limit requirement was moved into `ARCHITECTURE.md` as an
  explicitly UNBUILT requirement rather than dropped.** The clean-room handoff was the only place
  stating that code owns message-frequency limits; the code has none. Recording it as a gap keeps a
  settled product promise (a farmer's preferred cadence) from silently disappearing when its only
  written home became a historical record. Reversible: delete the paragraph if the promise is
  withdrawn.
- **GL-032 (2026-07-28) — replaced `PRODUCT_BRIEF.md`'s "unresolved decisions" list by reading the
  answers out of the code rather than asking.** Seven of eleven were settled in code (30-day
  retention, 48-hour staleness, snapshot semantics, magic-link admin sign-in, the attested provider,
  no seed geocoder, verified 10DLC alignment) and are now recorded as decisions. They were decisions
  max had already effectively made by approving the work; writing them down is bookkeeping, not a new
  call. Reversible per line if any reads wrong.
- **GL-032 (2026-07-28) — corrected `RUNBOOK.md`'s claim that `DEEPINFRA_API_KEY` is not a
  production credential, and added a "confirm before rotating" instruction rather than trusting the
  table.** The doc was written when production had no model provider; it now does. The general
  lesson — a rotation table is a claim, and Vercel values are write-only — is what the added
  sentence carries.
- **GL-006 (2026-07-28) — repaired the migration metadata with ONE current snapshot rather than
  reconstructing all five missing ones.** drizzle-kit only ever diffs against the newest snapshot,
  so the rest are historical convenience; inventing five point-in-time schema pictures nobody can
  verify against a database would be fabricating evidence rather than repairing metadata. Reversible
  if a future tool version needs the full chain.

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

**Completed:** 2026-07-28 — reconfirmed against the code, fixed test-first, and sabotage-verified in
both directions. The defect was real and reproduced before the fix: a delayed `STOP` left consent
`active`.

- **Fix.** `routeInboundMessage` now receives staleness as an input and owns the decision, parsing
  compliance keywords **before** the gate and applying it to free text and confirmation tokens only.
  `runInboundPass` no longer pre-empts routing; it finalizes a `stale` outcome exactly as before.
  This is the staleness rule scoped to the state it protects, **not** an exception carved out for
  STOP — consent ordering stays in `applyConsentTransition` under its own watermark and lock, and
  nothing re-implements it.
- **Why finalizing a routed stale event as `processed` is safe.** `claimNextInboundEvent` guards the
  watermark update with `!isStale`, so a late STOP cannot roll the conversation watermark backwards.
- **Tests** (`apps/web/lib/routing.integration.test.ts`, real Postgres). The required scenario:
  a newer ordinary message is processed and advances the watermark, an older `STOP` arrives after,
  and it must change consent **and** suppress a later proactive dispatch — asserted through
  `authorizeDispatch` returning `suppressed`, so a paper opt-out cannot pass. Plus a guard test that
  a stale free-text message and a stale `YES` are **still** refused, and the model is still never
  reached on either path.
- **Sabotage, both directions.** Moving the gate back ahead of compliance parsing fails the
  delayed-STOP test and nothing else; deleting the gate entirely fails the two stale-refusal tests.
  The fix is pinned on both sides rather than merely passing.
- **Verified:** `npm test` 479/479 · `npm run test:integration` **287/287** (was 285; +2 new) on
  local Postgres 16.12 · `npm run evals` critical 11/11, adversarial 29/29, advisory 4/4 · lint ·
  root typecheck · `next build`. Web-only `tsc` shows **54 errors before and after this change**,
  none in the touched files — that is the pre-existing GL-005 condition, not a regression.

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

**Completed:** 2026-07-28 — reconfirmed against the code, fixed test-first, sabotage-verified three
ways. The defect was real: `dispatching` was written in exactly one place and read by nothing, and
`runOutboundPass` had no error handling at all, so a throw aborted the entire pass.

- **Durable lease.** `DISPATCH_LEASE_MS` (10 minutes) plus `recoverAbandonedDispatches`, which runs
  first on every outbound pass. Deliberately generous: expiring a lease on a merely slow provider
  call would quarantine work about to succeed, and a delayed reply is a smaller harm than a
  duplicate SMS to a real person.
- **Quarantined as `ambiguous`, never `queued`.** We cannot know whether the provider accepted the
  message before we lost the thread, and that is precisely what `ambiguous` already means here — so
  this reuses the existing state and needs **no migration**. Recovered work is never re-authorized.
- **Per-row isolation.** A throw is now caught around each row, so one poisoned message cannot block
  every other sender's reply. The row is left `dispatching` rather than guessed at; the lease
  resolves it. A killed process runs no catch block and a lease cannot isolate a row mid-pass, which
  is why both exist.
- **Tests** — 5 in `packages/db/src/workflow.integration.test.ts` (fresh claim untouched, expired
  claim quarantined with attempt resolved, never re-authorized, terminal work untouched, exactly
  once under 4 concurrent passes over 8 distinct rows) and 5 in the new
  `apps/web/lib/dispatch-recovery.integration.test.ts` (throw at the transport and at recipient
  resolution, one poisoned row does not abort the pass, end-to-end recovery through the real
  `runOutboundPass`, and a merely-slow claim left alone).
- **Sabotage.** Requeueing instead of quarantining fails 3 tests; removing the recovery call from
  the pass fails the end-to-end wiring test; removing the deadline fails the two "leave it alone"
  tests. Each guard is independently load-bearing.
- **Verified:** `npm test` 479/479 · `npm run test:integration` **297/297 across 19 files** · lint ·
  root typecheck · `next build`.

**Partial — one required outcome is deliberately deferred.** "Surface stuck/ambiguous work in
operator diagnostics" is only half done: `runOutboundPass` now returns `failed` and `recovered`
counts, and the cron route already serializes its whole result, so the counts reach the scheduled
pass response. There is **no operator-facing view** of quarantined work — that belongs with GL-016's
failure diagnostics and GL-018's readiness endpoint rather than a third bespoke surface here. The
durable state is correct and queryable; what is missing is somewhere to read it.

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

**Completed:** 2026-07-28 — `f6544a2`. Reconfirmed in full before implementing: `verifyMagicToken`
was pure HMAC with no state, and the callback minted a session on every verification, while
`sign-in-email.ts` had been promising "can be used once" since F-032.

- **A column, not a table.** Each link carries a random 32-byte `nonce` inside its signed payload;
  the callback stores its SHA-256 in `admin_sessions.magic_nonce_hash` under a UNIQUE INDEX, written
  by the **same insert that creates the session**. A link being spent and a session existing are the
  same event, so there is no second record to keep in step. A separate credential table would have
  had to be written at **mint** time — an unauthenticated write path, and a per-address row whose
  presence is exactly the membership oracle `/api/auth/request-link` exists to deny. Minting still
  writes nothing.
- **The arbiter is the index**, reached through `on conflict (magic_nonce_hash) do nothing returning
  id`, where the empty result is the signal someone else won. Not a check-then-write: `for update`
  cannot lock a row that does not exist yet (the B-011 lesson). Authority is re-read **before** the
  link is spent, so a revoked operator's link is refused without being burned.
- **Enumeration resistance preserved:** `link_already_used` and `not_an_administrator` both render
  401, so a replayed link is not a probe for which links were genuine.
- **Legacy tokens fail closed.** A well-signed token whose nonce is missing or malformed is rejected
  as `malformed` rather than defaulting to a placeholder — a placeholder would give every such link
  the same identity, so opening one would consume all of them.
- **Migration 0006**, proven from an empty database by the integration run (7 migrations total).
- **Sabotage, verified by the main agent by hand, not by report.** Replacing the atomic insert with
  a read-then-write fails `survives EIGHT simultaneous uses of one link…`; downgrading the UNIQUE
  INDEX to a plain INDEX fails **9 tests** across both DB suites. Each guard is independently
  load-bearing.
- **The race test was not falsifiable on its first draft**, and the sabotage is what caught it:
  eight `Promise.all` calls through one `Db` handle queue behind its 3-connection pool, so each
  transaction completed before the next began. Each claimant now gets its **own connection** plus a
  barrier so all eight reach the insert together. This is the `Promise.all` rule with a pool-size
  twist the standing rules did not previously state.
- **Verified:** `npm test` **487/487 across 50 files** · `npm run test:integration` **311/311 across
  19 files** on local Postgres 16 · lint · root typecheck · `next build`. Counts reproduced
  independently from a clean checkout, not taken from the subagent's summary.
- **Correction to a documented figure:** the web-only `npx tsc -p apps/web/tsconfig.json --noEmit`
  baseline is **57 errors**, not the 54 recorded in `CLAUDE.md` — measured identical on clean `main`
  via `git stash`. That is GL-005's scope.

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

**Completed:** 2026-07-28 — `72bdac8`. **57 web errors → 0**, none suppressed.

- **Wiring:** root `typecheck` is now `typecheck:packages && typecheck:web`. Two halves rather than
  one project graph because `apps/web/tsconfig.json` sets `composite: false` — Next owns that file,
  and `tsc -b` can only reference composite projects, so making web composite means fighting the
  framework's generated config on every upgrade.
- **The 17 TS2769 errors were a latent PRODUCTION defect, not test scaffolding.**
  `type Sql = ReturnType<typeof postgres>` picks the *last* of two overloads and evaluates its
  conditional against the **unresolved** generic, collapsing the type map to `never` — so the tagged
  template accepted **no parameters at all**. `sql`select ${id}`` failed to typecheck while working
  perfectly at runtime. That alias was redeclared in four modules; it now lives once in
  `packages/db/src/sql.ts`, alongside `Tx`, which had separately drifted to a contravariantly
  incompatible type map (`unknown` vs `never`).
- **The 27 `ProcessEnv` errors were fixed by narrowing the production signature, not the test.**
  `resolveConfig`/`createAppContext` now take `Record<string, string | undefined>` — which is all
  they ever read, and which `resolveSmsConfig` in `packages/sms` already used, so this made two
  conventions agree rather than adding a third. Every production caller uses the `process.env`
  default and is unchanged.
- **Nothing suppressed:** zero `@ts-expect-error`, `any`, `exclude` globs, or `skipLibCheck`
  widening added. The 18 pre-existing `@ts-expect-error`s are all safety-boundary type tests
  asserting that a bypass *fails*; none are in `apps/web`.
- **Sabotage, run by the main agent by hand on a file the subagent never saw** (GL-004's callback
  route, merged after this branch was cut): a deliberate `TS2322` makes the root typecheck exit
  **1**, while the old bare `tsc -b` exits **0** on the identical error. That contrast is the proof
  the previous check was blind, not merely incomplete.
- `packages/core/src/typecheck-coverage.test.ts` fails if a future workspace lands in neither half —
  aimed at the *next* instance of this defect.
- **Verified after merging with GL-004:** `npm test` **493/493 across 51 files** ·
  `npm run test:integration` **311/311 across 19 files** · lint · root typecheck exit 0 ·
  `next build` clean, still its own layer.
- **A subagent report that did not survive checking:** it reported that `npm run lint` exits 0 while
  printing errors, and proposed a new item. It does not — a deliberate unused import produces
  `✖ 1 problem` and **exit 1**. The likely cause is reading a piped exit status rather than the
  command's. No item filed.

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

**Completed:** 2026-07-28 — `1a5d525`. Reconfirmed by reproducing it first: a generation trial
against the unchanged schema stopped and asked *"Is message_category column in outbox_work table
created or renamed from another column?"* — `message_category` was added by migration `0002`.

- **The lead was right, and had grown by one.** Seven migrations are journaled (`0000`–`0006`,
  `0006` arriving with GL-004 this session) while snapshots stopped at `0001`. Snapshot `0001`
  describes 22 tables; the schema has 25 — `admin_sessions`, `sales_location_offerings`, and
  `stand_data_flags` were invisible to the generator.
- **Applying was never affected**, which is what kept this invisible: the integration suite builds a
  database from empty and applies all seven on every run. Only *generation* was untrustworthy, and
  the danger is not that the tool errors out — it is that a wrong answer to a rename prompt writes a
  plausible migration that re-creates existing tables or renames a column out from under production
  data.
- **The repair is one file:** a `0006_snapshot.json` describing the current schema, chained onto
  `0001`. drizzle-kit 0.22.8 diffs against `snapshots[snapshots.length - 1]` **only**
  (`preparePrevSnapshot`), and enumerates snapshots from the directory listing rather than the
  journal — so intermediate snapshots are historical convenience, not correctness. Reconstructing
  five point-in-time pictures nobody can verify against a database would be **fabricating evidence
  rather than repairing metadata**, so it was deliberately not done. The tripwire asserts the rule
  the tool actually has, not a stricter invented one.
- **Verified the regenerated metadata agrees with the applied SQL**: the tables and enums it adds
  over `0001` are exactly what `0002`–`0006` create (`message_category`, `admin_sessions`, the
  stand-availability enums, `magic_nonce_hash`). No divergence between code schema and database
  schema was found.
- **No `.sql` file changed** — the md5 over all seven is byte-identical before and after
  (`bebb13d3…`). The commit adds two files and modifies none.
- **Headline proof:** the generation trial now reports **"No schema changes, nothing to migrate"**,
  with no rename prompts and no new migration file.
- **Tripwire** `packages/core/src/migration-metadata.test.ts`, sabotage-verified four ways: removing
  the `0006` snapshot fails 2 assertions and names the 3 missing tables; journaling an `0007`
  without a snapshot fails the newest-migration check (the **forward-looking** case, aimed at the
  next instance); a duplicated `prevId` fails the collision check.
- **Verified:** `npm test` **497/497 across 52 files** · `npm run test:integration` **311/311 across
  19 files** on local Postgres 16, all 7 migrations applied from empty · lint, root typecheck, and
  `next build` all exit 0.

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

**Inherited from GL-003:** the outbound pass already returns `failed` and `recovered` counts, and
quarantined dispatches are durable and queryable (`outbox_work.state = 'ambiguous'` with
`outbox_dispatch_attempts.error_code = 'dispatch_lease_expired'`). What GL-003 deliberately did not
build is anywhere for an operator to *read* that — it belongs here and in GL-018, not in a third
bespoke surface.

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

**Inherited from GL-003:** abandoned dispatches are already quarantined durably and identifiable by
`outbox_dispatch_attempts.error_code = 'dispatch_lease_expired'`. This item owns exposing them.

### GL-019 — Fail closed on production model configuration

**Completed (code):** 2026-07-28 — pulled forward from P2 at Max's request, because the live
deployment was affected right now. **Confirmed against the live environment, not inferred:**
`vercel env ls production` shows no `LLM_PROVIDER`, `DEEPINFRA_API_KEY`, or `DEEPINFRA_MODEL` at
all, so production has run the deterministic stub for its entire life — every model-backed journey
degrading into a clarification while health, the webhook, and every suite stayed green.

- **Fix.** `LLM_PROVIDER` is now required with **no default**, exactly like `PHONE_HASH_SALT` and
  `CRON_SECRET`. Absent, blank, or unknown is a `ConfigurationError` at startup.
- **Deliberately not "required in production."** The guide's wording invited environment sniffing,
  and this codebase already refuses that pattern — `cron-auth.test.ts` asserts the cron route
  contains no `NODE_ENV`/`VERCEL_ENV`, on the reasoning that a rule which relaxes off-production is
  one misconfigured deploy from being wrong. That is precisely how this defect survived: the
  default behaved identically everywhere it was tested. Max chose refuse-everywhere.
- **The stub is unchanged and still available** — for tests, evals, and local development. It lost
  only the ability to be selected *by accident*.
- **Tests.** Absent and blank both throw; the stub still resolves when named explicitly; plus a
  source assertion anchored to the selector that it reads no environment flag and carries no `??`
  default. Sabotage-verified twice: reintroducing the old default fails both new tests, and so does
  a "required only when `VERCEL_ENV=production`" variant.
- **Fallout fixed honestly** rather than papered over: six fixtures and two integration suites that
  relied on the implicit default now state `LLM_PROVIDER=stub`.
- **`.env.example` created** (also closes **GL-033**), naming every required variable, which are
  explicit in production, and which providers are deliberately unconfigured. No real credential;
  verified against `.gitignore`'s un-ignore rule and scanned for credential shapes.
- **Verified:** `npm test` **482/482** · `npm run test:integration` **297/297** · evals 11/11
  critical, 29/29 adversarial · lint · root typecheck · `next build`.

**Still open — the deployment itself.** The code now refuses to start without an explicit choice,
which means **production will fail to boot until `LLM_PROVIDER` is set in Vercel**. Setting it
(plus `DEEPINFRA_API_KEY` and `DEEPINFRA_MODEL` for a real provider) and redeploying is Max's
action, tracked with GL-001's rotation since both touch the same settings. Do not deploy this commit
before those variables exist.

**Not addressed here:** "readiness must show which provider class is active." `GET /api/health` is a
bare liveness check with no configuration awareness; building an authenticated readiness surface
belongs to **GL-018** rather than a bespoke one here.

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

Production uses `createLastMileSender` and does not estimate, log, or cap segments. Long
model-derived confirmation text can therefore create unexpected billable messages.

GL-035 removed the legacy `SmsSimulator` the estimator and metrics logger used to hang off, and
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

**Completed:** 2026-07-28 — the nine authority banners are gone (`ARCHITECTURE.md`,
`AI_ARCHITECTURE.md`, `DATA_ARCHITECTURE.md`, `SMS_COMPLIANCE.md`, `RUNBOOK.md`,
`ADMIN_OPERATIONS.md`, `PRODUCT_BRIEF.md`, `docs/README.md` ×2, `CLAUDE.md`), and both handoffs now
open with a HISTORICAL RECORD banner naming the owning documents. The clean-room handoff's own F-020
section, which declared itself the authority, is marked superseded in place rather than left to
contradict the banner above it.

**The handoff was diffed against the owning docs before any banner came down**, and three settled
decisions existed *only* there. Each was moved, not lost:

- **Deterministic code owns message-frequency limits** (handoff §4). The consent and recipient halves
  of that sentence were in `ARCHITECTURE.md`; the frequency half was nowhere. Moved to
  `ARCHITECTURE.md` §"Launch SMS consent" and stated honestly as a **requirement not yet built** —
  verified against the code: no cadence or rate cap exists anywhere in `packages/core/src/sms` or the
  schema, so writing it as current would have been a fresh falsehood.
- **The excluded-infrastructure list.** Every approved finding closed with an "adds no Kafka / event
  bus / event sourcing / workflow engine / distributed lock / policy engine / DLP / vector database
  / additional package" clause. Nothing in any living doc said this. Moved to `ARCHITECTURE.md`
  §"Design stance" as one positive statement of the settled shape, with the reason it is load-bearing
  (reaching for one is the signal a mechanism was generalized past its consumer).
- **"Retrieval-first" means retrieval before *fact selection*, not before *interpretation*.** The
  ordering was in `AI_ARCHITECTURE.md`; the disambiguation that keeps it from being read backwards
  was not. Moved to `AI_ARCHITECTURE.md` §"Retrieval and ranking".

From `ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md`, the **spiral-staircase constraint** was compared
clause by clause against `CLAUDE.md` "zen desk" and `ARCHITECTURE.md` "Design stance". All of it was
already covered except one sharper formulation — *complexity must buy down a named launch risk; a
component that cannot name the invariant it enforces and the failure it prevents gets deleted* —
which moved into `ARCHITECTURE.md` §"Design stance".

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

**Completed:** 2026-07-28 — every architecture doc now describes the enduring contract and carries
**no build status**; each points at `CLAUDE.md` "Current State & Open Items" in one line. Every claim
touched was re-verified against the code first, and the review found stale claims beyond the list
below — including two the list did not name:

- `ARCHITECTURE.md` "Not implemented: customer inquiry, stock-out, retention, authentication, model
  privacy boundary" → all five verified present (`packages/db/src/review.ts`, `purgeExpiredBodies`,
  `admin-guard.ts` + `admin_sessions`, the five per-seam projections). Banner removed.
- `ARCHITECTURE.md` "The composition root and adapter implementations remain later work" → false;
  replaced with what the architecture test actually enforces.
- `ARCHITECTURE.md` "Each invariant is a requirement awaiting executable proof" → false for all six;
  replaced with the sabotage rule, which is the durable point.
- `ARCHITECTURE.md` "Full-snapshot versus patch remains unresolved" → settled in
  `packages/core/src/inventory/proposal.ts`: patch language in, complete snapshot out.
- **NOT NAMED IN THE LIST — `ARCHITECTURE.md` claimed the QR stock-out *web form* as a built runtime
  surface.** Only `POST /api/public/stock-out` exists; `apps/web/app/` has no stock-out page. Now
  stated as contract, with the API route described as what exists.
- `AI_ARCHITECTURE.md` "The configured provider is still the deterministic stub; no live vendor
  adapter exists" → false and self-contradicting (the same doc documents the attested DeepInfra
  adapter 140 lines later). Banner removed; the gate section reframed as the mechanism it is.
- `AI_ARCHITECTURE.md` seam table "Built?" column and a hard-coded "471 unit tests" → both removed;
  a count in a contract doc is stale the next session.
- **NOT NAMED IN THE LIST — `RUNBOOK.md` §credential rotation told a rotator that
  `DEEPINFRA_API_KEY` is "not a production credential… absent from the Vercel environment entirely,
  so the deployment runs the deterministic stub".** Production now carries `LLM_PROVIDER=deepinfra`
  and both DeepInfra vars, so the key authorizes real spend and lives in **two** places. This one was
  operationally dangerous, not merely stale: following it would have rotated the console and local
  `.env` while leaving production authenticating with a revoked key. Corrected in the table and in
  the rotation order.
- `maps/README.md` "reference input for a later… seed utility… When authorized, it will validate and
  load" → the loader is built and has run; rewritten around what it may and may not write, including
  that the export itself is untracked because it carries PII.
- `PRODUCT_BRIEF.md` unresolved list → seven of eleven were decided. Split into "Product decisions
  since settled" (retention 30d, staleness 48h, snapshot semantics, admin magic-link sign-in,
  attested provider, no seed geocoder, 10DLC alignment) and a shortened genuinely-open list.
- `docs/README.md` "The repository is mid-rebuild… not yet enforced by executable code" → removed.

Deliberately left alone: `docs/TELNYX_10DLC_FIELD_VALUES.txt` (a transcript of live carrier console
state, pinned character-for-character by `auto-responses.test.ts` and `commands.test.ts`), and all
JOIN/START consent wording in `SMS_COMPLIANCE.md` §"Consent model", which GL-034 owns concurrently.

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

**Completed:** 2026-07-28 — created alongside GL-019, which made the file load-bearing rather than
merely missing: `LLM_PROVIDER` is now required, so a developer with no template cannot start the app
at all.

`.env.example` names every required variable with safe placeholder values, marks which must be
explicit in production, carries the never-rotate warning on `PHONE_HASH_SALT` and the two-place
requirement on `CRON_SECRET`, and states that mail (F-031) is deliberately unconfigured and fails
closed. No real credential: verified against `.gitignore`'s `!.env.example` un-ignore rule and
scanned for credential shapes.

The runbook instructs developers to copy `.env.example`, and `.gitignore` explicitly permits that
file, but it does not exist.

Create a content-free template naming every required variable, safe local values where appropriate,
which variables must be explicit in production, and which providers are deliberately unconfigured.
Never include a real credential.

### GL-034 — Align JOIN/START compliance copy

**Completed (repo half):** 2026-07-28 — the code was already right; the words were not. Reviewed
every place a human is told how to start or resume messages. **Two console edits remain and are
max's to make** — see "Owed in the Telnyx console" below.

**What was wrong.** `docs/VIGA_10DLC_WEBSITE_COPY.md` — the paste-ready source for the public
Squarespace pages, and the thing a farmer actually reads before texting anything — explained
opting out and then said messaging stops *"unless you request to rejoin"*, naming no keyword at
all. A reader who has just been told the opt-in word is JOIN will reach for JOIN, which for them
is precisely the word the carrier will not honour: they text it, get refused, and stay blocked.
Four sections fixed, all in that file:

| Section | Change |
|---|---|
| Opt-in page | Added: returning after an opt-out, reply `START` rather than `JOIN` |
| Terms → Opt In | Same instruction, beside the existing "JOIN or START" line |
| Terms → Opt Out | Replaced *"unless you request to rejoin"* with an explicit `START` sentence |
| Terms → Supported Commands | `START` added beside `STOP` |
| Privacy → Your Choices | `START` added beside the opt-out keyword list |

`JOIN` is untouched as the published **first-time** call to action — it is the registered opt-in
keyword and removing it would break the registration rather than fix the copy. Only the returning
path changed.

**What was already correct**, confirmed by reading rather than assumed: `ALREADY_JOINED_RESPONSE`
(already named `START`, but had **no test of its own** — the routing tests asserted the routing,
not the constant); `consentTransitionFor` and its doc comment; `SMS_COMPLIANCE.md`'s keyword table
and consent model; `ARCHITECTURE.md`; `DATA_ARCHITECTURE.md`; `RUNBOOK.md`'s failure-triage row
(`START` lifts it, `JOIN` does **not**). No web UI carries opt-in instructions at all.

`packages/core/src/sms/return-after-optout-copy.test.ts` is the new tripwire. It asserts the
returning instruction names `START`, that the opt-out section does **not** say `JOIN`, that the
first-time `JOIN` invitation survives, and the same properties on `ALREADY_JOINED_RESPONSE`. All
four sabotage-verified. One sabotage initially appeared to survive; the *sabotage* was faulty
(case-sensitive `perl` left a capitalized "Text JOIN" standing that the case-insensitive assertion
then matched) — redone correctly, it fails as intended.

**Deliberately NOT changed: `docs/TELNYX_10DLC_FIELD_VALUES.txt`.** It is a transcript of live
console state, and the rule is change the console first, then transcribe. A test demanding new
wording there would push a future editor into falsifying the transcript.

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

**Completed:** 2026-07-28 — each candidate reconfirmed against the code first; two of the three
findings above were wrong in detail, and the corrections changed what was done.

- **`roles.ts` — NARROWED, not deleted.** The finding's premise ("production uses the durable
  guard *instead*") is false: production reaches this module constantly. `admin-guard.ts` — the
  one guard all five admin API routes share — calls `requireRole` and `AuthorizationError`, the
  four admin pages call `hasRole`, and `packages/db/src/admin.ts` returns a `Principal` typed by
  `Role`. What was actually dead is the multi-level vocabulary: nothing anywhere produced or
  required `staff` or `farmer`, so the `IMPLIES` table could never fire. `Role` is now `"admin"`
  alone. Deleting the module would have deleted the live admin authority check.
- **SMS — the parallel path was real, and it was where the SAFETY PROOF lived.** `SmsTransport` is
  *not* the live seam, contrary to the finding: `createLastMileSender` takes a `ProviderTransport`
  (a plain function type in `delivery.ts`), and that is what the composition root wires Telnyx
  into. `SmsTransport`/`OutboundMessage`/`SmsSimulator`/`SentMessage` and the segment-metrics
  logger were reachable only from this package's own tests — deleted. The consequential part:
  `safety-boundary.type-test.ts`, the Golden Rule #6 layer-1 compile guard, asserted the branded
  outbound type against `OutboundMessage`, so the static provenance barrier was proven on a path
  production never took. It is re-anchored to `LastMileSendInput`, and sabotage-verified — erasing
  the brand now fails the typecheck on both bypass assertions. `estimateSmsSegments` and
  `normalizeAvoidableSmsUnicode` were KEPT: GL-021 attaches the first to the real send path and
  the outbound guard already calls the second.
- **`activate()` — deduplicated into one writer.** Confirmed: two code paths wrote the same
  activation state and only the worker's ran in production, so a divergence between them was
  invisible. They had already diverged — the test path read `proposal_version` in a separate query
  and guarded on nothing, while production copies it in SQL and matches on `state = 'open'` plus
  recipient plus `inventory_confirmation`. Production's version is now the exported
  `activateAcceptedPrompt` in `packages/db/src/transactions.ts`; the worker calls it and
  `OpenProposalResult.activate` calls it after creating the prompt row a dispatcher would have
  created. Tests adapted to production, never the reverse. Sabotage-verified: breaking the shared
  write fails **12 integration tests** across three files, which it did not do before.

Verified on this branch: `npm test` **491/491 across 52 files** (−6 from 497: the roles suite lost
five cases with the roles that no longer exist, and one simulator metrics test was deleted rather
than rewritten against a path GL-021 will build); `npm run test:integration` **311/311 across 19
files** on real Postgres 16; `npm run typecheck`, `npm run lint`, and `npx next build` all exit 0;
`npm run evals` critical **11/11**, adversarial **29/29**, advisory 4/4.

### GL-036 — Keep historical logs out of the normal reading path

**Completed:** 2026-07-28 — **discoverability changed; content did not.** Per max's decision, neither
log was merged, split, rotated, or rewritten: their forensic value is in staying exactly where they
are. `SESSION_LOG.md` left `docs/README.md`'s ordered read-list for a "Historical records — consult
deliberately, never load by default" section alongside the two retired handoffs, and `CLAUDE.md`'s
reading path now names all four under an explicit **do NOT load these to orient**; the session-workflow
step that told a cold agent to read the handoff no longer does.

**The `/session-wrap` skill was checked before anything moved.** It requires that `CLAUDE.md` name
the session-history file, and it owns the rotation threshold itself (`SKILL.md`: measure with
`wc -c` / `grep -c '^## '`, rotate past ~40k tokens or ~50 entries). So `CLAUDE.md` still names
`docs/SESSION_LOG.md` and its archive, and the rotation rule stated in each log's own header is
untouched — the skill keeps working. The only edit inside either file was one line in the archive
header citing the now-retired handoff as design authority.

Note left for whoever picks it up: the guide's original framing ("archive them by date or milestone,
keep current operational facts in the current-state snapshot") was **not** followed, because max
directed otherwise and because the logs already self-describe as on-demand history and already keep
operational truth in `CLAUDE.md`. Re-archiving would have moved bytes without changing what a cold
agent loads, which was the actual problem.

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
