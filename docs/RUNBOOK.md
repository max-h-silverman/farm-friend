# Farm Friend — Runbook (operate & extend)

Cold-start ready: with only [../CLAUDE.md](../CLAUDE.md) + this file, a developer can install, run
tests/evals, run the importer, and start the web app. Also the **how-to-extend** guide (referenced
from CLAUDE.md, not inlined there).

> **Phase-0 note.** Some paths/scripts below describe the target spine landed by **F-006b/F-006c**.
> Where a step names a file that doesn't exist yet, it's the contract that item builds to. This
> doc is written so it stays correct as those items land.

## Prerequisites

- **Node** per `.nvmrc` (`nvm use`). npm workspaces (ESM).
- **Postgres** for integration tests + migrations: a local Postgres or a **Neon** dev branch. Set
  `DATABASE_URL` (see `.env.example`).
- No network is required for unit tests or evals (the `MapProvider` and `LLMProvider` stubs are
  offline/deterministic).

## Local dev — the five commands

```
npm install                 # install all workspaces
npm run typecheck           # tsc across workspaces — also PROVES the safety boundary
npm run lint                # lint across workspaces
npm test                    # vitest unit — pure core logic, no DB/SMS/LLM (seams injected)
npm run test:integration    # vitest against Postgres — data invariants + importer idempotency
npm run evals               # evals/run.mjs (stub provider); critical fixtures must be 100%
```

`npm run typecheck` is part of the safety story: a deliberate un-stripped model call or un-redacted
send **fails `tsc`** (branded `ModelSafeContext` / `RedactedOutbound`). See
[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) §safety boundary.

## Environment

Copy `.env.example` → `.env` and fill:
- `DATABASE_URL` — Postgres/Neon connection (integration tests + migrations).
- `LLM_PROVIDER` / model config — selects stub vs. the open-weight adapter (stub is the default in
  tests/evals).
- `SMS_PROVIDER` — selects the in-memory simulator vs. Telnyx.
- Telnyx + magic-link secrets — for live SMS + auth (not needed for unit tests/evals).

`.env` is gitignored; only `.env.example` is committed.

## Migrations

Drizzle schema is `packages/db/src/schema.ts`. Generate + apply migrations per the `packages/db`
scripts (drizzle-kit). Integration tests apply migrations against `DATABASE_URL` and assert: the
VIGA tenant seeds, tenant scoping holds, and a stock-out report cannot write inventory.

## The map importer (`maps/`)

The importer ingests the existing VIGA map/form data into seed `farms`/`farm_stands`.

- **Input contract (the spec):** the eventual Google My Maps / Sheet export is shaped to match a
  **documented CSV/JSON input contract** — the input schema *is* the spec, since the real export
  format isn't finalized. (Fields: stand name, farm, location/address, goods/items, and a per-stand
  last-updated date **if the export carries one** — else the import date is used. This is the open
  VIGA data question; it blocks nothing.)
- **What it does:** seeds ALL stands `status=current`, provenance `migrated`, geocoded via the
  `MapProvider` seam (offline stub in tests/CI).
- **Idempotent / re-runnable:** safe to run N times. A re-run refreshes still-`migrated` stands
  (the old Google Form stays live, so re-imports pull new submissions) but **never clobbers** a
  stand a farmer has activated (`claim_status = claimed`). Tested.

Run it per the `maps/` script; inspect results in the migrate-data admin surface
([ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md)).

## Start the web app

```
npm run dev -w apps/web     # Next.js App Router — public map placeholder + /api/health
```

`/api/health` returns OK; the Telnyx webhook route accepts a simulated payload through core. The
public map renders the migrated-as-current feed (honestly aged).

## Telnyx webhook config

Point the Telnyx number's inbound webhook at `apps/web`'s webhook route. Inbound messages enter the
deterministic routing in [ARCHITECTURE.md](ARCHITECTURE.md) §routing before any model call. Use the
in-memory simulator (`SMS_PROVIDER=simulator`) to exercise flows without live Telnyx.

## How to extend

### Add a program
1. Define its consent (per-program opt-in) in `subscriptions`; wire `JOIN`/enrollment.
2. Add its branch to the deterministic routing (ARCHITECTURE §routing) — **before** any model call.
3. If it needs confirmation, make it a **consumer of the generic commitment state machine** (don't
   fork it) — a pending action + a context-bound token that commits exactly once and expires.
4. Test-first: keyword/commitment bypass, consent gating, the commit path.

### Add an LLM seam
1. Add the seam to the catalog in [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) and define its Zod
   schema in `packages/ai`.
2. Assemble its context through the **`ModelSafeContext` assembler** (never pass a raw record).
3. Validate the output (schema + domain), one repair retry, then clarify/flag — never a silent
   guess.
4. Add eval fixtures (advisory; **critical** if it's safety-relevant) and run `npm run evals`.

### Swap a provider
- **LLM:** implement `LLMProvider.generateJson` for the new backend; select via `LLM_PROVIDER`. The
  branded `ModelSafeContext` boundary is unchanged.
- **SMS:** implement `SmsTransport` (`send` + `verify`); the `RedactedOutbound` guard continues to
  normalize avoidable Unicode and block raw phones. After the provider accepts a send, call
  `logOutboundSmsMetrics` to record encoding, character count, and estimated billable segments;
  select the adapter via `SMS_PROVIDER`.
- **Map:** implement `MapProvider` (geocode); keep the offline stub for tests/evals/importer.

## Deploy (only when asked)

Vercel (web + API + Cron) against Neon Postgres. Migrations run as part of the deploy step. Never
deploy unless explicitly asked (CLAUDE.md "Do not").

## Failure triage

- **Unit test needs a DB/SMS/LLM** → a seam isn't injected; pure logic must take the provider +
  `Clock` as arguments.
- **`tsc` fails on a model call / send** → you're bypassing the assembler/redactor; go through it
  (that's the compile guard working).
- **An eval leaks a phone / forces a commit** → the runtime guard or data-minimization has a bug;
  fix the code, not the prompt (Golden Rule #6).
- **Importer clobbered an activated stand** → the idempotency guard on `claim_status` regressed;
  re-check before re-running against real data.
