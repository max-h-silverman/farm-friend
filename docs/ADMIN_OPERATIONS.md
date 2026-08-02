# Farm Friend — Admin Operations

The VIGA operator guide: administrator authority, admin surfaces, and operator runbooks. Admin
is a **first-class requirement** — non-technical VIGA staff run oversight through a guided web
admin.

> This is the **VIGA operator guide** — administrator identity and the surfaces that serve it. It
> carries no build status: what is actually built and open lives in
> [CURRENT_STATE.md](CURRENT_STATE.md).

## Administrator authority

**There is one administrator authority at launch.** There are no separate staff or moderator
levels.

- **administrator** — VIGA. Approves participating farms, resolves flags, reviews stock-out
  reports, and handles exceptions the system cannot safely handle. Max is escalation.
- **farmer** — owns their farm's listings and inventory through a separate farm authorization.

Every admin page and mutation route enforces a **server-side authorization check** against durable
records. Never trust a client-supplied identity or id.

**How identity works (F-056).** There is one fixed account: `board@vigavashon.org`. The database
refuses every other administrator identity. Sign-in verifies the configured password and re-reads
that fixed authority row; neither the password nor its verifier is stored in Postgres.

Success mints a **durable session**: a database row whose token the browser holds as an opaque
`HttpOnly; Secure; SameSite=None; Partitioned` cookie. Partitioning lets the credential work inside
VIGA's Squarespace iframe while confining it to that top-level site; a different embedding site gets
a different empty cookie partition. Only the token's **hash** is stored, so a database read cannot
recover a live credential. The administrator row is looked up **per request** from the session,
which is why revoking an administrator or a session takes effect on their **next request** rather
than whenever a self-contained token would have expired. Sessions expire in 12 hours; signing out
revokes the record server-side, not just the cookie.

**How you actually sign in.** Go to `/admin/login`, keep the fixed email shown there, enter the
administrator password, and choose **Sign in**. The page works without JavaScript. Every refusal has
the same wording, whether the email, password, authority row, configuration, or throttle caused it.
Failed attempts are limited by both a coarse client network and an account-wide durable budget.

