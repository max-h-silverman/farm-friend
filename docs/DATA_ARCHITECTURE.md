# Farm Friend — Data Architecture

The *data* source of truth: entities (all tenant-scoped), constraints, the two-axis
freshness/provenance model, privacy/retention, and the `ai_runs` MAY-store list. The concrete
Drizzle schema lives at `packages/db/src/schema.ts`; this doc is its rationale and the invariants
the schema + integration tests enforce.

## Tenancy

Every top-level entity carries `tenant_id`. All typed queries in `packages/db` are tenant-scoped.
The single VIGA tenant is seeded. Multi-tenant UI is deferred; the column is cheap forward
insurance, proven once by integration tests.

## The two-axis freshness/provenance model (load-bearing)

Keeping these **two axes separate** is what lets the migrated map look **full** on day one *and*
stay **honest** about age.

- **Axis 1 — lifecycle `status`** (`draft | current | superseded | hidden`) governs **is it shown
  on the map**. It lives on `inventory_snapshots`. Migrated inventory is `current` → it shows.
  Publishing a new snapshot sets it `current` and supersedes the prior (`superseded`).
- **Axis 2 — provenance** (`migrated | farmer_confirmed`) + a real/import date governs **honesty
  about age**. A `migrated` snapshot renders "**via VIGA's map, updated [date]**", **never**
  "confirmed today." On activation, provenance flips `migrated → farmer_confirmed` and recency
  resets to real.

Provenance/claim-state lives at **two grains** — a migrated-unclaimed stand has *no snapshot* on
day one, so the stand itself must carry the honest label too:
- **`farm_stands`**: `claim_status` (`migrated | claimed`) + `migrated_at` + `migrated_source`.
- **`inventory_snapshots`**: `status` + provenance + `confirmed_by_person_id` for per-publish audit.

This corrects the "migrated" idea from *suppressing* a pin to *annotating* it.

## Entities (all tenant-scoped)

- **`tenants`** — the tenant registry; VIGA seeded.
- **`people`** — displayName, `phone_hash` (never raw), email; the person record.
- **`person_roles`** — role grants (admin / staff / farmer / …), server-checked on every route.
- **`subscriptions`** — consent state: `global_sms` + per-program opt-in (see SMS_COMPLIANCE).
- **`farms`** — the farm; **`status`** (visibility/lifecycle of the farm).
- **`farm_stands`** — a stand under a farm; **`claim_status`** (`migrated | claimed`),
  **`migrated_at`**, **`migrated_source`**, **`visibility`**, **`lat`/`lng`** (geo, for the
  inquiry route's proximity/nearest-N strategy), update cadence.
- **`inventory_snapshots`** — a published inventory version; **`status`**
  (`draft | current | superseded | hidden`), **provenance** (`migrated | farmer_confirmed`),
  **`confirmed_by_person_id`** (who published — audit), `published_at`, `updated_at`, optional
  `expected_fresh_until`.
- **`inventory_items`** — items in a snapshot; **staple flag** + variable stock; exact quantity +
  unit + price text, or an **approximate label** (`some | limited | a lot`).
- **`stockout_reports`** — a customer report; **nullable `inventory_item_id` FK + normalized item
  text** (report a listed item *or* one not currently listed); `source` (`sms | qr_web`);
  `status` (`open | acted | dismissed`). **Never mutates inventory.**
- **`farmer_alert_prefs`** — per-farmer alert routing (`immediate | digest`).
- **`messages`** — inbound/outbound SMS; **raw body TTL-bounded**, phone stored hashed.
- **`conversation_states`** — in-flight flow state + **`pending_confirmation_json`** (the pending
  action a context-bound `YES`/`OUT` commits) + an **expiry** timestamp for GC.
- **`flags`** — FLAG review items (thread paused, needs human judgment); **retained** (audit).
- **`ai_runs`** — one row per model seam call for debuggability. **Stores no model input** (see
  MAY-store list below).
- **Gleaning tables** (`gleaning_opportunities`, `gleaning_signups`, …) — **designed, migrated,
  unused** in Phase 0. Present so the generic commitment state machine is validated against
  gleaning signup (its second consumer) and tenant scoping/migration is proven once. Capacity +
  waitlist are code-not-model.

## Hard constraints (schema + integration tests)

- **A `stockout_report` can never write inventory.** Enforced structurally + tested at the data
  layer. (Golden Rule #1.)
- **Tenant scoping on every top-level entity.** Cross-tenant reads/writes rejected.
- **`phone_hash` only** — no column stores a raw phone number; raw SMS bodies are TTL-bounded.
- **One current snapshot per stand** — publishing supersedes the prior `current` (the `status`
  axis is the answer to "which snapshot is current," not a fragile `max(published_at)`).
- **Importer idempotency** — a re-run seeds/refreshes still-`migrated` stands but never clobbers a
  stand a farmer has activated (`claim_status = claimed`).

## `ai_runs` — what it MAY store (never the model input)

The audit row must be **debuggable without becoming a PII leak**. It stores **no raw or stripped
model input** and no model output content that could carry PII. It **MAY** store:
- the **seam** name (e.g. `farmstand-inventory-extract`);
- the **provider** + **model** id;
- the **schema version** the output was validated against;
- the **validation status** (passed / repaired-then-passed / rejected) and repair count;
- an **opaque id set / hashes** linking to the durable rows involved (not their contents);
- timing/cost metadata.

If you need to debug *content*, reproduce from the durable source rows through the assembler — the
`ai_runs` row is a provenance/telemetry record, not a transcript.

## Privacy & retention

- **Phones:** normalized + hashed at ingress; the hash is the lookup/log key; **raw is never
  logged** and **never enters model context** (the assembler strips it — see
  [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md)).
- **Raw SMS bodies:** TTL-bounded; expired bodies are GC'd. Hashes, flags, and audit rows are
  retained.
- **Consent:** `global_sms` gates all SMS; per-program opt-in gates each program; `STOP` clears
  `global_sms` immediately (SMS_COMPLIANCE).
- **`conversation_states.pending_confirmation_json`** is GC'd on expiry so a stale `YES` can never
  commit an old action.
