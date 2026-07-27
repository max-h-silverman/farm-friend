# Farm Friend — Runbook (operate & extend)

Cold-start guide: with only [../CLAUDE.md](../CLAUDE.md) and this file, a developer can install,
run the suites, and start the web app. Also the **how-to-extend** guide (referenced from CLAUDE.md,
not inlined there).

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract.
>
> **Status (2026-07-26).** The four-package baseline, the launch schema and its migrations, the
> composition root, verified+persisting SMS ingress, the authoritative workflow transactions, the
> retention purge, the public map, the admin sign-in/farm-approval surface, and the flag/stock-out
> review queues (F-030) all exist. Still **not** built: the seed utility (B-002), a real model
> provider (F-024 — the stub is configured), sign-in link delivery by email (F-031), and go-live
> (F-029).
> Where a step below names a path or script that does not exist yet, it is the **contract the
> corresponding work builds to**, not a description of today; CLAUDE.md "Current State" is the live
> snapshot.

## Prerequisites

- **Node** per `.nvmrc` (`nvm use`). npm workspaces (ESM).
- **Postgres** for integration tests and migrations: local Postgres or a disposable CI instance.
  Set `DATABASE_URL` (see `.env.example`) to a database whose test role may create and drop a
  throwaway database. The integration suite fails explicitly when the variable is absent.

  **On this Mac it is already installed, and it is NOT on `PATH`.** Homebrew's `postgresql@16` runs
  as a launch agent; `psql`, `pg_isready` and friends live in `/opt/homebrew/opt/postgresql@16/bin`,
  so a bare `which psql` reports nothing and looks exactly like "no database available". A whole
  session was once written off on that false negative. To run the suite:

  ```bash
  export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH
  export DATABASE_URL="postgres://$(whoami)@localhost:5432/postgres"
  npm run test:integration 2>&1 | tee /tmp/itest.log
  ```

  Confirm it is up with `brew services list | grep postgres` or `pg_isready` (full path).
- No network is required for unit tests or evals (the model stub is offline and deterministic).

## Local dev — the five commands

```
npm install                 # install all workspaces
npm run typecheck           # tsc across workspaces — proves the static provenance barrier
npm run lint                # lint across workspaces
npm test                    # vitest unit — pure core logic, no DB/SMS/LLM (seams injected)
npm run test:integration    # vitest against Postgres — data invariants (requires DATABASE_URL)
npm run evals               # evals (stub provider); critical fixtures must be 100%
```

`npm run typecheck` is part of the safety story: bypassing the task-specific model-context
constructors or outbound guard in ordinary code **fails `tsc`** (the branded safe-context /
redacted-outbound types). This proves provenance, not runtime content safety; workflow tests and
hostile evals verify the runtime barrier but are not themselves enforcement. See
[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) §safety boundary.

## Environment

Copy `.env.example` → `.env` and fill:
- `DATABASE_URL` — Postgres/Neon connection (integration tests + migrations).
- `PHONE_HASH_SALT` — required; the phone hash is the only lookup/log key.
- `CRON_SECRET` — shared secret guarding the scheduled-worker route. **Required, no default, no
  local-only bypass** (see "Scheduled work" below).
- `MAGIC_LINK_SECRET` — signs admin sign-in links. **Required, no default**: the callback returns
  503 rather than verifying signatures against a guessable value, because that would be an open
  door to the farm-approval surface.
- `PUBLIC_BASE_URL` — the public origin sign-in links are built against, e.g.
  `https://farmfriend.example`. **Required, no default, and validated**: it must be an absolute
  URL, and `http` is refused outside localhost because a sign-in link is a bearer credential that
  must not travel in cleartext. It is configuration rather than a value derived from the request,
  because a `Host:` header an attacker controls would otherwise let the link-request endpoint mail
  a real operator a working-looking link pointing at the attacker's origin.
- **Mail provider** — not yet configured. F-032 built the sign-in request path against a
  `MailSender` seam whose only implementation today **fails closed**: an attempted send throws
  `MailNotConfiguredError` rather than quietly succeeding. Choosing a provider, recording its
  attested data handling, and implementing the adapter is **F-031**. Until then an administrator
  requesting a link gets the same 202 as everyone else and no mail is delivered.
