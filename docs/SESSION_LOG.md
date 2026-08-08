# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps the **newest eight entries**; everything older rotates into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 67. A log too large to open
mid-session defeats its own purpose.

---

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

## 2026-08-07 — F-088: the address question, reversed twice, and a constraint that outlived its defect

Started as UI polish on one janky field and ended by relaxing F-038's load-bearing invariant. The
path there was three reversals, each of them max correcting the frame rather than the details.

**What shipped on the form.** The full-width "Find this address on the map" button became a pin icon
inside the field; `Enter` runs the lookup. The island map now renders from the moment the address is
asked for — faint, pinless, fixed height — instead of materialising on a successful lookup and
shoving every field below it down the page. A resolved address zooms the frame from the whole island
to the stand's neighbourhood, keeping the coastline in view because Farm Friend draws its own island
with no tiles, and a pin on a blank field is a confident-looking picture carrying no information.

**The zoom is animated in JavaScript, not CSS, and the first version was wrong.** I wrote it as a
`view-box` transition; that property is too thinly supported to depend on, so on most browsers the
frame would have snapped and the travel — which is the part that carries the meaning — would have
been lost. A `requestAnimationFrame` loop behaves the same everywhere. The tests passed either way,
because they assert the settled viewBox value rather than the motion: green for a reason unrelated
to the change being correct.

**Places Autocomplete was scoped, argued for, and dropped.** The obvious answer to "make this less
janky" is autocomplete, and I costed it: a third reopening of the no-runtime-geocoder boundary, a
second Google API, a decision only max could make. He took the smaller path instead — polish the
geocoding flow that exists. `GEOCODE_ALLOWLIST` stays one file and the dependency tripwire is
untouched. Worth remembering that the boundary held because the cheaper option was actually enough.

**"Don't show my farm on the map" could not exist as asked, and the real need was narrower.** The
database had no third visitability state. Pushed back; max clarified from the live map — some farms
show a pin with no address listed — so the ask was "don't show my *address*", which is a display
fact, not a location one. That became `address_public` (0026), a flag beside the address that the
public card, the SMS answer path, and the admin screen all read. The non-obvious half: the "get
directions" link is built from the **coordinate**, not the address string, so hiding the address
does not suppress it. Without an explicit clause a farmer who hid their address would still be
handing every customer turn-by-turn navigation to their front door.

**Then max reversed the model twice more, and the second reversal is the one that matters.** First:
every farm should give an address, stored either way — which meant relaxing the constraint that
forbade an address on a `contact_only` row. I argued for keeping the coordinate forbidden, since the
pin is what sends someone driving. Max disagreed on the product: *"pin everyone. most farms would
want to be shown on the map as lead-gen. it's just about not wanting people driving there."* That is
a better frame than the binary I offered — "don't drive here" and "don't show me" are different
wishes, and F-038 had collapsed them.

**The original defect was never the coordinate. It was the *unlabelled* coordinate.** A pin that
looks identical to a real stand and offers the same directions link does imply "come here"; a pin
that says "Farm, no stand" and offers no route does not. So 0027 restates the constraint as one rule
over the shape of a location — complete, or absent — with `visitability` named only in the branch
that still forbids an unplaced visitable stand.

**max also caught that the differentiated pin already existed.** I was scoping how to build it;
`mapMarkerKind` has returned `contact-only` all along, with a `●` symbol, a "Farm, no stand" legend
entry and its own CSS — **unreachable the entire time**, because the constraint forbade the
coordinate that would have rendered it. The feature was already written and the database was
preventing it from ever appearing.

**What this trades away, stated plainly because it was a real decision.** The guarantee that nobody
is sent driving to a farm with nothing to buy used to be enforced by Postgres and unbypassable. It
now lives in `buildMapView` behind a test. That is weaker — a future change can drop one condition —
and max accepted it knowingly. Sabotage-checked: removing the clause fails the test.

