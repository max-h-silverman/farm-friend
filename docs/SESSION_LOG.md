# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps the **newest eight entries**; everything older rotates into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 53. A log too large to open
mid-session defeats its own purpose.

---

## 2026-08-05 — the onboarding listing form: the first farmer-facing listing writer, and three migrations to production

Closes F-067's remaining half and F-066's last acceptance criterion, then puts migrations
`0019`–`0021` on production.

**The gap this closed.** Onboarding captured a consent tick and nothing else, so a farm created by
an invitation reached the public map with a name and no address, hours, or items. The deeper fact:
**nothing in the codebase wrote listing facts at all.** `public_address`, `hours_text`, payment
methods and offerings were read everywhere and only ever *seeded* from VIGA's CSV.
`saveOnboardingListing` is the first non-seeder writer of `sales_locations`.

**The visitability branch is the form's structure, not a field on it.**
`sales_locations_coherent_visitability` is all-or-nothing in both directions — a visitable stand
needs an address *and* a complete coordinate pair, a contact-only stand must have none of the three
(F-038, B-024). So the form has to ASK whether there is a stand to visit before it can know what to
require. Enforced in the writer *and* by the database: the constraint is the guarantee, the writer's
check is what turns it into an answer the farmer can act on instead of an opaque 500. A sabotage
dropping the pin requirement was caught by the integration test *and* by Postgres, which is the
evidence both layers are real rather than one being decoration.

**The pin is dropped, not looked up — and that was max's call.** `coherentVisitability` demands
coordinates, and nothing here can turn a typed address into them: a runtime geocoder/map package is
a named non-goal and `maps/README.md` records that there is deliberately no mapping-provider seam.
Offered address-lookup (recurring cost, wrong-driveway pins), pin-drop, or publishing without a pin
(needs a schema change), max chose the farmer taps the island. `unprojectFromIsland` is F-043's
projection run **backwards** — the same statement about where the island is, read the other way,
rather than a second one that would drift. Verified in a live browser: a tap beside Vashon town
stored 47.4497 / -122.4733.

**max chose publish-on-submit over publish-on-SIGNUP.** Flagged first that the onboarding link is
the whole credential, so anyone holding a forwarded link could then put a stand on VIGA's public map
without proving they hold the farmer's phone — `listPublicStands` gates on `is_public` alone, with
no join to `farm_approvals`. max chose it anyway; recorded once, not re-litigated. Mitigations that
exist: links are one-use, expire in seven days, and an admin can remove a bad listing.

**"VIGA reviews your request" was retired, not reworded.** Redemption now authorizes and approves in
one transaction, so a promised review is a step nobody performs — a farmer would wait for a text
that already arrived.

**The boundary treats the token as the only credential.** A `farmId` in the request body is
*ignored*; sabotaging that to honour it failed a named test. That is the guard stopping any
onboarding link from overwriting any farm's public listing.

### The sabotage that escaped, and why it matters most

A plural-stripping normalizer (`"tomatoes"` → `"tomatoe"`) **passed all 17 new integration tests.**
It mangles the item key without *colliding* with anything, and the database index applies the
correct rule independently — so the stored rows looked right while the in-memory dedupe had
silently stopped agreeing with the index that arbitrates. Row-count assertions could never see it.

`standItemKey` is now exported and asserted **directly**, including that it returns the word itself
— the assertion no collision test can make. The escaped sabotage fails 4 named tests.

**The same defect class was already living in an existing test.**
`farmer-onboarding-surface.test.ts` reads page source as raw text, so the comment *recording that*
"VIGA reviews your request" was retired satisfied a search for that phrase. It now strips comments
first, verified by effect (present in the raw file, absent after stripping, markup intact). This
affected its pre-existing assertions too, not only the new ones — a comment could always have
satisfied any of them.

**An architecture tripwire fired and was right to.** `architecture.test.ts` forbids branching on
location type in the publication path (F-038: any farm may publish inventory). `farmer-listing.ts`
branches on `visitability` to satisfy `coherentVisitability` when writing a *listing* — the same
display-vs-gate distinction that already excludes the public read path. Rather than add a bare
exclusion, the exclusion is now **guarded** by a test asserting the file reaches no inventory write,
so the reason holds rather than being asserted in a comment.

### Migrations `0019`, `0020`, `0021` applied to production

Applied in order against `neondb`, after fingerprinting the target read-only (35 farms, 35
locations, 2 contacts, 19 migrations — matching the documented state) so a mistyped connection
string would have been obvious. max declined a pre-migration snapshot when asked.

**Verified by effect, not by the apply's exit status** — `db:migrate` can exit 0 having silently
skipped a migration whose journal timestamp is not newer:

- `0019` — `source` NOT NULL, **no default**, CHECK requiring the full handset chain for `sms` and
  none of it for `viga`;
