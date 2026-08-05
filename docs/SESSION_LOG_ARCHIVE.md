# Farm Friend — Session Log Archive (through 2026-08-02)

Rotated out of [SESSION_LOG.md](SESSION_LOG.md), which keeps the eight most recent entries;
everything older lives here. Last rotated 2026-08-05; it now holds 50 entries.

**Read these as history, not as contract.** Most of this file predates or begins the
clean-room reset, whose decisions superseded much of it; the current contract lives in the
architecture documents ([README.md](README.md) is the index). Where an entry here disagrees with the
current architecture documents or with [CURRENT_STATE.md](CURRENT_STATE.md), those win.

---

## 2026-07-31 — F-046 part 3: paging wired, deployed, and the two tests that could not fail

Parts 1-2 had merged deliberately inert: the page renderer, the `MORE` keyword, and migration
`0009_pending_result_lists` all existed and **nothing wired them**, so a customer texting `MORE`
fell through to free text and reached the model as a question. This session connected them and
shipped it.

### The shape: one callback, one repository, one renderer

`MORE` is a `nextPage` callback on `RouteDeps`, mirroring `freeText` — routing keeps owning only
the deterministic order, and retrieval/rendering stay outside it. The difference worth stating:
**the handler behind `nextPage` takes no model dependency at all**, so "paging reaches no model"
is a property of its signature rather than of a seam that happens not to be called. Ordering it
after the compliance keywords and commitment tokens is what makes "paging can never shadow an
opt-out" structural.

The repository (`packages/db/src/pending-result-list.ts`) makes the database the arbiter rather
than application code: save replaces via the unique index on `sender_hash`; a page is claimed and
the offset advanced in **one locked transaction**; expiry is measured against the **message's own
time**, never `now()`, so a delayed pass can neither refuse a page asked for in time nor silently
extend the window. Expired and exhausted rows are deleted as found — "never asked", "expired",
and "exhausted" become one honest reply instead of three shades of no.

