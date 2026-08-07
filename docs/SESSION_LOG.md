# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps the **newest eight entries**; everything older rotates into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 60. A log too large to open
mid-session defeats its own purpose.

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

## 2026-08-05 — retiring a stand, re-issuing a lost onboarding link, and quieter admin chrome

Four small admin asks from max (F-071). Two were one-line changes; two turned out to have a real
design decision underneath, and both were put to max rather than assumed. Merged as PR #83.
**Not deployed** — migration `0022_stand_retirement` is not applied to production.

### "Delete a farm/stand" could only ever mean taking it off the map

Reading the schema settled it before asking: nearly every reference to `sales_locations` is
`on delete restrict` — `inventory_revisions`, `inventory_entries`, `stand_items`,
`stock_out_reports` — so **a hard DELETE fails at the constraint for any stand that has ever
published**, which is nearly all of them. Erasure would also erase the answer to "what did this
stand say it had, and when", which Golden Rule #1 and the audit trail exist to keep. max was asked
anyway, with the constraint stated, and chose "take it off the map, keep records".

**`retired_at` is deliberately not `is_public`.** That column is a *listing attribute the farmer's
own onboarding form writes on every save* (`onboarding-listing.ts` sets `is_public = true`), so an
operator decision expressed through it would be silently reverted the next time the farmer edited
their listing. One column owned by two actors is the failure; a separate operator-owned column is
the fix.

**The enforcement is at the publication seam, not in the caller.** `confirmInventoryPublication`
reads `retired_at` from the location row it had *already locked* at the top of the transaction, so
a retirement racing an in-flight confirmation resolves at the lock rather than by arrival order.
It deliberately does **not** gate the `no` branch: declining a prompt for a since-retired stand is
closing your own proposal, not publishing, and refusing it would strand that proposal open forever.

### A lost onboarding link is re-minted, never recovered

`farmer_invitations` stores only `token_hash`, and `createFarmerInvitation` returns the token
exactly once. So max's "view onboarding link" is not implementable as a view, and shouldn't be —
the password-reset argument. max chose "make a new link". The farmers page now lists farms with no
live authorization and mints a fresh link through the invite path that already existed, rather than
a second endpoint.

**"Unfinished" is the absence of a LIVE AUTHORIZATION, not an unredeemed invitation.** Those come
apart in both directions and each is a test: VIGA can authorize a farmer straight from the queue
with no invitation involved (that farm is finished, and keying on redemption would strand it in the
list forever), and a farm whose only farmer was revoked again has nobody who can update it. An
*expired* invitation keeps the farm listed rather than dropping it — a farmer who lost their link
usually notices after it lapsed, so hiding those would hide exactly the farms an operator came for.

### Three existing guards caught real defects rather than passing

The most valuable part of the session, and none of it was found by reading the code.

- **drizzle-kit silently omits CHECK constraints when it generates SQL.** The coherent-retirement
  invariant existed in `schema.ts` and in *nothing the database enforced*.
  `migration-metadata.test.ts` caught it by name. The constraint is now hand-written into the
  migration and verified **by effect** against a freshly migrated database: present in
  `pg_constraint`, and it refuses an insert carrying half a retirement.
- **The generated journal timestamp was LOWER than `0021`'s** (1785992670717 vs 1787000000000) —
  precisely the documented silent-skip condition, where drizzle applies only when
  `created_at < folderMillis` and reports success for a migration it skipped. Corrected by hand.
- **`closure.integration.test.ts` detects lock contention by matching `pg_stat_activity` query
  text**, and adding a column to the locked SELECT reduced its observed claimants to **zero while
  the test kept running**. It was re-anchored to the locked table plus `for update` — the
  constructs it actually proves — rather than to a column list that changes whenever a column is
  added, then re-sabotaged to confirm it still bites. This is the "anchor a source assertion to the
  construct it proves" lesson appearing in a *runtime* probe.

Stashing the branch proved the closure failure was ours rather than environmental, which is what
distinguished it from a flaky concurrency test.

### The admin stands route had no guard test at all

`/api/admin/stands` was missing from the "every admin route refuses an unauthorized caller" sweep
in `admin-routes.integration.test.ts` — a sweep whose entire stated purpose is that adding a route
without a guard shows up there rather than in production. It is now covered, which matters more
than before: the route now carries the power to take any stand off the public map.

### Verified

1240 unit / 688 integration, typecheck and lint clean, on the merged base. No `packages/ai` file
changed, so no evals are owed. Every new guard was sabotaged and confirmed to fail: the publication
check, **both public read filters independently** (map filter intact while breaking SMS, and the
reverse — `inquiry.ts` runs its own SQL, so the map passing proves nothing about the text reply),
the route's session guard, and the awaiting-onboarding revocation clause.