- `0020` — `stand_items` present with its unique index over `lower(btrim(display_name, ' \t\r\n'))`,
  and **212 rows backfilled** from real production data;
- `0021` — settlement CHECK re-read via `pg_get_constraintdef` and confirmed to admit an
  authorization;
- listing data unchanged: 35 farms, 35 locations, 2 contacts.

Production went 19 → **22 migrations**. All three are additive and backward-compatible (a column, a
table, a widened constraint), so the pre-tranche image kept serving correctly in the window between
the migration and the deploy.

### Deployed

Merged as PR #81 (`7c996a7`), then built and deployed **from the merged base** — production must
never run code that did not land on `main`. Plan was `0 to add, 2 to change, 0 to destroy` (the two
Cloud Run services taking the new digest, nothing destroyed), plan assertions 37/37, deploy and
served-card assertions pass. Serving `farm-friend-web-00030-kx6` /
`farm-friend-worker-00031-tsm` at digest `sha256:6fed811a…`.

**Verified by effect against the live service**, not by the apply's exit status: `/api/public/stands`
serves 34 stands with **33 reading `usuallySells` from `stand_items`**, so the promoted image and the
migrated schema demonstrably agree — the single fact that would have broken had the migration been
skipped. `POST /api/farmer/listing` answers `400` to a malformed token before touching the database
and a uniform `410` to a well-formed unknown one, so the new endpoint is not an oracle either.

**One verification defect worth recording:** the first check invented a constraint name
(`inventory_revisions_coherent_source`) and reported a FAIL against a migration that was fine. The
name is now read from the migration file. A verification script that asserts the wrong thing is
indistinguishable from a broken migration until you look.

## 2026-08-05 — self-serve farmer onboarding (F-067), and two UI defects

max: *"I want to eliminate the VIGA farm authorization step. Once a farmer is sent their onboarding
link and gives consent they should be considered onboarded."*

**The framing that made this small: the invitation IS the authorization decision.** A coordinator
picks the farm and sends a one-use link to a specific person — the human judgment happens there. The
queue click that followed re-approved a decision already made, which is why the code it replaced
could say "VIGA always approves". So this deletes a rubber stamp, not a safety check.

**What could NOT be deleted, and nearly was.** `farmer_authorizations` is not the queue's output —
it is the record binding *this phone* to *that farm*, read by `resolveFarmerTarget` on every inbound
message. Remove the row and no farmer can publish at all. What changed is who writes it and when:
the arriving `SIGNUP` instead of a coordinator's click, in the same transaction as the consent and
the redemption, for the reason that transaction already existed — the invitation is spent, so a
crash between the two would leave a farmer consented, unauthorized, and holding a dead token.

**The gate is the evidence the invited path already rests on**, and each part is load-bearing: an
invitation *naming a farm*, whose agreement was *ticked*, redeemed *from the handset*. The three
paths that lack one fall through to VIGA's queue rather than failing — a bare uninvited `SIGNUP`
(reachable by anyone with the number), an invitation naming no farm, an untickd agreement. That
last one matters most: authorizing without the tick would set someone up for messages they never
agreed to receive.

`authorizeInvitedFarmerIn` is `authorizeFarmer` minus the administrator and deliberately nothing
else — same row, same uniqueness rule under lock, same settle, same notification, still an
`inventory_prompt` so `authorizeDispatch` re-reads consent at the claim. The audit event names the
**farmer's contact hash** rather than an operator: attributing a self-serve setup to a coordinator
who never clicked would put a false claim in the audit trail.

**max's scope decisions, asked mid-build.** A new-farm invitation should create the farm at invite
time (replacing "New farm — assign later"), onboarding should capture full listing details rather
than a minimal set, and — asked whether a new farm's address should wait for human review —
*"I'm not worried about mistakes in the farmer onboarding. The admin can fix anything that's
erroneous."* So farmer input publishes immediately, which leans on F-065.

**Two defects the tests caught, both introduced by this change.** The settlement CHECK encoded "a
settled request was settled by an administrator"; migration `0021` widens it to "an administrator
**or** the authorization the redemption granted", stated as a full disjunction because a CHECK
passes on NULL — relaxing the administrator test alone would admit a settled row recording nobody.
Sabotaged to confirm it still refuses that. And the SIGNUP reply's logical key was **positional**
(`index === 0` → `signup-ack-`); with the acknowledgement now conditional, the opt-in receipt would
inherit the acknowledgement's idempotency key on exactly the runs that omit it — two messages, one
key, and a receipt silently dropped as a duplicate. Keys are now content-based.

**The copy had become a lie.** The acknowledgement promises "VIGA has your request, they will review
it and text you when your farm is ready" — three claims false for a self-served farmer, arriving
beside the "your farm is ready" text the same transaction queues. Dropped for that case rather than
reworded; the carrier receipt still rides along, since consent was established by that same message.

