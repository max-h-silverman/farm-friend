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

**How you actually sign in.** Open any admin page — the sign-in fields are shown there directly when
you are signed out, so `/admin` works as well as `/admin/login`. Keep the fixed email shown, enter
the administrator password, and choose **Sign in**. The page works without JavaScript. Every refusal
has the same wording, whether the email, password, authority row, configuration, or throttle caused
it.
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
| Home | `/admin` | See everything waiting for a decision, and nothing else. Each item links to where the work is done |
| Farms | `/admin/farms` | Everything about one farm on one card: approve it, edit its name and description, see and revoke who can update it, send a setup link, review its stands and their Farm Bucks status, take a stand or the whole farm off the map and put it back, mark it a test farm |
| Messages | `/admin/messages` | Everything a person sent us: customer `FLAG` messages with the thread viewer (phones masked), stock-out reports, and questions about VIGA's own records |
| Invite a farmer | `/admin/farmers` | Prepare an invitation for someone not yet on Farm Friend, and decide access requests that arrived by text with no farm attached |

**Three tabs: Home, Farms, Messages.** The console used to have one screen per queue, which is
why a farm appeared six ways and no screen owned it — and why "Customer reports" and "Stock
reports" sat side by side as separate tabs when a stock-out *is* a customer report. Each screen
now owns one subject. `/admin/farmers` is reached from Home, because it is about *people* rather
than about a farm.

Each surface ships **incrementally with its workflow**, never as a final phase.

Each page resolves the administrator before querying its queue. The browser posts decisions to a
guarded mutation route; the acting administrator always comes from the **session**, never the
request body. Queue GET APIs do not exist because the pages already have the data. The one GET with
a browser consumer is `/api/admin/flags/<flag-id>/thread`, guarded by the same
`apps/web/lib/admin-guard.ts` mechanism and projected at the query boundary.

The Farm Bucks selector on each stand is a guarded browser mutation. It accepts only the three
states, derives the two stored booleans together, locks the stand row while saving, and records the
administrator from the session rather than the request body.

**Disposing a flag is what lets retention terminate.** F-026's purge exempts a message body whose
thread carries an **open** flag, and the exemption fails safe. Resolving *or* dismissing a flag ends
it, and the next purge pass clears that thread's expired bodies — proven end to end in
`packages/db/src/review.integration.test.ts`. Review the thread **before** you close the flag.

## Operator runbooks

- **Seed initial listing data:** run the one-time seed utility per [RUNBOOK.md](RUNBOOK.md). This
  is a greenfield load from reference input, not a migration with provenance. A location that
  cannot be geocoded is an operator task — the system never invents a coordinate.
- **Invite a farmer — this is where you decide.** On `/admin/farmers`, choose the farm (or
  **New farm** and type its name, which creates it), choose text or email, and enter the
  recipient's address. Farm Friend creates a one-use onboarding link and opens your own text or
  email app with the message ready. Send it from there. The link expires after seven days.
  **Sending an invitation that names a farm IS your approval of that farmer for that farm** — when
  they accept the SMS agreement and send the prepared `JOIN <invite>` from their phone, Farm
  Friend sets them up and approves the farm, and texts them that they are ready. So check the
  person really runs the farm **before you send the link**; nothing asks you again afterwards.
- **A farmer lost their setup link:** open the farm on `/admin/farms`. Its **Who can update this
  farm** section says whether the most recent link is still open, has expired, or was never sent.
  **The original link cannot be shown again** — only a scrambled form of it is stored, the same
  reason a website sends a password reset instead of your old password. Press **New setup link**;
  it is copied to your clipboard and shown on that farm's card, it replaces any earlier link, and
  the same "sending it is your approval" rule applies. Home counts these under **Farms nobody can
  update**, so you do not have to go looking for them.
- **Take a stand off the map:** open its farm on `/admin/farms`, open the stand under **Stands**,
  and press **Take off the map**, then confirm. The stand leaves the map and the text answers, and its farmer
  can no longer publish updates to it. **Nothing it already published is deleted** — the record of
  what that stand said it had, and when, is kept. Press **Put back on the map** to undo it. Use this
  when a farm stops running a stand; it is not how you fix a wrong listing detail.
- **Correct a farm's name or description:** open it on `/admin/farms` and press **Edit details**.
  This is VIGA's own record of the farm — its name and description. It is **not** the listing:
  what a stand has, when it is open, and what it costs stay the farmer's (Golden Rule #1), and
  there is deliberately no control here that changes them.
- **Remove a whole farm:** open it on `/admin/farms` and press **Remove this farm**, then confirm.
  The farm and **all of its stands** leave the map and the text answers. **Nothing it already
  published is deleted** — a farm cannot be erased, because that would erase the record of what
  its stands said they had and when. Press **Put this farm back** to undo it. A stand you had
  already taken off the map on its own stays off when the farm comes back.
