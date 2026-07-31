# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps the **newest eight entries**; everything older rotates into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 40. A log too large to open
mid-session defeats its own purpose.

---

## 2026-07-30 (latest) — F-043's poster pass: the map made to look like VIGA's, and two defects live in production

max compared the deployed map against the **actual poster image** — supplied this session for the
first time; the previous palette was derived from a *description* of it — and it did not read as
VIGA's map. The styling work is the small part of this entry. **The interesting part is that
making it look right surfaced two defects that were live in production, and the reason neither
was catchable was a verification method that had never actually worked.**

### The verification gap: the phone layout had never been on screen

The previous session recorded "LOOKED AT IN A REAL BROWSER … at phone and desktop widths" as the
criterion being met. It was not. `resize_window` resizes the *window*, and on this setup the
frame's `innerWidth` stayed **1728** while the window was 728 — so every "phone width" check ran
against the wide layout. The phone arrangement, which is the primary one, had never rendered.

**The fix is to load the page in a 390px iframe**, where the media queries evaluate against a real
phone width. That immediately exposed both production defects below. Anything measured through
`resize_window` in past entries should be treated as unverified.

Contrast is now **measured, not eyeballed** — a small script reads the computed tokens and
computes WCAG ratios. The new wooded areas first landed at **1.29:1 against the land in dark
mode**: invisible, and the same class of miss as F-043's original dark-mode defect.

### Two defects that were live in production

**Two place labels were anchored in open water.** Burton sat ~90m offshore in Quartermaster
Harbour; **Maury Island sat a full kilometre offshore** — nothing is at that latitude on Maury.
Neither was catchable: `island-geometry.test.ts` asserted farm coordinates and the highway against
the drawn polygon, but place labels are *artwork* and no assertion touched them. The test now
covers every non-ferry label (ferry docks exempt **by name** — a terminal genuinely is on water).

**The pins were too small to tap.** At a true 390px viewport the map renders at **0.351 scale**,
so the shipped `r=14` came out **under 5px on glass** — roughly a 10px target for the map's
primary action, against the ~44px a finger needs. Now `r=26`. This predates this session; adding
numbers to the pins is what made it visible.

### The numbering rule, and why alphabetical rather than positional

VIGA's poster numbers every stand and keys the pin to a list entry. It can do that trivially
because its order never changes. Ours re-sorts by distance the moment a customer shares location,
and filters narrow it constantly.

So `numberStands` (`map-view.ts`) assigns **alphabetically by farm, keyed to the farm rather than
the row**. Sorting and filtering reorder cards and renumber nothing. A positional number would
relabel all 32 pins the instant someone tapped "Sort by distance" — authoritative-looking and
wrong, and it would break the number a customer read on the poster a minute earlier. Ties break on
`id`, so a farm with two locations still gets two distinct numbers. Numbering runs over the
**full** set *before* filtering, for the same reason.

**One sabotage initially survived here and is worth remembering**: asserting that duplicate farm
names get *distinct* numbers passes even with the `id` tiebreak removed, because a stable sort
falls back to input order. Distinctness was the wrong property; the right one is **invariance
under reordering**, and that assertion catches it.

### Not every real feature belongs on the drawing

The wooded parks are real OSM polygons (`leisure=nature_reserve` / `landuse=forest` /
`natural=wood` / `leisure=park`), projected through the **same** `projectToIsland` as the pins and
the shore — a hand-drawn blob would be a third independent statement about where the island is,
which is the defect that once put 16 farms in open water.

Two exclusions, both decided by looking:

- **Fisher Pond and Fisher Creek** are stored by OSM as four-corner **parcel boundaries** and
  rendered as literal rectangles — they read as buildings, not woodland. Source vertex count
  (<9) is now the exclusion rule, because no amount of gentle simplification turns a rectangle
  into a forest. This is also why the survivors are **not** simplified at all: the first pass
  flattened them into boxes too.
- **Banner Forest**, though printed on VIGA's poster, has its OSM feature at **-122.56 on the
  Kitsap Peninsula**. On the poster it is mainland context in the water margin, not a Vashon
  landmark. Drawing it on the island would have been a fabrication.

The coastline was re-traced from OSM (4,881 nodes / 109 ways) and simplified at 25m rather than
90m: **246 vertices, up from 92**. Past 25m the count climbs with no visible difference at phone
width.

### Light mode only (max's call)

Dark mode is gone from the public map. It was an accommodation rather than a design: a second
value for every brand token, and each one a place the two themes could silently disagree — which
they did, twice now. `color-scheme: light` is **required**, not decoration: without it a browser
on a dark-mode machine still paints the `IN SEASON` select and the scrollbars dark, giving a light
page with dark widgets in it.

**Known tradeoff, accepted by max**: checking a stand outdoors at night is now a bright screen.
That is a real scenario for this product, and it is the cost of one honest design over two
half-verified ones.

Verified in the **served bytes** rather than the source: zero `prefers-color-scheme` rules,
`color-scheme: light` present, every dark token value absent, every light value present. And
proven under the condition that matters — this machine is in dark mode, and the page renders
light with no emulation.

### Also removed: the page's own title

The map is embedded in VIGA's Squarespace page, which carries the association's name and its own
heading, so the eyebrow and `<h1>` were the frame introducing itself to someone already reading
it. **The honor-system line stays**, shortened to a caption: it is why every listing says
"confirmed 4 hours ago" instead of claiming stock, and without it the recency wording reads as
hedging rather than as the product's whole point.

### Verified by effect, against the real corpus

34 cards / 32 pins (the two contact-only farms numbered but unpinned, per F-038); numbers 1–34, no
duplicates, every pin's number matching its card, order genuinely alphabetical. Toggling
`Open now` narrowed 34 → **26** with **zero renumbered**, and restoring returned identical
numbers — the filter did something, so the pass is not vacuous. The bottom sheet raises with 524px
of map still visible, carries the number, dismisses cleanly and clears selection. No horizontal
overflow at 390px. **12 "Hours not listed"** badges, matching the 12 stands that state no hours —
the honesty constraint intact.

Fixed in passing: the sheet's heading concatenated to `"12Holmestead Farms"`. The badge is
`aria-hidden` so a screen reader was already correct, but the name is now its own element, making
that structural rather than incidental. The card headings were already clean.

**Suites**: `npm test` **726/726** (69 files, +7); `test:integration` **403/403** (22 files) on
real Postgres from empty; typecheck and lint clean; evals 11/11 + 4/4 + 29/29. `evals:live` not
required — web-only, no seam projection, schema, or output contract changed.

**F-043 is closed.** The Squarespace embed handshake — the one acceptance criterion it could never
meet, because it needs a second origin — is split out as **F-044** rather than held open as a tail
on a finished item. Until VIGA pastes the listener the embed still works, falling back to the
fixed `height="900"`.

## 2026-07-30 — F-043 built: the interactive island map, and the defect a green suite could not see

The map becomes an island view with filters and a linked stand list. The build itself was
straightforward — the design was settled in the PM item. **The interesting part is that the worst
defect in the work passed 719 tests, a rendered-bytes inspection, and my own reading of the code,
and was only visible when I looked at a picture of it.**

