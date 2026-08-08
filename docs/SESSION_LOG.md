# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps the **newest eight entries**; everything older rotates into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 63. A log too large to open
mid-session defeats its own purpose.

---

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
Committed to `main` (max chose to skip the branch/PR flow this session). **Not browser-verified** —
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

---

## 2026-08-06 — self-onboarding: the plan's five workstreams, and where it was wrong

Worked `~/.claude/plans/woolly-kindling-origami.md`. Three workstreams merged, one on a branch,
one not started. **Nothing deployed.** The interesting content is where the plan and the code
disagreed, and where sabotage disagreed with both.

**B-037 was a live defect the tests actively concealed.** Editing a listing erased the farmer's
season, hours and restocking — every one of twelve columns written back NULL, silently. The test
that should have caught it was named "RESAVES an untouched edit form unchanged, **field for
field**" over a fixture holding only the eight fields the type knew about. A name asserting
completeness over an incomplete fixture is worse than no test: it is a claim nobody re-checks.
Fixed fixture-first so it failed on its own name before anything else changed.

**One of my own tests then passed for the wrong reason, and only sabotage found it.** The
integration test "an edit preserves restocking" survived deleting `stocking_days` from
`updateStand` — because omitting a column from a SET clause leaves what the INSERT already
wrote, so "preserved it" and "never wrote it" are the same observation. The edit now *moves* a
restocking day, which makes them different.

**The architecture tripwires never covered the web app at all.** `sourceFiles` collected only
`.ts`; the geocode block scanned `apps/web/lib` and not `apps/web/app`. So every page, route
handler and React component in the repository sat outside the geocode allowlist and the
`MapProvider` ban. Proven before fixing: a `geocode()` call plus the Maps host added to
`listing-step.tsx` passed the suite untouched. **No production source was violating any of it** —
the suite was green because the code happened to behave, not because anything checked.

**F-077 traded a real capability, deliberately.** Geocode-only means a stand at the road rather
than the mailing address can no longer be nudged, and rural Vashon is where lookup is weakest.
What it buys: a published coordinate that always corresponds to the published address. The
sharp edge it creates — A's coordinate publishing under B's address once the confirm gate is
gone — is handled in `changeAddress`. Two refusal paths clear a *stored* pin, and each needed
its own test: sabotaging either alone left the suite green, because `changeAddress` had already
cleared the pin in every test that existed. The clearing is only reachable on an **edit** form.

`DEVELOPMENT.md`'s geocoder exemption was justified by "every failure degrades to tapping the
map". F-077 deletes that, so the justification was **replaced rather than quietly dropped**.

**F-080: the plan's decisive sabotage is not decisive, and saying so is the point.** `JOIN` is
carrier-registered, so giving it an argument grammar inverts the compliance-first ordering. The
plan said the guarantee is proven by moving the token regex above the compliance lookup. It is
not: that regex *requires* a token, so it cannot match a bare `JOIN` from any position. And
loosening the grammar in place also passes, because compliance already consumed the word. **Only
both at once fails.** Two properties, each making the other non-critical — defence in depth, and
recorded in the test as such rather than as a single-guard proof.

Two more plan claims that did not survive contact:
- **`signup-reply.ts` does not collapse.** Requiring a token was said to make the "no consent
  basis" case unreachable. `openFarmerOnboardingRequest` writes no consent when
  `agreed_to_sms_at` is null, which an un-ticked invitation reaches *with* a token. Renamed, not
  deleted.
- **The two-consent-writer edit was unnecessary.** `JOIN <token>` parses as `kind: "farmer"` and
  never enters `routeCompliance` at all, so the parser separates the writers structurally.

**F-078: measured the corpus before building, and the plan was imprecise twice.** All three
headline claims held (32/32 rows carry an email, 5 multi-address farms, zero cross-farm
collisions). But Lavender Hill's three addresses come from **two columns combined**, not one
cell — the columns disagree for 5 of 32 farms, so they are unioned. And separators are **mixed**:
`" and "` as well as commas. A comma-only splitter turns one farm's cell into a single malformed
address and stores it, since nothing rejects "and" on sight. The corpus test caught that; the
fixtures alone did not.

