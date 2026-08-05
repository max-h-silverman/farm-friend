# Audit prompt — listing data model, ingestion, and the launch re-seed

> **This is a prompt for a fresh session, not a contract doc.** Paste it whole. It carries its own
> orientation, so the receiving session should not need this conversation. Written 2026-08-04.

## What you are being asked to do

Audit the **listing data pipeline end to end** — what facts VIGA's sources state, which of them the
schema can hold, which the ingestion actually loads, and which the public surfaces read — and
produce **a go-live plan for a single authoritative re-ingest performed at launch**.

Treat everything ingested to date as a **test run**. No currently seeded listing data is precious;
it will be replaced wholesale by a final ingest against the latest VIGA records. That is a
deliberate product decision by max, and it frees the audit from migration-compatibility worries
about existing rows. It does **not** free it from the farmer-owned-data rule — see "The one thing
the re-seed must not do".

Deliver an audit and a plan. **Do not implement.** The one exception is throwaway analysis scripts
over the corpus, which are exploratory and exempt from test-first.

## Why this is being asked now

The public stand card renders an "Additional information" block that is, in practice, an
**un-ingested backlog**: free text containing facts the schema already has structured homes for.
Two real cards, from the deployed map:

**Narwhal Farm** — every line below is in the description, as prose:

| Description line | Structured home | State as of 2026-08-04 |
|---|---|---|
| `10025 SW 212th Street / Vashon, WA, WA 98070` | `sales_locations` address | exists, populated — pure duplication, **and the text is corrupted (`WA, WA`)** |
| `Open: Year Round` | `availability.season` | exists, populated — yet the card's badge reads **"Hours not listed"** |
| `Stocking Days: As needed` | `stocking.cadence` | exists, populated |
| `5/2/2026 Update –Eggs, Jam, Swag` | `extractStockUpdate` (new, `722ddec`) | **parser exists, no consumer** |
| `Accepts Cash, Check, Venmo, VIGA Farm Bucks` | `sales_location_payment_methods` | **table exists; nothing writes or reads it** |
| `Instagram: @NarwhalFarm / Facebook: …` | `farm_links` | exists; population unverified |
| `Hosting Glass on Vashon` | `sales_location_participants` | exists; wiring unverified |
| `Small urban farm offering seasonal goods…` | — | genuinely free text |

Strip every line with a structured home and **roughly one sentence survives**. That is the finding
to test at corpus scale: is the description field mostly a rendering of facts we already hold?

Note the two on-screen contradictions, which are the reason this is a correctness matter and not a
tidiness one:

- the badge says **"Hours not listed"** while the prose says **"Open: Year Round"**;
- the card says **"Nothing confirmed recently"** directly above a farmer-dated stock update.

## Start here — do not re-derive these

These are established. Confirm cheaply if you wish, but do not spend the session rediscovering them.

1. **`sales_location_payment_methods` is a consumer-less empty table.** It is correctly shaped. Its
   only non-schema appearances are test cleanup lists — the suites truncate it, which is why its
   emptiness went unnoticed. Nothing in `seed.ts`, `seed-stands.ts`, or `public-listing.ts` touches
   it. So for payments the gap is **wiring, not schema**. Establish per field which of the two it
   is; do not assume either.

2. **`npm run offerings:propose` already implements model-assisted structuring**, correctly. The
   model reads VIGA's CSV and *proposes* tags into a review artifact; max edits/approves;
   `npm run db:seed-offerings` commits idempotently. Contact details are stripped **before** the
   text reaches the model. This is the pattern to **generalize to other fields**, not a new idea to
   introduce. The audit's question is *why it stopped at offerings*.

3. **`extractStockUpdate` (committed, `722ddec`) parses `"5/26/2026 Update: salad, kale"` into a
   date plus items.** It has **no consumer**, deliberately. How a sheet-typed date is recorded is an
   open decision this audit should absorb — see "Decisions this audit must make", item 3.