- `SMS_PROVIDER` — `simulator` or `telnyx`. There is **no default**; an unset or unknown value is a
  configuration error rather than a silent fallback.
- With `SMS_PROVIDER=telnyx`, all four are required: `TELNYX_API_KEY`,
  `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_FROM_NUMBER`, and `TELNYX_PUBLIC_KEY` — the ed25519
  webhook verification key, without which inbound webhooks cannot be verified at all.
- Model provider selection and model config — stub is the default in tests and evals.

Runtime configuration is parsed and validated in the **single composition root**
(`apps/web/lib/composition.ts`); there is no `config` package. It **fails closed**: selecting live
Telnyx without the verification key or delivery credentials throws at startup, and the simulator
never inherits live secrets. `.env` is gitignored; only `.env.example` is committed.

## Migrations

The launch schema is a **clean initial migration** containing only the minimum durable records in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md), with the constraints listed there enforced at the
database level.

`npm run test:integration` creates a uniquely named empty database through `DATABASE_URL`, applies
every file in `packages/db/drizzle/`, runs the migration set again to prove the Drizzle journal is
a no-op, exercises the launch constraints, and drops the test database. This is destructive only
to the uniquely named database created by the harness; never point manual migration commands at a
database whose contents you intend to preserve.

## Bootstrap the first administrator

Authorization has a chicken-and-egg problem: only an administrator can grant authority, so the first
one comes from outside the application. Run once per environment, against a database you intend to
change:

```
DATABASE_URL=… npx tsx packages/db/scripts/bootstrap-administrator.ts you@example.org
```

Idempotent — an address that is already a live administrator is reported and left alone. Afterwards
administrators are managed in the database.

**Why a script and not the alternatives** (decided 2026-07-26, F-025a): *first-user-wins* on a public
login URL is an open door to every farm's published state, and an *env-var allowlist* puts
authorization in configuration, where the audit trail cannot record who granted it or when. A row has
an `authorized_at` and the same revocation path as every other grant.

Sign-in itself is a magic link signed with `MAGIC_LINK_SECRET`; verifying it proves control of an
email address, and the administrator lookup — not the link — is what confers authority. See
[ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md) §the administrator role.

### Bootstrap, then sign in

1. Run the bootstrap script above once per environment, against that environment's database.
2. The operator opens `/admin/login` and enters that address.
3. `POST /api/auth/request-link` mints a 15-minute link and hands it to the mail seam.
4. Opening the link hits `/api/auth/callback`, which re-checks the administrator row and mints the
   durable session.

**Step 3 does not deliver mail yet** — the seam fails closed pending F-031. Until a provider is
configured, mint a link out of band with `issueMagicToken` and give it to the operator directly.

Two properties of the request endpoint to preserve when changing it, both proven by tests in
`apps/web/lib/request-link.test.ts`:

- **The response is byte-identical for every address** — same status, headers, and body whether or
  not the address is an administrator, whether it is malformed, and whether the mail seam threw.
  The endpoint is public, so any observable difference enumerates who VIGA's operators are. Note
  the third case especially: letting a mail failure become a 500 recreates the oracle through the
  error path, because mail is only ever attempted for a real administrator.
- **The token reaches exactly two places** — the rendered message and the operator's mailbox. It is
  never in a response body and never in a log. The handler therefore contains **no `console` call
  at all**, asserted against its source, because a vendor SDK routinely attaches the request payload
  (containing the live link) to the error it throws.

Rate limiting is the shared `createPublicActionThrottle`, on its **own budget** rather than the QR
stock-out form's: sharing one would let anonymous stock-out traffic from a shared NAT exhaust a real
operator's ability to sign in. The budget is per client, never per email address — a per-address
budget is itself an oracle, since an attacker learns which addresses send mail by watching which
ones start refusing.

## Seeding initial listing data

This is a **greenfield build**: existing VIGA map content is **reference input, not a schema
contract**, and there is no non-destructive migration requirement or provenance axis.

A **one-time seed utility** validates and loads farms, sales locations, and approval state.
**It does not seed inventory** (decided 2026-07-26, B-002): a seeded listing fact would fabricate a
confirmation no farmer made, and the honor-system product's core promise is showing *when* inventory
was last confirmed. Stands seed empty and render the honest "no current listing" until a farmer texts.
It also seeds **no phone numbers** — `farmer_authorizations` requires captured SMS consent, so phones
arrive through onboarding, never a bulk roster load.