**`drizzle-kit generate` silently dropped every constraint.** Run against the same `schema.ts`,
it emitted the CREATE TABLE and the foreign key and nothing else — both CHECKs and the
normalized unique index gone, no warning. Its version would have created a table enforcing none
of the rules `schema.ts` appears to declare. Only the meta snapshot was kept.

**Email provider: the plan said Vercel Marketplace, which is wrong for this repository.** Farm
Friend deploys to Cloud Run with Terraform-managed secrets and has no Vercel deployment. max
chose Google — and **Google Cloud has no first-party email service**, its own docs direct you to
a third party. What exists is VIGA's **Workspace account**, relaying through
`smtp-relay.gmail.com`. max chose **`board@vigavashon.org`** as the sender rather than a
dedicated address, because farmers will reply to a verification code and a `farmfriend@` mailbox
is one nobody watches. The trade — shared sending reputation — is accepted at ~35 messages.

## 2026-08-06 — the farmer's own surfaces, from max using them

max reported four things from actually working the app: he could not find how to delete a stand,
could not edit a farm's name, the onboarding save "seemed to take me to a different screen", and
the update form was "all so janky". Each turned out to be a different kind of defect, and two of
them were only visible from a browser.

### A removal was expressible but invisible

The sharpest finding, and it came from max asking a question about SMS rather than reporting a bug:
if a farmer texts "we have eggs and bok choy" when their stand lists eggs and kale, do they mean to
delete the kale? The architecture already answered correctly — the model returns *edits*
(`additions`/`changes`/`removals`), and `applyInventoryEdits` **preserves by omission** — so kale
survives unless the model explicitly removes it.

Two real gaps sat behind that correct architecture. The prompt defined the three arrays and never
said **when** to emit a removal, so a bare list of items was readable as a whole-listing
replacement. And `renderProposedSnapshot` showed the complete result while naming nothing as
leaving — a removal was visible **only as an absence from a list**, which is exactly what nobody
notices in a text message. An existing test actively enforced that (`not.toMatch(/removed|added|
changed/i)`), and its reasoning was sound but overshot: confirm the whole result, yes, but a farmer
must still be able to *see* the deletion they are confirming.

`ProposedSnapshot` now carries `removedItemNames` — **confirmation copy only**, read by no
consequence, with `entries` remaining the whole authority on what publishes. SMS and web share the
renderer, so one seam covered both surfaces.

The prompt change is a claim, so it was measured: three new `live-quality` fixtures against the real
model, all passing. A bare list adds without removing; "kale is all gone" still removes; "all we
have left today is eggs" still replaces. **The last two are the point** — a prompt that simply never
removed would satisfy the first fixture alone.

### The chips: max's idea, and why it beat the one it replaced

Asked whether plain text was clearly welcome on the update form, max went further: *"maybe instead
of a chat input the web update form can just be like adding/removing tags"*. That is right, and it
follows from the domain rather than from taste — a stand listing **is a set of short strings**, so a
farmer typing "sold out of kale" was doing manual labour to express *remove one member of a set*,
for a model to parse back into the removal we could have had directly.

The chat framing was argued against and dropped: there is one round trip, no history, and a chat UI
would promise a conversation the system does not have. Free-text survives as the escape hatch for
what chips cannot say — a closure, a price mentioned in passing — which is also what keeps the model
seam a live path instead of dead code.

**A structured edit skips the MODEL, and nothing else.** `applyInterpretedInventory` now takes
either `taskText` or an `edit` already in the interpreter's output shape. Everything after
interpretation was always code and is untouched: the same `validateInterpretation` against the same
retrieved snapshot, the same composition, the same confirmation gate. Sending chips through English
so a model could re-derive the shape would have been a lossy step and a model dependency for an edit
that needs no interpreting.