4. **GL-014 in `docs/GO_LIVE_GUIDE.md` already documents much of this gap** ("payment methods are
   never loaded", "approved offerings have no public reader", "Farm Bucks defaults to `false`,
   conflating 'no' with 'not loaded'"). **Extend GL-014; do not open a rival item beside it.** Your
   plan should read as a superseding, wider version of it, and should say plainly what GL-014 got
   right and what it missed.

## Ground rules specific to this audit

- **Measure against the real corpus, not the code.** This is a standing project rule and it is the
  rule that would have caught the empty payment table. Every claim about "the data" must come from
  running something over the actual CSVs. Reasoning from the parser about what the corpus contains
  is exactly the failure mode to avoid.
- **You need the source CSVs from max** (`--form <form.csv> --map <map.csv>`). They are not in the
  repo. **Ask for them before starting** — most of this audit is not doable without them, and a
  version done from the code alone would be worth less than nothing because it would look complete.
- **A doc, a comment, a test name, and a green check are claims, not proof.** GL-014's bullets are
  leads to reconfirm, not findings to restate.
- Read `CLAUDE.md`, `docs/CURRENT_STATE.md`, `docs/DATA_ARCHITECTURE.md`, and
  `docs/GO_LIVE_GUIDE.md` §GL-014/GL-015 to orient. Do **not** load the historical records.

## The one thing the re-seed must not do

**A re-ingest must never overwrite a fact a farmer owns.** By launch, some listings may carry real
farmer-sent confirmations, farmer-edited hours, or a `STOP`. VIGA's spreadsheet is *stale relative
to those*, and a wholesale re-seed that clobbers them would silently revert a farmer's own words to
a volunteer's typing — the exact inversion of golden rule #1.

"Everything so far is a test run" licenses replacing **seeded** data. It does not license replacing
**farmer-authored** data. The plan must state, per table, which of the two each row is, and how the
re-ingest tells them apart. GL-015 already names this ("Re-running the seed must never overwrite
farmer-owned live facts") and the seed utility is currently **insert-only**, which is a real
constraint on any re-ingest design.

## What to produce

### 1. A corpus-level field inventory

For **every distinct fact type** appearing across the real 31-stand corpus (not just the eight rows
tabled above — derive the list from the data):

- how often it appears, and in which source (form CSV, map CSV, or both);
- whether a structured home exists in the schema;
- whether ingestion populates it;
- whether any surface reads it (public web **and** SMS — GL-014 flags these as diverging);
- how it is currently rendered to a customer, if at all;
- **whether the same fact appears in two places that can disagree**, and which wins today.

Include the messy reality: `WA, WA 98070`, `–` vs `-` in dated lines, casing drift between
`"Eggs"` in prose and `"eggs"` as a tag, and the suspicious cross-row-looking text in
`maps/offerings-proposals.json` that GL-014 already flags (Venison Valley / Aeggy's).

### 2. A verdict on the description field

Answer directly: **should the customer-visible description be stored raw, or derived?**

The hypothesis to test is that it should be **rendered from structured facts plus a genuine
remainder** — so a fact appears once, in one voice, and cannot contradict its own structured twin.
Sketch what the remainder actually looks like across the corpus once every structured fact is
subtracted. If the remainder is consistently one or two sentences, say so; if it turns out to be
rich and varied, say that instead and drop the hypothesis. **Report what the corpus shows, not what
this prompt expects.**

Include the cost: a derived description means the ingest must classify every line, and anything it
fails to classify must go somewhere visible rather than be silently dropped.

### 3. A model-assisted structuring proposal

max's framing: *"might need to just dump it into a frontier model to massage the CSV before the
final ingestion."*

Take that seriously — and shape it to the architecture:

- **The model must not rewrite the source CSV.** A model-authored source file makes the model the
  author of durable data, violating golden rule #3 and destroying provenance. The existing
  `offerings:propose` shape is the correct one: **model proposes → review artifact → human approves
  → code commits.** Same outcome, provenance intact, and it fails safe if the model is swapped for
  a weaker one.
- Specify which fields are good candidates (payment methods and social links look mechanical;
  hours and seasons are already parsed deterministically and may not want a model at all).
- **Deterministic first.** Where a regex over the real corpus is sufficient and verifiable, prefer
  it — that is the existing `extractStandFields` pattern, and it does not need evals.
- For anything that does get a model seam: name the projection, the output schema, and the evals
  owed. Any new or changed seam requires `npm run evals:live`.
- State the review burden honestly: how many stands × fields would max have to eyeball, and what
  the artifact should look like to make that fast.

### 4. The launch re-ingest plan

A **runnable, ordered** plan, not a description of one:

- exact command sequence, in order, with what to verify **by effect** after each step (a row, a
  rendered card — never an exit code);
- what must be true of the CSVs before starting, and who produces them;
- how farmer-owned data is protected (see above) — and how that is *proven*, not asserted;
- migrations required, if any, and their ordering against the code that reads them (the RUNBOOK's
  ordering rule: migration first, then the code that reads it);
- **the rollback**: what happens if the ingest produces something wrong, given the seed utility is
  insert-only and GL-015 (correction path) is still open;
- what is verified locally versus what can only be checked in production;
- a **fingerprint/guard** so a mistyped connection string fails loudly rather than writing to the
  wrong database. Production Postgres is `neondb`; treat any destructive or bulk-write step as
  requiring explicit confirmation from max.

### 5. Decisions max must make

List them explicitly, each as **one question with named options** — max reads them cold, without
having followed your reasoning. At minimum:

1. **Derived vs. raw description** (from §2).
2. **Which fields get a model seam** vs. deterministic parsing vs. left as free text (from §3).
3. **How a sheet-typed date is recorded.** Live context: max has already decided that
   `"5/26/2026 Update: …"` should count as a **confirmation** so the card can say "Confirmed 26 May
   2026" instead of contradicting itself. The open part is *storage*. A published confirmation
   currently requires `inventory_revisions` rows with `proposal_id` and
   `published_by_authorization_id` — which assert **a specific handset was authorized and sent
   this**. A spreadsheet date has no handset and no message, so those two keys would be fabricated
   attestations about identifiable people, and the audit trail could no longer distinguish a real
   confirmation from a typed one. **Do not fabricate them.** The shape previously proposed to max,
   which he has not yet accepted, was: add a `source` column and make **only** those two keys
   nullable under a CHECK constraint that still requires the full chain when
   `source = 'sms'`. That makes the guarantee explicit and stronger for real confirmations while
   letting a sheet-sourced date exist honestly. Re-derive this independently; if you find a better
   shape, propose it. **Note:** `farm_approvals` is a *per-farm onboarding* approval, not a
   per-update review — VIGA does **not** approve individual stock updates, and any design implying
   it does is wrong.
4. **Re-ingest timing** relative to farmer onboarding — the later it runs, the more farmer-owned
   data it must avoid clobbering.

## Deliverables

- The audit written to `docs/` as a dated historical record (e.g.
  `LISTING_INGESTION_AUDIT_2026-08-XX.md`), matching the existing handoff convention — not a
  contract doc, and not an edit to one.
- A proposed **rewrite of GL-014** superseding the current text, for max to approve.
- `/pm` items for the implementation tranches, sequenced.
- Decisions surfaced per §5, using `AskUserQuestion` — one decision per question, plain English,
  options that stand alone without their descriptions.

## Definition of done for the audit itself

- Every quantitative claim traces to something you ran over the real CSVs, and you say what you ran.
- Every "this is not wired" claim is verified in **both** directions — the write path and the read
  path — because a negative from one lookup is not proof of absence.
- What you could **not** determine is stated plainly, with what it would take to settle it.
- No implementation, no schema changes, no seeding. Analysis scripts are fine and are exempt from
  test-first; say so where you used one.
