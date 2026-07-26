# Farm Friend — Admin Operations

The VIGA operator guide: the administrator role, the admin surfaces, and operator runbooks. Admin
is a **first-class requirement** — non-technical VIGA staff run oversight through a guided web
admin.

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract.
>
> **Status: partly built (F-025a).** Sign-in, durable sessions, server-side role lookup, and
> **farm approval/revocation** are built and tested. The **flag queue and the stock-out report
> queue are not** — they are F-030, and the sections describing them below remain requirements
> rather than descriptions. Each surface says which it is.

## The administrator role

**There is one administrator level at launch.** There are no separate staff, moderator, or
multi-tier roles — the earlier multi-level role model is removed.

- **administrator** — VIGA. Approves participating farms, resolves flags, reviews stock-out
  reports, and handles exceptions the system cannot safely handle. Max is escalation.
- **farmer** — owns their farm's listings and inventory. This is an *authority over their own
  records*, not an admin role.

Every admin route must enforce a **server-side authorization check** against durable records. Never
trust a client-supplied role or id.

**How identity works (F-025a).** An administrator is identified by **email**, because that is what
the login path proves. Sign-in is a magic link: the signed, expiring token is verified, and then the
email is looked up in `administrators`. Holding a valid link proves you control an address — it does
**not** make you an operator; only a row someone deliberately created does. A non-administrator
receives the same refusal as a bad token.

Success mints a **durable session**: a database row whose token the browser holds as an opaque
`HttpOnly; Secure; SameSite=Lax` cookie. Only the token's **hash** is stored, so a database read
cannot recover a live credential. Roles are looked up **per request** against that session's
administrator, which is why revoking an administrator or a session takes effect on their **next
request** rather than whenever a self-contained token would have expired. Sessions expire in 12
hours; signing out revokes the record server-side, not just the cookie.

**An administrator is never a farmer.** The role lookup returns the administrator role only, and it
is a constant rather than a query — an operator role cannot confer the ability to act as a farm's
owner (Golden Rule #1). VIGA approves *whether* a farm may publish; the farmer alone owns *what*
it publishes.

**Routine inventory maintenance is not a VIGA responsibility.** If operators find themselves doing
daily data entry, the product has failed its north star.

## Admin surfaces

| Surface | Status | What the administrator does |
|---|---|---|
| Farm approval | **Built** (F-025a) — `/admin` | Verify a farm and **approve it for publication** — recorded separately from the farmer completing onboarding |
| Flag review + thread viewer | **Not built** (F-030) | Resolve flags and inspect a paused thread. **Hard pre-launch gate** — this rail must be live before public SMS |
| Stock-out report queue | **Not built** (F-030) | See what customers reported, per farm; mark open, acted, or dismissed |
| Exceptions | **Not built** | Handle requests the system cannot safely handle, with audit |

Each surface ships **incrementally with its workflow**, never as a final phase.

`/api/admin/flags` currently returns an empty list behind a working role check. Do **not** read that
as "there are no flags" — nothing yet reads the `flags` table. Until F-030 ships, an arriving flag is
durable and unreviewable, and F-026's retention exemption therefore retains its thread indefinitely.

## Operator runbooks

- **Seed initial listing data:** run the one-time seed utility per [RUNBOOK.md](RUNBOOK.md). This
  is a greenfield load from reference input, not a migration with provenance. A location that
  cannot be geocoded is an operator task — the system never invents a coordinate.
- **Approve a farm:** open `/admin`, verify the farm is real, is a VIGA participant, and that the
  person who completed onboarding is authorized to act for it, then approve. Approval is **your
  act**, recorded separately; a farmer completing a form does not approve themselves. Only approved
  farms publish publicly — an unapproved farm's confirmation is refused, so this is a **hard
  prerequisite** for any farmer publishing anything, not a formality. Approval and revocation both
  record which administrator acted and when, in `farm_approvals` and the audit trail. Revoking
  blocks the *next* publication; it does not retract what is already published.
- **Add an administrator:** the first one per environment comes from the bootstrap script in
  [RUNBOOK.md](RUNBOOK.md); afterwards administrators live in the database. Authorization is
  deliberately **data, not configuration** — an env-var allowlist could not record who granted it.
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