**Status: the utility does not exist yet** (B-002). VIGA's ~30 stands will be transcribed by hand
rather than imported from the map's KML; the existing free-form map text is the unfilterable content
Farm Friend replaces, not data to carry forward.

Geocoding happens **once, during seeding** — it is not a permanent runtime provider seam,
and a location that cannot be resolved is an **operator task**, never a fabricated coordinate.
Optional public-web browser geolocation is transient and used only for approximate proximity to
those validated coordinates; it is not persisted or sent to the model. Destination-only Google
Maps links delegate origin resolution and routing. SMS does not resolve arbitrary customer origins.

## Start the web app

```
npm run dev -w apps/web     # Next.js App Router
```

## Scheduled work (the worker trigger)

Inbound work has **two triggers, one mechanism**. The webhook only ever **persists** an inbound
event before acknowledging; routing and delivery happen in the workers, and both triggers call the
same passes:

- **The kick (B-004) — the low-latency path.** After the webhook acknowledges Telnyx, it starts the
  inbound and outbound passes *for that one sender*. This is what makes a reply arrive in
  milliseconds instead of up to a minute. It is **registered with `waitUntil` and deliberately not
  awaited**, so it can neither delay nor fail the 200, and it owns **no guarantee**: every failure is
  swallowed and the work is left for the recovery net. It is scoped to one sender and budgeted, so a
  wedged pass is abandoned rather than running until the invocation is killed.

  **`waitUntil` is load-bearing (B-009), not decoration.** Started with a bare `void`, the kick is
  work the runtime knows nothing about: Vercel suspends the invocation the moment the handler
  returns, and the pass never runs. In production that dropped *every* inbound message — committed,
  acknowledged 200, then silently abandoned with `provider_inbox_events.claimed_at` NULL. Nothing in
  the local suites can see it, because vitest runs in Node where a floating promise resolves
  normally; `apps/web/lib/kick-survival.test.ts` asserts the registration against the route source
  for exactly that reason. (`after()` from `next/server` is the modern equivalent and requires
  Next 15.1+; this app is on Next 14.)
- **Cron — the durable recovery net.** The authenticated route below still runs the full unscoped
  passes, recovering anything a kick missed because an invocation crashed, a claim lapsed, or the
  process died mid-pass. It remains the **only** trigger for F-026's retention purge, which is never
  latency-sensitive and must not run on every inbound message.

Suppressing the kick entirely loses nothing — cron still carries the message to a dispatched reply.
That is proven directly in `apps/web/lib/latency.integration.test.ts`, which also measures the end
to end reply and proves a kick racing a concurrent cron pass cannot double-process or double-send.
Exclusion is the existing per-sender row lock in `claimNextInboundEvent`; the kick adds no new
concurrency control, it just arrives at the same lock from a second direction.

**One** authenticated internal route runs every scheduled pass:

```
GET|POST /api/internal/cron      Authorization: Bearer $CRON_SECRET
```

It runs three bounded passes in order: the inbound pass (deterministic routing →
consent/confirmation/free-text), the outbound pass (dispatch claim → provider → result), and the
**retention purge** (F-026). Each pass **enumerates its own work** — pending sender hashes, due
outbox rows, expired bodies — so the trigger passes no IDs and needs no knowledge of state.

**The retention purge** clears raw message context whose `body_expires_at` has passed: the body text
in `sms_messages` and `outbox_work`, and nothing else. The `sms_messages` row, its
`provider_inbox_events` projection, dispatch attempts, flags, and audit events all survive —
retention is selective, and the record that a message existed is what keeps the system auditable.

Three properties are worth knowing when operating it:

- **Flagged threads are exempt.** A body whose inbox event carries an **open** flag is retained;
  flag review needs a readable thread. The exemption ends when the flag is resolved or dismissed at
  `/admin/flags` (F-030) — either disposition, with no grace period, so the next pass clears it.
  The exemption fails safe: a body is purged only where the absence of an open flag can be shown.
- **It never touches outbound work the dispatcher is still using.** Only `sent`/`failed`/
  `ambiguous`/`suppressed` rows are cleared, so a purge can never race the dispatcher into sending
  an empty SMS.
