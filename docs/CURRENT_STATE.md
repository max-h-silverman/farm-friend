# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves SMS stock-out reporting, broad-inquiry paging
  and stand details. F-104's customer→farmer alert path is closed and proven on a real handset.
- Cloud Run serves the SMS answer rebuilt by B-062/B-063 (PR #107, 2026-08-11): one entry per
  stand, **name → claims → address**, `In stock (3h ago):` / `May also have:` in sentence case,
  a header naming the query and counting **stands**, and a bare `Map:` closing the last page.
  Past the freshness threshold the label reads `Last seen (6d ago)`; past 28 days the stock claim
  drops and the stand falls back to its usual offerings.
- **Freshness threshold is 96 hours** and governs BOTH surfaces from one constant — the SMS label
  and the public map's stale warning (max, 2026-08-11). `PRODUCT_BRIEF` §freshness owns it.
- Neon `neondb` has **41 applied migrations (`0000`–`0040`)**. `0040` adds `broad`, `stand_total`,
  and `stand_offset` to `pending_result_lists`, applied ahead of the image that reads them.
- **B-057 is live but unproven on the live path.** A stock-out alert can now name one of the stand's
  usual offerings, not only its published inventory. No production report has named one yet — that
  needs a real inbound text, and it is what closes the item.
- **This repo has no CI.** There are no workflow files and `gh pr checks` reports none, so a green PR
  page means nothing on its own: the local suites are the only gate before a merge.

## Verification

- `main`: **1,922 unit tests, 916 local integration tests**, typecheck, and lint pass (2026-08-11).
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
- **B-062 and B-063 owe one live check:** text a question whose answer includes a stand confirmed
  more than four days ago, and read the label — it must say `Last seen`, and the header must count
  stands. Both are deployed but unread on a handset, which is exactly how the defects they fix got
  through in the first place.
- **The 96-hour threshold changed the public map too**, not just SMS — its stale warning now starts
  two days later than before this deploy. Unverified by eye on the live map.
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
