# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves SMS stock-out reporting, broad-inquiry paging
  and stand details. F-104's customer→farmer alert path is closed and proven on a real handset.
- Cloud Run web `farm-friend-web-00067-mlf` and worker `farm-friend-worker-00062-qlw` serve immutable
  digest `sha256:47cc0e3fe54599a178e5b24358d3938f0643b91b82e266dc1bcc29b242d6b1a0`, built from `main`
  `99db95d` and deployed 2026-08-11. Plan assertions 60/60; deploy and served-card assertions pass.
  The serving digest was read back and matches the build.
- Neon `neondb` has **40 applied migrations (`0000`–`0039`)**. `0039` was applied 2026-08-11 ahead of
  the image that reads it and verified by schema effect: `referenced_stand_item_id` present and
  nullable, both new constraints present, and farm/stand/item/report counts unchanged across it.
- **B-057 is live but unproven on the live path.** A stock-out alert can now name one of the stand's
  usual offerings, not only its published inventory. No production report has named one yet — that
  needs a real inbound text, and it is what closes the item.
- **The SMS answer format is LIVE and read on a handset** (F-107 + B-061, both closed 2026-08-11).
  What production currently serves: one entry per stand — name, street address, `IN STOCK (23h ago): …`,
  `MAYBE: …`. A broad question ("what do you have") was **answered rather than deflected**, proving
  B-061's code check on the real inbound path. The `MAYBE:` line is still unproven live — all three
  stands in that reply were confirmed-only.
  **That reply is also what B-062/B-063 rebuilt**, so the deployed wording above is one deploy
  behind the branch: `In stock` / `May also have` in sentence case, name → claims → address, a
  header naming the query, `Last seen` past the freshness threshold.
- **This repo has no CI.** There are no workflow files and `gh pr checks` reports none, so a green PR
  page means nothing on its own: the local suites are the only gate before a merge.

## Verification

- `main`: 1,877 unit tests, **913** local integration tests, typecheck, and lint pass (2026-08-11).
  Branch `b-062-sms-answer-formatting` (unmerged, unpushed): **1,922 unit, 916 integration**,
  typecheck, lint, and stub evals (critical 11/11, advisory 4/4, adversarial 29/29). Migration 0040
  applied to a fresh database and confirmed by reading the columns back, with a no-op rerun.
  The web production build retains the tracked Next configuration/lint warnings (B-008).