**Two migrations applied to the local database, verified by effect.** 0026: 48 rows backfilled to
`address_public = true`, zero NULLs, nobody's address changed visibility. 0027: checked against the
real rows *before* applying (zero would violate), then probed after — contact-only-with-location
accepted, half a coordinate pair still refused, unplaced-visitable still refused, probe rows deleted.
Both recorded in `drizzle.__drizzle_migrations`, which hand-applied SQL bypasses; without that
`drizzle-kit migrate` would have tried to reapply them.

**Two corrections I owe the record.** I reported there was no Postgres locally and that integration
tests could not run — I had checked for the `psql` *client binary* and concluded the server was
absent. There is a database with 48 stands; the integration suite runs here and passes. And I
reported the new UI was missing from the served HTML: that check was wrong, not the code. The
address block renders client-side behind the visit question, so `curl` on the initial page cannot
see it; the client bundle carries it.

**Test churn worth avoiding next time.** Relaxing the constraint broke 41 tests and I fixed them in
several passes rather than diagnosing first. Most came from one cause: `posted()` read
`fetchMock.mock.calls[0]`, which became the *geocoding lookup* once every farm needed a resolved
address. Finding that first would have collapsed three rounds into one.

Also fixed: the map search field's native clear "x" had an I-beam cursor, so it read as text rather
than a control. `cursor: pointer` on `::-webkit-search-cancel-button`, matching `.filter-clear`.

**Verified**: 1562 unit + 805 integration passing, typecheck and lint clean, web build compiles.
Committed and pushed to `main` at `e55cb92` (max chose to skip the branch/PR flow this session).
**Not deployed, and the two migrations were deliberately NOT applied to production** — max's call:
production keeps serving the current image, which does not read the new column, and the schema
change waits for a session where it can be watched. **Not browser-verified** —
the zoom timing, the icon placement and the map strip at phone width are judgment calls made in
code; max does his own pass before go-live.

---

## 2026-08-07 — Two farmer-facing gaps max reported, and the compliance rule that reshaped one of them

max raised two things from using the app: the migration door telling farmers to "contact VIGA" to
set up texting, and old unstructured listing text sitting under new listings. Both were real; the
first turned out to be constrained by a rule that made the obvious design unbuildable, and the
second turned out to be the opposite of what it looked like.

**Farm Friend cannot send the first text, and that killed the natural design.** max's proposal —
farmer types their number, ticks consent, we text "reply CONFIRM" — cannot be built.
`isProactiveSendPermitted` permits an un-consented send only for `required_reply`, the
carrier-required answer to that recipient's *own* message, and `authorizeDispatch` suppresses
everything else for a number with no consent row: "silence is not permission." Any flow where a web
form triggers an outbound SMS to an unproven number is blocked by architecture, not missing code.
Routing around it by labelling the message `required_reply` would launder a proactive send through
a compliance exemption. So the direction inverts: the farmer texts **us**, and that inbound message
is the possession proof and the opt-in at once.

**The word has to be `START`.** max suggested `CONFIRM`, which reads better. But Telnyx keeps its
own opt-out list and enforces it independently — a `join` four minutes after a `stop` was still
refused 409 (verified live 2026-07-27), and only `START` clears it. A farmer who ever opted out and
replied `CONFIRM` would be recorded as consenting while every message to them was silently refused.
`START` is also carrier-registered, so one word serves a first-timer and a returning farmer alike.

**max asked to store the phone number anyway; it is collected in the copy's framing but not
stored, and that is worth restating.** `DATA_ARCHITECTURE` §privacy keeps a raw phone in exactly one
column *because the sender needs something to send to*. There is no send path here, so a stored
number would be personal data with no reader — the exact trap `administrator_phones` avoided — and
an unverifiable one, since a typo'd digit is a stranger's number that nothing would ever catch. The
farmer's inbound `START` carries the real number, verified by possession.

