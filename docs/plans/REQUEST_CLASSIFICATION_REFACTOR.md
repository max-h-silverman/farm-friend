# Refactor plan — one request classifier, name resolution after it

**Status:** taxonomy settled and measured at 100% (Phase 0 / 0b complete, 2026-08-13). **Ready to
build from Phase 1.** No code written yet.
**Owns:** the routing change only. Contracts stay owned by ARCHITECTURE.md §deterministic routing
and AI_ARCHITECTURE.md §seam catalog; this plan says what changes in them, not what replaces them.

## Why

Two live defects, both observed on a handset 2026-08-13, share one cause.

**Bug A — the map is not a product.** "where's the farm stand map?" returns
`renderClarificationRequest()` — "Sorry, I did not catch which item or farm you meant." The
customer-message intent seam classifies it correctly as `farm_stand_question` (measured 8/8 against
the live model); inquiry interpretation then returns `ambiguous`, because the only thing the customer
path can look up is a product. `MAP` works as a bare keyword and no free-text phrasing of it reaches
that branch. Measured live: "can you send me the map" and "map?" → `ambiguous`; "where do I find the
map" → a lookup for a product named `map`.

**Bug B — a common English word binds a farm.** "which stands are open right now?" from a
farmer-authorized handset returns "Thanks for letting us know. What was sold out?" Routing step 11
resolves a stand from *every* farmer message before classifying anything. The tier-2 scorer awards
one point per distinctive word, and **"Open Gate Lamb and Grazing" contributes the word `open`**.
Measured against the real 34-stand corpus in `maps/offerings-proposals.json`:

| message | binds to |
|---|---|
| `which stands are open right now?` | Open Gate Lamb and Grazing (score 1) |
| `what stands are open today` | Open Gate Lamb and Grazing (score 1) |
| `is anything open right now` | Open Gate Lamb and Grazing (score 1) |
| `when do you open` | Open Gate Lamb and Grazing (score 1) |
| `what time are the stands open` | Open Gate Lamb and Grazing (score 1) |

Every one is routed as a stock-out report about someone else's farm. The intent seam is never
consulted — measured 8/8 `farm_stand_question`, and irrelevant, because step 11 precedes it.

**The shared cause.** Name-matching is being used as an *intent* signal, against the whole message
text, before intent is known. "Another stand's name appears in this text" and "this is a report about
that stand" are different claims, and the code treats them as one. `GENERIC_NAME_WORDS` strips words
common across *stand names* (`farm`, `garden`); it cannot strip a common *English* word that happens
to sit inside one stand's name. Any future stand named "Open …", "Fresh …", "Sunny …", "Corner …"
reintroduces this for a different word.

**Scope note.** B-053 — the case step 11 was added for, a farmer texting "no eggs left at Pinecone
Gardens" and getting their own stand menu — is real and must keep working. This plan moves *when*
that check runs; it does not delete it.

## The change

One first-pass classifier, above everything that currently classifies. It answers *what kind of
request is this* and nothing else. Stand-name resolution moves **after** it, and runs only for the
arms that need a stand.

    inbound SMS
      → deterministic routing (steps 1–10, unchanged)
      → open stock-out clarification, if any (unchanged, stays below deterministic routing)
      → REQUEST CLASSIFIER  ← new, one call, one enum out
      → per-arm handling; stand resolution only where an arm needs it

**Input:** message text, and sender type (`farmer` | `customer`, resolved in code from
`farmer_authorizations` before the call). **No stand-name roster** — see below.

**Output:** one category, plus an attribute where the arm carries one. Nothing else — no stand name,
no prose. The schema is `.strict()`, so the seam structurally cannot name a stand, choose a
recipient, or carry text — the same containment `customer-message-intent` has today.

### The roster is dropped — measured, not argued

Max's original proposal was to pass the ~34 stand names in as classification context. It was a sound
idea and the safety objection I first raised was wrong (input width and output width are
independent; a one-enum output cannot leak a roster). **The measurement killed it instead.**

Phase 0, 2026-08-13, live model, 34 cases × 3 runs:

| configuration | arm accuracy | attribute accuracy |
|---|---|---|
| roster **out** | **96/102 (94%)** | **51/54 (94%)** |
| roster **in** | 87/102 (85%) | 42/54 (78%) |