- **It reports counts only.** The response carries `messageBodiesPurged`, `outboxBodiesPurged`, and
  `exempted` — never a body, an identifier, or a phone. A purge that logged what it deleted would
  defeat its own purpose.

It is idempotent and safe to run concurrently with live traffic and with itself (`for update skip
locked`), and bounded per pass, so a large backlog drains over several runs rather than in one long
transaction.

Run it locally, or by hand against a deployment:

```
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/internal/cron
```

On Vercel this is scheduled by **`apps/web/vercel.json`** (`crons` → `/api/internal/cron`, every
minute); Vercel sends the `Authorization: Bearer` header from the project's `CRON_SECRET`
environment variable. That file is asserted by `apps/web/lib/cron-schedule.test.ts` against the
route it names, because it was **missing entirely** until B-005 while this section documented it —
and the failure is silent, since B-004's kick keeps replies fast while nothing recovers what it
drops and F-026's purge never runs.

**The schedule depends on the plan, and Hobby cannot run this one.** A one-minute cron exceeds
Hobby's daily cap, so `npx vercel --prod` refuses the deploy outright. Two ways forward, and the
route's contract is identical under both — it is a plain authenticated HTTP endpoint:

- **Vercel Pro** — `vercel.json` deploys as-is, no external dependency, no extra secret handling.
- **An external scheduler** — anything that can issue an authenticated request on an interval.

**Currently live: GitHub Actions, `.github/workflows/scheduled-worker.yml`.** Until Pro is revisited
at go-live, that committed workflow is production's only scheduled recovery net, and it is what the
deployed `crons`-stripped build has instead of a Vercel schedule. It was chosen over a SaaS
scheduler for one reason: a dashboard-configured job is **unassertable**, while an in-repo workflow
is policed by `apps/web/lib/external-scheduler.test.ts` — same source-asserting family as
`cron-schedule.test.ts` and `cron-auth.test.ts`.

Two properties that test exists to hold, both learned from real defects:

- **It checks the HTTP status, not merely that `curl` ran.** A bare `curl` exits 0 on a 401, so a
  stale `CRON_SECRET` would paint a column of green checkmarks in the Actions tab while nothing had
  run since the day it rotated. The workflow captures `%{http_code}`, compares it to 200, and exits
  non-zero otherwise. *(The first draft of that assertion survived its own sabotage — it matched the
  word "status" elsewhere in the file — so it is now anchored to the comparison itself.)*
- **The secret reaches `curl` through `env:`, never interpolated into the `run:` block**, which would
  place it in the process argument list.

**Its interval is `*/5`, and that is not equivalent to Vercel's one minute.** GitHub's scheduled
events are best-effort: commonly delayed, and droppable under load. That is acceptable only because
the kick front-runs this route for live traffic, so the interval governs how long *missed* work
waits, never reply latency. Do not describe this as a one-minute pulse.

**When Pro lands, delete the workflow** rather than leaving two schedules racing the same
`for update skip locked` work.

Under any external scheduler the secret lives in a second place, which is a real cost: rotating
`CRON_SECRET` means rotating it *both* places (for this workflow, the repository secret named
`CRON_SECRET`), and a stale copy fails closed with a 401 rather than loudly — which is exactly why
the status check above is mandatory.

**Verify a schedule by its EFFECT, never by a dashboard.** A green cron entry proves an invocation
was attempted, not that the pass did its work — a 401 from a stale secret looks like activity. The
one unambiguous signal is F-026's purge, which runs on this trigger *alone*: set a body's
`body_expires_at` in the past, wait, and confirm it is `NULL`. If it clears, the trigger is
authenticated and the passes are running.
Choose the interval as a **recovery** budget, not a reply-latency one: since B-004 the kick front-runs
this route for live traffic, so the interval decides only how long work a kick *missed* waits. One
minute — Vercel Cron's floor — is fine. It is also the floor that made polling alone unable to meet
the ~10s an SMS exchange needs, which is why the kick exists.

**Authentication fails closed.** `CRON_SECRET` is required at startup with no default, the route
compares it in constant time, and there is deliberately **no** environment-conditional bypass —
`apps/web/lib/cron-auth.test.ts` reads the route source and fails if one appears. An unauthenticated
worker trigger would be a remote way to drive consent changes and real outbound SMS.

**Adding a scheduled job** means adding its call inside `runScheduledWork` in that one route —
never a second cron surface. F-026's retention purge is the worked example.

