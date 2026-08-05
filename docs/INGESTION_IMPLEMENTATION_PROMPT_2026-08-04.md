# Implementation prompt — the listing ingestion tranche (F-063 → F-061 → F-062 → F-064)

> **A prompt for a fresh session, not a contract doc.** Paste it whole. Written 2026-08-04, after the
> F-059 audit. It carries its own orientation.

## What you are being asked to do

Implement the four items the listing ingestion audit produced, **in dependency order**. This is
build work, not analysis — the audit is done and its findings are settled.

**Orient first:** `CLAUDE.md`, `docs/CURRENT_STATE.md`, and
**[LISTING_INGESTION_AUDIT_2026-08-04.md](LISTING_INGESTION_AUDIT_2026-08-04.md)** — that last one is
the reasoning behind everything below and answers most "why" questions. Read the item files with
`/pm show F-063` etc. Do **not** load the historical records.

**Base state:** `main` at `45c0370`, clean, deployed (web `farm-friend-web-00029-bgf`). 993 unit
tests green. Branch `f-059-listing-ingestion-audit` carries the audit docs and is **unmerged** — merge
it or branch from it, don't orphan it.

Standing rules that matter here: test-first; **never work on `main`**; don't commit, push, or deploy
unless asked; verify by effect, never by exit code.

## Do not re-derive these

Established by the audit against the real corpus. Confirm cheaply if you like, but don't spend the
session rediscovering them.

1. **VIGA supplies three CSVs, not two.** All in `~/downloads/`, all containing personal information —
   **never commit them, never copy them into the repo**:
   - `2026 Farm Stand Information (Responses) - Form Responses 1.csv` — **the profile form**. Parses
     via `parseFormResponses` to 31 stands + 1 documented refusal. **Still open**, so it changes.
   - `VIGA Farmstand Map- VIGA Member Farm Stands (1).csv` — the volunteer's transcription. 31 stands.
     **The only source of coordinates.**
   - `Farm Stand Weekly Status (Responses) 2024 - Form Responses 1.csv` — 734 rows, 49 farms, 4
     seasons. **No parser exists.**
2. **B-035 is closed wont-fix. `parseFormResponses` is correct** — do not rewrite or delete it. Nor
   `SUPPLEMENTAL_COORDINATES`, which correctly holds the four form-only farms.
3. **`joinStandSources` works**: 35 stands, 0 refusals, every name variant resolved, no false pairs.
   Keep it. Its header comment explains why the key is exact rather than fuzzy — respect that.
4. **`farm_links` and `sales_location_payment_methods` are both consumer-less** — verified in both
   directions; their only non-schema references are integration-test cleanup lists.
5. **The corpus numbers** (from scripts over the real CSVs): 276 description lines, 68% with a
   structured home, **0/31 stands with an empty remainder** (median 16 words, max 98). Hours stated
   as their own column for **29/31** farms. 41 link lines, 22 payment lines, 20 dated stock updates.

---

## 1. F-063 — the `source` column

**Do this first. F-062 and F-064 both block on it.**

Settled shape:

```
source = 'sms'   → proposal_id + published_by_authorization_id REQUIRED (CHECK constraint)
source = 'viga'  → both NULL; covers the launch import, the weekly form, and admin edits
```

Two values, not three: the import and an admin edit are the **same actor** — a VIGA volunteer typing
what a farmer told them. **No `admin_actor_id` on the revision row** — attribution lives with the
action, matching `stock_out_reports.reviewed_by_administrator_id` and `farm_approvals`.

Why not just fabricate the two keys: at inception every listing is VIGA-sourced, so fabrication makes
the entire founding corpus permanently indistinguishable from farmer-authored data, and would require
inventing consent records for real people.

**Owed:**
- Migration **before** the code that reads it (RUNBOOK ordering rule).
- **Sabotage both directions**: a `viga` row carrying a `proposal_id` must be refused by Postgres; an
  `sms` row missing `published_by_authorization_id` must be refused. A CHECK that passes on NULL is
  the classic silent-inversion failure — assert the *refusal*, not that the insert returned.
- Existing SMS confirmations still satisfy the constraint.
- Verify the migration **by effect** against a freshly migrated database (B-022): the column exists,
  the constraint is present, a violating insert genuinely fails.