The roster does not merely fail to help — it **actively hurts**, and the failure mode is legible:
with the roster present, `Pinecone Gardens`, `where is Pinecone Gardens` and `does Misty Isle have
flowers` all returned `unclear` across every run. The model appears to check the name against the
list and bail rather than classify the request's shape. Without the roster all three classify
correctly.

This also removes the coupling concern for free: the classifier never sees the corpus, so it cannot
drift as VIGA adds or removes farms, and the projection stays one message plus one enum.

## The arm list — SETTLED, measured 100% (max, 2026-08-13)

Six arms. **One enum, nothing else** — no attribute field, no sender type, no roster.

| arm | what code does next | needs a stand? |
|---|---|---|
| `search_stands` | general retrieval + ranking across stands | no |
| `stand_lookup` | resolve one named stand, then answer about it | **yes** |
| `inventory_report` | resolve stand + item; route by the sender's access (below) | **yes** |
| `system_inquiry` | answer from constants — the map, what Farm Friend is and does | no |
| `chitchat` | code-rendered greeting/scope reply | no |
| `unclear` | code-rendered "Sorry, I didn't catch that" | no |

### `inventory_report` merges what were two arms — the key decision

An earlier draft had separate `stock_out_report` and `inventory_update` arms, split by who sent the
message. **That split was measured and it failed**: `no eggs left at Pinecone Gardens` from a farmer
classified as `inventory_update` 3/3, which under the new ordering would have let another farm's
stock-out reach the sender's own proposal flow. That is the B-053 defect, reintroduced.

Max's call: both are **one top-level intent — someone asserting a stand's listed inventory needs
updating.** Who may act on it is an *access* question, not a language one, and it belongs downstream
where identity already lives. Three downstream cases, decided in **code** from
`farmer_authorizations`:

1. Customer reports inventory → customer-style report flow.
2. Farmer reports inventory for a stand they **have** access to → direct inventory update flow.
3. Farmer reports inventory for a stand they do **not** have access to → customer-style report flow.

Case 3 is B-053's job, now enforced by an ownership check in code rather than by a classifier
guessing intent from wording. This is strictly stronger: it survives the swap test, where a
prompt-based split does not.

**Consequence for the model-vs-code line:** the classifier no longer distinguishes update from
report at all, so a hostile classifier cannot route a stranger's report into a farmer's publish path.
Authority was never in the enum to begin with.

### No attribute field on the first pass

An earlier draft had `search_stands` and `stand_lookup` carry an attribute (produce / payment /
hours / season / restock / location). **Dropped for the first pass** (max, 2026-08-13): one
top-level classification only. A later stage decides what a request means — whether "what time are
the stands open" wants currently-open stands or hours generally is a retrieval question, not a
routing one.

Phase 0b's data measurements below remain valid and are **retained for whoever builds that later
stage**. They are not gating this pass.

**The attribute list is set by what the data can answer, not by what a customer might ask.** An
attribute the classifier routes confidently to empty data produces an answer that is wrong in a way
that is hard to notice, because the routing looks right.

**Phase 0b results — measured 2026-08-13** over the real 34-stand corpus
(`maps/offerings-proposals.json`), using the F-035 parsers that populated the production columns.
"Answerable" means a real parsed value, excluding both `not_stated` (VIGA never recorded it) and
`unparsed` (stated but unreadable):

| attribute | answerable | verdict |
|---|---|---|
| produce / stock | 33/34 have ≥1 offering tag | **ship** — the existing path |
| payment | `farm_bucks_accepted` / `farm_bucks_eligible` are `notNull` | **ship** |
| restock schedule | 27/34 (79%) | **ship** — `variable`/`as_needed`/`intermittent` are real answers |
| season | 26/34 (76%) | **ship** |
| hours | **21/34 (62%)** | **hold** — see below |
| location | address + coordinates required on every live stand | **ship** |
| hosted vendors | not modeled | **cannot ship** — see below |