### The two defects that only a browser could find

Both were invisible to a green suite, and both were found by opening the page.

**The page drew the wrong listing.** Chips send ENTRY IDS. `readCurrentStandEntries` read the
*published* revision, but composition uses the sender's *open proposal* as its base. A farmer who
edited once and came back saw chips for items their own pending proposal had already dropped;
tapping one sent an id absent from the base and was refused — correctly, for a change they had every
reason to think was on offer. The free-text path never hit this because prose names items, not
identifiers. The reader now returns the pending base when one is open, scoped to one sender so
nobody sees another's unconfirmed edit.

**The stylesheet styled the delete control as the publish button.** `.farmer-form
button:first-of-type` filled the first button green, written when the screen had exactly one button.
The moment the listing became editable, the first button on the page was a chip's ×. Position is not
intent; the affirmative action now carries an explicit class, asserted by test.

### Three things that were not what they looked like

- **"I can't delete a farm."** Retirement already existed and already did the right thing —
  reversible, confirm-gated, nothing published destroyed. It was headed "Take off the map", sat last
  inside a collapsed panel, and never used the word anyone searches for. A naming fix, not a feature.
- **"Let me edit the farm name."** The farm name was **immutable everywhere** — written at
  invitation time, changeable by no farmer and no administrator, while public on the map. It merely
  *looked* editable because the listing editor passed `listing.standName` into a prop called
  `farmName`. Two records, one name.
- **"It took me to a different screen."** It did not navigate at all. The save replaced the entire
  form with one sentence, so the card collapsed and the phone-verification card that had been below
  the fold the whole time snapped upward. A collapse plus a scroll jump reads worse than a
  navigation, because nothing announces it.

### A test-harness gap, found by a duplicate match

Testing Library's `cleanup` was never running: without `globals: true` there is no global
`afterEach` for it to register against, so every mounted component stayed in the document for the
rest of the file and `getByText` could satisfy a later test from an **earlier test's render**. A
component test could pass while the behaviour it named was broken. Adding the setup file exposed no
existing failures, which is luck rather than vindication.

Related: an admin test written this session **passed on its first version without the code
changing**, because it asserted on body copy that already contained the word. It was retargeted to
the section heading — the thing an operator actually scans — and only then failed. Recorded because
that is the failure mode the project's "a test that cannot fail proves nothing" rule exists for, and
it still nearly slipped through.

### Naming

"Weekly update form" was **never the product's name** — it entered this session from the assistant
repeating max's phrasing back at him, and is dropped. VIGA's "weekly form" (the Google form
volunteers transcribe) and the `weekly` reminder cadence are both real and untouched; no farmer
surface calls itself that.

---

## 2026-08-06 — the weekly form switchover: a self-serve farm door (F-072 / F-073)

max's last piece of go-live planning: VIGA's Google "Farm Stand Weekly Status" form is replaced by
one global Farm Friend link. Two cases he named — a farm not yet on Farm Friend needs to onboard
itself, and a farm already on Farm Friend that follows the old link should be sent to *update*
rather than set up again.

### The suggestion that was wrong, and what it changed

The first proposal back to max was to keep a possession check: farmer picks their farm, Farm Friend
texts a one-use link to the number VIGA has on file. He answered that **there are no farm phone
numbers** — and he was right. `contacts` holds people who have texted Farm Friend, not a roster of
who owns which farm; VIGA never supplied one. There is therefore no possession check available to
build, and the honour system is not a shortcut but the only design the data supports. Recorded
because the instinct to "just verify the phone" will recur and the answer will still be no.

### What actually keeps the door narrow

