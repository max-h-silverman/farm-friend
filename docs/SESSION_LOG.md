# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps the **newest eight entries**; everything older rotates into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 48. A log too large to open
mid-session defeats its own purpose.

---

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