## 2. F-061 — rebuild the description from the form's columns

Independent of F-063. **The visible payoff** — it kills both on-screen contradictions.

The defect is one line, `packages/db/scripts/seed-stands.ts:176`:

```ts
const publicDescription = mapDescription || [ ...form fields... ].join("\n");
```

When a map row exists (27 of 35 stands) the volunteer's prose wins and the form's clean columns are
discarded for display — while still being parsed for the structured fields. Hence "Hours not listed"
beside prose stating the hours.

**Build:** render structured facts from the profile form's own columns; store **only the genuine
remainder** as free text.

**The remainder is real content and must be preserved** — it's the farm's voice (a land
acknowledgement, WSDA licensing, "we place a sign at the bottom of the driveway"). The audit
disconfirmed the "description is mostly duplication" hypothesis: 0/31 stands have an empty remainder.
Do not derive it away.

**Also wire the two dead tables** — `farm_links` (41 lines; website/social are separate form columns)
and `sales_location_payment_methods` (22 lines). Both need a **writer and a reader**; a populated
table nothing reads is still invisible.

Deterministic throughout — **no model seam**, because the form supplies these pre-separated. Where a
regex is needed (payments), **measure it over the real corpus before defending it**.

**Watch:** the 4 map-only stands have no form row and still need a correct description. And **B-024**
— the no-public-address instruction must survive; don't let this republish an address a farmer asked
us to hide. Handle it in this tranche.

## 3. F-062 — ingest the weekly stock form

Largest piece. Needs F-063 settled so provenance is recorded consistently.

Build a parser for the weekly-status format, tested against the real file. Join by the existing
`matchStandName` key. Stock text becomes offerings/inventory **through the existing review path**, not
a direct write. Rows write `source = 'viga'`.

**The only place a model seam is warranted** — `What do you have available` is open-ended prose,
70/70 filled for 2026. If you add one: name the projection and output schema, write the evals, and run
**`npm run evals:live`**. A cooperative stub cannot detect a prompt describing the wrong job.

Superseded weekly rows must not overwrite newer farmer-sent facts.

## 4. F-064 — the launch ingest

**Runs before any farmer onboards** (max's decision). That's what makes the insert-only seed utility
and the open correction path (GL-015) acceptable here: with no farmer-authored rows in existence,
there's nothing to clobber. **This ordering is a real dependency — do not let onboarding start first.**

Ordered, verifying **by effect** at each step:

1. **Re-export all three CSVs.** The profile form is still open; the audit's numbers are a 2026-07-29
   snapshot. Verify counts and headers parse before any write.
2. **Fingerprint the target database before any write**, so a mistyped connection string fails loudly.
   Production Postgres is `neondb`. **Any bulk write there needs explicit confirmation from max.**
3. **Take a database snapshot.** Rollback is the weak point — insert-only utility, GL-015 open — so
   the snapshot *is* the rollback.
4. Migrations first, then the code reading them.
5. Dry-run the join: 0 refusals, every visitable stand has a coordinate. Never invent one (F-017).
6. Ingest. **Verify by effect:** `farm_links` and `sales_location_payment_methods` are **non-empty**
   (they're empty today — a strong check); a known row has populated hours.
7. **Render check on a real card:** no "Hours not listed" beside stated hours; no "Nothing confirmed
   recently" above a dated update.

## Definition of done

- Each item's acceptance criteria met (`/pm show <ID>`).
- `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run lint` pass — **run
  sequentially, never chained**; capture a failing test name before rerunning.
- `npm run evals:live` if and only if a model seam was added or changed (F-062).
- Sabotage every new test and confirm it fails; say which sabotages you ran.
- `/pm status` updated per item; `/session-wrap` before clearing context.
- Report honestly what ran, what didn't, and what's verified only locally versus in production.

## Open questions to raise rather than guess

- **F-062 scope**: ingest all four seasons, or only 2026? The audit didn't settle it.
- **Payment-methods parsing**: the audit measured *how many* payment lines exist (22) and their shape,
  but never scored a parser over them. Measure before committing to the deterministic path.
- **`offerings-proposals.json` cross-row suspicion** (Venison Valley / Aeggy's) that GL-014 flags —
  never reached. Still owed.
