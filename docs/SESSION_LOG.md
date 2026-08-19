# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps recent entries; older entries rotate into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 100. A log too large to open
mid-session defeats its own purpose.

---

## 2026-08-19 (latest) — the classifier's variance turns out to be the two cases we already knew about

One tranche, `b-090-classifier-variance`. Unit **2,418 across 171 files** (7 corpus skips),
typecheck, lint, scripted evals 11/11 · 4/4 · 19/19. Integration not run — this session touches no
database or web code, and `DATABASE_URL`/`PUBLIC_BASE_URL` are not set locally.

**B-090 — measure before tuning, and the measurement said "don't tune".** Twenty `evals:live` runs
against `mistralai/Mistral-Small-24B-Instruct-2501`, each captured to its own file:
**20/20 green, zero FAIL, zero SKIP**, every required group 100% every run. Only two fixtures move,
and both move *only* on the two already-catalogued baseline cases — `"what is viga"` missed 4/20
(corpus 52–53 of 53), `"when do you open?"` missed 11/20 (second-person 4–5 of 5). Roughly 800
classifications, 15 misses, both known phrases, **no third case**. So the previous session's
standing caution overstated the problem: `ADVISORY_CLASSIFIER_CASES` needs no new entry, and the
threshold that entry anticipated is not needed — the corpus holds at the existing gate. That was the
product decision the item reserved for max, and the measurement retired it rather than forcing it.

**The 51/53 did not reproduce, and the 3/5 `live-operation` failure was almost certainly an outage.**
Worst of twenty runs was 52/53. More conclusively, 3/5 is *arithmetically unreachable* from these
misses: the advisory list absorbs both, so neither can drop that group below 5/5 no matter how the
model flaps. That run predates B-089's `couldNotRun` labelling — an unlabelled transport failure is
exactly what it would have looked like, and it explains why four immediate reruns could not
reproduce it. Filed as explanation, not proof; the original transcript was lost, which is the whole
reason this session captures every run.

**A passing fixture can still be moving — the gap that made the extra tool necessary.** The corpus
fixture gates on "no *non-baseline* regression", so 51/53 and 53/53 are both PASS. A pass/fail tally
across runs would therefore have reported both moving fixtures as perfectly stable and concluded
"no variance", which is precisely the wrong answer. `live-eval-variance.ts` reads each fixture's
*internal score* out of its observed line and reports score movement separately from pass/fail. The
score regexes are anchored to the start of the observed line on purpose: ratios also appear inside
quoted customer messages (`"is 2/3 of a pound ok"`) and JSON payloads, and an unanchored search
reads one of those as the score — sabotage-proved.

**Capture-before-parse is the load-bearing design choice.** `evals/variance.ts` writes each run's
transcript to its own file *before* anything is parsed, so a crash, a Ctrl-C, or a parse bug still
leaves the evidence on disk; an unparseable file is reported loudly by name rather than silently
shrinking the sample. Re-summarise any capture directory for free with
`npx tsx evals/variance.ts --summarise-only --out <dir>`. The 20 transcripts are committed under
`evals/captures/2026-08-19-b090/` as the evidence for the conclusion above.

Sabotage-proved (three, all caught): counting an outage as a miss; reporting an always-failing
fixture as merely flaky; and the unanchored score regex above.

---

## 2026-08-19 (earlier session) — the eval gate learns to tell an outage from a regression, and SMS stops answering strangers

Four tranches, merged as `session-2026-08-18-wrap`. Unit **2,399 across 170 files** (7 corpus
skips), integration **1,463 across 107 files**, typecheck, lint, scripted evals 11/11 · 4/4 · 19/19,
and **live evals 39/39 clean** — which also clears the run owed from B-086/B-087.

**B-089 — a red live-eval run now means the model got worse.** Two independent lies, both fixed by
giving the runner facts it lacked rather than by weakening a fixture. *Transport:* every seam
collapses `provider_error` into its ordinary failure outcome **on purpose** — a sender who could not
be understood is owed the same honest reply either way — so a DeepInfra 502 surfaced as ten fixtures
returning `{"kind":"unclear"}`, indistinguishable on screen from a quality regression.
`createTransportObserver` counts throws out of `generateJson` at the provider, the last place the
difference survives; a fixture whose call never landed is `couldNotRun`, neither pass nor fail, and
the run exits 2 saying "N fixtures could not run". A genuine failure always outranks an outage, so
an outage can never launder a real regression into "inconclusive"; a fixture that *passed* through a
dead provider still passes, because a barrier holding against no answer is what containment asserts.
Proved by effect against a real 502 through the real adapter.

*The flapping fixture was a **contradiction**, not model variance.* `"when do you open"` was graded
by two fixtures in the same required group — the top-level corpus scored it advisory (max relabelled
it 2026-08-13: in an SMS thread with the service, "you" reads as the service) while the second-person
fixture failed the run on it. Identical code therefore scored 4/5 or 5/5. `classifier-baseline.ts`
makes that one shared, tested list; the case is kept and still printed. Confirmed on a live run that
*missed* it: the corpus reported 51/53 "known baseline miss only" and passed, where the old code
would have gone red.

**Standing caution — SUPERSEDED by B-090 later the same day.** This entry recorded that the corpus
scored both 51/53 and 53/53 across ~10 uncaptured runs and concluded the model "flaps beyond the two
catalogued cases". Twenty captured runs showed otherwise: only the two catalogued cases ever miss,
and the 51/53 never reproduced. The instruction it gave was still the right one — *measure before
tuning* — and the measurement is what retired the caution. See the B-090 entry above.

**F-119 — the stand card is seller-major.** `standCardSellerGroups` replaces `standCardSections`
(deleted, with its CSS): the seller is a sub-heading carrying its own recency, its items bordered
cards in a responsive grid. Presentation over data the card already received. **The tradeoff is
deliberate:** seller-major cannot keep F-114's "each item appears once" — two sellers carrying eggs
means eggs appears under each, and each copy carries that seller's own price under that seller's own
freshness, which is the comparison the mockup exists to offer. B-088 holds and is decided **per
section**, not per stand; F-118 holds — the sub-heading is still a link. max re-attached the mockup,
which settled two things the transcription could not: the heading is **`Usually carries`**, and
price is never a bare `$4` (the corpus holds `$6/dozen`, `$5 a bunch`, `$1.50/lb`, `$180 half` and
one phone number; the local stand renders `$8/dozen` and `$4/lb`). Measured in a browser at real
356px and 386px: no horizontal overflow, grid reflows 3→1, a 34-character unbroken name stays inside
its card. Computed styles confirm the cards are surfaces, not the old pills — `.items li` (0,1,1)
beat a bare class once before, and only a running-page read sees that.

**F-120 — answer more of the question before answering it fresher.** `matchCount` is now
`rankCandidates`' first key. Measured live: "any stands have kale and eggs?" led with a stand
carrying eggs, putting the stand carrying **both** second, because its evidence was a few hours
fresher inside the same day. **Broad is deliberately exempt** — it selects the whole catalog as its
"requested names", so counting there would rank by listing size, a leaderboard answering a question
that named no item. No new query: `groupSelectableStands` already deduplicates matched items by
name. Every ordering fixture puts the higher-match-count stand at the **older** timestamp, so a
dropped key fails rather than passing by coincidence.

**F-121 — Farm Friend answers nothing substantive until the sender has agreed (max).** Began as
"what does a pre-joined customer who texts without JOIN get?" Measured first: they were answered
normally, because `inquiry_reply` rides on the sender's own inbound message and needs no consent
basis. max's call reversed that — consent comes before service. A sender with **no consent record**
gets one invitation naming `JOIN` *instead of* their answer; a sender who **opted out** gets nothing,
because inviting someone back who texted `STOP` is what `STOP` exists to end.

**The exemption list is the routing ORDER**, not a second list: the gate sits directly below the
compliance branch, so the carrier-registered keywords pass by construction. Two would dead-end a
journey if gated — `VIGA` completes farmer onboarding from a handset with no consent row yet (gated,
the farmer is told to reply `JOIN`, which can never complete onboarding), and every `STOP` synonym
must reach the opt-out writer. Everything else gates, **`MAP` included** (max named it): the map is a
service, not a control for joining or leaving. So MAP moved below both the staleness guard and the
gate and **lost its delayed-event exemption** — a stale MAP now fails closed. No model runs for a
sender who has not agreed, which is stricter than the routing order alone gave.

*Why intent-matching was rejected:* measured against the live model, "sign up", "signup",
"subscribe", "sign me up", "add me to the list" and "i want to join" all classify `unclear`, while
"how do i sign up" and "how do i get updates" classify `system_inquiry`. Wording-matching would have
missed half; the consent row cannot. *Two defects found in my own work, both by a test:* the gate
first sat **above** the staleness guard, so a stale event replied instead of failing closed; and
nothing caught a stopped sender being invited — sabotage showed that assertion sat in the MAP test,
which returns before reaching the invite branch. Existing suites got real fixtures rather than
adjusted expectations.

**Also measured, then dropped:** a branch proving a cold sender's answer actually *dispatches*
(`inquiry_reply` and `required_reply` are the only categories that send with no consent row). F-121
deliberately removed that behaviour, so the branch was deleted unmerged rather than landing a test
we knowingly invalidate — F-121 carries the equivalent guarantee for the invitation itself.

**Farmer consequence, accepted:** an authorized farmer with no consent row is gated out of `LINK`,
`STAND`, `SETTINGS` and publishing `YES` until they text one of the five keywords. Normal onboarding
establishes consent via `VIGA`, so the ordinary path is unaffected.

**Deployed** 2026-08-19 as **`farm-friend-web-00088-8cw` / `farm-friend-worker-00083-28n`**, digest
`sha256:bfbc1bc0…e4e4`, from `d9d0f6c`. Plan was 0 add / 2 change / 0 destroy — only the digest moved
— with 61/61 plan assertions, deploy assertions and served-card assertions all passing. F-119
confirmed in the shipped bundles (`items-cards`, `item-card-price`, `seller-block-heading` present;
`items-nested` and `item-sellers` gone).

**Owed:** no message has been read on a real handset — the F-121 invitation copy included — and the
F-119 card has not been seen on a phone. F-121 could not be exercised against production without
sending real texts, so it ships verified by integration only.

## 2026-08-18 — the queue ships, then five defects max found by using it

Five deploys in one day, from a standing start of twelve unapplied migrations. Ends with
`ac90972` serving as **`farm-friend-web-00087-vt6` / `farm-friend-worker-00082-j8q`**, digest
`sha256:79be6918…af79` — the last carrying only the heading rename, verified in the shipped bundle
(`Also selling here` present, `Who sells here` absent). Unit **2,367 across 167 files** (7 corpus skips), integration
**1,445 across 107 files**, typecheck, lint, scripted evals 11/11 · 4/4 · 19/19.
**Live evals owed** — DeepInfra returned `502 Bad Gateway` to every call during the wrap; max's
call was to ship and file it (B-089).

### The release: migrations 0042–0053, then the four merged tranches

Preflight was treated as live evidence, and it matched the record exactly: 42 applied migrations,
serving digest `14347f34…`, no `sellers`/`stand_providers`/`own_seller_id`. The one thing worth
measuring beforehand was `0042`'s riskiest claim — that every row can find a provider. Against the
real corpus: **zero unbackfillable rows across all seven tables** (250 stand items, 34 revisions,
19 proposals, 17 links, 15 preferences, 9 prompts, 0 menu options), no farm owning two stands, no
NULL `owner_farm_id`.

Applied on the direct Neon URL and verified BY EFFECT: ledger 42 → 54, `stand_providers`
backfilled to 38, all seven `provider_id` columns NOT NULL and fully attributed, `0051`'s partial
index carrying the exact predicate `hosting.ts`'s `ON CONFLICT` names, and **`0052`'s enum value
proved WRITABLE in a statement after the migration** — a clean apply proves nothing there.

**One correction to the record.** `inventory_publication_proposals.provider_id` is nullable in
production and that is *correct*: `0042` sets it NOT NULL and **`0046` deliberately relaxes it**
so a venue's closure-only proposal can name no provider, replacing it with the
`inventory_proposals_provider_arm` CHECK — probed live, it refuses `has_inventory` with no
provider, by name. A preflight assertion reading the bare nullability reports a false failure.
Integration was also re-measured at **1,441/1,441 across all 107 files**, not the recorded
1,435/106: the six failures were the missing `PUBLIC_BASE_URL` and nothing else.

### Five defects, all found by max using the deployed product

Each was measured against production before it was touched.

**B-083 — seller cards claimed closures no farmer had made.** `sellerIsOpenNow` reduced a
**seven-member** `OpenState` union to a boolean by testing `=== "open"`, so `unknown` and
`by_appointment` printed "Closed". Measured on the live payload: **9 of 34 seller cards** were
asserting a closure nobody declared. The stand list beside it already held the right rule
(`map-view.ts` §the open-now filter). Three states now — max's rule: *Closed is reserved for out
of season or outside defined hours* — and the closed set moved to `isDefinitelyShut`, read by both
readers, written as the set of things that ARE closed rather than "not open". **That polarity is
the bug**: a state a later author adds now defaults to unknown.

**B-084 — the admin card contradicted itself.** Lavender Hill showed "Not open — out of season"
above "Stand is open". Both were true: her season ended 8/1, her *arrangement* is active. Two
different facts in one vocabulary. The control now names only the arrangement.

**B-085 — Morgan Hill's four "also selling here" names vanished.** F-118 made the typed list a
fallback suppressed by *any* modelled seller, and `0042` then gave **every** stand a self-pointer,
making that condition true everywhere. One native row hid four names and replaced none, because a
self-pointer is never an item credit. The fallback now counts **guests** — which is what the rule's
own comment always meant. This also reversed B-084's over-correction: dropping the seller's name
from a solo row left "Who sells here" answered by a bare "Selling here".

**B-087 (critical) — nine stands invisible to a direct question.** `who has eggs?` returned **one**
stand while ten were listing eggs. Every component checked out in isolation — the model returned
`["eggs","duck eggs","chicken eggs"]`, retrieval returned all ten rows. The defect was between
them: the **catalog** is built from `listPublicStands`, which drops the items of any confirmation
past 28 days, while the answer is **filtered** from `retrieveSmsListings`, which applies no such
filter. A stand 29 days stale contributed no catalog value, and **the model cannot select a value
it was never shown** — unreachable by name, not merely ranked last. Catalog now built from the
same rows the answer is filtered from.

