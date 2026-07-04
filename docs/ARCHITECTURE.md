# Farm Friend — System Architecture

The *system* source of truth: repo layout, runtime surfaces, deterministic routing, key flows,
provider seams, tenancy, and the invariants the code enforces. Product rationale is in
[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md); data in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); AI in
[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md).

## Stack

TypeScript **npm-workspace** monorepo (ESM), Postgres source of truth (Drizzle), **Next.js App
Router** as web + API/webhook host + farmer onboarding + admin, deployed on **Vercel** (Cron for
digests/reminders) against **Neon Postgres**. **Expo** native deferred but scaffolded. **Telnyx**
SMS behind a swappable seam; **open-weight-first** LLM behind a swappable seam. `tenant_id` on
core tables, single VIGA tenant seeded (cheap insurance, no multi-tenant UI yet).

## Repo layout

```
apps/
  web/        Next.js App Router: PUBLIC embedded map + stand pages; farmer web onboarding
              /claim + inventory editor; QR stock-out web form; /api routes + Telnyx webhook;
              VIGA admin/ops console; auth (email magic links)
  mobile/     Expo shell (deferred; shares API contracts + types)
packages/
  core/       Domain: compliance/commitment parsing, program routing, inventory publish +
              freshness, stock-out report→alert logic, the generic commitment state machine,
              (later) gleaning tallies/waitlist
  db/         Drizzle schema + migrations + typed queries (tenant-scoped)
  sms/        SmsTransport interface, Telnyx adapter, in-memory simulator, outbound redaction guard
  ai/         LLMProvider interface, Zod schemas + JSON Schema, prompts, the ModelSafeContext
              assembler, output validation
  config/     Env parsing/validation
  contracts/  Shared API request/response types + Zod validators (web + mobile + core)
maps/         Data-migration importer for existing VIGA map/form data → seed farms/stands
evals/        Model + grounding eval harness + fixtures (critical/advisory + adversarial)
docs/         Architecture + runbooks (first-class maintenance interface)
```

**Core is framework-agnostic**, behind narrow provider seams — no Next/DB/SMS/LLM imports in the
pure logic; providers + `Clock` are injected so unit tests run without I/O.

## Runtime surfaces

- **Public web:** the map render + a stable embeddable feed (GeoJSON/JSON) the VIGA site consumes;
  per-stand pages; the QR stock-out web form. Anonymous, no signup.
- **Farmer web:** magic-link auth → `/claim` (activation) + inventory editor.
- **Admin web:** magic-link auth → migrate-data, stock-out report queue, flag review + thread
  viewer, manual send. Server-side role checks on every route.
- **API / webhook:** `/api/health`; the Telnyx inbound webhook → core routing.
- **Cron (Vercel):** digests + reminders (later features).

## Deterministic program / commitment routing (one number)

All inbound SMS is routed by **code, before any model call**, in this fixed order:

1. **Compliance keywords win** — STOP/START/JOIN/HELP/INFO/UNSUBSCRIBE/END/QUIT. `STOP` always
   unsubscribes **globally**, regardless of conversation state, and can never be reinterpreted.
2. **`FLAG`** pauses the thread + creates a review item (the human-handoff safety rail).
3. **Live pending confirmation wins** — publish/activation `YES`/`NO`, stock-out `OUT`/`IGNORE` —
   *except* STOP/HELP/FLAG. These are **context-bound, never global**, commit **exactly once**,
   and their pending confirmation **expires** (GC'd).
4. **Active conversation state** routes the message to its in-flight flow.
5. **Role / subscription gates** eligible programs.
6. **Only then** an LLM `message-classify` seam runs.

`YES`/`NO`/`OUT`/`IGNORE` are never global. See [SMS_COMPLIANCE.md](SMS_COMPLIANCE.md) for the
keyword/consent semantics.

## The generic commitment state machine

Confirmation (a pending action + a context-bound token that commits it exactly once, with expiry)
is a **single generic mechanism** with **two consumers**, designed generically from the start so
it isn't over-fit to publish:
- **publish / activation confirm** — `YES` commits the pre-seeded or extracted inventory draft.
- **gleaning signup** — `YES`/`NO` signs up / declines within the context of a specific
  opportunity; capacity/waitlist is **code, not model**.

Building both consumers on one machine is why gleaning tables land in the spine (designed, unused).

## Key flows (code owns the commit; the model only proposes)

- **Publish:** inbound farmer text → (deterministic routing) → `farmstand-inventory-extract`
  proposes a draft → echo summary → `YES` commits: writes an `inventory_snapshot`
  (`status=current`, provenance `farmer_confirmed`), supersedes the prior current snapshot.
- **Activation (confirm-or-revise):** form-submit or VIGA-outreach trigger → a **pre-seeded**
  draft from the migrated data → `YES` confirms as-is (`migrated → farmer_confirmed`,
  `claim_status → claimed`); a text reply runs `farmstand-inventory-extract` on the revision.
- **Inquiry:** question → `inquiry-parse` (item(s) + farm scope + origin + strategy, or clarify) →
  **code-owned general retrieval/ranking** → `farmstand-query-answer` composes over grounded rows,
  recency-labeled. Empty → honest "no current listing."
- **Stock-out → alert:** SMS or QR web form → `stockout-report-parse` → a `stockout_report` (never
  touches inventory) → farmer alert per `farmer_alert_prefs` → farmer `OUT`/`IGNORE`.

## Provider seams

Narrow interfaces so I/O is swappable and tests are hermetic:
- **`SmsTransport`** (`packages/sms`) — `send` + `verify`; Telnyx adapter + in-memory simulator.
  `send` accepts only a **`RedactedOutbound`** and passes a code-level **outbound redaction guard**
  that refuses raw phone numbers / private fields regardless of model output.
- **`LLMProvider.generateJson`** (`packages/ai`) — stub + open-weight adapter (config-selected).
  Accepts only a **`ModelSafeContext`** produced by the stripping assembler; its output is
  **untrusted** and validated (schema + domain) before anything acts on it.
- **`Clock`** — injected time for deterministic recency/expiry tests.
- **`MapProvider`** — geocode; ships with an **offline/deterministic stub** for tests, evals, and
  importer runs (no network in CI). See [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md).

## Abuse / cost throttle seam (public unauthenticated LLM surfaces)

The customer inquiry route and the QR stock-out form ingest free text into an LLM with **no auth**.
The **throttle/abuse seam lives here** — a code-level rate/cost guard fronting any public
LLM-backed handler, keyed by a coarse client signal — decided now so it isn't retrofitted, and
**implemented with F-003 / F-008**, not Phase 0. Normal public lookup is **never artificially
capped**; the guard exists only to bound abuse/cost.

## Tenancy

Every top-level entity carries `tenant_id`; all typed queries are tenant-scoped. The single VIGA
tenant is seeded. No multi-tenant UI yet — this is cheap forward insurance, proven once by the
schema + integration tests.

## Invariants (enforced in code, tested)

1. The farmer owns published state — no customer action mutates the map.
2. Deterministic compliance/commitment before any model call; STOP always global; YES/NO/OUT/IGNORE
   context-bound, exactly-once, expiring.
3. The LLM proposes; code commits (publish/activation confirmation-gated).
4. Grounded, recency-labeled answers; migrated ≠ confirmed.
5. Privacy at the data layer (phones hashed, raw never logged, never in model context).
6. Safety enforced by code in three layers (compile / runtime / eval), never the system prompt.

Full statements + the "why" live in [CLAUDE.md](../CLAUDE.md) Golden Rules.
