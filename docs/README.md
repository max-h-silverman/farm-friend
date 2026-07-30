# Farm Friend — Docs Index

The documents below own the **enduring contract** — what Farm Friend must be, and the rules its
code must honor. They deliberately carry **no build status**. What is actually built, deployed, and
open lives in exactly one place: **[CURRENT_STATE.md](CURRENT_STATE.md)**.

Start at [../CLAUDE.md](../CLAUDE.md) — the product framing, the Golden Rules, and the task
workflow. Then [CURRENT_STATE.md](CURRENT_STATE.md) for what is actually live, and
[DEVELOPMENT.md](DEVELOPMENT.md) for the pre-ship checklist covering the area you're touching.

## Read in order

1. **[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md)** — the *product*. North star, canonical launch journeys,
   actors, the honor-system reality, privacy posture, launch scope and non-goals.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — the *system*. The design stance (the zen desk), the
   four-package layout and dependency direction, the composition root, runtime surfaces,
   deterministic routing, workflow and transaction ownership, provider seams, invariants.
3. **[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md)** — the *data*. Minimum durable records, the
   constraints the database must enforce, privacy and retention, the model-run MAY-store list.
4. **[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md)** — the *AI*. The trust contract, the semantic
   architecture (meaning is the model's, consequences are code's), the seam catalog, the
   model-vs-code line, the static/runtime safety boundary plus verification, validation, evals.
5. **[SMS_COMPLIANCE.md](SMS_COMPLIANCE.md)** — keywords, consent, required behavior, the FLAG
   safety rail.

## Build status and development discipline

- **[CURRENT_STATE.md](CURRENT_STATE.md)** — the **only** place build status lives: what is verified,
  what is deployed, the live invariants, and the open items. Overwritten by `/session-wrap`. Read it
  before starting work; nothing else in this repo carries status.
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — Farm Friend's pre-ship checklists: what each suite proves,
  what to test before touching routing / a model seam / privacy / SMS / the public map, this
  project's non-goals, and the gotchas peculiar to this codebase. General engineering discipline
  (test-first, simplicity, verification) lives in the global constitution, not here.

## Go-live work

- **[GO_LIVE_GUIDE.md](GO_LIVE_GUIDE.md)** — the prioritized work order from the July 28, 2026
  whole-codebase architectural review: confirmed defects, missing launch journeys, resilience and
  housekeeping work, verification gates, and go-live exit criteria. Temporary: it becomes a short
  release checklist once its items close.

## Operate / extend

- **[RUNBOOK.md](RUNBOOK.md)** — local dev, env, migrations, seeding, evals, deploy, Telnyx webhook
  requirements, credential rotation, and **how to extend** (add a future program / add a seam /
  swap a provider).
- **[ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md)** — the VIGA operator guide: the single
  administrator level, admin surfaces, and runbooks.
- **[VIGA_10DLC_WEBSITE_COPY.md](VIGA_10DLC_WEBSITE_COPY.md)** — source copy for the public VIGA
  Farm Friend opt-in page, privacy policy, SMS terms, and campaign submission.
- **[TELNYX_10DLC_FIELD_VALUES.txt](TELNYX_10DLC_FIELD_VALUES.txt)** — field-by-field values for
  the Telnyx campaign form. A **transcript of live console state**: change the console first, then
  transcribe.

## Historical records — consult deliberately, never load by default

Dated records of how decisions were reached. **None is design authority or current status**, and
none belongs in a startup reading path. Open one when you need to know *why* something was decided,
not *what* is true now.

- **[CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)** —
  July 24–25, 2026. The clean-room reset: the approved findings, the product contract as first
  settled, the Phase 3 repository audit, and the refactor direction. Its enduring contract now
  lives in the documents above.
- **[ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md](ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md)** —
  independent adversarial review of that reset, with the ranked trust/buildability findings.
- **[SESSION_LOG.md](SESSION_LOG.md)** / **[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md)** —
  dated build history, newest first; entries older than the newest eight rotate into the archive.
  Forensic detail on defects and their fixes.

## Building X → read these

| If you're building… | Read |
|---|---|
| Compliance / confirmation routing | ARCHITECTURE §routing, SMS_COMPLIANCE, DATA §durable records |
| A model seam or prompt | AI_ARCHITECTURE (seam catalog + model-vs-code line), then run evals |
| Package boundaries / the composition root | ARCHITECTURE §package layout |
| Seeding initial listing data | RUNBOOK §seeding, PRODUCT_BRIEF §relationship to the existing map |
| Farmer onboarding / VIGA approval | PRODUCT_BRIEF §canonical journeys, ADMIN_OPERATIONS, DATA §durable records |
| Inventory publication | ARCHITECTURE §key workflows, DATA §constraints, AI §seam catalog |
| Stock-out → farmer request | DATA §constraints (never mutates inventory), ARCHITECTURE §key workflows |
| SMS customer inquiry / out-of-scope recipe requests | AI §semantic architecture + retrieval + seam catalog, ARCHITECTURE §key workflows |
| Public map proximity / directions | PRODUCT_BRIEF §public discovery, ARCHITECTURE §provider seams, RUNBOOK §seeding |
| Anything privacy or safety | AI §safety boundary and verification, DATA §privacy, CLAUDE.md Golden Rule 6 |
| Admin surfaces / flag review | ADMIN_OPERATIONS, DATA §durable records |