**Replay, not re-retrieval** (max's call, this session): identity and order frozen at question
time, values dereferenced **fresh** at page time, because the table stores no copy of them. A
stand withdrawn mid-paging is dropped rather than rendered stale; a page whose stands have *all*
gone is **skipped**, since an empty page reads to a customer as "no results" — a false claim
while later pages still hold real answers.

### Deleting the second renderer, and the type that hid the (null) bug

After part 3, `renderGroundedAnswer` had **no production consumer left**. It also carried a
second fact type differing from the pager's in exactly one way: a non-nullable `publicAddress`.
**The nullable half was the true one** — the column is nullable, two real stands carry no
address — and that mismatch is precisely how F-045 shipped the literal word "null" to customers
past a fully satisfied compiler. Both are now gone, leaving one renderer and one fact type. The
grounding assertions moved to the survivor rather than retiring with the function, and the evals
render through the same path; sabotaging that renderer fails two adversarial fixtures, so they
genuinely exercise it.

### The two sabotages that survived — both were defects in my own tests

24 sabotages applied. Two initially survived, and both are the "a test that cannot fail proves
nothing" class:

1. **The concurrency test could not fail.** `Promise.all` over six claimants did not race them —
   measured, not assumed: each claim completed in under a millisecond, so every transaction
   committed before the next one read, and deleting `for update` passed the whole suite. The fix
   is to *manufacture* contention: a separate connection takes the row lock and holds it until
   every claimant has queued behind it, signalled by awaiting actual acquisition rather than a
   sleep. Now, without the lock **all six** claimants are served the same stands; with it,
   exactly three. This is the CLAUDE.md warning about `Promise.all` not racing async branches,
   met head-on.
2. **"The page was actually served" was asserted on the offset** — which an implementation that
   claims a page and then discards it *also* satisfies, since the claim advances the offset
   regardless. It now asserts the queued reply body.

Both directions of the confirmation/paging independence are asserted end to end through the real
webhook, for the same reason: each direction alone is satisfiable by the defect it forbids
("the confirmation survived" passes trivially if `MORE` did nothing; "the page was served" passes
trivially if no confirmation was ever open).

### Two things learned about the fixtures themselves

`deliverInbound` also drives the kick route, which builds its own deps from the composition root
with the **real** clock — and that expires a fixture proposal anchored a day in the past. The
existing suite already used `deliverInboundOnly` for exactly this reason; worth knowing before
debugging a phantom expiry again. Separately, a pending list of **invented** fact IDs drains
itself, because the pager dereferences and skips empty pages by design — a fixture list must name
real published stands or the assertions are about nothing.

### Verified against the real corpus, then in production

The offerings corpus is tracked (`maps/offerings-proposals.json`, 34 stands / 212 tags, matching
production), so paging was exercised over real names and real address widths rather than
fixtures: `"any eggs?"` matches **13 stands** and pages **5 pages, every one 2 segments**, against
F-045's single 488-character / 4-segment message. `"honey?"` matches 2 and saves **no row at
all**. The corpus's three widest name+address entries on one page render **285 chars / 2
segments**, so the two-segment ceiling holds against real data.

**Deployed** — migration first (`0009_pending_result_lists`, verified by effect: 10 applied,
every pre-existing count unchanged, all three CHECKs proven to reject *with a valid-row positive
control*, cleanup left 0 rows), then the image. Revisions `farm-friend-web-00013-djk` /
`farm-friend-worker-00014-qv2`, digest `sha256:5e6a4d49`. Plan read leaf by leaf: exactly one
real leaf per service plus the known non-converging `scaling` block. Against real production
rows, `Open Gate Lamb and Grazing` now renders **`address not listed`** — the `(null)` bug is
dead.

**A doc correction worth carrying**: there is no migration "0010". There are 10 migration
*files*, `0000`–`0009`; production had applied 9 of them, through `0008`. Earlier wording in
CLAUDE.md and CURRENT_STATE invented a 0010 and was fixed.

**Still owed: a handset tap.** Only a real phone proves threading and segment behaviour.

---

## 2026-07-31 — F-045 shipped: SMS could not see the offerings corpus, and matched food by string equality

max texted the production number "Who has lamb?" and "Any leafy greens available?" and got
"No stand has a current listing" to both, while the public map showed those stands the whole
time. **Two defects, one root cause**, and the root cause is the interesting part.

### The inquiry path was reading a table that is empty in production

`retrieveCurrentListings` queried only `inventory_revisions` + `inventory_entries` — farmer
**confirmed** stock. Production holds **zero** current inventory revisions, because no farmer has
published yet. So retrieval returned empty on *every* question, short-circuited to the honest
"no current listing", and never reached the fact-selection seam at all. Meanwhile the **212
offering tags** F-042 shipped to the map sat in `sales_location_offerings`, which this path never
queried. **One desk was giving two answers**: the map knew Holmestead sells lamb; SMS did not.

Retrieval now unions both, tagging each candidate with its `basis` — `confirmed` or `offering`.

### Comparing strings to answer a question about meaning

`rankCandidates` filtered candidates by **exact normalized item-name equality**. "leafy greens"
never matched "butter lettuce"; "root vegetables" never matched "beets". The corpus proves it
cuts both ways: it holds a literal `"leafy greens"` tag *and* `"baby lettuce mix"`, so even exact
matching hit inconsistently — which reads worse to a customer than never hitting.

The filter ran **before** the model, so the only layer that could understand "beets are root
vegetables" never saw beets. The fix is not a synonym table — that is the food-taxonomy-as-policy
CLAUDE.md forbids, and no finite list covers an open corpus of farmer-authored names. **Code
stopped deciding which items answer a request.** It now orders and caps candidates
(`MAX_INQUIRY_CANDIDATES`, a stated bound rather than one inherited from corpus size) and the
model selects across them.

**Grounding is untouched** — code retrieves, validates every returned identifier against the
retrieved set, and renders every word. **What moved is RECALL**, which is a quality property, not
an authority one. So recall became something *measured*: five live fixtures over real corpus
vocabulary, each with distractors, and the `live-recall` group **exits non-zero** rather than
merely recording. A model that cannot category-match is not a degraded experience; it is this
defect restored.

**Mistral Small 24B passes all five**, so the model upgrade max pre-approved was not needed and
nothing extra is being spent. The swap remains one env var if recall ever regresses.

### Two defects the tests caught mid-build, and one they didn't

Caught: `offering:<uuid>` identifiers were refused by `assertOpaqueId` (a colon is not an
identifier shape — the guard was right); and removing the item filter made an answer about kale
recite the eggs, so **rendering** now narrows by exact name separately from **retrieval**, which
does not.

**Not caught, and shipped to production:** `publicAddress` is **nullable**, two real stands carry
no address, and the renderer printed the literal word **"null"** to customers. The guard was
`publicAddress === ""`; the type said `string`, so the compiler was satisfied and every fixture
had an address. Textbook NULL-semantics miss. Fixed in F-046's renderer, not yet deployed.

### F-046 designed and half-built

max's follow-up: the replies are hard to parse. Measured against the real corpus — the *common*
questions are the big ones (eggs 16 stands, flowers 15, leafy greens 9) and name+address runs
22-57 chars — so **three per page** is the honest maximum inside **two billed segments**. The
shipped format was 488 characters / **four** segments.

Built this session: page rendering, `MORE` as a deterministic keyword ordered after `STOP`, and
migration 0009's `pending_result_lists`. **Not yet wired** — a customer texting `MORE` still
falls through to free text. Part 3 is the routing branch.

**max chose (2026-07-31)**: page 3 at a time; `MORE` **replays the saved list** rather than
re-running retrieval, so paging is consistent and costs no model call, accepting that stock
confirmed mid-paging waits for the next question; and **`YES`/`NO` and `MORE` both work** — a
farmer with an open confirmation can page without disturbing it.

### drizzle-kit omits CHECK constraints, silently

Asked to generate a snapshot, drizzle-kit also wrote **its own migration** for the same table
whose SQL **dropped all three CHECK constraints**, with a journal timestamp **older** than the
hand-written one — which is B-022's silent-skip trap. The timestamp half was already tripwired;
the dropped-constraint half was not. **Now it is**: `migration-metadata.test.ts` fails when a
CHECK constraint declared in `schema.ts` reaches no migration. Checked against migration **SQL**,
not the snapshot, because SQL is what runs. No drift today — all 71 declared constraints present.

`array_length` of an empty array returns **NULL**, and a CHECK constraint **passes** on NULL, so
the obvious spelling of "the list must not be empty" admits empty lists. `coalesce` is required,
and each constraint was verified by trying to violate it.

### Verified

F-045: unit 735/735, integration 407/407, evals 11/11 + 4/4 + 29/29, `evals:live` containment
4/4 / recall 5/5 / quality 6/6. **13 sabotages, all caught.** Deployed 2026-07-30 —
`web-00012-glc` / `worker-00013-b9t`, digest `sha256:b178bf93`, no migration owed.

This session's wrap: unit **758/758**, integration **407/407**, typecheck and lint clean, evals
green. F-046 parts 1-2 merged but **inert and undeployed** — production keeps today's behavior,
including the `(null)` bug.

## 2026-07-30 — F-043's poster pass: the map made to look like VIGA's, and two defects live in production

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

### Deployed

Shipped the same session, after the wrap: revisions `farm-friend-web-00011-dpd` /
`farm-friend-worker-00012-c26`, one digest `sha256:e1893b13…` on both. Image-only — no migration
owed, production stays at 9 migrations. `plan-assertions.py` 29/29, `deploy_assertions.py` PASSED,
`served_card_assertions.py` PASSED. The plan was read leaf by leaf: one real leaf per service
(`containers[0].image`), plus the known non-converging `scaling` block.

Verified by effect in production, not by the apply's exit code: 32 numbered pins, 34 list badges,
8 wooded areas, 12 "Hours not listed", 33 "Usually sells:", the page title gone, and **0**
`prefers-color-scheme` rules in the served CSS with every dark token absent. In a real browser on
a dark-mode machine the page renders light with no emulation; `Open now` narrowed 34 → **18** at
10pm (the computed dusk genuinely closing stands) with **zero renumbered** and all 12 unstated
stands still visible.

One probe misled and is worth recording: `/api/farmer/stand` answered **400** where CURRENT_STATE
records 403 for a fabricated token. Not a regression — the route is untouched by this tranche, and
the payload was hitting the schema check before reaching the token check. The 403 paths are intact.

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

---
## 2026-07-29 — the cutover is thrown: B-009 re-proven, Vercel torn down, F-034 closed

The migration's remaining three legs, in one pass: point Telnyx at Cloud Run, **prove the B-009
class by effect on the new runtime**, and retire everything the migration superseded. Then
credential rotation, which max chose to fold into this work rather than defer a fourth time.

### The webhook switch, and a timestamp that lied again

`PATCH /messaging_profiles/<id>` returned the new `webhook_url` **and the old `updated_at`**. An
independent re-read showed the write had landed and the timestamp moved. Same shape as the
`vercel env ls` trap: **a write's echo of its own payload is not confirmation, and a dashboard
timestamp is not a last-updated field.** Re-read from a separate request or believe nothing.

max chose to switch **before** proving durability, accepting that real texts could land on an
unproven runtime; volume is zero and no farmer has the number, so the window was small. Recorded
because it was a deliberate trade, not an oversight.

### B-009 is not inherited — proving it took a key swap, and the sabotage came first

The standing rule is that a property belonging to the *platform* is proven **by effect in the
deployment**. Cloud Run's container lifecycle is a new runtime for "does post-response work actually
run", so the Vercel-era fix proves nothing here. `scripts/prove-post-response-work.ts` runs three
checks against the database — fast path, cold start, and a message whose task was **never created**
recovered by the schedule — and **searches for the B-009 signature** (committed + acknowledged +
never claimed) rather than assuming it absent. All three passed; claim-to-finalize was ~1s.

**Signing is the obstacle worth recording.** Telnyx's private key is not ours, so a genuinely signed
request needs the deployment to trust a key we hold. `TELNYX_PUBLIC_KEY` is plain config, not a
secret, so the proof ran against a revision carrying a throwaway public key — with max's explicit
approval, because **while that revision is live the number rejects genuine inbound SMS**. Restored
immediately and verified *behaviourally*: the throwaway key now returns `signature_mismatch`.

**The sabotage ran before the proof, not after.** Against the deployment still trusting Telnyx's real
key, checks 1–2 failed `ack=401` while check 3 passed on its own merits (it needs no signature).
That is what makes the harness credible rather than decorative.

**Writing it caught two defects in itself**, either of which would have made it lie:
`provider_inbox_events` has no `body`/`processed_at` column (it is `state`/`finalized_at`; the body
lives in `sms_messages`), and `hashPhone` is **HMAC-SHA256 under `PHONE_HASH_SALT`**, not a bare
digest — a test salt yields a row nothing ever claims, *indistinguishable from the failure the check
exists to detect*. Checking a harness against the real schema before running it is cheap; a proof
that quietly measures nothing is not.

Incidentally proven: the **full round trip works on this runtime**. A proof message's reply was
dispatched through Telnyx and its delivery callbacks returned through the new webhook URL — two
inbox rows I had not created, identified before cleanup rather than assumed to be noise.

### The record was wrong about the legacy data — again, and in the dangerous direction

The migration plan recorded, as max's decision, that the legacy project held no real data, and
deliberately **not** as a verified fact. Reading it found **37 Firestore documents**: 19 users, 3
farms, 5 messages, 8 agent decisions, 1 flag, and a `pending_users` row with `source: "join"`, a real
approval timestamp, and — unlike every user and farm row — **no `test_data` flag**. Auth held 1
account.

max confirmed test data and approved deletion. It was archived first to
`~/farm-friend-legacy-archive/` (Firestore + Auth + non-secret manifests), and the delete **refused
to run** unless a re-read fingerprint matched exactly and the archive held all 37 docs. This is the
second time "assumed empty" was wrong in this project; the first was the reset script that found 6
volunteers and 2 farms with phone numbers. **The rule keeps paying for itself.**

Two smaller plan claims were also stale: the seven legacy schedulers were already `PAUSED`, not
still firing, and the always-warm charge ended with the services rather than needing `minScale=0`.

### Teardown

Deleted: the Vercel project and its env vars (Telnyx re-confirmed pointing elsewhere first), both
stale branches (`throwaway/hobby-deploy-test` **and** `f-019-sms-only-inquiry-boundary` — the second
was not on anyone's list), 17 legacy functions plus the 15 Cloud Run services behind them, 7 legacy
schedulers, 6 unreferenced legacy secrets including the STALE `TELNYX_API_KEY` that returned 401,
the Firestore/Auth contents, and the empty `farm-friend-497422` project. `farm-friend-vashon` now
holds **only** Farm Friend. Verified afterwards by listing each resource type and by every live
surface still answering correctly.

### F-034: rotation, and two traps

max reversed the third deferral and folded rotation into this session. `DATABASE_URL`,
`DEEPINFRA_API_KEY`, and `MAGIC_LINK_SECRET` rotated; **`PHONE_HASH_SALT` untouched, deliberately**.
Old values confirmed dead **by effect** — `password authentication failed` and 401 — never by
assuming a console did what it said.

**Trap 1: `version = "latest"` does not reach a running container.** Cloud Run reads secrets at
container start, so between the Neon password reset and the redeploy, production was serving on a
**revoked** password. `gcloud secrets versions add` alone changes nothing already running; the
redeploy is the step that applies a rotation.

**Trap 2: a scripted `.env` edit silently did nothing.** The regex assumed `KEY="value"`, but
`DEEPINFRA_API_KEY` is written **unquoted** in that file — so the substitution matched zero lines,
reported success, and left the dead key in place. It surfaced only when `evals:live` returned
`provider_error` on all six quality cases. **`live-containment` still read 4/4 through that
failure**, because a refused call counts as contained — so a containment-only pass is *not* evidence
the model path works. The corrected edit asserts its match count and refuses on anything but exactly
1. New values were verified *before* being stored, so a bad credential could not later be
misdiagnosed as a broken deployment.

`keys.txt` (how the values were supplied) was **untracked but not gitignored** — a `git add -A`
would have committed it. Deleted, and the tracked tree greps clean for both new values.

### Then a real handset broke it, twenty minutes after the synthetic proof passed

max texted `Help` at the end of the session as the real-handset check. It committed, and then sat at
`state=pending` for 75+ seconds with no reply — **the exact B-009 signature, on real traffic, on a
runtime I had just proven**. It was not B-009. Every database call was failing
`28P01 password authentication failed`: the rotation's new `DATABASE_URL` had never reached the
containers.

`gcloud secrets versions add` wrote version 2 at **16:35:29**. The newest revision was created at
**16:09:26** — twenty-six minutes *earlier*. Cloud Run reads secrets **at container start**, so
`version = "latest"` binds at startup and never re-reads; the `tofu apply` I ran after adding the
versions altered nothing in the revision template, created no new revision, and reported "2 to
change" while changing nothing that mattered. **A green apply is not a restart.** Filed as **B-021**.

**The humbling part is how the verification missed it**, because the checks were the right *kind*
(by effect, not by reading a value back) and still proved nothing:

- `/api/public/stands` → `{"stands":[]}` came from a **warm container** whose pooled connections
  predated the Neon reset. *A warm connection keeps working after the password behind it changes* —
  only a new connection re-authenticates. And an empty array is indistinguishable from an empty table.
- The scheduler **200** I cited was read *before* the rotation apply and carried forward as current.
- `evals:live` 6/6 runs **locally against local `.env`** and never touches the deployment at all.

The check that settles it is a timestamp comparison: **revision creation time vs. secret version
create time.** An older revision means nothing picked the value up, whatever any endpoint returns.

Forcing revisions (worker 00006 / web 00005) fixed it, and the stuck message was recovered by the
very next scheduled pass — inbound `processed`, reply `sent` with a real provider message ID,
`accepted`, 2 delivery callbacks back through the Cloud Run webhook, and `sms_consents` correctly
**empty** because HELP does not move consent. **The full round trip is now proven on real traffic,
not just synthetic.**

Two things this leaves: production now holds **one real phone number** (max's), which is the event
F-034 named as closing the exposure window — rotation landed first, so the order held. And a
**persistent `tofu plan` drift** reporting "2 to change" on a clean tree is still unexplained; until
it is, "the plan showed changes" is not evidence a deploy did anything. Both on B-021.

**The standing lesson, sharpened: a synthetic end-to-end proof and real traffic are not the same
runtime either.** `prove-post-response-work.ts` passed at 09:08 against a container started before
the rotation, so it proved the durability property honestly and told me nothing about the
credential. It took a handset to find it — the same family as B-009 (local ≠ deployed), B-005–B-008
(hoisted ≠ isolated install), and F-024 (stub ≠ real model), one level further out.

### Verified

`npm test` **528/528 across 55 files**; `npm run test:integration` **311/311 across 19 files** on
real Postgres; typecheck and lint clean; `npm run evals:live` **containment 4/4, quality 6/6** on the
rotated key. `npm run evals` not re-run — no seam projection, schema, or output contract changed.
`infra/plan-assertions.py` 24/24 on both applies. **Live round trip verified by a real handset** (see
above), on revisions worker 00006 / web 00005.

**One pre-existing flake recorded, not waved off.** An integration run failed
`a verified STOP unsubscribes end to end and calls no model` with PostgresError **40P01 deadlock** on
a fixture `truncate`, and passed on rerun. This branch changes no application or test code, so the
flake lives on `main`; the contention is between suites' truncates, not in Farm Friend's locking.

---

## 2026-07-29 — the GCP migration: Farm Friend is live on Cloud Run, and a lost salt

Vercel → Google Cloud Run, per `docs/GCP_MIGRATION_PLAN.md`. The driver was cost and licensing, not
a defect: Hobby is restricted to non-commercial personal use and Farm Friend does not qualify, so
Vercel meant ~$20/month indefinitely against VIGA's zero budget. GCP at launch volume is ~$0. Two
independent gains came with it — Cloud Tasks is durable where `waitUntil` was cancellable, and the
manual `crons`-strip left the deploy path.

**The deployment is live and verified by effect**: `https://farm-friend-web-p5mfxfp5za-uw.a.run.app`.
Health 200, `/api/public/stands` 200 against real Neon, admin 403, `/api/internal/{cron,kick}` **404
on the public service**, the worker unreachable from the internet, webhook **401** (not 500/503), and
a scheduled pass returning **HTTP 200** on revision `00003`.

### The cost premise was wrong by 13×, and max was right that it did not matter

The plan claimed the legacy always-warm functions cost $15–25/month and called killing them "the
single highest-value action in this document". The actual bill says **$1.57**. The error is worth
recording because it will recur: the arithmetic assumed idle CPU on a held instance bills at *some*
rate and bracketed $10–43 by varying it. Under request-based billing it bills at **none** — the
console shows only *"Cloud Run functions Min-Instance **Memory**"*, with no CPU counterpart. Two
plausible bounds from a pricing page both missed an answer that was zero.

I let that correction sound like it undercut the migration. It did not: the case is Vercel Pro ~$20
vs ~$0, and the $1.57 is a footnote. **A figure derived from a pricing page is not a cost.**

### The legacy functions could not be fixed, only deleted

`minScale=0` on `inbound-sms`/`simulate-inbound-sms` was the plan's "do this immediately" item. It
is **impossible**: `gcf-artifacts` holds **zero images** for 17 functions — the images were
garbage-collected out from under running services. They still served traffic from cached layers but
every revision attempt failed `image not found`, including one pinned to the digest the live
revision itself reported. Deleted with approval (archived config first, fingerprinted, zero
references in current code); seven schedulers firing into them paused. Verified by effect: 15
services remain, zero always-warm, all instances drained to 0.

The lesson is in `infra/main.tf`: the new Artifact Registry repository is **dedicated and carries a
cleanup policy that keeps recent releases**. Reusing Firebase's managed repo is what produced the
zombies.

### `waitUntil` → Cloud Tasks, and the await direction inverts

On Vercel the rule was *never await the kick* — the awaited thing would have been the passes, a
model call and a provider call inside the request Telnyx waits on. Now the awaited thing is only the
**task creation**, one bounded call, and awaiting it is what makes the work durable **before** the
handler returns. A fire-and-forget enqueue would reintroduce B-009 exactly: a floating promise the
runtime may discard when the container is reclaimed.

`kick-survival.test.ts` and `kick-wiring.test.ts` were **re-anchored, not deleted** — the defect
class survives the migration, only its mechanism changed. Sabotage: `await`→`void` fails 3 tests;
moving the acknowledgement after the enqueue fails 2.

Enqueueing **never throws and never retries**. The inbox event is already durable and the 200
already built, so a queue outage must not turn a successful ingress into a 5xx that makes Telnyx
retry a message we accepted. `ALREADY_EXISTS` counts as success — a webhook retry produces the same
deterministic task name, and the queue refusing the duplicate *is* the deduplication working. Task
names are **hashed, not sanitized**: stripping unsafe characters is not injective, so `evt/1` and
`evt1` would collapse and one sender's work would vanish.

**Cloud Tasks over REST, no SDK.** `@google-cloud/tasks` is 11.6 MB unpacked plus `google-gax`
(gRPC + protobuf), all landing in a container whose cold start sits on the SMS reply path, to make
one POST to one documented endpoint.

### `CRON_SECRET` was removed rather than kept beside IAM

The internal routes are now worker-only, reached through Cloud Scheduler's OIDC against an
internal-ingress service. Keeping the shared secret "for defence in depth" would have preserved its
actual failure mode — one credential in two places that had to match, where a mismatch returns 401
and **a 401 looks identical to success in any scheduler's UI** — while protecting against nothing,
since a caller who cannot satisfy IAM never reaches the code to present a token.

The in-process `DEPLOYMENT_ROLE` guard is explicitly the *second* door: it runs **before**
`appContext()` so the public service never builds a database pool for a route it does not serve, and
answers **404** rather than 403 to leak no hint the surface exists.

### The abuse throttle was about to become a no-op

`clientSignalFor` read the **leftmost** `X-Forwarded-For` hop. Correct on Vercel; **backwards on
Cloud Run**, where the caller controls everything it sends and Google *appends* the observed
address. Carried across unchanged, an attacker sends a random leftmost hop per request and lands in
a fresh bucket every time — the throttle removed, not weakened. Now reads the rightmost non-blank
hop. Sabotage: reverting fails 3 tests.

### PHONE_HASH_SALT was lost, and "never rotate" turned out to have an exception

The production salt was set in Vercel marked **Sensitive** — write-only, unreadable by anyone — and
recorded nowhere else. `vercel env pull` returns `[SENSITIVE]`. **Storing a secret somewhere
unreadable is the same as not recording it.**

The absolute rule means "there is no way back", and that holds only once the raw numbers are gone.
While `contacts.phone_e164` still holds the raw E.164 — the one column that stores it — every hash
can be recomputed. Production held 2 contacts from live SMS testing with both raw numbers intact, so
this was recoverable rather than fatal. max chose to **wipe** (none of it was real data): 71 rows
across 7 tables removed, fingerprint-guarded in one transaction. Verified by effect: 0 phone rows,
0 raw numbers, schema intact at 7 migrations.

`npm run db:rehash-phones` is kept as the documented recovery path, and **two simpler versions of it
failed against a real database first**:

1. *children first, contacts last* — children immediately reference a parent hash that does not
   exist yet.
2. `set constraints all deferred` — **no effect**. All **eleven** foreign keys onto
   `contacts.phone_hash` were created NOT DEFERRABLE, so deferral cannot be asked for at runtime.

The working shape is insert-new-parent → repoint-children → delete-old-parent. Verified end to end:
2/2 contacts match the new salt, 6/6 messages and 2/2 consents preserved, zero orphans.

### Four defects only a real build or a real deployment could find

Every one passed every local check first.

1. **`$PROJECT_ID` is not expanded inside a user-defined substitution's default value.** It arrives
   literally; docker rejected the tag.
2. **`COPY apps/web/public`** — this app has no such directory. A COPY of a missing path is a hard
   failure, not a no-op.
3. **The constructed Cloud Run URL was wrong.** `SERVICE-PROJECTNUMBER.REGION.run.app` is not the
   format; Cloud Run assigns `farm-friend-worker-p5mfxfp5za-uw.a.run.app` — opaque per-project
   suffix, *shortened* region. Caught only by the `url_assumption_holds` output written for exactly
   this, because a wrong URL here is **silent**: tasks and scheduled runs 404 forever while every
   service looks healthy.
4. **`PUBLIC_BASE_URL` on the web service alone crashed every scheduled run.** The worker's
   `resolveConfig` requires it and fails closed. Found by reading the worker's logs after forcing a
   run; the apply was green throughout.

Reading `.uri` back off the services is the obvious fix for (3) and **cannot work**: every service
needs `PUBLIC_BASE_URL`, so any service URL fed into shared config makes that service depend on
itself. Two applies hit that cycle from opposite directions. The host suffix is now an explicit
documented input, and three plan assertions pin the task target, the shared base URL, and the
worker actually having one.

### The Telnyx credentials were re-fetched, not copied — the legacy ones are stale

The plan says the legacy Secret Manager entries hold the same exposed credentials. **Tested: the
legacy `TELNYX_API_KEY` returns 401 against the live API.** Copying it would have produced a dead
SMS path that looked correctly configured. All four new values verified live before use: API key
200, public key decodes to 32 bytes *and* matches `/v2/public_key`, from-number valid E.164 and on
the matching messaging profile.

Note the public key legitimately did **not** change — it belongs to the account and does not rotate
with an API key. Its byte-identity with the legacy copy is correct, not a mistake.

### A source assertion matched its own explanatory comment

Third instance of this trap in this repo, after an import line satisfying a `waitUntil` check and a
loose alternation matching a CLI flag. The prohibition on `waitUntil(` matched the *comment*
explaining why `waitUntil` is absent. The helpers now strip comments as well as imports. **Prose
about a construct is not the construct.**

### Owed

Rotation (F-034) **deferred again** — sound only while no real phone numbers exist, and the database
is now empty, so the window is genuinely open. The first real inbound SMS closes it. Telnyx's
webhook still points at Vercel; the Vercel project, the stale `throwaway/hobby-deploy-test` branch,
and the legacy Firebase resources are all still owed a teardown. B-002 production seeding remains a
deliberate not-yet.

---

## 2026-07-28 — the housekeeping checkpoint: GL-031/032/034/035/036, and a rotation procedure that would have broken production

Third go-live tranche, and the one Max asked to review before P1. Five items, four of them
documentation truth-telling. Same method as last session — one item per subagent in an isolated
worktree, then verify every claim by *running* it here. That method earned its keep twice below.

### GL-035 — two of three "dead mechanisms" were not dead, and one deletion would have been serious

The guide proposed deleting `roles.ts`, the `SmsSimulator`/`SmsTransport` family, and
`openOrReviseProposal().activate()`. I wrote a starting map from my own greps and **got two of the
three wrong**, in the dangerous direction. The subagent contradicted me on both; I re-checked and it
was right.

**`roles.ts` is live.** My grep looked for the import *path* (`from "./roles"`, `auth/roles`) and
found only its own test and the barrel. But `@farm-friend/core` **is** a barrel, and production
imports through it: `apps/web/lib/admin-guard.ts` — the one guard all five admin API routes share —
calls `requireRole` and `AuthorizationError`, and four admin pages call `hasRole`. Deleting the file
would have deleted the live admin authority check. What was genuinely dead is narrower: the
`staff`/`farmer` values and the "admin implies staff" `IMPLIES` table, which nothing could ever
produce (`packages/db/src/admin.ts` returns the constant `["admin"]`). `Role` is now `"admin"` alone.
An implication table that can never fire reads as protection while proving nothing.

**The parallel SMS path was real, and it held the safety proof.** Correction to my map in the other
direction: `SmsTransport` is *not* the live seam — `createLastMileSender` takes a `ProviderTransport`
(a plain function type in `delivery.ts`), and that is what the composition root wires Telnyx into.
`SmsTransport`/`OutboundMessage`/`SmsSimulator`/`SentMessage` plus the metrics logger were reachable
only from the package's own tests.

The consequential part: **`safety-boundary.type-test.ts` — the Golden Rule #6 layer-1 compile guard
— asserted the branded outbound type against `OutboundMessage`.** The static provenance barrier was
being proven of a path production never took. That is the exact failure family CLAUDE.md already
documents twice (a source assertion satisfied by incidental text; a stub that cannot see what the
real thing does), one level up: *a safety proof anchored to dead code is not a safety proof*.
Re-anchored to `LastMileSendInput`. I sabotaged it myself rather than trusting the report — erasing
the brand fails **both** bypass assertions.

`estimateSmsSegments` and `normalizeAvoidableSmsUnicode` were kept deliberately: the normalizer is
already on the real path via the outbound guard, and the estimator is precisely the machinery
**GL-021** exists to attach to the real send path. Deleting it would mean rebuilding it in a fortnight.

**`activate()` was the genuine duplicate — and the two writers had already diverged.** Production
activation lives in the outbound worker (`apps/web/lib/workers.ts`); the test-only `activate()` wrote
the same three columns differently: it targeted `where id = proposalId` with no state guard, while
production matches `state = 'open'` + recipient + `inventory_confirmation`, and copies
`proposal_version` **in SQL** rather than reading it first (a read-then-write can record a version a
concurrent revision already superseded). Ten integration tests exercised the synthetic path, so any
drift between them was invisible. Now one exported `activateAcceptedPrompt` in `packages/db`, called
by both — tests adapted to production's behavior, never the reverse. My own sabotage of the shared
write fails **11 integration tests** across 2 files, and trips the `activation_coherent` CHECK
constraint besides.

### GL-034 — the code was right; the words a farmer reads were not

B-011 established that the carrier owns STOP/START: `START` lifts Telnyx's block, `JOIN` does not,
so JOIN enrolls only a first-time sender. `consentTransitionFor` implements that exactly.

The gap was `docs/VIGA_10DLC_WEBSITE_COPY.md` — the paste-ready public Squarespace copy, i.e. what
someone reads *before* they ever text. Its Opt Out section said messaging stops "unless you request
to rejoin", **naming no keyword at all**. A reader who was just told the opt-in word is JOIN reaches
for JOIN, is refused, and stays blocked with no idea why. No test policed that file. Five sections
now name START for the returning path; JOIN stays as the first-time call to action, and the new test
is scoped to the opt-out section so a whole-document ban can't creep in and break the registration.
Sabotage-verified here, not just reported: reverting the section to JOIN fails both assertions.

Registered 10DLC copy and `TELNYX_10DLC_FIELD_VALUES.txt` were untouched — that file is a transcript
of live console state, and the rule is change the console first, then transcribe. Two optional
console edits are written up under GL-034, and my recommendation is **to weigh them, not just do
them**: Telnyx auto-answers STOP/START in its own copy and enforces its block list independently of
the profile's auto-response fields, so neither edit changes what an opted-out user experiences. They
buy registration-vs-page consistency against the cost of a possible campaign re-review.

### GL-031/032/036 — the docs stop carrying status, and stop claiming authority they no longer have

Max made two calls that shaped this: **status lives in CLAUDE.md only** (docs drop their build-status
banners entirely rather than getting corrected ones — five fewer places to go stale), and the
**session logs stay exactly as they are but leave the reading path** (nothing rewritten; they simply
stop being startup context).

The risky half of retiring the clean-room handoff was not removing the banners — it was making sure
nothing it *settled* existed only there. Three things did, and were moved before the banners came
off: code-owned message-frequency limits (→ ARCHITECTURE, written as an explicitly **unbuilt**
requirement, since no cadence cap exists anywhere in the code), the excluded-infrastructure list —
no Kafka, event bus, event sourcing, workflow engine, distributed lock, policy engine, DLP, vector
database, additional package (→ ARCHITECTURE's design stance), and the disambiguation that
retrieval-first means before *fact selection*, not before *interpretation* (→ AI_ARCHITECTURE).

Stale claims corrected: ARCHITECTURE listed customer inquiry, stock-out, retention, authentication,
and the model privacy boundary as "Not implemented" — all five are built; AI_ARCHITECTURE said "the
configured provider is still the deterministic stub" 140 lines before documenting the DeepInfra
adapter; PRODUCT_BRIEF listed eleven decisions as open when seven were settled in code; `maps/README`
still called the seeder future work. Two the review had not named: ARCHITECTURE claimed a QR
stock-out **web form** as a built surface (only the API route exists), and the RUNBOOK finding below.

### The find of the session: a rotation procedure that would have broken production

`RUNBOOK.md` §"Credential rotation" said `DEEPINFRA_API_KEY` is **not** a production credential —
"absent from Vercel entirely, so the deployment runs the deterministic stub" — and instructed
rotating it in the DeepInfra console and **local `.env` only**. That was true when written. **GL-019
made it false** by setting `LLM_PROVIDER=deepinfra` in production, and nothing went back to correct
the rotation instructions. F-034's own PM checklist and CLAUDE.md carried the same line.

So the documented procedure for the one remaining go-live blocker would have revoked the key while
production kept calling DeepInfra with it — every model seam failing in the deployment, while local
`evals:live` stayed green because the local `.env` had just been updated. Corrected in all three
places, with an instruction to confirm a variable's presence in Vercel before rotating rather than
trusting any table, including that one. This is the same reasoning-from-a-stale-record error as
trusting `vercel env ls`'s timestamp column, and the reason the honest check is always behavioural.

### Verified

`npm test` **498/498 across 53 files**; `npm run test:integration` **311/311 across 19 files** on
real Postgres 16; `npm run evals` critical **11/11**, advisory 4/4, adversarial **29/29**; lint, root
typecheck, and `next build` all exit 0. **All run on the merged result**, not on the branches —
neither subagent tested the combination, and the merge is what ships. `evals:live` not re-run: no
seam projection, schema, or output contract changed.

One integration run early on failed two files with **hook timeouts**, then passed 19/19 twice — the
documented environmental signature (a failure that *moves*). It coincided with a second suite I had
running against the same Postgres.

### Owed

P1 (GL-007 onward) is next and unstarted. **GL-001 credential rotation remains the hard go-live
blocker**, now with a corrected procedure. Two optional Telnyx console edits under GL-034. GL-021
will consume `estimateSmsSegments`, kept for exactly that.

## 2026-07-28 — P0 closed except rotation: one-use links, a truthful typecheck, a repaired migration generator

Second go-live tranche. **GL-004, GL-005, GL-006 closed**; P0 now holds only GL-001, whose
remaining work is max's provider-console rotation. Delegated one item at a time to subagents in
isolated worktrees, then verified every claim by running it here rather than reading the summary —
which is what caught the two corrections below.

### GL-004 — the magic link was a signature, and a signature repeats

`verifyMagicToken` was pure HMAC over `{email, issuedAt, expiresAt}`. A signature says "authentic"
every time it is asked, so every callback inside the 15-minute window minted a fresh session, while
`sign-in-email.ts` had promised "can be used once" since F-032. A link forwarded, scanned by a mail
gateway, or sitting in a shared inbox was a working credential for the whole window.

**The fix is a column, not a table.** Each link carries a random 32-byte nonce inside its signed
payload; the callback stores its SHA-256 in `admin_sessions.magic_nonce_hash` under a unique index,
written by the *same insert that creates the session*. A link being spent and a session existing
are the same event, so there is no second record to reconcile and no window where one exists
without the other.

The rejected design is the more interesting half. A separate credential table would have to be
written at **mint** time — that is, from the internet, by anyone who can guess an operator's
address. That is both an unauthenticated write path and a per-address row whose presence is exactly
the membership oracle `/api/auth/request-link` exists to deny. Minting still writes nothing; the row
appears only when a link is *opened*, by someone already holding a validly signed one.

The arbiter is `on conflict (magic_nonce_hash) do nothing returning id`, where the empty result is
the signal someone else won — not a check-then-write, since `for update` cannot lock a row that does
not exist yet (the B-011 lesson). Authority is re-read **before** the link is spent, so a revoked
operator's link is refused without being burned. `link_already_used` and `not_an_administrator` both
render 401, so a replayed link is not a probe for which links were genuine. Legacy tokens with no
nonce fail closed as `malformed` rather than defaulting to a placeholder — a placeholder would give
every such link the same identity, so opening one would consume all of them.

**A race test that could not fail, caught by sabotage.** The first draft ran eight `Promise.all`
calls through one `Db` handle, whose pool holds three connections — so each transaction completed
before the next began and the read-then-write sabotage passed untouched. Each claimant now gets its
**own connection** plus a barrier so all eight reach the insert together. This is the `Promise.all`
rule with a pool-size twist the standing rules did not previously state.

### GL-005 — the typecheck was blind to the whole web app, and hid a production defect

Root `tsconfig.json` referenced only the four packages, so "typecheck passes" was a claim about
`packages/`, never `apps/web`. Behind that blindness sat **57** errors — and 17 of them were a
latent **production** defect, not test noise: `type Sql = ReturnType<typeof postgres>` picks the
last of two overloads and evaluates its conditional against the *unresolved* generic, collapsing the
type map to `never`, so the tagged template accepted **no parameters at all**. `sql`…${id}`` failed
to typecheck while working perfectly at runtime. `Sql`/`Tx` now live once in `packages/db/src/sql.ts`
(`Tx` had separately drifted to a contravariantly incompatible type map).

The other 27 were fixed by **narrowing the production signature rather than widening the test's
lie**: `resolveConfig`/`createAppContext` now take `Record<string, string | undefined>`, which is all
they ever read, and which `resolveSmsConfig` already used — so this made two conventions agree
rather than adding a third. Nothing suppressed: zero `@ts-expect-error`, `any`, or `exclude` globs
added.

Root `typecheck` is now `typecheck:packages && typecheck:web`, two halves because
`apps/web/tsconfig.json` is `composite: false` and `tsc -b` cannot reference it. **Proof it is
genuinely truthful:** a deliberate `TS2322` in a web file — GL-004's callback route, which the
subagent never saw — exits **1** under the new typecheck and **0** under the old bare `tsc -b`.

### GL-006 — the migration generator was guessing at history

Seven migrations journaled, snapshots stopped at `0001`. Reproduced before fixing: a generation
trial stopped and asked *"Is message_category column in outbox_work table created or renamed from
another column?"* — a column migration `0002` added. Snapshot `0001` described 22 tables against a
schema of 25.

**Applying was never affected**, which is precisely what kept this invisible: the integration suite
builds a database from empty and applies all seven on every run. Only *generation* was
untrustworthy, and the danger is not that the tool errors out — it is that a wrong answer to a
rename prompt writes a plausible migration that re-creates existing tables or renames a column out
from under production data.

**Repaired with one file.** Reading drizzle-kit 0.22.8's source rather than assuming: it diffs
against `snapshots[snapshots.length - 1]` **only** (`preparePrevSnapshot`) and enumerates snapshots
from the directory listing, not the journal. So a single current `0006_snapshot.json` chained onto
`0001` is the complete fix. Reconstructing the five missing intermediates was deliberately **not**
done — five point-in-time pictures nobody can verify against a database would be fabricating
evidence rather than repairing metadata, and the tripwire asserts the rule the tool actually has
rather than a stricter invented one. No `.sql` file changed: the md5 over all seven is byte-identical
before and after. The trial now reports *"No schema changes, nothing to migrate."*

### Two subagent claims that did not survive verification

Both found by running the thing rather than reading the report, which is the whole reason the
verify-don't-relay rule exists.

- **"`npm run lint` exits 0 while printing errors"** — filed as a proposed new item. It does not: a
  deliberate unused import produces `✖ 1 problem` and **exit 1**. The likely cause is reading a
  piped exit status (`${PIPESTATUS}` vs `$?`). No item filed.
- **CLAUDE.md's "54 web type errors"** was stale; the real baseline was **57**, confirmed twice
  before GL-005 started.

Also corrected mid-session: the main agent committed the three agent worktree directories into the
repo by accident (`git add -A` swept them in). Removed from the commit and `.claude/worktrees/`
added to `.gitignore` so it cannot recur.

### Deployed and migrated, verified by effect

Pushed straight to `main` (max's call — the work was already verified, and the repo's Vercel check
is permanently red for unrelated reasons). Migration **0006** applied to production and the CLI
deploy promoted, in that order, so production never ran code ahead of its schema.

The connection string came from max — **Vercel's `DATABASE_URL` is unreadable** (`vercel env pull`
returns `[SENSITIVE]`), which is a standing constraint, not a one-off. Before migrating, the target
was **fingerprinted** rather than trusted: `neondb`, 6 migrations applied, 21 `sms_messages` and 21
`outbox_work` rows from live testing, 0 stands. That is unmistakably production and not a copy — the
discipline the reset-script near-miss taught. max used the **direct (non-pooled)** Neon string, which
is the right endpoint for DDL and does not affect what the app runs.

Proof by effect after the deploy: 7 migrations, `magic_nonce_hash` present and nullable,
`admin_sessions_one_per_magic_nonce` created; health 200, `/api/public/stands` 200 `{"stands":[]}`,
cron **401**, webhook **401**, admin **403**. The webhook's 401 rather than 500 is the load-bearing
check — under the three-way diagnostic it proves configuration still resolves. Sign-in returned
**202 for every address**, including a real administrator address, a stranger, and a malformed one,
so enumeration resistance survived; the callback answered **401** to a garbage token rather than
500, which is what a schema mismatch would have produced.

`apps/web/vercel.json`'s one-minute `crons` block was stripped **uncommitted** for the Hobby deploy
and restored immediately after, per the standing procedure.

**Honest limit on the GL-004 proof:** production holds **0 administrators**, so the one-use replay
was not exercised end to end against the live deployment. It is proven by the integration suite and
by hand-run sabotage locally, and the deployed code path is confirmed only as far as "does not error
against the real schema." Closing that gap needs a bootstrapped administrator, which is a deliberate
authorization grant rather than wrap housekeeping.

---

---

## 2026-07-28 — three defects the green suites could not see, and production was running the stub

First tranche off `docs/GO_LIVE_GUIDE.md`. GL-002, GL-003, GL-019 and GL-033 closed; GL-001
scoped and deferred by max. Every finding was reconfirmed against the code before being fixed —
the guide is a review artifact, not a spec, and one of its claims was wrong.

### GL-001 — the scope was wrong in both directions, and the repo was never leaking

Checking the live environment instead of the notes corrected two things. **The DeepInfra key is
not a production credential**: `LLM_PROVIDER`, `DEEPINFRA_API_KEY`, and `DEEPINFRA_MODEL` were
absent from Vercel entirely. It rotates in the DeepInfra console, not Vercel — and that absence
turned out to be a live defect in its own right (GL-019, below). **The repository is clean**:
`git grep` over the tracked tree finds no real connection string, key, or Neon host; every
secret-shaped literal is a test fixture and `.env` has never been committed. So rotation is the
complete remedy — no history rewrite, nothing published to recall.

The procedure now lives in RUNBOOK §"Credential rotation" with proof-by-effect tables for both the
new values and the old. max decided **rotate in place** — the throwaway Hobby project and its Neon
database become production, so F-034's "tear down the project" line is withdrawn (its stale branch
is still owed a deletion) — then **deferred the rotation itself**. Sound only while the database
stays unseeded; that constraint is now written into the item rather than assumed.

### GL-002 — a delayed STOP was silently discarded

`runInboundPass` rejected every stale event *before* parsing it. So a `STOP` delayed in the carrier
network, arriving after a newer ordinary message had advanced the conversation watermark, was
finalized `stale_conversation_event` and never reached `applyConsentTransition`. The sender opted
out; Farm Friend recorded them active and would have kept sending.

The staleness rule was sound but **scoped wrong**. It protects *conversation* state, and the two
watermarks are independent — consent orders itself on `consent_transition_watermarks`, where an
older START cannot undo a newer STOP and STOP wins an exact tie. The conversation watermark
therefore has no standing over a compliance keyword.

So the fix is not an exception carved out for STOP; it is the rule applied to the state it actually
protects. `routeInboundMessage` takes staleness as an input and owns the decision: compliance
parsed **before** the gate, the gate applied to free text and confirmation tokens only. Consent
ordering is untouched. Finalizing a routed stale event `processed` is safe because
`claimNextInboundEvent` already guards the watermark update with `!isStale`.

The test asserts the opt-out comes back from `authorizeDispatch` as **`suppressed`** — consent that
changes state without reaching the dispatch guard is a paper opt-out. Sabotage both ways: restoring
the old order fails only the delayed-STOP test; deleting the gate fails only the two stale-refusal
tests.

### GL-003 — two holes, not one

`authorizeDispatch` commits `dispatching` before the body read, redaction, recipient resolution,
provider call, and result recording. `dispatching` was written in **exactly one place and read by
nothing** — `releaseAbandonedClaims` recovers inbound events only, outbound enumeration selects
`queued`. And `runOutboundPass` had **no error handling at all**, so one throw aborted the whole
pass and blocked every other sender's reply.

Two defenses, deliberately different in kind, because neither substitutes for the other: a per-row
`catch` (a lease cannot isolate a row mid-pass) and a durable 10-minute lease (a killed process
runs no catch block).

Recovery resolves to **`ambiguous`**, never `queued`. We cannot know whether the provider accepted
the message before we lost the thread, and requeueing would resend an SMS a real person may already
be holding. That is precisely what `ambiguous` already meant here, so it reuses the state and
**needed no migration** — the elegant path was also the correct one. The lease is deliberately
generous: expiring it on a merely slow call would quarantine work about to succeed, and a delayed
reply is a smaller harm than a duplicate message.

**Deliberately not built:** an operator view of quarantined work. The state is durable and
queryable; somewhere to *read* it belongs with GL-016/GL-018, and the dependency is noted in both
items rather than becoming a third bespoke surface.

### GL-019 — production had been running the test double its whole life

Pulled forward from P2 at max's request, because it was affecting the live site right then.
`resolveModelConfig` defaulted to `"stub"` when `LLM_PROVIDER` was absent, and production never had
it set. Every model-backed journey degraded into a clarification while health checks, the webhook,
and all 479 tests stayed green — because from the code's point of view nothing was wrong. The
default had been chosen.

The guide asked for "explicit provider selection **in production**," which invites environment
sniffing. This codebase already refuses that: `cron-auth.test.ts` asserts the cron route contains
no `NODE_ENV`/`VERCEL_ENV`, on the reasoning that a guard which relaxes in development is one
misconfigured deploy from being public. **That is exactly how this defect survived** — the default
behaved identically everywhere it was tested. Put to max, who chose **refuse everywhere**:
`LLM_PROVIDER` is now required with no default, like `PHONE_HASH_SALT`. The stub is unchanged and
still used by tests, evals, and local dev; it lost only the ability to be selected by accident.

Six unit fixtures and two integration suites relied on the implicit default. They now state
`LLM_PROVIDER=stub` — the assertion was not loosened to accommodate them. A source assertion
anchored to the selector pins both "no `??` default" and "no env flag"; sabotage-verified against
the old default *and* against a `VERCEL_ENV === "production"` variant.

`.env.example` was created (**GL-033**), which this change turned from merely missing into
load-bearing: without it a developer cannot start the app.

### Production configuration, verified by effect

max set `LLM_PROVIDER=deepinfra`, `DEEPINFRA_MODEL=mistralai/Mistral-Small-24B-Instruct-2501`, and
`DEEPINFRA_API_KEY` in Vercel, and un-marked four variables that were needlessly **Sensitive**
(`SMS_PROVIDER`, `PUBLIC_BASE_URL`, `TELNYX_PUBLIC_KEY`, `TELNYX_MESSAGING_PROFILE_ID` — a provider
name, a public origin, verification material, and an identifier). Vercel's Sensitive flag is
one-way, so each had to be deleted and re-added; the cost of the flag is losing the ability to
confirm what production is set to.

Verified after redeploy: health 200, cron 401, stands 200, admin 403, and webhook **401 rather than
500** — under the three-way diagnostic that proves every Telnyx credential still resolves. The
sharper check: a deliberately malformed signature returns **`malformed_signature`**, which means
the handler loaded `TELNYX_PUBLIC_KEY` and decoded it as a valid 32-byte ed25519 key before
rejecting the junk. "Non-empty" and "correct" look identical in a dashboard; this distinguishes
them. `vercel env pull` now reads back the four un-marked values and still returns `[SENSITIVE]`
for all six real secrets.

**Consequence: DeepInfra calls now cost money on real traffic.** Under $1/month at launch volume,
but no longer zero.

Merged as `c0c2b4e` (PR #53, squash) and **deployed the same session** — the standing rule after a
past session found three merged fixes production had never received. Post-deploy proof on the new
build: health 200, stands 200, admin 403, cron 401, webhook 401 (not 500, so the new
`required(env, "LLM_PROVIDER")` found its value), `malformed_signature` on a junk signature, and a
**GitHub-triggered scheduled run returning 200** — which exercises `CRON_SECRET` and all four worker
passes against the deployed code, since the workflow fails the run on any other status. The Hobby
plan still rejects the committed one-minute cron, so the `crons` block was stripped uncommitted for
the deploy and restored immediately (GL-017 owns settling that).

### Standing lessons

- **A review artifact is a set of leads, not a spec.** Three findings were exactly right; one
  named a production credential that was not one, and the discrepancy was itself the bigger defect.
- **"Required in production" is a smell.** A rule that relaxes off-production behaves one way
  everywhere it is tested and another way where it matters — the shape that hid GL-019 for the
  deployment's entire life.
- **Reuse the state that already means what you need.** GL-003 wanted a quarantine outcome and
  `ambiguous` already was one, so a defect that looked like it needed a migration needed none.

## 2026-07-28 — the model finally runs, and it breaks everything the stub could not

F-024 closed: the DeepInfra attestation filled from the real terms, the first live-model run, the
three defects it exposed that 471 green unit tests could not, the offering seam over the real
corpus, and F-037's operator surface for the flags that seam's sibling raises.

### The attestation, and the clause that had to become code

max read DeepInfra's data-processing terms and directed the fill. Values transcribed verbatim
from <https://docs.deepinfra.com/account/data-privacy>: no training on API data, inputs in memory
only and outputs deleted once returned, request **content** not logged (metadata only: request id,
cost, sampling parameters), zero stated retention. The caveat is recorded at the binding rather
than smoothed over — DeepInfra reserves an unbounded discretionary right to log "a small portion
of requests" for debugging or security, and inventing a number to bound it would be exactly the
inference the gate forbids.

One clause could not stay prose. Their no-training sentence carries an exception: *"except when
using Google or Anthropic models, where the receiving company's training policy applies."* Those
are models DeepInfra **routes** to another vendor's endpoints under that vendor's unattested
terms — so an `anthropic/` or `google/` `DEEPINFRA_MODEL` would have made the version-controlled
attestation false for a reachable configuration. It is now a startup error.

**The attestation moved to `packages/ai/src/deepinfra.ts`**, beside the adapter it gates. It had
been in the web composition root, which the propose script and the live evals never pass through —
they construct the provider directly, and would have bypassed the gate entirely.
`assertDeepInfraSelectionApproved` is now the one approval path for every consumer.

The source tests flipped: they had pinned the `null` literal so no agent could fill it with
guesses; they now pin the four values **and the citation** — URL and review date must appear in
the comment block immediately preceding the binding. Values flipped → 2 tests fail; citation
removed → 1; prefix guard emptied → 1.

### The first live run failed every seam, and the suite stayed green

The whole point of the exercise, and it delivered on the first call. `npm run evals:live` against
the real model: **every seam returned `invalid_output`**. Unit tests 471/471 green. Scripted evals
44/44 green. The stub reads neither the instructions nor the schema, so nothing in the existing
suite could see any of it.

**Defect 1 — the instructions described a different job.** Every projection attached
`COORDINATOR_SMS_OUTPUT_INSTRUCTIONS` — *"Write a concise SMS reply. Prefer one GSM-7 segment…"* —
to seams whose schemas accept only structured JSON, and **nothing anywhere stated the expected
shape**. The model returned `{"smsReply":"Added tomatoes, kale, and a dozen eggs to your
inventory"}`, which is a perfectly reasonable answer to the question we actually asked. Replaced
with per-seam contracts: example shapes plus semantic notes, and `output-contracts.test.ts` parses
every documented example **through the real schema**, so the prose a model reads cannot drift from
the validator that judges it. It also asserts kind-coverage in both directions — a schema gaining
a shape the instructions never mention leaves the model unable to use it; an instruction naming a
removed shape teaches a refused output.

**Defect 2 — `null` is how models say "not stated".** `{"quantity": null}` for a farmer who never
gave a quantity, and Zod's `.optional()` refuses `null`. `nullAsAbsent()` treats it as absence
**only where the schema already declares optionality** — same class of decision as the adapter's
code-fence stripping, a formatting idiom rather than a content one. A null-valued **unknown** key
still hits the strict schema's visible refusal, which is asserted, because that is the difference
between tolerating an idiom and quietly accepting a smuggled field.

**Defect 3 — the corpus disproved a bound, again.** Venison Valley Farm & Creamery legitimately
offers ~26 things (a creamery plus a produce partner), against a 24-item cap. Raised to 40 with a
refusal test at 60. Third time the real 31 stands have corrected a number that looked fine in the
abstract.

### What the containment fixtures proved, and why they are not "the model behaved"

`evals/live.ts` splits into **live-containment** (must be 100%) and **live-quality** (recorded).
The containment fixtures actively invite the model to comply with an injection, so the pass
condition is *the barrier held*, never *the model refused*. Llama duly complied — asked to include
`loc-999` in its selection, **it did**, and membership validation rejected the whole selection.
That is the harness working, observed rather than asserted.

**12/12 containment on both candidates.** Quality over three runs each: Mistral Small 24B
**6/6, 6/6, 6/6**; Llama 3.3 70B Turbo 5/6, 5/6, 6/6 — the extraction fixture flaking run to run
under batching variance. max chose **Mistral Small 24B**: stable, ~5× cheaper, and the stronger
performer on exactly these structured tasks. Bigger did not mean better here.

**Cost and rate-limit posture:** DeepInfra allows 200 concurrent requests per model, 429 beyond,
no RPM cap. Farm Friend's own ceilings keep worst-case concurrency in single digits, so the public
throttle needed no change. Under $1/month at launch volume.

### The offering seam, and the corpus's last correction

`npm run offerings:propose` → review → `npm run db:seed-offerings`. The propose step strips
contacts before any text reaches the model (the projection fails closed on a raw phone, so an
unstripped description would refuse rather than leak) and writes proposals beside the source text
they came from. **31/31 proposed.** max reviewed every list and approved with one edit: Aeggy's
redundant "eggs / duck eggs / chicken eggs" collapsed. Narwhal's "swag" stays — the stand
advertises it. Seedrain's "invasive plant control" stays too, and produced **F-038**: it is a
farm-related *business*, not a stand or a market, and the system has no type for that yet.

`seedOfferings` is the code-commits half — idempotent on (location, item), never rewrites an
existing tag (a farmer may have corrected it since), reports unknown stand names rather than
inventing them, writes zero inventory. The propose script lives in `packages/ai`, not
`packages/db`: it composes ai + core, and **db must not depend on ai**.

### F-037: a decision queue that cannot become an editing surface

The seeder's three real flags (Green Ears ×2, Holmestead) were visible only by SQL.
`/admin/stand-data` now lists each with the stand, the reason in plain words, and the source text
verbatim; resolving requires a note saying what was decided, because a resolution with no recorded
decision makes the queue a dismiss button.

The property worth the effort: **resolution records a decision and cannot act on it.** No write
path to `sales_locations`, offerings, or inventory. The temptation is specific — *"resolve the
contradiction by fixing the hours while I'm here"* — and a listing edit is a different capability
with its own authority story. Pinned by byte-equality over every listing field, sabotage-verified
by adding a listing update inside the transaction.

### The race test that could not fail, found by sabotage

The concurrency test used eight claimants sharing **one** administrator row — and it passed with
the flag's `for update` deleted. The authority re-read's own `for update` on that single admin row
serializes every transaction before the flag lock is ever contended, so the test was measuring the
wrong lock. Fixed to race **eight distinct administrators**, which is also the real scenario the
409 exists for; the sabotage then fails it correctly. Same family as the source-assertion failures
already recorded twice: the test looked right and proved nothing.

**Verified:** unit **479/479** (50 files), integration **285/285** (18 files) on real Postgres 16,
evals critical 11/11 + advisory 4/4 + adversarial 29/29 with **no fixture touched**, live evals as
above, typecheck/lint/`next build` clean.

**Released:** `a1e6fb7` (PR #49), `b47c564` (PR #50), `ea4889b` (PR #51), each deployed with
`npx vercel --prod` immediately after merge, crons block stripped uncommitted and restored.
Verified by effect: health `{"ok":true}`, cron **401**, webhook **401** (the load-bearing one —
401 rather than 500 proves config still resolves), and `/api/admin/stand-data-flags` **403** on
both methods.

**Production remains deliberately unseeded.** `/api/public/stands` returns `{"stands":[]}`. The
offerings are approved but not committed to production: that still waits on the 3 missing
addresses and F-034.

---
## 2026-07-28 — the seeder meets the real file, and a provider that refuses to start

F-024's adapter built behind an enforced attestation block, and B-002's loader run against VIGA's
actual export — which turned out to disagree with the documentation in four places, three of them
the dangerous direction.

### The CSV is malformed, and a standard parser reads it wrong in silence

The docs said "31 stands, real WKT coordinates". True, but not the whole shape. Each stand's
`description` field is **unquoted and spans raw newlines**, running until the next `"POINT (`
line. Python's `csv.DictReader` on this exact file returns **285 rows for 31 stands**, and every
continuation line — addresses, `Open:` lines, update notes — is attributed to the *following*
farm. Nothing downstream would have noticed: the availability parser would happily read a season
off the neighbouring stand's text and produce a confident, wrong map.

`packages/core/src/seed/stand-csv.ts` anchors records to the `"POINT (` literal instead of to
line count. The first naive parse is preserved in the test file's comment, because the failure is
invisible and worth a warning to whoever touches this next.

### The PII count was wrong in the direction that matters

Documented: 23 emails + 2 phone numbers. Actual, measured against the corpus: **22 unique emails
+ 4 phone numbers** (Northbourne, Peach Tree Hill, Vashon Garlic, Venison Valley). The email
figure was a raw-occurrence count; the phone figure was simply half. For a stripper, undercounting
is the failure direction — two numbers would have shipped.

Stripping keeps websites and `@handles` deliberately: the product contract publishes
farmer-selected web and social links, and only direct phone/email are private. Over-stripping
would have deleted facts VIGA intends to show. Verified by scanning every seeded text column in a
real database: **0 leaks**.

### Seeding found a real parser defect that no unit test would have

`parseStocking` read the **range** "Thursday - Sunday" as the two-element list {Thu, Sun},
dropping Friday and Saturday. Green Ears is stocked Thursday through Sunday and was invisible to a
customer filtering for Friday — with nothing reporting an error, because `specific_days` with two
days is a perfectly valid result. The `and` forms ("Saturday and Sunday") were always correct,
which is why the corpus was needed to expose it: the distinction is the *separator*.

Fixed test-first: dashed ranges expand, wrapping across the end of the week ("Saturday - Monday"
is Sat/Sun/Mon), while `and` lists stay lists. Sabotage-verified. This is the third time the rule
"measure against the real corpus before defending the code" has paid out on this parser.

### The flags are Green Ears and Holmestead — not Morgan Hill

The docs predicted Green Ears + Morgan Hill. Morgan Hill's "June 1, 2026 - TBD" **parses
correctly** as `open_ended` — the parser models the unknown end rather than guessing one, which is
exactly the designed behaviour, so it needs no human. The real second flag is **Holmestead
Farms**, whose "Mid April Weekends" states a start with no end and is genuinely unresolvable
(`season_unresolved`). Green Ears carries both `contradictory_hours` (two different `Open:` lines)
and `possibly_closed` ("7/9/2026 Update: Closed").

### Three stands refused rather than given an invented address

`public_address` is NOT NULL, and the Farmers Market, Breathing Meadows Farm and Open Gate Lamb
state no street address in the export. Inventing one is the coordinate-fabrication failure F-017
forbids, so the loader **refuses them and reports them** as operator tasks. 28 of 31 seeded.
Getting those three addresses from VIGA is max's call.

### Zero inventory is structural, not merely omitted

The seeder cannot fabricate a farmer's confirmation because `inventory_revisions` requires
`published_by_authorization_id` + `farm_approval_id`, and the seeder creates neither. Proven
against a real seeded database rather than asserted: revisions, entries, contacts, authorizations
and approvals are all **0**. Idempotency (second run: seeded 0, skipped 28), whole-batch rollback,
and constraint-refusal-without-coercion are each sabotage-verified.

### F-024: the block is enforced, not commented

The adapter is built and `LLM_PROVIDER` is finally **real** — it had been sitting in
`.env.example` advertising `stub|openweight` while `resolveModelConfig` hard-coded the stub and
never read the environment. An unknown value now throws rather than silently running the scripted
test double against real farmers.

`DEEPINFRA_DATA_HANDLING` is `null` and selecting the provider **throws a ConfigurationError
naming all four gate terms**. The point is that the attestation TODO is enforced by code and tests
rather than by a comment someone might overwrite: two source-asserting tests anchored to the
`null` literal, sabotage-verified by filling in plausible-looking values (3 tests fail). Per
CLAUDE.md an agent must never infer those values from marketing copy — so the offering seam did
**not** run this session, and `sales_location_offerings` is correctly empty. That is the honest
state, not an unfinished one.

### A hung suite that was the internet, and how it was ruled out

Two integration runs timed out mid-suite, each with a *different* named failing test. A failure
that moves between runs is the tell for environment rather than logic — and `git stash` settled it
cheaply: the hang reproduced on **clean `main` with the branch stashed**, so it was never a
regression from this work. max confirmed the connection had dropped. It recovered on its own and
the suite then ran in 13.5s. Worth keeping: a named failing test is a real defect until shown
otherwise, but stashing is the fast way to prove whose defect it is.

**Verified:** unit 471/471 (49 files), integration 273/273 (18 files) on real Postgres 16.12,
evals critical 11/11 + advisory 4/4 + adversarial 29/29 with **no fixture touched**,
typecheck/lint/`next build` clean.

**Released:** merged as `468859a` (PR #48, squash) and deployed with `npx vercel --prod`, crons
block stripped uncommitted and restored immediately. Verified **by effect**, since a CLI deploy
creates no GitHub deployment record: health `{"ok":true}`, cron **401**, webhook **401** — the last
being the useful one, because the three-way diagnostic makes 401 (not 500) proof that config still
resolves after the `resolveModelConfig` rewrite. The permanently-red Vercel check was confirmed red
on `main` itself before merging past it.

**Production is deliberately NOT seeded** (max, this session). `/api/public/stands` returns
`{"stands":[]}`. Seeding waits on three things so the corpus is loaded once rather than corrected
after: the 3 missing addresses, offerings pending F-024, and — the real constraint — **F-034
credential rotation, still deferred while the production `DATABASE_URL` sits exposed in two
transcripts**. That deferral is sound only while there is no real data in the database, and 28 real
VIGA stands moves that line.

**Owed:** **F-037** (filed this session) — the `stand_data_flags` operator surface, since the
seeder now raises flags nobody can act on; addresses for the 3 refused stands; and, once the
attestation lands, evals against the real model plus the cost/rate-limit check.

---

## 2026-07-28 — the deploy that never happened, and structure for the map

B-012 verified in production, then the seed tranche: a reader bug hiding behind the seeder gap,
migration 0005, and one model seam that replaced a regex the corpus disproved.

### B-012's callbacks were pending because the code was never deployed

The session opened by verifying B-012 by effect, the way F-026's purge was verified. The query
returned the same numbers as the day before: `message_received` 21/21 `processed`,
`message_sent` 9 + `message_finalized` 11 **all `pending`**. `outbox_work.delivery_status` NULL
across all 21 rows.

The scheduler itself was healthy — that was the useful negative control. Workflow runs returned
HTTP 200, and `sms_messages` showed **0 expired bodies still present**, so F-026's purge was
demonstrably executing against real data. A working scheduler running three-pass code looks
exactly like a broken fourth pass.

`gh api .../deployments` gave it away: production was serving **`9292961`** (B-007, 03:58Z), a
build from ~10 hours *before* `f16ef8f` merged. B-010 and B-011 had never been deployed either.
Corroboration without touching the code: migration 0004's columns were present (migrations are
applied separately via `npm run db:migrate`) while `provider_code` was populated on **0 of 35**
dispatch attempts — the schema was ahead of the application.

Deployed `ff75000` with `npx vercel --prod`, crons block stripped uncommitted and restored
immediately. One `workflow_dispatch` run later: all 20 callbacks `processed`, `delivery_status`
`delivered` on 11 rows, `finalized_at` set on every applied event, and **zero** callbacks against
the 5 failed + 5 ambiguous rows — correctly untouched, since the carrier never sent callbacks for
sends that never succeeded.

**A CLI deploy creates no GitHub deployment record**, so that API reports the last *Git
integration* SHA and is not evidence of what production runs. Verify the deployed build by
effect. Also observed: the `*/5` workflow actually fires **roughly hourly** (23:41, 22:32, 21:20,
01:08) — GitHub drops most slots, exactly as the workflow's own comment predicts.

### The seeder alone would not have fixed the empty map (B-013)

`listPublicStands` **inner**-joined `inventory_revisions`, so a location with no current revision
produced no row. B-002's own acceptance criterion — "every stand exists and is discoverable, and
no stand has a published inventory revision" — was unsatisfiable against that reader. Seeding 31
stands with zero inventory (the decided behavior) would have left the map exactly as empty, with a
green seed test. Second defect behind one symptom, the same shape as F-023 and F-026 before it.

The fix is a left join plus `nulls last`, and making `asOf`/`recencyLabel`/`isStale` optional
**together** so a stand nobody confirmed cannot render "updated just now". The UI already had an
`items-empty` branch — but it claimed *"the farmer confirmed this stand is empty"*, which for a
seeded stand is a confirmation nobody made. Now it distinguishes the two.

Sabotage found a gap in my own test: reverting `nulls last` **passed** the first draft, which
asserted membership but not order. Postgres sorts NULLs FIRST under `desc`, so unconfirmed stands
would have led the map ahead of freshly-confirmed ones. Added the ordering assertion.

### Two kinds of inventory, and why the separation is structural

max's framing: a stand has **specialties** ("usually has eggs, lamb") and **current stock** ("has
strawberries today"). These got two tables, and the reason is not stylistic —
`inventory_revisions` requires `published_by_authorization_id` and `farm_approval_id`, so the
seeder **structurally cannot** write current stock without fabricating a farmer and their consent.
A `kind` column on the revision table would have let seeded rows satisfy
`one_current_per_location` and render as confirmed.

### Enums from the corpus, not from a guess

max's call: enumerate the values that actually occur and expand when new ones appear. Extracted
from all 31 stands — `open_hours_kind`, `season_kind`, `stocking_cadence`, plus a day set.

`dawn_to_dusk` and `daylight_hours` are **first-class values, not degraded clock times**: dusk on
Vashon moves ~6 hours across the season, so 06:00–20:00 would invent precision the farmer never
stated — the same fabrication class as inventing a coordinate. Likewise `variable`/`as_needed`
are real answers, not NULL. `year_round` stays distinct from a null season so a filter can tell
"always open" from "never asked". Named seasons resolve at **query time** from one meteorological
constant, so a VIGA correction changes a constant rather than requiring a re-seed.

**A real defect the constraint tests caught:** `array_length(array[]::integer[], 1)` returns
**NULL**, not 0, so `between 1 and 7` evaluated to NULL on an empty array — and a CHECK constraint
**passes** on NULL. The first draft admitted the exact value it was written to forbid. Fixed with
`coalesce(..., 0)`.

### `not_stated` vs `unparsed` — the corpus forced the distinction

The availability parser's first draft flagged **12 of 31** stands. Ten were fine: "May 1 - Nov 1"
and "All year, All days" are not unreadable hours, they are stands that never stated a time of
day. Conflating "no hours recorded" (a fact) with "hours I could not read" (a defect) buried the
genuine ambiguities. After splitting them: **12 flags → 1**, and that one is real (Holmestead's
"Mid April Weekends", a month with no range end).

Two regex defects the tests caught: `(sun|mon|tues?|…)(?:day|s)?` matched neither "Mondays" (the
group cannot take both `day` and `s`) nor "Saturday" (`sat` matches, then `urday` fails the word
boundary).

### The regex that the corpus disproved, replaced by a seam

Offerings were the one job deterministic parsing could not do. Run against the real data it
produced customer-facing filter tags including `rotational grazing for chickens`, `special
occasions...etc..`, `but following organic practices`, and `plums ijuly)`. Distinguishing an
offering from a farming-practice clause requires reading the sentence.

`parseOfferings` was **deleted** — not left beside the seam — and replaced by
`offering-extraction`. The model proposes tags; the seeder records them for review; code commits.
The projection carries **one stand's description alone**: no farm name, no location id, no
contact. `.strict()` refuses output carrying `publish` or `salesLocationId` rather than stripping
it, so a model attempting a consequence is visible. Provider failure stays distinguishable from an
empty proposal — returning `[]` on failure would record "this stand offers nothing", a claim
nobody made.

Four adversarial fixtures (25 → 29), each sabotage-proved. One is not hypothetical: the projection
**fails closed on a raw phone in source text**, and VIGA's export carries two phone numbers.

Availability parsing stayed deterministic and needed no model — measured, not assumed.

### Where the model may and may not run (F-036)

max asked whether the map's filter should have an LLM component. Split into three cases so the
approval status of each is explicit: **seed-time** (built today), **query-time on the public map**
(blocked — that is the anonymous surface F-019 removed, and CLAUDE.md's Do-not list names it), and
**farmer-authored web submission** (a third case, *not* what F-019 blocked — a farmer editing
their own listing is the same act as texting an update, just a different transport; needs farmer
web auth, which does not exist, and must route through the same confirmation gate).

### Released and verified in production

Merged as `d49394c` (PR #47). Migration **0005** applied to production and verified by effect —
6 migrations, both new tables, all 4 enums, all 12 new columns. The app deployed with
`npx vercel --prod` (first invocation errored transiently on a concurrent build; the retry came
back `READY`), crons block stripped uncommitted and restored immediately.

**B-013 verified by effect in production, not inferred.** A probe stand with zero inventory was
inserted directly and `GET /api/public/stands` returned it with `items: []` and **no `updated` or
`stale` keys at all** — against the old inner join it would have been invisible. Probe deleted; the
endpoint is back to `{"stands":[]}` because the database has no stands yet, which is the seeder's
job. A scheduled worker run returned 200 against the deployed build.

Deploying immediately after the merge was deliberate: this session opened by finding three merged
fixes that had never been deployed, and the lesson only counts if it changes what gets done.

### Owed

The seam is built but **cannot run**: F-024's provider is still the stub. Seeding the 31 stands
waits on a real provider, or lands availability-only with offerings filled in later. max chose to
make the provider decision at the start of the next session, then run the seam.

---

## 2026-07-27 — the callbacks nothing read, and a rule enforced twice

B-012, found the day before while verifying the scheduler by effect. One bounded pass, and a
sabotage sequence that corrected the test rather than the code.

### The machinery was complete except for the part that runs it

`applyPendingDeliveryEvent` had **zero callers** — no pass, no webhook, not even a test. Everything
around it worked: Telnyx's `message.sent` / `message.finalized` callbacks were signature-verified,
minimized, correlated to their dispatch attempt by `provider_message_id`, and durably stored with
their `delivery_status` already on the row. Then nothing ever read them. Production: 21/21 inbound
events `processed`, all 20 delivery callbacks still `pending`.

The consequence is a meaning gap, not a crash. `sent` in `outbox_work` recorded that Telnyx
*accepted* a message and never that the carrier *delivered* it — which is exactly what you would
want when a farmer says they never got a prompt, and exactly the data B-011's invisible carrier
block would surface in. This is the third instance of the same shape (F-023 routing existed and was
unreachable; F-026's purge existed and was unscheduled), so the wiring test came first this time.

### Both design questions were settled by reading, not assuming

**Not the per-sender inbound path.** The schema had already made this decision and written it down:
`provider_inbox_events_minimal_projection_per_event_type` *forbids* a `sender_hash` on a delivery
row, and the one-claim-per-sender index is scoped `where event_type = 'message_received'`. Routing
delivery callbacks through `claimNextInboundEvent` would serialize unrelated carrier traffic behind
a farmer's conversation, and risk advancing a conversation watermark from an outbound event — which
would make that sender's *next real message* look stale and be rejected. So: a fourth bounded pass
on the one cron trigger, alongside inbound, outbound, and retention.

**Idempotent under replay, already.** `applyDeliveryEvent` ignores a repeated provider event ID and
any event at or before the row's current delivery instant, under a `for update` on `outbox_work`.
And `releaseAbandonedClaims` is *not* scoped to `message_received`, so it already recovers a lapsed
delivery claim — the claim is a real one because `coherent_claim_state` requires a token and expiry
on any `processing` row.

### The sabotage that found a third mechanism

Removing the duplicate-event guard from `applyDeliveryEvent` left the entire suite green. The first
assumption — that the test was weak — was half right, but the reason was not the expected one.
Probing the actual `UPDATE ... RETURNING` showed it matching a row and returning the *old* status,
which pointed at a **database trigger nobody had mentioned**: `guard_outbox_delivery_watermark`
(migration 0001) returns `OLD` when `delivery_event_id` repeats. The rule is enforced **twice**,
independently — trigger and application guard — so no single-point sabotage can fail a test of it.

The test was also passing for a third wrong reason: with a *terminal* first status, the trigger's
"a terminal result cannot be replaced" branch enforced it regardless. Rewritten with `sent` as the
first status, so only the duplicate rule is in play; it now fails only when *both* mechanisms are
removed, which is the honest result for a genuinely redundant guarantee. Four separate sabotages
were run: `for update skip locked` (fails only the 8-claimant contention test), the event-type
filter (fails the "never claims a conversational event" boundary), each duplicate mechanism alone
(green — the finding), and both together (fails).

**Contention was tested with eight simultaneous claimants**, per B-011's lesson that `Promise.all`
over two branches serializes itself and cannot fail.

### A designed path deleted instead of built

An orphaned-callback path — a `rejected` terminal state for an event whose dispatch attempt vanished,
so it wouldn't be re-claimed forever — was written, then deleted once its test wouldn't construct:
the projection check forbids a delivery event without a `dispatch_attempt_id`, and the FK is
`on delete restrict`. The state is **unreachable**, so a test now asserts that guarantee instead, and
fails if either constraint is relaxed. The zero-caller singular wrapper was deleted rather than left
beside the new plural one.

### Merged past a permanently-red check, deliberately

Merged as `f16ef8f` (PR #46) with GitHub's Vercel check failing. It fails on **every** commit
including `main`'s last three, all predating this work: the committed `vercel.json` declares a
one-minute cron the Hobby plan rejects, which is why production is deployed by hand with the `crons`
block stripped. max's call: merge now. It is written into CLAUDE.md so the red check is not mistaken
for a signal about a change under review — worth removing at go-live, since a check nobody can
distinguish from a real failure is how a real failure eventually gets missed.

**Production verification by effect is owed and not done**: no scheduled run has been observed
applying a real callback, since that needs the production `DATABASE_URL`. It is step one of the next
session, the same way the retention purge was verified the day before.

---

## 2026-07-27 — a scheduler that can fail loudly, the sentence the database threw away, and conforming to the carrier

Two pieces of the durability gap, and a consent rule that removed a divergence rather than repairing it.

### Production's recovery net exists in the repo now, not yet in the world

The deployed build is uploaded with `vercel.json`'s `crons` block stripped, because Hobby rejects a
one-minute schedule. The consequence had been sitting in plain sight since B-009: the best-effort
kick was the *only* thing invoking the workers, which is the precise inversion B-009 was filed
against, and F-026's retention purge — which runs on that trigger alone — had never executed in
production at all.

Decision (max): external scheduler now, revisit Pro at go-live. **GitHub Actions over a SaaS
scheduler for one reason only:** a dashboard-configured job is *unassertable*. cron-job.org would
have scheduled more faithfully — GitHub's schedules are best-effort and droppable, so `*/5` is a
request rather than a guarantee — but nothing in the repo could then prove the job existed or still
authenticated, which is the exact silent-failure shape B-005 was filed against. The interval is
acceptable only because the kick front-runs live traffic, so it governs how long *missed* work waits,
never reply latency. That distinction is written into the workflow and the RUNBOOK, because calling
it "a one-minute cron" would be false.

**The assertion that matters is that the run checks its HTTP status.** A bare `curl` exits 0 on a
401, so a rotated `CRON_SECRET` would produce a tidy column of green checkmarks while nothing had run
for weeks. And that assertion's first draft **survived its own sabotage** — a workflow accepting
every status still passed, because `/--fail|-f\b|http_code|status/` was satisfied by the
`-w '%{http_code}'` flag and the bare `/exit 1/` by an unrelated missing-secret guard. Same trap as
B-009's import line, in a new costume. It is now anchored to the comparison itself and fails under
four separate sabotages of it. Nine sabotages were run across the file; all six assertions fail when
the property they name is removed.

### B-011 turned out to be blocked on something more basic than its Golden Rule question

The plan was to bring max the consent-transition decision. Reading the code first changed the
sequencing: `classify()` in `packages/sms/src/delivery.ts` read only the **HTTP status** off the
thrown error, and `createTelnyxTransport` discarded the response body outright. Telnyx returns
`40300` in that body. **The error code B-011's candidate rule keys on did not exist anywhere in the
system** — every 409 arrived indistinguishable from every other conflict.

So B-010 was the prerequisite, and max chose to do it first and decide B-011 against real stored
rows rather than a single hand-run curl.

### B-010: the privacy question in its own notes had a "yes" answer

The item asked whether any class of provider error echoes the destination number, and said that if so
the class should be *dropped* rather than truncated. It does — the real 40300 body names **both**
E.164 numbers. But dropping it would discard the diagnostic entirely, so phones are **masked**
instead: the sentence survives, no digits do.

`maskRawPhones` is built on the outbound guard's existing `PHONE_BODY` pattern rather than a second
regex, so both consumers inherit every future correction to it — including B-001's UUID-hex fix. Same
detector, two dispositions: the guard *refuses* an outbound body carrying a phone (it is our own
message; a phone in it is a defect to surface), while stored third-party text is *masked* (a
provider legitimately names the numbers it could not deliver between).

Two columns, kept separate on purpose: `provider_code` is a **validated machine token** — a future
rule may key on it — and `provider_error_detail` is free text nothing may ever branch on. Both are
nullable and excluded from the `coherent_result` check, because a provider returning an unparseable
body (a gateway's HTML 502) must still be able to record its rejection; requiring them would turn a
malformed error into a failed write *inside the dispatch path*. `summarizeProviderError` never throws
for the same reason.

Nothing branches on either value today. `errorCode` remains what the retry policy reads, so this
changed no dispatch decision — it only made the next failure readable in one query.

**Why the discard survived this long: `createTelnyxTransport` was unexported.** The single code path
that parses a real provider error had no test, because everything above it used the simulator, which
never fails. It is now exported and covered against the two real 2026-07-27 payloads, and that suite
fails under a full revert to the original defect.

### B-011: conform to the carrier instead of reconciling after it

max's call, and it reframed the problem: **"conform to telnyx. join only works on first-time inbound.
otherwise require START."**

Both options the item had been carrying accepted that the two records would diverge and argued about
the repair — reconcile consent from a 409, or surface the mismatch for an operator. A third that
surfaced while reading the code (surface blocked recipients, reconcile nothing) had the same shape.
max's rule removes the divergence at its source instead: our record can no longer claim consent the
carrier will not honour, because JOIN never again enrolls someone Telnyx may be blocking.

And it does that with **no Golden Rule #2 exposure at all** — the outcome the "authoritative 40300"
option kept bumping into. No provider response drives a consent transition; a 409 is never consulted.
The decision stays a pure function of our own deterministic routing plus our own stored record. The
B-010 work that unblocked the authoritative option turned out not to be needed for the fix that
actually shipped, though it is what made the carrier's behaviour legible enough to reason about.

**Where the rule lives is the load-bearing part — and the first version of it was wrong.** It
belongs in `applyConsentTransition`, not `routing.ts`: a caller-side read followed by a write is a
race, since two concurrent JOINs could both observe "no record" and both enroll.

The first implementation did `select ... from sms_consents` inside the transaction and refused on a
hit, with a comment asserting the existing `for update` on the watermark serialized it. **It does
not.** `for update` locks rows that EXIST; a genuinely first-time sender has no watermark row, so
there is nothing to lock and the eight transactions ran concurrently. The race test enrolled
**three of eight**.

Every unit test passed throughout, because the unit stubs cannot model row-level contention. **Only
the integration run against real Postgres could see it** — the same shape as B-009, where Node
semantics hid a serverless-lifecycle bug, and B-005→B-008, where a hoisted `node_modules` hid an
isolated install. The fix moves the decision into the `sms_consents` PRIMARY KEY:
`insert ... on conflict (recipient_hash) do nothing returning state`. The database resolves the
contention, exactly one insert reports a row, and the losers learn it from their own write rather
than from a stale read. `returning` is what makes winner and loser distinguishable at all.

Sabotage-proven afterwards: reverting to the read-then-refuse version fails the race test, and
disabling `firstTimeOnly` entirely fails two.

Two smaller decisions that took a second pass:

- The guard keys on the **`sms_consents` row, not the watermark**. Every transition writes a
  watermark, including ones that do not enroll, so an absent consent row is the honest test of "never
  opted in". A refused JOIN also writes **no** watermark — otherwise it could mask a later legitimate
  START arriving at an earlier provider time.
- `applied: false` was **ambiguous** between "stale event" and "already enrolled", which need
  different answers to the sender. `ConsentTransitionResult.refusal` now says which. Routing keys on
  the reason, and **keying on `!applied` passed the entire routing suite** until a stale-JOIN fixture
  existed — the fourteenth sabotage of the session and the second time this session that an
  assertion proved to be satisfied by something other than the property it named.

`ALREADY_JOINED_RESPONSE` is 114 chars, one GSM-7 segment, and is deliberately **not** one of the
three registered 10DLC auto-responses — those are transcribed from live console state and pinned
character-for-character, this is ordinary code-rendered copy that can be edited without touching the
carrier registration. It goes out as `required_reply`, which is what lets it reach a `stopped` sender.

**The limitation is real and is written into the code comment rather than smoothed over:** while the
carrier block is active, that reply is itself 409'd and the farmer never sees it. It is still correct
to send — the block may not be active, it costs nothing when it is, and B-010 now records the refusal
with its reason. **The durable fix is farmer-facing, not code:** onboarding material and printed
instructions must say START, not JOIN, for returning after an opt-out. That is the one piece of B-011
still open.

### Shipped to production, and the purge finally ran

All three owed steps completed 2026-07-27, in the order the outage risk demanded — except the first,
which max chose to reorder knowingly.

**The ordering call.** `recordDispatchResult` writes `provider_code` / `provider_error_detail` on
*every* dispatch outcome, so deploying before migration 0004 means every outbound SMS fails at the
record step until the migration lands. Flagged as a real window rather than a theoretical one; max
accepted it (the number carries no real traffic and this is still throwaway validation) and the
migration followed immediately. Confirmed after the fact: both columns present, 5 migrations applied.

**Deploy** used the documented Hobby workaround — strip `crons` uncommitted, `npx vercel --prod`
(the CLI uploads from disk), restore, confirm `cron-schedule.test.ts` back to 4/4. Live checks:
health 200, cron 401 without a secret, webhook **401** — which is the three-way diagnostic saying all
four Telnyx credentials resolved, since a missing one renders 500.

**The purge ran against real data for the first time.** F-026 had only ever reported `0/0/0` because
nothing was eligible, so a privacy commitment had been *unenforced*, not merely unverified. With
`CRON_SECRET` set and a manual run returning 200, one body was made eligible among 21 real messages:

| | before | after |
|---|---|---|
| `body` | present | **NULL** |
| `body_expires_at` | past | **NULL** |
| the row itself | present | **present** |
| other bodies | 21 | **20** |

Cleared as a pair, minimized projection intact, blast radius exactly one. Checking what *survived*
mattered as much as what went — a purge that over-reached would be worse than one that never ran.

**And the verification found something.** The same sweep showed `message_received` 21/21 `processed`
but `message_sent` (9) and `message_finalized` (11) **all still `pending`**.
`applyPendingDeliveryEvent` has **zero callers** — no pass, no webhook, not even a test. So `sent` in
`outbox_work` means "the provider accepted it", never "the handset received it", and the rows
accumulate with no terminal state. Filed as **B-012**; same unowned-machinery shape as `model_runs`.
Not caused by this session's work — found *because* the scheduler was verified by effect rather than
by a green checkmark, which is the entire argument for doing it that way.

### Verified

Merged to `main` as **e4798fa** (PR #45, squashed). The PR's only check — Vercel — was failing, but
`main`@456ad93 carried the identical failure at the same URL: it is the known Hobby rejection of
`vercel.json`'s one-minute cron, which is precisely why deploys go out via `npx vercel --prod` from a
local checkout with the `crons` block stripped. Pre-existing, and it blocks `main` equally.

Everything green at wrap, on real Postgres 16.12:

| Suite | Result |
|---|---|
| `npm test` | **393/393** across 42 files |
| `npm run test:integration` | **226/226** across 16 files |
| `npm run evals` | critical **11/11**, advisory 4/4, adversarial 25/25 |
| typecheck / lint / `next build` | clean |

Critical evals went 10 → 11: a new fixture asserts the B-011 rule (JOIN refused for any existing
record, START honoured from every state, STOP unnarrowed). Migration **0004** applies from an empty
database, proven by the integration run rather than by `drizzle-kit check`.

Three test-side defects were found and fixed during the wrap, none of which the unit suite could
see: the B-011 integration fixtures reused `farmerHash`, which `beforeEach` seeds with an *active*
consent row (so "first-time" was never first-time); the routing stubs returned `[]` for the guard's
new `insert ... returning`, making every first-time sender look already-enrolled; and one assertion
("no `insert into sms_consents` runs") became wrong by design once the guard *became* an insert —
the load-bearing assertion is that no **watermark** advances.

### What is owed

- **Integration DID run, after an environment mistake worth recording.** Two attempts to find
  Postgres came up empty and the session proceeded on "no database available" — but Homebrew's
  `postgresql@16` was installed and running the whole time, merely absent from `PATH`
  (`/opt/homebrew/opt/postgresql@16/bin`). Finding it during the wrap is what surfaced the race
  above. **A negative result from a tool lookup is not proof the thing is absent** — the same
  reasoning-from-indirect-evidence trap that produced the wrong `vercel env ls` conclusion earlier.
- ~~The scheduler is merged but not live.~~ **Done and verified the same day — see below.**
- **B-011's farmer-facing half.** The code rule is in; the onboarding copy that tells returning
  farmers to text START rather than JOIN is not, and no code change can substitute for it.

---

## 2026-07-27 — B-009: the reply never went out because the kick never ran

Farm Friend sent its first SMS. The full round trip works: inbound keyword → deterministic route →
queued reply → Telnyx dispatch with a real provider message ID → delivery callbacks returning
through the same webhook.

Three defects were stacked, each hiding the next. Only the middle one was in the code.

### The diagnosis, in the database rather than on the phone

Two real inbound `HELP` messages had been committed and acknowledged 200 with no reply. Reading
every table localized it in one pass:

| Table | Rows | Reading |
|---|---|---|
| `sms_messages` | 2 | ingress committed |
| `contacts` | 1 | committed in the request path |
| `provider_inbox_events` | 2, `state='pending'`, `claimed_at` NULL | **never claimed — the break** |
| `sender_states` / `outbox_work` / `outbox_dispatch_attempts` / `sms_consents` | 0 | nothing downstream ran |

20 of 23 tables were empty. Everything the webhook does *synchronously* committed; everything the
kick does never happened. The first missing step is the first step past the durable commit, which
is the `void kickSenderPasses(...)` call.

### The cause is a platform contract, not a logic error

`void` starts work the Vercel runtime knows nothing about. Once the handler returns, the invocation
is free to suspend, and the promise simply stops. Vercel's reference states it outright: work that
is not awaited may be shut down before it completes. `waitUntil` registers the promise and extends
the invocation's lifetime until it settles, without holding the response open. (`after()` from
`next/server` is the modern equivalent and needs Next 15.1+; this app is on Next 14.)

The kick gained no guarantee from this. A registered promise shares the function's timeout and is
cancelled with it, so it stays best-effort and the scheduled trigger stays the durable net.

**The compliance exposure is why this was critical rather than a latency bug.**
`applyConsentTransition` runs inside `routeInboundMessage`, inside `runInboundPass`, inside the
kick — so a real `STOP` would have committed **no consent row at all** while Telnyx received a 200.
Not "consent correct, acknowledgement missing": the opt-out silently dropped. No violation had
occurred, because both test messages were `HELP` and an earlier `STOP` was sent during the
unprovisioned-number window and left no trace in any table.

### Why every local suite passed

**Vitest runs in Node, where a floating promise resolves normally.** The entire existing kick suite
— including `kick-wiring.test.ts`, written specifically to police how the kick is wired — passed
throughout. No behavioural test in that runtime can see this bug. `kick-survival.test.ts` therefore
asserts the registration against the route source, the same technique `cron-auth.test.ts` and
`workspace-manifests.test.ts` use for properties that are constructs rather than behaviours.

**That test's first draft survived its own sabotage.** It asserted `/waitUntil\s*\(/` against the
whole file; reverting the call site to the production defect still passed, because the `import` line
matched. It now strips imports and anchors to the call site, and fails under three sabotages —
revert to `void`, wrap an unrelated promise, `await` the kick. `kick-wiring.test.ts` passes through
all three, which is precisely why the new file had to exist.

`kick-wiring.test.ts` asserted `void kickSenderPasses(`. `void` was only ever a proxy for
"deliberately not awaited" — and it turned out to *be* the defect — so that assertion now follows
the intent instead of the keyword.

### Two configuration defects on either side of it

**Before:** the 10DLC campaign provisioning (previous entry) — fixed between sessions.

**After:** `TELNYX_FROM_NUMBER` was not in exact E.164 form, so Telnyx returned `400` on every send.
This masked B-009's fix for most of the session and cost far more time than it should have, because
`outbox_dispatch_attempts` stores `error_code = '400'` and **discards Telnyx's own sentence** —
`"The source phone number was deemed invalid by the carrier."` — which names the field outright.
Filed as **B-010**. Localizing it instead required probing the Telnyx API directly, testing each
request component in isolation, and enumerating malformed `from` formats until the error reproduced.

A dead end worth recording: `vercel env ls` showed `TELNYX_API_KEY` as "1h ago" while the web UI
showed "Updated just now". The CLI column is not last-update, and trusting it produced a confidently
wrong conclusion mid-diagnosis. Vercel values are write-only — the UI hides them and `vercel env
pull` returns `[SENSITIVE]` (confirmed for all ten) — so the only honest check is behavioural.

### Verified by effect, in the deployment

| | Before | After |
|---|---|---|
| Inbound claim latency | never, unless cron was triggered by hand | **4–8s, automatic** |
| Consent commit | nothing recorded | `active` / `start`, watermark correct |
| Routing | never ran | every message routed to the correct registered copy |

Six keywords in 39 seconds, out of order, each claimed within seconds with no cron and no manual
trigger. Claim latency is the load-bearing number: ~1888s (and only when a pass was triggered by
hand) → single-digit seconds. Consent semantics held against real traffic — the watermark carries
only the latest transition, and `HELP` did not move consent.

The supervised keyword demo then completed on a clean number: `start` → `join` → `help` at
06:43, all three `accepted` with real provider message IDs, consent landing at
`active` / `capture_source='join'`. A free-text inquiry (`"where can i get bok choy?"`) was also
exercised and returned a code-rendered clarification.

`npm test` 363/363 across 39 files; typecheck, lint and `next build` clean.

### B-011, found while demoing: the carrier owns STOP, and JOIN cannot undo it

The demo surfaced a second defect that the database alone did not show — it took a screenshot of
the actual handset. **Telnyx answers STOP/START itself**, in copy that is not ours ("Reply START to
re-subscribe"), while Farm Friend's registered copy says "Reply HELP for assistance". Two voices,
with contradictory instructions.

Worse, Telnyx then **rejects Farm Friend's own reply with 409** while its block rule is active.
Probing the API directly named it:

```
40300 | Blocked due to STOP message
"Messages cannot be sent from '…' to '…' due to an existing block rule."
```

This settles a question the previous framing had left open: **suppression is enforced independently
of the profile's auto-response fields**, which were deliberately left empty in an earlier session.
Disabling the auto-response text would therefore not restore deliverability, so "accept carrier
handling for STOP/START" is the workable path rather than one of two equal options.

**`START` lifts the block; `JOIN` does not** — `JOIN` is Farm Friend's registered opt-in keyword and
means nothing to Telnyx's compliance layer. Confirmed by outcome, not by timing: a `join` sent four
minutes after a `stop` still 409'd, while a `start` between them was accepted.

The consequence is a **consent-integrity divergence**, not a cosmetic one. A farmer who texts STOP
and later texts JOIN is recorded `active` by Farm Friend — `isProactiveSendPermitted` returns true —
while Telnyx blocks every message to them. The database and the carrier disagree about the same
person and nothing reconciles them. One candidate fix (treat a `40300` as authoritative and
reconcile consent to `stopped`) brushes against Golden Rule #2, since it lets a provider response
drive a consent transition; it would have to be a deterministic code-owned rule keyed to that one
error, never a general "provider says so" path. Undecided, and max's call.

### Owed

**The durability half is not done.** The deployed build has its `crons` block stripped for Hobby, so
production has **no scheduled recovery net at all** — the kick is the only thing running passes,
which is the exact inversion this item was filed against. The external-scheduler-vs-Pro decision
(external now, Pro at go-live) still needs implementing, and `CRON_SECRET` had to be rotated
mid-session because it was unreadable, which any external scheduler will need again.

The retention purge has still never been verified by effect; every observed pass reported `0/0/0`.

**Credential hygiene is now a go-live blocker, not a nicety.** `DATABASE_URL`, `CRON_SECRET` and the
Telnyx API key were all exposed in a working transcript this session and need rotating. Note the
asymmetry: **`PHONE_HASH_SALT` cannot be rotated** — changing it orphans every phone hash in the
database. Record it while it still works.

B-008 is still open, and its symptom appeared again in this session's build log.

---

## 2026-07-27 — Telnyx wired and verified; the demo blocked on an unprovisioned number

No code changed. The Telnyx transport was configured and every app-side property verified against
the live deployment — and the supervised `JOIN` demo still could not run, because the number was
never provisioned on the 10DLC campaign, so inbound SMS never reached Telnyx at all.

### What now works

`SMS_PROVIDER=telnyx` plus the four credentials are live in Vercel Production. The webhook answers
**401 `missing_signature`** where it previously answered 503, which is the observable proof that
`resolveConfig` resolved a complete Telnyx config.

Signature rejection was probed five ways against the deployment, all 401:

| Probe | Reason returned |
|---|---|
| No headers | `missing_signature` |
| Well-formed but wrong signature | **`signature_mismatch`** |
| Stale timestamp (−1h) | `timestamp_outside_window` |
| Junk (non-base64) signature | `malformed_signature` |
| Signature without timestamp | `missing_signature` |

`signature_mismatch` is the load-bearing one. Reaching it requires the timestamp check to pass, a
64-byte signature to decode, and **`TELNYX_PUBLIC_KEY` to decode to exactly 32 bytes and import as a
valid ed25519 key** — a wrong-key paste returns `malformed_key` instead. So the public key is
structurally a real ed25519 key. Whether it is *the account's* key is still unproven; only a genuine
Telnyx-signed request settles that.

### The three-way diagnostic the runbook got wrong

The session prompt (and RUNBOOK step 4) framed step 2 as two-way: 401 good, 503 means a missing
credential. That is wrong, and it points at the wrong fix.

`route.ts` calls `appContext()` as its **first statement**, before the provider check. `resolveConfig`
**throws** when `SMS_PROVIDER=telnyx` and any Telnyx var is missing or blank, and a throw in a route
handler renders **500**. So:

- **401** — config resolved.
- **503** — `SMS_PROVIDER` is not `telnyx`; execution reached the provider check, so all five vars
  resolved.
- **500** — `SMS_PROVIDER=telnyx` but a credential is missing or empty.

A missing credential is **500, never 503**. This mattered in practice: the first redeploy still
returned 503, and the correct read was "`SMS_PROVIDER` was never flipped from `simulator`" — which is
what it turned out to be. The `vercel env ls` timestamps were the tell: the four Telnyx vars were
minutes old, `SMS_PROVIDER` was two hours old, unchanged with the rest of the original set.

Note `vercel env pull` cannot help here — encrypted values come back as `[SENSITIVE]`.

### Hobby cannot deploy this repo's `vercel.json`

`npx vercel --prod` from `main` fails outright: `Hobby accounts are limited to daily cron jobs. This
cron expression (* * * * *) would run more than once per day.` B-005's one-minute schedule is
incompatible with the plan.

Rather than redeploy the stale `throwaway/hobby-deploy-test` branch — which was **17 commits of
doc drift** behind `main` and is documented as never-merge — the crons block was stripped from the
working tree **uncommitted**, deployed, and restored immediately. `vercel --prod` uploads from disk,
so this needs no branch and no commit. Confirmed first that the two branches differ in **zero source
files**: only docs and `vercel.json`.

This makes the Hobby-vs-Pro question concrete rather than theoretical. The throwaway project can
never become the real one; it cannot run the schedule the app requires.

### The demo could not run — and the app is not implicated

Real `STOP`, then `HELP`, to +1 206-864-5326. No reply to either. Diagnosis from both ends:

- **Vercel runtime logs** — zero requests to `/api/sms/webhook` in the window. The only hits were
  this session's own probes, timestamps confirmed. No application code ran.
- **Telnyx → Webhook Deliveries** — "No deliveries found."
- **Telnyx → Detail Record Search** — **"No records found."**

The last is decisive. Telnyx has no record of the inbound messages *at all*, so the failure is
upstream of the webhook and upstream of Telnyx's own message records.

**Root cause found at the end of the session: the number's Provisioning Status on the 10DLC campaign
read `Pending`.** It had never been provisioned on the campaign; max assigned it minutes before the
wrap. An unprovisioned number has no carrier route for inbound 10DLC traffic, which is exactly why
the messages died before Telnyx saw them.

The trap is that **three separate things all looked correct**: the campaign was *approved*, the
number was *Active*, and the number was *attached to the messaging profile*. None of those implies
the number is provisioned **on the campaign**, and no view we looked at surfaced the gap — we found
it only by opening the campaign's own number list. Attaching the number to the profile mid-session
did not change the result, because that was never the missing binding.

**`HELP` failing alongside `STOP` is what rules out the leading theory.** Carrier keyword absorption
was the suspected cause — Telnyx maintains its own opt-out list, and the console's Keywords page
shows STOP/START/HELP as fixed, non-editable defaults. But HELP is not an opt-out keyword and Telnyx
has no compliance reason to swallow it. Two different keywords failing identically means the problem
is not keyword-specific.

The three auto-response message fields were deliberately left **empty** during profile creation, so
Telnyx would not double-reply alongside Farm Friend's registered copy. That decision stands and was
not the cause.

### B-008: the sixth defect of the B-007 family

The successful deploy's build log carried
`ESLint: Failed to load plugin '@typescript-eslint' … Cannot find module '@typescript-eslint/eslint-plugin'`.

`apps/web/package.json` declares `eslint` but not `@typescript-eslint/eslint-plugin` or
`@typescript-eslint/parser`, which the root `.eslintrc.cjs` loads. Next treats the failure as
non-fatal, so **lint is skipped and the build goes green**. Not a runtime defect — compilation and
type-check both ran — but a lost quality gate whose absence is invisible on a passing deploy.

`workspace-manifests.test.ts` could not have caught it: it matches
`@farm-friend/*` **in import statements**. This is an *external* package referenced from a *config
file* — outside the test's design on two independent axes. `npm run lint` passes locally for exactly
the hoisting reason the whole family shares.

Filed as B-008 rather than fixed mid-session; the valuable part is extending the general test to
config-file references, not the two-line manifest fix.

### Verified

`npm test` 356/356 across 38 files; typecheck and lint clean. Integration and evals not run — no
database, model-seam, or workflow code was touched. `cron-schedule.test.ts` passing is the
confirmation that the `vercel.json` strip was restored.

### Owed

**Late update, after the wrap commit: provisioning cleared, ingress now works, and the demo still
fails — one stage later.** Two inbound webhooks returned **200** (05:49:10Z and 05:59:57Z): signature
verified, message committed durably, acknowledgement returned. No reply arrived at the handset.

The failure has therefore **moved from ingress to outbound**, which retires the carrier theory
entirely and makes this the first app-side suspicion of the whole effort. The prime suspect is the
**B-004 kick**: it is started with `void`, never awaited, and swallows every failure by construction,
and on Hobby there is **no cron to recover what it drops**. That is exactly the silent-failure mode
flagged at the session's start — a reply that never arrives with no error surfaced anywhere, because
the webhook already returned its 200.

Next session begins in the database rather than on the phone: `sms_messages` (did the inbound row
commit?), `sender_states` (did the inbound pass run?), `outbox_work` (was a reply queued, and what is
its `state`?), `outbox_dispatch_attempts` (was dispatch attempted, and what came back?), and
`sms_consents` (did the STOP transition commit even though no acknowledgement went out?). Each table
answers a different stage, and the first empty one localizes the break. B-008 is open. The throwaway Vercel project and branch still want deleting before go-live,
and production cron remains the open Pro-vs-external-scheduler decision, now sharper because Hobby
cannot deploy this repo's `vercel.json` at all.

---

## 2026-07-27 — The first deploy, and the five defects a green suite could not see

Farm Friend is **deployed**: https://farm-friend-web.vercel.app. Health returns `{"ok":true}`,
`/api/public/stands` returns `{"stands":[]}` against a real Neon database, and every security
boundary built over the last several sessions holds against a live deployment rather than a test
runner — cron 401 with no or wrong secret, admin API 403 unauthenticated, sign-in responses
byte-identical across addresses, throttle firing.

This was not the F-029 go-live. It is a **throwaway Hobby-tier deploy** to validate build and env
wiring, on branch `throwaway/hobby-deploy-test`, to be torn down.

### Five defects, one shape

Every one was invisible to 346 passing tests, because every test ran in a developer's fully-hoisted
`node_modules` or against a local database:

- **B-005** — no `vercel.json` at all, while RUNBOOK documented `vercel.json` → `crons`. Nothing
  would ever have been scheduled.
- **B-006** — no migrate command, while RUNBOOK said "migrations run as part of the deploy step."
  Migrations were applied in exactly one place: the integration harness, against a database it
  created and dropped.
- **B-007a** — `apps/web` imported `@farm-friend/ai` without declaring it.
- **B-007b** — `transpilePackages` listed only `@farm-friend/core` while three others were imported.
  **This was the actual build failure.** Every package ships raw TypeScript, the dev server
  tolerates it, `next build` does not.
- **B-007c** — `typescript`, `@types/node`, and `eslint` declared only at the workspace root. The
  build reached `✓ Compiled successfully` and then died in the type-check phase.

Each now has a test that fails without its fix, including a general one — `workspace-manifests.test.ts`
walks every workspace and asserts imports are declared, matching on `from "…"` / `import("…")` rather
than any occurrence of the string so a package named in a comment or in `architecture.test.ts`'s
tripwire list is not counted.

**The lesson worth keeping: npm workspaces hoisting makes a whole class of packaging defect
undetectable locally.** `npm test`, `npm run typecheck`, `npm run lint`, and `next build` from the
repo root all pass against manifests that cannot survive an isolated install. The only place the
repository now asserts that property is a test that reads the manifests directly.

### The near-miss

The Neon database was not empty. It held the **older Farm Friend** — the gleaning volunteer
coordination model (`volunteers`, `opportunities`, `claims`, `dispatch_waves`) whose machinery
CLAUDE.md names as an explicit non-goal — with 6 volunteer records, 17 SMS messages, and 2 farms
carrying contact phone numbers.

The reset script's row-count guard refused, having been written on the assumption the database was
empty. **That guard is the only reason nothing was destroyed.** The order was wrong: a destructive
script was proposed before the database was inspected. Inspect first.

It also explains the migration failures. `flags` existed with the old schema
(`phone_hash`/`volunteer_id`, not `contact_hash`/`reason_code`), so `CREATE TABLE IF NOT EXISTS`
skipped it and the foreign key could never be created. **The repeated failure was protecting the old
data.** A pooled-vs-direct Neon connection theory was advanced confidently and was wrong — the same
failure occurred on both.

Max confirmed the contents were his own test numbers from a superseded deployment, and authorized the
wipe. The rewritten script required `CONFIRM_WIPE=yes` **and** fingerprinted the old schema, so a
mistyped connection string would fail rather than erase something else.

### The Vercel specifics

Hobby caps cron at once per day and **rejects** the one-minute schedule, so the throwaway branch
carries a `vercel.json` with no `crons` block — which is why `cron-schedule.test.ts` fails on that
branch by construction, and only there. The Git integration also built the same pre-fix commit three
times; deploying with `npx vercel --prod` from a local checkout sidestepped it entirely and is what
finally worked.

### A correction that matters for the demo

Earlier guidance in this session wrongly implied F-024, B-002, and F-031 gate a live `JOIN` demo.
**They do not.** `JOIN`/`STOP`/`HELP`/`START` are deterministic keyword paths handled before any
model call (`provider.calls === 0`, asserted through the real webhook route), and the reply is sent
by the **B-004 kick in ~47ms** rather than by cron — so a demo needs no cron and no Vercel Pro. What
it needs is Telnyx credentials, `SMS_PROVIDER=telnyx`, and the messaging profile webhook pointed at
the deployed URL. F-029 records this correction.

### Verified

`npm test` 356/356 across 38 files; real-Postgres integration 222/222 across 16 files; typecheck +
lint clean; evals critical 10/10, advisory 4/4, adversarial 25/25. Live deployment verified by
request against every route above. PRs #41, #42, #43 merged.

### Owed

The throwaway Vercel project and `throwaway/hobby-deploy-test` branch should be deleted before
go-live. `PUBLIC_BASE_URL` may still be a placeholder in Vercel. Production cron remains an open
F-029 decision (Pro vs. an external scheduler). F-024, B-002, and F-031 still gate a *useful* launch,
just not a keyword demo.

---

## 2026-07-26 — F-032: the sign-in path gets built up to the wire, and F-031 keeps the wire

One item, one PR, merged. F-025a built magic-link verification and the session it mints; F-030 built
the queues those sessions unlock. Nothing could **send** a link, so a non-technical VIGA operator
still could not sign in unaided.

### The split, and why it happened first

The session opened by surfacing the blocker the prompt named: F-031 needs a mail provider,
credentials, and an attestation of its data-processing terms that **no decision has authorized**.
Max asked whether GCP offers an option (he has `farm-friend-vashon`). It does not — Google has no
first-party transactional email API. "Email on GCP" in practice means SendGrid via Marketplace,
whose terms are **Twilio's, not Google's**, so GCP billing consolidation buys no privacy or
architectural advantage. Gmail API on Workspace works but is a mailbox API with sending limits not
designed for automated mail. Max held the decision to find out what email infrastructure VIGA
already runs — the right sequencing, since an existing Workspace tenant or sending domain constrains
the choice more than any vendor comparison.

That made F-031's "receive it by email" criterion unmeetable this session. Rather than narrow the
item silently or mark it done against criteria it does not meet, **F-032 was split off** for the
provider-independent half. F-031 keeps the transport, the attestation, and the SPF/DKIM/DMARC
sending-domain work, and stays the F-029 blocker.

### The decisions worth keeping

**The mail seam fails closed by throwing, not by no-oping.** A "no provider configured" sender that
quietly returned success would present as a healthy system that never delivers — the hardest version
of this bug to diagnose. Its error carries **neither the recipient nor the body**, because an error
is the most likely thing on this path to reach a log aggregator and the body contains a live
credential. Startup deliberately does *not* require a provider: making it mandatory would take down
the map, the webhook, and the cron worker over a feature none of them use. The cost of that trade is
paid at send time, loudly.

**Enumeration safety is a property of whole responses, and it has to survive failure.** The endpoint
is public, so any observable difference — status, header, body, timing — tells a stranger who VIGA's
operators are. Asserted by comparing **whole serialized responses** rather than shapes. The subtle
half is the failure path: mail is only ever attempted for a real administrator, so letting a mail
error become a 500 rebuilds the oracle precisely. That is proven with a throwing seam, and it is the
case a cooperative stub would have missed. The live run confirmed it end to end — a **bootstrapped
real administrator** and a stranger got byte-identical 202s while the seam was throwing
`MailNotConfiguredError`.

**The budget is per client, never per email address.** A per-address budget is itself an oracle: an
attacker learns which addresses are real by watching which ones start refusing. Sign-in also gets its
own throttle instance, because sharing the stock-out form's would let anonymous QR traffic from a
shared NAT exhaust a real operator's ability to sign in — an availability failure on the recovery
path of the whole admin surface.

**The throttle runs before the administrator lookup.** A refused request performs no database read,
so the endpoint cannot be used to time the table and a throttled attacker cannot keep probing.

**`createModelCallThrottle` became `createPublicActionThrottle`.** The mechanism was always general —
a sliding window over a coarse client key — and only the name was model-specific. One mechanism with
two consumers beat a second near-identical limiter.

**No `console` call exists in the handler, asserted against its source.** A vendor SDK routinely
attaches the request payload — containing the live sign-in link — to the error it throws, so there is
no safe console call on this path. The accepted cost is a silent delivery failure, and it is paid for
by the seam failing loudly at send time instead.

**Writing the no-JS test caught a real defect.** `/admin/login` must work without JavaScript, since
it is the recovery path for every other admin screen. The handler parsed only JSON, so every native
form post would have answered 400 while the enhanced path worked fine — the acceptance criterion
would have been false. It now accepts form-encoded bodies, verified in the built app's markup.

### The sabotage log

Ten sabotages, each verified to fail before the claim was believed: 404 for a non-administrator; a
distinguishing response header on an identical body; a mail error escaping as a 500; logging the
caught error; debug-logging the minted link; the throttle moved after the lookup; the link built from
the `Host` header; lowercase normalization removed; form-encoding support removed; and
`revoked_at is null` dropped from the administrator query — the one property only the real database
owns, which correctly failed the integration suite with a revoked operator receiving mail.

**None passed silently this time**, unlike F-030's two. The enumeration tests were written to compare
whole serialized responses specifically because F-030's near-miss was a shape check that could not
see a changed value.

### Verified

`npm test` 342/342 across 36 files; real-Postgres integration 216/216 across 15 files; typecheck +
lint clean; evals critical 10/10, advisory 4/4, adversarial 25/25; production build passes with
`/admin/login` and `/api/auth/request-link` present and every route dynamic. Exercised live against a
bootstrapped administrator: identical 202s, throttle refusing the 4th request with `retry-after: 900`,
and **no token or address in the server log**. Merged to `main`.

### Owed

F-031 is now purely the transport: pick a provider once VIGA's existing email infrastructure is
known, read its terms, implement the `MailSender` adapter, and set up SPF/DKIM/DMARC. Until then no
link is delivered and a link must still be minted out of band with `issueMagicToken`. `model_runs`
still has no production writer.

---

## 2026-07-26 — F-030: the flag rail gets its human half, and retention learns to terminate

One item, one PR, merged. `FLAG` is a **registered 10DLC compliance commitment** and no human
could act on one: `/api/admin/flags` returned `{ flags: [] }` behind a *working* role check and
read nothing from the `flags` table. Customer stock-out reports accumulated with no reader at all.
Two consequences, and the second is the one that made this urgent — F-026's retention exemption
**never terminated**, because nothing in the product could move a flag out of `open`, so a flagged
body retained indefinitely.

### The decisions worth keeping

**Dismissal ends the exemption exactly as resolution does.** The purge predicate is
`flags.status = 'open'`, so both dispositions release the thread. That is asserted as its own test
rather than folded into the resolution case, because the drift this project has already been bitten
by once — `= 'open'` → `<> 'resolved'` — keeps a *dismissed* thread exempt forever while passing a
resolution-only suite. Sabotaging the predicate now fails with "expected +0 to be 1".

**No grace period after disposal, deliberately.** DATA_ARCHITECTURE already said no consumer needs
one; building a bounded post-resolution window would have been speculative state with no owner. The
very next purge pass clears the body, and the operator copy says to read the thread *before*
closing the flag.

**Masking is a query-level guarantee, not a rendering convention.** `listFlagsForReview` and
`readFlaggedThread` select `right(phone_e164, 4)`, so the full number is never materialized in
application memory and the admin surface never becomes a second reader of the send path's one
column. `maskPhoneSuffix` **refuses** anything longer than four digits rather than truncating —
a caller that passes a whole number fails closed instead of leaking, and the sabotage that selects
the full column now throws at the boundary rather than reaching a response.

**The thread viewer shows what the sender typed, verbatim.** That text is the thing under review;
redacting it would defeat the rail. The guarantee is over *our* identifiers — no hash, no E.164 —
not over prose a sender chose to send (Golden Rule #6). A body retention already cleared is
reported as `bodyPurged`, so an operator can tell "deleted on schedule" from "they sent nothing."

**Triage has no action that could change a listing.** Reviewed and dismissed, nothing else. The
temptation this forecloses is specific — "the customer said it is out, so remove the item" — and it
is the exact failure the private-signal design exists to prevent. Golden Rule #1 is proven by
snapshotting every published revision, entry, and approval across every operator action and
asserting **byte equality**, not "still one revision."

**One guard, four consumers.** `requireAdministrator` moved out of `farms/route.ts` into
`apps/web/lib/admin-guard.ts`. Four copies of an authorization check would have been four places
for one to drift. RUNBOOK's "how to extend" gained an *Add an admin route* subsection recording the
pattern.

### The sabotage log

Eleven sabotages, each verified to fail the suite before the claim was believed: disposition and
triage status written as constants; the administrator liveness re-read removed; both exactly-once
guards removed; full `phone_e164` selected in the queue and in the thread viewer; a sender hash
added to a queue row; the exemption predicate drifted to `<> 'resolved'`; the route guard swallowing
`AuthorizationError`; the acting administrator read from the request body; triage superseding the
current revision.

**Two of them passed, and that was the point.** Writing `'resolved'` when the operator chose
`dismissed` passed all 26 tests — the dismissal test asserted only that the body got purged, never
that the *recorded decision matched the one made*. Same hole on the triage side. Both suites now
assert the recorded disposition directly, which is a defect class independent of retention: an
operator's audit record differing from their decision. A third finding worth keeping: sabotaging
`delete from inventory_entries` was caught by a **database trigger** ("published inventory entries
are immutable"), not by the test — so the Golden Rule #1 claim was re-proven with a supersession
sabotage the trigger does not block, which the snapshot test does catch.

### Verified

`npm test` 298/298 across 31 files; real-Postgres integration 210/210 across 14 files; typecheck +
lint clean; evals critical 10/10, advisory 4/4, adversarial 25/25; production Next.js build passes
with `/admin/flags` and `/admin/reports` rendering and every route dynamic. Merged to `main`.

### Owed

`model_runs` still has no production writer. F-031 (sending a sign-in link) remains the reason a
non-technical VIGA operator cannot yet sign in unaided — the queues built here are reachable only
by a link minted out of band with `issueMagicToken`.

---

## 2026-07-26 — F-025a: the operator gets an identity, and farms can finally be approved

One item, one PR. Farm Friend could not approve a farm. Publication refuses with `not_approved`
unless a live `farm_approvals` row exists, and **no code path created one** — every test that
published successfully did so because its *fixture* inserted the row by hand. The suite was green
and the product could not work. This is the item that closes that.

**Three defects with one cause: the operator had no identity.** `administrators` identified people
only by `contact_id` — a phone contact — while magic-link auth identifies them by email, and nothing
connected the two, so an authenticated operator could never be resolved to an administrator row.
`resolvePrincipal` therefore returned an empty role list and `hasRole` denied everything. Approval
was reachable only by hand-written SQL. Fixing the identity fixes all three.

### The decisions worth keeping

**Identity is email, and existing rows fail closed.** Migration 0003 adds `administrators.email`
(NOT NULL, lowercased and structurally checked, one live row per address) and makes `contact_id`
optional — an operator who never texts is still an operator. Pre-existing rows have no email and no
way to invent one, so the migration **revokes** them rather than fabricating an identity. Inventing
one would have been a real authorization grant conjured by a schema change; this is a greenfield
build, so failing closed costs nothing.

**A session is a database row, not a signed claim — and that is the whole point.** Roles are
re-looked-up against the session's administrator on *every* request, so revoking an administrator
takes effect on their **next request** rather than whenever a self-contained token would have
expired. Only the token's SHA-256 hash is stored, so a database read cannot recover a live
credential — the same discipline as the phone hash. Unsalted SHA-256 is correct here and wrong for
phones: the input is 256 bits of uniform randomness, so there is no candidate set to enumerate.

**Login is not first-user-wins, and that took the shape it did deliberately.** The callback verifies
the link, then looks the email up in `administrators`. Holding a valid link proves you control an
address; it does **not** make you an operator. Auto-provisioning there would have been an open door
on a public URL. A non-administrator gets the same 401 as a bad token, so the endpoint never reveals
who VIGA's operators are. Bootstrap is a seed script rather than an env-var allowlist, because
authorization belongs in data where the audit trail can record it — an env var cannot say who
granted it or when.

**`ADMINISTRATOR_ROLES` is a constant, not a query.** That is the enforcement of Golden Rule #1: the
farmer owns published state, so an operator role must never confer the ability to act as a farm's
owner. A list that cannot vary cannot be widened by a bad row, a join, or a future column. VIGA
approves *whether* a farm may publish; the farmer alone owns *what* it publishes.

**Authority is re-read at the moment of the write.** `approveFarm` and `revokeFarmApproval` check the
administrator row inside their own transaction, holding the lock. A principal proves who the caller
*was* when the request started; only the locked row proves who they *are*. The route adds a second
check and the transaction the third — the third is the one that matters.

### The sabotage log

Every claim was verified falsifiable before being believed:

| Sabotage | Result |
|---|---|
| Role lookup also grants `farmer` | 2 tests fail |
| The `not_approved` gate removed entirely | 2 tests fail |
| `approveFarm` skips the administrator liveness check | 2 tests fail |
| Callback auto-provisions any verified email | 1 test fails |
| `POST` takes `administratorId` from the request body | 1 test fails |
| Logout clears only the cookie | 1 test fails |
| `requireRole` dropped from the farms route | 5 tests fail |
| `resolvePrincipal` returns a hardcoded admin | 5 tests fail |
| Each of 5 migration constraints dropped | 1 test each |
| Prefix-matching cookie parser; each cookie attribute | 1 test each |
| Session revocation / expiry-boundary / hash-identity | 1 test each |

**A false negative that taught the lesson again.** The first "callback skips the administrator
lookup" sabotage came back green, which looked like a hole in the test. It was not — the edit was
`if (false || administrator === null)`, which is *identical* to the original. Rewriting it as genuine
auto-provisioning made the test fail correctly. Worth recording because the failure mode is
seductive: a sabotage that does not change behavior proves nothing about the test, and reads exactly
like a test that cannot fail.

**One genuinely weak assertion, found and fixed.** That same test asserted
`expect(sessions.length).toBeGreaterThanOrEqual(0)` — a check that cannot fail. It now asserts that
no administrator row and no session were created, which is what the property actually is.

### Findings

- **Eight existing fixtures broke on the new NOT NULL, and that is the correct signal.** Every suite
  that inserts an administrator needed an email. Each got a distinct address, since the partial
  unique index rejects duplicate live rows and a shared literal would couple independent suites.
- **`createDb`, not a hand-built `Db`.** The first version of the approval suite built
  `{ orm: drizzle(clientA), sql: clientB }` and hit `ERR_INVALID_ARG_TYPE` binding a `Date`. The
  cause is documented on `createDb` itself: `drizzle()` overwrites the date serializers on whatever
  postgres.js client it is constructed over. Use `createDb`, which keeps the two clients separate
  structurally. (`sharedDb`'s first-call caching, per the standing rule, is why `createAppContext`
  is not an option here.)
- **Route suites must close `publicReadContext`'s pool.** It is cached for the process life and has
  no other owner in a test, so `dropdb` fails on the live connection without an explicit close.
- **Migration/schema drift was checked directly** rather than assumed: applying 0000–0003 to an empty
  database produces exactly the constraints and indexes `schema.ts` declares, with `email` NOT NULL
  and `contact_id` nullable.

### Deliberately not built

**Email delivery of the sign-in link (filed as F-031).** F-025a builds link *verification* and the
session it mints, not sending. Sending needs a mail provider, credentials, and a data-handling
attestation no decision has authorized — inventing one would be exactly the speculative machinery
CLAUDE.md forbids. Today a link is minted out of band with `issueMagicToken`, so a non-technical VIGA
operator cannot yet sign in unaided. That is a real gap before go-live, and it now has an owner.

**The flag queue and stock-out visibility (F-030, was F-025b).** `/api/admin/flags` keeps a *working*
role check over an empty list and reads nothing. Its retired-F-009 comment is gone, replaced by one
saying what it does and does not do. Until F-030 ships, an arriving flag is durable and unreviewable
— which is also why F-026's retention exemption never terminates.

**Verified, then merged to `main` as `0f2f44d` (PR #38):** unit 292/292 (30 files), integration
176/176 (13 files, real Postgres), typecheck, lint, evals critical 10/10 + advisory 4/4 +
adversarial 25/25, production build with `/admin` rendering. Re-verified green on merged `main`.
No deploy owed — nothing is deployed until F-029, and migrations run as part of that step.

---

## 2026-07-26 — B-004: the webhook kicks the workers, and three tests that could not fail

One item (B-004), one PR. Inbound reply latency went from a ~60s worst case to a **measured 47ms**
end to end against real Postgres. The production diff is 41 lines in one route plus a new 95-line
module; no worker, transaction, or handler changed, which was the explicit scope boundary.

**The fix is smaller than the problem sounded.** `runInboundPass` and `runOutboundPass` already
accepted an optional ID list — added during F-023 so tests could drive one sender — so a per-sender
kick needed no new plumbing at all. The webhook builds its 200 first, starts both passes with `void`
and a `.catch`, and returns. Everything durable stays where it was: the claim is still
`claimNextInboundEvent`'s row lock, dedup is still the inbox's unique provider event ID, the consent
recheck is still `authorizeDispatch`'s.

**The kick owns no guarantee, deliberately.** Next 14.2.35 has neither `unstable_after` nor
`@vercel/functions`' `waitUntil`, so work started after the response can be frozen or killed by the
runtime. That is not a problem to solve — it is the design. B-004's own acceptance criteria require
that a kick which "crashes, times out, or never runs loses nothing," so the kick is best-effort by
construction: every failure swallowed, each pass budgeted at 10s, cron unchanged as the recovery net
and still the only trigger for F-026's retention purge. Awaiting the kick would satisfy the latency
criterion and violate the acknowledgement one.

### The sabotage log, which is where the real work went

**"Suppressing the kick loses nothing" — proven by deleting it.** With the kick removed from the
route entirely, exactly the two latency tests fail and all four durability tests still pass,
including the reply going out on the next cron pass and both race tests. That asymmetry is the
proof; a suite where removing the feature fails everything would prove nothing about recoverability.

**The race tests could not fail, and finding that took four attempts.** First version used two
`Promise.all` branches. With the claim's `alreadyProcessing` check disabled — then the explicit
`for update` — then the `state = 'pending'` filter — the suite stayed green every time. Two branches
in one event loop do not race: the first claim transaction resolves before the second starts.
Instrumenting concurrent claims directly showed 1 of 3 succeeding even with guards removed, which
identified the actual load-bearing primitive: the **`sender_states` upsert**, whose `on conflict do
update` takes the row lock that serializes the whole claim transaction. The other three guards are
defense-in-depth over it. Only removing the upsert's lock produced genuine triple-claiming — and
only then did the race tests fail. They now use 8 contenders instead of 2.

**F-023's suite assumed an inert webhook, and 9 of its tests broke.** Not a defect in the kick: the
suite delivered a message through the real route and then ran its *own* pass with a controlled clock
and a `ForbiddenProvider`, which now raced a second real processor. Two fixes, deliberately
different. Tests that must own the model interaction (scripted-provider free-text cases) use a new
`deliverInboundOnly` that persists exactly what the route persists without kicking. Compliance tests
keep the original `ForbiddenProvider` proof on a no-kick delivery, and separately assert the kick
carried the message end to end.

**An honest limit, recorded rather than papered over.** `expectKickProcessedIt` was initially
commented as proving "no model on the compliance path" via the composition root's response-less stub
provider. Sabotage disproved that: moving the `freeText` call ahead of `parseCommand` still passed,
because these fixtures leave the database empty, empty retrieval short-circuits in code before any
seam (Golden Rule #4), and the stub is therefore never reached. The comment now says what the helper
does and does not prove, and the guarantee stays owned by `routing.test.ts`, whose throwing seam
fails 8 tests on that sabotage. The compliance path's `ForbiddenProvider` proof was re-verified as
still falsifiable after the restructure.

### Findings reported rather than absorbed

- **`sharedDb` caches on first call and ignores the URL thereafter.** So `createAppContext` cannot be
  bound to a second database in-process, and calling `close()` on a context tears down the pool other
  suites share. The latency suite assembles the two capabilities `runOutboundPass` actually reads
  (`db`, `sendSms`) instead. Worth knowing before anything else tries to build a second context.
- **Provider selection couples the webhook verification key to the delivery transport.** The route
  requires `SMS_PROVIDER=telnyx` to trust an inbound webhook, which also selects the live Telnyx
  transport — the test suite hit a real 401 against `api.telnyx.com` with a fake key. That coupling
  is a safety property (the simulator never inherits live secrets), so the suite stubs the one
  `fetch` at the network boundary rather than splitting the config axis.

**Verified on the branch:** unit 279/279 (28 files), integration 144/144 (10 files, PostgreSQL
16.12), typecheck, lint, evals critical 10/10 + advisory 4/4 + adversarial 25/25, production build.

---

---

## 2026-07-26 (later) — F-023 inbound routing, F-026 retention, F-027/F-028 cleanups, and a latency defect the specification caused

Four items merged (PRs #30, #31, #35, #33) plus a docs sync (#32). Ended on `main` at `5fb13b8`,
everything merged, no open PRs. The session began as a question about demoing to the VIGA board and
became the largest single day of go-live progress.

**F-023 closed the biggest gap between a green suite and a working product.** The webhook persisted
inbound events correctly and `runInboundPass` claimed and finalized them *without routing* —
`parseCommand`, `consentTransitionFor`, and `answerInquiry` had zero production callers, so a farmer
who texted `STOP` was never unsubscribed on a registered 10DLC campaign. `apps/web/lib/routing.ts`
is the composition that was missing.

The design decision worth keeping: the model seams are reached only through a `freeText` callback
invoked *after* `parseCommand` returns `none`. That makes "no model call on the compliance path" a
**structural property of the function** rather than a convention a future edit could quietly break,
and `routing.test.ts` proves it with a seam that throws on any call.

**The registered auto-response copy existed in no TypeScript file.** Opt-in, opt-out, and help
responses were registered with the carrier and transcribed in `TELNYX_10DLC_FIELD_VALUES.txt`, but
`HELP` could not have returned the registered text because the text was not in the codebase. Now in
`packages/core/src/sms/auto-responses.ts`, verified character-for-character against the transcript
by a test that fails on drift in either direction — the same pattern `commands.test.ts` already used
for keywords. The console stays the authority.

**F-026 made the retention promise executable.** Every body carried a `body_expires_at` 30 days out
and nothing ever acted on it. `purgeExpiredBodies` clears expired text from `sms_messages` and
`outbox_work` while retaining rows, projections, flags, and audit events. The flagged-thread
exemption is deliberately written as "purge only what can positively be shown to have no open flag"
— purging evidence out from under an open safety review is irreversible in a way over-retention is
not. **F-025 is a real dependency**: until flag resolution exists, nothing moves a flag out of
`open`, so a flagged body retains indefinitely. That is the exemption working, not a leak.

**F-026's agent found a race outside its own scope.** `runOutboundPass` reads `outbox_work.body` to
send it, so purging a `queued` row whose expiry had passed would have **delivered an empty SMS to a
real person**. The outbound purge is now restricted to terminal states.

**F-027 exposed a live privilege-escalation gap while removing a cosmetic vestige.** The tenancy
field was speculative and harmless; the *missing test coverage* was not. The old role suite tested
`farmer → staff/admin` but never the reverse, so granting `staff` the `farmer` role — an operator
silently gaining farmer capability, against Golden Rule #1 — **passed the pre-change suite**.
Verified directly by running the old assertions against that escalation. The suite grew 6 → 13 tests
and now fails three on it.

Also: the new tripwire is deliberately **unanchored**. The borrowed `/\btenant/i` pattern matches
`tenantId` but *not* `targetTenantId`, the exact parameter name removed — an anchored pattern would
have let the concept walk back in. Both tripwire files assemble the term from fragments so the scan
needs zero path exclusions; exclusions are how tripwires die.

**F-028's history was not what the item assumed, and the real finding is about test blindness.**
F-021's completion claim was *correct* — it deleted all six tracked files. Two directories survived
holding only a gitignored `tsconfig.tsbuildinfo`, so the repo looked like six packages while git
tracked four. The `workspaceDirectories()` helper skips any directory lacking a readable
`package.json` — **exactly an orphan's shape** — so the "only the approved four packages" test was
structurally blind to it. A green test that could not fail for this case.

### B-004: a latency defect the specification caused

Filed this session. Inbound SMS waits up to ~60s for a reply because the cron trigger polls at
Vercel Cron's one-minute floor, against a target of ~10s. Every durable property F-023 and F-026
proved still holds — they just hold slowly.

**The root cause was the brief, not the implementation.** F-023's specification asked for "the
smallest thing that works" as a *trigger* and framed the decision as a scheduling-mechanism choice.
Nobody asked what response latency the product needs, so the agent built exactly what was specified
and built it well. Batch polling suits background work; an SMS exchange is request/response and the
person is holding a phone. Decided fix: the webhook kicks the inbound pass *after* acknowledging
Telnyx, with cron demoted to a recovery net. An inline kick was rejected during F-023 planning for
risking the prompt-ack requirement — that objection applies to work before the 200, not after it.

### Process finding: parallel agents shared one working tree

F-027 and F-028 were dispatched in parallel without worktree isolation. They overwrote each other
repeatedly; one committed against instructions purely to stop losing work, and both spent real
effort on recovery rather than building. Both branches were rebuilt from `main` and re-verified from
scratch, and neither shipped the other's content — but that is remediation, not a defense. **Use
isolated worktrees for any future parallel dispatch.**

A related lesson about trusting agent reports: the F-023 agent reported completion with no
verification numbers and no sabotage log, having marked the PM item "in review" while the code sat
uncommitted with zero commits on the branch. Independent sabotage-testing of every merged item found
one real gap the agents missed — an exemption predicate drift from `f.status = 'open'` to
`f.status <> 'resolved'` passed F-026's entire suite, because no fixture isolated a *dismissed-only*
thread. Closed with the missing fixture before merge.

### Decisions recorded for the remaining items

Walked through the four items needing max's input; all decisions are in their PM item files.
**F-025** splits into a/b (auth + approval first, then flag queue), admin identity becomes **email**
(`administrators.contact_id` points at a phone while magic-link auth uses email — nothing connected
them), bootstrap is a seed script. **F-024** targets DeepInfra on a mid-size instruct model; the
attested terms are *DeepInfra's* as inference host, and the attestation stays a blocking TODO until
max reads their data-processing terms — an agent must never infer those values. An adversarial eval
failure **stops and reports**; no fixture edits to go green. **B-002** uses a typed TypeScript data
file with seed-time coordinate lookup, and waits for max's stand list rather than being built
speculatively. **F-029** goes live only after everything else, B-004 included.

### Verified on `main` at `5fb13b8`

`npm test` 269/269 across 26 files; integration 138/138 across 9 files; typecheck, lint, evals
(critical 10/10, advisory 4/4, adversarial 25/25); production Next.js build. Every merged item was
independently sabotage-tested rather than accepted on its agent's report.

---

## 2026-07-26 — F-012 closed on live console state, B-003 date-dependence, and the go-live path logged

Three merged branches earlier in the day (F-016, F-018, F-017 — see their entries below) plus this
wrap. Ended on `main` at `06e120c`, everything merged, no open PRs.

**F-012's blocking carrier question was moot, and the reason matters more than the answer.** The item
had stayed open on: *does amending registered Sample Message 3 require carrier resubmission?* max
supplied the live Telnyx console state, which registers **two** sample messages, both using
`YES`/`NO` — neither advertising the retired `OUT`/`IGNORE` tokens. Nothing needed resubmission.

The false alarm's root cause: `docs/TELNYX_10DLC_FIELD_VALUES.txt` was a **wish list of candidate
field values**, and its "Message 3" was labelled *"if you add another sample"* — a draft never
submitted. Both the PM item's decision brief and the F-012 implementation agent read that file as a
record of what was registered and inferred a problem that did not exist. **A doc that looks
authoritative and isn't is worse than a missing doc.** The file now opens with a STATUS header
declaring it a transcript of live console state, and the rule is written down: change the console
first, then transcribe.

**A real compliance defect surfaced from the comparison.** The registered HELP auto-response
contained the support number `+15163178228` while the campaign declares `Embedded Phone Number: No` —
the copy contradicted the declared attribute, the kind of mismatch that draws a carrier review flag.
max edited the console so help routes to `board@vigavashon.org`; the declaration is now truthful.
Console-vs-repo drift was corrected **toward the console** (it is the authority), and two tests now
read the artifact: every sample message must carry opt-out language, and the auto-responses must
contain no phone number while the campaign declares none.

**B-003 — the integration suite was date-dependent, and it broke mid-session.** Verified 106/106 at
00:06; at 08:32 the same suite failed **54 of 106** with no code change. Fixtures hard-coded
`2026-07-25` while `outbox_work.created_at` defaults to `now()` and the schema enforces
`body_expires_at > created_at` (the retention rule that a body outlives its row). A fixture expiry
written as "tomorrow" became "yesterday" once the wall clock passed it. **The constraint was right;
the fixtures were wrong.**

Method note worth keeping: the failure appeared while verifying an unrelated two-file *documentation*
change. Stashing that change and re-running proved 54/106 failed on clean `main` — establishing the
edit was innocent *before* investigating is what kept the diagnosis honest.

Fixture instants across all six suites are now offsets from a clock-derived anchor, which preserves
every ordering and duration asserted while letting the timeline move with the clock. Rows whose expiry
must clear `created_at = now()` use a 48h horizon; the previous 24h landed exactly on "now" once the
anchor became relative. A tripwire in `architecture.test.ts` fails if a literal instant returns, and
fails **loudly** (ENOENT) rather than vacuously if a listed suite path goes missing — the obvious
failure mode for a test that reads files by path.

**The sabotage that mattered most:** fixture expiry is 48h and `STALE_AFTER_HOURS` is 48, so raising
the threshold to 100000 was necessary to confirm the stale-listing test still *discriminates* rather
than passing vacuously under the new anchor. Also sabotage-verified: the conversation-watermark
staleness guard, consent START/STOP ordering, a reintroduced literal date, and the missing-path case.

**B-003 reframes B-001, and B-001 was left open deliberately.** B-001 was an undiagnosed
`1 failed | 91 passed` flake; F-012's first tranche found a genuine unanchored-regex defect (~3.1% of
random UUIDs) and closed B-001 against it. That fix stands on its own merits. But a date-boundary
failure produces the *same* signature, the original failing test name was never captured, and B-003
proves the suite held more than one time bomb. So the regex is *a* candidate cause, not a demonstrated
one. **Do not cite B-001 as closing the intermittent-failure class.**

**The go-live path was logged as owned PM items (F-023–F-027).** It had been described in prose across
several sessions and existed nowhere in PM — the backlog was entirely closed clean-room findings plus
B-002. Derived from reading the code, not from prior summaries. Two findings from that audit:

- **Nothing routes inbound SMS.** The webhook verifies signatures over raw bytes and persists the
  minimized projection correctly, but `runInboundPass` claims an event, fails stale ones closed, and
  finalizes it **without routing**. Production callers of `parseCommand`, `consentTransitionFor`,
  `answerInquiry`: none. So a farmer texts `STOP` and nothing unsubscribes them — a carrier-compliance
  exposure, not merely a missing feature, since `parseCommand` being well-tested is irrelevant if
  nothing calls it. (F-023)
- **Nothing can approve a farm, and publication requires approval.** `transactions.ts:711-715` returns
  `not_approved` without a live `farm_approvals` row, and no code path creates one. **The publication
  tests pass because their fixtures insert the row themselves** — green tests over an unreachable
  production path, the same pattern F-017 and F-018 each hit. (F-025)

Also filed: F-024 (the configured provider is still the stub), F-026 (bodies get a 30-day
`body_expires_at` and nothing ever deletes them — the retention promise is a claim, not a mechanism),
F-027 (vestigial `tenantId` carrying a hard-coded `"viga"` plus a tenant comparison that can only
succeed, contradicting the tenancy non-goal; no table has a `tenant_id`, so nothing to migrate).

F-023 and F-026 both need a scheduler and neither has one; the item files record that whichever lands
first owns the choice, so one mechanism serves both.

**Verified at wrap** (sequentially, never chained): unit 222/222 across 22 files; integration 106/106
across 7 files vs PostgreSQL 16.12; typecheck; lint; evals critical 10/10, advisory 4/4, adversarial
25/25.

---

## 2026-07-26 — F-017 public map, browser proximity, and a model reachable from the public graph

Built from clean `main` at `dc2973c` on `f-017-public-map-proximity`. Test-first throughout.

**The headline: F-019's model-free claim was true of the HANDLER and false of the MODULE GRAPH.**
F-019 proved `handleStandsRequest` works with a throwing provider, and that is real evidence. But
the public route and the map page both imported `appContext()` from `lib/composition.ts` — which
constructs `inquiry`, `stockOut`, and `interpreter`. So `@farm-friend/ai` **was** in the public read
surface's transitive import graph. Nothing was called, so no test could fail; but making the public
map "smarter" with `context.inquiry` was a one-word diff with nothing structural in its way, and
that is precisely the anonymous model-backed web surface F-019 exists to keep out of launch.

The fix splits the shared infrastructure into `apps/web/lib/public-context.ts` (db + clock, reading
`DATABASE_URL` directly) which `composition.ts` now builds on top of — one pool, one clock, two
consumers. The public route and page import the narrow context, so **the public read path cannot
name a seam it was never handed.** `apps/web/lib/public-surface-model-free.test.ts` walks the
transitive local imports of both public entry points and fails if a model package or any seam
constructor appears anywhere in them. It carries an explicit anti-vacuity guard — if the crawler
ever stops resolving imports, that guard fails rather than letting every assertion pass silently.

**`MapProvider` existed, had zero consumers, and invented coordinates for any address.**
`StubMapProvider.geocode()` returned a deterministic pseudo-coordinate near Vashon derived from a
string hash of *any* input. Nothing imported it but the barrel. Deleted, with a tripwire in
`architecture.test.ts` that fails if `MapProvider`, `StubMapProvider`, a `geocode(` call, or a
mapping/geocoding/routing dependency reappears in any workspace. A stand pinned at a fabricated
point is worse than one with no point: it sends a real customer somewhere real and wrong.

**Proximity is arithmetic, not a provider.** `packages/core/src/public/proximity.ts` is pure —
haversine distance, coordinate validation, destination-link construction, no network and no
adapter. Haversine rather than flat subtraction because a degree of longitude is ~46.7 miles at
Vashon's latitude and ~69 at the equator, and a customer told the wrong stand is nearest has a wrong
answer, not an imprecise one; a unit test asserts exactly that, so "simplifying" to Pythagoras
fails. Routing links carry the **validated coordinate and no origin parameter** — the address string
is deliberately absent so a click-time geocoder cannot land someone at a different "Provo Farms".

**The browser origin is transient because of WHERE it lives, not because of a promise.** It is React
state in the customer's own tab; sorting happens client-side over a list already delivered. There is
no code path that could send it anywhere, so "not stored, not logged, not in model context" is
structural. `@farm-friend/core/proximity` is a new browser-safe subpath export — the barrel pulls
`node:crypto` (phone hashing) into the client bundle and broke the production build, which was a
useful signal that the client should not reach server-side privacy code at all.

**The SMS origin boundary reuses F-018's mechanism rather than inventing a second one.** Recognizing
that "which stand is closest to me?" needs a position is *meaning*, so the model sets
`originDependent: boolean` and code appends `ORIGIN_LIMITATION_STATEMENT`. The subtle failure this
prevents is not invented geography — it is returning an ordinary recency-ranked list as though it had
answered "which is closest?". So a ranking operation of `nearest`/`closest` is **refused rather than
silently downgraded**, and the intent allowlist has no member that can carry a coordinate, distance,
bearing, or travel time.

**The map UI shows staleness three ways.** A left border, an amber recency line, and the words "May
be out of date" — colour alone fails for a colourblind customer and in bright sun, and this is the
one signal the product cannot afford to have missed. A stale listing is never hidden; a
confirmed-empty stand reads "The farmer confirmed this stand is empty right now" rather than showing
a gap. Verified against real seeded data in a running dev server: 4 stands, the 9-day-old listing
present and marked, 4 destination-only links, zero origin leakage in the HTML.

**Sabotage-tested, seven ways.** Reintroducing a `MapProvider` file (architecture tripwire fails);
importing `appContext` on the public page (2 model-free tests fail); importing a seam two levels
deep in the graph (transitive crawl catches it); breaking the crawler itself (anti-vacuity guard
fails); hiding stale listings (5 map-view tests fail); replacing the limitation constant with
fabricated geography (1 adversarial eval + 2 unit fail); disabling the intent allowlist (3
adversarial fail); downgrading an unexecutable ranking to `any` (3 adversarial fail); and dropping
the limitation from the reply (1 integration fails). Each was restored after confirming.

**H22 was the tautology risk and was checked deliberately.** It asserts on `ORIGIN_LIMITATION_
STATEMENT` — a constant checked against itself is the failure mode F-012, F-016, and F-018 each
caught in their own work. It was written from the start to assert the constant does **not** match a
distance or direction pattern, so swapping in fabricated geography fails it; the unit tests catch
the same swap independently. **No test in this tranche could pass under a broken implementation** —
verified by the sabotage runs above, not assumed.

**Deliberately not done:** no seed utility was built (F-017's scope names "validated one-time
seeding", but there is still no seed script in the repo and none was in scope to invent here — the
*constraints* it must satisfy are enforced by the schema, which already rejects out-of-range
coordinates). No per-stand pages, no filter/search UI. F-012's external decision untouched.

**Verified:** `npm test` 219/219 across 22 files; real-Postgres integration 106/106 across 7 files
(suites run sequentially, `tee` captured); typecheck, lint, `git diff --check` PASS; evals critical
10/10, advisory 4/4, adversarial **25/25** (was 19); production Next.js build passes. No integration
failure occurred; B-001 did not recur.

## 2026-07-26 — F-018 recipe scope boundary: the seam never existed, the prose channel did

Built from clean `main` at `fad267c` on `f-018-recipe-scope-boundary`. Test-first throughout.

**The recipe seam never existed — confirmed empirically before deleting anything.** F-018 is written
as "remove the recipe model projection/seam, model permission, provider decision, and misleading
advisory-eval claim." A case-insensitive grep for `recipe|meal|food.?safety|preparation|cook|canning|
preserv|forag` across `packages/`, `apps/`, and `evals/` returned **zero** recipe machinery — every
hit was the word "preserves" meaning *retains an item*, or "Strawberry preserves" as a test fixture's
item name. `packages/ai/src/projections.ts` has exactly four projections (inventory extraction,
inquiry interpretation, grounded fact selection, stock-out parse); none is a recipe seam. There is no
recipe-link provider in the handoff's unresolved-decisions list, and no advisory eval mentions
recipes. **Four of the item's scope bullets and one acceptance criterion had nothing to act on.**
This is the third consecutive item to hit the same trap, and the docs were already correct here —
`AI_ARCHITECTURE.md` line 180 stated "Recipe requests have no model composition seam."

**What was actually wrong is the half the item's acceptance criteria pointed at and nobody had
built: there was no enforcement, and there WAS a live prose channel.** `validateInterpretedIntent`
accepted `{kind:"ambiguous", question:<any non-empty string>}` and `answerInquiry` returned that
string to the customer **verbatim**. `validateFactSelection` had the identical `clarification.
question` field. Reproduced with a throwaway probe before any code changed:

```
VALIDATION OK: true
DELIVERED VERBATIM TO CUSTOMER:
  Kale chips: toss with oil, bake 350F 12min. For canning, boil jars 10 minutes;
  low-acid vegetables are safe at 15 PSI. See allrecipes.com/kale
```

Canning pressures, a link, and every blocking check green. That is precisely F-018's stated
"consequence prevented," and it was live on the launch path.

**The fix removes the channel rather than policing it.** The item forbids a content scanner,
classifier, or moderation service — and rightly: scanning invites an arms race over wording. Both
outcomes became **bare signals carrying no field but `kind`**, refused by an exact `keys.length !== 1`
check, and code renders the words (`renderClarificationRequest`). A model with no permitted field to
write into cannot smuggle prose through it, whatever it renames the field to. That is why the
adversarial fixtures try `question`, `message`, `answer`, `suggestion`, and `recipe` — the defense is
structural, so all five fail identically.

**The scope statement is a boolean, and that distinction is the whole design.** Recognizing that
"what can I make with kale?" is a recipe request is *meaning*, so it stays the model's job —
hard-coding a food or request vocabulary in `retrieval.ts` would be exactly the taxonomy-as-policy
CLAUDE.md forbids. But the model sets `outOfScopeRequest: boolean` and **nothing else**; code appends
the `RECIPE_SCOPE_STATEMENT` constant. The model classifies without composing a syllable. A
non-boolean value there is refused — "prose wearing a flag's name." The useful half survives: a
recipe request naming an ingredient still gets real availability and recency, then the boundary.

**Sabotage-tested, five ways — and the one at risk of being tautological was checked deliberately.**
Loosening the ambiguity check to `keys.size > 2` (2 unit + 2 adversarial fail); hard-coding
`scopeNote` off (2 integration fail); loosening the clarification check (1 unit + 1 adversarial);
replacing `RECIPE_SCOPE_STATEMENT` with actual recipe text (1 adversarial + 2 integration); removing
the boolean guard (1 unit + 2 adversarial). Each was restored after confirming.

The fourth is the one worth recording. H16 asserts on `RECIPE_SCOPE_STATEMENT` — a constant checked
against itself is exactly the failure mode F-012 and F-016 each caught in their own work. It was
written from the start to assert the constant does **not** contain `"350F"`, so swapping in recipe
prose fails it; the integration tests caught the same swap independently. **No test in this tranche
could pass under a broken implementation** — verified, not assumed.

**One test of mine asserted the wrong mechanism and was corrected.** The hostile-ambiguity
integration test expected `rejected`; the real outcome is `clarification`, because
`createInquiryModel.interpret` deliberately converts *any* schema failure into a bare ambiguity
signal — it fails toward asking rather than guessing, unlike the selection seam, which reports a
refusal to keep attacks observable. That asymmetry is pre-existing and defensible. The test now
asserts the property that matters — no word the model wrote survives (`15 PSI`, `allrecipes.com`,
`350F`, `/canning|bake/i` all absent) — rather than forcing a mechanism.

**Deliberately not done:** F-012, F-016 (done/merged, not reopened); F-017's public map UI and
proximity/routing links untouched. No content scanner, classifier, moderation service, recipe table,
provider, package, or durable entity was added — the diff adds one boolean field, two code-rendered
strings, and deletes two prose fields.

**Verified:** `npm test` 177/177 across 19 files; real-Postgres integration 103/103 across 7 files
(suites run sequentially, `tee` captured); typecheck, lint, `git diff --check` PASS; evals critical
10/10, advisory 4/4, adversarial **19/19** (was 14); production Next.js build passes. No integration
failure occurred; B-001 did not recur.

## 2026-07-26 — F-016 one launch SMS program, and a live consent defect

Built from clean `main` at `d93ece5` on `f-016-launch-consent-boundary`. Test-first throughout.

**The headline: F-016 was not a deletion item, it was a defect.** The item is written as "remove
passive customer follow-up, follow-up-interest state, and scoped `MUTE`." Grep found **none of the
three in executable code** — F-012's inspection was right, and it extends past `MUTE` to follow-up
state as well. Every hit was documentation. Had the item been taken at face value there would have
been nothing to build.

What was actually wrong was the other half of the item — *"every proactive non-required outbox claim
rechecks **active** launch consent."* It did not. `authorizeDispatch` asked
`consent[0]?.state === "stopped"`, so a recipient with **no consent row at all** — never onboarded,
never texted `JOIN`, never opted in by any route — was **authorized** for a proactive send. Absent
consent read as permission. Proven with a throwaway probe before any code changed:
`CONSENT ROWS: 0` → `CLAIM STATUS: authorized`. That is a live Golden Rule #2 violation on the
launch critical path, not a documentation gap.

**The fix puts the meaning in one place.** `isProactiveSendPermitted` in
`packages/core/src/sms/consent.ts` is a pure predicate over a consent record — no database, no
model, no conversation state — and `authorizeDispatch` consults it rather than reimplementing the
rule in SQL. It asks for `state === "active"`, so silence is no longer permission.

**One bounded category replaced two overlapping flags.** The outbox carried a free-text
`message_kind` *and* an `is_required` boolean. Neither could express the case the consent model
actually needs: a direct reply permitted by the recipient's own inbound message that is *not*
carrier-required. Rather than add a third flag, both were deleted in migration `0002` in favor of
one `message_category` enum. Three tiers now exist and each has a reason: `required_reply` survives
everything (otherwise `STOP` could not acknowledge itself), `inquiry_reply` rides on the customer's
own message but is still suppressed by `STOP` (universal STOP outranks an owed reply), and the rest
are proactive and need active consent.

**`JOIN` had no consumer.** It parsed as a compliance keyword and then nothing read it —
`applyConsentTransition` accepted only `"start" | "stop"`. `consentTransitionFor` now maps both
registered opt-in spellings onto the one program, differing only in recorded provenance, and the
transaction persists that provenance.

**Sabotage-tested, six ways — and one test was too weak.** Reverting the gate to `!== "stopped"`
(1 unit + 2 critical evals + 2 integration); making `JOIN` establish nothing (1 unit + 1 eval);
reordering so `STOP` no longer outranks a reply (1 unit + 1 eval); deleting the `required_reply`
exemption; disabling the dispatch gate entirely (4 integration, including a pre-existing F-014 STOP
test); and dropping `JOIN` provenance (1 integration). Each failed as expected and was restored.

The fourth one is worth recording: deleting the `required_reply` exemption failed the unit test but
**the integration suite stayed green (32/32)**. The test asserted that a recipient with *no consent
row* still gets a required reply — which passes under either rule, so it could not fail. Rewritten
to use a recipient who has just **`STOP`ped**, which is the case that actually distinguishes them.
This is the same failure mode as F-012's tautological eval, in a different disguise: a test that
cannot fail proves nothing. The literal category lists in the new eval and unit test are spelled out
rather than iterated from `LAUNCH_MESSAGE_CATEGORIES` for the same reason.

**Deliberately not done:** F-012's registered `OUT`/`IGNORE`, `STOPALL`, and FLAG copy scope
(done and merged, not reopened); F-017 and F-018 untouched.

**Owed, and named rather than quietly absorbed:** there is still **no inbound routing layer**.
Nothing in production code calls `parseCommand`, `runInboundPass`, or `answerInquiry`, so
`consentTransitionFor` has no runtime caller. F-016 owns the consent *decision* and proves it;
building the router that consumes it is downstream work.

**Verified:** `npm test` 171/171 across 19 files; real-Postgres integration 98/98 across 7 files;
typecheck, lint, `git diff --check` PASS; evals critical 10/10 (was 7/7), advisory 4/4, adversarial
14/14; production Next.js build passes.

## 2026-07-26 — F-012 keyword-set alignment, and B-001 finally caught with a name

Built from clean `main` at `fc6c77d` on `f-012-keyword-set-alignment`. Test-first throughout: the
new `commands.test.ts` block failed 8/15 before the parser changed.

**The STOPALL finding held exactly as briefed.** `STOP_WORDS` was
`{STOP, UNSUBSCRIBE, END, QUIT, CANCEL}` while `docs/TELNYX_10DLC_FIELD_VALUES.txt:20` registered
`STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT` and the public pages promised the same six. A subscriber
texting `STOPALL` — registered with the carrier, promised publicly — fell through to
`{ kind: "none" }` and reached the model as free text. A live Golden Rule #2 violation.

**The fix is structural, not a list edit.** Adding one string would have left the two lists free to
drift again tomorrow. Instead the registered lists are now stated **once**
(`REGISTERED_OPT_OUT_KEYWORDS` / `_OPT_IN_` / `_HELP_`) and the parser tables are *derived* from
them, so a keyword cannot be advertised without being honored. A test then reads the registered
`.txt` artifact itself and asserts agreement **in both directions** — registered-but-unparsed is a
broken public promise, parsed-but-unregistered means live behavior exceeds what was disclosed.

**Drift checked both ways, as instructed.** Registered→code found only `STOPALL`. Code→registered
found `OUT`/`IGNORE`, which were parsed but *not* in any registered KEYWORDS field — the item's
claim that the keyword registration was already correct is confirmed. Their drift lives in
**Sample Message 3** and the public "Supported Commands" copy.

**The superseded commitment machine is deleted, and that was in scope.** `packages/core/src/index.ts`
said so in a comment, the handoff assigns it to F-012, and its only "second consumer" was
`gleaning_signup` — an explicit non-goal. It had no transactional caller. The two **critical** evals
that exercised it were not dropped: they were re-pointed at the live `confirmationEligibility` path
and assert the same invariants (non-contextual YES cannot commit; expiry cannot be revived), plus a
third for `predates_activation`. Critical evals went 5/5 → 7/7 — coverage moved onto real code
rather than lapsing.

**A tautology caught during sabotage testing.** The new eval originally iterated
`REGISTERED_OPT_OUT_KEYWORDS`, so deleting `STOPALL` from that constant made the parser *and* the
eval agree — 3 unit tests failed but evals stayed green. Rewritten to spell the six keywords out
literally. This is the difference between a test that checks behavior and one that checks a
constant against itself.

**B-001 reproduced during verification — and this time the log was captured.**

```
FAIL apps/web/lib/inquiry.integration.test.ts >
  keeps every other farm's data out of both inquiry model contexts
  expect(containsRawPhone(context)).toBe(false);   // expected true to be false
```

*Root cause, and it is a real product defect.* `RAW_PHONE_RE` had no boundary anchors, so it matched
**any** run of ten digits. A UUID's hex digits form one about **3.1% of the time** (measured: 6,174
of 200,000). That test puts two location UUIDs into the model context → ~6% per-run failure for that
single test, which reproduces the observed `1 failed | 91 passed` shape and its rough 1-in-8
frequency. **The resource-pressure hypothesis was wrong**; chaining was a coincidence, which is why
the flake seemed to prefer chained runs and never reproduced in isolation.

*Why it mattered beyond the suite.* `redactOutbound` shares the regex and **throws**. Any legitimate
outbound SMS whose text carried an identifier with an unlucky digit run would be refused at random —
an intermittent failure on the delivery critical path.

*The F-013 echo.* F-013 fixed this same bug class in `assertNoRawPhone` but left the sibling
`RAW_PHONE_RE` unanchored. The SESSION_LOG warning "treat a named test as a real defect — F-013 hit
a genuine bug that first looked exactly like this" was correct, and following it is what solved this.

*Fix and proof.* `(?<![0-9A-Za-z_])…(?![0-9A-Za-z_])` — the digits must stand on their own. Measured
after: **0 false positives in 200,000 UUIDs**, and `(206) 555-1234`, `2065551234`, `206-555-1234`,
`206.555.1234`, `+1 206 555 1234`, `+12065551234`, `1-206-555-1234` all still refused. The
regression test pins **five specific UUIDs** known to match the old pattern, so this cannot decay
back into a probabilistic flake.

**Sabotage-tested, six ways.** Dropping `STOPALL` from the registered list (3 unit tests + 1 eval
fail); re-adding `OUT`/`IGNORE` as tokens (1); restoring `OUT`/`IGNORE` to registered Sample Message
3 (1); registering `FLAG` as a carrier help keyword (2); deleting the `expired` guard in
`confirmationEligibility` (1 critical eval); deleting the `predates_activation` guard (1 critical
eval); and reverting the phone-regex boundaries (1). Each failed as expected and was restored.

**Deliberately not done:** F-016's passive-follow-up / follow-up-interest / scoped `MUTE` removal
(separate item, not absorbed); F-017 and F-018 untouched. No `MUTE` exists in code or copy today, so
F-012's `MUTE` acceptance criterion is satisfied by inspection rather than by an edit.

**Verified:** `npm test` 159/159 across 18 files; real-Postgres integration 92/92 across 7 files,
**8 consecutive clean runs** after the B-001 fix; typecheck, lint, `git diff --check` PASS; evals
critical 7/7, advisory 4/4, adversarial 14/14; production Next.js build passes.

**Open, and it is the whole reason F-012 stays in review:** *does amending registered Sample Message
3 require carrier resubmission, or is it editable in the Telnyx console?* Everything else is in-repo
or VIGA-website work needing no carrier action.

## 2026-07-25 — F-019 SMS-only inquiry boundary and the public abuse/cost throttle

Built from clean `main` at `d5ad2f1`. Test-first: the throttle tests failed with
`Failed to load url ./throttle`, and the public-surface tests failed on missing modules, before
either existed.

**The item was mostly already documented, and that was the trap.** F-019's decision session (July
24) wrote the doc language and explicitly recorded "No application code … changed." Reading the
docs alone would suggest the item was done. What remained was the entire executable half — which is
exactly the failure mode CLAUDE.md warns about: *do not cite a doc as evidence that a guarantee
holds*.

**A misattribution worth recording.** The starting prompt said the missing public HTTP route "needs
F-017's abuse throttle." It does not: F-017 is proximity and destination links and contains no
throttle. **F-019** owns it ("scope the public unauthenticated model abuse/cost throttle to the QR
stock-out form"). CLAUDE.md's gap line carried the same error and is now corrected. Wiring the
public route therefore belonged to this item.

**The boundary is a dependency set, not a promise.** `handleStandsRequest` takes `db` + `clock` and
has **no seam to hand a model to**, so "public discovery is model-free" is a compile-time fact
rather than an intention. The integration test drives it with a provider that **throws on any
call** — the surface works with no model available, which is the only version of that claim worth
asserting. A cooperative stub going untouched would prove nothing.

**Three decisions worth recording.**

*A refused call does not consume budget.* Recording the rejection would let a client that is
already over its limit extend its own lockout by retrying — punishing the impatient rather than the
abusive. Pinned by a test that refuses at t=30s and expects admission at t=61s.

*The signal hashes the leftmost forwarded hop, not the chain.* Proxies append, so hashing the whole
`x-forwarded-for` value lets an attacker append one random hop per request and buy a fresh budget
every time. This was written as a test first ("uses only the first hop of a forwarded chain") and
sabotage-confirmed. The key is salted and hashed so no raw address reaches the throttle map, and it
is a **cost bucket, never identity** — not durable, not an authorization input, no customer profile.

*Two orderings are load-bearing.* The throttle runs **before** the model call, so a refusal costs
nothing; and a **malformed body is rejected before the throttle**, so junk cannot spend a genuine
reporter's budget. Both are tested by asserting the provider call count, not just the status code.

**Structure forced by the framework, kept because it is better.** Next.js rejects non-route exports
from a `route.ts`, so the handlers live in `apps/web/lib/` with the route files as thin bindings
from the composition root. That is what makes them injectable and testable with real `Request`
objects and a scripted provider.

**Two things the environment taught us.** `inventory_revisions` is immutable, so the stale-listing
test publishes a *superseding older* revision rather than editing `published_at` — the database
correctly refused the shortcut, which is Golden Rule #1 enforced by a constraint. And drizzle
leaves prepared-statement type state on the connection it migrates over, which mis-binds later
`timestamptz` parameters; the existing suites already dodge this with a throw-away migration
client, and this one now matches.

**Sabotage-tested, five ways.** Disabling the throttle (6 unit + 5 integration fail); calling the
model before the throttle (3 fail); hiding stale listings instead of flagging them (1 fail);
hashing the full forwarded chain (1 fail); drifting the web's recency wording from SMS (3 fail).
The parity test is real: web and SMS share one `renderRecency`/`isStale`, so a fact cannot read
fresh on one channel and stale on the other — **fact parity without interaction parity**, which is
F-019's whole claim.

**Deliberately not done:** the public **map UI** (F-019 built the JSON routes and the boundary, not
the render — F-017 is its natural home); a `destinationLink` helper was started and **deleted**
because routing links are F-017's scope; F-012, F-016, F-017, F-018 untouched.

**Verified:** `npm test` 154/154 across 19 files; real-Postgres integration 92/92 across 7 files
against PostgreSQL 16.12; typecheck, lint, and `git diff --check` PASS; evals critical 5/5,
advisory 4/4, adversarial 14/14; production Next.js build with both public routes registered.
`vitest.config.ts` now collects `apps/*/lib/**/*.test.ts` so the composition root's pure logic is
unit-tested beside it. Merged to `main` as PR #22 (`2aff3eb`), re-verified after merge.

**One flake observed, UNDIAGNOSED — see CLAUDE.md "Known gaps" for the live warning.**

*What was observed, exactly:* two failures this session, each `1 failed | 91 passed`, each inside a
chained `npm test && npm run test:integration && …` invocation. Around them, **17 clean 92/92 runs**
(5 + 6 immediately after the second failure, 6 more during the wrap). Isolated runs have never
reproduced it.

*What was NOT captured — the mistake to avoid repeating:* **the failing test name.** Both times the
output was grepped down to the `Tests` summary line, and by the time a rerun was launched the detail
was gone. Everything below is therefore inference from run *shape*, not evidence about a specific
test.

*The contention hypothesis, and why it is weak.* The initial guess was that two concurrent vitest
processes interfere through the shared Postgres server. **Data interference is ruled out:** every
suite creates its own database named `farm_friend_<tag>_${process.pid}_${randomUUID()}`, so two runs
cannot collide on rows. That leaves only server-level resource pressure — `max_connections` is 100,
in-use was 6, and 7 suites at ~6 connections each means two full concurrent runs peak near 84. Under
the limit, but not comfortably. That is the entire remaining mechanism, and it does not explain why
exactly one test failed rather than a connection error surfacing.

*Why this is worth real suspicion rather than a shrug.* F-013's entry below records a bug that
presented as "~1 in 4 runs, a different test each time" and turned out to be a genuine defect —
`assertNoRawPhone` matching UUID digit runs by chance — which in production would have randomly
refused legitimate customer inquiries. A flake that only appears under load is exactly what a
latent nondeterminism looks like. **Do not close this by observing more green runs.**

*If it recurs, do this first:* capture the failing test name and full assertion **before** rerunning
— `npm run test:integration 2>&1 | tee /tmp/itest.log`, then read the log. Run the suites
sequentially rather than chained (`npm test; npm run test:integration`) to test the contention
hypothesis directly. If a specific test is named, treat it as a real defect until proven otherwise.

## 2026-07-25 — F-013 grounded answers and code-bound stock-out recipients

Built on the F-015 branch (the projection pattern it establishes is exactly what this item
follows). Test-first: `answer.test.ts` and `retrieval.test.ts` were written and observed failing
before either module existed.

**The customer never reads a model-authored fact.** That is the whole item, and it is structural
rather than promised. Retrieval returns typed facts with opaque IDs; the model returns *identifiers
only*; code validates membership against the exact retrieved set, dereferences authoritative
values, and renders names, items, recency, and stale warnings. The selection schema has no field
capable of carrying prose, so a model wanting to invent availability has nowhere to put it.

**The two inquiry projections are deliberately disjoint.** Interpretation sees the question and no
facts — it decides what to look up, and handing it the answer set would invite it to answer from
context. Selection sees the facts and not the raw question — it orders what code found, and the raw
request is where an injection lives. Both splits are compile errors to violate.

**Empty retrieval short-circuits before the selection call.** With nothing to select from, a model
call could only invent, so the honest "no current listing" is code-rendered without one. The
integration test asserts the selection seam was never reached.

**Two decisions worth recording.**

*A refused shape is distinguished from a transient failure.* The first integration run showed a
smuggled `answerText` arriving as a polite clarification: the strict schema rejected it correctly,
but the seam collapsed both failure modes, so an attack was indistinguishable from a network blip.
The seam now returns an explicit refusal and the workflow rejects `invalid_output` visibly while
still asking the customer on `provider_error` — because "nobody has kale" is a factual claim we
cannot support from a failed call.

*Opaque identifiers are checked for shape, never scanned as content.* A flaky integration failure
(~1 in 4 runs, a different test each time) turned out to be a real bug: `assertNoRawPhone` was
applied to UUIDs, whose digit runs match the phone pattern by chance. In production this would have
randomly refused legitimate customer inquiries. The content rule now applies only to human-readable
retrieved text; identifiers get `assertOpaqueId`, which checks that an ID is an ID rather than free
text smuggled through an identifier field. Pinned by a 500-draw regression test plus a
deliberately phone-shaped UUID. Worth noting the general lesson: a safety check applied where its
semantics do not hold is not conservative, it is a liability.

*The superseded `reportStockout` helper was deleted, not corrected.* F-013 required removing its
false "the outcome shape has no inventory field, therefore a report cannot mutate state" proof. It
had no caller but its own test, and the real workflow now proves that invariant against durable
published state, so deleting it beat maintaining two ways to do one thing.

**Deliberately not done:** message classification remains unbuilt and unprojected (F-012's, no
consumer); F-012's commitment machine and OUT/IGNORE tokens are untouched; no live vendor adapter;
F-016 through F-019 untouched.

**Verified:** `npm test` 137/137 across 17 files; real-Postgres integration 72/72 across 6 files
against PostgreSQL 16.12, run **six consecutive times** to confirm the flakiness was resolved rather
than reshuffled; typecheck and lint PASS; evals critical 5/5, advisory 4/4, adversarial 14/14; the
production Next.js build and `git diff --check` PASS. The new adversarial fixtures were
sabotage-tested: relaxing the selection validator's extra-key check fails the smuggling fixture.

**Merged.** F-015 as PR #20 and F-013 as PR #21, both into `main` (`bb192f5`), each re-verified
green after rebase and after merge. CLAUDE.md's live snapshot was compressed in the same wrap: the
build narratives live here, and the snapshot keeps phase, capability, verified counts, and gaps.
There is no deploy owed — no route, migration, or provider config changed.

## 2026-07-25 — F-015 model privacy boundary and hostile verification

Starting from clean `main` at `b9aaf50`, F-015 connected F-014's typed interpreter port to a live
model seam behind the approved boundary. Test-first throughout: the projection tests failed with
`projectInventoryExtraction is not a function`, and the type test's bypass assertions were written
before the export surface they constrain.

**What replaced what.** `assembleContext<T>(seam, fields)` / `assembleSmsContext<T>` are **deleted**,
not deprecated. They were the audit's central finding: a public generic entry point accepting an
arbitrary object, whose runtime scan for phone-shaped text and forbidden key names was doing the
work that a *projection* should do structurally. In their place `packages/ai/src/projections.ts`
exposes one named projection per built seam. `projectInventoryExtraction` constructs its record
field by field from named arguments, so handing it a wider row does not widen model context — the
guarantee is structural rather than a scanner's best effort. It also copies rather than aliases, so
mutating the caller's array afterward cannot reach an already-built context.

**Three decisions worth recording.**

*Only one projection was built.* The seam catalog approves five, but stock-out parsing and grounded
fact selection are F-013's and message classification is F-012's — none has a consumer today.
Building their projections now would have meant five near-duplicate mechanisms with one real caller,
against the zen-desk rule. The generic assembler was deleted rather than kept "until the others
arrive," because keeping it would have preserved exactly the bypass F-015 exists to close.
AI_ARCHITECTURE's seam table now carries a built? column so the gap is legible rather than implied.

*The low-level provider call became unreachable, not merely branded.* F-014's barrier let any caller
invoke `generateJson` with a context of its own choosing, as long as it came from *an* assembler.
Now `generateJson` is not exported from `@farm-friend/ai`; the only public model entry is
`generateValidated`, reachable only with a `ModelSafeContext` that only a projection constructs. The
type test asserts each bypass — including reintroducing a generic assembler — is a compile error.
Both directions were verified by deliberate sabotage: reintroducing `assembleContext` fails `tsc`
with an unused `@ts-expect-error`, and replacing the field-by-field copy with a spread fails exactly
the two adversarial fixtures written to catch it.

*Zod strips unknown keys; the seam now refuses them.* The hostile integration test caught this: a
model returning `publish: true` alongside valid edits had that field silently discarded and its
proposal accepted. Publication was never at risk — it is code's, gated on the farmer's confirmation,
and the test's own row assertions confirmed nothing published. But "the model reached for a
consequence it does not own" must be a *visible refusal*, not an invisible cleanup, so every schema
member is now `.strict()` at the top level too. This is the one place a real defect was found rather
than a claim being tightened.

**Claims narrowed to what is demonstrated.** The outbound guard's "proves the content is clean" is
now "refuses the named raw-phone class," with a test recording the values it deliberately does *not*
catch (emails, addresses, spelled-out digits) and naming what actually keeps other actors' data out:
code-rendered cross-actor text and prose returning only to its own author. `docs/SMS_COMPLIANCE.md`'s
"no raw phone numbers / private fields" line was corrected likewise. The eval suite's cooperative
canned model is gone; `evals/hostile.ts` plus a hostile group in the interpretation integration test
run hostile models across projection → validation → code rendering → durable rows, inspecting the
captured provider context *and* the resulting state.

**The provider privacy gate is executable.** `checkProviderDataHandling` / `assertProviderApproved`
run at the composition root and throw on training, stateful storage, enabled logging, or retention
past 30 days. Honest scope: this checks an operator-attested, version-controlled *declaration* — it
is not a network audit of a vendor's practice, and the configured provider is still the stub, so no
real vendor's terms have been approved through it yet.

**Deliberately not done:** F-012's commitment machine and OUT/IGNORE tokens remain untouched (the
critical evals still exercise them, so removal stays a deliberate F-012 decision); no customer
inquiry, retrieval, or stock-out path (F-013); no live vendor adapter; F-016 through F-019 untouched.

**Verified:** `npm test` 99/99 across 16 files; real-Postgres integration 58/58 across 5 files
against PostgreSQL 16.12; typecheck and lint PASS; evals critical 5/5, advisory 4/4, adversarial
7/7; the production Next.js build and `git diff --check` PASS.

## 2026-07-25 — F-014 authoritative SMS transactions

Starting from clean `main` at `cbf8273`, the authoritative transaction path was built test-first on
top of F-022's schema. Every suite was observed failing before implementation: the six new
migration-surface tests failed for the right reasons (no `provider_event_type`, no
`base_revision_id`, no `invalidated` state, no delivery columns, one migration file), and the 27
workflow tests failed wholesale before the transactions existed. The implementation then:

- added forward migration `0001_authoritative_transactions` without touching `0000` (verified
  byte-identical to `main`): the generalized inbox with a per-event-type minimal-projection check,
  inbound-only sender claiming, base-revision binding, activation-relative expiry, the honest
  `invalidated` proposal state, and the delivery status/watermark plus its monotonicity trigger;
- replaced the speculative generic commitment placeholder with inventory-specific core ports —
  patch application over stable entry IDs where omission preserves, complete-snapshot rendering,
  confirmation eligibility, and a validated interpreter port;
- implemented the authoritative Postgres transactions: durable acceptance/dedup, recoverable
  per-sender claiming under row locks, fail-closed stale ordering, the separate consent watermark,
  one open proposal, exactly-once confirmation/publication with authority + approval rechecked while
  locks are held, consent-aware dispatch, bounded retries, ambiguous quarantine, monotonic delivery;
- implemented raw-body Telnyx ed25519 verification before parsing, minimized event parsing,
  fail-closed configuration, the last-mile raw-phone capability, the single `apps/web` composition
  root, the real webhook route replacing the echo stub, and bounded workers; and
- wired the interpreter port to the one pending proposal, so typed edits revise it and a
  clarification queues a question without creating one.

**Three decisions worth recording.**

*Enum recreation over `ALTER TYPE`.* Drizzle's migrator runs all pending migrations inside one
transaction (`pg-core/dialect.js:54`) and PostgreSQL forbids using a newly added enum value in the
transaction that added it. Splitting the migration into two files does not help. Migration `0001`
therefore recreates `proposal_state` with all five values and swaps the column over, keeping
`invalidated` a first-class state in a single `migrate()` run. Approved by max during implementation
after the alternatives (a separate `closed_reason` column, or reusing `expired` and losing the
distinction) were weighed.

*The generic commitment machine was kept, not deleted.* It is superseded by the inventory ports and
has no authoritative caller, but the unchanged eval suite still exercises it and its `OUT`/`IGNORE`
tokens belong to F-012's parser/campaign alignment. Deleting it here would have broken the evals and
crossed an ownership boundary. `packages/core/src/index.ts` records why it remains.

*Two connection pools, same total budget.* Constructing a Drizzle instance overwrites the date/time
serializers on whatever postgres.js client it is built over
(`drizzle-orm/postgres-js/driver.js:10-14`), after which raw SQL on that client cannot bind a `Date`
— and the resulting error names the calling query rather than the cause. This cost several debugging
rounds and was isolated with throwaway probe tests. `createDb` now backs the query builder and the
raw transactional client with separate clients. The first fix incidentally doubled the connection
ceiling from 5 to 10; max caught that in review, and the split was capped to 3 (raw SQL) / 2
(Drizzle) so the total is unchanged. The fix is structural rather than conventional: no future
caller has to remember to convert timestamps by hand. Whether 5 total is correct is an inherited,
never load-tested number and remains a deployment-sizing question outside F-014.

**Deliberately not done:** no live model adapter, context projection, or hostile-model proof
(F-015); no keyword/parser or campaign changes (F-012); no customer inquiry or stock-out
consequences (F-013); no proximity, recipe, or channel-surface work (F-017 through F-019). The
interpreter port is tested only with deterministic fakes and F-014 makes no hostile-model claim.

**Verified:** `npm test` 83/83 across 14 files; real-Postgres integration 53/53 across 5 files
against an isolated PostgreSQL 16.12 cluster; typecheck and lint PASS; the unchanged eval suite
passes critical 3/3, advisory 2/2, adversarial 4/4; the production Next.js build and
`git diff --check` PASS.

**PM:** F-014 moved to `in progress` at PM commit `382a98f`, with implementation state recorded at
`4991333` and the connection-pool decision at `a77bda6`.

## 2026-07-25 — F-022 clean launch schema and initial migration

Starting from clean `main` at `3d89380` (merged PR #16), the database foundation was replaced
test-first without implementing F-012 through F-019. The first integration run was observed failing
because there was no committed migration, the schema still declared forbidden launch concepts, and
`DATABASE_URL` was absent. The implementation then:

- replaced the speculative schema with contacts, one-level administrator authorization, farms,
  farmer authorization, separate VIGA approval, public farm facts, actionable sales locations,
  farmer links, payment / Farm Bucks facts, immutable published inventory, minimized SMS state,
  launch consent, inventory-publication proposals, private stock-out reports, flags, outbox work,
  dispatch attempts, audit events, and model-run evidence;
- stored normalized raw E.164 once on `contacts` and used the unique phone hash for every workflow,
  queue, evidence, and foreign-key path;
- separated exact / approximate / hidden farm fallback projections from farm-stand and VIGA Farmers
  Market sales locations, with inventory and reports bound only to sales locations;
- added foreign keys, bounded checks, coherent-state checks, partial unique indexes, and explicit
  PostgreSQL guards for fallback projections and immutable published inventory history;
- generated `0000_clean_launch.sql` with its Drizzle journal/snapshot metadata, adding
  explicit SQL for constraints the pinned generator does not serialize;
- replaced the out-of-band / silently skipped integration assumption with a harness that requires
  `DATABASE_URL`, creates a uniquely named empty database, applies every migration, verifies a
  second journal run is a no-op, exercises the constraints, and drops the database; and
- kept initial VIGA content as reference input for a later validated seed utility rather than
  embedding data or compatibility state in the migration.

This tranche deliberately adds no repository transaction for sender claiming, consent ordering,
confirmation/publication, STOP-versus-dispatch ordering, delivery monotonicity, or retention. It
also adds no handler, provider, model seam, UI, campaign behavior, seed data, or deployment behavior
owned by F-012 through F-019.

**PM:** F-022 moved to `in progress` at PM commit `6cce6c7`, to `in review` at `004126c`, and
to archived `done` at `bd9ee4e` + `9fe9128`. Implementation commit `5507d68`, review-state commit
`461aa6e`, and merge `fc49e68` are recorded as key commits.

**Verified:** the original red integration run failed 3/3 as intended; the completed
real-Postgres suite passes 12/12 against an isolated PostgreSQL 16.12 cluster; `npm test` passes
46/46 across 10 files; typecheck and lint PASS; evals critical 3/3, advisory 2/2, adversarial 4/4;
the production Next.js build and `git diff --check` PASS.

**Release:** implementation commit `5507d68` and review-state commit `461aa6e` merged in
[PR #17](https://github.com/max-h-silverman/farm-friend/pull/17) at `fc49e68`. The feature branch
was removed. No deployment was performed or owed for this schema-only prelaunch tranche.

**Next:** select and separately authorize the next planned tranche. F-014 owns the authoritative
transaction behavior supported by this schema; F-012 through F-019 remain distinct owners and must
not be absorbed merely because their later workflows use these records.

## 2026-07-25 — F-021 four-package boundary reset

The first implementation tranche after the clean-room review reset the repository to the approved
package boundary. The architecture test was written and observed failing first: it reported
`apps/mobile`, wildcard/deferred workspaces, all five reversed `core` dependencies, and the
disallowed web dependency on `contracts`. The implementation then:

- deleted `apps/mobile`, `packages/config`, and `packages/contracts`;
- made the root workspace list explicit and limited it to `apps/web` plus `core`, `db`, `sms`, and
  `ai`;
- removed every deleted workspace reference from manifests, TypeScript project references,
  Next.js transpilation, ESLint configuration, and `package-lock.json`;
- made `core` independent of workspace adapters in both its manifest and source imports, with the
  architecture test enforcing the approved allowed-edge direction;
- moved the still-used stock-out report-source type beside its authoritative core workflow and
  moved the health response validator beside its HTTP handler;
- deleted the obsolete migration-provenance/claim-state shared types and migration-aware recency
  helper rather than relocating them; and
- retained the deterministic model/SMS test doubles and target-compatible pure helpers while
  deleting the throwing open-weight and Telnyx placeholders that could be mistaken for operational
  adapters.

The tranche deliberately did not alter the legacy database schema, add migrations or workflows,
change campaign/provider/deployment configuration, resolve deferred product decisions, or absorb
F-012 through F-019. The schema's obsolete tenancy/gleaning/provenance structures therefore remain
an explicit later-schema gap rather than being partially reshaped here.

**PM:** F-021 moved to `in progress` at PM commit `caa07f3` and to `in review` at `1d5d284`;
implementation commit `bb9bf96` is recorded as the key commit.

**Verified:** `npm test` 46/46 across 10 files; typecheck and lint PASS; evals critical 3/3,
advisory 2/2, adversarial 4/4; production Next.js build PASS; `git diff --check` PASS.
`npm run test:integration` ran with all 3 Postgres tests skipped because `DATABASE_URL` is unset;
this is not green Postgres proof.

**Release:** implementation commit `bb9bf96` is pushed on `f-021-package-boundary-reset`;
[PR #16](https://github.com/max-h-silverman/farm-friend/pull/16) is open. No deployment was
performed or owed.

**Next:** review and merge PR #16, then separately plan the clean launch schema/migration tranche
without absorbing F-012 through F-019 or resolving decisions without a real schema consumer.

## 2026-07-25 — Architecture review closed; F-021 planned

The four-part review-to-build gate was completed against the current repository, the stable
clean-room handoff, the independent audit, the executable tests/evals, and current PM ownership:

- **Executable-proof claims:** the SMS requirements banner and runbook typecheck language were
  already corrected. Remaining false cleanliness, structural-proof, stock-out-shape, and helper-eval
  language was consolidated into F-013 and F-015 rather than becoming a cleanup framework.
- **Doc/code drift:** acknowledged foundation drift remains implementation backlog. F-014 now owns
  the narrow last-mile raw-E.164 delivery boundary and fail-closed Telnyx verification
  configuration; F-012 and F-017 retain campaign and map drift. No catch-all refactor item was
  created.
- **Unresolved decisions:** none blocks the first package-boundary tranche. Inventory snapshot
  semantics, contact/reassignment behavior, public-location projections, UX parameters, retention
  values, and provider/campaign choices remain just-in-time decisions for their first real
  consumers.
- **Deletion/buildability:** no deleted capability needs restoration. The consumerless
  message-classification seam should be removed through F-015. Runtime SMS-origin geocoding,
  speculative packages/state, and generic future-program machinery stay deleted. The approved
  product and four-package baseline are settled enough to build.

The architecture review was explicitly closed and planning of the first build tranche was
authorized. F-021 now specifies a test-first package-boundary reset: delete `apps/mobile`,
`packages/config`, and `packages/contracts`; move only still-valid types to their owners; and make
`core` independent of workspace adapters. F-021 is planning-only until a separate implementation
request; no Farm Friend application code, schema, campaign/provider configuration, implementation
branch, or deployment changed during the review.

**PM:** proof-language scope was committed at `b0fbdd9`; the delivery boundary at `3826ff1`;
just-in-time inventory semantics at `ab9de7c`; and planned F-021 at `552418b`.

**Verified during closeout:** `npm test` 46/46 across 10 files; typecheck and lint PASS; evals
critical 3/3, advisory 2/2, adversarial 4/4. `npm run test:integration` completed with all 3
Postgres tests skipped because `DATABASE_URL` is unset; real-Postgres verification remains owed for
the later schema/workflow tranche.

**Release:** documentation-only closeout branch `docs/architecture-review-closeout`; no deployment
applies.

**Next:** after this closeout merges, start F-021 from clean `main` only when the fresh-session
request explicitly authorizes implementation. Do not absorb F-012–F-019 or begin the launch schema.

## 2026-07-25 — Keyword grammar and review-state ownership (F-012 / F-020)

Two follow-on contradictions from the independent audit were reviewed separately against the
approved one-program consent boundary and the repository's existing documentation roles.

- **Keyword grammar:** F-016 already removed the audit's reason for a command-plus-argument grammar.
  Launch uses one fixed whole-normalized-message matcher; bare `JOIN` / `START` affect the one
  launch program, and extra text cannot become a program argument. Remaining registered/public
  copy, Telnyx profile/autoresponse, parser-variant, `STOPALL`, FLAG, and obsolete `OUT` / `IGNORE`
  alignment remains F-012 work. No new grammar or PM item was added.
- **Design authority versus stale session state:** the audit's original claim that Phase 4 had not
  begun was obsolete, but mutable next-step and PM-status text inside the handoff had gone stale.
  F-020 keeps the clean-room handoff as the single stable design authority, `CLAUDE.md` as the sole
  repository-local live snapshot, PM as item-status authority, and this log as dated history. No
  second authority document or status registry was added.

The handoff now records both approved decisions and stable ownership without a mutable current-phase,
exact-next-step, or live-PM-status section. `CLAUDE.md` names the four-part review-to-build gate.
No application code, schema, package, dependency, provider configuration, external campaign copy,
or deployment changed.

**PM:** F-012 was corrected at `a254e7d`; F-020 was created at `db1d92f` and moved to in progress
on `f-020-review-state-consolidation` at `5afac6b`.

**Verified:** `npm test` 46/46 across 10 files; typecheck and lint PASS; evals critical 3/3,
advisory 2/2, adversarial 4/4. `npm run test:integration` completed with all 3 Postgres tests
skipped because `DATABASE_URL` is unset; a real-Postgres run remains owed.

**Release:** documentation-only branch `f-020-review-state-consolidation`; no deployment applies.

**Next:** in a fresh session, close the four remaining review-to-build gates exactly one finding or
decision at a time: executable-proof claims, doc/code drift, genuinely unresolved-decision triage,
then the deletion/buildability verdict and phase-transition approval.

## 2026-07-24 — Finding 5 and follow-on architecture decisions (F-017–F-019)

Ranked finding 5 and the next four contradictions from the independent audit were reviewed one at
a time against the clean-room contract and spiral-staircase constraint:

- **Proximity (F-017):** launch uses optional transient browser geolocation for deterministic
  approximate proximity to validated seeded public coordinates. Destination-only Google Maps
  links delegate origin resolution/routing. SMS does not resolve arbitrary origins and returns a
  code-rendered limitation plus public-map link. No runtime geocoder, map package, invented
  coordinate, customer-location record, routing engine, service, or package was added.
- **Recipe safety (F-018):** Phase 1 removes generated meal ideas, recipes, preparation/food-safety
  guidance, and runtime recipe-link retrieval. A recipe request may receive grounded ingredient
  availability plus a code-rendered scope statement. No moderation system, classifier, policy
  engine, recipe catalog, provider, service, or package was added.
- **Natural-language web inquiry (F-019):** Phase 1 inquiry is SMS-only. Public web remains a
  model-free map/listing/filter/proximity surface over the same authoritative facts. The QR
  stock-out form keeps the public model abuse/cost throttle; ordinary lookup is uncapped. No web
  chat, inquiry endpoint, session, conversation state, or transport framework was added.
- **Retrieval ordering (F-013 clarification):** deterministic routing precedes every model call;
  model interpretation precedes code retrieval; grounded model selection sees only the retrieved
  facts; code validates/renders/queues. Empty retrieval skips grounded selection. The correction
  was folded into F-013 rather than creating another item.
- **Inventory proposal lifecycle (F-014 clarification):** unconfirmed inventory is a distinct
  pending proposal payload. `YES` creates the immutable published revision; `NO` and expiry create
  none. Full-snapshot versus patch semantics remain separately unresolved. The clarification was
  folded into F-014 rather than creating another item.

The design authority and companion product/system/data/AI/runbook/index guidance were synchronized.
No application code, schema, package, dependency, provider configuration, external campaign copy,
or deployment changed.

**PM:** F-017 was added in `~/pm` at `cf74275`, F-018 at `7edfaf8`, and F-019 at `5785436`.
Retrieval ordering was added to F-013 at `0cdc70b`; the pending-proposal lifecycle was added to
F-014 at `1806f46`; and F-013/F-017 channel ownership was aligned at `97d6e39`. F-012 through
F-019 remain planned and require separate implementation authorization.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical 3/3 + advisory
2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped because
`DATABASE_URL` is unset; a real-Postgres run remains owed. No deploy is required for this
documentation/PM-only tranche.

**Released:** repository commit `e7182c1` was pushed in PR #13. No deployment applies to this
documentation/PM-only change.

**Next:** review the audit's "Keyword grammar" contradiction exactly one finding at a time.

## 2026-07-24 — Ranked finding 4 decision: one launch SMS program (F-016)

Ranked finding 4 was reviewed against the clean-room contract, data architecture, SMS compliance
requirements, current schema/parser/webhook, and the registered/public 10DLC source copy. The audit
correctly found three incompatible consent meanings, but the correction separates a wrong launch
specification from an optional unresolved product promise.

Launch VIGA Farm Friend is one registered operational SMS program. `JOIN`, `START`, and documented
farmer onboarding establish or restore its consent with provenance. Inventory prompts, publication
confirmations, customer inquiry replies, and stock-out alerts are applicable message categories
inside that program, not separately enrolled programs. Universal STOP remains global and retains the
approved provider-time ordering and dispatch boundary from finding 2.

The marginal passive customer follow-up was removed. A customer-initiated inquiry permits its
relevant direct response but creates no durable consent for later proactive notifications. Launch
therefore has no follow-up-interest state and no scoped `MUTE` command. Future programs require their
own disclosed enrollment only when approved and built; launch pre-creates no program discriminator,
future-program rows, command arguments, tables, states, packages, or UI.

The correction deliberately introduces no per-category launch consent, general program-enrollment
platform, policy engine, reply-window mechanism, second subscription flow, Kafka, event bus, event
sourcing, workflow engine, distributed lock, service, package, or provider. F-012 remains the owner
of registered `OUT`/`IGNORE`, `STOPALL`, and FLAG campaign-copy drift. No application code, schema,
package, dependency, provider configuration, public campaign source copy, or deployment changed.

**PM:** F-016 was created as `planned`, high-priority `compliance-trust` work (`292bd30` in
`~/pm`). F-013, F-014, F-015, and F-016 remain unauthorized for implementation.

**Released:** repository commit `1a41fb5` was pushed on `f-016-sms-consent-boundary`; PR #12 is open
against `main`. No deploy is required for this documentation-only tranche.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical 3/3 + advisory
2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped because
`DATABASE_URL` is unset; a real-Postgres run remains owed. `git diff --check` passed.

**Next:** after this documentation tranche merges, review ranked finding 5 — runtime geocoding
versus the launch proximity promise — exactly one finding at a time.

## 2026-07-24 — Ranked finding 3 decision: model privacy boundary and proof (F-015)

Ranked finding 3 was reviewed against the approved clean-room contract and the actual assembler,
provider, redaction, and eval boundaries. The claimed "three-layer code-enforced safety boundary"
was incorrect: branded types provide a static provenance barrier, runtime projection/validation/
rendering provides enforcement, and tests/evals verify those barriers but cannot block an unsafe
production value.

The marginal promise was narrowed from "runtime scanning proves arbitrary content clean" to named
structural privacy guarantees. Each model seam receives one explicit minimal projection containing
only the current actor's task text where needed, required public facts, and opaque identifiers. The
low-level provider call is internal and has no database, repository, arbitrary-record, or
provider-managed conversation capability. Farm Friend does not claim a general detector for every
email, address, secret, or sensitive phrase a sender voluntarily includes.

Model-authored prose may return only to the actor whose current task text supplied its private
context. Cross-actor messages are code-rendered from permitted typed facts and do not relay customer
free text. The outbound phone refusal remains a named fail-closed backstop rather than proof that
every private value has been detected.

The single configured model provider must not train on Farm Friend request/response data; calls are
stateless; request/response logging is disabled where supported; and unavoidable provider retention
has an approved documented maximum compatible with Farm Friend's raw-context retention. A
model-version change under the same approved data-handling contract remains config plus evals, while
a provider or provider-data-handling change re-runs that privacy gate.

The correction deliberately introduces no general DLP, taint tracking, universal email/address
detector, Kafka, event bus, event sourcing, workflow engine, distributed lock, service, package, or
additional provider. It was synchronized across the clean-room handoff, AI/system/data architecture,
runbook, docs index, and `CLAUDE.md`. No application code, schema, package, dependency, provider
configuration, or deployment changed.

**Released:** repository commit `572ca43` was pushed on `f-015-model-safety-boundary`; PR #11 is
open against `main`. No deploy is required for this documentation-only tranche.

**PM:** F-015 was created as `planned`, high-priority `compliance-trust` work (`5e2c43d` in
`~/pm`). F-013 and F-014 remain planned; none of the three is authorized for implementation.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical 3/3 + advisory
2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped because
`DATABASE_URL` is unset; a real-Postgres run remains owed. `git diff --check` passed before the
session-log update and is re-run at handoff. No deploy is required for this documentation/PM-only
tranche.

**Next:** after this documentation tranche merges, review ranked finding 4 — the conflicting
consent meanings — exactly one finding at a time. Do not implement F-013, F-014, or F-015 or change
application code/schema before separate authorization.

## 2026-07-24 — Ranked finding 2 decision: concurrent and out-of-order SMS (F-014)

Ranked finding 2 was reviewed against the approved clean-room contract rather than treating the
independent audit as design authority. Narrowing the marginal promise removes the separate
stock-out `OUT`/`IGNORE` commitment: a code-bound web/QR stock-out report asks the farmer for
current inventory, then uses the ordinary inventory proposal and YES/NO publication path. That
preserves the north star while avoiding a second concurrent confirmation grammar.

The remaining launch invariants need a small Postgres mechanism inside the existing Next.js app:

- verify Telnyx against the raw request bytes, then transactionally insert a minimized inbox row
  keyed by provider event ID before acknowledging;
- serialize ordinary stateful work per sender with a short row lock/claim, order it by
  `(occurred_at, provider_event_id)`, and prevent stale events or stale model results from mutating
  newer state;
- keep a separate STOP/START consent watermark where later provider time wins and STOP wins an
  exact-timestamp tie;
- allow one live inventory-publication confirmation per sender, with its version, allowed YES/NO
  replies, expiry, and provider-accepted prompt activation recorded durably;
- perform model and Telnyx calls outside database transactions, then re-lock and revalidate before
  applying results;
- make the outbox dispatch claim the STOP linearization boundary, use bounded retry only for
  definitive retryable failures, and do not automatically resend after an ambiguous provider
  result without verified Telnyx idempotency support.

The correction deliberately introduces no Kafka, event bus, event sourcing, workflow engine,
distributed lock, service, package, general conversation replay, or exactly-once carrier claim.
It uses only the existing application boundary, Postgres transactions/rows/locks, Telnyx, and the
one approved model provider. The registered public campaign files still advertise `OUT`/`IGNORE`;
that external-copy drift remains F-012 rather than being silently changed in an architecture
decision.

The approved decision was synchronized across the clean-room handoff, product brief,
`ARCHITECTURE.md`, `DATA_ARCHITECTURE.md`, `SMS_COMPLIANCE.md`, admin operations, runbook, and
`CLAUDE.md`. No application code, schema, package, provider configuration, or deployment changed.
F-014 was created as planned, high-priority `compliance-trust` work (`19e0203` in `~/pm`); F-013
also remains planned and neither item is authorized for implementation.

**Verified during wrap:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical
3/3 + advisory 2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped
because `DATABASE_URL` is unset; a real-Postgres run remains owed. No deploy is required for this
documentation/PM-only tranche.

**Next:** after this documentation tranche merges, review ranked finding 3 — whether the claimed
three-layer safety boundary actually has three enforcement layers — exactly one finding at a time.
Do not implement F-013 or F-014 or change application code/schema before separate authorization.

## 2026-07-24 — Independent architecture audit + ranked finding 1 decision (F-013)

PR #8 merged the F-011 clean-room baseline reset to `main` (`565187c`). The follow-on independent
audit is preserved in
[ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md](ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md) and indexed
from the docs README as **review input, not design authority**. Its spiral-staircase constraint is
now the review rule: first narrow a marginal promise where that preserves the north star; otherwise
add only the smallest mechanism that closes a named launch invariant inside the existing
Next.js/Postgres/four-package system.

**Ranked finding 1 was approved.** The prior specification simultaneously allowed arbitrary
model-composed prose and claimed code could deterministically verify every factual claim; schema
validation and evidence IDs cannot provide that guarantee. It also let a model-parsed stock-out
location indirectly choose which farmer received an alert while claiming recipient selection was
code-owned.

The settled correction keeps natural-language understanding but narrows the consequential outputs:

- inquiry retrieval returns typed authoritative facts with stable identifiers and `asOf` values;
- the model interprets the request and selects/orders only identifiers from that retrieved set;
- code checks retrieved-set membership, dereferences authoritative values, and renders names,
  inventory, recency, stale warnings, and supported deterministic distance/comparison facts;
- unrestricted model prose is not treated as deterministically verifiable, and unsupported
  likelihood language such as "more likely" is not a launch promise;
- only a web/QR report with a code-bound sales-location identifier can queue a farmer stock-out
  alert; free-text SMS may return the reporting link but cannot select a location or recipient;
- code resolves the authorized farmer from the bound location.

This deliberately adds no natural-language claim verifier, extensible query platform, fixed
semantic strategy catalog, policy engine, package, service, event bus, workflow engine, vector
database, or model provider. The decision was synchronized across the clean-room handoff,
`PRODUCT_BRIEF.md`, `ARCHITECTURE.md`, `DATA_ARCHITECTURE.md`, `AI_ARCHITECTURE.md`, and
`CLAUDE.md`. No application code or schema changed.

**PM:** F-013 was created as `planned`, high-priority `compliance-trust` work (`6334373` in
`~/pm`). After confirming PR #8 had merged, F-011 was marked done and archived (`c5be625`).
F-012 remains the separate planned 10DLC-copy launch gate.

**Verified during wrap:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical
3/3 + advisory 2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped
because `DATABASE_URL` is unset; a real-Postgres run remains owed. No deploy is required for this
documentation/PM-only tranche. The branch is pushed for a user-managed follow-on PR/merge.

**Next:** in a fresh session, review ranked finding 2 — SMS concurrency and out-of-order events —
exactly one finding at a time. Do not implement F-013 or change code/schema until separately
authorized.

## 2026-07-24 — Clean-room baseline reset: F-011 (original review-sequence finding 1)

Branch `f-011-baseline-reset`. First finding of the original Phase 4 review sequence defined by
[CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md), which is
now **tracked in the repo and is the design authority** — previously it existed only as an
untracked working-tree file.

**Why this was finding 1.** The declared baseline (seven architecture docs, `CLAUDE.md`, PM
`product.md`) asserted as settled fact a product the clean-room contract had replaced. Because
`CLAUDE.md` auto-loads into every agent's context and instructs agents to treat those docs as
source of truth, the stale baseline was actively *manufacturing* the work later findings exist to
delete: any session starting cold would have built tenancy scoping, two-axis migration provenance,
and gleaning tables. It also made every later finding's acceptance criteria unverifiable, since
"correct" was defined by documents that were wrong.

Deleted from the declared baseline: gleaning/volunteer scope and its "tables in the spine" pledge,
tenancy, the two-axis migration provenance model and claim states, `config`/`contracts` packages,
Expo, multi-level staff roles, and the permanent `MapProvider` seam (geocoding is now a one-time
seeding concern, and the coordinate-inventing stub is gone). Declared instead: the four-package
baseline (`core`/`db`/`sms`/`ai` + `apps/web`), the `core → no other package` dependency rule, the
single composition root, and one authoritative use case + durable path per workflow.

**Two judgment calls worth recording.** First, the old docs enumerated a closed inquiry-ranking
strategy set (`proximity | freshness | coverage | any`) — precisely the "fixed semantic strategy
catalog" the contract forbids. Restated as an **open interpretation the model proposes and code
validates and executes**, which resolves a contradiction in the contract's own terms rather than
transcribing it. Second, unproven guarantees were **demoted to requirements**: every architecture
doc now opens with a status note naming its own gaps, because the Phase 3 audit found documented
safety claims that executable code does not enforce.

`SESSION_LOG.md` was left unchanged (history may record superseded decisions) and is now labeled as
such in the docs index. `SMS_COMPLIANCE.md` got narrow edits only — gleaning removed, scoped `MUTE`
added, `FLAG` marked a product safety feature rather than a carrier-mandated keyword, and
speculative-schema identifiers (`subscriptions`, `people.phone`, the removed activation flow)
replaced with durable-record language.

**Review found two defects.** The commit was amended (`6765e29` → `b292bc7`) to fix the stale
schema names, which the first pass had filtered for gleaning but not for schema references. The
second was filed as **F-012** rather than fixed: the registered 10DLC campaign copy still presents
`FLAG` as a supported keyword and documents `MUTE` nowhere, so F-011 wrote the "FLAG is not
carrier-mandated" rule and left the live violation one file away. Correcting a submitted carrier
campaign is a real decision with an external dependency and is a listed unresolved launch decision
— it is a hard SMS-compliance gate before public SMS, but blocks none of the intervening
architectural findings.

**Scope held:** docs + `CLAUDE.md` only; no file under `apps/`, `packages/`, or any schema path was
touched. Excluding the added handoff, the rewrite was ~956 insertions against 812 deletions — a
reset, not an expansion.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical 3/3 + advisory
2/2 + adversarial 4/4 — unchanged from baseline, as expected for a docs-only change. These checks
prove isolated helpers and structural claims, **not** launch workflows. `DATABASE_URL` remains
unset, so the 3 Postgres integration tests still skip; a real-Postgres run remains owed.

## 2026-07-13 — VIGA 10DLC copy + outbound SMS segment cost controls (PR #7)

Branch `fix/telnyx-sms-costs`; PR #7 is open against `main`. Added paste-ready Squarespace,
privacy/terms, and Telnyx campaign-field copy for **VIGA Farm Friend** (`752e85d`). It describes
only the current farm-stand MVP, uses the live VIGA-hosted opt-in/privacy paths, and omits the
rejected future volunteer/gleaning campaign. Telnyx's keyword field rejects spaces, so the final
opt-out list uses `STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT` and does not include `STOP ALL`.

Implemented provider-independent SMS cost controls (`e88c705`). `packages/sms` now estimates
GSM-7 vs. UCS-2 and billable segments (including two-septet GSM extension characters), normalizes
only unambiguous typographic variants at the mandatory `redactOutbound` boundary, and preserves
meaningful Unicode such as names, addresses, accents, and emoji. Outbound metrics contain only the
recipient hash, encoding, character/encoding-unit counts, and segments — never body text or raw
phones. `assembleSmsContext` adds a one-GSM-segment preference for coordinator replies while
explicitly forbidding destructive truncation. A 101-character smart-punctuation sample falls from
2 UCS-2 segments to 1 GSM-7 segment after normalization.

The repository does **not** yet contain a live Telnyx send: `TelnyxTransport.send` remains the
intentional Phase 0 throwing stub. PM F-010 was added (`~/pm` commit `1f6b87a`) as a high-priority
launch dependency; this session completed its provider-independent cost controls, while production
send, outbound-only raw phone lookup, post-acceptance metric emission, and adapter tests remain
open. No deploy is required for this library/documentation change.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS, `git diff --check` PASS;
evals critical 3/3 + advisory 2/2 + adversarial 4/4. `npm run test:integration` completed with all
3 tests skipped because `DATABASE_URL` is not configured; a real-Postgres run remains owed.

## 2026-07-05 — Architecture and SMS follow-up cleanup merged (PRs #5 + #6)

Closed architecture, schema, and deterministic SMS-parser contradictions after Phase 0. Activation
became staff-initiated manual onboarding for roughly 35 stands: staff record farmer identity and
SMS consent provenance, then trigger one pre-seeded confirm-or-revise message; the prior claim-link
and form-submit automation was deleted. `people.phone` became the one normalized raw-phone column,
read only by outbound sending, while `phone_hash` remained the lookup/log key.

Pruned overlapping schema state (`farms.status`, snapshot `hidden`, and
`expected_fresh_until`); `farm_stands.visibility` is the single hide switch. Activation `YES`
writes a new `farmer_confirmed` snapshot rather than mutating provenance. Set provisional raw-body
retention (30 days plus flagged-thread exemption), per-consumer commitment expiry (48 hours for
publish/stock-out, 14 days for activation), whole-message token matching with fixed YES/NO
variants, `JOIN <program>`, and stand-resolution-before-alert for SMS stock-out reports.

**Verified before merge:** `npm test` 39/39 (9 files), typecheck PASS, lint PASS; evals critical
3/3 + advisory 2/2 + adversarial 4/4. Integration remained DB-gated.

## 2026-07-04 — Phase 0 built (F-006a + F-006b + F-006c), verified, not committed

Branch `feature/f-006-platform-spine` (off `main` = `3f76949`, the archived scaffold; the working
tree was the intentional clean-slate wipe). Built the full Phase-0 spine test-first, per the
approved plan (`we-re-building-farm-friend-generic-clock.md`). **Not committed** — the user
directed no commit/push/deploy without explicit go-ahead.

**PM restructure first (via `/pm`).** Split the oversized F-006 three ways (F-006a docs, F-006b
spine, F-006c auth+evals); added F-007a/b, F-008, F-009; reframed F-002 (publish, two-axis
provenance), F-003 (open-intent inquiry), F-005 (console consolidation, with flag review pulled
out to F-009 as a hard pre-launch gate). Dependency order encoded via table position + "Depends
on" notes. Reconciled `product.md` (coordinator framing, `contracts` package, two-axis migration
model, code-enforced-safety golden rule). ID strategy: kept existing IDs, rewrote in place. F-006
retained as a `wont-fix` stub recording the split.

**F-006a — docs + CLAUDE.md.** CLAUDE.md in Nudgenik house style; the `docs/` set reading in order
via `docs/README.md`. Key decisions captured: the **two-axis migration model** (lifecycle `status`
= shown-on-map vs. provenance = honesty-about-age; migrated shows as `current` but is labeled
honestly, never "confirmed today"), the **sharpened type-safety claim** (branded types make it a
*compile error to bypass* the assembler/redactor — provenance, not content; the runtime scan +
adversarial evals prove content), the **`ai_runs` MAY-store list**, and the **abuse/cost throttle
seam** location (decided in ARCHITECTURE, built in F-003/F-008).

**F-006b — spine.** npm-workspace monorepo (`core`, `db`, `sms`, `ai`, `config`, `contracts`) +
web/mobile shells + 5 scripts. Tenant-scoped Drizzle schema with the restored columns
(`farm_stands.claim_status/migrated_at/migrated_source/visibility/lat/lng`, `farms.status`,
`inventory_snapshots.status+provenance+confirmed_by_person_id`), nullable-FK+text stock-out shape,
gleaning tables (designed, unused), `ai_runs` (no model input). Provider seams: `SmsTransport`
(+simulator +Telnyx stub +**outbound redaction guard**), `LLMProvider` (+stub +openweight
+**`ModelSafeContext` assembler** +validate-and-repair), `Clock`, `MapProvider` (+**offline
stub**). The **branded type-level safety boundary** — `ModelSafeContext`/`RedactedOutbound` whose
only public constructor is the assembler/redactor; a deliberate bypass fails `tsc`, **proven
non-vacuous** (removing a `@ts-expect-error` makes `tsc` fail: "string not assignable to
RedactedOutbound"). The **generic commitment state machine** designed against two consumers
(publish/activation + gleaning): context-bound, exactly-once, expiring. First unit tests cover all
eight named invariants.

**F-006c — auth + evals.** Magic-link auth (issue/verify, HMAC signature + expiry code-enforced),
a server-side `requireRole` helper (admin⇒staff implication + tenant match) used by routes, plus a
web callback route and a role-guarded admin route. The eval harness (`evals/run.ts`, run via
`tsx`) with critical/advisory groups and the **adversarial group** that proves — by exercising the
*real* assembler + commitment machine — that an injected SMS can't smuggle a phone into context or
force a commit. **Proven non-vacuous**: neutering the assembler's phone scan fails the adversarial
group and exits non-zero.

**Notable engineering decisions.**
- Relative imports are **extensionless** (`moduleResolution: "Bundler"`, source-first workspace
  consumption) so both `tsc -b` and Next's webpack resolve them; Next couldn't resolve `.js`
  specifiers pointing at `.ts` source.
- React pinned to `18.2.0` across web + mobile to satisfy React Native 0.74's exact peer.
- Integration suite is `DATABASE_URL`-gated (skips cleanly) so `npm test` stays hermetic and
  CI-without-a-DB doesn't fail; it runs against local/Neon Postgres when the URL is set.

**Verified this session:** `npm run typecheck` PASS, `npm run lint` PASS, `npm test` **38 passed
(9 files)**, `npm run test:integration` 3 skipped (DB-gated), `npm run evals` critical 3/3 +
advisory 2/2 + adversarial 4/4. `apps/web` builds and live-served `/api/health` (200), the Telnyx
webhook (deterministic routing through core — `STOP`→global compliance, free-text→`none`), the
magic-link callback (bad token→401), and the guarded admin route (unauth→403). `apps/mobile`
type-checks.

**Owed / next:** commit + PR when the user gives the go-ahead. Run the integration suite against a
real Postgres to exercise the schema + seed. Then the launch set: F-007a → F-007b → F-002 → F-008
→ F-003 → F-009.
