# Listing ingestion audit — 2026-08-04

> **Dated historical record, not a contract doc.** Frozen on completion. Where this disagrees with an
> architecture doc, the architecture doc wins for contract; this file records what was *measured* on
> 2026-08-04 against the real corpus.
>
> Scope: F-059. Audit only — nothing was implemented, no schema changed, no seeding run.
> Every quantitative claim below traces to a throwaway analysis script run over the real CSVs;
> those scripts are exploratory and exempt from test-first, and each is named where used.

## The headline: the audit's founding premise was wrong

The prompt ([LISTING_INGESTION_AUDIT_PROMPT_2026-08-04.md](LISTING_INGESTION_AUDIT_PROMPT_2026-08-04.md))
instructed that step one was to confirm B-035 — that `parseFormResponses` "describes a source VIGA has
never produced" — and warned that everything else depended on it being true.

**It is not true.** A third CSV exists in `~/downloads/`:

```
2026 Farm Stand Information (Responses) - Form Responses 1.csv
```

It is the profile export. Its header is a byte-for-byte match for `EXPECTED_COLUMNS`, in order. It
parses cleanly through `parseFormResponses`: **31 stands, 1 refused** — Forest Garden Farm, whose
submission is `(same info as last year)` with no address, which is the exact refusal the code
documents by name.

**Why it was missed.** The filename begins with `2026`, and in `ls -l` output that runs straight into
the date column — `Jul 29 11:11 2026 Farm Stand Information (Responses)…` reads as a year. Searching
for either of the two filenames the prompt named never surfaces it.

Every specific piece of evidence the prompt offered for the fabrication claim is real data:

| Prompt's claim | Measured reality |
|---|---|
| `EXPECTED_COLUMNS` names columns existing in neither file | The exact header of the profile CSV, in order |
| Fixture `13609 SW 220th St` (Aeggy's) "appears in neither file" | Line 2, Aeggy's Farm, `Address` cell |
| Fixture `Bank Road, East of Town` "appears in neither file" | Sweet Alyssum Farm, `Address` cell |
| `parseFormResponses` + its 210-line test file are "green over an invented format" | Both are correct against the real export |
| "max has confirmed the two files are the complete set" | A third file exists, dated 2026-07-29 |

**Consequences:**

- **B-035 should be closed as not-a-defect.** `parseFormResponses` must be neither rewritten nor
  deleted. It reads a real, current, structured file correctly.
- **`SUPPLEMENTAL_COORDINATES` is not residue of a fiction.** It holds exactly the four farms my join
  found in the profile form with no map row (below). It is a correct hand-geocode, not a leftover.
- **CURRENT_STATE.md lines 39–42 are wrong** and should be corrected; they assert the fabrication.
- The prompt's own warning applies to itself: an audit built on B-035 "would look complete while
  describing" a file situation that does not exist.

*Script: `probe.ts` — ran all three CSVs through both parsers.*

## The three sources, and how they actually relate

The prompt modelled two sources. There are three, and the real relationship is different.

| File | Parser | Result | What it is |
|---|---|---|---|
| `2026 Farm Stand Information (Responses)…csv` | `parseFormResponses` | **31 stands, 1 refused** | **Per-farm profile.** One row per farm, structured columns, 2026-current. **Still open** — max confirmed VIGA is still collecting. |
| `VIGA Farmstand Map- VIGA Member Farm Stands (1).csv` | `parseStandCsv` | **31 stands, 0 refused** | Volunteer's hand-typed transcription. **Sole source of coordinates.** |
| `Farm Stand Weekly Status (Responses) 2024…csv` | *(neither)* | `parseFormResponses` throws | **Recurring stock feed.** 734 submissions / 49 farms / 4 seasons. No parser exists. |

The corrected relationship:

```
profile form  ──(volunteer hand-types)──▶  map CSV  ──▶  seeder
   (31 farms, structured)                (31 stands, prose + geometry)

weekly status form ─── 734 rows, no parser, NOT INGESTED AT ALL
```

The prompt's claim that "the only durable home for profile facts today is the volunteer's hand-typed
description" is **false**. The profile form is that home, it is structured, and the seeder already
reads it. The weekly form is a *third*, separate feed — not the origin of the profile facts.

The prompt's 70/70-vs-1/70 finding about the weekly form still stands and is still useful, but its
conclusion inverts: profile facts are sparse *in the weekly form* because they live in the profile
form instead.

### The join already works

`joinStandSources` over the two real files: **35 stands, 0 refusals.**

- **27** `form_and_map` — form details + map coordinates
- **4** `form` only — Farmstad, Handpicked Homestead, Lavender Hill Farm, Sweet Alyssum Farm
  (no map row; these are exactly the four in `SUPPLEMENTAL_COORDINATES`)
- **4** `map_only` — Forest Garden Farm, Vashon Island Farmers Market, 3 Brothers Outpost,
  Breathing Meadows Farm (no 2026 profile submission)

`matchStandName` resolves every real name variant — `Aeggy's`/`Aeggy's Farm`, `Provo Farm`/`Provo
Farms`, `Olive Farm`/`Olive Farm Stand`, `Flora Hill`/`Flora Hill Farm` — and produces no false pair.
The Lavender Hill / Flora Hill near-miss its header comment warns about is real and is correctly
avoided. **This machinery is sound and should be kept.**

*Scripts: `reconcile.ts`, `names.ts`, `join.ts`.*

## The real defect: one line in the seeder

`packages/db/scripts/seed-stands.ts:176-190`

```ts
const publicDescription =
  mapDescription ||          // ← when a map row exists, the volunteer's prose wins outright
  [ ...form fields... ].join("\n");
```

For the **27 stands with a map row**, the seeder stores the volunteer's transcribed prose verbatim as
the public description — while separately parsing the *form's* clean columns into the structured
fields. The form's own well-formed text is discarded for display and used only for parsing.

That single line is the mechanism behind both on-screen contradictions the prompt flagged:

- **"Hours not listed" beside `Open: Year Round`.** The form states `Open Hours & Days` as its own
  column for **29/31 farms**. The map collapses season and hours into one `Open:` line, so the
  displayed prose has hours while the structured hours field misses them. The data exists; the
  ingestion drops it.
- **"Nothing confirmed recently" above a farmer-dated stock update.** `extractStockUpdate` has no
  consumer (deliberate — see decision 4).

Both are ingestion artifacts, exactly as CURRENT_STATE says. Neither is a rendering bug.

## 1. Corpus-level field inventory

Across all 276 non-empty description lines in the 31-stand map corpus:

| Fact | Lines in map prose | In profile form | Schema home | Ingestion writes it | Any surface reads it |
|---|---|---|---|---|---|
| Links (web/social) | **41** | 20 website / 21 social | `farm_links` | **no** | **no** |
| Address | 30 | 30/31 | `sales_locations` | yes | yes |
| Season | 25 | 31/31 | `availability.season` | yes | yes |
| Payment methods | 22 | *(not a column)* | `sales_location_payment_methods` | **no** | **no** |
| Contact names | 21 | 31/31 | — (stripped) | n/a | n/a |
| Stocking | 21 | 25/31 | `stocking.cadence` | yes | yes |
| Stock update (dated) | 20 | *(not a column)* | `extractStockUpdate` | **no** | **no** |
| Participants | 7 | *(not a column)* | `sales_location_participants` | partial | yes |
| Hours | *(folded into season)* | **29/31** | `availability.hours` | **partially — see above** | yes |

**Verified in both directions** (write path and read path), per the prompt's requirement:

- **`sales_location_payment_methods` — confirmed consumer-less.** Its only appearances outside
  `schema.ts` and `0000_clean_launch.sql` are four integration-test *cleanup* lists. No writer, no
  reader. Gap is wiring, not schema.
- **`farm_links` — the same, and the prompt under-called it.** The prompt listed it as "exists;
  population unverified". Measured: identical state — schema plus four test-cleanup references, no
  writer, no reader. **Links are the single most common structured fact in the corpus (41 lines)**
  and are entirely un-ingested. This is a second consumer-less table, not a populated one.

*Script: `desc.ts` for line classification; grep over `packages`/`apps` excluding `dist` for wiring.*

### Cross-source disagreement

Of the 27 joined stands, where both sources state the same fact:

| Fact | Stated in both | Disagree |
|---|---|---|
| Address | 25 | **4** |
| Season | 25 | 21 → **2 genuine** |

The season number is misleading and worth stating carefully: **23 of the 25 "disagreements" are the
volunteer concatenating the form's `Open Season` + `Open Hours & Days` into one line.** Only 2 are
genuine divergence, and both are punctuation-level. The four address disagreements are transcription
drift, all in the map's direction of being *more* verbose:

- Aeggy's — map `13609 Southwest 220th Street, Vashon, Washington 98070, United States` vs form `13609 SW 220th St`
- Olive Farm Stand — map `24629 Dockton Rd SW` vs form `24629 Docton Rd` *(form has the typo)*

**Which wins today:** the map, for the description; the form, for the structured fields.

Transcription residue confirmed: `WA, WA` corruption and en-dash drift in dated lines are present and
originate in the manual step.

*Scripts: `conflict.ts`, `concat.ts`.*

## 2. Verdict on the description field: **the hypothesis is disconfirmed**

The prompt's hypothesis was that the description is mostly a re-rendering of structured facts, with
"roughly one sentence" surviving once they are subtracted. The prompt also — correctly — instructed:
*"Report what the corpus shows, not what this prompt expects."*

Measured across all 31 stands:

- **68%** of description lines (187/276) have a structured home.
- **32%** (89 lines) are genuine remainder.
- **0 of 31 stands have an empty remainder.**
- Remainder size: min 1 word, **median 16**, mean 26, **max 98**.

The Narwhal Farm example in the prompt is real but **not representative** — it is near the low end.
The remainder is not "one sentence"; it is substantive and varied, and it is the farm's voice:

- *Littlest Bird Farm* (98w) — a land acknowledgement naming the sx̌ʷəbabš people, plus closed-loop
  and biodynamic practice detail.
- *Fruits Des Vignes* (59w) — WSDA processor licensing, prepared-food offerings.
- *Breathing Meadows* (37w) — herbal medicine teaching, appointment-only explanation.
- *Bart's Cart* (29w) — "a second grower's plants are being introduced weekly".
- *Holmestead Farms* — "We place a sign at the bottom of the driveway when we are open!"

**Verdict: store a genuine remainder, do not derive the whole description — but stop storing the map
prose as the description.** The correct target is not "derived vs. raw". It is:

> Render the structured facts from the **profile form's own columns**, and store as free text only
> the remainder that has no structured home.

This kills both contradictions by construction (a fact appears once, in one voice), preserves every
farm's actual character, and needs no model to classify the 68% — because **the form already supplies
those fields pre-separated**. The classification problem the prompt worried about ("the ingest must
classify every line") largely disappears once you ingest the origin instead of the transcription.

The cost the prompt asked me to state: for the 4 `map_only` stands there is no form row, so their
descriptions must still be line-classified or left raw. That is 4 stands, not 31.

## 3. Model-assisted structuring: **mostly unnecessary**

max's framing was *"might need to just dump it into a frontier model to massage the CSV."* Taken
seriously and measured, the answer is that the deterministic path covers nearly all of it — which is
the cheaper *and* more robust outcome, and matches the existing `extractStandFields` pattern.

| Field | Recommendation | Why |
|---|---|---|
| Address, season, hours, stocking | **Deterministic** | Already separate columns in the profile form. Parsers exist and work. |
| Website / social links | **Deterministic** | Separate columns (20 and 21 of 31). Needs wiring to `farm_links`, not intelligence. |
| Payment methods | **Deterministic first** | 22 map lines, near-uniform `Accepts Cash, Check, Venmo…` shape. Measure a regex over the corpus before reaching for a model. |
| Farm Bucks | **Deterministic** | `parseFarmBucksPolicy` exists and reads VIGA's `*does not accept VIGA Bucks*` name annotation. |
| Remainder prose | **Leave as free text** | It is the farm's voice. Nothing to extract. |
| Weekly-status stock text | **Model seam, if ingested at all** | Only genuinely open-ended field. Gated on decision 1. |

**If any model seam is added**, it must follow the `offerings:propose` shape the prompt correctly
identifies as already-right: model proposes → review artifact → max approves → code commits. The
model must never rewrite a source CSV (golden rule #3, and it destroys provenance).

**Review burden**, honestly: the deterministic path needs max to eyeball roughly **31 stands × 3
fields** (links, payments, remainder) — call it one screen per stand, sortable, with the source line
beside the extracted value. That is a real but bounded review, and it is exactly what
`offerings-proposals.json` already looks like.

**Why it stopped at offerings** (the prompt's question): offerings needed a model because free-text
produce prose maps to a controlled tag vocabulary — a genuine judgement call. The other fields did not
need one, because the profile form already separates them. The stopping point was correct.

## 4. The launch re-ingest plan

**Precondition — who produces what.** The profile form is **still open**, so the file will change
before launch. max must re-export all three CSVs immediately before the ingest; the ones analysed here
are a snapshot, not the launch corpus.

Ordered, with verification **by effect** at each step:

1. **Re-export** the profile CSV and the map CSV from Google. *Verify:* row counts and header match;
   run `probe.ts` — profile must parse to ~31 stands with only the known refusal.
2. **Fingerprint the target database before any write.** Assert the connection resolves to the
   intended database and that the stand table's row count matches expectation. A mistyped connection
   string must fail loudly, not write. Production Postgres is `neondb`; any bulk write there needs
   explicit confirmation from max.
3. **Migrations first, then the code that reads them** (RUNBOOK ordering rule). Required migrations
   depend on decision 4; at minimum, the `inventory_revisions.source` change if that shape is chosen.
4. **Dry-run the join** — `join.ts` equivalent. *Verify:* 0 refusals, and every visitable stand has a
   coordinate. A visitable stand without one is refused, never invented (F-017).
5. **Ingest.** *Verify by effect:* query a known row — Narwhal Farm's hours are populated and its
   description no longer contains `Open:` or an address line; `farm_links` and
   `sales_location_payment_methods` are **non-empty** (they are empty today, so this is a strong check).
6. **Render check.** Load the real card. *Verify:* no "Hours not listed" badge beside stated hours; no
   "Nothing confirmed recently" above a dated update.

**Protecting farmer-owned data — and proving it, not asserting it.** The seed utility is
**insert-only** today (GL-015), which is a genuine constraint: it cannot clobber, but it also cannot
correct. Before the ingest, the plan must enumerate per table which rows are seeded and which are
farmer-authored, and the *proof* is a pre/post diff showing farmer-authored rows byte-identical across
the ingest — not an assertion that insert-only implies safety.

**Rollback.** This is the weakest point and I will not overstate it. With an insert-only utility and
GL-015 open, there is **no clean rollback today** beyond restoring from a snapshot. Any launch ingest
should be preceded by a database snapshot max takes explicitly. Closing GL-015 before the re-ingest
would be the more robust ordering.

**Local vs. production.** Everything through step 4 is verifiable locally against real Postgres from
an empty schema. Steps 5–6 can only be fully checked in production, because the deployed card is the
artifact in question.

## 5. What I could not determine

- **Whether the weekly-status form should be ingested at all.** No parser exists; this is decision 1.
- **Whether the profile form's late submissions change the corpus shape.** The form is open; I
  measured a 2026-07-29 snapshot.
- **The `offerings-proposals.json` cross-row suspicion** (Venison Valley / Aeggy's) that GL-014
  flags — not reached this session. Still owed.
- **Whether a payment-methods regex is sufficient.** I measured *how many* lines (22) and their
  shape, but did not write and score a parser over them. That measurement is owed before committing
  to the deterministic path for payments.

## Decisions max made (2026-08-04)

1. **Source per field — settled by the corrected picture.** The profile form is authoritative for
   details; the map remains the sole source of coordinates. This was the prompt's "biggest decision",
   and finding the profile export largely dissolves it: the seeder already joins this way.
2. **Description: rebuild from the form's columns**, storing only the genuine remainder as free text.
   Retires the `mapDescription ||` line.
3. **Weekly stock form: ingest it.** *(max chose this over leaving it out.)* Requires a new parser for
   the 734-row feed — none exists. See the open question below.
4. **VIGA-sourced facts count as confirmations, recorded via a `source` column** — not by fabricating
   an authorization. Settled in full below; **F-063**.
5. **Timing: the re-ingest runs before any farmer onboards.** This materially de-risks the whole plan:
   with no farmer-authored rows in existence, the insert-only constraint and the missing rollback
   (GL-015) stop being launch blockers for *this* ingest. It also means the ingest must be **ordered
   ahead of** onboarding in the go-live sequence, and that ordering is now a real dependency.

### Decision 4, settled (max, 2026-08-04)

Treating the import as a confirmation is right in product terms — these *are* farmer-stated facts,
and launching with "nothing confirmed recently" above a dated update is dishonest in the other
direction.

It could not be built literally, because `inventory_revisions` requires `proposal_id` and
`published_by_authorization_id`, which assert **a specific authorized handset sent this message**.

**Fabricating those keys was considered and rejected.** At system inception every listing is
VIGA-sourced, so fabrication would make the *entire founding corpus* permanently indistinguishable
from farmer-authored data, at exactly the moment farmers are asked to trust the system. It would also
require inventing authorization rows — consent records for real people — or pointing every stand at a
dummy authorizer.

**Settled shape — a `source` column with two values:**

```
source = 'sms'   → proposal_id + published_by_authorization_id REQUIRED (CHECK)
source = 'viga'  → both NULL; covers the launch import, the weekly form, and admin edits
```

max's reasoning for one `viga` value rather than separating import from admin edit: they are the
**same actor** — a VIGA volunteer typing what a farmer told them, through different doors. One value,
one rule, and F-062's weekly rows need no special case.

**No `admin_actor_id` on the revision row** (max's call). This matches the codebase's existing
convention, verified 2026-08-04: there is no general admin audit log, and attribution lives with the
*action* rather than the data row — `stock_out_reports` carries `reviewed_by_administrator_id` under a
CHECK binding reviewer and timestamp together; `farm_approvals` does the same.

Carry-forward, recorded in **F-065**: an admin inventory-edit workflow must therefore record its own
action, or the edit is unattributable. That belongs to that feature, not to this schema change.

The constraint makes the guarantee for **real** confirmations strictly stronger — what was convention
becomes database-enforced.

Note for whoever builds it: `farm_approvals` is per-farm onboarding approval, **not** per-update
review. VIGA does not approve individual stock updates, and any design implying it does is wrong.

### Consequence of choosing to ingest the weekly form

Ingesting it is a larger scope than the rest of the plan combined, and it is the one place a model
seam is genuinely warranted (`What do you have available` is open-ended prose, 70/70 filled for 2026).
It also carries the same provenance question as decision 4, and more sharply: these are farmers
filling in a **Google Form**, not texting Farm Friend. Whatever decision 4 settles on must cover the
weekly feed too, or the two will disagree about what "confirmed" means.

Sequencing consequence: the weekly-form parser is new work that must land **before** the launch
ingest, which itself must land **before** farmer onboarding. That is now the critical path.

## Proposed rewrite of GL-014

*For max to approve; not yet applied to `docs/GO_LIVE_GUIDE.md`.*

> **GL-014 — Structured listing facts are parsed but never stored, and the description contradicts
> them.**
>
> VIGA supplies three files: a **per-farm profile form** (structured, 31 farms, still open), the
> **volunteer's map transcription** (prose + the only coordinates), and a **weekly stock form** (734
> rows, no parser, not ingested).
>
> The seeder joins the first two correctly — 35 stands, 0 refusals — but at
> `seed-stands.ts:176` it stores the volunteer's prose as the public description whenever a map row
> exists, discarding the form's clean text for display. Consequently:
>
> - `farm_links` and `sales_location_payment_methods` are **both** correctly-shaped tables with **no
>   writer and no reader** (verified in both directions; their only non-schema references are
>   integration-test cleanup lists). Links are the most common structured fact in the corpus — 41
>   lines — and are entirely un-ingested.
> - Hours are stated as their own column for **29/31 farms** but the map folds them into the season
>   line, so the card shows "Hours not listed" beside prose stating the hours.
> - `extractStockUpdate` parses 20 dated update lines and has no consumer, so the card reads "Nothing
>   confirmed recently" above a farmer-dated update.
> - Farm Bucks defaults to `false`, conflating "no" with "not loaded".
>
> **What the prior GL-014 got right:** the payment-methods gap, the Farm Bucks default, and the
> missing public reader for approved offerings.
> **What it missed:** `farm_links` is in the identical un-wired state; the hours contradiction has a
> single-line cause; and the fix is to ingest the profile form's columns rather than to parse the
> transcription harder.
>
> **Not a defect:** `parseFormResponses` (see B-035, closed 2026-08-04) — it reads a real file
> correctly.

## What was run

All scripts are throwaway analysis over the real CSVs, held in the session scratchpad, **not committed**
(the corpus contains personal information and must never enter the repository):

| Script | What it established |
|---|---|
| `probe.ts` | All three files × both parsers. Found the profile export; disproved B-035. |
| `reconcile.ts` | Profile↔map name overlap; profile field fill rates. |
| `names.ts` | Raw name strings from both sources. |
| `join.ts` | Real `joinStandSources` run: 35 stands, 0 refusals, 4 needing supplemental coordinates. |
| `desc.ts` | Classified all 276 description lines; measured the remainder per stand. |
| `conflict.ts` | Cross-source disagreement counts; transcription-residue scan. |
| `concat.ts` | Established that 23/25 season "conflicts" are season+hours concatenation. |

Suite state at audit time: **102 files / 993 tests green**, matching the base commit. No code, schema,
or data was changed by this audit.