**The second issue was the reverse of its description.** max asked that the onboarding form
"supersede but not overwrite" the old prose. In fact `saveOnboardingListing` wrote **zero** to
`farms.description` through all three doors — it did not overwrite it, it ignored it. So a farmer
published a clean listing and VIGA's older prose stayed welded underneath, contradicting the fields
above it and editable by nobody. The fix is a writer plus an edit box, with `undefined` meaning
"this door states nothing" and `""` meaning "the farmer cleared it" — collapsing those is B-037 one
column over.

**I measured the parser and reported it as if it described the live cards, and max caught it with a
screenshot.** I ran `buildStandDescription` over the real corpus, found it removed 53% of the text,
and argued from that against using a model. The function was right; the claim was not. F-061's
cleanup has been *deployed since it was written and has never run against the data* — F-064's
ingest never happened — so production stores raw prose and the card renders it verbatim. Tian Tian's
live card shows the farmer's name, her home address, `Website:`, `Open:`, `Stocking Days:`, a dated
update and `Accepts`, beside a "Hours not listed" chip and above a duplicate of its own "Usually
sells" list. **To say what a card shows, read the column, not the parser.**

**The model question resolved against the model, on evidence.** max asked whether an LLM could fold
the redundant text intelligently. Measured against the real corpus the leftovers were a *fixed set
of labels* — `Generally Offers` (13 of 34 farms, duplicating the exact field the form asks for),
`Hosting` (7), two date spellings, colon-less `Open` lines — which a parser handles exactly and a
model would handle non-deterministically and unreviewably. The constitution's rule decided it:
measure against the real corpus before defending a deterministic approach.