### The gating check changed the design before any code

The item's own note flagged it: the availability columns might not be populated. Measured against
production first, and the answer moved the design — season 85% (29/34), hours 65% (22/34), and
**`open_days` at 0% island-wide**, though 14 stands state a `specific_days` restocking cadence. So
`Open now` is season + time-of-day only; the weekday branch is implemented because the schema
permits it, but nothing feeds it and nothing may assume it does.

Also found: **F-035's note naming Green Ears and Morgan Hill as unparseable is stale.** Both parse
cleanly. The four real open flags are Holmestead and Open Gate (season) plus Peak Moon and Sweet
Alyssum — and those two are **address** flags, not availability. Recorded so it is not re-derived.

### Three states, because a boolean would have to lie

12 of 34 public stands state no hours. A boolean `isOpenNow` has to call those `false`, which
asserts a farmer said "closed" when the farmer said nothing at all. So `openNow` returns a state,
`unknown` is first-class, and the filter keeps unknown stands while the card badges them "Hours not
listed". max decided this: shown-but-marked, never hidden, never reported shut.

The rule generalizes to every filter — *a stand that never stated a fact is never excluded by a
filter over that fact*. Verified against the real corpus through the running app: all 12 survive,
0 dropped.

### The sun is computed, and checked against someone else's numbers

Migration 0005 refuses to store dawn/dusk as clock times because dusk on Vashon moves ~5 hours
across the year. `daylight.ts` computes the real sun instead — pure arithmetic, no provider, no key.

The test anchors to **US Naval Observatory** published times rather than to this implementation's
own output captured as a golden file. That distinction earned its keep immediately: it caught two
transcription errors in my first draft of the test (Jan 15 sunset 16:38 → 16:47, Jun 21 sunrise
05:11 → 05:13). A self-generated fixture passes against an algorithm that is wrong in the same way
it is.

Verified by effect: `Open now` returns **31** stands at 1pm and **18** at 2am.

### The defect worth the entry: the artwork and the projection disagreed

The first hand-drawn coastline put **16 of 32 real farms in open water**. Every test passed. The
projection was correct and internally consistent — and *nothing compared the drawing to it*. A
drawn map and projected pins are two independent statements about where the island is; they agree
only if something makes them, and nothing did.

A second hand-drawn attempt fixed the farms and collapsed Quartermaster Harbour to a sliver,
because the farm positions constrain a hand-guess far more tightly than the real coast does.
Resolved by tracing the actual shoreline (OpenStreetMap `natural=coastline`, 4,961 nodes → one
closed ring → Douglas-Peucker to 92 vertices, baked in as a static array — no runtime seam). It
satisfied all 32 farms with **zero** tuning.

**The structural fix matters more than the shape.** The geometry now lives in
`apps/web/lib/island-geometry.ts` because `vitest.config.ts` covers `apps/*/lib` and **not**
`apps/*/app` — a coastline defined beside its component is untestable by construction. The test
checks every real farm coordinate *and* samples the highway route against the drawn polygon.

### Then the browser found five more that bytes cannot

The "someone looks at it" criterion is the one F-042 and F-040 both still owe, and it paid for
itself. Every one of these passed the full suite and a rendered-bytes inspection:

1. **`globals.css` has carried a `prefers-color-scheme: dark` block since F-017.** The new VIGA
   brand tokens had no dark values, so the island rendered as a bright cream slab on a near-black
   page — worst on a phone at night, exactly when someone checks whether a stand is open.
2. **The highway** was drawn in the water colour: a channel through sage in daylight, a dark scar
   on dark land at night. It has its own `--road` token per theme now.
3. **The island was taller than the phone screen** — 828px on a 737px viewport, first stand card
   1293px down. A customer opened the map and saw only map.
4. **SVG type scales with the viewBox**, so capping that height shrank place labels to ~11px on
   glass. The first fix **silently did nothing**: a second `.island-place` rule placed *above* the
   original lost on source order.
5. **Clicking a pin drew the browser's blue focus rectangle** around a round pin — `:focus-visible`
   rather than `:focus`.

Bytes prove markup and geometry. They do not prove CSS.

### max's design pass, from the actual poster

Two structural notes and one artefact:

- **Filters moved above the map and list.** Between the two they read as a caption on the map — a
  control belonging to the picture rather than the screen, easy to scroll past on a phone.
- **Map tap raises a bottom sheet instead of scrolling.** The old smooth scroll travelled ~800px to
  a card, throwing away the map being read. The sheet keeps the map visible (294px of it, measured)
  and dismisses back to the same view. Explicitly *not* "hide all other listings": that would leave
  the map as the only route back to the full set, so a later filter change would appear to do
  nothing.
- **max supplied VIGA's printed farm map.** It is **pale land on soft grey-green water with a cream
  list panel** — the opposite weighting from my inference of "sage island on cream", and the reason
  to work from the artefact rather than a description of it. Pins take the poster's green; brick red
  is a *text* colour there, so a map of brick dots was a misreading of the brand.

Dark mode is not the poster with the lights off — inverting naively gave dim green pins on dim green
land. Land stays muted, pins go bright, so figure/ground survives even though both colours move.

One thing deliberately **not** copied: the poster's legend uses colour alone for "open year round"
vs "open til late November". The three-signal rule holds; the cards carry words.

### Verified and owed

719/719 unit (69 files), 403/403 integration from empty, typecheck/lint clean, evals 11/11 + 4/4 +
29/29. `evals:live` correctly not required — no seam projection, schema, or output contract
changed. Model-free and architecture tripwires pass. ~20 sabotages, all caught.

**Deployed the same session** — revisions `farm-friend-web-00010-7mc` /
`farm-friend-worker-00011-l2w`, digest `sha256:b9a020f1…`, no migration owed. Verified by effect in
production: 34 stands / 212 tags / 29 seasons / 22 hours on the API, and the served page carries the
island, 32 pins, all five filters, 12 "Hours not listed" badges and 33 "Usually sells:" lines.

**Owed: the Squarespace embed handshake**, which needs a second origin to frame the page and was
not exercised. Everything else on the item is verified, including the browser check.

## 2026-07-30 — F-040 built: farmer onboarding, and six sabotages that were the real work

One tranche, all five pieces max scoped. The build was largely mechanical — the design was settled
in the PM item and not re-litigated. **The interesting part is that six of my own assertions were
wrong, and only sabotage found them.** Two of those were guarantees the whole item rests on.

### The gap this closes

`farmer_authorizations` had existed since the clean launch with **no writer outside test fixtures**.
Publishing demands one, so a real farmer texting an update resolved to no authorization, fell
through to the *customer* branch, and nothing reported why — behind a fully green suite, because
every publication test inserted the row it was supposed to be proving. The same shape as F-024's
silent stub and B-002's un-run seeder: a green check covering less than its name implies.

### The link is deliberately not a signed claim