**Hours is the weak one and must not ship on the first pass.** Thirteen stands have no readable
hours, including Open Gate Lamb and Grazing, Lavender Hill Farm and Sherman Creek Farm. A customer
asking "who's open Sunday" would get an answer computed from 62% of the island with no signal that
the rest were silently excluded — a confident answer that is wrong by omission, which is worse than
today's honest failure. Two honest options, Max's call when the arm is built: exclude the attribute,
or answer it while **naming the stands whose hours are unknown**. The second is truthful and matches
the product's existing posture on staleness; it is more rendering work and no more risk.

Note `hoursText` is **display-only, never filtered on** (F-035) — Sherman Creek's "Saturday and
Sunday when available" carries a caveat no day set can hold. An hours attribute answers from the
structured columns and may show the prose beside it; it may not filter on the prose.

**Hosted vendors cannot be answered and is not an arm.** "What other vendors sell at Plum Forest?"
requires a link from one farm to another farm's location, and **no such link exists**. The corpus
case — Handpicked Homestead's "I don't have my own farmstand, please add me under Plum Forest's
location" — is stored as `visitability: contact_only` plus her sentence kept verbatim as an access
note (B-024). That is prose, not a relationship: no column joins her farm to Plum Forest's
`sales_locations` row. Answering this needs a **data model change first**, which is its own piece of
work and explicitly out of scope here. Adding the arm without the link would route confidently into
nothing.

### How a stand name is resolved — decided: shape 1

The classifier returns the **arm only**. Code resolves the stand name from the message text, as it
does today, but now **only for the arms that need one** (`stock_out_report`, `stand_lookup`).
Max's call, 2026-08-13.

The rejected alternative was having the classifier also return the name span it saw, letting code
resolve an isolated span rather than the whole sentence.

**Consequence, and it is load-bearing: the tier-2 scoring bar must be raised as part of this work.**
Shape 1 keeps whole-message matching inside the two arms, so bug B remains *reachable* there — a
stock-out report containing "open" can still bind to Open Gate. Moving the check below
classification removes the common case; it does not remove the defect. Phase 2b fixes the matcher
itself and is **not optional under shape 1**.

## When the model call fails

A failed classifier call — provider down, timeout, invalid output after the repair retry — produces
**no arm at all**. Code replies:

> Sorry, we ran into an issue handling your message. Please try again.

(max, 2026-08-13. Final wording during Phase 3; it keeps B-049's second half, pointing at the map,
which does not depend on the model being up.)

**Why this is not `unclear`.** Telling a customer whose question was never seen that we did not
catch it blames their wording for our outage and asks them to retype something that was fine —
B-049 established exactly this for the interpreter, and this extends that one pattern rather than
adding a concept. It also avoids the worse option: degrading into `search_stands` and returning
"no stand has a current listing", which is a factual claim about the corpus that code never checked.

**Known trade, accepted by Max.** Today a provider outage still answers product questions, because
the current fallback path works without the intent seam. Under this design an outage stops answering
everything and says so. A clear "try again" beats a confident wrong-sounding answer — but this is a
real reduction in what works during an outage, chosen knowingly.

**Three distinct cases, three distinct replies:**

| situation | reply |
|---|---|
| model returns an arm | normal per-arm handling |
| model returns `unclear` | "Sorry, I didn't catch that" — their message, honestly unhandled |
| model call fails | "Sorry, we ran into an issue…" — our fault, stated as ours |

## Phases

### Phase 0 — measure the taxonomy before building on it (gate)

Nothing is built until this passes. A taxonomy that reads clean and classifies at 70% is worse than
the narrow one in production now.

Against the **live** model (`npm run evals:live` shape, real seams — a scripted stub reads neither
the instructions nor the schema and structurally cannot see a prompt describing the wrong job):

- Both screenshot messages, and the "open"-family messages in the table above.
- `who takes viga bucks?` → `search_stands` + attribute `payment`.
- `no eggs left at Pinecone Gardens` from a farmer handset → `stock_out_report`. **This is the
  B-053 regression gate.** If reordering breaks this, the reorder trades one misroute for another.
- Boundary pairs: `who's open Sunday` (search/hours) vs `what are Plum Forest's hours`
  (stand_lookup/hours); a bare product word; a bare stand name.
