# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps recent entries; older entries rotate into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 71. A log too large to open
mid-session defeats its own purpose.

---

## 2026-08-10 — The admin farm card gets a hierarchy

Max asked for a design pass on the farm/stand listing, naming one symptom: the nested stand was
very hard to find. The card had four sections with identical 0.78rem uppercase grey micro-labels
and identical hairline separators, so nothing led — a stand rendered as bare bold text between two
hairlines, visually *lighter* than "Remove this farm".

The organizing decision: **a stand is the only thing on this card a customer ever sees**, so it
gets the card's one filled container (green ground, white sub-cards, its own green disclosure
caret) while everything else — farm details, access, take-down — is VIGA's bookkeeping sitting on
plain paper. That is what separates the subject from the paperwork about it, rather than four
equally-weighted panels. The destructive section moved onto its own amber ground at the card's end
so a volunteer scanning for "edit the name" never lands there by accident.

Two things were making it worse than the markup suggested. `.admin-button-row button { flex: 1 1
9rem }` stretched every button to fill the row, so a routine edit and a farm take-down rendered as
identical 1000px slabs. And the `dl` labels were uppercase at 600 weight *under* a heading at the
same size — three of them stacked read louder than the heading they belonged to, inverting the
hierarchy; they dropped to quiet sentence case.

**The verification is narrower than it looks.** `/admin/farms` is behind admin login and needed
seeded farms, so rather than infer from the file, the components were rendered against the real
served stylesheet and *measured* in Chrome — computed background, padding, caret rotation, button
flex-basis, heading size, and no horizontal overflow at 390px. The first measurement caught a real
failure: the stylesheet link had loaded a stale cached copy and none of the new rules applied at
all, which reading the CSS would never have revealed. But the route itself was never opened, and a
multi-stand farm, a removed farm, and "off the map with the farm" chips are unseen in the new
styling. A `::before` computed transform also reads as identity on a zero-size element — the
rendered caret, not the computed value, is the truth there.

`apps/web/lib/admin-ui.test.tsx` does render both `FarmList` and `StandDetails`, but it never
asserts on the "Stands" heading — so the rename to "1 stand" / "N stands" passed for want of an
assertion rather than because the change was proven safe. The suite is blind to this change class;
the Chrome measurements are the evidence here, not the green check.

A scratch `.probe/inquiry-probe.ts` in the repo root belongs to an active parallel session probing
SMS inquiry responses — left untouched, uncommitted, and deliberately not gitignored.

## 2026-08-10 — Verification email copy and code emphasis

Verification emails now use Farm Friend's requested subject and concise copy. The same message is
present as a plain-text fallback, while Gmail delivers a `multipart/alternative` email whose HTML
version renders the six-digit code at 32px, bold, and spaced for easy reading. The verification
request no longer performs a farm-name lookup solely for email copy.

Verified with 1782 unit tests, 871 local integration tests, typecheck, lint, and the web production
build. The default integration command correctly refuses to run without a disposable database URL.

## 2026-08-10 — F-100, the admin console reorganized around subjects

Max asked for four specific admin changes and a UX audit behind them. The audit — run as a
subagent at his request — found the root cause of everything he had described as "what just
happened? did that work? where did it go?": the console was organized by **database table**, one
screen per queue, so no screen owned "the farm". It appeared six ways across two pages, each with
its own vocabulary and none linking to the others. Both examples he gave were symptoms of that one
cause, not separate bugs.

Three tabs now, one subject each — Farms, Messages, Users. A farm is one directory row expanding
to everything about it. Messages merges three destinations for one kind of work, two of which
("Customer reports" / "Stock reports") were synonyms to a volunteer and one of which was reachable
only by hand-typing its URL. Users restores the people directory this branch had earlier deleted;
that deletion was wrong — `listUsersForAdministration` answers "who has texted us and can they
publish", which is a subject rather than a duplicate of farm access. The Home tab went last, on
max's call: it held nothing but counts pointing at other tabs, so every task cost two clicks and
the landing screen had no work on it. Its counts moved to the tab that owns the work; `/admin`
redirects to Farms so bookmarks survive.

**"Delete a farm" means take-down, not erasure** — max's choice, matching F-071 for stands.
`farms` is referenced `on delete restrict` by eight tables, so a hard DELETE fails for any farm
ever used, and erasing one would erase what its stands published and when. The load-bearing design
decision is that a farm take-down does **not** write each stand's own `retired_at`: readers treat a
stand under a retired farm as off the map, but the stand's column stays untouched, so restoring the
farm returns exactly the stands it was holding down while a stand retired on its own stays retired.
Collapsing the two would make restore guess. Both directions are tested, and both were sabotaged to
prove the tests can fail.

Migration `0036` hit three known traps in one pass, which is worth recording together: the enum
had to be **recreated** rather than extended because `ALTER TYPE … ADD VALUE` cannot run inside
drizzle's transaction; `generate` silently dropped the CHECK, which was hand-appended and then
proven to genuinely refuse; and the journal `when` was born older than 0035's future-dated stamp,
so it would have skipped itself silently. Its other half fixes the screenshot max sent: address
questions were filed as `unparsed_availability`, so the queue rendered "Availability text could not
be understood" directly above quoted text that was plainly an address — the label contradicted the
evidence beneath it.

Two defects were invisible to the suites and found only in the browser, both worth remembering as a
class: jsdom reports every element as zero-sized, and each component's tests render it alone. The
farm card's sections were landing in the shared `auto-fit` stand grid at 171px columns, and a
take-down left nested stands rendering "Visible to customers" until reload because `StandDetails`
snapshots its prop into state. Both were diagnosed by **measuring the running DOM** rather than
reading source that already looked correct.

A long detour on local setup produced `scripts/dev-setup.sh`. Next expands `$NAME` inside .env
values, and an Argon2id verifier is a run of `$`-delimited segments, so `ADMIN_PASSWORD_HASH` in
`apps/web/.env.local` reaches the server *shorter than it was written* and every sign-in refuses
with the same generic message a wrong password gets — while the verifier keeps verifying correctly
in any standalone script, because that script reads the file directly. Reproduced in both
directions before documenting it.