**A wrong finding worth recording so it isn't re-derived.** Mid-session I reported that nothing in
the codebase creates contact records and asked max to approve writing a farmer's phone number on an
invited `SIGNUP`. That was wrong — `apps/web/app/api/sms/webhook/route.ts` already writes the contact
at ingress on every inbound message, in the single raw-E.164 column, exactly as golden rule 5
prescribes. My greps had missed the one production insert. The permission was never needed.

**Verification by effect caught what the suites could not.** Running the full chain against the real
local database surfaced that migration `0021` had never been applied there — the integration suites
build their own databases, so all 635 passed while the dev database still held the old constraint.
Confirmed the widened constraint by querying `pg_get_constraintdef`, then ran the chain end to end: a
coordinator names a new farm, the farmer ticks and redeems, and the farmer can publish for that farm
with no open request, the audit attributing the act to the farmer, and one non-contradictory text.

**The wrap found the half of the feature that was missing.** Syncing ADMIN_OPERATIONS.md surfaced
`farm_approvals` — a **second, independent gate**. `confirmProposal` checks
`farmer_authorizations`, then `farm_approvals`, and returns `not_approved` when the second is
absent. So the first commits left a self-served farmer authorized, texted "your farm is ready", and
**refused on their very first update** — the same silent dead end this feature exists to close,
moved one step later. My mid-session report that the farmer "can publish" was wrong: they could be
*targeted*; publication was still blocked. Confirmed by querying both gates for the farms the
verification runs had created (`authorized=true approved=false`), not by reading the code.

max chose to grant both on redemption. The approval names the administrator who **created the
invitation** — honest rather than convenient, since that is the person who decided this farm
participates, at the moment they minted a link naming it. Written with `on conflict do nothing`
against the partial unique index rather than a preceding read: `for update` cannot serialize a row
that does not exist yet, so two concurrent redemptions for one farm would both see "unapproved" and
the second would raise. Verified by effect afterwards — both gates open, approver correct.

**Two UI defects max reported, fixed alongside.** The public map's phone view had ~40% of a screen of
blank panel under the stand list: `.list-column { padding-bottom: 40vh }` existed only to let cards
scroll clear of the floating detail sheet, but applied unconditionally. Scoped to `.sheet-open`,
which the page already set and no CSS read. And the admin "Copy link" button failed every time in
the live embed — the admin surface runs inside VIGA's site as an iframe, where
`navigator.clipboard.writeText` is gated by the `clipboard-write` permissions policy: unless the
*embedding* page sets `allow="clipboard-write"`, it rejects with `NotAllowedError` on HTTPS from a
genuine click. VIGA owns that embed code, so the frame cannot fix it from inside. `copy-text.ts`
falls back to `document.execCommand`, which works precisely because it predates the policy.

The farmer onboarding page also got a copy pass: ~150 words to ~60, one phone screen with no
scrolling. "Step 1 of 3" was the real defect — it promised two more screens when the remaining steps
were VIGA's. The four carrier-registered disclosures (frequency, rates, STOP, HELP) were left
untouched per SMS_COMPLIANCE.md; only their framing changed, and sabotaging one confirmed the
compliance test still fails when a required fact goes missing.

**Committed:** `25509a3`, `33a617c`, `34984c8`, `6dc4f41`. **F-066's commits rode on this branch**
(`2659600`, `8f6e876`, `e2ccc2c`) — built in a concurrent session, logged in the F-066 entry below.

**Merged as PR #80 (`41e6dd0`), squashed.** The merge was held while the second session was still
running — merging would have moved the base under work branched from where it started — and taken
once that session finished. The merged base was re-verified rather than inheriting the branch's
numbers: 1075 unit, 638 integration, typecheck, lint, all green on `main`.

**Sequencing decided with max after the merge:** build the onboarding listing-details form
*before* deploying and sending any farmer a test link. A link sent today would work — the farmer is
authorized and their farm approved — but their stand would reach the public map carrying a name and
nothing else, because the onboarding page still captures only the consent tick. The first farmer to
use this should get the complete experience, and the same form is the writer F-066's standing item
state currently lacks, so it closes that item's last acceptance criterion too.

**Owed:** the onboarding listing-details form (F-067's remaining half — nothing in the codebase
writes listing facts today, they are only ever seeded); then migrations `0019`–`0021` to production
in order, before the image that reads them; then one real onboarding link to a single farmer.

## 2026-08-05 — the listing ingestion tranche: F-063, F-061, F-062, and F-064's guard

Four items built in dependency order. The through-line is that **almost every design decision was
settled by measuring the real corpus rather than by reasoning about it**, and measuring contradicted
the audit twice and my own instincts once.