- Roster in vs roster out, same fixture set, to price what the roster actually buys.
- **`unclear` boundary specifically.** It must catch genuine nonsense without becoming the model's
  escape hatch. DEVELOPMENT.md's warning on the farmer seam applies: an instruction that pushes
  toward reaching a clarification arm produces round trips that buy nothing. Measure how often
  `unclear` wins on messages that a working arm should have taken.

Per DEVELOPMENT.md §instruction edits: measure the **family across repeated runs**, never one
phrasing once. Record raw verdicts.

**Gate:** if an arm misclassifies at its boundary, the arm list changes before any code is built on
it. Report numbers to Max; the arm list is his call, not the classifier's.

#### Phase 0 RESULT — run 2026-08-13. **The gate did not pass.**

34 cases × 3 runs, live model, draft instruction. Headline: **94% arm / 94% attribute with the
roster dropped** (see §the roster is dropped). That number is good enough to build on *once the
failures below are fixed* — but three of them are real, and one is the explicit regression gate.

**FAILURE 1 — the B-053 gate. Blocking.**
`no eggs left at Pinecone Gardens` from a **farmer** handset:
roster out → `inventory_update` (3/3); roster in → `unclear` (3/3). Wanted `stock_out_report`.

This is precisely the case routing step 11 exists to catch, and the draft taxonomy loses it. The
farmer is reporting *someone else's* stock-out and the model reads it as their own update — which,
under the new ordering, would let it reach the proposal flow. **The current design catches this and
the replacement does not.** No code is written until this classifies correctly.

Root cause is the instruction, not the arm list: `inventory_update` is described as "a farmer
stating what THEIR OWN stand has, sold out of" and nothing tells the model that a farmer naming
*another* stand is reporting. The fix is instruction wording, and per DEVELOPMENT.md the decisive
test is to write the failing phrase in verbatim and re-measure — **if it still fails, the behavior
is not reachable by prose and the lever is code**, meaning some form of the step-11 ownership check
survives into the new design rather than being deleted.

**FAILURE 2 — `when do you open`. Blocking for bug B.**
roster out → `stand_lookup` (3/3); roster in → `system_inquiry` (3/3). Wanted
`search_stands`/`hours`.

The message that started this investigation still does not route correctly. It is genuinely
ambiguous in English — "you" could mean Farm Friend or a stand — so this may be a case where the
*honest* answer is a clarification rather than a guess. Worth deciding explicitly rather than
tuning the instruction until it picks one.

**FAILURE 3 — `season` collapses into `produce`.**
`who has strawberries in season` → `search_stands`/`produce` (3/3, both configurations). Wanted
`season`.

Arguably correct: the customer wants strawberries, and "in season" is a qualifier, not a different
question. **Recommend dropping `season` as an attribute** and letting the produce path answer it,
rather than instructing the model into a distinction it does not naturally draw. Phase 0b showed
season data is 76% populated, so the attribute was already marginal.

**Clean across all 3 runs, roster out:** both bug-A phrasings (`system_inquiry`), the payment pair
(`search_stands`/`payment` — the "who takes viga bucks" case that shaped the taxonomy), the
search-vs-lookup boundary (`who's open Sunday` vs `what are Plum Forest's hours`), all three
`inventory_update` cases, both farmer-asking cases (`looking for nigella`), the chitchat/unclear
boundary including `what's the weather` and the recipe request, `restock`, and `location`.

#### Phase 0.1 / 0.2 RESULT — **the gate passed. 47/47 cases, 141/141 runs, 100%.**

Max restructured the taxonomy rather than tuning the instruction against the failures: merge the two
inventory arms, drop the attribute field, drop `senderType`, keep the roster question open. Measured
2026-08-13, roster out, 3 runs per case.

Progression, each step measured rather than assumed:

| taxonomy | arms | result |
|---|---|---|
| 7 arms, attribute, senderType, roster in | — | 85% arm / 78% attribute; 4 of 6 required cases failing |
| 7 arms, attribute, senderType, roster out | — | 94% / 94%; **B-053 gate failed 3/3** |
| 6 arms, merged `inventory_report`, roster in | — | 63%; 4 of 6 required cases failing |
| 6 arms, merged `inventory_report`, roster out | — | 87%; **all 6 required cases clean** |
| + three instruction fixes (below), roster out | 6 | **100% — every case clean across every run** |

