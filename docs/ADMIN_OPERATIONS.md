# Farm Friend — Admin Operations

The VIGA operator guide: the administrator role, the admin surfaces, and operator runbooks. Admin
is a **first-class requirement** — non-technical VIGA staff run oversight through a guided web
admin.

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract.
>
> **Status: built (F-025a + F-030).** Sign-in, durable sessions, server-side role lookup,
> **farm approval/revocation**, the **flag review queue with its thread viewer**, and the
> **stock-out report queue** are built and tested. What remains unbuilt is the exceptions
> surface and a way to *send* a sign-in link (F-031) — each is marked below.

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

**How you actually sign in (F-032).** Go to `/admin/login`, enter your VIGA email address, and open
the link that arrives. The link expires in **15 minutes** and can be used once; requesting another
is free. The page works without JavaScript, because sign-in is the recovery path for every other
admin screen and must not be the one that breaks.

The confirmation always reads *"if that address belongs to an administrator, a sign-in link is on
its way"* — for **every** address, including a mistyped one. That is deliberate and not evasiveness:
the page is public, so a message that distinguished a recognized address from an unrecognized one
would let anyone on the internet discover who VIGA's operators are. If no link arrives, the likely
causes are a typo, an address that was never authorized, or one that has been revoked — the screen
cannot tell you which, and whoever runs Farm Friend can.

> **Not yet delivering mail.** The provider is not configured (F-031), so *no link is actually
> sent today*. Until it is, ask whoever runs Farm Friend to mint one for you directly. Everything
> else on this path — the form, the throttle, the token, the expiry — is live.

**An administrator is never a farmer.** The role lookup returns the administrator role only, and it
is a constant rather than a query — an operator role cannot confer the ability to act as a farm's
owner (Golden Rule #1). VIGA approves *whether* a farm may publish; the farmer alone owns *what*
it publishes.

**Routine inventory maintenance is not a VIGA responsibility.** If operators find themselves doing
daily data entry, the product has failed its north star.

## Admin surfaces

| Surface | Status | What the administrator does |
|---|---|---|
| Sign-in | **Built** (F-032) — `/admin/login` | Request a 15-minute sign-in link. Public and unauthenticated, so it answers identically for every address. **Mail delivery pending F-031** |
| Farm approval | **Built** (F-025a) — `/admin` | Verify a farm and **approve it for publication** — recorded separately from the farmer completing onboarding |
| Flag review + thread viewer | **Built** (F-030) — `/admin/flags` | Resolve or dismiss flags and inspect the flagged thread with phones masked |
| Stock-out report queue | **Built** (F-030) — `/admin/reports` | See what customers reported, per farm; mark reviewed or dismissed |
| Exceptions | **Not built** | Handle requests the system cannot safely handle, with audit |

Each surface ships **incrementally with its workflow**, never as a final phase.

**Every one of these routes enforces the role server-side** through one shared guard
(`apps/web/lib/admin-guard.ts`), and the acting administrator always comes from the **session**,
never the request body. The integration suite asserts the refusal per route and per method, so a
new handler that forgets its guard fails there rather than in production.

**Disposing a flag is what lets retention terminate.** F-026's purge exempts a message body whose
thread carries an **open** flag, and the exemption fails safe. Resolving *or* dismissing a flag ends
it, and the next purge pass clears that thread's expired bodies — proven end to end in
`packages/db/src/review.integration.test.ts`. Review the thread **before** you close the flag.

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
- **Watch stock-out reports:** open `/admin/reports`. The queue shows customer reports per farm and
  stand, with the item named — including when the report pointed at a published entry rather than
  free text. Reports **never** change the map, answers, or ranking, and the surface offers no action
  that could: the only two are **mark reviewed** and **dismiss**, both of which record that a human
  looked and change nothing a customer sees. Only the farmer's confirmed revision through the
  ordinary inventory flow changes publication. If reports pile up for one stand, chase the farmer;
  do not edit their inventory on their behalf.
- **Resolve a flag:** open `/admin/flags`. A `FLAG` creates a review item. Read the thread, take the
  needed action, then record **resolved** or **dismissed** with a short reason — the reason is
  required, because an audit record that does not say why is not much of one. Both dispositions
  record who acted and when, in `flags` and the audit trail, and both are **final**: a flag is
  disposed of exactly once, so a second operator gets a conflict rather than silently overwriting
  the first one's decision. `FLAG` is a **Farm Friend product safety feature**, not a
  carrier-mandated keyword.
- **Inspect a thread:** the thread viewer shows that sender's retained inbound messages, oldest
  first, with the flagged one marked. The sender appears **masked** — `(•••) •••-0701` — and the raw
  number never leaves the database: the query selects only the last four digits. A message whose body
  has already been deleted on its retention schedule is shown as such, rather than as a blank
  message. Text the **sender** chose to type is shown verbatim; that text is the thing under review.

## Privacy in the admin

Admin surfaces honor the same data-layer privacy as everything else: phones are shown **masked**
(never full raw numbers), raw message context is short-lived and deleted on expiry (flagged threads
stay readable while the flag is open, and become eligible for deletion the moment it is disposed
of — there is no grace period, because no consumer needs one), and flags and audit records are
retained. See [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §privacy.

The masking is a **query-level** guarantee, not a rendering convention: `listFlagsForReview` and
`readFlaggedThread` select `right(phone_e164, 4)`, so the full number is never materialized in
application memory and the admin surface never becomes a second reader of the send path's one
column. `maskPhoneSuffix` **refuses** anything longer than four digits rather than truncating it, so
a caller that accidentally passes a whole number fails closed instead of leaking. The approval queue
and the stock-out queue carry no phone material at all — asserted by tests that grep the whole
serialized response for an E.164 and for any 64-hex run.