**Then measurement forced a correction on my own fix.** Dropping every labelled line emptied **nine**
farms rather than one, because for those farms every line is labelled — and 10 lines across the
corpus carry a *tail* no column holds ("Stocking daily. Harvest days are Tuesday and Friday. Best
selection on those days by late afternoon"). No punctuation rule separates the halves. So a labelled
line is dropped only when its body reads as a plain list; anything richer survives whole and reaches
the farmer's edit box. That is where max's model instinct was right — the residue is genuinely
model-shaped — but the farmer is on the page and is the better authority on their own words.

**A sabotage escaped and exposed a test that could not fail.** Both "keep the tail" fixtures were
long enough that the length check alone kept them, so disabling the sentence-break rule left all 26
tests green. Flora Hill's short real line ("Everyday. Flavors change on Friday") now isolates it.
Thirteen sabotages total this session, each verified applied by grep before running — the earlier
lesson that a substitution which silently fails to match proves nothing.

**The dry run found a defect no fixture would have.** Venison Valley's stored row begins literally
`/22/2026 Update:` — the month gone, lost upstream in hand-editing — so the dated-update pattern,
anchored on a leading month digit, missed it and the line printed beneath "Nothing confirmed
recently". The month is now optional, matched by the shape that remains rather than repaired;
supplying a month nobody wrote would be inventing a confirmation date.

**max's vCard check found a live gap.** He asked whether customers texting `JOIN` receive the
contact card. They did not, and no SMS path sent it at all: F-039 built
`/api/public/contact-card` and wired it to a link on the public web *map* only, so anyone who
arrived by text — the product — was never told it existed and every later message came from an
unnamed number. It now rides in the welcome both `JOIN` and `START` trigger. That costs a second
segment (the URL is 71 characters at production's `run.app` host); max chose the segment over
cutting the copy. The first version of that test asserted a 160-character ceiling, which is the
*single*-segment limit — concatenated GSM-7 is 153 — so it would have let a 2.1-segment body pass.

**Merged, deployed, and the cleanup run** — max approved both at the wrap. 1553 unit (131 files),
802 integration (58 files), typecheck, lint. No `packages/ai` change and no migration, both checked
against the diff.

Deployed at web `00041-r5m` / worker `00040-bks`, which also shipped the two tranches max had been
holding (F-081, and the sign-up wizard plus the integration guard). Verified by effect rather than
by the apply's status: plan assertions 55/55, `deploy_assertions` confirming each serving revision
is newer than every secret version it consumes, and new code genuinely serving — 34 stands, bare
`/farmer/start` 404, malformed body 400 rather than 500.

**The cleanup rewrote 31 of 34 rows** in one transaction, verified by reading them back and then
independently through `/api/public/stands` — the surface a customer reads, not the script's own
report. Tian Tian's card went from nine lines of restated facts to one. 34 → 29 farms carry a
description; the 5 emptied held nothing but structured facts that still render from their own
columns. A re-run reports **0 would change**: idempotence proven by effect. The two "Stocking"
lines that survive are the deliberate tail-keeps, which is the design holding on real data.

---

## 2026-08-07 — F-081's default schedule, and two sabotages that found gaps rather than confirming tests

Built F-081 (approved farmers start on a weekly reminder schedule), closed B-038 by ingesting the
last three farm emails into production, and filed F-082/F-083 from things max surfaced. The
durable content is the two escaped sabotages and where the schema said the seed had to live.

**The gap was wider than CURRENT_STATE described, and reading the code is what showed it.** The
open item named `authorizeFarmer` as the door that writes no `inventory_prompt_preferences` row.
In fact **no onboarding door wrote one**: the table had exactly one writer,
`setInventoryPromptPreference`, behind the farmer settings surfaces. A fix touching only
`authorizeFarmer` would have reached almost nobody, since invite and migration are the live doors.
F-052's machinery was correct and reached zero farmers because its candidate query selected against
an empty table.

**The schema chose where the seed lives, not judgment.** A preference row carries composite foreign
keys to BOTH `sales_locations` and `farmer_authorizations`, so it is structurally impossible before
a stand exists — and `authorizeFarmer` and the invited redemption both run *before* one does (an
invited farmer publishes from the web form and is authorized later, when they text `JOIN`). So
`seedDefaultPromptPreference` is called from `saveOnboardingListing` **and** from both
authorization writers: the doors reach the pair (stand, live authorization) at different moments,
and seeding at whichever comes second is the only shape that covers all four.

**Two of four sabotages found real gaps rather than confirming the tests, which is the whole reason
to run them.**

- A hand-computed `+7 days` **escaped every assertion**. The fixture published at 10:00 local,
  where "seven days on at the same clock time" and "10:00 local on the seventh day" are the *same
  instant* — so the schedule rule was never under test at all. The fixture now publishes at 15:30
  local, and the sabotage fails on `22:30Z` vs `17:00Z`. **A test whose fixture sits exactly on the
  boundary it is testing cannot see the boundary.**
- Dropping the authorization validity check **escaped** — nothing exercised a revoked or foreign
  authorization, so a revoked farmer would have been scheduled for texts. Two tests added; the
  cross-farm one also proves the composite foreign key refuses it independently, so the check and
  the constraint are both real barriers rather than one dressed as two.

**The typecheck caught a drift trap the tests could not.** All three listing doors restated
`saveOnboardingListing`'s input shape inline, so adding one field left three boundaries describing
a writer that no longer existed. Now stated once as `SaveOnboardingListingInput`; two dead imports
removed on the way through.

**B-038's three farms were never in the form export at all** — which is why the fix the item
proposed (re-run the ingest) would have changed nothing on its own. They are seeded farms that
never filed a response. Ingested from a scratchpad copy of the export with four rows appended;
VIGA's original file untouched. **Verified through the shipped `findVerifiableFarmByEmail`** with
the controls that make it evidence: wrong salt matches nothing, unknown address matches nothing,
and **one farm's address does not verify another farm** — F-079's per-farm scoping, proven rather
than assumed. `farm_emails` 38 → 42 rows, 32 → 35 farms; every real farm now has an address.

**A parsing trap worth knowing if VIGA's map export is ever reused.** `VIGA Map Stands.csv` writes
multi-line descriptions **unquoted**, so an ordinary CSV read splits one stand across many rows — a
naive parse produced **275 phantom farms** with names like `dawn to dusk` and `Zelle`. The real
count is 31 stands, recoverable only by treating a `POINT` in the first column as the record
boundary. It was obvious here because the output was nonsense; a quieter version of the same
mistake would have silently mismatched farms to emails.

**The market is not a farm, and measurement settled it.** max asked for a stand "type"; `kind`
already exists (`farm_stand` / `farmers_market`), the market row already carries the right value,
and **nothing reads the column**. Then max supplied the MarketWurks screenshot, which reshaped
the question: of 19 visible market vendors, **4 are in the farm roster and 15 are not** — bakers,
soap makers, a kids' booth, co-op tables. That killed my own earlier suggestion in F-082 that a
vendor list should link to farm rows; F-050's display-string design is right here for a second
reason it never anticipated. Both notes were corrected in the item rather than left contradicting
the finding. F-083 files the larger MarketWurks question, with the caveat that "seems pretty
basic" describes the customer-facing widget and not the unseen operator side.

**Not deployed, by max's choice.** F-081 carries no migration — it is a new writer over the
existing schema.

---

## 2026-08-07 — F-079 shipped, and three things that were green for the wrong reason

Built the migration door (F-079), deployed it, ingested the roster, and along the way found a
live production defect, a tripwire that could never fail, and an assertion of my own that failed
on correct configuration. The interesting content is all in the third category.

**The item under-specified the work in two ways that changed the build.** It described the code
as "hashed at rest, single-use, expiring, throttled per farm and per address" without noticing
that F-078 stored nothing about what was *sent* — so F-079 carries **migration 0025**, which the
item never mentions. And the existing `createPublicActionThrottle` rations by a coarse client
bucket, which **cannot** do per-farm/per-address: rotating the client signal is free, so one
farmer's inbox stays reachable. Both limits are counted from the stored rows instead, which is
also what makes them hold across containers.

**A code held in memory would have refused farmers who typed exactly the right digits.** Cloud
Run scales to zero between a farmer reading their mail and typing the code, so the later request
routinely lands on a different container. That is the whole argument for the table.

**The secret door answered HTTP 200 while rendering 404 markup, and only the real server showed
it.** `app/loading.tsx` was a Suspense boundary wrapping *every* route, and Next commits a 200 as
soon as that shell streams — before the page body runs `notFound()`. A 200 carrying 404 text is
indexable, cached as success by intermediaries, and tells a prober the path is live, which is the
single fact the obscurity exists to hide. **Four hypotheses were tested and disproved first**
(`force-dynamic`, awaiting params, dynamic segments, a `not-found` boundary) — each returned a
correct 404 in isolation, which is what made the real cause findable. The middleware fix was
abandoned because Next 14 middleware is edge-only and cannot use `timingSafeEqual`. Fixed by
scoping the map's spinner to a `(map)` route group, which is more correct on its own terms; a
build-shape test now asserts no root `loading.tsx`, sabotage-verified.

**F-078's raw-email tripwire could not fail, and had been green since it shipped.** It ran
`/\bfarm_emails\b/` over `codeOnly` output — which blanks **template literals**. Every query in
this codebase is a tagged template, so it detected *no reader of the table at all*, including the
two files its own allowlist named. The allowlist made it look verified. Now anchored to
SQL-preserving source and sabotage-verified against a new reader and a `packages/ai` reference.
The general lesson is the one CLAUDE.md already states — anchor to the construct, not to nearby
vocabulary — but the specific trap is worth naming: **a source tripwire about a TABLE cannot use
the same stripper as a tripwire about a CALL.**

**Planning the infrastructure exposed a live production regression.** The first plan showed
`SMTP_PASSWORD` being *removed* from the running web service. Cause: every `mount_*` flag
defaults to `false` and nothing recorded which ones production ran with, so each apply silently
reverted the previous one. It had already happened — **`GEOCODING_API_KEY` was mounted on web
revision 00034 and stripped at 00035** by the SMTP apply, absent through 00038. Since F-077 made
the typed address the only source of a coordinate, **production could not create a visitable
stand for that entire window**, and every apply reported success. Fixed with
`infra/production.tfvars` (the flags as configuration, not shell history), a plan assertion that
fails when a service would unmount a live secret — verified by planning *without* the var-file —
and the RUNBOOK's deploy command, which had been wrong.

**One of my own assertions failed on the correct configuration.** "EMAIL_HASH_SALT is never a
plain environment value" scanned `env` for the name at all — but a secret *mount* appears in
`env` too, with an empty `value` and a real `value_source`. It flagged every properly-mounted
secret. The existing `SMTP_PASSWORD` check gets this right by filtering on a truthy `value`.
**Worth recording: my first attempt to sabotage the fix edited `resource_changes` while the
check reads `planned_values`, so the sabotage passed and looked exactly like a check that cannot
fail.** Aiming a sabotage at the wrong tree is indistinguishable from a vacuous test.

**A dry run against production caught a defect before any write, which is why the dry run
exists.** Four farms — Flora Hill, Green Ears, Lavender Hill Farm, Sweet Alyssum Farm — carry a
`*does not accept VIGA Bucks*` annotation appended to the farm-name cell in VIGA's form. Exact
matching correctly refused them, so those four farmers would have had **no address stored and no
way to verify**, with the ingest reporting success. The annotation recurs every year, so the fix
belongs in the parser: a trailing paired `*…*` only, with three tests guarding the opposite
failure (over-stripping silently renames a farm). 31 → 38 addresses, 32/32 farms matched.

**F-078 shipped `ingestFarmEmails` with no caller**, so the roster could not actually be loaded
and max's chosen ordering — the ingest decides `EMAIL_HASH_SALT` — was not yet possible.
`scripts/ingest-farm-emails.ts` is that caller. **The salt is an argument, never generated
internally**: it is unrotatable, and a script that generated one would decide a permanent
production value and then discard it. The farm count is **pinned at 36** (VIGA's 35 plus the
marked `Test Farm`), not a floor — a floor accepts a half-seeded or wrong database and reports
"0 problems" over data nobody meant to touch.

**Design decisions worth keeping:**

- **The publish grant is a row, not a signature**, matching `farmer-link.ts`: a signed grant
  keeps verifying after the fact with nothing able to say otherwise. Its hash lives on the
  verification row itself, so there is no second credential table.
- **`consumeAndGrant` is one statement.** Consuming and granting are the same commitment — a
  consume that succeeded while the grant failed would spend the farmer's only code and hand them
  nothing.
- **The attempt cap is checked FIRST.** If the code comparison ran first, a capped record would
  still answer differently for a right guess than a wrong one, which is exactly the signal the
  cap withholds.
- **A malformed code is not counted against the cap.** A farmer who typed four digits made a
  typo; charging it exhausts the honest case faster than the attacking one.
- **All three F-079 secrets mount behind ONE flag.** The two salts are required by the verify
  routes, so a deployment holding the door secret alone serves a door that 500s on first use —
  one flag makes that state unrepresentable.

**One acceptance criterion is satisfied only generically, and max should know it.** "A farm with
no email on file is told to contact VIGA" cannot be done *specifically* without contradicting the
uniform-response rule the same item requires: naming that a farm has no address discloses roster
contents to anyone who asks. Both steps carry a standing "contact VIGA" line instead, which the
~3 affected farms reach like everyone else.

**Deployed and exercised end to end against production**, every step read back from Postgres
rather than a response body: identical responses for an address on file and a stranger with
**exactly one row written**; a wrong code counted and a malformed one not; the right code
verified, set the grant cookie, and **a replay refused**; the grant opened that farm's form and
**not another farm's**. Test row removed afterwards. Migration 0025's seven CHECKs and five
indexes all present, each proven to genuinely refuse, with a valid row accepted as the control.

Verified: **1495 unit**, **791 integration**, typecheck, lint, evals 44/44, production build.
`packages/ai` untouched across all eight commits, so no `evals:live` was owed.