**The merge was the unlock.** `no eggs left at Pinecone Gardens` — the case that killed the previous
taxonomy — passes 3/3 once update and report are one arm and access is decided downstream.

**Three fixes closed the remaining failures:**

1. `inventory_report` reworded to drop an implied stand: "stating that items are available,
   unavailable, sold out, or coming soon, **whether or not a stand is named**." Before this,
   `no eggs left` and `out of kale` fell to `unclear` 3/3 — the exact shape a farmer texts about
   their own stand, and the shape a customer texts before we ask which stand. It was a regression
   against a string the existing `stock-out-parse` seam already has a live fixture for.
2. A rule making a bare inventory statement with no stand named still `inventory_report`.
3. The service's own name passed as a **labelled `systemName` context field**, not baked into the
   instruction prose (max, 2026-08-13). `what is farm friend`, `what can farm friend do` and
   `who are you` were `unclear` before it; all clean after. Configuration stated once, the same
   shape `senderType` had — not a product fact hardcoded in a prompt.

**Harness verified by sabotage.** With one expectation deliberately inverted (`hi` → expect
`inventory_report`) the run reported 138/141 and named the case. The 100% is a real measurement,
not a harness that cannot fail.

**Two caveats on the 100%, both stated rather than smoothed over:**

- The cases are ours. The instruction and the phrasings were written by the same pass that measured
  them, so this shows the taxonomy is *coherent*, not that it is *complete*. Real handset traffic
  will contain shapes nobody anticipated — **treat the first live week as the real measurement.**
- The case count grew 40 → 47 during the fixes (six "no stand named", three service-name). Fixes
  measured against cases added in the same pass are weaker evidence. The load-bearing part is that
  the three **pre-existing** failures (`no eggs left`, `sold out of tomatoes`, `what is farm friend`)
  all flipped to clean.

**Also settled by this run:** `when do you open` and `what time are the stands open` both route to
`search_stands` (max: the sender is plainly asking for farm-stand information; a later stage decides
whether that means currently-open stands or hours generally — no clarification needed). `season`
collapsing into produce is moot now that the attribute field is dropped.

#### Phase 1 FINAL — 52/53 through the real seam. Classifier work stops here.

The instruction was ultimately settled against **production transport**, not against the
measurement harness — see the note in `evals/live.ts`. Two code-owned fast paths sit inside the
seam, both ahead of the model call:

1. **The generic acceptance question** (`packages/ai/src/acceptance-question.ts`) — "who takes
   X", "which stands accept X", "is anyone taking X". Purely syntactic: subject + acceptance
   verb + object, anchored at the start. It contains no organisation, currency or payment
   vocabulary, so a VIGA rename cannot break it and "who takes bottle caps" matches.
2. **The VIGA Bucks domain resolver** (`packages/ai/src/farm-bucks-intent.ts`), which runs
   FIRST because it is the more specific rule. It claims four shapes and nothing else:

   | shape | category |
   |---|---|
   | `does <stand> take VIGA Bucks?` | `stand_lookup` |
   | `who takes / where can I spend VIGA Bucks?` | `search_stands` |
   | `what are / how do I get VIGA Bucks?` | `system_inquiry` |
   | `no VIGA Bucks left`, `my VIGA Bucks expired` | `unclear` |

**Why VIGA Bucks is code and not prompt vocabulary.** The rule against hard-coding what the
model can understand forbids **farm and food** vocabulary — data that changes as stands and
seasons turn. VIGA Bucks is a **fixed program of the service**, in the same class as `MAP`: one
concept, already a column pair on `sales_locations`, invariant across farms. Two attempts to
handle it in the instruction each fixed one case and regressed another, because a prompt rule
mentioning payment gets applied to any message containing the payment word regardless of what is
being asked.

**`stand_scoped` → `stand_lookup` regardless of whether the stand resolves** (max, 2026-08-13).
The classification question is whether ONE SPECIFIC stand is being asked about; entity
resolution is a separate downstream concern with its own clarification and no-match behaviour.