## Telnyx webhook config

Point the Telnyx number's inbound webhook at `apps/web`'s webhook route
(`apps/web/app/api/sms/webhook/route.ts`). The signature, minimized-persistence, sender-claiming,
ordering, consent, dispatch, and delivery-monotonicity requirements below are **implemented and
proven by real-Postgres tests** as of F-014; the customer-inquiry retrieval step is not. Requirements
that must hold before live SMS:

- Read the **exact raw request bytes** and verify the webhook signature before parsing. Telnyx's
  receiving guidance requires it:
  <https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks>
- After verification, commit only the minimized inbox projection with a unique provider event ID;
  do not retain the raw provider envelope or duplicate the raw E.164. **Acknowledge only after that
  commit**, within Telnyx's response window.
- Claim at most one ordinary stateful event per sender under a short Postgres row-lock transaction.
  Release before any model or SMS call, then re-lock and verify the claim/state before finalizing.
  Reject stale state transitions by provider occurrence order; order STOP/START on their separate
  consent watermark, with STOP winning an exact timestamp tie.
- Inbound messages enter the deterministic routing in [ARCHITECTURE.md](ARCHITECTURE.md) **before
  any model call**.
- For customer inquiry, deterministic routing is followed by model interpretation, code retrieval,
  grounded model selection from the retrieved IDs, then code validation/rendering/outbox.
- Unconfirmed inventory lives only in the one pending proposal record. `YES` creates the immutable
  published revision in the confirmation transaction; `NO` and expiry create no revision.

Carrier keyword and confirmation requirements center on opt-in, opt-out, and help:
<https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages> and
<https://support.telnyx.com/en/articles/9940291-10dlc-campaign-compliance-requirements>. **FLAG is a
Farm Friend product safety feature and must not be represented as a carrier-mandated keyword.**
Launch is one registered operational SMS program: `JOIN`, `START`, and documented farmer onboarding
establish its consent; universal STOP applies across all Farm Friend messaging; a customer inquiry
permits only its relevant direct reply and creates no passive follow-up subscription or `MUTE` path.
Adding an outbound message type means adding a `message_category` enum value and deciding its
consent meaning in `packages/core/src/sms/consent.ts` — never adding a second consent state or
enrollment. A new category defaults to nothing: the predicate must be extended deliberately.

Use the in-memory simulator to exercise flows without live Telnyx.

Natural-language customer inquiry is SMS-only at launch. Ordinary public map/listing/filter lookup
is model-free and uncapped. The public QR stock-out form remains model-backed and must use the
abuse/cost throttle.

Built public routes (F-019): `GET /api/public/stands` (model-free, uncapped) and
`POST /api/public/stock-out` (throttled; body carries the QR-bound `salesLocationId` UUID and
`taskText`). The throttle budget is set in the composition root — 5 model calls per client per 60s,
deliberately generous so a real reporter never meets it. Adding **any** new public model-backed
handler means routing it through `context.publicModelThrottle`; adding one that is model-free means
leaving it out. Do not add a public route that accepts a free-text *question* — inquiry is SMS-only.

## How to extend

### Add a future program

Gleaning, volunteer coordination, and Farm Bucks transactions are **plausible future programs**,
deliberately unbuilt. When one arrives:
1. Define and externally disclose its **separate enrollment**. Extend the deterministic keyword
   grammar only then; launch `JOIN`/`START` refer only to the launch operational program. Universal
   STOP continues across all Farm Friend messaging.
2. Add only the program-specific consent state and UI the approved workflow actually consumes.
3. Add its branch to the deterministic routing — **before** any model call.
4. If it needs confirmation, make it a **consumer of the existing confirmation mechanism** by
   parameterizing it — do not fork it.
5. Test-first: keyword and confirmation bypass, consent gating, the commit path.

Do **not** pre-create a general program-enrollment platform or a future program's tables, states,
command arguments, packages, or UI.

### Add an admin route or surface

1. Guard it with the shared `requireAdministrator` from `apps/web/lib/admin-guard.ts`. Do not write
   a second guard — one mechanism, several consumers, so an authorization check has one place to
   drift rather than four.
2. Take the acting administrator from the **session**, never the request body. A caller who names
   someone else must not be able to act as them.