**F-063 — `source`, and the column the spec didn't name.** `inventory_revisions` asserted in every
row that a specific authorized handset sent a specific message. VIGA's own records have no handset,
so the spec added `source` with `sms` requiring `proposal_id` + `published_by_authorization_id`.
Building it surfaced a third NOT NULL key the spec never mentioned — `farm_approval_id`. max's call:
`viga` carries none of the three, because approval is the *onboarding* step and F-064 runs before any
farmer onboards, so at import time no farm has an approval row to point at.

The constraint is **one biconditional over all three keys**, not three per-column rules, because a
CHECK *passes* on NULL — independent rules would each be satisfied by exactly the half-populated rows
the constraint exists to refuse.

**The backfill would have failed against production, and only a populated-schema test caught it.**
The first version used `UPDATE … SET source = 'sms'`. `inventory_revisions_guard_history` is a BEFORE
UPDATE trigger permitting only the supersede shape, so that aborts on any table holding a current
revision — which is every real database. Against an empty test database it passed cleanly. It now
backfills via `ADD COLUMN … DEFAULT`, then **drops the default** so a writer that omits `source`
cannot be silently recorded as a farmer's confirmation.

**max reversed one acceptance criterion.** F-063 called for the card to read "From VIGA's records"
vs. a farmer confirmation; max chose the *same* "Confirmed X ago" wording for both. The distinction is
recorded in the data, not shown on the card.

**F-061 — the one-line defect, and what measuring found around it.** `seed-stands.ts:176` stored the
map transcription as the public description whenever a map row existed (27 of 35 stands), discarding
the form's clean columns for display while still parsing them for structured fields. That one line
caused both on-screen contradictions. Rebuilt from the form's own columns; both are gone at the data
level, verified over the real corpus.

Measuring corrected the audit twice. **Payment methods exist only in the map transcription** — the
profile form has no payment question at all, so the audit's "22 payment lines" were map lines. And
the "0/31 empty remainder" figure measured the *map description*, not the form's columns. Measuring
also found a **wrong-row link**: the map lists `www.handpickedhomestead.com` under Plum Forest Farm.
max chose to prefer the farmer's own answer, which fixes that and every case like it without naming a
farm in code. `farm_links` and `sales_location_payment_methods` — schema, no writer, no reader — got
both: 34 links and 53 payment rows over the real corpus.

**F-062 — where I had the product wrong, and max corrected it.** I proposed the weekly form feed
"usually sells" rather than confirmations, reasoning that a 34-day-median row would fake an active
confirmation loop at launch. max pushed back twice, and was right both times: think about the people.
A farmer has filled in VIGA's weekly form for years and has not heard of Farm Friend — if their
submission produces nothing, the replacement system is strictly worse for them on day one and
silently discards work they did. And a customer wants **both** facts in concert: the standing one
sets expectations, the dated one says how much to trust it today. I had treated "old" as
"dishonest", when the architecture's premise is that stale information stays visible *with a
warning*. Past 48 hours the card already shows its stale caution, which is exactly true.

**No model seam was added.** The audit expected one for the open-ended availability prose; measured
against the real corpus those answers are comma-separated lists a deterministic parser reads cleanly.
So no eval or `evals:live` run is owed, and there is no model in this path to jailbreak.

Measuring the real file found four defects the tests had not: payment text publishing as produce
("…and potatoes. Cash, checks, Venmo…"), sentence fragments as items, Green Ears appearing as *both*
stocked and closed (one latest-wins timeline per farm now), and two rows refused as unreadable that
were farmers stating a real fact ("We don't have anything available this week").

**F-064 — the guard, the rehearsal, and the three duplicates.** `describeTarget` names a target but
confirms only the string an operator typed; `requireExpectedDatabase` reports what is *actually*
there and aborts on anything unexpected. Verified by effect: pointed at a rehearsal database while
claiming `neondb`, the seeder refused and named what it found.

The three weekly farms matching no stand turned out to be duplicates (max confirmed), and split into
**two problems, so two mechanisms**. `Venison Valley Farm` and `Ostara` are word-prefixes of their
seeded keys. `Maggie's Farm` → `Green Ears` is a **rename**, stated in Green Ears' own form row
("Formerly Maggie's Farm") — the two names share no characters, so no spelling rule could reach it.
`resolveStandKey` stays an **exact** comparison of whole words anchored at the start, honoring this
module's standing prohibition on similarity scoring (a Jaccard matcher once ranked Lavender Hill
against Flora Hill at 0.33). Checked first: no seeded key is a word-prefix of another, so a prefix
names exactly one farm or none, and an ambiguous prefix resolves to neither. Unknown stands 3 → 0,
published 13 → 16.