**The `unclear` arm is a domain OVERRIDE, and the most important of the four.** "no viga bucks
left" is grammatically identical to "no eggs left", so the model returns `inventory_report` —
correctly applying an instruction rule we need for real reports. The model is not wrong; it
lacks the domain fact that VIGA Bucks are not stand inventory. Without this override an
allocation statement routes into farm inventory handling.

##### The one known miss — `what is viga` → `search_stands` (wanted `system_inquiry`)

Deliberately unfixed. The resolver matches the **`VIGA Bucks` concept**, never bare `VIGA`;
widening it to the organisation name would claim a large, vaguely-bounded family of messages for
a single failing case. Prompt tuning is ruled out by the same evidence as above.

**Policy from here: the live corpus drives classifier changes.** If `what is viga`, or any other
pattern, occurs often enough in real traffic to matter, add the real messages to the fixture and
revisit the taxonomy with evidence. Do not tune against the existing fixture — it is a
regression suite, not a training set, and every attempt to optimise against it has traded one
failure for another.

#### The settled instruction

Verbatim, as measured. Phase 1 implements **this text**; any edit re-opens the measurement.

```text
Classify the message into exactly one category.

search_stands: asking which stand(s) meet a need or asking generally about stands, including availability, payment, hours, or other stand information.
stand_lookup: asking for information about one specific stand.
inventory_report: stating that items are available, unavailable, sold out, or coming soon, whether or not a stand is named.
system_inquiry: asking what the service is, how it works, what it can do, or about the map.
chitchat: greeting, thanks, acknowledgement, or small talk.
unclear: none of the above.

Rules:
- A bare product or item name is search_stands.
- A bare stand name is stand_lookup.
- Questions about stands generally are search_stands.
- Questions about a specific stand, including its location, are stand_lookup.
- A named stand does not imply stand_lookup when the message is an inventory statement.
- Use inventory_report for statements about a stand's inventory regardless of who sent them.
- An inventory statement with no stand named is still inventory_report.
- A message naming the service is system_inquiry when it asks what the service is or does.
- Use unclear only when no other category reasonably fits.

Return only the category name.
```

Context fields sent with it: `systemName` and the message. **Nothing else** — no roster, no sender
type.

The measurement harness is preserved at
`scratchpad/taxonomy-probe.ts` (session-local); Phase 1 reimplements it as a live eval fixture, which
is where it must live to survive.

### Phase 0b — what the data can actually answer (gate on the attribute list)

Runs alongside Phase 0; gates the attribute list rather than the arm list.

- Per attribute, count populated rows across all live stands — not "does the column exist" but "is
  it populated and current": hours, season, restock schedule, location.
- Confirm payment (`farm_bucks_accepted` / `farm_bucks_eligible`) is populated, not merely present.
- Establish how **hosted vendors** is modeled — multiple farms against one `sales_locations` row,
  or something else — which decides arm vs. attribute.

**Gate:** an attribute ships only if the data answers it. Attributes can ship incrementally; a thin
one waits rather than routing confidently into empty data.

### Phase 1 — the seam

Test-first. New seam `request-classification` in `packages/ai`:

- `.strict()` schema: **one enum field, six values.** No attribute, no sender type, no stand name.
  The seam has no channel through which a stand, a recipient, or prose could travel.
- Projection carrying the message text plus `systemName`, copied not aliased. **Nothing else.**
- The settled instruction verbatim (see §the settled instruction). Any edit re-opens Phase 0.
- Entry in `SEAM_OUTPUT_SHAPES` (examples are parsed through the real schema, so they cannot drift).
- **No fallback arm.** A refused or unreachable model produces no classification and no arm; the
  caller renders the failure reply (see §when the model call fails). This is a deliberate departure
  from `customer-message-intent`, which uses one value as both an answer and a fallback — the
  conflation this refactor removes.
- The Phase 0 case set becomes a **live eval fixture**. It is the seam's regression suite and must
  live in the repo, not a scratchpad.
- Entry in the AI_ARCHITECTURE.md seam catalog and its permitted-input table.

**Authority is not in the enum at all.** The classifier cannot express "this farmer may publish" —
`inventory_report` is one arm for everyone, and who may act on it is decided downstream in code from
`farmer_authorizations`. This is stronger than the earlier draft, where a prompt-level split carried
part of the authority decision. Golden Rules #1 and #3; the swap test is trivial here because there
is nothing authority-bearing for a hostile model to return.