3. Re-read the administrator's authority **inside the transaction that writes**, and commit the
   audit event in that same transaction. `packages/db/src/review.ts` and `admin.ts` are the pattern.
4. Project the minimum: no phone material unless the surface genuinely needs it, and mask it at the
   **query** (`right(phone_e164, 4)`) rather than in the renderer, so the raw number never leaves
   the database.
5. Test-first, in `apps/web/lib/admin-routes.integration.test.ts`: add the refusal assertion for
   **every method** on the new route to the unauthorized-caller block, and grep the whole serialized
   response for an E.164 and for any 64-hex run.

**A PUBLIC auth route is the exception, and inverts most of this.** `/api/auth/request-link` and
`/api/auth/callback` are deliberately unauthenticated — they are how someone becomes authenticated,
so `requireAdministrator` cannot apply. What replaces it:

- **Answer identically for every input.** Not "return 200 in both cases" — identical status,
  headers, and body, asserted by comparing whole serialized responses. Include the failure paths:
  a malformed address, and an internal error on work only a real administrator triggers.
- **Front it with `createPublicActionThrottle` on its own budget**, and consult the throttle
  *before* any database lookup, so a refused request performs no read and cannot be timed.
- **Bucket by client, never by the identifier being probed.** A per-address budget tells an
  attacker which addresses are real by which ones start refusing.
- **Build outbound URLs from configured values**, never from `Host` or `X-Forwarded-Host`.

### Add a model seam

1. Add the seam to the catalog in [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) and define its schema.
2. Define the seam's explicit minimal input projection. It may contain only the current task text,
   required public facts, and opaque identifiers; never pass a raw record, transcript, other
   actor's text, contact/auth/consent/admin/audit data, internal note, or secret.
3. Add a task-specific context constructor and keep the low-level branded provider call internal to
   `packages/ai`; do not give the adapter a repository, database client, or provider-managed thread.
4. Validate the output against **schema and evidence**, one repair retry, then clarify or flag.
   Structural validity is not grounding.
5. Code-render every consequential or cross-actor message. Model-authored prose may return only to
   the same actor whose current task text supplied its private context.
6. Add a hostile full-workflow fixture that captures the provider context and resulting outbox row
   (advisory; **critical** if safety-relevant), then run the evals.