- **Rehearse against the real site with a test farm (F-074):** open the farm on `/admin/farms` and
  press **Mark as test farm**.
  Marking a farm as a test farm makes it **absent** — from the map, from `/api/public/stands`,
  from customer text answers, and from the farm list at `/farmer/start`. It is not a listing with
  a warning on it; islanders simply never see it. Unmark it to put it back. Both directions are
  recorded against you.
  **To see test farms yourself**, add `?hidden=true` to the map address, or add your mobile
  number under **Phones that can see test farms** and text Farm Friend normally.
  **Two things to be clear about before you use this.** First, `?hidden=true` is **not a
  password** — anyone who knows to type it sees test farms. That is fine for a fake farm and
  wrong for a real one: a farmer who does not want her address published is set to *contact only*
  instead, which is a fact about her listing rather than a web address anyone can guess. Second,
  a number on the phone list gets **visibility and nothing else** — it cannot publish, approve,
  or read anything an ordinary number cannot. Removing a number stops it seeing test farms on its
  very next text.
  **A test farm can still be set up through `/farmer/start`** even though it is not in the
  dropdown, which is deliberate: walking a farmer's whole journey is the thing a test farm exists
  for. Name test farms so they read as fake — that name is the only marker anywhere.
- **Set a farmer up by hand:** open `/admin/farmers`. Anyone whose request needs a person is
  waiting at the top, shown by the last four digits of their number — an invitation naming no
  farm, or one whose agreement was never ticked. (A third source, someone texting with no
  invitation at all, ended with the `SIGNUP` keyword in F-080.)
  **Check that the person really runs the farm before you authorize them** — a phone number only
  proves someone has that phone. On authorizing, Farm Friend texts them that they are set up and
  how to post their first listing. A farm set up this way still needs approving (below).
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
  person who completed onboarding is authorized to act for it, then approve. What approval gates is
  whether the **farmer may publish an update** — an unapproved farm's confirmation is refused, so it
  is a **hard prerequisite** for a farmer publishing anything, not a formality. It is *not* what
  makes a stand visible: a stand VIGA seeded is already on the map whether or not its farm is
  approved, so approving one changes nothing a customer sees today and everything about whether its
  farmer can correct it tomorrow. **A farm invited by name is already approved** by the invitation
  you sent, recorded against you; this screen is for the farms that arrived any other way, so an
  **empty queue is the normal state** rather than a sign something failed.
  The 35 farms seeded from VIGA's own listings were approved in bulk on 2026-08-05, recorded against
  the board account — VIGA had already decided they participate by putting them on the map. Approval and revocation both
  record which administrator acted and when, in `farm_approvals` and the audit trail. Revoking
  blocks the *next* publication; it does not retract what is already published.
- **Restore or rotate administrator access:** follow [RUNBOOK.md](RUNBOOK.md). Rotation adds a new
  password-verifier secret version, deploys a new web revision, proves the new password, and revokes
  every old session. There is no second account or add-administrator path.
- **Watch stock-out reports:** open `/admin/messages` and find **Stock-outs**. The queue shows customer reports per farm and
  stand, with the item named — including when the report pointed at a published entry rather than
  free text. Reports **never** change the map, answers, or ranking, and the surface offers no action
  that could: the only two are **mark reviewed** and **dismiss**, both of which record that a human
  looked and change nothing a customer sees. Only the farmer's confirmed revision through the
  ordinary inventory flow changes publication. If reports pile up for one stand, chase the farmer;
  do not edit their inventory on their behalf.
- **Resolve a flag:** open `/admin/messages`. A `FLAG` creates a review item. Read the thread, take the
  needed action, then record **resolved** or **dismissed** with a short reason — the reason is
  required, because an audit record that does not say why is not much of one. Both dispositions
  record who acted and when, in `flags` and the audit trail, and both are **final**: a flag is
  disposed of exactly once, so a second operator gets a conflict rather than silently overwriting
  the first one's decision. `FLAG` is a **Farm Friend product safety feature**, not a
  carrier-mandated keyword.
- **Answer a question about our records:** open `/admin/messages` and find **Questions about our
  records**. When VIGA's export contradicts itself
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
  id="farm-friend-admin"
  src="https://farm-friend-web-p5mfxfp5za-uw.a.run.app/admin"
  title="VIGA Farm Friend administration"
  style="width:100%;border:0;display:block"
  height="1100"
></iframe>

<script>
  (function () {
    var frame = document.getElementById("farm-friend-admin");
    var appOrigin = "https://farm-friend-web-p5mfxfp5za-uw.a.run.app";

    window.addEventListener("message", function (event) {
      if (event.origin !== appOrigin) return;
      if (event.source !== frame.contentWindow) return;
      if (!event.data || event.data.type !== "farm-friend:height") return;

      var height = Number(event.data.height);
      if (!Number.isFinite(height) || height < 300 || height > 10000) return;
      frame.style.height = Math.ceil(height) + "px";
    });
  })();
</script>

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
separate sign-ins. The shared height reporter resizes the frame after sign-in, navigation, and queue
changes so Squarespace owns the only scrollbar; `height="1100"` is the no-script fallback.

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
  (function () {
    var frame = document.getElementById("farm-friend-map");
    var appOrigin = "https://farm-friend-web-p5mfxfp5za-uw.a.run.app";

    window.addEventListener("message", function (event) {
      if (event.origin !== appOrigin) return;
      if (event.source !== frame.contentWindow) return;
      if (!event.data || event.data.type !== "farm-friend:height") return;

      var height = Number(event.data.height);
      if (!Number.isFinite(height) || height < 300 || height > 10000) return;
      frame.style.height = Math.ceil(height) + "px";
    });
  })();
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