Not the dropdown. Anyone can post a farm id to the endpoint behind it, so omission from a list
protects nothing. The guarantee is `claimGrandfatheredFarm` **re-resolving on submit**, and the
predicate it uses is F-071's — **the absence of a live farmer authorization**, never an unredeemed
invitation. That definition was already reasoned through once and comes apart in both directions
(VIGA can authorize straight from the queue with no invitation; a revoked farmer's farm belongs
back on the list). It is now stated **once** as a shared SQL fragment and used by both the public
list and the resolver, because two copies is exactly how a farm ends up hidden from the dropdown
and still claimable.

### An acceptance criterion deliberately not met

F-072's filed item asked that redemption leave a live `farmer_authorizations` row, matching F-067's
self-serve chain. It does not, and should not: naming a farm on an unauthenticated form is evidence
of nothing, so granting publish-by-SMS authority from it would hand the SMS surface to anyone with
the link. **The honour system buys a LISTING; speaking as the farm still needs a handset.** The
page says so rather than letting a farmer discover it when their first text is refused.

### One form, three credentials — the alternative was three forms

`ListingStep` and `parseListingSubmission` are parameterized by credential rather than forked. The
failure being avoided is drift: three doors publishing three different shapes onto one map. The
same reasoning extended to the billed address-lookup endpoint, which now accepts an invitation
token, a claimable farm id, or a stand link — and **refuses a request carrying two**, since
honouring either would let one credential launder the other.

**The geocoding gate got weaker on the grandfathered path, and that is written down rather than
glossed.** A farm id is not secret, so the throttle rather than the credential is the real cost
defense there. What the claim check still buys is that the lookup closes for a farm the moment it
has a farmer.

### F-073's third half was the real work

Recognition and routing are small. The gap was that **listing facts were frozen for everyone except
a farmer mid-onboarding** — the form is welded to a one-use invitation token, so an onboarded farmer
could change nothing. The edit surface lives under the existing `/stand/<token>` credential, so
revocation is inherited rather than reimplemented.

**Prefill is load-bearing, not polish.** `saveOnboardingListing` replaces the whole listing — that
is what lets a farmer drop an item by leaving it out — so a blank edit form would erase a farmer's
address and payments when they came only to change their hours. Two sabotages target exactly this:
the reader returning empty payments/items, and the form failing to prefill `hoursText`. Both fail
named tests.

### The defect only running it could find

`/api/farmer/link-request` was first bound to `appContext()`, which validates SMS, model, and map
configuration — so an unauthenticated farmer page returned **500** on an unrelated missing variable.
**No test could see it**: every test injects these dependencies, so the composition itself is
invisible to the suite. It now builds from `publicReadContext` plus the two values it needs. This is
the second time the full composition root has leaked into a public surface; `public-context.ts`
exists because of the first.

### A fixture that looked like a bug

The first live link-request check queued nothing for a matching farmer. The cause was a seeded
contact carrying a **placeholder hash** (`aaaa…`) rather than one under the real salt — fake data,
correct code. Recorded because the shape of that failure (verified behaviour, silent zero result)
is one that invites blaming the code.

### Verified, and how

Every claim read back from Postgres or `/api/public/stands`, never from a success message: a
grandfathered listing reaches the public map; posting an **already-onboarded** farm's id is refused
`409` with that farm's row confirmed unchanged; a matching phone queues exactly one text whose token
**hashes to a live `farmer_links` row** while a wrong number, a cross-farm farmer, and a revoked
authorization each queue **zero** — with all three HTTP responses byte-identical; and the edit writes
listing facts with **zero inventory revisions**, so F-066's separation survives a new writer.

1293 unit / 710 integration tests, typecheck, lint, production build. No migration, no model seam.
**Merged nowhere and deployed nowhere** — branch `f-072-grandfathered-onboarding`, commit `5e1c596`.

---

## 2026-08-06 — the expanded stand card, redesigned around what's in stock

A design pass max asked for on the expanded card — specifically the "usually sells" and confirmed
stock blocks, and the card generally, built from scratch rather than carried over. He supplied an
e-commerce product page as a reference for hierarchy and use of space. What was taken from it was
its *typographic method* (one dominant fact, quiet uppercase section labels, weight spent
sparingly, space instead of boxes), not its layout — a product page is built around one price and
one buy button, and this card answers "what's here, how sure are we, how do I get there".

