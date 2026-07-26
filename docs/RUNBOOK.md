# Farm Friend — Runbook (operate & extend)

Cold-start guide: with only [../CLAUDE.md](../CLAUDE.md) and this file, a developer can install,
run the suites, and start the web app. Also the **how-to-extend** guide (referenced from CLAUDE.md,
not inlined there).

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract.
>
> **Status.** The repository matches the four-package baseline and contains the clean launch schema
> plus its initial migration. The SMS webhook does not yet verify signatures or persist, repository
> workflow transactions are not implemented, and live SMS/model implementations and the composition
> root do not exist. Where a step below names a path or script that does not exist yet, it is the
> **contract the corresponding work builds to**, not a description of today.

## Prerequisites

- **Node** per `.nvmrc` (`nvm use`). npm workspaces (ESM).
- **Postgres** for integration tests and migrations: local Postgres or a disposable CI instance.
  Set `DATABASE_URL` (see `.env.example`) to a database whose test role may create and drop a
  throwaway database. The integration suite fails explicitly when the variable is absent.
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
- `MAGIC_LINK_SECRET` — signs admin sign-in links. **No default**: the callback returns 503 rather
  than verifying signatures against a guessable value, because that would be an open door to the
  farm-approval surface.
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
  milliseconds instead of up to a minute. It is started and deliberately **not awaited**, so it can
  neither delay nor fail the 200, and it owns **no guarantee**: every failure is swallowed and the
  work is left for the recovery net. It is scoped to one sender and budgeted, so a wedged pass is
  abandoned rather than running until the invocation is killed.
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
  flag review needs a readable thread. The exemption ends when the flag is resolved or dismissed.
  **F-025 builds that resolution path** — until it ships, nothing can move a flag out of `open`, so
  a flagged body retains indefinitely. That is the exemption working as designed, not a leak.
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

On Vercel, schedule it with Vercel Cron (`vercel.json` → `crons`, path `/api/internal/cron`); Vercel
sends the `Authorization: Bearer` header from the project's `CRON_SECRET` environment variable.
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

Vercel (web + API + scheduled jobs) against Neon Postgres. Migrations run as part of the deploy
step. Never deploy unless explicitly asked (CLAUDE.md "Do not").

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