max chose a link that never expires until revoked. The obvious implementation is `magic-link.ts`'s
mechanism — a signed, expiring claim — and it is **exactly wrong here**. A signature is stateless:
it says "authentic" any number of times, so a revoked farmer's link would keep verifying forever
with nothing able to say otherwise. Revocation is the only safety net this design has, so the link
must be a *lookup key into a row someone can withdraw*, never something a verifier can validate on
its own.

So `farmer_links` holds 32 random bytes, hash-only, and `resolveFarmerLink` re-reads **both**
revocation columns on every request. No denormalized farm id, no cached "active" flag, no claim in
the token. There is nothing to cache around because there is nothing cached.

The two records split for the same reason: `farmer_onboarding_requests` is what a farmer *asked*
for — no farm, no grant column, no message text — and is the one record on the page writable from
unauthenticated inbound SMS. It cannot become authority because it has no field that could.

### Where the schema pushed back, correctly

`activateWebProposal` first tried to open the confirmation window without an outbox row, and
`inventory_publication_proposals_activation_coherent` refused it. That constraint encodes "a
proposal is committable only once a prompt the farmer was shown was accepted" — satisfying its
shape with a NULL would have hollowed it out. The fix was to make the web path *earn* it: it queues
a real confirmation SMS and activates against that. The farmer gets a receipt on the channel they
trust, which is worth having anyway — a browser tab is not a receipt.

### The six survivors

~35 sabotages. Six survived, each exposing a test that looked like it proved something and did not:

1. **The resolver's authorization check was untested.** Revoking through the writer also revokes the
   links, so deleting `auth.revoked_at is null` still passed — the *link* clause was doing all the
   work. Fixed by revoking the authorization directly, leaving the link row open, and asserting the
   link row is still open so the test cannot silently decay back into the other one.
2. **The one-stand-per-link guard was untested** — no fixture had a farm with two stands, so "the
   link names ONE stand" was unverifiable.
3. **A `contactHash` leak into the pending-request projection survived the whole suite**, because
   the fixture had an authorization and no open request: the array it leaked from was empty. Both
   arrays are now populated and asserted non-empty *before* the privacy assertions run.
4. **The cross-farmer confirmation test was satisfiable by the exact attack it forbade.** Reading
   the sender hash from the *named proposal* rather than the attacker's own token makes the attacker
   **become** the victim — so the gate matches, publishes on the victim's behalf, and consumes their
   proposal. "Refused" and "still open" were the only assertions; the second was false but nothing
   else checked was. Now asserts the proposal is UNCONSUMED.
5. **Two independent defenses were indistinguishable to the suite.** Sender-from-token and
   activation-scoped-to-sender each refuse the cross-farmer attack alone, so removing either one
   passed. Redundant defenses are worth having; redundant defenses nobody can tell apart are how one
   gets deleted as dead code later. Each is now isolated by its own test.
6. **The token shape guard returned null with or without the regex**, since no row matches garbage.
   What it actually buys is that garbage never reaches the driver — now asserted by *query count*,
   with a well-formed token proving the counter is not stuck at zero.

The general lesson, worth carrying: **an assertion on a refusal is weak.** "It refused" is satisfied
by refusing for the wrong reason, or by a fixture too thin to exercise the path. Assert the durable
effect — the row unconsumed, the array non-empty, the query count zero.

### Approval is not consent, and the category is what keeps it true

The "you're all set" text is queued inside the authorization transaction, as a **proactive**
category. So `authorizeDispatch` re-reads consent at the claim and suppresses it for a farmer who
never texted JOIN/START. Asserted at the dispatch claim rather than the queue — that is where the
guarantee lives — **plus the complement**, because a notification nobody can ever receive would
satisfy the suppression test perfectly.

`SIGNUP`/`LINK` are parsed **last** among keyword branches so neither can shadow `STOP`, and
**before** free text so no model sees them. Moving the branch after free text fails 7 tests.

### Verified by effect, twice

Whole journey against real Postgres and the running app: SIGNUP → masked queue → authorize (text
queued, `inventory_prompt`, `queued`) → LINK → resolve → propose (**0 revisions**) → confirm
(published) → revoke (link resolves null on the *next* request, form refuses, published listing
untouched).

Then again through the **real HTTP route with the real model**. Two things worth recording:

- Mistral rendered **"plum jam" twice**, once bare and once priced. Interpretation quality, not a
  code defect — and precisely what the confirmation gate exists to let a farmer catch.
- An earlier "real model" run **actually hit the stub**: the previous dev server had not died and
  the new one failed `EADDRINUSE`, which I only caught by grepping the log. A stub clarification
  reads *identically* to a real refusal. Redone on a genuinely free port.

### Two tripwires earned their place

`workspace-manifests.test.ts` caught a real missing manifest entry (the new segment test made
`packages/sms` import `@farm-friend/core`, an edge the architecture permits but the manifest did not
declare). `schema.integration.test.ts` caught the two new tables missing from its pinned list.

### Deployed the same session