### Phase 2 — rewire routing

- Deterministic routing steps 1–10 **unchanged**. The classifier sits below them, so no stored state
  can reinterpret a `STOP` (Golden Rule #2, structural not conventional).
- Open stock-out clarification stays **above** the classifier, where B-065 put it and for its reason.
- Step 11's pre-classification stand binding is **deleted**. Nothing resolves a stand before the
  message is classified.
- `farmer-message-intent` and `customer-message-intent` are **deleted, not left beside the new seam** —
  DEVELOPMENT.md's delete-on-the-way-through rule; two ways to classify one message is the thing this
  refactor exists to remove.

#### The `inventory_report` access fork — where B-053 now lives

Classify → resolve the stand → **then** decide by access, entirely in code:

| sender | access to the resolved stand | flow |
|---|---|---|
| customer | — | customer-style report; private signal to that stand's farmer |
| farmer | **has** access | direct inventory update flow (proposal + confirmation) |
| farmer | **no** access | customer-style report — B-053's case |

No stand resolved → the existing "Which stand are you at?" clarification (B-065), unchanged.

This is the whole of what step 11 was doing, minus the part that caused bug B: the ownership check
runs *after* the message is known to be an inventory report, so an ordinary question containing the
word "open" never reaches it.

### Phase 2b — raise the matcher's bar (still required)

**Not optional.** Stand resolution still runs on whole message text inside `inventory_report` and
`stand_lookup`, so bug B stays reachable there: a report whose text contains "open" can still bind to
Open Gate. Phase 2 removes the common case by moving the check below classification; this phase fixes
the defect itself.

The bug is that **a tier-2 score of 1 counts as identification**. One matched word out of a
multi-word stand name is not a name — it is a coincidence, and `GENERIC_NAME_WORDS` cannot prevent it
because the word is generic in *English*, not in the stand corpus. Any future stand named
"Open …", "Fresh …", "Sunny …", "Corner …" reintroduces it for a different word.

Candidate rules, to be **measured against the real corpus before choosing** — parsers that look
correct in the abstract fail on real data in minutes:

- Require score ≥ 2 for a multi-word stand name; a single-word name (`Aeggy's`) still binds at 1.
- Require the matched words to be a meaningful *fraction* of the stand's distinctive words.
- Keep score 1 only when the matched word appears in exactly one stand's name across the corpus.

Corpus test set: the "open"-family messages must resolve to nothing; the F-106/B-065 cases must keep
resolving (`barts` → Bart's Cart, `pinecome` → Pinecone Gardens under an open clarification,
`holmstead` still tying and asking). Both directions matter — a bar high enough to reject "open"
must not also reject "barts".

#### Phase 2b RESULT — measured 2026-08-13. **Rule B ships: 14/14.**

Measured against the real 34-stand corpus in `maps/offerings-proposals.json`, plus the two live
stands the F-106/B-065 cases name (Pinecone Gardens and Handpicked Homestead are live rows absent
from that file — measuring the "must keep resolving" half without them measures a different island).

**The rule: matched distinctive words must be at least HALF the stand's distinctive words.**
`open` is 1 of 4 for "Open Gate Lamb and Grazing", so it binds nothing; `barts` is 1 of 2 for
"Bart's Cart", so it still does. It lives in `packages/core/src/inquiry/stand-name-match.ts` as
`meetsDistinctiveWordBar`, beside the fuzzy tier, and the scorer in `free-text.ts` calls it.

| candidate rule | required cases passed | why it lost |
|---|---|---|
| current (score ≥ 1) | 9/14 | the defect — the whole "open" family binds |
| A — ≥ 2 for a multi-word name | 12/14 | breaks `barts` (Bart's Cart has 2 distinctive words) |
| **B — ≥ half the distinctive words** | **14/14** | **shipped** |
| C — score 1 only if the word is corpus-unique | 9/14 | does nothing: `open` IS unique to one stand |
| B + a 5-character floor on a lone word | 14/14 | costs 9 more real partials for two English words |
| B + a 6-character floor on a lone word | 13/14 | breaks `barts` |

**The cost, accepted by max 2026-08-13:** 33 single-word partials of longer names stop resolving —
`morgan` no longer reaches Morgan Hill Community Farm Stand, nor `outpost`, `vignes`, `creamery`.
Those senders are asked which stand they mean. Full names (36/36) and half-names (`morgan hill`)
are unaffected. Asking is recoverable; binding a stranger's report to the wrong farmer is not.

**What rule B does NOT claim.** A word that is a stand's *entire* distinctive name still binds at
1 — `green` → Green Ears, `cart` → Bart's Cart, `olive` → Olive Farm Stand. That is identification,
not coincidence: the sender typed the whole name. The rule targets partial coverage, not vocabulary.

### Phase 3 — the arms that were missing

- `system_inquiry` answers the map from `PUBLIC_MAP_URL` — the same constant `MAP` uses, stated once.
  Bug A closes here.
- `unclear` and the model-failure reply get their final copy, code-rendered.
- `search_stands` and `stand_lookup` route into retrieval. Interpreting *what* was asked — produce,
  payment, hours — is that later stage's job, not the classifier's; Phase 0b's coverage numbers are
  the input to it, and the hours caveat there still applies wherever hours get answered.

### Phase 4 — verification

- Unit + integration suites for each arm; integration against real Postgres, per the existing pattern
  in `stock-out-clarification.integration.test.ts` — the pending row, its expiry and its unique index
  are the mechanism, and a stubbed driver would assert the mock.
- **Sabotage each new test**: break the code deliberately, confirm the test catches it. A test that
  cannot fail proves nothing.
- The "open"-family messages become a **regression fixture**. This bug must not be reachable again.
- `npm run evals` and `npm run evals:live`. `live-containment` must be 100%.
- The swap test, written out: with a hostile classifier returning the worst arm for every message,
  which properties survive? Expected answer — all of them, because the arm selects a code path and
  every consequential step re-checks authority and re-validates identifiers against real rows.
  Specifically: `inventory_report` returned for a customer's unrelated message reaches the
  customer-style report flow and publishes nothing; returned for a farmer, it publishes only against
  a stand `farmer_authorizations` says they hold, and otherwise falls to the report flow. **The
  access fork is the test** — assert all three rows of its table, including a farmer against a stand
  they do not own.
- **The failure path is tested by forcing a provider failure**, not by assuming it. Assert the
  customer gets the failure reply — not `unclear`, and not a "no current listing" claim about a
  corpus nothing searched.
- Full suite + typecheck before done.

## Risks

- **The 100% is against our own cases.** The instruction and the phrasings were authored by the same
  pass that measured them. It shows coherence, not coverage. **Treat the first live week as the real
  measurement**, and expect shapes nobody anticipated.
- **Hours data is thin (21/34).** Wherever hours get answered — the later interpretation stage, not
  this classifier — answering from 62% of the island without saying so is a confident answer that is
  wrong by omission. Phase 0b §hours states the two honest options.
- **An outage now degrades every path at once, by design.** With no fallback arm, a failed
  classifier call means no message is answered until the provider recovers. Accepted by Max
  (§when the model call fails); the mitigation is honest copy, not a silent guess.
- **`unclear` can become an escape hatch.** If a later instruction edit pushes toward it, customers
  get round trips that buy nothing — DEVELOPMENT.md's warning about the farmer seam's `unclear`.
  It measured clean at 100%; the eval fixture is what keeps it that way.
- **Stand resolution still runs on whole message text** inside `inventory_report` and `stand_lookup`
  until Phase 2b lands. Phase 2 alone closes the reported bug but not the underlying one.
- **`pending_result_lists` / `MORE` paging** interacts with `search_stands`; the existing paging
  contract must be re-verified against the new arm, not assumed.
- **Hosted vendors is a separate refactor** and deliberately not sequenced first (max, 2026-08-13):
  it is an independent data-model change, it does not block or conflict with this work, and going
  first would leave both live bugs on handsets longer.

## What this plan does not touch

Deterministic routing steps 1–10, compliance keywords, confirmation tokens, the outbound guard,
privacy at the data layer, the public map surface, the admin console.
