# Farm Friend — Docs Index

The documents below own the **enduring contract** — what Farm Friend must be, and the rules its code
must honor. They deliberately carry **no build status**. What is actually built, deployed, and open
lives in exactly one place: **[CURRENT_STATE.md](CURRENT_STATE.md)**.

Start at [../CLAUDE.md](../CLAUDE.md) — product framing, Golden Rules, task workflow. Then
[CURRENT_STATE.md](CURRENT_STATE.md) for what is live, and [DEVELOPMENT.md](DEVELOPMENT.md) for the
pre-ship checklist covering the area you're touching.

## The contract docs — read to orient

1. **[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md)** — the *product*. North star, canonical launch journeys,
   actors, honor-system reality, privacy posture, launch scope and non-goals.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — the *system*. Design stance, package layout and dependency
   direction, composition root, deterministic routing, workflow and transaction ownership, provider
   seams, invariants.
3. **[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md)** — the *data*. Scope discipline, the constraints the
   database enforces, privacy and retention, the model-run MAY-store list.
4. **[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md)** — the *AI*. Trust contract, semantic architecture, seam
   catalog, model-vs-code line, safety boundary + verification, evals.
5. **[SMS_COMPLIANCE.md](SMS_COMPLIANCE.md)** — keywords, consent, required behavior, the FLAG rail.

## The reference docs — look one thing up

Not cold-start reading. Each is the catalogue its contract doc points into.

- **[SURFACES.md](SURFACES.md)** — every runtime surface and the bounds it enforces (← ARCHITECTURE).
- **[DATA_RECORDS.md](DATA_RECORDS.md)** — every durable record, what it is for, its rules
  (← DATA_ARCHITECTURE).
- **[EXTENDING.md](EXTENDING.md)** — recipes: add a program, an admin surface, a farmer-link surface, a
  model seam; swap a provider (← RUNBOOK).

## Status, discipline, and operations

- **[CURRENT_STATE.md](CURRENT_STATE.md)** — the **only** place build status lives. Overwritten by
  `/session-wrap`. Read it before starting work.
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — per-area pre-ship checklists, this project's non-goals, and
  the gotchas peculiar to this codebase. General engineering discipline lives in the global
  constitution, not here.
- **[GO_LIVE_GUIDE.md](GO_LIVE_GUIDE.md)** — the prioritized work order to launch (`GL-###` items,
  priority bands, verification ladder). Controls order, not contract.
- **[RUNBOOK.md](RUNBOOK.md)** — local dev, env, migrations, seeding, evals, deploy, Telnyx webhook
  requirements, credential rotation.
- **[ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md)** — the VIGA operator guide.
- **[VIGA_10DLC_WEBSITE_COPY.md](VIGA_10DLC_WEBSITE_COPY.md)** — source copy for the public opt-in page,
  privacy policy, SMS terms, and campaign submission.
- **[TELNYX_10DLC_FIELD_VALUES.txt](TELNYX_10DLC_FIELD_VALUES.txt)** — field-by-field values for the
  Telnyx campaign form. A **transcript of live console state**: change the console first, then
  transcribe.

## Historical records — consult deliberately, never load by default

Dated records of how decisions were reached. **None is design authority or current status.** Open one
when you need to know *why* something was decided, not *what* is true now.

- **[SESSION_LOG.md](SESSION_LOG.md)** / **[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md)** — dated
  build history, newest first; the log keeps the newest eight entries.
- **[archive/](archive/)** — frozen documents that were once authority: the July 2026 clean-room reset
  and its adversarial review, the completed GCP migration plan (still cited by source comments in
  `apps/web/lib/`), and the F-059 listing-ingestion audit, the only record of what was *measured*
  against the real farm CSVs.

## Building X → read these

| If you're building… | Read |
|---|---|
| Compliance / confirmation routing | ARCHITECTURE §routing, SMS_COMPLIANCE, DATA §durable records |
| A model seam or prompt | AI_ARCHITECTURE (seam catalog + model-vs-code line), then run evals |
| Package boundaries / the composition root | ARCHITECTURE §package layout |
| Seeding initial listing data | RUNBOOK §seeding, PRODUCT_BRIEF §relationship to the existing map |
| Farmer onboarding / VIGA approval | PRODUCT_BRIEF §canonical journeys, ADMIN_OPERATIONS, DATA §durable records |
| Inventory publication | ARCHITECTURE §key workflows, DATA §constraints, AI §seam catalog |
| Stock-out → farmer request | DATA §constraints, ARCHITECTURE §key workflows |
| SMS customer inquiry / out-of-scope requests | AI §semantic architecture + retrieval + seam catalog, ARCHITECTURE §key workflows |
| Public map proximity / directions | PRODUCT_BRIEF §public discovery, ARCHITECTURE §provider seams, RUNBOOK §seeding |
| Anything privacy or safety | AI §safety boundary, DATA §privacy, CLAUDE.md Golden Rule 6 |
| Admin surfaces / flag review | ADMIN_OPERATIONS, DATA §durable records |
