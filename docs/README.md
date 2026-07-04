# Farm Friend — Docs Index

The architecture docs are the **source of truth**. Read them in order for a cold start; jump by
task with the "building X → read these" map below. The prior scaffold at HEAD `3f76949` is
archived reference only — where it disagrees with these docs, the docs win.

## Read in order

1. **[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md)** — the *product*. North star (a fresh map), the three
   flows + the open-intent inquiry route, actors, the honor-system reality, the
   migration/activation launch moment, MVP scope, open questions.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — the *system*. Repo layout, runtime surfaces, the
   deterministic program/commitment routing, key flows, provider seams, the abuse/cost throttle
   seam, tenancy, invariants.
3. **[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md)** — the *data*. All entities (tenant-scoped),
   constraints, the **two-axis freshness/provenance model**, the
   stock-out-report-never-mutates-inventory rule, privacy/retention, the `ai_runs` MAY-store list.
4. **[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md)** — the *AI*. The `LLMProvider` seam, the seam
   catalog, the model-vs-code line, the **three-layer code-enforced safety boundary**,
   validation/repair, evals, data minimization, the offline `MapProvider` stub.
5. **[SMS_COMPLIANCE.md](SMS_COMPLIANCE.md)** — keywords, consent, required behavior, the FLAG
   safety rail, provisional copy (A2P 10DLC assumed approved by launch — SMS is critical path).

## Operate / extend

- **[RUNBOOK.md](RUNBOOK.md)** — local dev, env, migrations, evals, deploy, Telnyx webhook config,
  the importer input contract, and **how to extend** (add a program / add a seam / swap a
  provider). Cold-start ready.
- **[ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md)** — the VIGA operator guide: roles, per-feature
  admin surfaces, and runbooks (migrate data, invite/claim a farmer, watch stock-out reports,
  resolve a flag, inspect a thread).

## Building X → read these

| If you're building… | Read |
|---|---|
| Compliance / commitment routing | ARCHITECTURE §routing, SMS_COMPLIANCE, DATA §messages/conversation_states |
| A model seam / prompt | AI_ARCHITECTURE (seam catalog + model-vs-code line), then run evals |
| The map importer / public feed | PRODUCT_BRIEF §migration, DATA §two-axis model, RUNBOOK §importer contract |
| Farmer activation (confirm-or-revise) | PRODUCT_BRIEF §activation, DATA §claim_status + provenance |
| Inventory publish | DATA §inventory_snapshots + two-axis model, AI §inventory-extract |
| Stock-out → alert | DATA §stockout_reports (never mutates), ARCHITECTURE §flows |
| Customer inquiry / recipes | AI §inquiry-parse + retrieval layer, ARCHITECTURE §abuse seam |
| Anything privacy/safety | AI §three-layer safety boundary, DATA §privacy/retention, CLAUDE.md Golden Rule 6 |
| Admin surfaces / flag review | ADMIN_OPERATIONS, DATA §flags |
| Gleaning | DATA §gleaning tables, ARCHITECTURE §commitment state machine (two consumers) |

The live snapshot of what's built vs. skeleton is **CLAUDE.md "Current State & Open Items"**.