**B-024 is fixed in code.** A farmer's written refusal now makes her stand contact-only — no address,
no pin — read as a general rule from her own words rather than by naming a farm. Production still
publishes her address until the ingest runs.

**Seventeen sabotages, and three of them found problems with the tests rather than the code.** Two
early attempts silently failed to apply and proved nothing (every later one asserts its anchor is
present before editing). The surviving-DEFAULT case passed every refusal test because the default
quietly satisfied the NOT NULL. And the name-ambiguity guard was checked with a string that was a
prefix of *neither* candidate, so the candidate list was empty either way and disabling the guard
changed nothing. All three now catch their defect.

**Committed and merged; not deployed.** The tranche carries **migration `0019`**, which production
has not received. F-064's production run is deliberately not done: it is a bulk write to `neondb`
needing max's explicit approval, a re-export of all three CSVs (the profile form is still open), and
a `neondb` snapshot — with an insert-only utility and GL-015 open, the snapshot *is* the rollback.

---

## 2026-08-04 — the expanded stand detail, and what the description turned out to be

Started as a design pass on one card. Ended by establishing that the seeder's `--form` path reads a
file VIGA has never produced.

**The layout defect was real but shallow.** `.detail-actions` was a bare `<div>` with no layout, so
two inline anchors rendered as the single word "WebsiteGet directions" — two destinations reading as
one. Fixing only that left the actual problem: the expanded row put a narrow left column (actions,
status, staleness) beside the chip box, and the two never have comparable heights — the aside is a
fixed three-item stack, the box grows with a farm's tag count. A well-tagged stand left ~180px of
empty column *distributed between* the left items, which reads as something failing to load. A
split that is wrong in both directions is the wrong structure, not a spacing bug. It is now three
stacked full-width bands (act → what's here → supporting detail), which is also the phone
arrangement, so the two surfaces stop diverging in shape for no reason a customer could name.

**The description was demoted because it was winning an argument it should not have been in.** It
inherited the 1rem body size, making it the largest type on the card — larger than the stand's own
name — and it is the one field of unbounded length, so a wordy farm dominated purely by writing
more.

**A text assertion could not have caught the collision, and nearly shipped as the test.** The first
version asserted `textContent !== "WebsiteGet directions"`. That reproduced the defect but cannot
verify the fix: the separation is a flex gap, and `textContent` is byte-identical with and without
it. The test now asserts list *structure*. Same class of near-miss the project's verification notes
already name — anchor to the construct, not to nearby vocabulary.

**`extractStockUpdate` parses the dated lines, and deliberately has no consumer.** VIGA's sheet
carries `"5/26/2026 Update: Salad, spinach, kale"`, which rendered as prose directly beneath the
card's code-rendered "Nothing confirmed recently" — two statements contradicting each other, the
dated one looking more specific. The closure form of that shape (`"7/9/2026 Update: Closed"`)
already had a reader; this one did not. An impossible date is **refused, not rolled forward**
(`new Date(2026, 1, 31)` is silently 3 March), and a dated closure is excluded rather than published
as a stand carrying one item called "Closed".

**Where it stopped, and why.** max decided the dated line should count as a confirmation so the card
can say "Confirmed 26 May 2026" instead of contradicting itself. Storage is unresolved: a published
confirmation needs `inventory_revisions.proposal_id` and `published_by_authorization_id`, which
assert *a specific handset was authorized and sent this*. A spreadsheet date has neither, so those
two keys would be fabricated attestations about identifiable people and the audit trail could no
longer tell a real confirmation from a typed one. Proposed instead, not yet accepted: a `source`
column with a CHECK that still requires the full chain when `source = 'sms'`. Also corrected
mid-session — **`farm_approvals` is per-farm onboarding, not per-update review.** VIGA does not
approve individual stock updates, and my earlier description implied it did.

**The finding that outgrew the session.** max supplied the two canonical datasets and said the map
is hand-updated by a volunteer from the form submissions — so the map is a *derivative*, and every
oddity in the descriptions (`WA, WA 98070`, the en-dash in `5/2/2026 Update –Eggs`) is transcription
residue from the manual step this product exists to remove. Measured over the 70 form rows dated
2026: `What do you have available` is filled **70/70**, while address, currencies, and links each
appear **once** — they sit behind an optional "if this is your first time this season" prompt nobody
fills in. So the only durable home for profile facts today *is* the volunteer's typed description,
which is why "Additional information" carries so much.

**`parseFormResponses` describes a source that never existed.** Its `EXPECTED_COLUMNS` name Address,
Contact Name(s), Social Media, Website, Open Season, Open Hours & Days, Stocking Days as separate
columns; none exists in either real file. Tracing its own fixtures: `13609 SW 220th St` and
`Bank Road, East of Town` are in **neither** file, while `23720 Dockton Rd SW` and
`15624 115th AV SW` appear **only inside map description prose**. max's read is that the schema was
inferred from the map CSV early on. That makes `form-responses.ts` and its 210-line test file a
green suite over an invented format — the "test that cannot fail" failure mode at module scale.

**Verified:** 993 unit tests / 102 files, typecheck, lint, production web build. Six sabotages,
each failing a distinct named test — collapsing the action list to bare anchors, forcing the sheet
down the directory branch, and three on the parser (impossible-date guard, closure exclusion,
latest-wins). Wide-screen layout measured in a real browser across 16 stands spanning every shape;
no band gap exceeds the 12px grid gap, and the action row wraps without overlap down to a 260px
card.

**Deployed** at max's call during the wrap: web `farm-friend-web-00029-bgf`, worker
`farm-friend-worker-00030-vzd`, digest `sha256:3a25dd2c…f33977a464`, no migration. Verified by
effect rather than by the apply's exit status — the served stylesheet resolves `.detail-actions` and
`.detail-aside` to `display:flex` with their gaps, and `.stand-selected .stand-detail-body` to
`minmax(0,1fr)`, so the two-column split is gone from production and not merely from the source.
Plan assertions 37/37; deploy and served-card assertions pass.

**Owed:** the phone-width and dark-appearance look at the expanded card, which `DEVELOPMENT.md`
requires for the public map. Not done — the browser in this environment reports a successful resize
while `window.innerWidth` stays 1728, and AppleScript window control times out (-1712). max chose
to merge and check it himself. The phone sheet's *markup* is covered by a test; its *layout* is not.

## 2026-08-04 — web onboarding establishes SMS consent (the launch blocker)

The first tranche of the pre-go-live farmer plan (`~/.claude/plans/warm-dazzling-kahn.md`), worked
from an approved plan rather than a PM item — max's call, and the plan file is the record.

**The defect, stated plainly.** `SIGNUP` opened a request row and established no consent.
`FARMER_AUTHORIZED_NOTIFICATION` is a proactive `inventory_prompt`, so `authorizeDispatch`
correctly suppressed it for anyone with no consent record. Nothing in the invitation text, the
onboarding page, or the SIGNUP reply ever asked the farmer to text `JOIN` — the word appeared only
in code comments. So the standard invited path was: farmer completes onboarding → VIGA approves →
**the farmer is never told, and never will be.** Every piece was individually correct and fully
tested; nothing exercised the composition, which is exactly where it failed.

**A tick on a web page is not consent, and the design turns on that.** Anyone holding the
invitation link can tick a box, so the tick proves only that someone with the link ticked. What it
does is stamp `farmer_invitations.agreed_to_sms_at` — *where the agreement was shown*. The consent
record is written when `SIGNUP <token>` arrives from a handset, because the inbound message is the
evidence tying the person who agreed to the number that will be messaged. The page gates the
prepared `sms:` link behind the server having recorded the tick, so a farmer cannot spend the
one-use invitation before the agreement exists.

**The write is atomic with the redemption, and that is load-bearing rather than tidy.** A crash
between redeeming the invitation and writing consent would leave the invitation spent, the farmer
un-consented, and no retry path — the second `SIGNUP` finds a redeemed invitation and the approval
text stays suppressed forever. That is the original dead end, reached by a different route. So
`applyConsentTransition` became a thin `begin` wrapper over `applyConsentTransitionIn(tx, …)` and
onboarding calls the inner form inside its own transaction. Same shape as `queueOutbox`, for the
same reason: **one consent writer**, so the first-time rule, the watermark ordering and STOP's
tie-break are stated once and every caller gets all of them.

**`firstTimeOnly` is what makes onboarding safe as an opt-in path**, and it needed no new code —
the B-011 machinery already does exactly the right thing. A farmer who already texted `JOIN` keeps
one unchanged record with its original provenance; a farmer who texted `STOP` is **not** silently
re-enrolled by filling in a web form. That second case is the one worth naming: the carrier would
refuse the send regardless, and only `START` clears its list, so recording `active` there would
make our record disagree with theirs about the same person.

**The reply had four cases and one rule: say the true thing about messaging.** Consent established
→ the registered opt-in receipt verbatim, since that is the moment the carrier registered it for.
No consent basis at all → an instruction to reply `JOIN`, the one place that word belongs in
farmer-facing copy. Already consented → neither, because they need no instruction and a second
receipt would claim an agreement not made today. That decision is a pure function
(`signupReplyBodies`) rather than branching inside the router: the router owns the deterministic
*order* and proves it with a throwing model seam, and putting four copy cases in there would make
each reachable only through a SQL stub shaped to produce it.

Two things the tooling got wrong and the plan predicted. Drizzle generated the `0018` journal
timestamp **out of order** (`1785873477704`, earlier than `0017`) — the B-022 trap where a migration
is silently skipped and reports success; corrected to `1786700000000`. And this drizzle version
tracks no CHECK constraints in snapshots at all, so the constraint was hand-written into the SQL,
matching how `0016` already did it.

The `provenance` wording in the new schema comment tripped `schema.integration.test.ts`'s forbidden-
concept scan, which reads raw source including comments. Reworded rather than exempted — the
tripwire is right that the *concept* has no place in this schema.

Verification: 102 unit files / 985 tests, 42 integration files / 580 tests against real Postgres
from an empty schema, typecheck, lint, production web build. Four new end-to-end journeys run
through the real signed webhook with a provider that throws on any call. Migration verified **by
effect** — column, constraint, and a backdated agreement actually refused — never by an exit code.
Four sabotages each fail a distinct named test: removing the consent write, removing `firstTimeOnly`,
inverting the agreement check, and replacing the `AgreementStep` call site with a bare link. No
model seam was added, so no eval or `evals:live` run was owed.

Also fixed: the map directory key read "Don't take VIGA Bucks" of a single stand, with the test
asserting the same wrong wording. Committed separately from the consent work.

Released as PR #77, squash-merged to `main` as `b8bc76d`.

Migration `0018` was applied to production **before** promoting the code that reads the column, per
the RUNBOOK's ordering rule. The target was fingerprinted first (`neondb`, 17 migrations, 35 farms
and 35 locations, column absent) so a mistyped connection string would have failed rather than
migrated something else. Verified by effect afterwards: the column and its CHECK constraint exist,
the journal shows `0018` landing exactly once at the corrected `1786700000000` with no duplicate
timestamps, and all 35 farms and locations are intact.

