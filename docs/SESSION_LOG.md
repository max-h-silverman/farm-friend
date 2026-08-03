# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps the **newest eight entries**; everything older rotates into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 43. A log too large to open
mid-session defeats its own purpose.

---

## 2026-08-02 — complete interactive map listing details, marker mapping, and order deployed

F-058 (`71cc48f`, PR #72) completes the public map tranche. The map now carries sanitized source
listing prose, hours, stocking notes, updates, and public web/social links into the detail view;
direct email addresses and phone numbers are removed. The default directory is ascending by stable
stand number, while explicit distance sorting remains unchanged. The legend and marker rendering now
use visitability, destination type, season, approved usual offerings, and reviewed Farm Bucks facts.
The requested sticky-map behavior was explicitly withdrawn and was not changed. Contact-only farms
remain list entries without pins because they have no customer-visitable coordinate.

The null-only backfill applied 34 descriptions and 24 reviewed payment facts with 0 unmatched source
entries; a dry-run rerun found 0 remaining changes. Production checks found 0 direct emails or phone
numbers in descriptions, Peak Moon's details and payment fact in the live API, and the expected
farmers-market, seasonal, year-round, and flower-only marker classifications. Handpicked Homestead
is intentionally unpublished and is the one database row outside the 34-stand public response.

Verification: 93 unit-test files / 894 tests, 41 real-Postgres integration-test files / 564 tests,
typecheck, lint, production web build, and 44/44 scripted eval cases. Cloud Build
`619b58f4-a6de-42b2-b8d4-f51b80f3266e` produced digest
`sha256:7babc9efb9848b176bfd7043727ac1020b7ee4a63cd07795abeb29e2db682f69`. OpenTofu passed 37/37
assertions and applied 0 adds, 2 service updates, and 0 destroys. Live revisions are
`farm-friend-web-00021-ft8` and `farm-friend-worker-00022-jfx`; deployment, secret-freshness,
served-card, and public-API checks passed. No migration was owed: production already held all 17.

## 2026-08-02 — farmer SMS handling and final map polish deployed

The remaining uncommitted work from the parallel session was included in `81412d7`, then the final
map name-wrap alignment and farmer-SMS architecture documentation landed in `53ea6fb`. The release
includes authorized farmer free-text classification before exact stand targeting, routing to
inventory update, farm-stand question, or code-rendered clarification; VIGA-style colored and
flower markers; selected-marker halos and final label layering; wide-screen sticky map behavior;
and top-aligned stand numbers when a name wraps.

Verification: 92 unit-test files / 883 tests, 41 real-Postgres integration-test files / 563 tests,
typecheck, lint, production web build, and focused map tests 74/74. Cloud Build
`479ac6d3-9d2a-4cf8-84b5-505171b06c9e` published digest
`sha256:9b557833f5135912bf2a3d4d90e88aa0fcbc07abcbccc5f8630309a9539f717b`. OpenTofu passed 37/37
plan assertions and applied 0 adds, 2 service updates, and 0 destroys. Production is live at web
revision `farm-friend-web-00020-rz7` and worker revision `farm-friend-worker-00021-spx`; deployment
assertions, served vCard checks, and the canonical map HTTP 200 check passed. No migration was owed:
production already held all 17 committed migrations.

## 2026-08-02 — parallel admin changes and the VIGA-poster map refinements merged and deployed

The parallel session's uncommitted work was carried into `71bafa7` and merged to `main` in
`2a6eba1`. It includes farmer invitations and unbound-farm onboarding, the guarded administrator
Farm Bucks status write path, and the public map refinement requested against VIGA's poster: the
legend sits above the stand list, cards show only their indicator dots in a dedicated column, card
text stays left-aligned, and tapping the selected card or marker collapses it again. The map assets
were included; generated `.idea/` metadata was ignored.

Verification before release: 91 unit-test files / 874 tests, 41 real-Postgres integration-test files
/ 561 tests against disposable databases, typecheck, lint, production web build, and the focused
map suite's 4/4 tests passed. Production already had all 17 committed migrations, so no migration
was applied. Cloud Build `bc444893-2f59-4a9a-aaaa-31d30b2a5c16` published digest
`sha256:a3d63ff627e6e7e74b7a05f04dcd30c97b827ce235515fbefaaea55eed7d1491`. OpenTofu passed 37/37
plan assertions and applied two service updates with no adds or destroys. Web revision
`farm-friend-web-00019-lg9` and worker revision `farm-friend-worker-00020-ndb` are live on that
digest; secret-freshness, served-card byte, production migration-journal, and canonical public-map
route checks passed. The remaining live browser and physical-handset journeys stay open in
`CURRENT_STATE.md`.

## 2026-08-02 (latest) — one pre-go-live architecture shipped, with the dead alternatives removed

### Administrator interface polish — merged, not deployed

The signed-in administrator view now leads with four plain-language workflows: **Stands**,
**People**, **Needs attention**, and **Stock reports**. The old header is gone; navigation and
sign-out share one row, desktop content has a wider readable column, and the small color system uses
the VIGA palette without overwhelming the operational work. Farm approval and farmer-access actions
carry the yellow priority accent.

Stand cards now disclose with the browser's native control, so mouse, touch, keyboard, and no-script
use all follow the same reliable behavior. Their expanded view makes the timely information easiest
to find, then groups visit/listing, hours/season, and remaining facts into distinct sections. Copy
throughout the admin surface was shortened and softened without changing authority or safety
meaning.

Final local verification: 858 unit tests; 556 integration tests across 40 files against an isolated
disposable Postgres server; typecheck; lint; and the production web build. The build retains its
pre-existing Next configuration warnings about `outputFileTracingRoot` and the missing Next ESLint
plugin. No production system or data was touched. A final browser walkthrough of the refined view is
still owed; F-055 remains in review for its broader farmer and mobile proof.

Farm Friend's farmer-behavior tranche and final pre-go-live architecture are now in production at
`a7e1417`. The deployment carries F-049 closure/reopening, F-050 participant names, F-051 exact
multi-stand targeting and `STAND`/`SETTINGS`, F-052 scheduled prompts and `SAME`, and F-055's
completed farmer/admin web workflows. The database moved first to all 15 migrations, through
`1786300000000`; only then did web revision `farm-friend-web-00015-g76` and worker revision
`farm-friend-worker-00016-gt2` take the shared digest
`sha256:9dbf6e6d97e7a3e765bcf856a798eaeb9577054b58f8c0ab401b79b28ed633d9`.

### Pre-go-live meant one architecture, not compatibility machinery

B-031 removed the five access-bearing alternatives that had no launch consumer: nullable farmer
link targets, raw-hash enrollment, nonce-less admin sessions, administrator phone identity, and a
generic one-role facade. B-032 removed silent proposal/location defaults and proposal-owned schema
and YES/NO token fields. Populated forward-migration tests preserve real rows while leaving future
writes with one exact shape; decisive NULLs fail in Postgres rather than slipping through a CHECK.

B-033 then deleted the misleading surfaces left around that final schema: five unused admin queue
GET handlers beside the server-rendered pages, provider label and duplicate schema-name fields,
optional output instructions that every real projection already supplied, and the runnable phone
rehash path that contradicted the never-rotate salt rule. Only the flag-thread GET remains because
the browser actually consumes it. Historical migrations and dated records remain evidence, never a
second callable architecture.

### The absence tests had to prove they could fail

The new tripwires strip comments/imports and anchor to executable exports and call sites. Sabotage
made all five deleted GETs, the surviving browser fetch, each AI contract removal, and both phone
recovery guards fail for the claimed effect before restoration. Provider requests across all five
model projections were byte-identical before and after B-033 (SHA-256
`80d9dbc6da7ec487f70acd1c2842775b81372a170c3f047c78f3025eacf3b1b5`), so no paid live eval
was owed: the type surface shrank without changing a projection, schema, output contract, or model
message.

Final local verification passed 879 unit tests, 572 real-Postgres integration tests across 39
files, 44 scripted eval cases, typecheck, lint, production build, and true no-op Drizzle generation.
One integration pass hit the known cross-suite fixture deadlock at a `TRUNCATE`; with the change
stashed, the unchanged-base file passed 19/19, and the restored complete suite passed 572/572.

### Production is current; user-journey proof remains pre-go-live work

Live health, public, protected-admin, SMS, and removed-route checks passed after deployment. The
Cloud Tasks queue is `RUNNING` and the Cloud Scheduler job is `ENABLED`. What remains is product
exercise, not an owed release: run the complete farmer onboarding/status update, administrator,
farmer settings, customer inquiry, and farmer update journeys against production and verify durable
database effects. Mail-provider attestation, the Squarespace embed handshake, and physical-handset
vCard/paging checks remain separate open gates. `npm audit --omit=dev` also reports three
high-severity production dependency advisory groups in direct `drizzle-orm`, direct Next.js, and
transitive PostCSS; B-034 owns supported-line upgrades and application-reachability assessment,
with no observed exploit and some advisory reachability still unconfirmed. F-029 remains open only
for live carrier/JOIN launch verification; its migration and deploy legs are complete.

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