Also from the audit: `post()` was clearing a minted invite, destroying the only copy of an
unrecoverable link on any later unrelated click; success and error messages rendered once above a
list rather than on the row that caused them; Farm Bucks and stand retirement saved with no
confirmation at all. The lower-ranked findings are filed as F-101 and B-048 rather than carried in
anyone's head.

Verified with 1782 unit, 871 integration, typecheck, lint, the production build, and evals 44/44
(`evals:live` not owed — no model seam, prompt, or projection was touched). Migration `0036` is
applied and verified by schema effect **locally only**; production has not run it.

Merged as `1ead9a3` (PR #97) but **deliberately not deployed**: max chose to wrap a parallel session
first and ship both together after his phone-width pass, so the next deploy carries more than this
tranche. The branch kept its `f-099-…` name after F-099 was taken by the VIGA Bucks work mid-flight;
the PM item is **F-100**.

## 2026-08-09 — B-044 follow-up, structured offerings removed from descriptive prose

The first repair restored reviewed usual offerings but left the same foods in some farms'
Additional information. The description parser now receives the reviewed usually-sells set and
removes only leading offering-only sentences, preserving independent prose after them. Real-corpus
guards cover Tian Tian, Ostara, and Sweet Alyssum rather than treating one screenshot as the rule.

Fourteen production descriptions were rewritten and verified, five becoming empty; the idempotence
run now reports all 25 descriptions clean. Tian Tian exposes nine usual items with only its organic-
practices note, while 3 Brothers exposes eggs with no current-stock claim or duplicate prose. The
rewrite backup is
`~/farm-friend-backups/farm-descriptions-backup-2026-08-09T19-34-25-398Z.json`.

PR #94 merged as `af2cc0d` and deployed to web `00054-wfk` and worker `00049-w4v`, both on digest
`sha256:247393a9f769e76bd13e91195eb332dbda0d8e815b8ea4b84dfc82d213b36840`. Verified with 1778
unit and 860 integration tests, typecheck, lint, production build, the real corpus, production data,
all 60 plan assertions, secret freshness, health, served bytes, and the live public API.

## 2026-08-09 — B-045, verification email restored over Gmail HTTPS

Cloud Run could no longer open the SMTP connection, while HTTPS egress and the VIGA board mailbox
continued to work. B-045 replaces only the delivery adapter: Gmail's HTTPS API now sends from the
board mailbox with a refresh grant restricted to `gmail.send`. The client secret and refresh token
live in Secret Manager; the delivery resolver refuses any configuration that would mount Gmail and
SMTP credentials together.

The approved production release is web `farm-friend-web-00053-jcr` and worker
`farm-friend-worker-00048-4st`, digest
`sha256:cb9a6fa262ed7edf414486f65261f5e4e6c5a6abe220de664903f87137e630a8`. A real production
verification request recorded B-047's `farmer_verification_send` outcome `accepted`, then arrived
in the recipient's inbox. Max's controlled address was added to Sylvan Garden's roster without
removing its existing address.

Verified with 1777 unit tests, 860 integration tests against an empty local Postgres schema,
typecheck, lint, the web production build, Terraform plan-assertion tests, Cloud Run health, and
provider acceptance plus inbox receipt. No DNS change, third-party email account, or paid service
was used.

## 2026-08-09 — B-044, reviewed offerings restored as part of the stand corpus

Two cards exposed one production-data defect. Tian Tian's prose named bok choy and a choy but its
structured usual list was empty; 3 Brothers' prose said `OPEN has: eggs` while it had no structured
item. The parser was not selectively losing those foods: the 2026-08-08 rebuild had restored stands
without the separately reviewed offering artifact, leaving every reviewed usual offering absent.

The reviewed artifact contained 212 approved items across 34 source entries, with no unknown or
unresolved stands against the real exports. Those 212 rows were published, 3 Brothers' duplicate egg
prose was removed, and the public API now returns Tian Tian's full nine-item usual list and 3
Brothers' structured eggs. The verified backup for the one prose edit is
`~/farm-friend-backups/farm-descriptions-backup-2026-08-09T18-42-59-230Z.json`.

The lasting fix treats stands and reviewed offerings as one restore unit. `db:seed` now requires the
approved artifact, validates every referenced stand before writing, and commits both halves in one
transaction. A failure in either half leaves neither behind. The standalone offering path refuses
farmer-owned listings, preserving the rule that bulk VIGA data cannot overwrite farmer authority.
`OPEN has:` is now recognized as an offering-list label and removed from Additional information only
when its body is a plain list.

Verified with 1770 unit tests, the full integration suite, typecheck, lint, the web production build,
and a dry run against the real 35-stand exports. Deliberate breakage proved the regression catches a
missing `OPEN has:` rule, omitted offering writes, and a split transaction that commits stands before
an offering failure. Production was checked by database effect, a zero-insert idempotence run, and
the live public API—not by script success output.

## 2026-08-09 — F-098, two silent refusals, and an SMTP path that stopped working

Started as a UX pass on the returning farmer's tab and ended in a production incident. The two are
unrelated except in sequence, and the incident is the part worth reading.

**The "Details & settings" tab had three buttons that committed something** — the listing's "Save",
the onboarding wizard's "Submit", and "Save settings". F-097 unified the buttons *inside* the
settings panel and left the composition alone, so the wizard's Submit survived beside the panel that
replaced it. The Submit was never gated on the credential: `steps === null` is true for a stand
link, which is what put onboarding's word on a returning farmer's screen. It is now gated on the
door, and the settings panel hands its save up through context so one press commits both. The
writers stay separate — merging them would put the participant write, with its own audit event and
public-text refusal, behind the listing's transaction.

**The render-prop version of that wiring passed every test and 500'd on every real request.** A
server component cannot pass a function to a client one, and jsdom has no such boundary, so the
suite was green while production was broken. Caught only by loading the deployed page. The fix is
context; the lesson is that the composition seam between server and client components is invisible
to the component suites and has to be measured against the running app.

**The address button no longer says "Save".** While an onboarding "Submit" was also on screen,
"Save" was the honest word for it; with a single "Save changes" committing the tab, a second button
saying Save reads as a competing commit. It says "Find on map", which is what it does.

**The grandfathered farmer could not finish onboarding, and had not been able to since Friday.**
`JOIN <token>` was removed 2026-08-07 and farm identity moved to a phone stated on the onboarding
form, matched by a bare `START` against `pending_phone_hash`. That column lives on
`farmer_invitations` — a row the honour-system door could not write, because
`created_by_administrator_id` was NOT NULL with an FK to `administrators` and there is no
administrator in that loop. The next day the form became a wizard and its fourth step, holding only
invitation-gated fields, rendered as a heading and two nav buttons. Migration `0035` makes the
issuer optional with a CHECK that a self-issued claim names its farm, and max approved making
`farm_approvals.administrator_id` nullable too: a farm can now publish with nobody having approved
it, and VIGA's revoke is the backstop. Verified end to end from an empty schema — claim, `START`,
authorization, the same welcome an invited farmer gets. A doc line in `grandfathered-listing.ts` had
been citing `JOIN <token>` as the live path for two days and was hiding this.

**B-046 — an unused code locked the farm out for thirty minutes.**
`farm_email_verifications_one_live_per_farm` is partial on `consumed_at IS NULL`, so a code the
farmer never used holds the farm's only slot; expiry does not release it. Every retry hit `on
conflict do nothing`, returned `already_live`, and the route answered its uniform "sent" regardless.
Issuance now retires the farm's own earlier code in the same transaction. The invariant is unchanged
— still exactly one live code — but the farmer's newest intent wins over her abandoned one.
`issued_at < now` is what separates a retry from a race: eight simultaneous claimants share one
instant, so none retires another's code and exactly one wins on the index. Strict `<`, never `<=`. A
farm-level `for update` lock was written first and **deleted after sabotage left all 25 tests
green** — it was a line claiming a protection it did not provide.

**B-047 — the system could not see its own email failures.** `createEmailSender` takes an optional
`logger` and no caller ever passed one, so every outcome, accepted and failed alike, was discarded.
Three separate investigations of one incident had to reason from response timing because no evidence
existed. The route now logs outcome, transport error code, farm and idempotency key as a JSON line
on stdout. The farmer's address is deliberately absent and a test greps the log to prove it. The
uniform *response* is unchanged — it is what stops the endpoint revealing which addresses are on
file.

**That logging is what found the real problem.** Production cannot open an SMTP connection at all:
`ECONNECTION` in ~0.26s, an instant refusal rather than a timeout. Port 465 was deployed and tested
live and failed identically; the Workspace relay's IP restriction is off and authentication is on;
the same credentials work from max's machine on both ports; the same revision reaches the Geocoding
API over HTTPS in 0.37s; and no email-related file, Dockerfile or lockfile changed between Friday's
commit and now. It worked on Friday for a real farmer. The remaining explanation is Google blocking
outbound SMTP from this service, and the recommendation is an HTTPS email API. Filed as B-045,
carried in CURRENT_STATE, and it blocks the grandfathered door.

**Two false conclusions worth recording, because both looked solid.** First: "zero verification rows
exist, so this never worked in production" — the 2026-08-07 22:43 wipe destroyed Friday's rows, and
absence of data the wipe explains is not evidence. Second: "I burned her rate limit" — she was at
0 of 3; what actually refused her was the live-code block, which the timestamps showed once checked
rather than recalled. Diagnostic requests against a real farm are not free: they consume the farm's
hourly budget and hold its one live slot.

**The commit messages carry the wrong bug IDs.** `2431c07` says "B-025" and `ca212df` says "B-026";
both were written before checking the backlog, where those IDs belong to closed bugs from 2026-07-29
and 2026-08-01. The real items are **B-046** (the lockout) and **B-047** (the missing send logging),
with the SMTP outage filed as **B-045**. The commits are pushed and are not being rewritten — this
line is the mapping.

Verified: 1766 unit, 84 integration across the four suites touched, typecheck, lint, three
production Cloud Builds. Sabotaged the Submit gate, the address-button label, the details-tab
wiring, the supersede retire, the `issued_at` comparison and the farm lock; all failed as they
should except the lock, which was deleted for it.

## 2026-08-09 — F-097: the link a farmer can read, and one press instead of two

Ten adjustments max asked for overnight after reading the onboarding thread on a real handset.
Most were copy and layout; two changed contracts, and those are the ones worth the paragraphs.

**The link was four lines long in the message thread.** The stand token was 32 random bytes
rendered as 64 hex characters, which wrapped four times beside the production host and read as
machine output rather than as something to tap. It is now 16 bytes of base64url — 22 characters,
128 bits, the same strength with a different encoding. The temptation to name and avoid was
shortening the *randomness* instead of the *encoding*, so the suite asserts the decoded byte count
rather than the character count, and asserts 500 distinct draws so a constant cannot pass. The
35 links already sitting in farmers' threads are 64 hex; `isFarmerLinkToken` spans both ranges,
because recognising only the new shape would have dead-linked all of them behind the uniform "this
link is not active" refusal — which deliberately cannot be told from a revocation, so nobody could
have discovered why. Four boundary validators had their own copy of the hex regex; they now share
core's predicate. The setup message also lost three lines of scaffolding around the URL, and went
from three segments to two. The tightened bound was sabotaged by reverting the token to hex.

**The web editor publishes in one press, and `docs/ARCHITECTURE.md` needed rewording rather than
contradicting.** That doc says the web path gets no bypass of the confirmation gate, and it still
does not: `publishStructuredFromLink` composes the existing propose and confirm calls, so
`confirmInventoryPublication` still re-reads live authority, VIGA approval and retirement under its
own locks and still consumes the proposal exactly once. What was removed is a SCREEN. The exact
preview earns its place on SMS, where code interpreted prose and had to show its reading before
acting; on the web the farmer is reading back the rows they just typed. `propose`, `confirm` and
`decline` were deleted from the route rather than left beside `publish`, since a second door onto
one writer is how the two come to disagree.

Max also asked that a web update stop texting a confirmation. The obstacle is
`activation_coherent`, which refuses a live confirmation window with no outbox message behind it —
the constraint exists so a proposal cannot be committable without a prompt the farmer was shown.
Rather than weaken it, the row is now written `state = 'suppressed'` with `completed_at` set: a
state `outbox_work_coherent_state` already permits, and the same one the dispatch claim writes when
consent forbids a send. The record still exists for the audit trail; it simply never becomes work.

**The reminder cadence is now asked at onboarding**, below the SMS agreement it follows from —
every farmer was silently seeded `weekly` and learned their schedule when a text arrived. It cannot
be written when the farmer chooses it, because `inventory_prompt_preferences` carries a composite
foreign key to an authorization that does not exist until they text `START`. So it waits on the
invitation in a new nullable column and is applied inside the redemption transaction, exactly as
`pending_stock` does. NULL means "never asked" rather than "chose weekly", so only the first may be
silently moved if the default ever changes.

**Migration 0034 would have been silently skipped.** `0033` carries a journal timestamp dated
2026-08-30, three weeks ahead of the wall clock, so the freshly generated 0034 was born *older*
than the last applied migration — the exact failure `CURRENT_STATE` warns about, and it was
`migration-ordering.test.ts` rather than any judgement that caught it. 0034 is hand-stamped one
second after 0033. **Every migration generated before 2026-08-30 inherits this.** The column was
then verified against `information_schema`, not against "migrations applied successfully".

The settings panel went from three save buttons — one of them labelled "Submit", onboarding's word
— to one that writes only what changed, because sending all three writers on every press would
file a participant audit event claiming the seller list was edited whenever a farmer touched their
reminder schedule. Writing that test found a real defect in the one-press stock editor too: the
success banner survived a subsequent failed save, so a farmer would read "Your stand is updated."
directly above the error saying it was not. The old two-step flow cleared it when the proposal
opened; collapsing to one press removed that moment.

The map card's date moved below the items it covers and reads "Last updated X ago", counting in
weeks past seven days and giving up at four — "45 days ago" is a number nobody converts. That is a
third phrasing rather than a reformatting of the SMS one, because a browsed card and a text reply
answer different questions; everything under a week still delegates to the shared arithmetic so the
two channels cannot drift.

Several tests had pinned exact copy ("Confirmed X ago", "Save default stand", a literal
`JSON.stringify({ token, salesLocationId })`). Those were re-anchored to the properties they were
protecting — that the credential travels in the body at all, that pausing is not opting out —
rather than re-pinned to the new wording.

### The welcome text, rewritten — and the keyword lists split in two

Max read the thread on a handset again and rewrote the setup message himself. The shape that
mattered: it now SHOWS how to phrase an update rather than describing it. "Just text us what you
have out" states the interface without demonstrating it, and a farmer's first message is the one
most likely to be a stilted list — because they are guessing at a format that does not exist. The
example carries the real shape ("we're out of eggs, replenished kale and added radishes"): ordinary
phrasing, several operations at once, add and remove and restock mixed together.

**`STAND` is now named only for a farmer who has a second stand.** It picks between stands, so for
everyone else it teaches a word for a situation they are not in. The count comes from the stands
query that was already running in `queueFarmerAuthorizedNotification`; its `limit 1` came off. The
parameter defaults to naming it, because a caller that does not know the count is not evidence of
one stand, and the failure directions are asymmetric — a two-stand farmer never taught the word has
no other way to learn it, while a one-stand farmer who reads it loses a few characters.

**`SETTINGS` left the taught set entirely**, on max's reasoning: a farmer has exactly one edit page
and `LINK` already opens it, since the reminder cadence is a tab on that same page. It stays parsed
and working.

That last one needed somewhere to put the decision, and the reason is worth recording. The keyword
tripwire asserts that every keyword the parser honours appears in `FARMER_TAUGHT_KEYWORDS` — so
dropping a word simply fails the test, and the cheapest way to make it pass again is to delete the
wrong side of it. `FARMER_UNTAUGHT_KEYWORDS` is the second list: the tripwire now requires every
parsed keyword to sit in one or the other, so **a keyword nobody teaches and a keyword somebody
forgot cannot look the same.** It carries the expiry condition too — `SETTINGS` moves back when
account settings become a surface genuinely separate from the stand's edit page.

The message went to three segments, up from the two this session had just won. That was spent
deliberately: the example is the most valuable line in the text, so the bound moved to the honest
number rather than the copy being trimmed to fit a target. Two integration tests were pinned to the
old wording through a hardcoded `["LINK", "STAND", "SETTINGS"]` list; they now assert the real rule
including the *absence* of the latter two, so re-adding either is a decision rather than a drift.

Also considered and dropped: routing the link through a Squarespace URL mapping. It cannot work —
Squarespace redirects are 301s, so the Cloud Run host lands in the address bar anyway, the token
transits their logs, and a 301 caches hard enough to strand farmers if the target ever moves. The
measurement that settled it: iOS breaks URLs after `/` **and** after `-`, so the ragged whitespace
in the thread came from the hyphens in `farm-friend-web-p5mfxfp5za-uw.a.run.app`, not from the
token. Getting to one line needs a genuinely short domain, which is a purchase and max's call.

Final verification: 1743 unit, 851 integration, typecheck, lint. The conditional-`STAND` branch was
sabotaged (forcing it always-on) and the test caught it. The favicon was checked by effect against
the running standalone server rather than against the build's route listing. Migration 0034 was
checked against `information_schema` rather than its success message. Not verified: appearance at
phone width, which is max's own pass.

## 2026-08-08 — F-076: one returning-farmer stock editor, literally shared with onboarding

The returning-farmer status tab now emits additions, removals and price changes as a direct
structured edit. The old chip-only path and free-text/SMS proxy are gone from the web; SMS retains
its model interpretation seam. Web edits still stop at the existing exact code-rendered preview,
then require explicit confirmation before publication. “Usually sells” remains standing listing
state; “in stock” remains a dated claim.

The first pass reused only the item-row shell, leaving the status tab with its own container, add
controls, copy and page-scoped styling. Max caught the mismatch twice. The final design has one
`StockInventoryEditor` rendering the fieldset, price switch, helper copy, add row, item cards, stock
switches, remove controls and structured price fields for both onboarding and later updates. The
stand's `Update` button is its only extra child; contextual labels preserve the standing-versus-
dated distinction. A source guard requires both surfaces to call this component and fails if either
recreates the pricing markup; deleting the returning-farmer call made the guard fail as intended.

Phone-width Chrome exercised `per`/`for`, count visibility, the unit menu, price hiding, removal,
exact preview, confirmation and publication against an isolated local Postgres fixture. It then
measured both mounted editors while visible and matched computed styles for the add row, cards,
amount, basis, unit and remove controls. Final verification passed 1723 unit and 851 integration
tests, typecheck, lint and the production build.

F-076 merged to main through its review branch and remains undeployed by Max's explicit wrap
decision. Production still serves the digest recorded in `CURRENT_STATE.md`; the next deployment
must begin with a fresh live audit rather than treating that snapshot as evidence.

## 2026-08-08 — Contact-only onboarding fix, and a stale-state deployment regression

The live four-step onboarding form accepted a resolved address and pin for Sylvan Garden, then the
final submit returned `incomplete_location` when the farmer selected “No — I deliver.” The form and
the migrated database already implemented F-088: any farm may be fully placed, while visitability
only decides whether customers are invited to drive there. `saveOnboardingListing` was the lone old
copy of the rule and still rejected every location on `contact_only`.

The failing integration case now sends the form's exact shape and requires it to persist as a
placed contact-only farm. The writer mirrors the database constraint in one expression: a complete
address/latitude/longitude is valid for either visitability; a wholly absent location is valid only
for contact-only; every partial shape returns the actionable refusal. Restoring the old rejection
made that exact test fail. Main passed 1720 unit and 849 integration tests, typecheck and lint; the
52-test onboarding-listing suite also passed independently against fresh Postgres.

The first deployment was wrong. `CURRENT_STATE.md` claimed production ran `6ab087e` with only 30
migrations, so a hotfix image was reconstructed from that commit. Production had actually already
advanced to image `e1491d…`, built from pushed main `40466fd`, with migrations `0000`–`0033` applied.
The reconstructed image therefore reverted the four-step wizard and other current UI. The plan also
moved `ROTATION_APPLIED_AT` backward; although inert, that unrelated delta was a warning that should
have stopped the apply. Passing deployment assertions did not make the intended delta correct.

Max caught the regression. A direct audit then established ground truth before any second change:
34 Neon ledger rows and the exact new columns/constraints; recent Cloud Run revision digests and
their Cloud Build `SHORT_SHA`; pushed main at `40466fd`; and B-024's real row already safe as
`contact_only` with no address or coordinates. No migration or data write was run in this session.

Production was corrected with an image-only plan from current main plus fix `c581e1f`: 0 add, 2
service updates, 0 destroy, 55/55 assertions. Web `00047` and worker `00044` serve digest
`d5379a52198d29809517175f266e48a8f3749a51ba85cf6dcca6238c7e20623d`; both are ready and newer
than every secret version, web traffic is 100%, the public endpoint and served vCard pass, and
neither new revision has an error-level log. The durable deploy rule is now explicit in RUNBOOK:
measure live revision/schema/source first, and stop on any plan delta outside the intended change.

## 2026-08-08 — F-092: prices become structured, and two silent traps in the migration path

Started as UI polish on the inventory builder and ended with a schema change, because measuring the
data answered a question that had been decided in the abstract two weeks earlier.

**The corpus overruled the design doc.** `0030` made `stand_items.price_text` free text and argued
it well: a roadside sign says "$6/dozen" or "2 for $5", not a decimal with a currency code, and a
numeric column would force a shape the sign does not have. max asked for number + unit anyway, so
the free-text argument was worth checking rather than repeating. The VIGA export — 285 stands, every
description VIGA has ever collected — contains **exactly one dollar sign**, and it belongs to a
delivery threshold ("orders over $50"), not to an item. The local database agreed: 37 stand items,
zero priced. There was no vocabulary to honour and nothing to migrate, so the free-text case was
defending a corpus that turned out to be empty. max chose the structured shape on that evidence, and
the feature became greenfield rather than a migration.

**Four columns, one mechanism.** `amount / quantity / unit / basis`, where `basis` is `per` or
`for`: "$6 / dozen" and "3 lb for $5" are the same four facts with a different joining word, and
`per` is the bundle with an implied count of one. Storing it as one shape keeps the renderer a
single function rather than a branch per sentence, and means a third kind of price would be a third
`basis` value rather than a fifth column. `numeric`, never `double precision` — money in binary
floating point is how `5.10` becomes `5.0999999999999996`. `renderStandItemPrice` in core is the
only place parts become words; the map, admin, SMS and the form's own confirmation screen all call
it, because two renderers is how two stands come to print one fact differently.

Zero is **free** and renders as the word; NULL across all four is "not stated". `unit` is free text
(a stand may sell by the half-flat or the cord) with a menu of eight suggestions plus "other" — the
list is a shortcut, never a vocabulary business code may branch on.

**`prices_public` is opt-in, opposite to `address_public`.** An address on a public listing form is
information a farmer already supplied for publication; a price is a thing this system never asked
for, and no existing stand has consented to showing one. max's call: hidden means hidden — the
prices stay stored when the switch is off, so turning it back on restores the work, but no customer
surface may render one. The gate is **in the SQL**, so a withheld price never leaves the database
rather than being filtered by a renderer a future reader could bypass.

**The privacy gate had no test, and a sabotage is what found that.** Deleting the `prices_public`
branch from the public query left all 843 integration tests green — the load-bearing guarantee of
the whole feature was uncovered. Four tests now cover it, including the pair that makes the
withholding assertion mean something: identical row, identical query, one boolean different. Without
that second test, a reader that returned no price at all would pass the first perfectly.

**A live column was one `generate` away from being dropped.** `farmer_invitations.pending_stock` was
added by a hand-written `0031` and never mirrored into `schema.ts`. `drizzle-kit generate` diffs the
database against that file, so this session's unrelated migration proposed
`DROP COLUMN pending_stock` — F-090's held stock, live in `farmer.ts`. Caught by reading the
generated SQL line by line. The lesson is in RUNBOOK now: a hand-written migration is only half the
change, and an unexpected `DROP` is a schema-file omission rather than a drizzle bug.

**"migrations applied" lied twice.** `npm run db:migrate:local` printed success while doing nothing
— first because the hand-written file had no journal entry, then because journal `when` values in
this repo are future-dated, so a freshly generated migration sorted *earlier* than the newest applied
record and was treated as already run. Both caught only by querying `information_schema` afterward.
Also documented in RUNBOOK; the production section already warned about the timestamp case, and it
bites locally the same way.

**The UI split rather than shrank.** The row is two lines now — name and in-stock above, the price
sentence below — because four price controls do not fit beside a name and a toggle at phone width.
One "Add prices" switch governs the whole section rather than one per row: a farmer either prices
their goods or does not, and pricing is the exception at an honor-system stand, so the default row
stays the compact single line. The quantity box appears only with `for`.

**max found two defects in the built form, both filed rather than fixed here.** B-040: the unit
control is chosen by asking whether the row's value is in the suggestion list, and "other" stores a
sentinel space — so once the free-text box opens, nothing can put the menu back. Inferring a control
from its value was the mistake; the row should carry which one the farmer picked. B-041 is a
modelling error in this tranche's own design: a bundle does not need a unit. "$5 for 3" is a complete
price for corn — the unit is the cob, and naming it would be worse than silence — but the CHECK, both
boundary parsers and the renderer all require four parts, so the form drops such a price silently.
The two bases are not symmetric (`per` genuinely needs a unit; `for` does not), and that asymmetry
now has to be stated once rather than four times.

Earlier in the same session: the address Save button took the submit button's style with a real
disabled state, and the inventory builder became one self-contained section with single-line rows.
A specificity bug there is worth remembering — `.farmer-listing input[type="text"]` is (0,2,1) and
beat a two-class rule no matter where it sat in the file, rendering the price box at full row width
and squeezing the item name to zero. Four wrong theories (stale build, uncompiled CSS, wrong
component, cached payload) were each built on a failed grep; one `getComputedStyle` call found it.
The constitution now carries that: when what renders contradicts source that reads correctly, stop
reading source and measure the running thing.

---

## 2026-08-08 — F-090: one farmer surface, priced items, and a third provenance

max asked for four things on the farmer onboarding form: fold in the stand details and preferences,
also ask what is in the stand right now, prefill what we already hold, and let farmers price their
usual items — "slightly more like an e-commerce setup" while still feeling local rather than
commercial. Two of those turned out to be bigger than they looked.

**Two presentations, one component.** max chose a wizard for onboarding and tabs for editing:
setting up happens once and is linear; coming back is an errand and should be one tap from arrival.
The step is a *view* over one always-mounted form, never a fork — `ListingStep` is shared by all
three doors, and forking it is how two doors start publishing different shapes onto the same map.
Every field stays in the document behind a `hidden` fieldset, because unmounting would drop answers
on Back and the whole-listing writer would then erase by omission whatever the farmer could not see.
Sabotaging that (unmount instead of hide) failed two tests, one written for exactly it.

The two links below the status form are gone; their pages became the second tab. Both old routes
still work — farmers may have bookmarked one and our own SMS names them.

**Today's stock waits for START, and max reversed his own first call to get there.** He initially
chose to publish it at submit. Shown that this puts a *dated public claim* behind a phone nobody has
proved — anyone holding an invitation link could put dated stock on the map under a farm's name, and
the farm's own confirmation timestamp would then say VIGA vouched for it — he chose to hold it. The
text rides on the invitation and publishes inside the same transaction that mints the authorization
and the approval, so the claim and the proof of who stands behind it commit together or not at all.

**`source = 'web'` is a third provenance, and the schema is what forced the question.** An
`sms`-sourced revision must name a proposal carrying a consumed token and a consumption event id —
the record of an inbound confirmation. This farmer never sent one. `viga` would credit VIGA with a
farmer's own claim; `sms` would require inventing the exact evidence F-063's constraint exists to
demand honestly. So `web` names an authorization and an approval, both real, and **no proposal** —
and the CHECK asserts that absence rather than leaving it unmentioned. This was max's call, asked
mid-build once the constraint made the fork explicit.

The enum is **recreated, not extended**. 0001 already recorded why: Postgres cannot use a newly
added enum value in the transaction that added it, and the migrator runs every pending migration in
one. `ALTER TYPE … ADD VALUE` applies cleanly and then fails on first use, on a fresh database.

**Prefill was a defect, not a convenience.** The onboarding page passed no `defaults`, on the
reasoning that an invitation *creates* a listing rather than editing one — true of the record, and
wrong about the data. Measured against the real corpus rather than assumed: 47 of 48 stands carry an
address, 48 carry hours, 37 a season, 36 items are standing claims. Submitting the blank form those
farmers were shown would have overwritten VIGA's seeded listing with nothing. B-037's shape, on the
door where it costs most.

The prefill reader resolves a farm's stand with the **same query the writer uses**, deliberately
including its lack of a `retired_at` filter. Adding one looked obviously right and is silent data
loss: for a farm whose oldest stand is retired, the form would prefill from stand B while the save
replaced stand A. Sabotaged; the test named it — *expected 'Live Stand' to be 'Retired Stand'*.

**Prices are free text and stay that way.** `inventory_entries.price_text` has existed since launch;
this is that column one table over, so there is one spelling of "price" in the system. A roadside
sign says "$6/dozen" or "2 for $5", not a decimal with a currency code — and a numeric column would
invite the subtotals and cheapest-stand sorting that turn an honor-system stand into a storefront.
NULL is *not stated*, never "free", with a not-blank CHECK so `""` cannot render as the same thing.

The item shape became `{ name, priceText }` end to end rather than a price array beside a name
array. One pair means a price cannot drift onto the wrong item, and it made the compiler name every
door that had to change. Three consumers took it explicitly rather than by coercion — the
flower-only regex, the confirmed-item dedupe, and the search haystack all now say `.itemName`; left
implicit, each would have matched `"[object Object]"` and failed no test.

**What running the app caught that no suite could.** Both F-090 pages 500'd: the local dev database
had never had 0030/0031 applied, and every test builds its own database, so all 1652 stayed green
over a broken app. The served stylesheet was then checked for the new class names by fetching its
bytes rather than reading the source — the markup had landed with a dozen classes nothing styled.

**Scope deliberately left out.** Seller names stay F-084's — `saveSalesLocationParticipants` needs a
verified phone hash and onboarding has none, and F-084's own analysis allows "stays
post-authorization" as a possible right answer. Default SMS stand stays out of onboarding; it is
meaningless with one stand.

**Two small follow-ups max asked for mid-session.** The admin signed-out screen now renders the
sign-in fields instead of a link to them — it reuses the same `LoginForm` the login page does, not a
copy, so the fixed email, the native no-JS post, and the refusal copy stay in one place; two CSS
rules that lost their markup were deleted. And the days-open field gained a select-all, whose
`checked` is *derived* from the days rather than held separately, so ticking all seven individually
fills it in too and no second piece of state can disagree with the boxes.

**Verified.** 1652 unit, 840 integration against local Postgres, typecheck, lint. Migrations
verified by effect on a fresh database — enum reads `sms,web,viga`, both columns present, all four
constraints present. Seven sabotages, each caught by the test that owns the property. No
`packages/ai` file changed and prices reach no model seam (the SMS answer renders location names and
addresses, never item text), so no evals were owed.

**Not verified: appearance.** The Chrome extension was not connected. The four-step wizard, the
two-tab page, and the wrapping priced item rows are the most layout-dependent surfaces in the
project and none has been seen at phone width.

---

## 2026-08-08 — the launch ingest, a two-day silent outage, and a database rebuilt from scratch

Started from one screenshot — Provo Farms showing "Hours not listed" beside a map entry that reads
"Open: All year, All days" — and ended with production's data rebuilt from the CSVs twice, a
production outage found and fixed, and four defects that only appeared when code met real data.

**The screenshot was not a new bug.** F-061 had already fixed the code; F-064's data run had never
happened, so production was new code over old rows. Worth stating because the instinct was to go
looking for a rendering fault, and the honest answer was "the parser works, it has never been run".

**Two defects in the weekly ingest, both found by rehearsing rather than by reading.**
`parseWeeklyStatus` promises "the latest submission per farm" and keyed that race on the raw
`Farm Name` string — a spelling, not a farm.

- One farmer submitted as `Fruits Des Vignes Farm` in April and `Fruits des Vignes Farm` in July.
  Two farms, 17 submissions for 16 farms. The database absorbed it by *ordering luck*: both names
  resolve to the same stand, so the April row lost the `skippedAsOlder` guard and was counted as a
  routine skip.
- The second published a **wrong fact**. Green Ears filed stock on 30 March as "Maggie's Farm",
  renamed, and closed on 6 July under the new name. Two keys, so the closure and the stock row never
  raced: the closure was correctly reported-not-written, and the four-month-old March stock
  published as current. A farmer who shut their stand for the season appeared open and stocked.

The writer already resolved renames, but it could not repair this — by the time it sees the rows the
timeline is decided, and a closure is deliberately never written, so nothing is there to supersede
the stale row. The rename map had to move *into* the parser.

**`sales_location_participants` got its writer.** Third table with a schema, live readers, and
nothing ever writing it — the card's "Also selling here" section had rendered nothing since F-050.
It could not be written because `confirmed_by_authorization_id` was `NOT NULL`, and a spreadsheet
has no handset. That is the problem F-063 already settled for `inventory_revisions`, so migration
`0029` takes the same shape rather than inventing a second one: a `source` column with a
biconditional CHECK. Fabricating an authorization was rejected for F-063's reason — at inception it
would make the entire founding corpus indistinguishable from farmer-confirmed data.

**GL-015's insert-only limit, found the only way it could be.** The first production ingest reported
`skipped 35` and wrote nothing: every stand already existed, and the loader could only create or
skip. Links, hosts and most payment methods stayed empty. **The rehearsal had missed it by running
from an empty schema, where every stand is an insert** — same code, same CSVs, opposite outcome.
That is the lesson worth keeping: rehearse against a restored production snapshot, not a clean one.
Backfill now fills empty side tables and refuses any farm whose farmer holds a live authorization.

**The production outage, which nothing was reporting.** max reported address lookup broken in
production but working locally. The mount was fine and the secret had a version — the secret
*contained the literal five bytes* `<key>`, pasted from the RUNBOOK's own step 2 without
substitution. Google answered `REQUEST_DENIED` for every address, and `lookupIslandAddress`
collapsed that into `no_result` — the same answer a genuinely unknown address gets. So every farmer
was told their valid address could not be found, the route returned HTTP 200 throughout, and since
F-077 made the typed address the only source of a coordinate, **no visitable stand could be created
for two days with no signal anywhere**. Fixed in both places: the key, and the code —
`REQUEST_DENIED`/`INVALID_REQUEST` now return `not_configured`, whose existing copy tells the farmer
to contact VIGA instead of blaming their address. `OVER_QUERY_LIMIT` deliberately stays `no_result`:
a throttled key is configured correctly, and calling it misconfigured sends an operator to rotate a
healthy credential.

**"Gold & Silver" was ours, not the ingest's.** max spotted a payment method on Provo's card that is
in none of the CSVs. Traced to the pre-ingest snapshot: it was one of the 7 payment rows that
already existed, from earlier hand-testing on a real farm's listing. The backfill correctly left it
alone — it adds, never removes.

**Then max chose to nuke and rebuild.** Schema dropped, 30 migrations reapplied, stands re-seeded,
confirmations re-published. Two restore steps the seeders do **not** cover surfaced by hitting them:
the fixed administrator, and the farm email roster (which must reuse the stored `EMAIL_HASH_SALT` —
verified behaviourally by hashing a known email through the shipped function and resolving the row
back to its farm). max chose to wipe the 3 real consent records too; those numbers must text `START`
again, since we cannot text first.

**Map cleanup, and one accessibility rule narrowed deliberately.** The staleness banner, the "Needs
confirmation" label, and the amber border all came out — each was the same fact told again. The rule
in `globals.css` says staleness is never signalled by colour alone; the dated "Confirmed 39 days
ago" line is words and survives, so the rule holds, but it is now the *whole* of the signal. Its
test was kept and widened rather than dropped, because a guarantee with no test is one that leaves
silently — which is exactly what that test's own comment says.

**B-039, the item the screenshot started.** 13 of 35 stands read "Hours not listed" while stating
their hours, because the answers are *day* patterns and `open_hours_kind` models times of day.
`open_days` could hold them, had two live readers, and had never been written. `parseOpenDays` reads
the day axis from the same answer `parseOpenHours` reads the time axis from. Measured against all 32
real answers: 24 of 35 stands now carry days, and every refusal is right — 5 blanks, "See below", 4
time-only answers that must not become a seven-day claim, and Sweet Alyssum's `Spring: Fri- Sun,
Summer: everyday`, which one day set cannot express without being wrong half the year. `openNow`
still answers `unknown` for a days-but-no-times stand, correctly; the fix is in what the card says.

**A correction I made mid-session.** I flagged a "participants rendering gap" from a bad inference —
searched the collapsed page for the wrong key name. Checked properly: the payload carries all 6
non-empty host lists, the section renders on card expansion by design, and existing tests already
covered it. There was no gap.

**Committed and merged this session** (PR #87, squashed to `main`). Production *data* is current;
production *code* is not. **max deferred the deploy to the next session** — it is the first step
there, and until it runs the card still reads "Hours not listed" for the 24 stands whose `open_days`
are now populated.

---

## 2026-08-08 — the onboarding form, and `JOIN <token>` replaced by a bare `START`

Started as eight cosmetic edits to the onboarding form and ended by replacing the credential that
completes farmer onboarding. Deployed to production (web `00042-rfs`, worker `00041-g59`).

**The eight form items were genuinely cosmetic, except two.** "Where is it?" → "Your farm address"
with the instruction in the placeholder; the pin-icon lookup became a **Save** button; the found dot
got much bigger; `e.g.` on the example placeholders; "…to customers" → "…in the live listing"; and
the privacy checkbox moved directly under the address it governs. The two that weren't cosmetic:

- **The map "turning white" on zoom was `opacity` on the `<svg>` itself**, fading the whole element
  against the page rather than fading the artwork. The box is now a fixed water-coloured ground with
  the artwork group fading over it.
- **The pin's size is asserted as a fraction of the settled frame**, never as a raw `r`. The radius
  scales with the zoom, so a bare number would have passed at any apparent size and would need
  rewriting every time `ZOOM_FRACTION` changed.

**Item 7 turned into a redesign, over five reversals.** max asked for the consent box above Submit;
then a post-submit modal; then "text CONFIRM" instead of a token; then a saved phone; then removing
the `JOIN <token>` route entirely. Two of those I pushed back on with evidence rather than building:

- **"Reply CONFIRM" cannot work**, because it inverts the direction. `isProactiveSendPermitted`
  permits a send to a number with no consent record only for `required_reply` — the answer to that
  recipient's *own* message. We cannot text first, so the farmer's message has to come first.
  `CONFIRM` is also not a compliance keyword, so it would establish nothing.
- **A stored phone would have duplicated a mechanism that already worked.** `JOIN <token>` already
  tied handset to farm. I said so before building it. max's answer was to delete `JOIN <token>`
  instead — which is the right call and made the phone the *only* mechanism rather than a second one.

**The trap in that change, and the reason it needed care.** `openFarmerOnboardingRequest` calls the
consent writer with `firstTimeOnly: true`, which refuses whenever *any* record exists. That is
correct for `JOIN` (B-011: `JOIN` is ours and cannot clear the carrier's own opt-out list, so
claiming consent for a returning sender records `active` while every send is refused 409). But
`START` is the carrier's own keyword and the only word that lifts that block — so it is *precisely*
what a returning farmer sends. Keeping the flag would have spent their invitation, left consent
`stopped`, and told them nothing. The flag is now conditional on which credential arrived, and the
inversion is pinned by *"ENROLLS a returning farmer whose phone had texted STOP"*.

What that does **not** give up: the protection `firstTimeOnly` was added for was a *web form*
silently re-enrolling someone who had opted out. That still holds, because a form tick writes no
consent at all. What enrolls is an inbound message from the handset, which is the one act that
legitimately clears a stop.

**Four dead references the removal left behind, each of which would have failed silently.**
`buildInviteSmsUrl` still composed a `JOIN <token>` body — with the grammar gone, that message would
arrive as free text, reach the model, finish nothing, and look to the farmer like they did exactly
what they were told. The agreement step's copy told them to text it. `FARMER_JOIN_INSTRUCTION` named
`JOIN`, a word that now enrolls without setting anyone up. And the schema comment still described
`SIGNUP <token>`, two keywords out of date.

**`drizzle-kit` did exactly what migration 0024 warned it would.** For `0028` it emitted only the
two `ADD COLUMN` lines and **silently dropped all three CHECK constraints and the partial index** —
so `schema.ts` would have declared rules enforced by nothing. It also stamped a journal `when`
*earlier* than 0027's, which `migration-ordering.test.ts` caught: an out-of-order entry is silently
skipped. Both fixed by hand. The migration test fails 4 of 7 when the constraints are removed, which
is the evidence they are real rather than declared.

**The agreement folded into the form, closing max's original item 7.** It had been a separate card
*below* the whole form, so the page read as two errands and a farmer could submit having never
scrolled to the disclosures. `AgreementStep` is deleted; the tick is a field above Submit and gates
it. The old ordering hazard (a prepared-text link between tick and Submit, which could take a farmer
off the page before their listing saved) went away with the card, since the hand-off now lives on the
saved screen.

**The confirm modal exists for a failure with no other signal.** A mistyped phone number: the listing
saves, the farmer texts `START` from their real phone, it matches nothing, and they wait — with every
field on screen looking correct. Ten valid digits are indistinguishable from the right ten digits, so
nothing in the system can detect it. Hence a blocking dialog that reads the number back.

**Two real defects my own tests caught, both worth recording.** Removing the agreement `<section>`
also took the link-expiry paragraph with it — the surface test failed and I initially misread it as a
stale assertion. And the agreement POST became the *first* fetch call, so every test reading calls
positionally read the wrong body; the endpoint filters now select the listing endpoints **by name**
rather than excluding the lookup, which is what keeps the next new endpoint from doing it again.

**A styling rule that excluded by enumerating.** `.farmer-listing input[type="text"]` silently missed
the `type="tel"` phone field and the paragraph `<textarea>`, so both rendered at browser default
mid-form. The rule stops enumerating; a test asserts every rendered field carries a covered type,
read from the DOM rather than by grepping the stylesheet — because matching nothing is the failure.

**Deploy.** Migrations first (26 → **29**), fingerprinting production before touching it and
verifying by effect rather than from the apply's exit status. Then the image: plan was
`0 to add, 2 to change, 0 to destroy`, `plan-assertions` 55/55.

**Still owed, and it is the real gap:** no SMS has gone through this code, and nobody has used the
form in a browser on production. The `START` path is proven through the real webhook handler against
real Postgres — never against Telnyx.
