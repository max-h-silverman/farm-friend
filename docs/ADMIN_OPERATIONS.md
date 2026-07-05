# Farm Friend — Admin Operations

The VIGA operator guide: roles, the per-feature admin surfaces (each ships **incrementally with its
feature**, never as a final phase), and operator runbooks. Admin is a **first-class requirement** —
non-technical VIGA staff run daily ops through a guided web admin.

## Roles

Role names match the `role_name` enum in the schema.

- **admin** — full access; Max is escalation.
- **staff** — daily ops: onboard farmers, migrate data, resolve flags, watch stock-out reports,
  inspect threads. One tech-comfortable coordinator does heavier triage.
- **farmer** — owns their stand; not an admin role.

Every admin route enforces a **server-side role check** (the F-006c role helper). Never trust a
client-supplied role or id.

## Admin surfaces (by feature)

| Surface | Ships with | What staff do |
|---|---|---|
| Migrate-data | F-007a | Run/inspect the importer; see seeded/migrated stands. |
| Farmer onboarding | F-007b | Record a farmer (name, phone, SMS consent w/ provenance); send the activation text; see `migrated` vs `claimed`. |
| Stock-out report queue | F-008 | See what customers reported, per farm; mark open/acted/dismissed. |
| **Flag review + thread viewer** | **F-009** | Resolve flags, inspect a paused thread. **Hard pre-launch gate.** |
| Inventory health | F-005 | Review recency + farmer cadence by farm. |
| Gleaning admin | F-004 | Inspect opportunities + signup counts. |
| Console consolidation | F-005 | The above unified into one console; manual send/override with audit. |

## Operator runbooks

- **Migrate data:** run the importer per [RUNBOOK.md](RUNBOOK.md) §importer. It seeds ALL stands
  `status=current`, provenance `migrated`. Re-running is safe (idempotent) and never clobbers a
  farmer who has activated. Migrated pins show honestly aged.
- **Onboard a farmer (activation):** during outreach (in person / by phone), record the farmer in
  the onboarding surface — name, phone, and their **SMS consent** (the surface records who took
  it, when, and how). Then send the activation text; `YES` confirms the migrated data as-is, or
  the farmer texts changes. You binding the farmer to their stand is the identity check — only
  bind someone you know is that stand's farmer. Non-responders stay `migrated`, honestly labeled —
  not a failure state; no action required. If a farmer still uses the old Google Form, key the
  submission in here the same way.
- **Watch stock-out reports:** the queue shows customer reports per farm. Reports **never** change
  the map — only the farmer's confirmed `OUT` does. Staff triage/dismiss, don't edit inventory.
- **Resolve a flag:** a `FLAG` pauses the thread. Review the thread, take the needed action, mark
  the flag resolved. This rail must be live before public SMS.
- **Inspect a thread:** the thread viewer shows the message history under privacy policy (no raw
  phone numbers surfaced beyond policy).

## Privacy in the admin

Admin surfaces honor the same data-layer privacy as everything else: phones are shown masked
(never full raw numbers), raw SMS bodies are TTL-bounded (30 days; flagged threads stay readable
while the flag is open and 30 days after resolution), and audit/flags are retained. See
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §privacy.