**B-086 — category matches presented as equals.** `who has kale?` returned eleven stands, one with
kale: the matcher had expanded up a generality ladder (kale → leafy greens → produce) and back
down its other rungs. **The expansion is correct and F-045 requires it**, so the fix is
presentational (max's call): exact matches first, the rest under `Other stands with <category>:`.
`sortMatchesByExactness` is pure code — no model, no taxonomy, category named from the matched
catalog values themselves.

**B-088 — two display facts repeated or shrunk away.** Per-item recency printed the section
heading's own phrase on every line (**33 of 37 public stands have one seller**); it now appears
only where the sellers on that item disagree — keyed on *agreement*, not seller count, because
three of the remaining four publish on the same day. And the map tooltip is a `foreignObject`, so
its font sizes are viewBox units: **"Runs this stand" measured 6.6px on a 390px phone**, text that
shrank as the screen did. It counter-scales now; raising the CSS numbers would have inflated
desktop by the factor it rescued the phone.

### The data work: hosted sellers resolved, one listing moved

`0042` left eleven typed participant names as display-only history and refused to link them,
because the corpus held `Fernhorn Bakery` at Pacific Crest and `Fern Horn Bakery` at Tian Tian —
one bakery, two spellings, and matching would either merge two stands' relationships or split one
bakery. **max resolved three** (`scripts/resolve-hosted-sellers.ts`): Fernhorn is ONE bakery with
TWO arrangements; Handpicked Homestead was *linked not created*, because she already existed with
a live authorization and her own description places her at Plum Forest; Gracie's Greens is new.
Two sellers and four arrangements written, verified by effect.

**Morgan Hill keeps its self-pointer, permanently.** `0042` called that seller "a row invented to
satisfy NOT NULL". Measured, it is not: VIGA's own description, 17 pooled items, a current
revision, a name byte-identical to the stand's, and four participant rows naming it through a
composite FK with `ON DELETE RESTRICT`. Clearing it would re-root history and orphan real data to
change nothing visible. **max's read is the right one: those four names are decorative, not
operational** — no handset, no seller rows, and 17 items ("vegetables", "duck eggs") no rule could
attribute. Promoting them would have created four identities nobody owns or can update.

**Handpicked Homestead's listing moved to Plum Forest**, where she actually sells. Inventory is
keyed to a `provider_id` — a seller *at a stand* — so there is no seller-only state to move to;
the real answer was that her own stand should not exist. Re-pointing the revisions is **refused by
the database** (`guard_inventory_revision_history` covers `provider_id` since `0042`), and rightly:
those records say she published at *her own stand* on 8/11 and 8/17. So it supersedes and
republishes, as her own update would. **Two constraints corrected the design mid-write**, each
rolling back cleanly: `source_keys_coherent` refused a `viga` revision carrying her approval, and
`scheduled_prompt_subjects_inventory_base_fk` refused moving a prompt already *sent* — that row
stays with the stand it happened at; her cadence preference is a setting and moved.

### Verified in production, not by exit status

After the final deploy, the real inquiry path was exercised against production data:
`who has eggs?` → **12 matching stands** (was 1), Provo Farms third on its two-day-old listing.
`who has kale?` → 6, led by the stands that have kale, with `Other stands with salad greens:`
separating the rest. No regressions: flowers 13, tomatoes 6, `who has durian?` still returns the
honest no-listing reply. Both label fixes were confirmed **in the shipped JS bundles** — the new
strings present, every old string absent.

### Late in the session: one rename, and next session's design filed

`Who sells here` became **`Also selling here`** on both the public stand card and the admin console
(max). On the public card that gives two sections one heading — the modelled-seller roster and the
typed-names fallback — which is safe because they are mutually exclusive by construction, and a
test now pins that they never both render. Tian Tian is the case that prompted it: a modelled guest
(Fernhorn Bakery) alongside the retained typed spelling `Fern Horn Bakery`, where only the roster
shows.

**F-119** files max's mockup for the next session: In stock and Usually sells become per-seller
groups of bordered item cards, each seller sub-heading carrying its own recency. It is presentation
over data the card already receives — `groupProviderItems` returns providers per item today, so
regrouping to seller-major is the work. **The mockup image itself was not preserved** — it arrived
through the conversation rather than as a file, so F-119 carries a written transcription and a note
to have max re-attach the original before building.

### What this session cost, and the standing lesson

Two defects (B-085, B-088's recency) were **caused by the previous tranche's own fixes**, and one
(B-085's bare row) by a fix made earlier the same day. The pattern: a rule written against a
corpus where its distinguishing case cannot occur. `alsoSellingHere`'s fallback was written before
every stand had a self-pointer; the per-item recency before anyone counted that 33 of 37 stands
have one seller. **Measure the rule against the real corpus before believing it** — the arithmetic
is minutes and it caught every one of these.

## 2026-08-18 — the map's two lists become one two-way view of stands and sellers

Branch `f-118-map-seller-architecture`, squash-merged as **`beeb386`** (PR #134). **Not deployed** —
it joins the three tranches already waiting on max's 2026-08-18 leave-it-undeployed call, and adds
no deploy obligation of its own: client-side only, no migration, no writer, no seam.
Unit **2,341 across 166 files** with the 7 corpus skips; typecheck and lint clean. No evals owed —
`packages/ai` and `evals/` untouched, checked rather than assumed. Integration not re-run: nothing
here touches a writer or a query, and the whole change is client-side over payloads both lists
already receive.

A design session (`/ui-design`), driven turn by turn by max looking at the running app.

### The architecture: one relationship, stated once

Stands and sellers are many-to-many, and before this the relationship was rendered **three times
in three shapes** — a sentence on the seller card, a name list on the stand card, and a `Set` of
ids built inline for the pin highlight. That is three places for one fact to drift, and the fact
is not decorative: it is what a customer follows to get from "who bakes the sourdough" to "which
pin do I drive to".

`apps/web/lib/stand-seller-graph.ts` now states it once and both lists read it. **No read change
was needed** — `PublicStandPayload.sellers[]` already carries `sellerId` and
`SellerListEntry.sellingAt[]` already carries `salesLocationId`, so the join is client-side over
data both lists already receive. What the module owns is what could be *wrong*: a link pointing at
a stand the map is not showing, a pin number invented rather than looked up, a seller's own stand
described as somebody else's.

### The redundancy that only showed up once both directions rendered

Adding a "who sells here" roster to the stand card made a latent problem visible: every seller was
named **twice** — once as an item credit ("Sourdough — Fernhorn Bakery") and once in the roster
below. The fix was not to pick one section but to notice that **the item credit is already where
the reader's eye is**, so it becomes the link. The roster now names only sellers *no item
credited* — someone at the stand who has published nothing, whom no credit can reach.

`alsoSellingHere` fell out of this as a third naming: it is `sales_location_participants`, which
DATA_RECORDS retires as display-only history — typed strings with no identity, so nothing to cross
to. It is now the fallback for a stand with **no modelled sellers at all**, which is the only case
it still answers anything.

### Two defects the source could not show, found by measuring the running page

Both are the failure mode CLAUDE.md names: *when what renders contradicts source that reads
correctly, stop reading source and measure.*

1. **The marker tooltip was clipping off the shore.** It is drawn in a `foreignObject` inside the
   SVG, and `.island` is `overflow: hidden`. Centring a 400-unit box on its pin ran off the edge —
   measured in a browser, a west-shore tooltip lost its whole left half, seller names included.
   Vashon is long and narrow, so that was **most pins, not an unlucky few**. `markerTipBox` clamps
   horizontally and flips below a pin near the north shore; every tooltip re-measured fully inside
   the island on all four edges.
2. **Every seller card's expanded body was indented past its own name.** `.stand-details` carries
   a 2.1rem left margin that aligns a *stand's* body under its name, clearing the pin number in
   the gutter. A seller card has no pin number — `.stand-head-no-pin` already reclaimed that
   column — so the same rule pushed her whole detail 34px right. Measured at 500px: heading at 47,
   body at 81. Now both 47, with the stand card's own indent verified untouched.

### Three revisions from max, all the same shape

Each was the seller list having grown *its own way* of saying something the stand list already
says one way:

- **"1 of 1 stand open"** made the reader do arithmetic to reach a yes. The question is "can I buy
  from her right now", which has two answers. The count still decides it — one open stand out of
  three is Open — but the card states the answer, not the working. A stand that stated **no hours
  is never counted open**: answering Open on a silent schedule states a claim no farmer made.
- **A chosen seller's stands wore a thin olive stroke** while a chosen stand wore the selection
  halo, so the same map said "you picked this" two different ways depending on which list was
  open. One mark now, both lists.
- **The seller card responded only to its heading**, where a stand card has always taken a tap
  anywhere on it — which on a phone reads as broken to anyone who tapped the obvious thing.

Also: the seller list's separate search box is gone. The two lists genuinely search different
corpora, but that is a fact about the *corpus* and not about the *question* — the customer asks
"what am I looking for" once, and two fields in one header leave them working out which one the
list below is listening to. The map's term now feeds both, each list keeping its own haystack rule.

### The last revision: stop taking the reader somewhere else

Tapping one of a seller's stands originally switched the list to View stands and opened the card
there. It answered the question and **threw the reader's place away** — they were reading about a
seller, and the surface they were reading vanished. The stand's detail now expands *inside* her
card. That retired `goToStand` entirely, and the asymmetry that remains is real and worth naming:
a stand card's seller name crosses to the seller list, while a seller card's stand rows stay put,
because a seller has no pin and no sheet and the map is a map of stands either way.

### The category chip max deferred, and why it is a real decision

The mockup carried a Produce / Baked Goods / Flowers / Misc chip. No seller column holds it, and
guessing it from item names would be a **second food-vocabulary branch** — `map-view.ts` records
exactly one allowed exception (`FLOWER_VOCABULARY`, deliberately bounded to display) and states
that *a second is the signal it should have been data*. Asked rather than guessed; max chose to
leave the chip off until there is a field behind it. If it is wanted, the honest home is a
category the seller picks at onboarding.

### Verification

Sabotage-verified throughout — **nineteen** deliberate breaks across the four passes, each caught
by the test that claimed to cover it (the off-map link, provider-vs-seller dedupe, pooled items,
both tooltip clamps, the halo, the card tap, the open rule, second-tap-closes, reset-on-close,
one-at-a-time, and more). The first pass was driven in a real browser against the local database
at ~500px: all four crossings work end to end on real data.

**Not verified in a browser:** passes two through four. max took that check himself and confirmed
it. No width below 500px was reachable — Chrome would not resize smaller. The item-credit crossing
has no local seed data (no guest seller has published items), so it rests on unit tests alone.

### `/sellers` pruned

Flagged rather than taken during the passes — deleting a documented public URL is a product call —
and max took it at the wrap. Nothing linked to the page once the toggle existed, and it had
drifted into rendering a weaker seller card than the map's own. `sellerSellingSummary` and
`joinNames` went with it as its only consumers; `filterSellers` stays, because the map uses it.

**The model-free tripwire caught the deletion**, which is the good outcome: it lists public entry
points and treats a missing file as a hard failure rather than a silent skip, so removing a page
without telling it turns the suite red. Its seller-read coverage moved to a **second entry for the
map's own page**, which now reads `listPublicSellers` itself — and that edit was sabotage-verified
(a model import into `seller-list.ts` still turns it red), because a tripwire you have just edited
is exactly the kind that quietly stops biting.

Final: **2,335 unit tests across 166 files** (down 6 with the retired summary tests), typecheck and
lint clean.

---

## 2026-08-18 — a UI pass over the admin cards and the public map, and a feature that had never once rendered

Branch `admin-card-design`, squash-merged as **`b14155f`** (PR #133). Unit **2,285 across 165
files** with the 7 corpus skips — re-run green on the merged base; typecheck,
lint and scripted evals clean (critical 11/11, advisory 4/4, adversarial 19/19). Integration was
not re-run — nothing this session touched a writer or a query. No live eval owed: `packages/ai`
and `evals/` are untouched, checked rather than assumed.

A design session, driven turn by turn by max looking at the running app. Worth recording because
three of the defects were **invisible to a green suite**, each in a different way.

### F-117's question had never once rendered

max noticed the onboarding form showed nothing about hosted selling. Every part of F-117 had
shipped and was tested — the picker, the API's `hostStandId`, the writer's provider row, and
`listHostStandChoices` — but **the onboarding page never called the query and never passed
`hostStandChoices`.** The prop defaults to `[]`, the component asks only when the list is
non-empty, so no seller could ever answer. Nothing failed anywhere.

The component suite supplied the prop itself. **That is precisely why 2,250 green tests proved
nothing about it**: a behavioural test cannot assert the absence of a *call*. The guard is
therefore a source tripwire, `apps/web/lib/onboarding-host-wiring.test.ts`, which strips imports
and comments first (a bare name search is satisfied by the import line) and **proves the search
can match before trusting an empty result**.

Only the invitation door asks the question: `grandfathered` and `stand_link` post to endpoints
that do not parse `hostStandId`, so asking there would discard the answer silently.

### The CSS lesson, learned twice in one session

max reported the filter bar had no more breathing room after I had reported it done. I had edited
the base `.filters` rule and verified it was *served* — but **two later media-query blocks
override it**, and one of them is what a desktop reader actually gets. My verification was real
and useless: I confirmed the declaration shipped without checking what won the cascade.

The same class of bug then produced the broken seller cards: `.stand` reserves grid column 1 for
the poster dots and `.stand-head` reserves its own for the pin number, so a seller card reusing
that markup laid her name out in a 1.65rem gutter, wrapping one word per line. Reusing a card's
markup is not reusing its layout.

**The standing form:** when what renders contradicts source that reads correctly, grep *every*
rule that touches the property and compare by position in the served file — not the one rule you
edited. Both fixes were verified that way, by byte offset in the compiled stylesheet.

### What changed

- **The admin stand card reads as a profile.** A lead block carries what is on the shelf and when
  it was confirmed — never a bare timestamp, because an undated inventory is a claim about the
  present an unattended stand cannot make. The rest are titled fact groups, two across. Dropped
  `emphasis: "primary"`, which said the same thing `prominent` did from the other end, and deleted
  ~250 lines of dead CSS: four stacked overrides of `.admin-stand-detail-*` with no consumer.
- **"Other details" is gone.** A drawer named for what it is not collects whatever nobody filed —
  Farm Bucks, which this card carries a verb for, was sitting in it. Now `VIGA's record`.
  "Other sellers here" dropped entirely: the card's own "Who sells here" group answers it, *with*
  the controls, so a read-only copy would disagree the moment someone paused.
- **An open Actions menu now outranks the cards below it.** Each card's actions cell was its own
  stacking context, so the menu's `z-index` competed only *inside* that cell; against sibling cards
  the contest was between cells, all tied at 1, and ties go to DOM order. Fixed by marking the open
  menu and raising both rungs. The Actions trigger also renders only on an OPEN card now.
- **The stand editor can be left without saving.** Save had no class at all (a browser-default
  button); it is now the console's primary, with Cancel beside it. Extended to the other two
  panels, which had the same dead end — Farm Bucks gets **Done**, not Cancel, because its select
  writes on change and offering to cancel would promise to undo a write that already happened.
- **VIGA's pause asks before it acts.** The whole row is the toggle, which makes it easily
  mistapped, and pausing takes a real seller's goods off the island's only guide. **Resume is not
  gated** — it puts something back, and a confirmation on a harmless act is chrome an operator
  learns to click past, which is how the one that matters stops being read. Where the toggle reads
  as the stand being open/closed, the question says "close this stand" rather than naming a
  different act from the one pressed.
- **F-117's form asks one question, four answers** (max): just my own stand · only at someone
  else's · both · a farm with no stand people can visit. The two columns underneath stay two
  columns; they were also two *questions*, and a farmer does not hold them separately. 72 existing
  tests answered the old question and were retargeted to the new labels.
- **The map's "Browse by seller" link became a View stands / View sellers toggle** on the list
  itself, so answering "who sells bread?" no longer leaves the map and loses the filters. A chosen
  seller **highlights the stands she sells at** — for a hosted-only seller those are somebody
  else's pins, the case pins could never express. Seller cards render in the stand card's own
  shape, carrying the same kinds of fact in the same slots but dateless: what is out *right now*
  belongs to the stand card, the one surface that can date it honestly.
- **`GEOCODING_API_KEY` lives only in Secret Manager.** The local `.env.local` key was IP-restricted
  and this machine was not on its allowlist, so Google answered `REQUEST_DENIED` — which
  `address-lookup.ts` correctly maps to `not_configured`. Measured both keys against the real API
  rather than inferred: production's works. `dev-setup.sh` now fetches it per run and never writes
  it to disk, the same way it already handled `ADMIN_PASSWORD_HASH`.

### Owed

**Nothing in this session has been seen rendered.** The browser extension was unavailable
throughout, so every visual change was verified as served markup and compiled CSS — including the
two that were *wrong* until max looked. The admin console and the map's new toggle and seller
cards are owed a look at any width. Contrast was measured, not eyeballed: the toggle is 4.82:1
both ways, clearing AA.

---

## 2026-08-17 — F-101's seller half, all of F-117, and a 500 that only running the app could find

Twelve commits on `f-101-seller-half` (`b40827a`…`b6985d9`). Unit **2,210** with the 7 corpus
skips; integration **1,435 passing across 106 of 107 files**; typecheck and lint clean. The six
integration failures are the **pre-existing** `PUBLIC_BASE_URL` isolation weakness in
`apps/web/lib/farmer-stand.integration.test.ts` — proved rather than assumed by checking out `main`
and reproducing the identical six there (1,403 passing). This branch adds 32 passing integration
tests and no failures.

### The premise correction that shaped the session

max opened by flagging that a stand/seller settings screen probably already existed, and he was
right. F-101's own notes claimed *"it does not exist today: `/farmer` holds onboarding and start
only"* — but `/stand/[token]/settings` has existed since F-051, and `LINK`/`SETTINGS` have parsed
deterministically and texted a permanent link since F-040. **One acceptance criterion was already
met when the item claimed it as owed work.** The seller half was therefore a new section on an
existing screen, not a new screen — which also matches the rule already in `onboarding-copy.ts`:
a farmer has exactly ONE edit page.

The same correction happened twice more, and both are worth remembering:

- **"Editable stand metadata" was half-built.** F-073 shipped a full listing editor for the stand's
  OWNER at `/stand/[token]/listing`. Only VIGA's half was missing. max chose to build it rather
  than close the criterion as met.
- **F-117 needed no migration for its arrangement.** I claimed `hostStandId` had to be held on the
  invitation until `START`, like `pendingStock` and `pendingPromptCadence`. max asked whether a
  hard constraint could be relaxed; the answer was that **there was no constraint** — those two
  wait because they need an AUTHORIZATION (a dated confirmation needs somebody to stand behind it,
  a reminder needs a recipient), and `stand_providers` needs only a `seller_id`, which exists the
  moment the invitation names her farm. The row goes in beside her own stand's, in one transaction.

### F-101's seller half

- **`PROVIDER_SELLER_ARM`** names the seller test once; `PROVIDER_AUTHORITY_ARMS` composes from it
  and `participationArm` uses it. The screen and the seam cannot come to disagree about who is the
  seller — the disagreement's shape would be a button that returns `not_authorized`.
- **`mayPause`** rides each listing from that arm. **Not the same question as `describesOwnStand`**:
  a hosted seller's own listing is not her stand, and pause is still hers. That row is where the two
  diverge and is asserted.
- **`handleFarmerParticipationPost`** + `/api/farmer/participation` — the second production caller
  of `setProviderParticipation` and the first meeting the authority asymmetry. The token is the
  actor; no authority is re-stated outside the seam.
- **`ListingParticipation`** on the settings screen: pause/resume, Remove behind an inline
  confirmation, no restore anywhere. Deliberately NOT the admin's `SellerParticipation`
  parameterised — different audiences, different authority shapes, and one file holding both
  would hold both sets of copy.
- **`saveStandMetadata`** — VIGA edits a stand's own facts. Deliberately not `saveOnboardingListing`
  with an admin arm: that writer replaces payment methods, usual offerings, the farmer's own
  description and her items, and Golden Rule #1 keeps VIGA's hand off her published words.
  `incomplete_location` gives the coherent-visitability constraint words so an operator clearing an
  address gets a next move rather than a 500.
- All six F-100 copy findings, plus the test-phone row defect: the route now returns the real id and
  the last four of the NORMALIZED number, so a number that normalizes differently no longer shows
  the typo's suffix under an id the server does not have.

### F-117, folded in on max's call

- **`approval_source = 'seller'`** (`0052`) — a third source, settled with max. The two that existed
  could not tell the truth about the row: `viga` would make a self-selected seller indistinguishable
  from one VIGA approved, in a flow whose premise is that VIGA never saw her; `host` names a
  vouching authorization that does not exist until the host answers, which is after she is live.
- **`listHostStandChoices`** — a name and an id, carrying the map's own `visibleFarms` rather than a
  restatement. **LEFT join to `sellers`**, so a VENUE like Morgan Hill (no seller of its own, and
  the strongest case for this flow) is included; an inner join dropped it silently with every other
  test green.
- **The onboarding question is its own question**, never a third `visitability` value: that column
  says whether THIS stand can be visited, and selling elsewhere is a fact about an arrangement.
- **`pending_host_confirmations`** (`0053`) and the thread-bound answer. Answerable only while the
  question is the last message in the thread — anything the host texted us, or anything we sent
  them, closes it. Golden Rule #2 met by conversation state rather than a clock. **The system-sent
  half is the one a weaker implementation forgets** and is sabotage-proved separately.

### The defect only running the app could find

Every farmer web screen — `/stand/[token]`, its settings, its listing editor — returned **500** in
`next dev`: `UnhandledSchemeError: Reading from "node:crypto"`. Two client components imported
`creditSeller` from the `@farm-friend/core` **barrel**, which re-exports `privacy/phone.ts`.
`@farm-friend/core/seller-credit` is already an exported subpath and the module is pure — it exists
for exactly this. **Pre-existing on `main`**, confirmed by checking out `main` and reproducing.

No suite caught it because jsdom resolves the barrel fine. It is the §the local runtime is not the
deployed runtime gotcha in a new costume, and the only thing that surfaced it was launching the app.

### Verified by running it, not only by tests

Against local Postgres with `0052`/`0053` applied (verified by effect — table present, `seller` in
the enum) and the app on `next dev`:

- F-117 end to end: picker → self-selection → live arrangement (`approval_source = seller`) → the
  host's real GSM-7 text → `NO` ends it → a second answer finds nothing.
- F-101 authority: seller pauses and resumes; **host refused pause, permitted end**.
- The adapting label: a solo farmer reads *"Close my stand for now"*, a multi-listing farmer reads
  *"Pause this listing"*.
- The settings screen serves 200 with the section, pause and Remove; the confirmation correctly
  absent until Remove is pressed. The login shows static *"Signing in as board@vigavashon.org"* with
  the hidden input intact.

**23 sabotages this session, each caught by a distinct test.** The one worth repeating: removing the
`where exists` guard on the hosted-arrangement write raises a foreign-key violation that loses the
farmer's **entire onboarding form** — which is why that write is deliberately non-fatal.

### Judgment calls max may want to revisit

- **A stand whose owner Farm Friend cannot text still lists the seller**, and no question is opened.
  Farm Friend cannot text first, so refusing a real arrangement over a message we could never have
  sent would leave the public map wrong instead. The host keeps Remove on their own settings screen.
- **The confirmation uses `stock_out_alert`**, so it requires ACTIVE consent rather than riding the
  carrier's reply allowance — a host who texted STOP hears nothing, which is correct.
- **Routing tries the host question before the inventory proposal.** Safe precisely because the host
  question can only be open when nothing has passed in that thread.

### Owed

**Nothing deployed, and `0042`–`0053` remain unapplied to production** — this joins the existing
queue rather than shipping alone. **VIGA's stand editor has not been seen rendered**: the Stands
view switches client-side, so `curl` cannot reach it, and the browser extension was unavailable
again this session. It carries 8 component tests and 5 seam tests.

---

## 2026-08-17 — F-101: the admin console becomes Stands & Sellers, and the pause/end mechanism gets its first caller

Merged as **`dc0b831`** (PR #131), ten commits on `f-101-admin-ui-refactor`. Unit **2,189** with the
7 corpus skips; integration **1409/1409 across 102 files**; typecheck and lint clean — all four
**re-verified on the merged base**, not just on the branch. No live eval run owed: `packages/ai`
and `evals/` are untouched, checked rather than assumed. **Nothing deployed** (max, 2026-08-17) —
production is already behind by F-114/F-115 with `0042`–`0051` unapplied, so this joins that queue
rather than shipping alone.

**The gap this closes.** F-115 Tranche D built `setProviderParticipation`, its authority resolver
and every consequence, fully tested, with **zero production callers**. Pausing or ending a hosted
selling relationship was mechanism-complete and unreachable. This session built the surface.

**The design, settled with max by interview before any code.** The governing aim he named: *a VIGA
volunteer must never have to understand the data model to run the system.* Everything follows from
it.

- **Two views, one destination.** Stands and Sellers are two ways of looking at one set of
  arrangements, so they share a destination rather than splitting the nav. The nav is now
  **Stands & Sellers · SMS Users · Alerts**, and **"Farms" is gone rather than renamed** — max:
  VIGA's whole job is *view and edit stands and sellers, invite new stands or sellers*, so a farm
  is not a destination and approval/retirement/setup links become things done while looking at a
  seller.
- **The lists are entities, not states.** One row per stand, one per seller; a participation is a
  detail inside a row and never a row. A seller at three stands is one row.
- **The singular case is not a list**, on both views — a plain fact with its control, no list
  chrome.
- **The adapting label.** On a stand whose only arrangement is its own seller's, the toggle reads
  as the stand being open or closed, because there that is its true effect. Computed from the
  whole set, never the row, so it **can never say "closed" while a guest is still selling there**
  — the lie the rule exists to prevent. max chose this over introducing a stand-level closed
  state: a label that adapts, not a new mechanism.
- **Toggle = pause/resume; Remove = end**, behind an inline confirmation, with no restore — coming
  back is a fresh invitation, because `ended_at` has no inverse and the UI must not imply one.

**One pushback that changed the design.** max wanted the seller to self-select a host stand during
onboarding with only her own power to revoke. That inverts F-116's settled rule — a host who
cannot remove an uninvited seller is hosting someone they never agreed to. He replaced it with a
better answer than the one offered: an SMS to the stand owner, *"Please confirm that you host
[seller]. Reply YES to confirm, NO to deny."* Live immediately, `NO` ends it. Answerable **only
while it is the last message in the thread** — Golden Rule #2's context-binding satisfied by
conversation state rather than a clock. Filed as **F-117**; it depends on this item's seller
settings screen as the fallback once the confirmation closes.

**Two traps the data found, not the tests.**
- `sales_location_participants` and `stand_providers` both answer "who sells here", but the first
  are display strings a stand owner typed, with no row a control could act on. The new read
  returns only real arrangements, and asserts the distinction directly — a toggle beside a typed
  name would act on nothing.
- Replacing the Farms page **orphaned `listFarmerAuthorizations`**, which would have made
  `/api/admin/farmers` dead surface. The `dead-surfaces` suite caught it; the access roster now
  lives on the seller card, where "who can update this listing" belongs anyway.

**What the browser found that the suites could not.** Every test passed while the page rendered as
unstyled HTML: fourteen class names written, none of them in `globals.css`. Fixed mostly by
*reusing* the console's existing row/pill/button vocabulary rather than adding a second visual
language. Then max's trims on the rendered result — no row glyphs, no page heading, white cards,
the row count as plain text beside the view switch, and **"unclaimed" demoted from an alert to a
neutral chip**: every farm starts unclaimed, so alerting on it made the attention line permanent
furniture and taught the operator to skip the real alert beside it.

**A self-inflicted regression, filed as B-079.** The dead farm card was deleted with a
brace-counting script that removed whole `describe` blocks containing a `FarmList` render — and
one of them also held four tests for the Alerts page, which is still live. Lint at wrap time was
the only thing that surfaced it, via three newly-unused imports. max chose to file rather than
restore before merging. The lesson outlasts the fix: **a substring-matched script deleting test
blocks cannot tell which tests in a block are about the thing being deleted.**

**Owed.** The **seller half of F-101 has not started** — the farmer settings screen (reached by a
permanent unguessable link, re-sent on `LINK` or `SETTINGS`), editable stand metadata for VIGA *or*
the stand's owner, and the F-100 audit's remaining copy findings. Also unresolved: the whole
console was verified as served markup and CSS rather than as pixels, because the browser extension
was not connected.

## 2026-08-17 — F-115: retiring the derivations F-114 left behind, and the venue nobody could see

Merged as **`a32a4a7`** (PR #130), nine commits on `f-115-de-vibe-remediation`. Unit **2,165**
with the 7 corpus skips; integration **1400/1400 across 100 of 100 files**, up from 1347/1347
across 96. Typecheck and lint green, and **re-verified on the merged base** — all four suites
again, plus `drizzle-kit generate` still reporting *"No schema changes"*, so the `0051` snapshot
delta is healthy. No live eval run owed — `packages/ai` and `evals/` are untouched by the whole
branch, checked rather than assumed.

**The work order.** Two independent architecture audits, run cold against `main` at `3abe2fc`
after F-114 and before QA, found one root cause in seven places: *F-114 built the right owners and
left the old call sites in place.* Each phase introduced a correct seam and converted the callers
it was looking at; callers outside that set kept deriving through `sales_locations.own_seller_id`,
which is right for 31 of 38 stands and wrong for exactly the hosting relationships F-114 exists to
serve. Nothing failed in testing, in the corpus, or in review. Tranches A–G in
`docs/plans/de-vibe-remediation-plan.md`; the pause/end writer is filed separately as **F-116**
because it was feature work rather than cleanup.

**The rule throughout was DELETE the stale derivation, never widen it.** The composite FKs added
in `0042`–`0049` already guarantee the coherence those comparisons were re-deriving, so widening
one recreates the root cause. `standBelongsToSender` and `currentInventoryJoin` are gone rather
than fixed.

**Tranche E found that "one liveness predicate" was TWO.** Ten sites hand-wrote
`ended_at is null and lifecycle_state in ('active','paused')`, and collapsing them into one
fragment would have been wrong. They are two rules that agreed only because `paused` was
unreachable: **PUBLIC** (what a customer may be shown — active only) and **REACHABLE** (whose
listing a farmer may still act on — active or paused, because §facts and authority says a paused
provider is *offered re-opening, never refused*). `provider-liveness.ts` states both, so a new
site has to choose, and choosing wrongly is a visible name rather than a mistyped predicate.

**Pausing hid nothing, and nobody had chosen that.** All ten predicates admitted `paused`, so a
paused seller's goods stayed on the map — contradicting the architecture plan's *"ending or
pausing hides current public facts."* Two tests asserted the opposite in near-identical words and
their parity assertion passed, because both were written while `paused` was a state nothing could
enter. Invisible until Tranche D built the writer. max decided: **pause hides.** The ordering of
the work order is what surfaced it — a fragment written against an unreachable state records
whatever its author assumed.

**Re-invitation after ending was impossible** (the plan's one open question, D2), measured with a
probe rather than reasoned from the schema. `0051` makes the `stand_providers` uniqueness partial
(`where ended_at is null`); max decided a seller may be invited back. `ON CONFLICT` then had to
name that predicate or every invitation raised — caught by the writer's own suite, not by the
migration test.

**The differential closed the plan's Unverified item, and the duplication was the non-finding.**
Both audits confirmed `inquiry.ts` builds its own per-seller SQL rather than calling
`readStandProviderFacts`; neither checked whether the two agree on freshness. They do — exactly,
on every seller's date and on which items belong to whom — and they keep separate shapes for the
reason the audits' STRONG list gives. What measuring found instead was three defects in one line:

```
join sellers f on f.id = l.own_seller_id
```

INNER, in the map reader and in **both** SMS retrieval queries. A **venue** has no
`own_seller_id` — a place several farmers sell at and nobody's farm, which is what the
self-pointer exists to represent — so every venue was dropped from the map and from both halves of
SMS retrieval entirely. Now LEFT, with the stand-owner visibility rule the alias carries still
biting, proved by retiring the host and watching the stand leave both channels. The same line gave
every hosted seller's confirmed SMS row the **host's** name; that row is one seller's claim, so it
now carries the provider's own seller. Nothing renders `farmName` today, which is why no existing
test saw it — one renderer away from naming the wrong farm.

**One difference is deliberate and stated rather than asserted away.** A seller who confirmed an
EMPTY stand is a dated fact on the card ("confirmed empty") and absent from SMS, per that query's
own documented rule: an SMS answer lists places to go for a thing, and a seller with nothing is
not one. Asserting equality there would have forced one of the two surfaces to be wrong.

**Two source-text tripwires could not fail**, both measured rather than reasoned about.
`architecture.test.ts`'s `issueFarmerLink` regex matched 5,319 characters — running past its own
function into a later interface — and asserted the `salesLocationId` parameter F-114 C.3
deliberately replaced with `providerId`: green throughout C.3 while claiming the removed design.
`map-marker-styles.test.ts`'s CSS regex matched 42,426 characters spanning two unrelated blocks
42KB apart. Both replaced by anchored assertions or by pointers to behavioural coverage.

**A migration test's range filter had no upper bound** — `name >= "0048_"` with nothing above it,
the exclusion anti-pattern DEVELOPMENT.md warns about, running in the other direction. `0051` was
the first migration to trip it.

**Sabotage notes worth keeping.** A refusal case in Tranche A was *impossible to construct*: the
composite FKs refuse an incoherent subject row, which is precisely the plan's point that
re-deriving proves nothing. One sabotage produced malformed SQL and failed four tests for the
wrong reason — indistinguishable from a test that cannot fail until you read the error. And a
scheduler fixture went silently `ineligible` when forced earlier than the writer's computed slot,
because publication resets the cadence.

**Owed:** `0042`–`0051` remain unapplied and nothing is deployed, so every defect above is latent
rather than live. **F-116 now has a writer and no entry point** — `setProviderParticipation` has
zero production callers, so pause/end is mechanism-complete and unreachable. max decided
(2026-08-17) the surface is controls in the admin views and the seller's own settings screen, not
an SMS keyword, and **it ships with F-101, which widened from the F-100 audit's leftover copy
fixes into the admin UI refactor**: F-116 keeps the mechanism and its authority rule, F-101 owns
the surface, so the two are not tracked in two places. The handset passes C.3/C.4/C.5 owe are
unchanged.

---

## 2026-08-16 — Whose goods are these? (F-114 Phase C.5, the customer's half — the last phase)

Merged as **`9d9ff58`** (PR #129). Integration **1347/1347 across 96 of 96 files**, up from
1289/1289 across 92; unit **2,152** with the 7 corpus skips. Typecheck, lint and scripted evals
(11/11, 4/4, 19/19) green, and **re-verified on the merged base** — all four suites again, plus
`drizzle-kit generate` still reporting *"No schema changes"*, so the snapshot is healthy. **F-114 is complete** — every phase from B to C.5 is on `main`, and the
nine-migration queue (`0042`–`0050`) is unchanged, because C.5 added no migration at all: Phase B
had already given `stand_items` and `inventory_revisions` their provider column. Every criterion
in the PM item is checked except the physical-handset pass, which is max's.

**The phase was one defect, in three places.** The map, SMS retrieval and the admin roster had all
kept the Phase A shape — `is_current` keyed on `sales_location_id` alone. That was correct while
every stand had one seller and silently wrong the moment one had two: both sellers' entries come
back interleaved under whichever `published_at` the loop saw first, so one farmer's goods are
dated by another's update. Nothing errors. Every item is present. The card is wrong. Phase A
consolidated those sites precisely so this would be one change; C.5 is that change.

The new seam is `readStandProviderFacts`, and it is a NEW reader rather than a widened
`currentInventoryJoin` because the *shape* of the answer changed, not just the predicate — the
corpus-wide surfaces select one row per stand, this returns a nesting. That let the three surfaces
adopt it one at a time without dragging the admin roster along, which genuinely does want
stand-wide aggregates.

**`items` is now DERIVED from `sellers`, not read a second way.** The stand-wide union is what a
customer scanning a map needs ("is there kale here"); the per-seller nesting is what the detail
card needs ("whose, at what price, confirmed when"). Two shapes of one fact rather than two facts,
which is the only construction that makes web-and-SMS agreement structural instead of promised.

**Two rules moved into core, because they were about to be written a fourth and fifth time.**
`creditSeller` — the stand's own seller renders unlabelled, **by self-pointer, never a name match**
— already existed three times (the SMS target menu, the settings screen, the reminder list). Its
separator is a *parameter*: SMS is GSM-7-bound and one em-dash re-encodes a whole message to
UCS-2, so what must not differ between channels is *which* listings get a name, not the
punctuation. `sellerCredit` was factored out beside it when the card needed the credit without a
location name attached — one predicate, two renderings, rather than composing a string and
trimming it back off.

**A prior deliberate decision was reversed, deliberately.** `closure-public.integration.test.ts`
asserted that a closed stand KEEPS its items, with the notice, the Open-now filter and the
suppressed routing link doing the work. §customer behavior overrides it: a shutdown renders
nothing itemized, both registers, because a closed stand is a locked box and a standing claim is
as unbuyable as a dated one. Suppressed in `public-listing` rather than the card — suppressing
only in the detail card would leave a closed stand's stock answering a produce search and printing
on the compact card, with the card's own suite fully green.

**The seller list is why hosted sellers can be named at all.** It survived an over-engineering cut,
and the reason is narrow: a bakery selling only at other people's stands owns no `sales_locations`
row, so it has no pin and no card. Crediting it by name on someone else's card while leaving it
findable nowhere is worse than not naming it. Its search matches a seller's own name and goods and
deliberately NOT the stands they sell at — matching those answers "who is at Morgan Hill" with
every baker who has a table there, which the map already answers properly.

**`intersectAvailability` finally has a consumer.** Phase A built it and shipped it as an identity
function with `provider: undefined` everywhere; C.5 is the surface that asks it. Both directions
are proved and both were checked on the live wire, not only in the suite: a seller closed inside an
open stand, and a seller claiming `all_day` still closed inside a shut one.

**Three defects found in passing, none of them C.5's own scope, all measured against a real
database before being touched.** The SMS *offerings* half still joined `stand_items` on the stand,
so a hosted seller's usual items reached customers from ended relationships, unaccepted
invitations, and sellers VIGA had retired — the map had closed all three and SMS runs its own SQL.
The admin roster listed a two-seller stand **twice**, each row carrying half the inventory. And a
`Write` emitted a stray NUL byte into a template literal where a space belonged: JS parsed it,
every test passed, and only `od -c` showed it.

**Two verification lessons worth the standing entry.** First: *a mis-aimed sabotage is
indistinguishable from a test that cannot fail*, and C.5 produced three — a perl pattern that never
matched the source, a `limit 1` inside an aggregate that limited nothing, and an object spread that
did not remove the key it appeared to. Each read as an escape until the sabotage itself was
checked. Second: the four real escapes were all the same standing failure — `usually_carried` with
no unusual item beside a usual one, a hidden-price case whose item had no price to hide, a venue
case for the null self-pointer, an SMS offerings gate with no hosted seller to refuse. Also: the
empty-id-list guard proved *genuinely* redundant (ids travel as an array parameter, so `= any('{}')`
already matches nothing) and was deleted rather than left unfalsifiable.

**Two traps got tripwires.** A backtick in a SQL comment closes the template literal and typecheck
names a *column* far from the comment — five hunts this phase, now
`packages/core/src/sql-template-safety.test.ts`, which proves its own scanner in both directions
before trusting a clean sweep. The NUL-byte sweep is documented in DEVELOPMENT.md §gotchas.

**Read in a browser, not just asserted.** The item-first card and `/sellers` were both loaded
against the real dev database with a seeded hosted bakery; the served `/api/public/stands` payload
was read on the wire. Two things only the running page showed: `stand-card.ts` imported core's
*barrel*, which re-exports `privacy/phone` and pulled `node:crypto` into the browser bundle (the
page 500'd; vitest runs in Node, where it resolves fine, so no unit test could have caught it), and
the nested seller lines kept the chip's pill because `.items li` at (0,1,1) beat a bare
`.item-seller` class — the file read correctly and only a computed-style read of the live page
showed otherwise. Geometry measured at 360px and 390px: no horizontal overflow, credited lines
wrap; no C.5 rule sits in a `prefers-color-scheme` block, so the light-only palette holds.

**Owed:** the two new customer surfaces have not been seen on a real phone.

## 2026-08-16 — Whose schedule is this? (F-114 Phase C.4, cadence + scheduler + paused re-opening)

Merged as **`ac3fcd5`** (PR #128). Integration is **1289/1289 across 92 of 92 files**, up from
1248/1248 across 88; unit is 2,080 with the 7 corpus skips. Typecheck, lint and scripted evals
(11/11, 4/4, 19/19) green, and **re-verified on the merged base** — tests, typecheck, lint, and
`drizzle-kit generate` still reporting "No schema changes" — not only on the branch. `packages/ai` and `packages/core` are untouched across the whole phase —
`git diff --stat main` empty for both, with the search proved against a known-present term first —
so no live eval run was owed. **`0048`, `0049` and `0050` join `0042`–`0047` unapplied to
production, taking the queue to nine.** Five tranches.

**The phase opened with a design question, and the answer was to delete.** `stand_providers`
carried a `reminder_cadence` and a `reminder_authorization_id`; `inventory_prompt_preferences` was
ALREADY one-per-provider, with a unique index on `provider_id` and its own
`designated_authorization_id` — added by the *same* migration. One fact, two homes, and the pair had
never gained a reader or a writer across B, C.0, C.1, C.2 or C.3. The schema comment defending it
("`inventory_prompt_preferences` remains the stand-level record") was already false when written.

Reading the pair instead would have meant moving the scheduler's cursor — `version`, `next_due_at`,
`last_due_slot_at` — onto a relationship record, or splitting a listing's schedule from its place in
that schedule. So: deleted, and deleted from `0042` **in place** rather than by a later migration,
because no database anywhere has applied it — the same fact that let C.0 replace it wholesale. The
queue length is unchanged by the deletion; production never sees the columns.

**A live snapshot defect surfaced on the way, and it was not mine.** `0042`'s snapshot carried TWO
`public.sellers` blocks: the correct renamed table, and Phase B's *deleted* `sellers` table, still
referencing `farms`. JSON parsers keep the last duplicate, so drizzle had been reading the dead one.
Harmless today only because `0043`–`0047` were built as text deltas from the correct block and
`0047` — the head `generate` actually diffs — is right. Fixed in the same commit.

It also nearly cost the wrap: the first attempt at the snapshot edit went through a Python JSON
round-trip, which silently dropped the duplicate **and 209 unrelated lines**. Caught by reading the
diff rather than trusting the write. Snapshots get edited as TEXT now, and that is filed.

**The `*_location_own_seller_fk` family was enumerated up front rather than discovered one
migration at a time.** Eight keys total: `0045` moved `inventory_revisions`, `0047` moved five more,
`0048` moves `inventory_prompt_preferences`, `0049` moves `scheduled_prompt_subjects`. The last two
— `closure_revisions` and `sales_location_participants` — deliberately STAY, because both carry
facts about the PLACE and re-rooting them would make the record assert something false (max,
2026-08-15). All three moved this phase existed only in `0042` and were **never carried into
`schema.ts`**, so none was findable by reading the schema; each surfaced on a hosted write.

`0048` was load-bearing rather than tidy. At a venue `own_seller_id` is NULL and a foreign key
cannot match NULL, so the dropped key did not merely constrain a venue's cadence — it made one
**impossible**, at the database, where no writer could reach around it.

**The cadence seam refuses the HOST arm deliberately.** `resolveProviderWriteAuthority` answers *may
this phone write this provider's STOCK*, and `host_may_update_stock` grants exactly that: a physical
observation about goods on a shelf. A reminder schedule is not an observation, and §facts and
authority makes its recipient the seller by construction — *"other authorized users may still update
it manually"*, manually rather than by owning the schedule. Kelsey may mark Zoe's last loaf gone;
she may not own Zoe's schedule. A venue's stand-armed manager is refused for the same reason, and
the venue's nested seller sets her own — which is also the case that proves the refusal is about who
is asking rather than about a venue being unschedulable.

**The scheduler pass read the roof three times.** `own_seller_id` gated the designated
authorization, gated VIGA's approval, and was written into the durable subject as `owner_seller_id`.
For Zoe all three are Kelsey, so the first two refused her outright and her cadence would have sat
in the table forever with `next_due_at` in the past. It reads the PREFERENCE'S own seller now, safe
because `0048`'s key guarantees that seller IS the listing's. The pass also gained a
relationship-liveness check it never had: a seller whose listing ENDED still has a seller record, a
live authorization and an approval, so all three gates pass and she would be prompted to confirm
goods she no longer sells there.

**A paused listing is offered re-opening, and the gate is at the COMMIT.** Three ways in — a fresh
update, a reply to a prompt the scheduler sent before the pause, and `SAME`, which reaches
`confirmInventoryPublication` through no door at all. Guarding the doors would be three rules that
can disagree and would leave `SAME` publishing silently, so the gate sits on the one seam all three
funnel through. `resolveProviderWriteAuthority` has reported `paused: true` on an *authorized*
answer since C.2 precisely so this could be a flag rather than a refusal; nothing had read it.

**The consent is the farmer's, and it is durable.** A caller-supplied boolean would let any path
assert a consent no farmer gave — exactly the inference the rule forbids. It is
`reopening_stated_version` on the proposal, written by the proposal writer when it composed the
prompt that stated the consequence. The **version**, not a boolean, and that distinction is
load-bearing: a revision bumps `proposal_version` and clears the activation, so a boolean would
survive a farmer seeing the sentence, revising instead of confirming, and then answering an ordinary
prompt that never mentioned re-opening. Placed LAST among the refusals, so it consents to one
consequence and excuses nothing — a revoked authorization still returns `not_authorized`.

**The farmer replies `YES`** (max, 2026-08-16). No new SMS keyword: `YES`/`NO` are the two words a
farmer already knows, and a third would be one more thing to teach for a case that arises rarely.
That decision is what makes the recorded version necessary rather than merely tidy — the `YES` is
ambiguous on its own, and only the record says which sentence it answered.

**The settings screen moved both halves together.** C.3 left it stand-shaped for exactly one
sub-phase because the default picker and the reminder rows are one screen and one save button;
converting the picker alone would have left a listing picker above a stand-keyed reminder. C.3's
placeholder case is INVERTED here, and the case it could not have — a hosted-only seller like Zoe,
whose settings page previously refused her outright because her only listing was filtered away and
the empty result read as `not_authorized` — is added. Participants stay keyed by STAND, because they
are the stand's own record; both pages dedupe by stand before fetching them.

**Twenty-one deliberate breakages, each caught by the case aimed at it — after two escapes, both
the standing lesson again.** Deleting the cadence seam's authorization-agreement check changed no
test result, because every mismatch case also used a mismatched PHONE and the seam resolves by
phone, so the arms refused first; the isolating case is ONE phone holding TWO live authorizations —
Zoe selling her own goods and managing the venue — presenting the one that did not answer. And
dropping the re-opening sentence from the SMS reply broke nothing, because the constant's own test
asserts the CONSTANT and the seam's tests assert the STATUS; a reply that lost it still renders a
plausible confirmation. The end-to-end case through `handleFreeText` closes that, asserting the
absence of the ordinary prompt too.

**Two mirror-image traps cost a false green each.** A refusal case written without `next_due_at` is
refused by `inventory_prompt_preferences_due_state_coherent` — a CHECK, evaluated before any foreign
key — so it passed with or without `0048`; caught only because the case asserts the constraint NAME.
And a `beforeEach` truncate CASCADED from `inventory_publication_proposals` into
`inventory_revisions`, leaving every scheduler case running against an empty stand while still
queueing prompts, because `offers_same: false` with a null base is what an unpublished stand
legitimately produces. Every structural assertion passed; only the asserted BODY caught it.

**One real defect, caught by a test rather than by reading.** `participantNamesByLocation` is keyed
by stand, and the seller-name box initialised its text with what had just become a LISTING id. Both
are UUIDs, both lookups compile, and every load would have shown an empty seller list.

**Nothing deployed, deliberately** (max, 2026-08-16, asked at the wrap). Production is nine
migrations behind and the merged code needs `0042` before it can serve a single write, so applying
them and deploying is one act rather than two — and the nine are Max's call. Production keeps
serving `farm-friend-web-00082-2pl`, which predates every writer that needs them and is unaffected.

**Still not built: C.5** — the public seller list and item-first cards.

---

## 2026-08-16 — Zoe can be reached at all (F-114 Phase C.3, targeting + stock-out routing)

Merged as **`daa499f`** (PR #127). Integration is **1248/1248 across 88 of 88 files**, up from
1208/1208 across 84; unit is 2,075 with the 7 corpus skips. Re-verified on the merged base — tests,
typecheck, lint and scripted evals — not only on the branch. C.2 gave Zoe the ability to publish Gracie's
Greens' stock from the web; C.3 is what lets anything *reach* her.

**The gate was one join, and it read as a sentence nobody had re-read.** `lockLiveTargets` joined
`sales_locations.own_seller_id = auth.seller_id` — *the stands this phone owns*. True of every
stand in the corpus, and false of every hosting relationship C.1 and C.2 had just built. A seller
with no stand of her own was untargetable outright: no `LINK`, no `STAND`, no `SETTINGS`, no
scheduled prompt, nothing. A target is a PROVIDER now.

**One rule, two directions, and their agreement is a test rather than a shared line of SQL.**
`PROVIDER_AUTHORITY_ARMS` is the three ways to say yes as composed SQL text, shared by the
targeting query and `resolveFarmerLink`. `resolveProviderWriteAuthority` deliberately keeps its own
statement: it must additionally report WHICH arm answered, under which authorization, and
distinguish `not_authorized` from `provider_not_live` — folding it into a filter would lose exactly
the facts its callers need. So the round trip is asserted over every phone-and-listing pair with
the host opt-in swept both ways. A menu that offers a listing the writer then refuses is a farmer
told to choose and then told no; that is the failure the test exists to prevent, not tidiness.

**The menu names the seller only where it differs from the stand**, by SELF-POINTER and never a
name match — §suppression follows a pointer, applied to the farmer's side. It asks *"Which listing
do you mean?"* rather than *"Which stand"*, because a host choosing between two listings at one
stand has no answer to the latter. Still GSM-7.

**Stock-out routing is by CONTRADICTION, not recency**, and the discovery worth recording is that
there is no sold-out flag anywhere in the schema: *presence in a provider's current revision IS the
claim that the item is out there.* So absence from a published listing is that provider already
saying they are out, and the three outcomes fall out of one fact — listed → contradicted, told;
published without it → agrees, skipped; no current revision or usual-only → no dated claim to
argue with, never told, filed for VIGA. `readCurrentInventoryByProvider` is the new reader, and a
provider with no current revision is ABSENT from its result rather than present-and-empty, because
"published nothing" and "published a listing without this" are the non-claimant and the agreer.

**A live behavior change, decided at the wrap (max, 2026-08-16): ship it.** The 18 stands that
publish no confirmed inventory stop receiving stock-out alerts entirely — today they are texted
regardless. §customer behavior specifies exactly this and explicitly forbids designing around the
transitional condition; it resolves as those stands confirm inventory, and until then VIGA's queue
is where those reports land. It is the one C.3 change a farmer would notice without being told.

**`0047` removes SIX composite keys, and the last two were found by a probe rather than by
reading.** Two each on `farmer_target_contexts`, `farmer_target_menu_options`, and `farmer_links`,
all still asserting the one-seller-per-stand model. The migration was written for four; a
populated-schema probe was refused by `farmer_links_targeted_location_own_seller_fk` — a constraint
nobody had re-read — which surfaced the fifth and sixth, and that one would have refused a hosted
seller's own link outright. **Four of the six existed only in `0042` and were never carried into
`schema.ts`**: real drift, resolved here rather than left for the next generated migration.

Each `(location, own_seller)` pair is REPLACED by `(provider, seller)` — `0045`'s substitution —
rather than dropped. Dropping them was the first draft and was wrong: nothing would then tie
`owner_seller_id` to the provider beside it, so a menu row could name one seller's listing under
another seller's name with no constraint anywhere seeing it. Each `(authorization, seller)` pair
becomes a plain reference, **a real loosening named rather than buried**, for the reason `0045`
widened `authorization_farm_fk`: who may target whom is two LIVE facts a static key cannot see.

**A correction to the snapshot-repair procedure, measured rather than assumed.** `0047`'s snapshot
is a DELTA of `0046`'s, not an introspection. Measured three ways on this branch: `generate` on the
merged base says *"No schema changes"*; an introspected `0047` snapshot makes it emit **16KB** of
constraint churn; the delta-edited snapshot returns it to *"No schema changes"*. The C.1 guidance
to introspect was written when the snapshot was already drifted — it repairs a drifted snapshot and
**degrades a healthy one**. Also learned the hard way: `drizzle-kit generate` appends a journal
entry as a side effect, so a probe run silently drops your own migration's entry. Both filed in
DEVELOPMENT.md §gotchas.

**Six escapes, and every one was the same failure the last six were** — a guard is unfalsifiable
until a case exists where it is the ONLY thing that could refuse. The self-pointer label survived a
swap to name-matching, because no fixture had a seller whose name disagreed with its stand's *in
either direction*. The proposal's provider filter and the composition base both survived removal,
because no suite anywhere had two listings at one stand reachable by ONE phone — which needs the
host opt-in, the only legitimate way that happens. The SMS menu's seller label survived being
deleted outright, because nothing asserted the rendered menu. The link query survived losing its
live authority arms, because no link pointed at a listing that was not the holder's own. The
settings screen survived losing its self-pointer filter for the same reason. And
`resolveAdministratorLinkTarget` survived "pick the first" because it had no test at all. 19
deliberate breakages in total, each caught by the case aimed at it once those six were closed.

**Deliberately still stand-shaped, for one more sub-phase.** The farmer settings screen keeps the
stand's own listing by self-pointer and drops hosted ones: the per-listing screen belongs with
C.4's reminder cadence, which is the setting that actually differs per listing and shares the same
save button. Splitting it across two tranches would leave a listing picker above a stand-keyed
reminder. VIGA's `issue_link` resolves its `(authorization, stand)` pair to one listing and REFUSES
on ambiguity rather than picking — picking is what hands an operator a link to the wrong seller's
goods with nothing on screen saying so.

**C.4 opens with a design question, not a build one.** `inventory_prompt_preferences` is ALREADY
one-per-provider with its own designated authorization, so `stand_providers.reminder_cadence` and
`reminder_authorization_id` are a second home for one fact and remain unread. The likely answer is
to DELETE those two columns rather than read them — two ways to state one thing is what the zen
desk forbids — but it is a decision to make deliberately, with the scheduler pass in view.

**Environment note**: `npm run test:integration` needs `PUBLIC_BASE_URL` exported as well as
`DATABASE_URL`, or eight `farmer-stand` cases fail on a missing config. Identical on the untouched
merged base, so it is an environment fact rather than a regression.

No seam projection, schema, or output contract changed — `packages/ai` and `packages/core` are
untouched, `projectStockOutParse` still projects exactly `{entryId, itemName}`, and `providerId`
appears nowhere in the AI package, with the search proved against a known-present term first. No
live eval run owed.

---

## 2026-08-15 — Everything the records were built for (F-114 Phase C.2, writes + closure)

Two tranches, merged as **`214aeb2`** (PR #126). Zoe can now state Gracie's Greens' stock at
Kelsey's stand without touching Kelsey's listing, and Morgan Hill can shut its gate. Integration is
**1208/1208 across 84 of 84 files**, up from 1133/1133 across 77; unit is unchanged at 2,074 with
the 7 corpus skips. Re-verified on the merged base, not only on the branch.

**The last place the one-seller-per-stand assumption survived was a foreign key.** `0042` gave
`inventory_revisions` a composite key onto `(sales_locations.id, own_seller_id)`, which reads
plainly as *every revision's seller is the stand's own seller*. True of 38 of 38 stands when it was
written, and it forbids hosted publication **at the database** — no writer could have reached
around it. It was correct at the time: C.0 had just re-rooted identity onto sellers and every stand
still had exactly one. `0045` replaces it with `(provider_id, seller_id)`, which is what it was
reaching for and stronger: whose goods these are is decided by the RELATIONSHIP, never by who owns
the roof. Worth recording because nothing in the phase plan predicted it — it surfaced only when a
hosted publication test failed against a constraint nobody had reason to re-read.

**One deliberate loosening, named rather than buried.** `inventory_revisions_authorization_farm_fk`
bound the publisher's authorization to the seller being published, which refuses exactly the write
§the Venison Valley case permits: a host stating a hosted seller's stock under that seller's own
opt-in. It becomes a plain authorization reference. The database *cannot* answer who may publish
for whom — the answer is two LIVE facts, the relationship's `host_may_update_stock` and the
authorization's revocation, and a static key sees neither. `approval_farm_fk` was deliberately NOT
widened: VIGA's approval is a fact about the seller, never about who typed the update.

**`host_may_update_stock` gained its first reader**, which is the point of the tranche. C.1 left it
a column with a constraint and no consumer — the "data present with no consumer is invisible" trap,
shipped knowingly. `resolveProviderWriteAuthority` is now the one place that answers *may this
phone write this provider's stock, and under which authorization?*, with three ways to say yes
enumerated once rather than at each writer.

**Closure needed a second seam, not a flag on the first.** A stand shutdown overrides every
provider and renders nothing itemized, so it is not any seller's stock — and at a venue there is no
provider to ask about at all. `resolveStandWriteAuthority` answers "may this phone state a fact
about this PLACE?" The writers now resolve each proposal section against the authority it needs.
Merging the two questions would have produced a call returning "authorized for no provider", which
every caller would then have had to interpret.

**B-077 closed, and its shape mattered.** `closure_revisions` demanded a seller in three NOT NULL
columns, so Morgan Hill could hold none of them. Closure now takes two arms mirroring the
authorization's own: a venue names no seller and no seller-approval, because approval gates whether
a SELLER may be public and a venue sells nothing. `owner_authorization_id` stays NOT NULL in both —
the stand arm drops the seller, never the person. **The arm is decided by the STAND, not chosen by
the writer** (`closure_revisions_guard_arm`, a trigger because the rule reads another table);
without that, the venue's arm would be an escape hatch letting any stand's owner publish a closure
with no approval behind it.

**`0046` also widened `inventory_publication_proposals.provider_id`**, which was not anticipated.
That column binds a confirmation token to the listing the farmer was shown, and a venue's closure
has no listing. Naming one of its hosted sellers' would bind the token to goods the closure is not
about — and let that seller's `YES` publish the venue's shutter. A CHECK confines NULL to exactly
the closure-only case.

**Four defects found on the way**, each closed with a case aimed at it: the revise path moved
`sales_location_id` without `provider_id`, so a retargeted proposal would be confirmed against a
listing the farmer never read; a pre-existing constraint test filed the host's seller on the hosted
provider's row, a shape admissible only because nothing checked it; the confirmation locked only
"the acting authorization", silently leaving the other unlocked in exactly the mixed proposal where
they differ; and the seller-retirement gate would have reported `farm_retired` for a venue, because
`rows[0]?.retired_at !== null` is TRUE on an empty result.

**The standing lesson from 22 sabotages: a guard is unfalsifiable until a case exists where it is
the ONLY thing that could refuse.** All six escapes were that same failure, in six disguises.
The seller-arm preference had no case constructing a phone holding both arms. The provider/stand
agreement check was tested with an actor already refused earlier for a different reason. The
closure insert's stand-owner columns and the confirmation's stand-authority resolution both needed
a MIXED proposal at an ordinary stand, where the two authorities finally differ — at a venue both
are `(null, null)` and at a single-seller stand they are the same row. The arm trigger needed an
UPDATE that swaps the arm, because a valid supersede passes whether or not the trigger sees updates
at all. And a `NOT VALID` foreign key sailed through a violating-insert probe, because `NOT VALID`
still refuses new rows and skips only the existing ones — the assertion had to move to
`convalidated`, the fact that actually differs. **This generalizes past sabotage: when a breakage
changes no test result, the first question is whether some *other* guard is answering first.**

**Two migrations owed production, taking the queue to five.** `0045` then `0046`, after `0042`,
`0043`, `0044`, in that order. Neither was generated — both are constraint-only work `drizzle-kit`
does not emit. The snapshots were produced the way C.1 repaired its own: introspect a throwaway
database built from every migration, then renumber the generated snapshot and drop the spurious
journal entry and `.sql` the generator writes alongside it. **Running `drizzle-kit generate`
against `schema.ts` directly still produces a destructive drop-and-recreate** — the drift C.1
recorded is not gone, only routed around.

## 2026-08-15 — Two doors, and the door that was already open (F-114 Phase C.1, doors)

C.1's invitation mechanism was merged and green, and nobody could reach it. VIGA's endpoint had no
button; the stand owner had no door at all. Both now have a person's way in. Integration is
**1133/1133 across 77 of 77 files**, up from 1124/1124; unit is 2,074 up from 2,063.

**The stand owner's authority was already recorded — it just had no surface.** `resolveFarmerLink`
joins `location.own_seller_id = link.owner_seller_id = auth.seller_id`, so a token that resolves at
all belongs to a phone authorized for the seller its stand names as itself. That is precisely what
§there is no second permission system means by "stand owner": derived through the self-pointer,
never stored. So the door reads no new column, invents no role, and adds no gate — it hands
`inviteSellerToStand` the authorization the token already resolved, and the writer re-reads it under
lock. `invited_by_authorization_id` is the vouch, which is what makes acceptance record
`approval_source = 'host'`.

**The SMS half needed no keyword, and that is the session's main judgment call.** The brief asked
for a door Kelsey can reach "from her phone or from her stand settings page", and the obvious
reading is a new farmer keyword. It is the wrong build. `LINK` and `SETTINGS` both already text the
farmer that page, so the phone door exists; a keyword would have to invent a free-text grammar for
a name that becomes a *public brand*, then find a way to text a 64-hex link back for the host to
forward. That is a second mechanism for a door that already opens, and every one of Max's five C.1
decisions removed a step rather than adding one. Recorded here because the absence of a keyword is
the kind of thing a later session re-proposes without knowing it was considered.

**A name, never a seller id, on the farmer's door.** VIGA's door can name an existing seller because
a coordinator is looking at the roster. Offering that to the farmer would mean handing this surface
a list of every seller on the island — exactly the projection `resolveFarmerLink` exists to keep
narrow. So the farmer types the name of the person on their table, and VIGA resolves an existing
identity, which is the same human step §the 11 hosted names already requires and the reason code
never matches a name to an identity.

**A seller name is public text, and nothing was checking it.** §suppression follows a pointer credits
every hosted seller on the stand's public card, so a name minted at either door reaches the island's
only guide. `saveSalesLocationParticipants` has held that boundary for the display-only names since
F-084; the real ones had no guard at all, and the farmer's door was about to let untrusted input
type one. `validatePublicStrings` now guards `inviteSellerToStand` — one place, both doors, the same
code-owned refusal copy — answered before the transaction opens so a refusal leaves no seller behind.
An *existing* seller is deliberately not re-validated: its name is already public, and refusing it
would block an invitation over a row the call did not write. This was a live gap, not a hypothetical:
`Gracies Greens 206-555-0199` was accepted and published before the guard.

**An invitation is not a setting, and a sabotage proved the test didn't know that.** Everything else
on the settings panel writes what *changed* when the farmer presses Save; this mints a link that
exists exactly once, so it has its own press. Asserting that Invite posts once says nothing about
what Save does — and a `save()` that also invited went unnoticed until the tab-committed path
(F-098's `registerSave`, where the panel renders no button of its own and the listing form's press
reaches `save` directly, bypassing the disabled state) got a case of its own. **The escaped sabotage
is the most useful thing that happened this session**: it is the exact failure mode the discipline
exists to catch, and it escaped because the test asserted the presence of the right behavior rather
than the absence of the wrong one.

**The blast radius genuinely widened, and is written down rather than buried.** A leaked farmer link
can now create a seller row and a `pending` relationship at its own stand. It still authorizes
nobody — acceptance needs the invited seller's own handset and a bare `START` — and `pending` is
excluded by every public reader, so the worst a leak achieves is an unaccepted invitation VIGA can
revoke. That bound is asserted beside F-040's five, not assumed.

**Both doors now answer with the complete onboarding URL, shown once**, matching `create_invite`.
VIGA's previously returned a bare token, which would have made an operator assemble a URL by hand;
neither door echoes the raw token beside the link, because a second spelling of one credential is a
second thing to leak.

**Process note worth recording:** the first hour of this session was edited directly on `main`,
against CLAUDE.md's standing rule. Nothing was committed there and the work moved cleanly to
`f-114-phase-c1-invite-doors`, but the branch should be claimed at step 2 of *working a task*, not
remembered at commit time. Twice during sabotage cleanup a `git checkout <file>` was used to undo a
deliberate breakage and reverted uncommitted session work with it — restoring from a scratchpad copy
each time. Sabotage should be undone from the backup that was taken for it, never from HEAD, while
the work is uncommitted.

Verified: unit 2,074 pass / 7 skip, integration 1133/1133 across 77/77, typecheck, lint, web build,
scripted evals 11/11 + 4/4 + 19/19. **No seam projection, schema, or output contract changed, so no
live eval run is owed.** Twelve sabotage cases, each caught by the case aimed at it once the escape
was closed. Merged to `main` as **`e2c79c9`** (PR #125), and **re-verified on the merged base**:
2,074 / 7 skip and 1133/1133 across 77/77. This change carries **no migration and no deploy-only
surface**; the deployment itself is still owed, and `0042`/`0043`/`0044` remain unapplied — all
Max's call.

## 2026-08-15 — The invitation is the one we already had (F-114 Phase C.1, invitation)

C.1's behavior half: a stand owner or VIGA names a seller and gets a one-use link to forward. The
invited seller opens it, fills the same onboarding form a stand owner fills, and texts a bare
`START` — at which point they are authorized for their own seller and the relationship goes live.
**No approval queue, no second form, no VIGA step.** Integration is **1124/1124 across 77 of 77
files**, up from 1077/1077 across 73.

**The hosting invitation IS the farmer invitation, and that is the whole design.** §there is no
second permission system had already cut C.1's access grants on the ground that the permission
following acceptance is an ordinary authorization. The same argument applies one level up:
`farmer_invitations` already names a seller, holds the handset a redemption must arrive from,
carries the SMS agreement, and on `START` mints the authorization and the approval in one
transaction. That is invitation and acceptance, built and in production. The only thing it could
not say is *which* relationship the redemption accepts — one nullable column. A `hosting_invitations`
table with its own token, expiry, redemption path and consent story would have been a second
mechanism doing one mechanism's job, with every rule restated and kept in step by hand.

**Max narrowed the design five times mid-session, and every answer removed work.** He interrupted
with *"let's make sure the invite/adding/onboarding is very simple and not overly gated"*, which
killed the approval queue I was about to build. Then, in order: VIGA does not have to okay it — the
invitation IS the approval, exactly as F-067 made it for the ordinary farmer. Onboarding happens
**always**, even for a seller Farm Friend already knows, *"because details may vary"* — which is
better than either option I offered, since it collapses two paths into one parameterized path
rather than doubling them. The host forwards the link; Farm Friend never texts a number nobody gave
us. VIGA is the approver on record whenever VIGA issues the link — not the owner "on whose behalf" a
coordinator typed. And nothing is public until the seller finishes, which `pending` already gives
for free because every public reader excludes it.

**The vouch waits on the invitation, and that is forced rather than chosen.**
`stand_providers_hosting_lifecycle_coherent` refuses an approval on a `pending` row — rightly, since
approving a relationship nobody has accepted would publish a seller who never agreed to be there.
So `invited_by_authorization_id` sits on the invitation and is applied at acceptance, which is
exactly what `pending_stock` and `pending_prompt_cadence` already do for facts that cannot legally
exist until the authorization does. Kelsey's vouch becomes `approval_source = 'host'`; VIGA's
becomes `'viga'` naming nobody.

**One CHECK is deliberately not a biconditional**, against the grain of every rule beside it. The
schema's standing reason for biconditionals is that a CHECK passes on NULL and both directions are
real failures. Here only one is: a provider bound with no seller would redeem into the "nothing to
authorize" branch and silently accept nothing, while a seller named with no provider is what all 39
production invitations look like. Sabotaging it *as* a biconditional made the fixture unwritable —
the honour-system door needs a seller and no provider — which is the clearest possible proof the
one-directional form is correct.

**Acceptance runs inside the redemption transaction**, gated on the authorization exactly as the
held stock publication beside it. The invitation is spent by that redemption, so a crash between the
two would strand the farmer holding a dead link with nothing reporting why — F-067's silent dead
end, reintroduced one step later. `host_may_update_stock` is untouched and stays off: acceptance
never grants more than it says.

**Twenty-two sabotages, each caught by the case aimed at it** — across the two record suites, the
invite writer, the acceptance path, and the admin route. Two are worth keeping:

- **A sabotage that caught nothing, and what it exposed.** Removing the admin route's
  exactly-one-seller check changed no test result, because the *writer's* refusal produced the same
  400. The guard was unfalsifiable, so it was deleted rather than kept — and the rule proved where
  it actually lives, where breaking it fails three cases across two suites. Two places stating one
  rule is what the zen desk forbids; an assertion that cannot fail is what the verification
  discipline forbids. The same edit fixed both.
- **A sabotage script that produced malformed SQL read as a real signal.** Dropping the issuer CHECK
  appeared to collapse the whole suite at setup, which looked like a strong catch. It was a broken
  `python` splice emitting `syntax error at end of input`. Redone properly, the same sabotage failed
  three cases honestly. A sabotage that fails for the wrong reason proves nothing about the
  constraint.

**The `0044` snapshot was repaired by measurement, not by hand** — the trap CURRENT_STATE.md already
documents, hit again because `0044` is hand-written. A database built from all 45 migrations,
introspected, its all-zero id replaced with a real UUID and `prevId` chained to `0043`. Then the
part worth recording: probing `drizzle-kit generate` against the repaired snapshot emitted **16.7KB
of constraint churn**, which looked alarming until the same probe was run against `HEAD` in a
throwaway worktree and emitted **15.9KB of the same churn**. The drift is pre-existing — introspected
names differ from `schema.ts` names across the whole schema — and the delta between the two probes
is exactly this migration's three new objects. Measuring the baseline is what turned "my repair is
broken" into "this predates me".

**One flake, filed rather than tuned around (B-078).** A full integration run reported `Test Files 1
failed | 76 passed` while all 1124 tests passed — a suite-level failure with no failing test named.
Re-run was 77/77 and both heavy candidate files were green in isolation, so it reads as database
contention under parallel load. The file name was lost to a `grep` for summary lines, which is the
whole reason it is filed: the run that hides this is the one reporting a passing test count beside a
failed file.

**No live eval was owed**, checked rather than assumed: every new column was located across
non-test source and appears only in the db package, migrations, and build output. The search was
proved against a known-present term first, after an initial `grep` for `provider_id` in the two seam
files returned zero — an empty result that would have "confirmed" the right answer for the wrong
reason.

Squash-merged as `70b6e1b` (PR #124); merged `main` re-verified at 1124/1124 across 77 files.
**`0044` joins `0042` and `0043` unapplied to production**, and all three remain Max's call —
nothing this session is deployed.

---

## 2026-08-15 — Two records, and three quiet defects the migration walked into (F-114 Phase C.1)

C.1 was scoped down to **records only** — the authorization's stand arm and the host stock right,
with `0043_authorization_arms` and its constraints. Invitation, per-provider publication, the
seller list, and the item-first cards are the sub-phases that follow, each writing against the
shape this settles. Max chose the stopping point at the top of the session; the phase order's own
discipline argues for it, since each phase wants its constraints and readers before the next
begins. Integration is now **1077/1077 across 73 of 73 files**.

**An authorization names a seller OR a stand, and the stand arm has exactly one job.** A venue like
Morgan Hill sells nothing of its own, so its hours, closure, description, and roster can be reached
through no seller authorization — there is no seller to name. It is deliberately not a second
permission system: "stand owner" stays *derived* through the self-pointer and is never stored. The
nine composite keys onto `(authorization, seller)` are untouched, and a stand-armed row has NULL
there, so it satisfies none of them. That is the correct reading, not an oversight — a person
managing a venue is not thereby authorized for anyone's goods.

**The host stock right is off by default, and that default is the product decision.** Whether a
hosted seller's stock may be updated by the stand's own authorized phones lives on the
`stand_providers` row, because it is a property of the relationship rather than of the stand or the
role. The baker who drops off at dawn wants it; Zoe at Venison Valley does not. An invitation that
silently conferred it would make acceptance mean more than it says, which the hosting lifecycle
already forbids — so `false` both as the column default and as the backfill for every existing row.

**Six sabotages, six caught by the case aimed at each.** Both halves of the one-arm biconditional
(admitting "neither", then admitting "both"), a stand index made non-unique, the stock right
defaulting to `true`, the CHECK added `NOT VALID`, and a migration quietly moving a live
authorization onto the stand arm. The last one needed two attempts and the failed one was
informative: moving an authorization that *carried* dependent facts failed inside the composite
keys, so the suite errored in `beforeAll` rather than proving the assertion. Re-aiming it at the
revoked authorization — which carries nothing — let the UPDATE succeed and the identity assertion
catch it, which is what was actually being tested.

**Three pre-existing defects surfaced on the way through, none of them mine to introduce.**

- `multi-seller-migration` selected its pre-migration set as *"everything that is not `0042`"*. That
  is correct only while `0042` is the newest file in the repo: `0043` was swept into the
  pre-migration set and applied against a schema that had not yet renamed `farm_id`. **Every future
  migration would have broken this file the same way.** Both files now compare by order
  (`name < "0043_"`), which is stable.
- `schema.ts` named two constraints that `0042` had renamed —
  `farmer_authorizations_id_farm_unique` and `…_one_active_contact_per_farm`. Harmless to apply,
  and dangerous to *generate*: the next generated migration would have proposed dropping and
  recreating the target of nine composite foreign keys. Found because a sabotage case asserted the
  constraint *name* and Postgres reported a different one.
- **The `0042` snapshot never received the `farm`→`seller` column renames**, across sixteen tables,
  so `drizzle-kit generate` stopped and interrogated rather than diffing. `migration-metadata.test.ts`
  (GL-006) exists precisely to catch this and is what failed. It was repaired by building a real
  database from all 43 migrations and **introspecting** it into `0043_snapshot.json` — a measured
  picture rather than a hand-edited one, which is what that test's own comment warns against. A
  generation trial afterwards produced only foreign-key noise and zero structural changes.

**`closure_revisions` deliberately stays seller-rooted.** Its `owner_seller_id`,
`owner_authorization_id`, and `owner_approval_id` are all NOT NULL and route through the
self-pointer, so a venue still cannot record a closure at all. That is a real gap and it is filed
(B-077) rather than half-fixed: it needs the closure *writer* to grow a stand arm, and widening the
column alone would leave a nullable column no code can produce.

Verified: integration 1077/1077, unit 2063 passing (7 corpus skips), typecheck, lint, and scripted
evals 11/11 · 4/4 · 19/19. **No live eval was owed** — checked rather than assumed: the four seam
files receive no authorization data at all, and the only matches for the term are comments saying
so. `0043` is **not** applied to production.

## 2026-08-15 — The last four files, and one column name (F-114 Phase C.0)

Closed out C.0's remaining four integration files and merged PR #122. Integration is now
**1057/1057 across 71 of 71 files**.

**The undefined read was a sixth site, not a mystery.** The previous session left
`scheduled-prompts.integration.test.ts` failing on an undefined `own_seller_id` with the cause
unfound, having verified the column returns a value when queried directly. It did — the column was
never the problem. `apps/web/lib/scheduled-prompts.ts` *selects* `own_seller_id` and then *reads*
`location.owner_seller_id`, three times. The previous session's own note records finding five such
sites in production code and fixing them; this was a sixth it missed, in the worker pass rather than
the db package.

What actually found it was refusing to keep reading source. The stack pointed at
`transactions.ts:1323`, which is a red herring — that is the *second* failure in the file, and the
first one, 45 lines further down the log, named the real site with its bind parameters attached
(`[uuid, undefined, hash]`). Reading the whole captured log rather than its tail was the entire
diagnosis. A probe against a real migrated database confirmed the column was fine before any fix
was written, which is what ruled out every schema theory in one step.

**The three historical suites were rewritten, not repaired — and the rewrite is where the value
was.** Each asserted Phase B's native brand slot, a concept C.0 deleted. Repairing them would have
produced tests that pass without proving anything.

- `stand-providers-constraints` now proves the *replacement*: `seller_id` NOT NULL refuses the
  sellerless row (23502, not a partial unique index), no sellerless row exists anywhere including
  the ones the migration wrote, no `%native%` index survives, the self-pointer is nullable and a
  venue gets **zero** fabricated providers, and `create_own_seller_provider` fires on insert, on a
  later self-pointer change, and idempotently on a no-op save. The availability and note cases each
  attack their own real relationship rather than reaching for the sellerless row as a cheap insert.
- `multi-seller-migration` and `stand-items-backfill` both populated their fixtures in the **current**
  vocabulary while deliberately stopping at an **earlier** schema — `sellers` and `own_seller_id`
  against a database that still had `farms` and `owner_farm_id`. The C.0 sweep renamed them along
  with everything else, which is exactly wrong for a historical migration test: it would prove the
  migration against its own output. Both are now written in the vocabulary of the schema they
  actually populate, and `multi-seller-migration` gained assertions that the rename preserved every
  id and that no constraint or index still carries the old names.
- `stand-items-backfill` stops before `0020` and then applies everything through `0042`, so it now
  also asserts that the rows `0020` wrote survive being re-rooted onto per-seller providers
  twenty-two migrations later. Nothing was checking that span.

**Six deliberate breakages, six caught.** `seller_id` made nullable; the trigger narrowed to
INSERT-only; the self-pointer backfill replaced with a no-op; the provider backfill filtered to
exclude retired stands; the constraint-rename sweep neutered; the `stand_items` attribution
filtered to usually-carried. Two of them killed the migration outright rather than failing an
assertion, which is the honest outcome — a retired stand's revision has no provider to point at,
exactly as that fixture's comment predicts.

**A defect measured and deliberately not fixed.** `sellers_name_not_blank` admits a name made of
tabs and newlines: `trim()` with no second argument strips spaces only. It is the renamed
`farms_name_not_blank` and C.0 changed nothing but its name, and **seventeen** `*_not_blank` CHECKs
in the schema share the flaw — one already-correct exception, `stand_providers_public_note_not_blank`,
was written properly during Phase B after a tab-and-newline note got through. Fixing one of
seventeen would leave two behaviours for one rule, so the suite asserts the *measured* truth in two
cases (empty and space-only refused; tab-and-newline admitted, marked INVERT WHEN FIXED) and
**B-076** files the sweep. The test now states what the database does rather than what a constraint
name implies.

**Merged.** Max approved push and merge; PR #122 is merged and `main` carries C.0. Still not
deployed, and `0042` is still not applied to production — both remain his call.

## 2026-08-15 — The seller root (F-114 Phase C.0)

Started as C.1 (hosted-seller invitation) and became something else within the first hour. Asked how
a hosted bakery's phone gets authorized when `farmer_authorizations` requires a farm, Max answered
that farmers *are* sellers — bakers, flower growers, popsicle makers — and that "farmer" was never
the root. That is a re-rooting of the product's core identity record, so C.1 was set aside and this
became **Phase C.0**, a hard gate before it.

**The model, arrived at by correction rather than design.** Four exchanges each killed something I
had just built or proposed:

1. I asked whether to split `sellers` from `farms` or rename. **The corpus answered**: all 38 stands
   have an owner farm whose name is byte-identical to the stand's, and no farm owns two. The split
   carries no information — it exists only because `owner_farm_id` was `NOT NULL`.
2. So I proposed merging stand and brand into one record. **Max rejected it**: Morgan Hill Community
   Stand *is* a brand — a venue with real identity that sells nothing itself. Merging would have
   destroyed that. Two records, and the correction records this as a rejected draft so the reasoning
   does not look tempting again.
3. I concluded from "no phone has ever been authorized for Morgan Hill" that no stand-manager role
   exists and VIGA maintains it by hand forever. **That read a transitional state as permanent** —
   the migration is unfinished, and Morgan Hill *will* have managers. Same error §customer behavior
   already warns about with the 18 stands publishing no confirmed inventory.
4. On Tian Tian's shared payment box I moved payment to the stand. **Wrong**: payment acceptance is
   the seller's own fact — their money, their account — and even the box may not be shared. But a
   shared box *is* the common arrangement, so it is the default rather than an exception to record.

**What the structure became.** A stand has a name, metadata, and nested sellers. `farms` is renamed
to `sellers` (renamed, never split — every id survives, so all 16 keys onto it stay valid);
`owner_farm_id` becomes `own_seller_id`, the **self-pointer** naming which nested seller IS the
stand, NULL for a venue. The **native brand slot is gone**: `seller_id` is `NOT NULL`, because NULL
only ever meant "the stand itself" while `farms` was the root. Public suppression follows the
pointer, never a name match — which is what keeps `Hill Farm` hosted at `Hill Farm Stand` credited
and a renamed farm suppressed, the two failures §customer behavior named when it rejected matching.

**Migration `0042` was replaced, not migrated past.** No database anywhere had applied it —
production ledger 42 rows (`0000`–`0041`), every local database at most 40. Migrating onto the
native-slot model and straight off it would put 38 live stands through two reshapes to reach a state
they can reach in one.

**Five defects the populated-schema test caught that an empty one would not have**: a composite FK
created before its unique target; six keys rooted on the column being dropped; two map-projection
triggers depending on it; 25 constraints and 13 indexes left asserting `farm_*` names on renamed
`seller_*` tables (renaming a table renames neither); and eight backfill joins still matching the
removed native slot.

**Typecheck passed while 63 files were broken.** Drizzle infers column types from `schema.ts`, so
identifier renames propagate invisibly — but raw SQL in tagged templates is just text. A fully green
`npm run typecheck` across three workspaces meant nothing. The sweep that followed also exposed
defects the rename did not cause: `readNativeProviderId` still looked up `seller_id is null`;
**five production sites selected `own_seller_id` and read `.owner_seller_id`**, so every
authorization lookup silently failed; and two history-immutability triggers still named the dropped
column.

**One trigger removed, a different one added.** Phase B created a native provider for every stand.
C.0 cannot: a stand may legitimately have no seller of its own, and the trigger would have to invent
one. The replacement fires only when a stand *names* its own seller, so a venue gets nothing
fabricated — proved by inserting a venue and asserting zero providers.

**Verified.** 2,063 unit tests, typecheck, lint, and scripted evals (11/11 critical, 4/4 advisory,
19/19 adversarial) all pass. Integration is **979/1046 across 67 of 71 files**, up from 423 when the
sweep began. The migration applies to a populated pre-`0042` schema, is idempotent, and every added
constraint is sabotage-proved: both projection guards fire in both directions, wrong-seller pairings
are refused, a null seller is refused, an incoherent lifecycle is refused, a pending invitation is
admitted. No live eval run is owed — C.0 changed no seam projection, schema, or output contract.

**Owed.** Four integration files. Three (`stand-providers-constraints`, `multi-seller-migration`,
`stand-items-backfill`) assert the native brand slot and need rewriting rather than repair.
`apps/web/lib/scheduled-prompts.integration.test.ts` fails its whole fixture on an undefined
`own_seller_id` read whose cause I did not find — the column returns a value when queried directly,
so the next session should measure inside the running fixture rather than infer from source, per the
standing rule about what to do when rendering contradicts source that reads correctly.

**PR #122 is open and deliberately unmerged.** Max held it rather than putting four known-failing
integration files on `main`, which has no CI to flag them. Not deployed, and `0042` is still not
applied to production — both remain his call.

## 2026-08-15 — Records and constraints for multi-seller stands (F-114 Phase B)

Phase B of the multi-seller refactor: the record layer. `sellers` and `stand_providers` now exist,
and a provider dimension runs through inventory revisions, usual items, proposals, farmer links,
prompt preferences, scheduled prompts, and SMS targeting. **Every current output is unchanged** —
every write goes to the stand's native slot, which is the stand behaving exactly as it always did.
Hosted-seller *behavior* is Phase C and is deliberately not built.

**One record, not two, and the native slot is a brand.** `seller_id IS NULL` means the stand selling
under its own name. The contract settled this and Phase B confirmed why it matters at the writer
level too: one nullable column means one constraint set covers both kinds, and the twelve read sites
Phase A consolidated stayed one seam instead of two.

**The count correction, and the two keys that did NOT move.** The contract said nine composite
foreign keys route authority through `(sales_locations.id, owner_farm_id)`. There are **eight** — the
"ninth" double-counted `farmer_target_contexts_selected_location_owner_fk`, citing its
`foreignColumns` line in the original list and its declaration line again as the ninth. Of the eight,
**six re-rooted**. Max decided the other two stay on the stand: `closure_revisions` carries
stand-level closure, which is owner-only and overrides every provider — a fact about the *place*, not
about any seller — and `sales_location_participants` is explicitly *retired* as display-only history
by contract item 5, so a provider reference is one the migration is forbidden to populate. Re-rooting
either would have made the record assert something false.

**The migration is where the real defects were, and only a populated database found them.**

1. `drizzle-kit generate` emitted `ADD COLUMN … NOT NULL` with no default and no backfill for all
   eight columns. That **passes on an empty database and fails instantly on a real one** (23502).
   Against the production corpus — 37 stands with inventory, usual items, links, preferences and
   proposals — that is every one of those tables. Rewritten to add nullable, backfill, then
   `SET NOT NULL`, so the constraint is proved by the data rather than asserted ahead of it.
2. `inventory_revisions_guard_history` refused the backfill outright. That trigger permits exactly
   ONE transition — superseding a current revision — and raises on everything else. It is a Golden
   Rule #1 protection and was not weakened: the migration disables it for that single statement,
   re-enables it immediately, and then **widens it to cover `provider_id`**, so the new column is as
   immutable as the columns beside it from that point on. Attributing an existing revision to the
   provider that already published it is not a rewrite of history; nothing published changes.
3. Nothing created a native provider for a *newly* created stand — only for the ones that existed at
   migration time. Rather than patching the two writers that create stands and leaving every future
   writer to remember, the guarantee went into the database as an `AFTER INSERT` trigger. A stand
   with no native slot can hold no inventory and no usual items at all, and the failure would surface
   far from its cause. The number of writers that must remember this is now zero.
4. `stand_providers_location_fk` had to become `cascade`, not `restrict` — deleting a stand was
   blocked by its own native slot, which broke the existing "a removed location cascades its stale
   targeting context" behavior. The native slot has no existence apart from its stand. This is not a
   weakening of the hosted-seller guarantee: VIGA *retires* stands rather than deleting them, so
   what protects a hosted seller's history is that the stand row is never deleted at all.

**A defect caught while threading the writers.** `saveOnboardingListing` clears standing claims
before rewriting them, and that clear was scoped to the *stand*. Left alone, it would have silently
dropped every hosted seller's usual items each time the host saved their own listing. It is now
scoped to the provider.

**The schema vocabulary forbids the word "provenance."** `schema.integration.test.ts` scans the
schema text, the index file, `0000`, and the snapshot for a list of banned concepts, and a constraint
*name* trips it as readily as a column. `stand_providers_approval_provenance_coherent` became
`stand_providers_approval_source_coherent`, matching the existing `source` vocabulary. The camelCase
key `sourceProvenance` survives only because the pattern is `\bprovenance\b`.

**The pending-change defect is fixed** (contract item 6). The one-open-proposal index was keyed on
`sender_hash` alone, so the limit on pending SMS changes was per *person*, not per target — someone
affiliated with sellers at two stands who texted an update for one was locked out of the other until
they replied. Now `(sender_hash, sales_location_id, provider_id)`. The regression test was written
first and watched fail.

**Invalidation (contract item 8) did not exist at all.** Closure was read at send time and nothing
was ever invalidated, so a provider paused after a prompt went out could still have a live
confirmation token in someone's phone; answering YES would publish for a listing no longer public.
`invalidateProviderWork` is ONE function with an optional `providerId` — omitted means the stand
closed and every provider is invalidated — rather than two near-duplicates. It closes only `open`
proposals and suppresses only `queued` outbox rows, which is what makes it idempotent, leaves an
answer the farmer already gave intact, and never marks an already-sent message suppressed. This is
the guarantee the Phase C re-open confirmation will rest on.

**Phase A paid for itself immediately.** Changing `readCurrentRevisionRef` to take a provider turned
every stand-scoped read site into a compile error in exactly the five files the enumeration named.
Without it, those sites would have kept returning stand-wide rows — correct-looking and wrong.

Verified: 1,037 integration tests across 70 files, 2,063 unit tests (7 corpus-only skips), typecheck,
lint, and scripted evals (critical 11/11, advisory 4/4, adversarial 19/19). **36 sabotage cases**
assert the exact row each new index and CHECK refuses, and **seven deliberate breakages were each
caught** by the suite aimed at them: a non-partial native-slot index (the NULL-distinct trap), a
one-directional `reminder_coherent`, a dropped `coalesce` on the empty day array, one-current keyed
on the stand, `stand_items` keyed on the stand, invalidation ignoring the provider, and invalidation
rewriting an answered proposal. The migration is verified against a **populated** copy of the
pre-`0042` schema with 11 assertions on exact row effects — including a retired stand that still owns
revisions and a never-published stand — plus a re-run proving it is a no-op. No live-model eval was
owed: no seam projection, schema, or output contract changed.

Merged as PR #121 (`0ed60cb`). **Max chose merge-only at the wrap: no database change was applied.**
`0042` rewrites rows in VIGA's real farmer data and is irreversible, so the apply is his to run.

Owed: **`0042` is unapplied in production and must land BEFORE the merged code runs.** Every writer
now supplies `provider_id`, so against the un-migrated schema they fail immediately. Merging changed
nothing about the live service, which still serves the 2026-08-14 revisions.

## 2026-08-14 — One reader for "what's in stock here" (B-074, F-114 Phase A)

Phase A of the multi-seller refactor: consolidate the hand-written current-inventory reads behind one
seam, proving output unchanged, before any provider record exists. The contract's own sequencing
rationale is the point — after Phase B the reader must return per-provider rows, and a site still
carrying its own `sales_location_id`-only SQL would keep returning stand-wide rows. Correct-looking
output that is wrong, on the map and in SMS, with no error anywhere. Consolidating first turns that
class of defect into one compile-time change.

**The enumeration was the deliverable, and it corrected the contract twice.** The old figure of 26
was already known bad; the replacement is **12 sites**, listed by file and line in the contract. But
the contract's "nine files" framing was *also* incomplete — it named `apps/web/lib/scheduled-prompts.ts`
and missed `packages/db/src/scheduled-prompts.ts`, which runs the same read on the farmer's
cadence-save path. Searching the nine named files would never have found it; the list came from
sweeping every production reference to `inventory_revisions` and `inventory_entries` across the repo.
Five categories of deliberate exclusion are recorded too (closure reads, writers, the seeder, a
by-id lookup in `review.ts`, and one type-guard false positive in `stand-form.tsx`), so a later
reader does not re-add them believing they were missed.

Second correction: the contract said sites 10–12 read under `for update`. **Only one does**
(`farmer.ts:621`, the B-070 supersede). The other three run inside a writer's transaction but read
the revision unlocked. So `readCurrentRevisionRef` takes `lock` as a **required** argument — a
default that took it would put row locks on read paths, one that dropped it would silently undo
B-070 — and the test measures the lock with a second session's `for update … nowait` rather than
trusting the argument.

**Three shapes, not one.** The twelve sites ask one question three ways, and a single row type would
make every caller carry columns it does not use. The three corpus-wide surfaces (customer SMS
retrieval, the public map, the VIGA admin roster) compose a SQL **fragment** into their own larger
statements — they select stand, farm, closure, offering and payment facts in one round trip, and a
per-stand call would multiply queries by the corpus and change the ordering each depends on.
`visibleFarms` is the existing precedent for exactly this shape, adopted for exactly this reason.
The stand-scoped sites get a row reader; the writers get the revision identity alone.

**Two traps this pass hit, both worth not rediscovering.** `listStandsForAdministration` was a
**tagged template**, where an interpolation becomes a bind *parameter* — composing the shared join
sent the clause as a string value and failed with `syntax error at or near "$1"`. It moved to
`.unsafe()`, matching `listClaimableFarms`; the statement carries no parameters of its own, so
nothing became injectable. And the roster's `currentItems` column had **one** assertion in the entire
suite: `currentItems: []` on a never-published stand — green whatever the column returned, including
returning nothing for every farm in the corpus. That is the precise shape of a test that cannot fail,
and it was guarding both admin refresh surfaces (the farms page and `/api/admin/stands`).
`admin-roster-inventory.integration.test.ts` now asserts populated values.

**The availability intersection lives at this seam, deliberately.** The contract requires it computed
once, because two surfaces computing it separately is the map-and-SMS disagreement the refactor
exists to end. Its rule is one-directional: a stand that is not open overrides every provider, but an
open stand does not make a provider open. `unknown` **permits** rather than closes — 5 of 34
production stands state no season and 12 state no hours, and treating silence as "closed" is the
certainty-manufacturing this product exists to avoid. In Phase A every call passes no provider and
gets the stand's own answer, which is a tested identity rather than a placeholder.

One deliberate behavior change, strictly narrowing: entries order `sort_order asc, id asc`
everywhere. Two sites already did; two ordered by `sort_order` alone, which is not a total order
because nothing makes `sort_order` unique per revision.

Every new test was sabotaged and confirmed able to fail — including the tagged-template revert, which
is how that trap was proven real rather than theoretical. Verified: typecheck, lint, production web
build, scripted evals (11/11 critical, 4/4 advisory, 19/19 adversarial), 2,063 unit tests, 981
integration tests across 66 files. Live model evals were **not** run and are not owed: the `inquiry.ts`
diff is its import and its join, with no projection, prompt, or output contract touched. No migration.
Nothing deployed — Phase A is code-only and rides the next deploy.

This branch also carries the multi-seller contract itself (`eca6c24`, previously only on
`f-114-multi-seller-architecture`), so merging brings the reviewed contract to main alongside the
Phase A implementation of it.

---

## 2026-08-14 — A custom domain for every public link, and an SPF record that had been failing all along

max got DNS access to `vigavashon.org` and asked what, beyond a CNAME for the map, was worth adding.
The question turned out to be scoped too narrowly in two directions.

**The reputation problem was never map-only.** `PUBLIC_BASE_URL` is one value feeding the entire web
service, and enumerating what SMS actually emits found three of four links on the raw `*.run.app`
host: the onboarding invitation, the standing farmer link, and the contact card. Only the `Map:` line
was already on VIGA's domain — which is why nobody had reported *that* one being blocked. Two of the
three wrap a 64-character random token, and an unfamiliar host around an opaque token is the shape
carrier filters penalise; VIGA's 10DLC campaign is registered against `vigavashon.org`, so an
unrelated host is a campaign mismatch too. So this was never a `map.` subdomain — it is one hostname
for the whole service, and `farmfriend.vigavashon.org` is what it became.

max twice proposed something shorter on SMS-length grounds — `ff.vigavashon.org`, then a separately
registered `frmfnd.us` for about $7/yr. **Measuring settled it**: the tokens are 32 random bytes as
hex, so the longest link runs 130 characters on the old host and 116 on the new one. Every option is
multi-segment regardless, and no hostname choice moves a segment boundary. The 8 characters `ff.`
would save are noise against a 64-character token, and a brand-new vowel-dropped domain on a cheap
TLD reintroduces exactly the unfamiliarity being fixed — domain age is what reputation systems score,
and a subdomain borrows the parent's. The lever, if length ever matters, is the token, not the host.

**The DNS dump surfaced a live bug nobody was looking for.** `vigavashon.org` publishes Google
Workspace MX records, and its SPF record was
`v=spf1 include:spf.mandrillapp.com include:sendgrid.net ~all` — Google absent entirely. Every message
Farm Friend sent as `board@` had been failing SPF; DKIM was present and often carried it, which is
precisely the half-configured shape that looks fine. Fixed, and a monitor-only `_dmarc` added (there
was none). This is likely part of VIGA's separate newsletter-deliverability complaint, and worth
knowing that the domain may publish only ONE `v=spf1` record — a second one for a newsletter provider
would break Farm Friend's mail too, so those senders must merge into the single record.

**Verification notes worth keeping.** The Squarespace panel accepts DNS edits while showing "you're
using custom nameservers", so saving there proves nothing — `dig` against both NS1 and Squarespace
nameservers confirmed they serve identical records. Google Search Console had no `vigavashon.org`
property under `board@`, so the existing `google-site-verification` TXT belongs to some other account;
the GCP account self-verified as a Domain property instead. And **the domain mapping reported
`Ready: True` about six minutes before TLS actually served** — a request in that window fails
certificate verification, which inside an iframe is a silent blank. Polled the real request until it
returned 200 before telling max to touch the embed.

Shipped as configuration only: same image digest, new revisions `web-00082-2pl` /
`worker-00077-rxp`. Internal Cloud Tasks/Scheduler traffic stays on `*.run.app`, which also keeps
already-texted links working. The new plan assertion (61/61) fails a mapping created without the
`PUBLIC_BASE_URL` cutover — the one shape that would apply green while every SMS still sent the
blocked host; proven by sabotaging three configurations.

`public_host` is in **tracked** `production.tfvars`, not the gitignored `terraform.tfvars`. Setting it
in the latter would have left it on one machine, and the next apply from another checkout would
destroy the mapping and revert the fix while reporting success — the same failure that created
`production.tfvars`.

Filed as **F-113**. It was worked most of the session under the label "B-072", which is a *different*
open bug (classifier scoping); the ID was corrected across the commits, infra comments, docs, and the
branch before merge.

**Open:** the antivirus verdict itself is unconfirmed — nothing re-tested against Webroot, and
reputation systems hold stale verdicts. Whether carrier filtering ever affected the SMS links was
never measured, so that half is reasoned, not observed. No SMS built from the new host has been read
on a handset.

---

## 2026-08-14 — The first real farmer onboarded, and two silent failures came with them

Provo Farms completed onboarding, texted `VIGA`, sent stock updates — and appeared nowhere. Their pin
was on the map, admin showed "current stock", and nothing anywhere reported a problem. Two separate
defects, both invisible by construction.

**B-070 — the redemption could never commit, and the retry hid it forever.** VIGA had seeded Provo's
stand months earlier, so a current inventory revision already existed.
`publishPendingStockIn` inserted the farmer's held onboarding stock without retiring the incumbent,
`inventory_revisions_one_current_per_location` refused it, and the whole transaction rolled back —
authorization, approval, consent and stock together. That throw landed in `runInboundPass`'s bare
`catch {}`, which logged nothing; inbound events are ordered per sender and the claim only lapses, so
the message was reclaimed every minute since 08-13 while the cron returned 200. The three texts behind
it never processed. **The seeded shape is the ordinary one at launch** — every farm VIGA imported from
the existing map carries a `viga` revision before its farmer ever texts.

Adding the log line was what found the *second* half: `farmer_invitations_valid_redemption`
(`redeemed_at >= created_at`). `order by created_at desc limit 1` selected the newest unredeemed
invitation for the handset regardless of when it existed, and Provo had a second onboarding pass
created 12.5 hours *after* the text they were actually answering. Bounded the query to
`created_at <= occurredAt`; the later invitation is deferred, not skipped.

Deployed, then verified by effect rather than by a 200: the stuck event moved `processing` →
`processed`, an authorization appeared, and all four queued messages drained in order. No repair rows
were written — the fix let production replay the farmer's own message.

**B-071 — the matcher was editing farmers' listings.** With Provo finally live, the map showed six
confirmed items and the SMS answer showed four. `stand_lookup` has no `broad` operation, so a
product-less question about one stand had nowhere correct to land and fell into `inventory` — the one
stand-scoped operation that calls the catalog matcher. Measured on Provo's real eleven-value catalog,
`what's in stock at provo?` dropped a confirmed item in **3 of 8 live runs**; against the island-wide
200-value catalog it returned 58 arbitrary values once and `invalid_output` twice. Nothing downstream
could catch it: a dropped value is indistinguishable from one the customer never asked about.

The fix put the guarantee where code can hold it. A product-less stand question is `overview`, which
already meant "names one stand without requesting a narrower fact" and renders the whole listing from
code with no seam call (13/13 live). A stand-scoped `inventory` question now answers the yes/no **and**
the full listing, both code-rendered — the matcher only decides which item the verdict is about, still
re-validated against the stand's catalog. Max's rule: a broad question about a specific stand must not
let the model edit that stand's listing.

Two false starts worth recording. Narrowing the matcher's values for a resolved stand was **redundant**
— `candidateStands` already collapses to the resolved stand, so the catalog was never island-wide on
that path; the change was reverted. And prompt wording was the wrong lever twice: making the classifier
ignore a named stand fixed the operation but lost `stand_lookup`, answering island-wide instead. Only
sharpening `overview` vs `inventory` moved all thirteen cases without collateral damage.

Then two copy corrections from the handset: the offerings line now subtracts confirmed items (Provo
repeated all six verbatim under "Usually sells", burying the two that added information), and a
single-stand answer carries no map link — the link helps a customer choose among stands, and this
answer is already about the one they named.

Verified: 2,036 unit, 958 integration across 64 files, typecheck, lint, scripted evals 11/11 + 19/19,
live evals 5/5 operation and 7/7 catalog. Every new test was sabotage-checked; one early test passed
against unmodified code and was rewritten rather than trusted. Three production deploys this session
(web `00077`/`00078`/`00079`), each with 60/60 plan assertions and deploy/served-card assertions.

Not addressed: the classifier sometimes returns `search_stands` where `stand_lookup` fits ("any
tomatoes at provo?"). It answers island-wide rather than wrongly — a quality gap, recorded in B-071.

## 2026-08-13 — B-068/B-069 shipped: classification cannot see the catalog it is classifying

The inquiry pipeline now enforces the distinction the prompt could not: the first model call sees
only the sender's message and fixes a strict route-specific operation. Only inventory and payment
then expose a deduplicated catalog to one generic value matcher. An empty match is a valid result;
provider/schema failure remains a separate failure. Code validates every returned value, expands it
to all supporting stands, retains both confirmed and usual evidence, and owns ordering and paging.

That closes the cucumber defect structurally. Forest Garden's 24-day cucumber confirmation can no
longer be omitted because a model preferred its usual-offering voice; matching `Cucumber` restores
every supporting fact and renders the confirmed one as `Last seen`. It also removes the expensive
stand-by-stand fact-selection call from broad, hours, location, overview, and clarification answers.

The boundary is measured independently from matching: broad/inventory 13/13, other operations 7/7,
second-person 5/5, VIGA/domain 5/5, and catalog 7/7. The full top-level corpus remains 52/53 with only
the pre-existing `what is viga` miss; any new miss fails the gate. `when do you open?` is a system
inquiry, while `do you have eggs?` remains stand inventory and VIGA Bucks keeps its deterministic path.

Verified before release: 2,036 unit tests, 953 integration tests, typecheck, lint, production build,
scripted evals, and the paid live suites. PR #115 merged as `a636cbe`; web `00076-nn4` and worker
`00071-m2q` serve the same immutable digest with no migration. Plan assertions passed 60/60, deploy
and served-card assertions passed, and neither revision logged an error. Handset confirmation of
B-068/B-069 remains part of the pre-go-live pass.

## 2026-08-13 — Phase 2 shipped, and the first two handset messages found two more bugs

F-111 Phase 2: the classifier is wired, both legacy seams are deleted, and it is **deployed**
(`b187b7e`, PR #114, web `00075-bfw` / worker `00070-7rw`). Then two SMS messages from a real
handset surfaced three problems, none of them a Phase 2 regression.

**The rewiring, and what moved.** `handleFreeText` now runs: deterministic routing steps 1–10
(untouched, body-only) → the open stock-out clarification, **now offered to any sender** rather
than customers only → authority read from `farmer_authorizations` and deliberately *not* passed to
the model → one classifier call → a switch over six categories. Routing step 11's
pre-classification stand binding is deleted; a stand resolves only inside the arms that need one.

**The `inventory_report` access fork is the whole B-053 story, now in code.** Customer → report;
farmer holding the resolved stand (or naming none, which means their own listing) → the publish
path; farmer without access → report. The classifier returns the *same category* in all three
cases — there is no enum value meaning "this sender may publish", so a hostile classifier cannot
reach a publish path. The swap test asserts that across three categories.

**Phase 2b, and why the obvious rules lost.** A distinctive-word score must now cover **at least
half** a stand's distinctive words. Measured against the real corpus plus the two live stands the
F-106/B-065 cases name — 14/14 required cases, where three plausible alternatives each failed:
requiring two matched words breaks `barts` (Bart's Cart has exactly two distinctive words); keeping
a score of 1 when the word is corpus-*unique* does nothing at all, because `open` **is** unique to
one stand; and a minimum word length costs nine more real partials at 5 characters or breaks
`barts` at 6. **Accepted cost (max):** 33 single-word partials of longer names stop resolving —
`morgan` no longer reaches Morgan Hill — and those senders are asked which stand instead.

**A test that could not fail, caught by sabotage.** The new split rule carries the house
"no food vocabulary in the source" assertion. The first version stripped comments *before*
searching the remainder, so it passed with `eggs` planted in the file — the strip removed the very
text the assertion looked for. The fixed version anchors to executable code only, first proving the
extraction sees the code at all, and now passes on a comment and fails on a branch.

**Then the handset, and the correction worth carrying.** Two messages, three findings:

- **B-067 (fixed, data-only).** `eggs?` returned Morgan Hill with its entire nine-item offerings
  list printed as one run-on item. One `stand_items` row held all nine names as a 115-character
  string. **Measured before writing: exactly one row in the corpus had that shape** — no other row
  contains a comma — so this was a guarded repair, not a parser. Where a split part already existed
  but sat uncarried (`duck eggs`, `flowers`), max chose to promote rather than skip, so the stand
  shows nine rather than seven.
- **B-068 (open).** `cucumber` returned Forest Garden as `May have: cucumbers`, but that stand has
  Cucumbers as a **published entry** confirmed 24 days earlier, which B-062/B-063 says must read
  `Last seen (24d ago):`. The entry was never retrieved — a retrieval question, not a rendering one.
- **B-069 (open), and my wrong first answer.** Replies took close to a minute. I suggested
  fast-tracking the classifier; **that was wrong, and measuring afterward showed why.** Three
  serial calls, wildly unequal: the classifier emits ~5 tokens, while grounded fact selection emits
  ~18 per selected stand at ~30 tokens/sec — the call B-049 already raised the timeout to 90s for.
  Phase 2 added a small call in front of a large slow one. The lever is selection, not the
  classifier, and the item says so explicitly so the next session doesn't chase it.

**Deliberately not manufactured: a provider failure in production.** Every practical lever (revoking
the key, pointing at a dead host) is a real outage for every sender on VIGA's own account. The
outage reply is proven by an integration test forcing `{ok: false}`, sabotage-verified against the
`unclear` string; seeing it on a handset needs a preview service with a bad endpoint.

**Owed:** 11 of 13 handset cases are unrun, including both defects Phase 2 was built to close.
Neither has been confirmed on a real phone.

---

## 2026-08-13 — Two bugs turned out to be one taxonomy, and the harness lied about the score

Max reported two SMS misroutes from his own handset: "where's the farm stand map?" got the generic
"I did not catch which item or farm you meant", and "which stands are open right now?" got "Thanks
for letting us know. What was sold out?"

**Neither was a classifier failure, and that was the whole finding.** The map question classified
correctly (`farm_stand_question`, 8/8 against the live model) and then died in *inquiry
interpretation*, because the only thing the customer path can look up is a product. The second
never reached a classifier at all: routing step 11 resolves a stand from **every** farmer message
before classifying anything, and the tier-2 scorer awards one point per distinctive word — so
**"Open Gate Lamb and Grazing" contributes the word `open`**. Measured against the real 34-stand
corpus, five ordinary phrasings all bind to that farm, including "when do you open".

The shared cause: name-matching used as an *intent* signal, run against the whole message before
intent is known. "Another stand's name appears here" and "this is a report about that stand" are
different claims, and the code treated them as one. `GENERIC_NAME_WORDS` cannot help — the word is
generic in *English*, not in the stand corpus, and any future "Fresh …" or "Sunny …" stand
reintroduces it for a different word.

**What got built (Phase 1 of `docs/plans/REQUEST_CLASSIFICATION_REFACTOR.md`): one first-pass
classifier, six categories, one enum.** It is implemented, measured and **not yet wired** —
`apps/web` still runs both legacy seams. Phase 2 is the rewiring.

**`inventory_report` merges what were two arms, and the merge was forced by measurement.** With
`stock_out_report` and `inventory_update` split by sender, "no eggs left at Pinecone Gardens" from a
farmer handset classified as *their own update* 3/3 — B-053 reintroduced by taxonomy. Max's call:
both are one intent (someone asserting a listing needs updating), and **who may act on it is an
access question decided downstream in code**, not a language question. The classifier now cannot
express authority at all, which is strictly stronger than a prompt-level split.

**The harness score was not reachable in production, and chasing it cost most of the session.** A
direct HTTP probe scored the settled instruction 141/141; the real seam reproduced 41/47. The probe
had no system message, no `response_format`, and different prompt framing. Of the six differences:
two were *our expectations being wrong* (in an SMS thread with the service, "you" means the service —
"when do you open" and "are you a robot" are `system_inquiry`), one was a field that helped only the
harness (`systemName`, ablated out and its removal *improved* the baseline), and one needed code. The
lesson now in the fixture header: **measure against the path production actually uses.**

**Two things the roster taught us.** Max proposed passing the ~34 stand names as classification
context — safe, since a one-enum output cannot leak a roster, and my safety objection was wrong.
Measurement killed it instead: **94%→85% and 87%→63%, on two different taxonomies.** With the roster
present, bare stand names returned `unclear` every run, as though the model checked the list and
bailed rather than reading the sentence. Excluding it also means the classifier cannot drift as VIGA
adds or removes farms.

**Prompt framing became a per-seam property, not a workaround.** "Extraction" had been baked into
shared plumbing that then had to carry a non-extraction task — `Input (JSON): … Output
requirements:` buries a classification, and the system message told every seam to "omit" fields that
a single required enum has no concept of. `ModelSafeContext` now carries an optional `framing`
declared **by the projection**, never inferred by the adapter from a seam name. Existing seams are
pinned byte-for-byte, user *and* system message.

**Two code-owned fast paths, both earned by failed prompt attempts.** "who takes viga bucks?" stably
returned `system_inquiry` — VIGA is an organisation name a general model has no context for. Two
instruction rewrites each fixed the target case *and regressed another*, because a prompt rule
mentioning payment gets applied to any message containing the payment word regardless of what is
asked. So: a **generic acceptance matcher** (subject + acceptance verb + object, no payment or
organisation vocabulary — "who takes bottle caps" fires), and a **VIGA Bucks domain resolver**
claiming four shapes and nothing else. The resolver is justified against the no-hard-coded-vocabulary
rule: that rule forbids *farm and food* vocabulary, which changes as stands and seasons turn; VIGA
Bucks is a fixed program of the service, already a column pair, in the same class as `MAP`.

**The resolver's `unclear` arm is the subtlest thing here.** "no viga bucks left" is grammatically
identical to "no eggs left", and the instruction explicitly teaches that shape as `inventory_report`
— a rule needed for real stock-out reports. The model returned `inventory_report` *correctly
applying a rule we gave it*; it simply lacks the domain fact that VIGA Bucks are not stand
inventory. Max's call: the application holds that fact, so the override belongs in code. Narrowing
the instruction instead would have endangered "no eggs left", a core path.

**Verified:** 2088 unit tests, 945 integration tests (62 files, against local Postgres — the
`DATABASE_URL` in Secret Manager is **production Neon**, and this suite creates and drops databases
per file, so it must never point there), typecheck, lint, scripted evals 44/44, live classifier
fixture **52/53**. Key tests sabotage-verified. The one known miss is `what is viga` →
`search_stands`: bare `VIGA` is deliberately *not* the concept the resolver matches, and widening it
to the organisation name would claim a large vaguely-bounded family for one case.

**Owed, and the reason Phase 2 is not optional:** the stand-matcher's score-of-1 defect is still
live. Moving classification first removes the common case; the scoring bar itself is unfixed.

---

## 2026-08-13 — The farm was removed everywhere except where it counted

VIGA admin reported "farm removal isn't working". Checked both halves as asked: **stand removal
(F-071) was correct on every surface; farm removal (F-100) worked on none that a customer sees.**

The writer was never the problem. `retireFarm` sets `farms.retired_at` and writes its audit event
exactly as designed. The whole defect was on the read side, and it came from a *correct* design
decision that only got built halfway.

A farm take-down deliberately never writes each stand's own `retired_at` — that is what lets a
restore return exactly the stands the farm was holding down while a stand retired on its own stays
retired. Right call, unchanged. But **nothing downstream implemented the other half of that
contract.** Every public reader filtered `sales_locations.retired_at` — the stand's column, which a
farm take-down never touches. So a removed farm stayed on the map, stayed reachable by text, stayed
in the public signup pickers, and its farmer could still publish new inventory to it. The admin
console was the only surface that agreed with the operator, because `listStandsForAdministration`
is the one reader that joined `farms.retired_at`.

**Why the suite was green, and this is the part worth keeping.** F-100's load-bearing test asserts
"every stand under the farm goes down" — and checks it through the admin reader. So the test passed,
`DATA_RECORDS.md` stated the rule as settled fact ("readers treat a stand under a retired farm as
off the map"), and the operator's own screen confirmed it. Three independent-looking confirmations,
all downstream of the same single reader, none of them evidence about a customer. The requirement
was written down, asserted, and never built. That failure class is now in DEVELOPMENT.md §gotchas:
*a test that asserts through the admin reader proves nothing about what customers see* — the admin
screen is the one most likely to read the column you just wrote and least likely to catch the ones
that don't.

**The fix is one seam plus one gate.** `visibleFarms` already existed for exactly this reason — four
surfaces compose it rather than hand-writing the rule, because four copies is four chances to miss
one. It stated only the test-farm clause; it now states both reasons a farm is absent, and the map,
both SMS retrieval queries and both public pickers inherited the fix for free. The retirement clause
is **unconditional**, unlike the test-farm one: `?hidden=true` and a listed sender hash make a viewer
deliberate about *fake* farms, which hold no real data, and neither is authority to see a real farm
VIGA removed. Publication needed its own locked check inside `confirmInventoryPublication` beside the
approval it belongs with — it is a transactional read, not a filter — returning a new `farm_retired`
status. The routing fallback already replies on any non-published status, so the farmer gets the same
clarification the `stand_retired` path produced; no SMS branch changed.

No schema change, no migration, no model or seam touched.

Four new tests, each written failing and confirmed to reproduce the reported defect first: a removed
farm leaves the map AND the SMS answer, with the model scripted **hostile** so grounding is proven
rather than assumed; restore returns it to both; a stand retired on its own stays down after its farm
is restored; publication is refused once the farm is removed and works again after restore. Both
fixes were then sabotaged and the tests caught each — neutering the retirement clause failed two
public-surface tests, neutering the publication gate failed the publication test.

Also folded in: the admin user-list pills and filter now read **Farmer / Regular user** instead of
"Farmer access / No access yet", which implied a pending step that does not exist, with the access
pill right-aligned to its column. Pre-existing uncommitted work, covered by its own test.

**Verified:** typecheck, lint, 1,960 unit, 945 integration. **Deployed** the same day — web
`00074-4hk`, worker `00069-bp6`, digest `sha256:f1f40aae…` from `main` `3f89523`, plan assertions
60/60 with the image digest as the only delta, no migration owed. `/api/public/stands` returned 34
stands and 35 under `?hidden=true` right after, so both branches of the predicate are live and
neither over-excludes. **Owed:** the console check — remove a test farm, confirm it leaves the map
and the text answers, put it back. Filed as B-066.