Merged as `8ae9af2` (PR #62), then **migration 0009 first, image second** — the order the RUNBOOK
insists on, because deploying the image alone would have shipped code whose tables did not exist.
Production fingerprinted immediately before and after: every pre-existing count unchanged, both new
tables empty, 8 → **9 migrations**. Revisions `farm-friend-web-00009-pvm` /
`farm-friend-worker-00010-zdn`, digest `sha256:ed998c4c…`; plan read leaf by leaf (exactly one real
leaf per service), 29/29 plan assertions, deploy + served-card assertions PASSED.

**F-042 went out in the same image**, so the 212 tags reached customers for the first time — the
map now serves them across 33 of 34 public stands.

### Owed

**Nobody has looked at the screens.** `/stand/<token>` and `/admin/farmers` serve correct markup and
CSS classes — verified by fetching the rendered HTML — but the styling has **not been seen
rendered**; the browser extension was not connected. Same debt F-042 carries. Also renamed the page
namespace to `farmer-form` mid-build after finding `.stand` is the public map's *card* class: a
page-level `.stand` would have inherited card padding, a border, and a green left rule.

---

## 2026-07-29 — F-042 built: the offering tags reach customers, and a rule that had to leave the JSX

One item, built to copy that was already approved, so the interesting part is not the vocabulary —
it was settled last session — but **where the load-bearing rule ended up living, and why it could not
stay in the markup.**

### The defect: seeding was necessary and not sufficient

212 offering tags across 33 of 35 stands, and no customer could see one of them.
`listPublicStands` never selected `sales_location_offerings`, so the API exposed no offerings field
and every tagged stand rendered *"No listing yet"* while the database knew it sold eggs. F-041
delivered the data and proved it by effect; this was the reader half, filed separately so the
distinction stayed visible.

### The rule had to leave the JSX to be testable at all

max's approved copy rests on one rule: **"Usually sells" never takes a timestamp**, because a date
beside it reads as a confirmation nobody made — the same class of failure B-013 caught on the recency
fields.

The obvious implementation is a conditional chain in `stand-map.tsx`. That was rejected on discovery
that **this repo has no component-rendering harness** — no jsdom, no testing-library, and
`stand-map.tsx` has never had a test. A rule that load-bearing sitting in untested markup is a
guarantee that is not a tested invariant, which by the project's own standard is not a guarantee.

So the whole "which lines does this stand get" decision moved into `standListingLines`, a pure
function in `map-view.ts` — the module that already exists precisely because "everything that could
be WRONG about the map is decided here, where a test can hold it to account." `stand-map.tsx` now
prints its output and chooses nothing: no `stand.updated` check, no `items.length` check, no
`visitability` check. `detail` is settable only on a confirmed line, and the usual line's label is a
constant with no interpolation available to it.

The function subsumed the pre-existing F-038/B-013 conditional chain too, so there is one mechanism
rather than two — the confirmed-empty sentence and the contact-only sentence are now line *kinds*
alongside the new ones.

### One arithmetic, two voices

The map's heading needed "Confirmed 4 hours ago" while SMS says "updated 4 hours ago", and
`renderRecency` hard-coded the verb. Two options: slice the verb off the string downstream, or split
the arithmetic. Split it — `renderElapsed` renders the bare phrase and `renderRecency` is that phrase
prefixed. A client stripping a verb off a sentence would be one wording change from printing garbage.

**This is why `evals:live` was not required, and the claim is measured rather than argued:**
`renderRecency`'s output was compared against the previous implementation across **57,601
minute-by-minute cases over 40 days — byte-identical**. No seam projection, schema, or output
contract changed; `packages/ai` references none of these symbols.

### The cross product that a second join would have caused

Selecting the tags via `left join sales_location_offerings` alongside `inventory_entries` makes the
query a **cross product**: 3 tags × 2 confirmed items is 6 rows, and the accumulating loop would push
each item three times and each tag twice. Every duplicate reads as a real second item on the card.
Aggregated in a subquery instead, keeping the row grain at one-per-inventory-entry, which is what the
loop already assumed. `coalesce(…, array[]::text[])` because an aggregate over no rows is NULL, not
an empty array — and the untagged stands are the majority, so that is the common path.

### A divergence found on the way through

`page.tsx` held a **second hand-written copy of the wire format**, and the copies had already drifted:
the page sent `updated: undefined` and `stale: undefined` as *present keys* where the API omitted
them, so "nobody has confirmed this" reached the browser differently depending on which reader
produced it. Both now call one `serializePublicStand`, typed to `PublicStandPayload` so the compiler
holds the contract instead of two object literals agreeing by habit.

### The asymmetry that is deliberate, and the sabotage that caught it

`usuallySells` is **always sent, `[]` when empty**; the three recency fields are **absent when
empty**. That looks like an inconsistency worth tidying, and it is load-bearing: an empty tag list is
a complete honest answer, whereas "no confirmation" and "confirmed nothing" are different facts only
absence can distinguish.

**20 sabotages were run; 19 were caught immediately. One survived** — omitting `usuallySells` when
empty passed the *entire* suite, unit and integration, because the renderer treats absent and empty
alike by design and no test asserted the wire shape. That is exactly the "tidy up the asymmetry"
regression, and it would have reached production silently. It now has its own assertion, anchored on
`"usuallySells" in stand` rather than a value comparison.

### Verified by effect, against the real corpus

Not by a passing suite. A local database built from `maps/offerings-proposals.json` — **34 stands, 33
tagged, 212 tags, matching the production fingerprint** — served through the real app, then the
*rendered bytes* read: 33 "Usually sells:" + 33 "Nothing confirmed recently.", exactly **1** "No
listing yet", and **no elapsed phrase within 400 characters of any usual label**. Then a real
revision published through the real proposal→confirmation chain on a 7-tag stand with 2 items
confirmed produced *"Confirmed 4 hours ago: flowers, duck eggs"* over *"Also usually sells:
vegetables, fruit, chicken eggs, plant starts, leafy greens"* — the confirmed items subtracted
case-insensitively, because tags come from VIGA's form text and confirmations arrive in a farmer's
own SMS and nothing normalizes casing between them.

### A tripwire worth recording

Running `next dev` **clobbers `.next/`**, and B-025's `contact-card-build.test.ts` reads the
production build output. It fails with "no built chunk containing BEGIN:VCARD" — which looks like a
CRLF regression on the very thing B-025 just fixed, and is purely environmental. A rebuild clears it.
Noted in CURRENT_STATE so it is not re-diagnosed.

### Owed

**Nobody has looked at the map.** The two voices are styled to differ at a glance — filled green
chips for a confirmation, outlined for a tag — but that CSS has **not been seen rendered**: the Chrome
extension was not connected when the check was attempted, twice. The copy, counts, ordering, and the
no-timestamp rule are all verified on the rendered bytes; the visual distinction is not.

F-040 (farmer onboarding) was opened next and stopped before any code: its five pieces — SMS request,
VIGA approval, the "you're set up" text, the farmer web form behind a never-expiring link, and
revocation — split naturally, and the web form is the only part that creates a new risk surface while
also being the only part a farmer does not strictly need (SMS publishing already works). That scope
call is max's and is the first thing the next session settles.

---

## 2026-07-30 — B-025 was the minifier, not the network; B-023 closed; F-042's vocabulary settled

Three items, each verified by effect rather than by a passing command. The headline: **B-025's filed
diagnosis was wrong in both directions**, and following it would have produced a fix that changed
nothing.

### B-025 — a template literal, not Next.js and not the proxy

Filed as "the Next.js response path or the proxy layer is normalizing the body", with the note **"NO
LOCAL TEST CAN SEE THIS."** Both premises were false, and measuring rather than accepting them is the
whole story.

It reproduces on a **local standalone build** — 147 bytes, 0 CR, identical to production. So the
network was never involved. Probing the layers in order:

- A plain Node HTTP server relaying the same `Response`: CRLF intact.
- All three Next.js body forms — string, `Buffer` with explicit `content-length`, `ReadableStream`:
  **all three preserve CRLF byte-for-byte.** The candidate fix in the bug report (return a
  Uint8Array/Buffer with an explicit content-length) would have changed *nothing*, because the
  plain string already works.

The real cause is the **build**. The minifier folds `[...].join("\r\n")` into a single template
literal and writes the separators as **raw CR and LF bytes in the source text** — not as the escape
sequence. ECMA-262 normalizes a literal CRLF inside a template literal to a single LF at *parse*
time (§12.9.6), so the CR was gone before the string ever existed at runtime. The renderer was
correct, its CRLF assertion was correct, and both were irrelevant.

**One wrong turn worth recording**, because the correct-looking evidence pointed the wrong way:
grepping the built chunk showed `join("\n")` and no `join("\r\n")`, which reads as "the minifier
rewrote the separator." It hadn't — a raw **byte** dump showed genuine `\r\n` in the template. The
lesson is the repo's own: grep output is text about bytes, not the bytes. Only `python3 -c` on the
raw file settled it.

**The fix is `String.fromCharCode(13, 10)`.** It emits no newline byte into the bundle, so there is
nothing for a parser to normalize — the property holds *by construction* rather than by a minifier's
cooperation. This is the one place in the codebase where an obvious literal is deliberately refused,
so the reasoning lives in the code, not here.

**Why the test had to read the build output.** A unit test on the renderer cannot see this: vitest
runs unminified TypeScript, where the join is still a join. That is precisely why B-025 shipped with
a green suite. `apps/web/lib/contact-card-build.test.ts` therefore asserts against the built chunk,
bounded to the card's own region so a stray `\r\n` elsewhere in a 300KB bundle cannot satisfy it.
Sabotaged back to the literal: both assertions fail.

**Verified by effect on the wire, twice** — locally (153 bytes / 6 CRLF, `file(1)` reads "vCard
visiting card, version 3.0"), then in production on both HTTP/1.1 and HTTP/2 after the deploy, by
hex dump independent of our own checker.

### The deploy-time check, because a bare-LF card passes every other check

`infra/served_card_assertions.py`. B-025 survived a full deployment while returning 200 with the
right media type, the right display name, and the right number — **every check short of counting the
separator bytes passed**, and a malformed vCard fails by opening *nothing* on the handset, which is
indistinguishable from a working tap.

Kept **separate** from `deploy_assertions.py` on purpose: that script is metadata-only and never makes
an HTTP request. Same pure-core/impure-shell split, so its tests construct payloads directly —
including the exact 147-byte production body, with an assertion that the good and bad cards differ by
**precisely six CR bytes and nothing else**.

Proven end to end, not merely unit-tested: pointed at a rebuild carrying the original defect it exits
1 reporting "6 BARE LF and 0 CRLF"; pointed at the fixed build it passes with the real 153/6/0.
Sabotaged four ways (removed the bare-LF branch, zeroed its count, accepted any content-type, dropped
the empty-body guard) — each caught, and notably removing the B-025 branch does **not** hide behind
the neighbouring "no CRLF at all" assertion. Wired in as step 6 of the RUNBOOK deploy sequence.

### B-023 — the first administrator is `board@vigavashon.org`

max chose a VIGA **org** address over a personal one, so authority sits with the organization from
the start. max ran the write himself; the row was then **verified by reading it**, not accepted on
report — 1 live row, `authorized_at` 2026-07-30T01:32:05Z, `revoked_at` null, and every other table
unchanged.

Verification went one step past "the row exists" to "the row is *usable*": `findAdministratorByEmail`
resolves it in production for the exact address, for mixed case, and with stray whitespace, while an
unrelated address still returns no administrator. Rehearsed first on a throwaway local database from
empty, confirming the script writes one row and is genuinely idempotent (second run: "already an
administrator", exit 0).

**Still not self-service.** No mail provider (F-031), so nobody receives a sign-in link — the link
must be minted out of band. The row makes sign-in *possible*, not *delivered*. **B-023 was F-040's
blocker, so farmer onboarding is now unblocked.**

### F-042 — the vocabulary, settled before any code

The 212 tags are what a farmer *usually* has, from the 2026 form. They are **not** a confirmation of
current stock, and the product's honesty rests on that gap staying visible. Two distinct facts needed
two distinct voices:

- **Usual range** (all 33 tagged stands): *"Usually sells: salad greens, tomatoes, flowers"* followed
  by *"Nothing confirmed recently."*
- **Confirmed stock** (0 stands today): *"Confirmed 4 hours ago: …"* with *"Also usually sells: …"*
  beneath it.

Three rules, and the first is the load-bearing one: **"Usually sells" never takes a timestamp** — a
date beside it reads as a confirmation, which is exactly the failure. The stock-out flow stays
attached to confirmed items only (reporting "the tomatoes are out" against a tag nobody confirmed is
noise for the farmer), and *"No listing yet"* survives for the 2 untagged stands, where it is still
true.

Wording chosen deliberately: **"sells" over "carries"** — "carries" implies a shop with shelves, and
these are mostly unattended honor-system tables. And the plain *"Nothing confirmed recently."* over a
friendlier "call ahead or take a chance", which nudges toward risk in VIGA's voice rather than simply
stating the absence. **Copy is approved; nothing is built.**

---

## 2026-07-29 — F-041 offerings seeded, F-039 the vCard, and a farmer's address we should never have published

A subagent session: two items built in isolated worktrees, both verified by the coordinator rather
than relayed. Then the offerings seed, which found something more important than itself.

### Both agents died uncommitted, and verifying rather than trusting caught two real defects

A session limit killed both agents mid-edit with **nothing committed** — the exact "reported
completion with uncommitted work" hazard the standing rules name, except neither got as far as
reporting. Recovering their worktrees and re-running everything found two defects in work that
otherwise looked finished:

- **F-041 had a typecheck failure** at the line the agent died on (`indexLocationsByMatchKey(sql: Sql)`
  called with a `Tx`; the two are deliberately distinct types).
- **F-041's ambiguity test leaked its fixture.** It seeded two colliding stands and left them in the
  shared database, so the *next* test inherited the collision and threw. It read as a defect in the
  dry run; it was test isolation. **An ambiguity is a whole-database property, not a per-call one** —
  a leaked colliding pair makes every later call in the suite throw. Had the agent's report been
  relayed, this would have been a reported green that wasn't.
- **F-039 had no route at all.** The renderer and its tests existed; `apps/web/lib/contact-card.ts`
  and the route file did not, so the test file could not even load. Resumed the agent to finish it.

### F-041 — key the loader through the seed join's own normalization

`seedOfferings` matched `sales_locations.name` as an exact string, but the approved artifact records
each farm's **map-export** name while the seed stores the **form** name. Measured against production:
26 of 31 matched; five were silently reported unknown and given no tags. Fixed by reusing
`matchStandName` — one mechanism, two consumers — rather than regenerating the artifact, so the loader
survives the *next* naming difference. An ambiguous name **refuses the whole batch**, on the same
reasoning the join itself uses: a wrongly joined pair is silently wrong, a missed one is a reported
refusal. Measured after: **31/31, 0 unmatched, 0 ambiguous collisions across 35 stands.**

**`--dry-run` now resolves against the database** (`planOfferings`), printing `Aeggy's -> "Aeggy's
Farm"` when names differ. The old dry run only echoed the file, so it reported 31 entries while 26
could land — *that* is how the five stayed invisible. A dry run that cannot see the database cannot
show the facts a reviewer needs, so `DATABASE_URL` is now required for one.

### Why four farms had no tags — not "newer", structurally unreachable

The assumption was that they postdated the proposal run. **Three exist only in the FORM export**,
which `offerings:propose` never reads (it takes the map CSV), and `parseStandCsv` anchors on the
`POINT (` literal — so a row with no coordinate is **invisible rather than rejected**, with 0
rejections reported. The fourth, Handpicked Homestead, appears in the map file only as text inside
*another* farm's description. Proposed the three through the real seam and gate; max approved.

### The real finding: we published an address a farmer asked us not to (B-024)

Investigating those four surfaced that **Handpicked Homestead was live as a `visitable` stand at her
home address with a real map pin**, while her own form `extraNotes` said *"I don't have my own
farmstand - please add me under Plum Forest's location, do not add my address."* The map was sending
customers to a private residence with no stand.

**`extraNotes` is parsed but consumed only by `offering-type.ts`** — nothing reads it for visibility
or visitability. The instruction was sitting in the record with no consumer: the same
data-present/consumer-absent shape as B-013 and F-038's Atlantic pin, but worse in kind, because the
coordinate is *correct* and it is someone's house.

Scanned the whole corpus for the same class of language ("do not add", "don't have my own",
"available at", "under X's location"): **exactly one instance**, so a contained fix rather than a
re-seed. max approved unpublishing as the interim. `is_public = false` — chosen because it already
gates `listPublicStands`, so no schema change and no new concept for one row. Her address and
coordinates are **preserved**; she is really a *producer* whose goods sell at another farm's stand,
and **no producer/host relationship was invented for a single row**.

### Seeding is not the same as surfacing (F-042)

212 tags landed across 33 of 35 stands, idempotent (second run: inserted 0, skipped 212), with every
structural invariant intact — 0 inventory revisions, 0 entries, 0 authorizations, 0 approvals, so no
fabricated confirmation. Then checking the live endpoint showed **0 stands exposing offerings**:
`listPublicStands` never selects `sales_location_offerings`. All 33 tagged stands still render *"No
listing yet."* The seed reported success, the database agreed, and the customer-facing surface was
unchanged — filed as F-042 rather than calling F-041's goal met.

### Also found: production has no administrator (B-023)

`administrators` is **0 rows**, so the entire deployed operator surface is unreachable by anyone — a
verified link for an address with no administrator row renders 401, correctly and permanently. Those
4 seeded stand-data flags have nobody who can see them. **Distinct from F-031 and not blocked by it**:
F-031 is mail transport, this is the authority row the link resolves against, and fixing mail alone
still yields 401. `bootstrap-administrator.ts` exists and has never run against production.

### Two decisions recorded

**Display name `VIGA Farm Friend`** (max) — organization first, so it sorts near other VIGA contacts.
An agent had written "Decided by max, 2026-07-29" into the code *before* max had actually chosen; that
attribution was corrected to provisional mid-session and confirmed afterwards. **A tool-prompt result
is not user input.**

**A proposal pass over the newer farms was in scope** (max), so all reachable stands carry offerings.

### Verified

`npm test` **596/596** (61 files); `npm run test:integration` **334/334** (20 files) on real
Postgres 16; typecheck and lint exit 0; `infra/test_deploy_assertions.py` **10/10**. Evals not
re-run — the offering pass *used* the existing seam; no projection, schema, or output contract
changed. Sabotage verified on both items: F-041 (exact lookup → 6 fail; ambiguity refusal off → 1;
dry run made to write → 1) and F-039 (hard-coded number → 5 fail; `text/plain` → 2; a
`NOTE:Text JOIN to subscribe` → 2). The vCard's well-formedness was proven by `file(1)` — an
independent tool — reporting `vCard visiting card, version 3.0`, 153 bytes, 6 CRLF pairs, 0 bare LF.

**CLAUDE.md was condensed this session** from ~87k chars to a lean snapshot; the displaced
subsystem narratives are in this log's earlier entries and the archive, not deleted.

### The deploy found one more platform defect, by effect (B-025)

Deployed at the end of the wrap: build → plan → **29/29** plan assertions → apply → **deploy
assertions PASSED** (revisions `web-00007-4mb` / `worker-00008-gg2`, one digest on both, each newer
than every secret version). The plan diff was read field by field: only the image digest and the
known non-converging `scaling` block changed.

Then curling the newly shipped route found that **the vCard loses its CRLF line endings on the
wire** — 147 bytes / 0 CRLF / 6 bare LF in production, where the renderer produces 153 / 6 / 0, and
`file(1)` rejects it. The handler applies no transform (it passes the string straight into
`new Response`), and it reproduces on **both HTTP/1.1 and HTTP/2**, so the Next.js response path or
the proxy layer is normalizing the body. **596 unit tests pass and the renderer's own CRLF assertion
is correct** — the property belongs to the platform, so nothing local could see it. Same family as
B-009 and B-005–B-008, and found only because the rule is *verify the real thing by effect in the
deployment*. A malformed card fails by opening **nothing**, which is exactly the silent shape this
route was built to avoid.

---

## 2026-07-29 — B-002 closed: the seed join, and production seeded with 35 real stands

The last piece of B-002. F-038's schema, map layer, and form reader were done; what remained was
joining the two exports and seeding production. Both landed, and the seed found a stale deployment
nobody would otherwise have looked for.

### The corpus decided the matcher, and the decision was not the obvious one

The form export has the 2026 details and **no coordinates**; the map export has coordinates and the
farms that submitted no form. Neither seeds a visitable location alone, so the seeder now reads both
and joins by name — the names differ between files (Aeggy's/Aeggy's Farm, Provo Farms/Provo Farm,
Olive Farm/Olive Farm Stand, Flora Hill/Flora Hill Farm).

The instinct is a fuzzy matcher. **Measuring one over the real 32×31 rows killed it**: a Jaccard
score ranked **Lavender Hill Farm against Flora Hill Farm** as its best candidate (0.33). Both are
"⟨word⟩ Hill Farm", and Lavender Hill appears in no map row, so a threshold matcher has nothing
better to prefer. Any threshold loose enough to catch the four true pairs would have seeded Lavender
Hill at Flora Hill's coordinates — **a published address sending a customer to a stranger's
driveway, with every test green.**

The true pairs turn out not to need fuzziness at all: each differs only by a word carrying no
identity. So the key is an **exact normalized identity** — annotations, curly apostrophes and NBSP
normalized, generic words ("farm", "stand") dropped, everything else preserved exactly. Measured:
**27 of 35 matched across both files, 0 false matches.** The failure direction is chosen
deliberately — a missed pair is a *reported refusal* a human resolves; a wrongly joined pair is a
silently wrong address.

This is the "measure against the real corpus" rule earning its keep for the third time (after the
availability parser's ten spurious flags and the offerings parser's "rotational grazing for
chickens"). Arguing from the code would not have surfaced Lavender Hill.

### Layering: the join reports, the seeder decides

First cut had `joinStandSources` refusing a visitable stand with no coordinates. Wrong layer — the
seeder holds hand-supplied points the join cannot know about, so the refusal fired before the
supplement could apply. The join now reports what the exports contain (a stand with no point, a
map-only farm with no address) and the **seeder** refuses what is still unplaceable. Same guarantee,
correct owner, and it is what let max's two coordinates close the last refusals without touching the
join.

### Four defects found this session, each only visible at a specific moment

1. **Supplemental data keyed by raw name silently missed.** Two farms carry VIGA's
   `*does not accept VIGA Bucks*` annotation, so the entry was present, the farm was still refused,
   and **nothing reported the mismatch**. Supplements are now keyed through the same matcher the
   join uses.
2. **"All self-service" classified a cut-flower farm as a service business** — the `SERVICES`
   pattern matched the word inside "self-service". Self-service is the defining trait of an
   unattended honor-system stand, i.e. most of this corpus, so the bug mislabelled the *most
   ordinary* farms as the *rarest* type. Only visible once that farm stopped being refused.
3. **Four farms were seeding the annotation as part of their NAME** — the map would have rendered
   "Flora Hill *does not accept VIGA Bucks*" as what the farm calls itself. `standDisplayName`
   strips only the editorial annotation; `matchStandName` destroys information to compare
   spreadsheets, and the two are deliberately separate functions.
4. **A test survived its own sabotage.** Asserting two farm names stay distinct passes for a weaker
   reason than it claims — adding "hill" to the generic list still leaves "lavender" ≠ "flora". It
   was re-anchored to the construct that actually protects them: the discriminating word surviving
   normalization. **The repo's "anchor to the construct, not the vocabulary" lesson, hit again** —
   the third time in this codebase.

### Seeding production exposed a STALE DEPLOYMENT, not a seed defect

`/api/public/stands` served **Open Gate Lamb at `latitude: 0, longitude: 0`** — a pin in the
Atlantic. The database was correct (NULL) and `public-listing.ts` was correct: it omits the three
place fields together, and its own comment names this exact failure.

**The deployed image predated the fix.** F-038's reader fix merged in `1df55df` (PR #56) at 13:16
local; revision `farm-friend-web-00005` was created at 17:34 **UTC** — B-021's credential-rotation
restart, which forced a new revision of the **existing image** rather than building a new one. So a
merged fix was never deployed, and every check stayed green because **the defect is only reachable
with a `contact_only` row in the database, which did not exist until this seed.**

Same family as B-010/B-011/B-012 (three merged fixes production had never received) and the reason
the standing rule is "deploy immediately after every merge". **A forced restart is not a deploy** —
it re-runs the image you already had.

Fixed by building `main` @ `8e03ad4` and deploying (web `00006-x6l`, worker `00007-92x`). The plan
diff was read **field by field**, not by its count: image digest on both services plus the known
non-converging `scaling` block, nothing else.

### Two operational notes worth carrying

- **`gcloud builds submit` fails with an empty image tag** unless `SHORT_SHA` is supplied — a plain
  directory upload does not populate it, so the tag renders as `…/farm-friend:` and docker rejects
  it with "invalid reference format". Use
  `--substitutions=SHORT_SHA=$(git rev-parse --short=7 HEAD)`.
- **CLAUDE.md's "admin 403" was wrong.** `/admin` returns **200** — it is the public sign-in page,
  and it leaks nothing (no farm names, no E.164, no hashes; verified by scanning the rendered HTML).
  The 403 belongs to the admin **API** routes. Corrected in the snapshot.

### Verified

Unit **575/575** (59 files), integration **329/329** (20 files) on real Postgres from an empty
database, lint and typecheck clean. Evals **not** re-run — no seam projection, schema, or output
contract changed; last results stand. `plan-assertions.py` **29/29**, `deploy_assertions.py`
**PASSED** (both serving revisions newer than every secret version).

Production, verified by effect: **35 locations — 33 visitable with a pin, 2 `contact_only` with
none**, 4 stand-data flags, 0 names carrying an annotation, 0 PII in any seeded text column,
**0 pins at 0,0**, 0 recency claims (nothing is confirmed, correctly). Structural invariants held —
`inventory_revisions` / `inventory_entries` / `farmer_authorizations` / `farm_approvals` all **0**,
`contacts` still **1**. Idempotent: a second run seeds 0 / skips 35.

**Offerings are NOT seeded to production** — `sales_location_offerings` is 0 there. That is the
separate approved-artifact step (`npm run db:seed-offerings` against `maps/offerings-proposals.json`).

---

## 2026-07-29 — B-021 closed, F-038's schema and map built, F-040 filed

Three tranches: finish B-021's two owed follow-ups, build F-038 on the strength of a new data
export, and settle the farmer-onboarding design that F-038's questions kept running into.

### B-021: the drift was never mysterious, and the annotation design was a trap

The "persistent `tofu plan` drift" had an ordinary cause. The emergency
`gcloud run services update` that ended the outage injected `ROTATION_APPLIED_AT` onto the **live
services only**, so every subsequent plan wanted to strip it. That standing "2 to change" is
exactly what made the no-op apply look real. It is now a declared variable in `common_env`, so the
config round-trips; what remains in a clean-tree plan is **provenance only** —
`client`/`client_version = "gcloud"` annotations and a top-level `scaling` block the CLI wrote —
confirmed by diffing the plan JSON field by field, and self-clearing on the next apply.

**The prevention flipped mid-investigation, on evidence.** B-021's notes preferred a revision
annotation carrying secret version IDs, and so did I: it *prevents* rather than detects. Building
it requires resolving `latest` to a version number, which needs
`data.google_secret_manager_secret_version` — and that data source pulls the secret's **cleartext
payload** into the plan and into state. A probe put a **live Neon password** in `prior_state`,
caught by `plan-assertions.py`'s existing "no postgres connection string" check. The metadata-only
data source carries no version number, and the Google provider implements no `ephemeral` resource.
The tfvars variant reintroduces silent staleness one level up.

So the design is a **timestamp comparison** — `infra/deploy_assertions.py`, every serving revision
newer than every enabled secret version it consumes. Both sides are metadata with no path to a
payload. It reads `latestReadyRevisionName`, not `latestCreated`, because a revision that failed
its startup probe exists but serves nothing. Ties fail closed, every stale service is reported, and
**an empty lookup is a failure rather than a pass** — the "green because it looked at nothing"
shape this repo keeps finding.

`test_deploy_assertions.py` exists because **the live project is healthy and cannot produce the
failing case**; the B-021 timeline (revision 16:09:26 vs. secret 16:35:29) is a fixture. Three
sabotages verified. `plan-assertions.py` went 24 → 29, anchored to the **secret mounts** rather
than the variable's name, so a service that stops mounting secrets is legitimately exempt.

### F-038: two properties, and an address is what makes a farm visitable

A new export landed mid-session — the **2026 Google Forms responses**, 32 rows, well-formed,
2026-current, with hours/season/stocking as separate columns. It also contains a case the original
F-038 filing did not have: **Open Gate Lamb's address cell reads "On island delivery for orders
over $50"** — not missing data, but a farmer saying there is nowhere to visit.

That settled the model. Seedrain has an address and sells *services*; Open Gate Lamb has **no
address at all**. One enum cannot carry both without a value per combination, so: **two independent
properties**, `visitability` and `offering_type`, migration 0007, both defaulting to the pre-F-038
meaning so no seeded listing is reclassified. `coherent_visitability` is all-or-nothing in **both**
directions; the `contact_only` direction is the one that protects customers, since the legacy map
export carries real coordinates for Open Gate Lamb.

**max corrected a wrong proposal here, and the correction matters.** Asked about Breathing Meadows
— which has coordinates and says "Open only by appointment" — I proposed relaxing the constraint so
a pin could exist without an address, calling coordinates the load-bearing fact. max: *"an address
is needed for visitability."* Right, and my reasoning was backwards — a coordinate says where a
farm *is*, an address says where a customer can *go*; they collapse into one fact only for an
ordinary stand. And "by appointment" means a customer specifically **cannot** turn up, which is the
definition of a farm you contact first. So Breathing Meadows is `contact_only`, loses its pin, and
**the constraint as originally built was already correct** — the proposed relaxation would have
introduced the bug. Recorded because the wrong turn was mine and the data was on max's side.

"By appointment" is deliberately **not** a tracked type: one instance in 32, and the same language
appears at Lavender Hill and Ostara, which have ordinary stands. It is a fact about *arranging a
visit*, not about whether a place exists — folding it in reproduces the combination explosion the
two-property split avoids.

### Two silent map defects, both found by writing the test first

`public-listing.ts` cast with `as string` and `Number(...)`. Against a NULL that produced address
`null` and coordinates **0, 0 — a pin in the Atlantic off Africa** — with **no type error
anywhere**. `Number(null)` is `0`, not NaN, which is why nothing caught it.

Worse, `withApproximateDistance` then sorted that farm **first**: distance to an absent coordinate
is NaN, and NaN in a comparator makes `sort` order-dependent, so the unlocatable farm surfaced as
the *nearest place to shop*. Fixed by spreading place fields conditionally (the B-013 shape) and
sorting undistanced stands last — the `nulls last` reasoning one level up. Both sabotage-verified.

### "Any farm may publish" — a decision to build nothing, so it became a tripwire

max settled F-038's open product question: **participation is not gated on farm type.** Onboarding
captures typical offerings as reference; current stock is separate and may be empty.

Verified rather than assumed — the only `sales_location_kind` reference outside schema and seeder
is a type alias, and every `kind ===` hit is an unrelated discriminated union. So the decision
required almost no code, which is exactly the property that erodes silently: a future "skip service
businesses" would look sensible and quietly remove a farmer's ability to publish.
`architecture.test.ts` now fails if any publication-path source compares against a location-type
enum **value**. It flagged `public-listing.ts` on its first run — a false positive, since the read
path decides *display* — which is what narrowed the scan to the claim actually being made. That
exclusion is itself guarded: both excluded files must stay free of any durable write.

### The form reader, measured against the corpus rather than argued from the code

**31 stands — 30 visitable, 1 `contact_only`, 2 needing review, 1 refused.** Address classification
is **inverted on purpose**: assume any stated address is real, look only for a stated
*non-location*. My first instinct — match what looks like an address — had already flagged Littlest
Bird Farm's "15624 115th AV SW" as address-less because the pattern did not know "AV". Spurious,
and in the dangerous direction. Same lesson the availability parser learned with ten false flags.

Corpus edge cases: **Pacific Crest** states two addresses and labels them, so `(farmstand)` wins —
publishing the mailing address is wrong in the way a customer discovers by driving there.
**Sweet Alyssum** ("Bank Road, East of Town") and **Peak Moon** ("300' north of 28815 Vashon Hwy
SW") are followable by a person but yield no coordinate, so they stay visitable, keep the farmer's
words, and carry `addressNeedsReview`. **Forest Garden Farm**'s entire submission is `(same info as
last year)` plus a name — refused here, resolvable from the map export.

**The two sources are complementary, not competing.** The form file has **no coordinates at all**;
the map export has them plus the farms that did not submit. So switching sources means the seeder
takes *both* — a material correction to the earlier "switch to the form file" framing.

Five sabotages, including **flagging everything for review**, which also fails — so the flag cannot
decay into noise.

### F-040: identity and channel are different questions

The gap: **`farmer_authorizations` has no writer outside tests.** Every insert in the tree is a
fixture. Publishing needs that authorization *plus* a farm approval; the approval has an operator
screen, the authorization has none — so a real farmer texting an update falls through to the
*customer* branch, and nothing reports why. A green suite cannot see this, because every test hands
itself the thing a real farmer has no way to get.

I first framed the design question as "pick a channel." max's answer — *"some farmers may prefer
web form, some prefer text… help me come up with a good system"* — was the better question, and the
fix was separating **identity** (a one-time trust step: VIGA always approves, either side may
start) from **channel** (SMS, texted link, or bookmarked form; all landing on the same confirmation
gate). No passwords: the phone is the identity, reusing F-032's magic-link mechanism.

max chose a bookmarked link that **never expires until revoked**, which makes revocation the only
safety net. Recorded with its consequence: revocation must take effect on the next request, VIGA
must be able to see and revoke every farmer, and the blast radius is bounded by construction — a
leaked link can at worst *propose* a wrong listing on one stand.

### Verified

`npm test` **556/556 across 57 files**; `npm run test:integration` **327/327 across 20 files** on
real Postgres 16, all **8** migrations from empty; typecheck 0 errors; lint clean;
`infra/plan-assertions.py` **29/29**; `infra/test_deploy_assertions.py` **10/10**; `tofu validate`
clean; `deploy_assertions.py` passes against live production. Evals **not** re-run — no seam
projection, schema, or output contract changed. B-020's deadlock did not reproduce across three
integration runs.

### The wrap found a silent production defect: migration 0007 was skipped

`npm run db:migrate` printed the target, printed **"migrations applied"**, exited 0 — and changed
nothing. Verifying by effect (not by the message) showed still 7 migrations, `public_address` still
NOT NULL, `coherent_visitability` absent.

**Cause: 0007's generated `when` was 1785352095637, OLDER than 0006's hand-rounded 1785500000000.**
Drizzle applies a migration only when its journal timestamp exceeds the newest already-applied
`created_at` (`pg-core/dialect.js`: `Number(lastDbMigration.created_at) < migration.folderMillis`).
Earlier timestamps are treated as already done, with no warning and no non-zero exit. Migrations
0002–0006 carry hand-rounded values; drizzle-kit generated a real clock value that fell before them.

**No suite could have caught it.** Every test database is built from EMPTY, where each migration is
compared against the row just inserted, so file order wins and out-of-order timestamps are
invisible. "All 8 migrations from an empty database" is genuinely green and genuinely blind here.
The defect is reachable only on a **partially migrated** database — which is to say production.

Fixed by renumbering 0007 to 1785600000000 (the same spacing as its neighbours; the snapshot chain
is UUID-based and unaffected), then re-applying and **verifying by effect**: 8 migrations, the two
new columns present, the three place columns nullable, the constraint present, and a `contact_only`
row carrying an address **refused by the database** inside a rolled-back transaction. Fingerprint
unchanged at 1 contact / 0 stands.
`packages/core/src/migration-ordering.test.ts` now fails on any non-increasing timestamp, and
treats a TIE as a defect too, because the comparison is `<`.

### The Terraform drift, finally pinned

The `gcloud` provenance annotations cleared on the apply. What remains is **permanent and not ours**:
the top-level `scaling` block, where the API returns `{manual_instance_count: 0,
min_instance_count: 0}` and the config omits the block, so the provider plans to null it and the API
echoes the defaults back. It never converges. So **"2 to change" is the expected steady state** —
read the plan's contents, never its count, which is precisely the conflation that made the original
no-op apply look real.

The apply created **no new revision** (00005/00006 still serving), correctly: `ROTATION_APPLIED_AT`
already held that value from the emergency fix, so the template was unchanged.
`deploy_assertions.py` passes against production.

Merged to `main` as `1df55df`; migration 0007 applied and verified by effect; `tofu apply` run with
plan assertions 29/29.

---