Cloud Build `04d46497-1e9d-4722-96f1-0e478cc35d2e` produced digest
`sha256:d27f3639f4a7ccc05da41b77e5cdc3a8581871cb4c5eb393a02422322de6aca6`. OpenTofu passed 37/37
plan assertions and applied 0 adds, 2 service updates, 0 destroys; deploy and served-card
assertions passed. Live revisions are `farm-friend-web-00028-mwv` and
`farm-friend-worker-00029-jzz`. Verified **by effect** rather than by the apply's exit status: the
live `/api/farmer/onboarding` refuses a malformed token with `400` before any database work, and
answers a well-formed but unknown one with the uniform `410 invitation_unavailable`, so the new
endpoint is not an oracle for whether a guessed token names anything.

**Still owed:** the journey has never been exercised against a real handset, and the agreement step
has not been looked at in a real browser at phone width.

## 2026-08-04 — interactive map selection and key polish

Nine small corrections to the public map, requested directly rather than through a PM item, plus two
mid-session amendments. Selection now reads the same on both surfaces: the directory row's selected
fill IS its hover fill (one new `--row-hover` token), so a chosen row no longer shifts color under
the pointer, and its ring thickened 2px → 3px to match the selected pin's weight.

**The selected pin is drawn last.** SVG has no `z-index` — paint order is stacking order — so a
selected pin rendered in place hid under whichever pins came after it, worst in the dense clusters
where the selection is hardest to find. Rather than add a second near-duplicate helper, `hoistStand`
gained a `"front" | "end"` parameter: the directory still hoists the selection to the front, the pin
layer hoists it to the end. Both ends are sabotage-verified.

