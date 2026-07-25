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
- Model provider selection and model config — stub is the default in tests and evals.
- SMS provider selection — in-memory simulator vs. Telnyx.
- Telnyx credentials, the **webhook signing key**, and auth secrets — for live SMS and sign-in
  (not needed for unit tests or evals).

Runtime configuration is parsed and validated in the **single composition root** in `apps/web`;
there is no `config` package. `.env` is gitignored; only `.env.example` is committed.

## Migrations

The launch schema is a **clean initial migration** containing only the minimum durable records in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md), with the constraints listed there enforced at the
database level.

`npm run test:integration` creates a uniquely named empty database through `DATABASE_URL`, applies
every file in `packages/db/drizzle/`, runs the migration set again to prove the Drizzle journal is
a no-op, exercises the launch constraints, and drops the test database. This is destructive only
to the uniquely named database created by the harness; never point manual migration commands at a
database whose contents you intend to preserve.

## Seeding initial listing data

This is a **greenfield build**: existing VIGA map content is **reference input, not a schema
contract**, and there is no non-destructive migration requirement or provenance axis.

A **one-time seed utility** validates and loads farms, sales locations, listing facts, and approval
state. Geocoding happens **once, during seeding** — it is not a permanent runtime provider seam,
and a location that cannot be resolved is an **operator task**, never a fabricated coordinate.
Optional public-web browser geolocation is transient and used only for approximate proximity to
those validated coordinates; it is not persisted or sent to the model. Destination-only Google
Maps links delegate origin resolution and routing. SMS does not resolve arbitrary customer origins.

## Start the web app

```
npm run dev -w apps/web     # Next.js App Router
```

## Telnyx webhook config

Point the Telnyx number's inbound webhook at `apps/web`'s webhook route. Requirements that must
hold before live SMS:

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

Use the in-memory simulator to exercise flows without live Telnyx.

Natural-language customer inquiry is SMS-only at launch. Ordinary public map/listing/filter lookup
is model-free and uncapped. The public QR stock-out form remains model-backed and must use the
abuse/cost throttle.

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

### Swap a provider

- **Model version, same approved provider contract:** implement/select it by config; the branded
  context boundary remains unchanged and the full suite must pass at parity or better.
- **Model provider:** before selection, re-verify that it does not train on Farm Friend
  requests/responses, calls are stateless, request/response logging is disabled where supported,
  and unavoidable retention has an approved documented maximum. A provider swap is not exempt from
  this privacy gate.
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