**Copy the worked example.** `inventory-extraction` is the built seam and the pattern to follow:
`projectInventoryExtraction` in `packages/ai/src/projections.ts` (step 2–3, note it copies each
permitted field explicitly rather than spreading a caller's object),
`packages/ai/src/inventory-seam.ts` (step 4, and note every schema member is `.strict()` so a
smuggled consequential field is a visible refusal, not a silent strip),
`apps/web/lib/interpretation.ts` (step 5, plus snapshot-membership validation the schema cannot
do), and `evals/hostile.ts` with the hostile group in `apps/web/lib/interpretation.integration.test.ts`
(step 6). Add the new projection's own bypass assertions to
`packages/ai/src/safety-boundary.type-test.ts`.

### Swap a provider

- **Model version, same approved provider contract:** implement/select it by config; the branded
  context boundary remains unchanged and the full suite must pass at parity or better.
- **Model provider:** before selection, re-verify that it does not train on Farm Friend
  requests/responses, calls are stateless, request/response logging is disabled where supported,
  and unavoidable retention has an approved documented maximum. A provider swap is not exempt from
  this privacy gate. **Declare the terms in code**: add the provider's `ProviderDataHandling` to
  `resolveModelConfig` in `apps/web/lib/composition.ts`. `assertProviderApproved` runs at startup
  and **throws** on any violation, so a provider that cannot meet the terms never constructs. Note
  what this is: an operator-attested, version-controlled declaration checked in code — not a
  network audit of the vendor's actual practice.
- **SMS:** implement the transport (send + **signature verification**); the redaction guard
  continues to normalize avoidable Unicode and block raw phones. After the provider accepts a send,
  record encoding, character count, and estimated billable segments — **by recipient hash, never
  with message text**. Preserve the outbox dispatch-authorization boundary: retry a definitive
  retryable rejection only under the bounded policy, and quarantine a possibly accepted result
  rather than automatically sending it again.

## Deploy (only when asked)

Vercel (web + API + scheduled jobs) against Neon Postgres. Never deploy unless explicitly asked
(CLAUDE.md "Do not").

**Migrations are a separate operator step, not part of the build** (B-006 — this section claimed
otherwise while no such step existed):

```
DATABASE_URL=… npm run db:migrate
```

Idempotent, so re-running is the normal way to check state. It prints the target's host and database
name but **never** the connection string's password.

**Migrate against an empty database, and check first.** `0000_clean_launch.sql` uses
`CREATE TABLE IF NOT EXISTS`, so a table that already exists under a *different* schema is silently
skipped — and a later `ALTER TABLE … ADD CONSTRAINT` then fails on a column that was never created.
The result is a half-applied schema where **every retry fails identically**, and the error names a
missing column rather than the real cause. This happened on the first deploy (2026-07-27) against a
database still holding the older Farm Friend's tables. Inspect
`information_schema.tables` before migrating into anything you did not create empty.

On **Neon**, use the **direct** connection string (the hostname *without* `-pooler`) for migrations;
the pooled one is for the running app. This was not the cause of the failure above, but it is Neon's
documented guidance for DDL. It is deliberately **not** wired into the Vercel
build: a build hook would migrate on every preview deploy and every rollback, pointing whatever
`DATABASE_URL` that environment carries at a schema change — including production, from a branch
build.

**First run 2026-07-27**, as a throwaway Hobby-tier validation (https://farm-friend-web.vercel.app),
not the F-029 go-live. Steps 1–5 are now **proven**; steps 6–10 (Telnyx) remain unrun.

Two things that cost real time and are not obvious:

- **Deploy with `npx vercel --prod` from a local checkout.** The Git integration built the same
  pre-fix commit three times regardless of what was pushed. The CLI uploads what is on disk.
- **A monorepo deploy installs `apps/web` alone**, so anything the build needs must be declared
  there — not merely at the workspace root. Five defects of exactly this shape shipped undetected
  because npm hoisting hides them locally (B-005/B-006/B-007);
  `packages/core/src/workspace-manifests.test.ts` is what now catches them.

The order is the safety property: **do not point the carrier at the app before the app can honor
`STOP`.**

1. **Confirm the 10DLC campaign is _approved_**, not merely submitted. Carrier approval is queue
   time outside our control.
2. **Provision Neon Postgres**, then `DATABASE_URL=… npm run db:migrate` against it from empty.
3. **Create the Vercel project** with **root directory `apps/web`** (this is a workspace monorepo;
   `apps/web/vercel.json` carries the cron schedule). Set every variable below — configuration
   **fails closed**, so a missing one is a startup error rather than a degraded mode:

   | Variable | Notes |
   |---|---|
   | `DATABASE_URL` | the Neon connection string |
   | `PHONE_HASH_SALT` | a real generated secret — **never** the `.env.example` placeholder |
   | `CRON_SECRET` | a real generated secret; Vercel Cron sends it as the bearer token |
   | `MAGIC_LINK_SECRET` | a real generated secret (F-025a) |
   | `PUBLIC_BASE_URL` | the deployment's `https://` origin (F-032) |
   | `SMS_PROVIDER` | `telnyx` |
   | `TELNYX_API_KEY` · `TELNYX_MESSAGING_PROFILE_ID` · `TELNYX_FROM_NUMBER` | delivery credentials |
   | `TELNYX_PUBLIC_KEY` | the **ed25519 webhook verification key**; without it inbound webhooks cannot be verified at all |

4. **Verify configuration fails closed** in the deployed environment. Env vars do not take effect
   until a **redeploy**. POST an unsigned request to the live webhook and read the status — the
   diagnostic is **three-way**, because `route.ts` calls `appContext()` *before* the provider check
   and `resolveConfig` **throws** on a missing Telnyx var:

   | Status | Meaning |
   |---|---|
   | **401** `missing_signature` | config resolved — proceed |
   | **503** `webhook_not_configured` | `SMS_PROVIDER` is not `telnyx` (execution reached the provider check, so the other vars resolved) |
   | **500** | `SMS_PROVIDER=telnyx` but a Telnyx credential is **missing or blank** |

   A missing credential is **500, never 503** — an earlier version of this section said otherwise and
   sent a real debugging session after the wrong var. `vercel env pull` cannot verify values;
   encrypted vars return `[SENSITIVE]`. `vercel env ls` timestamps are a useful tell for which vars
   were actually edited.

   **On Hobby, `npx vercel --prod` refuses to deploy at all** — `vercel.json`'s one-minute cron
   exceeds the plan's daily cap. Strip the `crons` block from the working tree **uncommitted**,
   deploy (the CLI uploads from disk), and restore it immediately; `cron-schedule.test.ts` failing is
   the tripwire for a forgotten restore. Do **not** deploy `throwaway/hobby-deploy-test` — it carries
   no source difference, only doc drift, and is never-merge.
5. **Run the administrator bootstrap once** against the production database (§"Bootstrap the first
   administrator"). Note that **no sign-in link is delivered until F-031**, so mint one out of band
   with `issueMagicToken`.
6. **Point the Telnyx messaging profile's webhook** at `https://<deployment>/api/sms/webhook`, and
   confirm +1 206-864-5326 is attached to that profile.

   Leave the profile's three **auto-response message fields empty** (Keywords tab). Farm Friend sends
   the registered copy itself; text here would double-reply. The STOP/START/HELP keyword *labels* are
   fixed and non-editable — that is expected.

   **Attaching the number to the profile is not the same as provisioning it on the approved
   campaign — check both.** Messaging → Campaigns → your campaign → the number's **Provisioning
   Status** must read **Active**, not **Pending**.

   This cost a whole session on 2026-07-27. The campaign was approved and the number showed Active
   *on the profile*, but it had never been provisioned *on the campaign*. Real `STOP` and `HELP`
   produced no reply, no webhook delivery, and **no Telnyx message record at all** — an unprovisioned
   number has no carrier route for inbound 10DLC traffic, so the messages died upstream of Telnyx
   entirely. Nothing in the profile view hints at this. `HELP` failing identically to `STOP` is what
   ruled out carrier keyword absorption and pointed upstream.

   Provisioning is carrier-side and clears on its own, typically minutes to hours.
7. **Verify signature rejection first:** an unsigned or wrongly signed POST to the live webhook must
   return 401 *before* any real message is sent.
8. **Send a real `STOP` before a real `JOIN`.** `STOP` is the compliance-critical path and the one a
   carrier audits. Verify the durable consent state changed, then `JOIN`, then `HELP`.
9. **Confirm the scheduled pass is actually firing** in the deployment (Vercel's cron log, plus its
   effects — an expired body cleared by F-026's purge). The B-004 kick masks a dead cron by keeping
   replies fast, so "replies work" is *not* evidence the schedule runs.
10. Record the verified result and the console state here.

## Failure triage

- **Unit test needs a DB/SMS/model** → a seam isn't injected; pure logic must take the provider and
  `Clock` as arguments.
- **`tsc` fails on a model call or send** → you're bypassing the task-specific constructor or
  redactor; go through it (that's the static provenance barrier working).
- **Integration tests "pass" instantly** → `DATABASE_URL` is unset and they skipped. That is not a
  green data layer.
- **A hostile workflow test/eval exposes unavailable private data or forces a commit** → runtime
  projection, validation, or deterministic consequence handling has a bug; fix the code, not the
  prompt (Golden Rule #6). The failing eval detected the bug; it was not the production guard.
- **An SMS is not arriving** → read the failed attempt, do not reproduce the call by hand:

  ```sql
  select state, error_code, provider_code, provider_error_detail, started_at
  from outbox_dispatch_attempts
  where state in ('definitive_rejection', 'ambiguous')
  order by started_at desc limit 20;
  ```

  `error_code` is the HTTP status and names only a category. **`provider_code` and
  `provider_error_detail` are the ones that identify the cause** (B-010) — before they existed, two
  separate 2026-07-27 investigations each burned hours recovering by curl a sentence the provider
  had already sent us. Known values:

  | provider_code | Meaning | Action |
  |---|---|---|
  | `40001`-class, "source phone number … deemed invalid" | `TELNYX_FROM_NUMBER` is not exact E.164 | Fix the env var; a leading `+` is required |
  | `40300`, "Blocked due to STOP message" | Telnyx's carrier block rule is active for that recipient | See B-011 — `START` lifts it, `JOIN` does **not** |

  `provider_error_detail` is phone-masked (`[redacted]`) and capped at 500 chars, so it is safe to
  read and paste. Both columns are best-effort: a provider returning an unparseable body records the
  status alone rather than failing the write.
