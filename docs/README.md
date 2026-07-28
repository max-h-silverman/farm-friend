# Farm Friend — Docs Index

**[CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md) is the
design authority.** Read it first. The documents below restate the settled contract for daily use;
where any of them disagrees with the handoff, the handoff wins.

> **Read these as requirements, not as status.** The repository is mid-rebuild toward the approved
> baseline. Several guarantees these docs describe are **not yet enforced by executable code** —
> each doc carries a status note naming its own gaps. The live snapshot of what is actually true is
> **CLAUDE.md "Current State & Open Items"**.

## Read in order

0. **[CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)** —
   the settled product contract, the approved architecture baseline, the repository audit, and the
   refactor direction.
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

## Go-live work

- **[GO_LIVE_GUIDE.md](GO_LIVE_GUIDE.md)** — the prioritized work order from the July 28, 2026
  whole-codebase architectural review: confirmed defects, missing launch journeys, resilience and
  housekeeping work, verification gates, and go-live exit criteria.

## Review handoffs

- **[ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md](ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md)** —
  independent adversarial review of the clean-room reset, including the ranked trust/buildability
  findings and the **spiral-staircase constraint** against over-architecting. **Review input, not
  design authority:** its recommendations change the contract only after explicit agreement.

## Operate / extend

- **[RUNBOOK.md](RUNBOOK.md)** — local dev, env, migrations, seeding, evals, deploy, Telnyx webhook
  requirements, and **how to extend** (add a future program / add a seam / swap a provider).
- **[ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md)** — the VIGA operator guide: the single
  administrator level, admin surfaces, and runbooks.
- **[VIGA_10DLC_WEBSITE_COPY.md](VIGA_10DLC_WEBSITE_COPY.md)** — source copy for the public VIGA
  Farm Friend opt-in page, privacy policy, SMS terms, and campaign submission.
- **[TELNYX_10DLC_FIELD_VALUES.txt](TELNYX_10DLC_FIELD_VALUES.txt)** — field-by-field values for
  the Telnyx campaign form.
- **[SESSION_LOG.md](SESSION_LOG.md)** — build history. **Historical record**: it describes
  decisions that the clean-room contract has since superseded.

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