- Local integration tests need Postgres on `localhost` and are run with `npm run test:integration:local`.
  `psql` is not on the default PATH (`postgresql@16` lives under Homebrew's `opt`), so a bare
  `psql`/`pg_isready` reports "command not found" — that is **not** evidence the database is absent.
- Stub evals pass critical 11/11, advisory 4/4, adversarial 29/29. The real DeepInfra model scores
  containment 5/5, closure 7/7, recall 5/5, quality **19/20** (2026-08-11). Note the per-category
  counts exceed the fixture count — several fixtures score multiple cases. B-057 added one quality
  fixture, proving the stock-out seam picks a usual offering out of a mixed candidate list; it passed
  7/7 runs.
- **Broad availability questions are answered by CODE, not by the prompt** (B-061 defect 4, closed
  2026-08-11). The model classifies "what do you have" as `ambiguous` **even when that exact phrase is
  written into the instruction as never-ambiguous** — measured 10 runs out of 10, and 0/7 across the
  family in the deploy-day live run. `isBroadAvailabilityRequest`
  (`packages/core/src/inquiry/broad-request.ts`) overrides `ambiguous` toward answering when a message
  has shopping grammar and names no product; measured 27/27 end to end where the model alone was 5/21.
  The live fixture now scores "N model + M code" so a regression in the check surfaces as an unrescued
  case instead of hiding behind the model's score. **Do not "fix" that fixture by trimming it to the
  cases the model passes — the failing phrasings are what the code check exists for.**
  The check holds **no food or farm vocabulary** and a test asserts that against its own source; a miss
  is closed by extending the grammar, never by adding a crop word.
- **Live evals are nondeterministic** in two distinct ways, and both must be held apart. Roughly one
  run in three shows a provider error, labelled `[provider error, not a verdict — rerun]` and scored
  as a FAILURE on purpose: the seam returns the same `clarification` shape for "unreachable model"
  and "model declined", so accepting any clarification let an unreachable model read as correct.
  Separately, one B-056 fixture returns real but wrong verdicts in ~2 of 7 runs (B-058) — so a
  single live run cannot distinguish a regression from that noise.
- Deployment assertions confirm both revisions are newer than every mounted secret; the served contact card
  has the expected E.164 suffix, 153 bytes, CRLF-only lines, and all seven required properties.

- `DEEPINFRA_API_KEY` runs on **VIGA's own account** (Secret Manager v3, 2026-08-11). Proven by
  effect in production; the old personal-account key is revoked and returns 401.

## Standing facts a cold start needs

- Farmer onboarding sends the farmer to text **VIGA** from their stated handset; `START` remains the
  carrier recovery fallback. Telnyx sends the opt-in receipt; Farm Friend sends only the listing-live link.
- Onboarding validates on submit, returns the farmer to the earliest incomplete step, and shows only that
  step's missing fields. The address action is **Save**; unresolved addresses are refused, never approximated.
- VIGA Farm Bucks is a farmer-owned acceptance claim, stored apart from the payment-method list. `LINK`,
  `STAND`, and `SETTINGS` retain their existing farmer update behavior.
- A dated stock claim has exactly one provenance: `sms`, `web`, or `viga`. Onboarding inventory waits for
  verified handset redemption before publication.
- `visitability` controls the map invitation. A contact-only farm may be placed, but gets no directions link.
- Broad availability inquiries expose only the first three selection candidates to the model; code keeps the
  validated remainder in deterministic order for `MORE`. A broad request is recognized by **code** when the
  model calls it ambiguous, so the customer is answered whichever model is installed.

## Open before go-live

- Finish physical-handset checks: farmer onboarding, consent, vCard, paged SMS, administrator/settings,
  and F-105’s stand-detail sheet at phone width in both appearances; verify VIGA’s Squarespace embeds and
  the `?hidden=true` behavior.
- F-065: attribute every listing change to its actor; F-084: decide participant attribution during onboarding.
- B-008, B-034, B-036, F-101, and B-048 remain planned.
- **VIGA's call, not a code question:** whether the Vashon Island Farmers Market belongs in the
  roster as a farm at all — it is the market itself, not a stand with a farmer to onboard.
- **B-057 owes one live check:** text a stock-out for an item a stand carries as a usual offering
  but does not currently publish (Pinecone Gardens' eggs is the original case), then confirm the
  farmer's alert names it and the report stored `referenced_stand_item_id`. Until then the fix is
  proven only by test.
- B-058: one B-056 live fixture returns wrong verdicts in ~2 of 7 runs — fix or make it score
  `correct/total`, but do not loosen it until it always passes.
- **The three defects the live check exposed** (2026-08-11, from one real "what do you have"
  reply — none was a regression of B-061 or F-107). **All resolved in code on branch
  `b-062-sms-answer-formatting`, none deployed:**
  - **B-062** (fixed, 4390e08): the count said "1-3 of 45" over 35 stands — it counted facts while
    the renderer merged them into per-stand entries, and a dual-basis stand could repeat across a
    MORE. Both counts are stands now; migration **0040** stores `stand_total`, `stand_offset`, and
    `broad`. Shipped with the answer-format rebuild max specified: name → claims → address,
    sentence-case labels, a header naming the query, a bare `Map:` close.
  - **B-063** (fixed, 43a0b65 + 6ba89e1): `IN STOCK (16d ago)` now reads `Last seen (16d ago)` —
    the label carries the staleness, costing one character where the old suffix cost twenty. Past
    28 days the stock claim drops entirely, as the map already did. Ranking is three tiers: fresh
    confirmation, usual offerings, stale confirmation.
  - **B-064: closed wont-fix** (max, 2026-08-11). "Veggie" is the farmer's own word, not a
    truncation — so their listing stands (golden rule 1), and the renderer floor this item
    proposed would have silently suppressed a farmer's deliberate wording.
- **The freshness threshold is now 96 hours, up from 48** (max, 2026-08-11, commit 6ba89e1).
  It governs BOTH surfaces from one constant, so **the deployed map's stale warning will start two
  days later once this ships** — a change to live behaviour, chosen over splitting the number.
  `PRODUCT_BRIEF` §freshness records it; `answer.test.ts` now pins the value, which nothing did
  before (the old test was written against the constant and passed at any number).
- **Migration 0040 is committed but NOT applied to production.** Applying it must precede or
  accompany the deploy: the new answer path writes `stand_total` and `broad` on every saved paging
  list, and an image reading columns that do not exist yet would fail on any multi-page answer.
- F-108 (idea): a per-answer `MAP:` link resolving to a view of just those stands. Blocked on nothing;
  it is a new public surface plus a stored per-answer code, so it was kept out of F-107.
- B-059, B-060: B-057's follow-ups — measure the seam against the corpus's genuinely awkward lists
  (Tian Tian's "bok choy" vs "Baby bok choy"; Bart's Cart's overlapping plant items), and prove by
  sabotage that a hostile `stand_items.display_name` stays inert in the farmer's alert. Both are
  quality risks: a wrong pick names the wrong item, and nothing published moves either way.

**Unverified at phone width** — jsdom reports every element as zero-sized, so these are covered by
tests but not by eye: the farmer agreement step, F-067's onboarding listing form and its map,
F-090's four-step wizard, F-097's restyled surfaces (the settings panel, the saved-confirmation
screen, the onboarding cadence control, the map card's recency caption), and **F-100's three admin
tabs** — the farm directory row collapses to three columns under 34rem, unchecked by eye. Per-tranche
browser checks are **not tracked here** (max, 2026-08-05): he runs a browser pass himself before
go-live.

The 2026-08-10 farm-card hierarchy pass was measured in Chrome (computed styles, no overflow at
390px) against **the components rendered on the real stylesheet, not `/admin/farms` itself** — admin
login and seeded farms were never exercised. A multi-stand farm, a removed farm, and a stand reading
"off the map with the farm" are unseen in that new styling.

## Traps worth not rediscovering

These are now stated where the work happens — **RUNBOOK.md** owns them: the migration-generator traps
(§Migrations), the deploy and secret-rotation traps (§Deploy, §Credential rotation), the corpus and
seeding traps (§Seeding), and production Neon's reachability from a dev machine (§Failure triage).
Codebase-level gotchas live in **DEVELOPMENT.md** §gotchas.