**No browser check was run, and it is not tracked as owed.** max's call at the wrap: he does his own
browser testing in a pass before go-live, so recording a per-tranche browser debt overstates what is
outstanding. Migration `0022` was applied to the **local sandbox only** (43 farms / 39 stands
unchanged, verified by effect); production is untouched, and max chose not to deploy this tranche.

---

## 2026-08-05 — structured listing facts, a geocoded draft pin, and roads on the island map

Two asks on the onboarding form (F-069), then the map (F-070). Both merged as PR #82 and **deployed**
(web `farm-friend-web-00032-msc`, worker `farm-friend-worker-00033-tp9`); no migration was owed.

### The structured fields already existed — nothing wrote them

max asked whether the form's free text should be structured, or passed through a model to
structure it. Reading the schema dissolved the choice: **F-035 built all of it in migration
`0005`** — `season_kind`, `open_hours_kind`, `stocking_cadence`, `stocking_days`, five CHECK
constraints — and the seeder was its only writer. `dawn_to_dusk` and `until_dusk`, which max
guessed at as options, were *already enum values*. So the onboarding form wrote prose into
`hours_text` and NULL into every column a filter can use, which is exactly the unfilterable shape
VIGA's existing map fails at.

**No migration, no model.** The model's real job here is F-064's ingest of the existing 31-farm
prose corpus — prose that already exists and cannot be re-asked. A farmer sitting in front of a
form is not that case: structured input is exact and free, and golden rule 3 means the model could
only propose anyway, so a confirmation step would sit *on top of* the picker rather than replace it.

**`coherentAvailability` mirrors the five constraints in memory.** The constraint is the guarantee;
the mirror is what turns a contradiction into `incoherent_availability` naming the group to fix
rather than a 500. It is asserted **directly** rather than only through stored rows, because a
sabotage proved the two layers can drift while every row assertion stays green — the database
applies its rule independently. The integration suite catches that drift with the real Postgres
violation, which is the evidence both layers are real.

**Payments are a closed set with a free-text tail.** "venmo"/"Venmo"/"VENMO" were three unjoinable
values in an unconstrained `method text` column. Canonicalizing is correct here and forbidden for
produce for a reason worth keeping straight: payment methods are a small VIGA-known set, so this is
a **spelling** table — folding "VENMO" decides how a word is written, folding "tomatoes" decides
something about the world. Unrecognized methods are kept verbatim or the set would silently lose a
real fact. **VIGA Farm Bucks is not offered**: acceptance is gated on `acceptanceRequiresEligibility`,
so a farmer ticking a box would be claiming a VIGA decision about themselves.

### The no-geocoder boundary was narrowed, not removed — max's call after pushback

max asked to geocode the typed address instead of dropping a pin. Pushed back first, because this
was a *decided* boundary with three things holding it: PRODUCT_BRIEF §launch decisions,
DEVELOPMENT §non-goals, and a tripwire in `architecture.test.ts`. The reason on record is that a
`StubMapProvider` once invented deterministic pseudo-coordinates near Vashon for **any** address
string, and a stand at a fabricated point is worse than one with no point — it sends a customer
somewhere real and wrong. Rural Vashon is where lookup is weakest, and a stand is frequently at the
road rather than the mailing address, which only the farmer knows.

max reaffirmed, and chose **draft-with-confirmation** over silent use. So the lookup is a
suggestion: off-island results are refused rather than shown (against `ISLAND_BOUNDS`, the single
statement of where the island is), the farmer confirms or taps to move it, only a confirmed
coordinate submits, and **every** failure — no result, no key, provider error, network error —
degrades to tapping the map, which is the pre-F-069 behaviour. A deployment with no
`GEOCODING_API_KEY` is fully supported.

**What did not reopen.** No SDK (a `fetch` to a REST endpoint, so the dependency tripwire stays
armed), no `MapProvider` seam, and one approved call site — `architecture.test.ts` now fails on a
*second* geocode caller rather than on any at all. The key is server-side, behind the invitation
token and its **own** throttle bucket, because a farmer refining an address makes several lookups
in a row and sharing the stock-out bucket would let either surface starve the other.

**Fixing that tripwire exposed a real weakness in it.** It matched raw source, so a comment
*explaining* why `StubMapProvider` is forbidden satisfied a search for `StubMapProvider` — a file
could be flagged for documenting the defect it avoids, and worse, a forbidden call hidden in a
string would have passed. It now strips comments and string literals before matching.