**Pin outlines carry no state.** The white-unselected/black-selected switch is gone; every pin now
wears the same thin 2px outline, whose only job is holding markers apart from the land and from each
other. Selection is said once, by the halo. The flower glyph keeps an outline matching its own
petals, because a contrasting stroke draws the seams *between* its five overlapping circles and
turns one glyph into five discs.

Two defects were found by measuring rather than by reading the diff. The **thin black border**
appearing beside the amber one on first selection was `.stand:focus-within { border-color:
var(--olive) }` — clicking a row focuses the button inside it, so the dark border fired alongside the
selection ring; removed, with keyboard focus still carried by the button's own `:focus-visible`.
Separately, on wide screens the **amber ring was being erased whenever the pointer rested on the
selected row**: `.stand:hover { box-shadow: none }` and `.stand-selected` have equal specificity and
the hover rule sat later in the file. Computed style read `box-shadow: "none"` in a real browser;
`.stand:not(.stand-selected):hover` fixes it. Neither was visible to any test.

**The directory key never wraps.** Its type and its gap both scale in `cqi` against `.list-column`,
which is now a container — a `vw` clamp sized the key for room the padded column does not have and
clipped the last label on a phone. The slopes and floors are measured at 320–414px, not guessed.
An honest limit: below roughly a 340px column the three labels cannot share one line at any legible
size — the dots and gaps alone overrun it, verified down to 7px type — so the type stops at a
readable floor and the row scrolls rather than clipping a legend entry invisibly. The key is also
left-aligned with wider inter-item spacing.

