# Farm Friend — Admin Operations

The VIGA operator guide: the administrator role, the admin surfaces, and operator runbooks. Admin
is a **first-class requirement** — non-technical VIGA staff run oversight through a guided web
admin.

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract.
>
> **Status: requirements, not claims.** The admin surfaces below are **not built**. Authentication
> currently validates a token but returns an empty role list with no durable session or database
> authorization. Treat this document as the specification for what must exist, not what does.

## The administrator role

**There is one administrator level at launch.** There are no separate staff, moderator, or
multi-tier roles — the earlier multi-level role model is removed.

- **administrator** — VIGA. Approves participating farms, resolves flags, reviews stock-out
  reports, and handles exceptions the system cannot safely handle. Max is escalation.
- **farmer** — owns their farm's listings and inventory. This is an *authority over their own
  records*, not an admin role.

Every admin route must enforce a **server-side authorization check** against durable records. Never
trust a client-supplied role or id.

**Routine inventory maintenance is not a VIGA responsibility.** If operators find themselves doing
daily data entry, the product has failed its north star.

## Admin surfaces

| Surface | What the administrator does |
|---|---|
| Farm approval | Verify a farm and **approve it for publication** — recorded separately from the farmer completing onboarding |
| Flag review + thread viewer | Resolve flags and inspect a paused thread. **Hard pre-launch gate** — this rail must be live before public SMS |
| Stock-out report queue | See what customers reported, per farm; mark open, acted, or dismissed |
| Exceptions | Handle requests the system cannot safely handle, with audit |

Each surface ships **incrementally with its workflow**, never as a final phase.

## Operator runbooks

- **Seed initial listing data:** run the one-time seed utility per [RUNBOOK.md](RUNBOOK.md). This
  is a greenfield load from reference input, not a migration with provenance. A location that
  cannot be geocoded is an operator task — the system never invents a coordinate.
- **Approve a farm:** verify the farm is real, is a VIGA participant, and that the person who
  completed onboarding is authorized to act for it. Approval is **your act**, recorded separately;
  a farmer completing a form does not approve themselves. Only approved farms publish publicly.
- **Watch stock-out reports:** the queue shows customer reports per farm. Reports **never** change
  the map, answers, or ranking. An alert may ask the farmer to send current inventory; only the
  farmer's confirmed revision through the ordinary inventory flow changes publication. Triage and
  dismiss reports; do not edit a farmer's inventory on their behalf.
- **Resolve a flag:** a `FLAG` pauses the thread. Review it, take the needed action, mark it
  resolved. `FLAG` is a **Farm Friend product safety feature**, not a carrier-mandated keyword.
- **Inspect a thread:** the thread viewer shows message history under the privacy policy — no raw
  phone numbers surfaced.

## Privacy in the admin

Admin surfaces honor the same data-layer privacy as everything else: phones are shown **masked**
(never full raw numbers), raw message context is short-lived and deleted on expiry (flagged threads
stay readable while the flag is open and for a bounded period after resolution), and flags and
audit records are retained. See [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §privacy.