Two decisions were put to max rather than assumed, because both change the whole card: **stock
leads** (the confirmed items are the headline, not the farm's identity or the freshness caveat),
and **chips for confirmed items only**.

### The two voices are now told by SHAPE, not by two shades of the same shape

F-042 established that a farmer's confirmation and a seeded specialty are different kinds of claim
and must be distinguishable at a glance. They were a filled chip list and an outlined chip list —
which still gave a soft fact the countable shape of a stock list, so at speed the two blocks read
as one kind of claim in two tints. Now a confirmation is chips (discrete, countable, dated by a
label directly above the items it covers) and a specialty is a plain grey comma-joined sentence.
Prose cannot be mistaken for a stock list, and it leaves **no visual slot where a date would look
at home** — the no-timestamp rule stays enforced in `standListingLines`, and the styling stops
inviting a violation of it.

`StandListings` splits the elapsed phrase off `line.label` and reads `line.detail` instead. That
field is guaranteed present on a `confirmed` line and *never* on a `usual` one, so the split is
type-safe rather than a string slice off a rendered sentence — the failure `confirmedElapsed`
exists to prevent.

### Looking at it caught an honesty defect that the code review could not

On a stale stand the card rendered a green `CONFIRMED 6 DAYS AGO` directly above an amber
"May be out of date". Green is this map's colour for *a farmer vouched for this*, so the card was
saying trust this and don't trust this about one fact — the exact contradiction the recency design
exists to prevent. The timestamp now follows staleness into amber. This is a behaviour rule, so it
has its own sabotage-verified test rather than living only in CSS.

### The fourth staleness signal was removed, and the accessibility rule re-anchored

max flagged the "May be out of date — updated 6 days ago" line as not understandable. It was
genuinely confusing and this pass had made it worse: the card said one fact four times, and that
line sat inside `.detail-aside` next to "Get directions", where it read as a caveat about the
*route* rather than the produce. **Its placement was never a design decision** — the aside exists
to close a gap the old two-column detail grid opened between its children, and the staleness line
was grouped in to fix that layout hole, then rationalised afterwards in the comment.

It was NOT removed on the "it's redundant" reasoning alone. `globals.css` carries a documented
rule: staleness is never signalled by colour alone, because colour fails for a colourblind
customer and in bright sun, and this is the one signal the product cannot afford to have missed.
That rule was written when the timestamp was neutral. It no longer is — **two word-based signals
survive** (`Needs confirmation` beside the address, and the dated `Confirmed 6 days ago` above the
items), so the guarantee holds without the fourth line. The rule's comment was rewritten to
describe what actually carries it now, rather than a line that no longer exists.

**Removing a user-facing accessibility signal broke zero tests** — nothing guarded that rule, which
is how the line drifted into redundancy unnoticed in the first place. A test now asserts staleness
appears in readable *text* (not class names: a `.stand-summary-freshness` query passes against an
empty span). Sabotaged both ways — emptying the label and dropping the date each fail it.

### Deleted on the way through

The nested bordered inventory panel (a panel inside a panel spends a border and two paddings to
say what the gap already says), `.recency`/`.recency-stale` (no renderer left), the description
block's duplicate margin/border and its `.listing-label` override (now identical to the base rule),
`.sheet .detail-inventory`'s background, and `.detail-visit`'s own rule — section separators are
owned in one place, `.stand-detail-body`.

### Verified

1243 tests / 112 files, typecheck and lint clean. Three tests added, **each sabotage-verified**.
Browser-checked at desktop width and at phone width (the sheet, forced visible at 390px since the
window manager would not resize the window) — and the light-only palette confirmed **while the OS
sat in dark appearance**, which is the check DEVELOPMENT.md §before you ship requires and which
F-043 shipped five defects past. No model seam, schema, or projection changed, so no evals owed.