The **"Has a stand to visit" filter was removed end-to-end** — the option, the active-filter count,
the `StandFilters` field, the predicate in `applyStandFilters`, and its test — rather than left as an
unreachable key with no consumer.

Verification: 99 unit-test files / 959 tests, typecheck, lint, and production web build. The new
`hoistStand` end-hoist tests were sabotage-checked: reverting the branch fails both, restoring passes.
Every visual claim was confirmed in a real browser at 1440x1000 and in 390px and 320px frames,
reading computed styles rather than trusting screenshots — jsdom reports every element as zero-sized
and can see none of this. No schema migration, no model seam, and no SMS or privacy surface was
touched, so no integration run or eval was owed.

Released as PR #76, squash-merged to `main` as `4a8bca7`. Cloud Build
`6a2c341b-22fa-43ee-8952-84f6febc6d74` produced digest
`sha256:2f089d8b4a0482a78cea6754b5dfa914800c7e5c021fb2dc9845ee455eab797a`. OpenTofu passed 37/37
plan assertions and applied 0 adds, 2 service updates, and 0 destroys. Live revisions are
`farm-friend-web-00027-5ng` and `farm-friend-worker-00028-67c`; deploy and served-card assertions
passed. No migration was owed. Verified **by effect** rather than by the apply's exit status: the
served CSS bundle carries `--row-hover`, `.stand:not(.stand-selected):hover`,
`container-type:inline-size`, and `cqi` sizing; no served chunk still contains "Has a stand to
visit"; and the live page reports a 3px amber ring, the selected pin last in the layer, a
one-line left-aligned key, and a uniform 2px pin stroke.

A local-history note for whoever pulls next: the squash merge rewrote three commits that existed
only on the local `main` (`c9efe10`, `8f04542`, `7e8326f`); their content is present in `4a8bca7`,
and local `main` was reset to `origin/main` after confirming the trees matched.

## 2026-08-02 — map marker colors corrected and deployed

The map’s open-state CSS was overriding the category colors: unknown, by-appointment, and stale
classes could turn a category marker gray or amber. Flower glyph strokes were also gray. PR #74
(`87ea51c`) makes the category fill authoritative: seasonal stays blue, year-round stays green,
farmers market stays purple, and flower petals and outlines stay red. Written open-state and stale
warnings remain in the card/list, and CSS regression tests cover the cascade boundary.

Verification: 94 unit-test files / 896 tests, typecheck, lint, and production web build. Cloud Build
`0d4f9963-535f-4ecd-81f5-7c35900390f6` produced digest
`sha256:0e98f195d7947735b426254118d769e9ffa9dc49c35c4801920f34ff9ddbb698`. OpenTofu passed 37/37
assertions and applied 0 adds, 2 service updates, and 0 destroys. Live revisions are
`farm-friend-web-00023-frt` and `farm-friend-worker-00024-mzv`; deployment and served-card checks
passed. No database migration or data backfill was needed.

## 2026-08-02 — complete interactive map listing details, marker mapping, and order deployed

F-058 (`71cc48f`, PR #72; final marker correction `640f0ac`, PR #73) completes the public map
tranche. The map now carries sanitized source
listing prose, hours, stocking notes, updates, and public web/social links into the detail view;
direct email addresses and phone numbers are removed. The default directory is ascending by stable
stand number, while explicit distance sorting remains unchanged. The legend and marker rendering now
use visitability, destination type, season, approved usual offerings, flower-product terms, and
reviewed Farm Bucks facts.
The requested sticky-map behavior was explicitly withdrawn and was not changed. Contact-only farms
remain list entries without pins because they have no customer-visitable coordinate.

The null-only backfill applied 34 descriptions and 24 reviewed payment facts with 0 unmatched source
entries; a dry-run rerun found 0 remaining changes. Production checks found 0 direct emails or phone
numbers in descriptions, Peak Moon's details and payment fact in the live API, and the expected
farmers-market, seasonal, year-round, and flower-only marker classifications. Handpicked Homestead
is intentionally unpublished and is the one database row outside the 34-stand public response.

Verification: 93 unit-test files / 894 tests, 41 real-Postgres integration-test files / 564 tests,
typecheck, lint, production web build, and 44/44 scripted eval cases. Cloud Build
`b3904d28-05ba-4276-9c7a-22281962e513` produced digest
`sha256:8e66a05b6734531d980f5193102ba3a4c9e845b221184dc96fdab9fcdf16066d`. OpenTofu passed 37/37
assertions and applied 0 adds, 2 service updates, and 0 destroys. Live revisions are
`farm-friend-web-00022-sk9` and `farm-friend-worker-00023-zhh`; deployment, secret-freshness,
served-card, and public-API checks passed. No migration was owed: production already held all 17.