**An administrator is never a farmer.** A live administrator session resolves directly to its
administrator row. Farmer authority is separate and always requires a live farm authorization
(Golden Rule #1). VIGA approves *whether* a farm may publish; the farmer alone owns *what* it
publishes.

**Routine inventory maintenance is not a VIGA responsibility.** If operators find themselves doing
daily data entry, the product has failed its north star.

## Admin surfaces

| Surface | Path | What the administrator does |
|---|---|---|
| Sign-in | `/admin/login` | Sign into the fixed VIGA account with its password. Public and unauthenticated; every refusal is identical |
| Farm approval | `/admin` | Verify a farm and **approve it for publication** — recorded separately from the farmer completing onboarding |
| Flag review + thread viewer | `/admin/flags` | Resolve or dismiss flags and inspect the flagged thread with phones masked |
| Stock-out report queue | `/admin/reports` | See what customers reported, per farm; mark reviewed or dismissed |
| Stand-data questions | `/admin/stand-data` | Resolve the loader's questions about VIGA's source data, recording the decision |
| Farmer access | `/admin/farmers` | Authorize a farmer to publish for a farm, see every farmer's access live and withdrawn, revoke it, and issue a replacement private link |

Each surface ships **incrementally with its workflow**, never as a final phase.

Each page resolves the administrator before querying its queue. The browser posts decisions to a
guarded mutation route; the acting administrator always comes from the **session**, never the
request body. Queue GET APIs do not exist because the pages already have the data. The one GET with
a browser consumer is `/api/admin/flags/<flag-id>/thread`, guarded by the same
`apps/web/lib/admin-guard.ts` mechanism and projected at the query boundary.

**Disposing a flag is what lets retention terminate.** F-026's purge exempts a message body whose
thread carries an **open** flag, and the exemption fails safe. Resolving *or* dismissing a flag ends
it, and the next purge pass clears that thread's expired bodies — proven end to end in
`packages/db/src/review.integration.test.ts`. Review the thread **before** you close the flag.

## Operator runbooks

- **Seed initial listing data:** run the one-time seed utility per [RUNBOOK.md](RUNBOOK.md). This
  is a greenfield load from reference input, not a migration with provenance. A location that
  cannot be geocoded is an operator task — the system never invents a coordinate.
- **Set a farmer up:** open `/admin/farmers`. Farmers who texted `SIGNUP` are waiting at the top,
  shown by the last four digits of their number. **Check that the person really runs the farm
  before you authorize them** — a phone number only proves someone has that phone, and nothing
  automates this decision. On authorizing, Farm Friend texts them that they are set up and how to
  post their first listing. The farm still needs approving (below) before anything publishes.
- **Turn off a farmer's link:** also `/admin/farmers`. A farmer's private link **keeps working
  until you revoke it** — so if a farmer loses their phone, or a link gets shared or forwarded,
  revoke it. It stops working on the very next request, and the farmer can text `LINK` for a new
  one. Revoking access also kills every link to it. **This is the only safety net a standing link
  has**, so it is a real operational duty rather than a rare cleanup: a leaked link can propose a
  wrong listing on that one stand until it is revoked. It can never change who owns a farm, alter
  anyone's authorization, reach another farm's listing, read anyone else's data, or publish without
  the farmer confirming — those are bounded by construction, not by watching the queue.
  A revoked farmer stays visible, marked revoked, so "who did we turn off, and when" has an answer.
- **Issue a link yourself:** the same screen has "Create link" / "Replace link" for a farmer who
  cannot text for one, or whom you are setting up in person. **The link is shown once and never
  again** — copy it before navigating away. Replacing a link revokes the previous one, which is
  exactly what you want after a lost phone.
- **Approve a farm:** open `/admin`, verify the farm is real, is a VIGA participant, and that the
  person who completed onboarding is authorized to act for it, then approve. Approval is **your
  act**, recorded separately; a farmer completing a form does not approve themselves. Only approved
  farms publish publicly — an unapproved farm's confirmation is refused, so this is a **hard
  prerequisite** for any farmer publishing anything, not a formality. Approval and revocation both
  record which administrator acted and when, in `farm_approvals` and the audit trail. Revoking
  blocks the *next* publication; it does not retract what is already published.
- **Restore or rotate administrator access:** follow [RUNBOOK.md](RUNBOOK.md). Rotation adds a new
  password-verifier secret version, deploys a new web revision, proves the new password, and revokes
  every old session. There is no second account or add-administrator path.
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
- **Answer a stand-data question:** open `/admin/stand-data`. When VIGA's export contradicts itself
  or states something the loader cannot resolve — two different `Open:` lines, an unresolvable
  season, a dated note saying the stand closed — the loader records the question rather than
  guessing, and this is where it surfaces. Each item names the stand, the reason in plain words, and
  the **source text** verbatim. Resolving requires a **note saying what you decided**; without it the
  queue would be a dismiss button and the audit record would say nothing. Resolution is **final and
  happens exactly once** — a second operator gets a conflict, not a silent overwrite.
  **Resolving records a decision; it does not edit the listing.** There is deliberately no action
  here that changes hours, season, offerings, or inventory: correcting a listing is a different
  capability with its own authority story, and the temptation to "fix it while I'm here" is exactly
  how a decision queue becomes an unaudited editing surface. The integration suite pins this with a
  byte-equality snapshot of every listing field across a resolution.
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

## Embedding the admin on VIGA's website

Paste this into a Squarespace **code block** on the administrator page:

```html
<iframe
  src="https://farm-friend-web-p5mfxfp5za-uw.a.run.app/admin"
  title="VIGA Farm Friend administration"
  style="width:100%;height:1100px;border:0;display:block"
></iframe>

<p>
  <a
    href="https://farm-friend-web-p5mfxfp5za-uw.a.run.app/admin"
    target="_blank"
    rel="noopener noreferrer"
  >Open admin in a separate window</a>
</p>
```

The deployed admin must send the matching partitioned session cookie before iframe sign-in works.
Administrator pages permit framing only from `https://vigavashon.org`,
`https://www.vigavashon.org`, or the app itself. Every authenticated write also requires the
browser request to originate from the admin app, independently of the cookie. A direct-window
session and a Squarespace-embedded session occupy separate browser partitions and can require
separate sign-ins.

## Embedding the map on VIGA's website (F-043)

The public map is designed to sit **inside VIGA's own page**, not to be a separate site people are
sent away to. Paste this into a Squarespace **code block** where the Google My Map embed is today:

```html
<iframe
  id="farm-friend-map"
  src="https://farm-friend-web-p5mfxfp5za-uw.a.run.app/"
  title="Vashon farm stands, updated by the farmers themselves"
  style="width:100%;border:0;display:block"
  height="900"
  loading="lazy"
></iframe>
<script>
  // The map tells this page how tall it really is; this resizes the frame to match.
  // Without it the map gets its own inner scrollbar and reads as a bolted-on widget.
  window.addEventListener("message", function (event) {
    if (!event.data || event.data.type !== "farm-friend:height") return;
    var frame = document.getElementById("farm-friend-map");
    if (frame) frame.style.height = event.data.height + "px";
  });
</script>
```

**Why the script matters.** An iframe's height is chosen by the *embedding* page — the embedded
document cannot resize its own frame. Without the listener VIGA must guess a height, and every guess
is wrong in one of two ways: too short gives the map an inner scrollbar (a small scrolling box inside
a long page), too tall leaves a slab of dead space beneath it. The map posts its real height whenever
the content changes — a filter narrowing the list, a card being selected, the phone rotating — and
those three lines keep the frame matched to it.

**The `height="900"` is a fallback**, used only for the instant before the first message arrives and
in the unlikely case the script is stripped. Do not tune it; the script supersedes it.

**What the message contains: one number.** The map posts `{type, height}` and nothing else. It reads
nothing back from VIGA's page, carries no customer data, and is not a channel for any. See
`apps/web/app/embed-height.tsx` for why it is safe for that message to be un-targeted.

**Nothing else is required** — no API key, no account, no per-view billing. The island artwork is
drawn in the page itself rather than served from a mapping provider, which is why the embed has no
usage cost no matter how often VIGA's page is loaded.

**The map is always light** (max, 2026-07-30). It does not follow the visitor's dark-mode setting:
it is a rendering of VIGA's printed farm map, which is a light artefact, and one palette is one
design that can actually be checked. So the embed will look the same to every visitor regardless
of their device theme. If VIGA's surrounding page is ever styled dark, the map will read as a
light panel within it rather than adapting — that is expected, not a fault to report.