### Roads on the island map (F-070)

F-043 drew one road deliberately: "drawing the side roads would turn a legible poster into a street
map." That was right when the artwork only oriented a customer. **The onboarding form gave it a
second job** — it is now how a farmer says where their own stand is — and one spine gives them
almost nothing to place themselves against. max chose main arteries plus Westside Highway: twelve
roads, 101 vertices against the coastline's 246, residential grid excluded.

**Traced from OpenStreetMap through the same `projectToIsland` as the pins**, the discipline the
coastline and woods already follow. Vashon Highway itself was **replaced**: it was 13 hand-chosen
vertices whose own comment admitted guessing "put the line in the water twice". Westside Highway
stays **two chains** — OSM records it in pieces that do not share endpoints, and joining them would
draw pavement across a gap.

**The test that was nearly wrong.** A first version flagged any long span as a splice, which fired
on the highway's *real* 7km straight run between Vashon town and Burton (45m deviation across 164
source vertices) — it would have forced bending a straight road to satisfy a test. Replaced with a
**directness** check: a span longer than the road's own end-to-end distance is incoherent by
construction. The on-land test now samples by distance (~100m) rather than ten points per segment,
because the old density checked one point per 700m across that span — wide enough to miss an inlet.

**The render bug no test could catch.** The first rendered preview drew **twelve empty paths** — a
regex bug in the throwaway render script, not in the data. Every suite passed, because the suite
checks coordinates and nothing checks that a road reaches the screen. Caught only by looking at the
picture, which is the argument for looking.

### Verification

**1234 unit, 665 integration, typecheck, lint.** No `packages/ai` file changed, so no evals or
`evals:live` are owed. **Fourteen sabotages, each caught by a named test** — including the mirror
drifting from the constraints, an unconfirmed pin publishing, a second geocode caller, a road across
Quartermaster Harbour, and minor roads raised to highway weight.

**One sabotage escaped and was fixed:** a duplicate-weekday test used eight entries, so the *length
ceiling* refused it and the dedupe it named was never exercised — deleting the dedupe left it green.
Rewritten to two entries, which only the dedupe can refuse. Same family as the plural-normalizer
escape recorded in the entry below.

**Owed before this is trustworthy:** a real browser round trip, and **one live geocoding call
against the real provider** — every test injects the provider, so the real request/response shape is
unverified and the path has never made a billed call.

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

### The admin surface still described the old world (max, mid-wrap)

max: *"the admin needs updated based on the new no-approval for new farms."* Checked against
production rather than reasoned from the code, and the finding was sharper than expected: **all 35
seeded farms sat in the approval queue**, each with a stand already live on the public map.

**Approving them changed nothing a customer sees**, which is the part worth remembering.
`listPublicStands` gates on `is_public` — **not** on approval — so a seeded stand is visible whether
or not its farm is approved. What `farm_approvals` actually gates is whether the **farmer may
publish an update**: `confirmProposal` and the scheduled prompts both re-read it. So the queue was
presenting 35 items as pending VIGA action, where acting changed only a farmer's ability to correct
their own listing — and VIGA had already decided those farms participate by putting them on the map.

max chose to approve all 35 and keep the queue. Written insert-only and idempotent against the
partial unique index (the arbiter, not a preceding read), attributed to the board account,
fingerprinted before writing, and verified by effect: queue empty, 35 locations untouched, and a
re-run writes zero. `scripts/approve-seeded-farms.ts` is retained and safe to re-run.

**Copy corrected in three places, each of which had become false rather than merely stale:** the
dashboard tile (approval is now the exception, reached only by the three uninvited paths), the
section note (which claimed approval is what lets stands "appear to customers" — it never was), and
the empty state, which read as "nothing to do *yet*" when an empty queue is now the normal healthy
outcome. A test pins the empty-state claim; sabotaging the copy fails it. ADMIN_OPERATIONS.md gets
the same publish-vs-visible distinction.

Deployed as `84c512d` → `farm-friend-web-00031-qn9` / `farm-friend-worker-00032-fbt`, plan
`0 add / 2 change / 0 destroy`, assertions 37/37, and the public map verified unchanged afterwards
(34 stands, 33 with items) — the approval write touched publishing rights only, as intended.

**One verification defect worth recording:** the first check invented a constraint name
(`inventory_revisions_coherent_source`) and reported a FAIL against a migration that was fine. The
name is now read from the migration file. A verification script that asserts the wrong thing is
indistinguishable from a broken migration until you look.
