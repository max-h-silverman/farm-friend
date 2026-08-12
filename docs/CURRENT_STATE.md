# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves SMS stock-out reporting, broad-inquiry paging
  and stand details. F-104's customer→farmer alert path is closed and proven on a real handset.
- Cloud Run web `farm-friend-web-00069-cd9` and worker `farm-friend-worker-00064-wcn` serve
  immutable digest `sha256:9843a3944cf0282683c80e249ec9c4d1f2e9ccc43b6d006f55ffc7b3be3a91a0`,
  built from `main` `f8a0d4c` and deployed 2026-08-11. Plan assertions 60/60 (delta was the image
  digest on both services and nothing else); deploy and served-card assertions pass. The serving
  digest was read back from both services and matches the build.
- The SMS answer is the one B-062/B-063 rebuilt (PR #107): one entry per stand,
  **name → claims → address**, `In stock (3h ago):` / `May also have:` — `May have:` with no stock
  line above it — a bare `Map:` closing the last page, `Last seen (6d ago)` past the freshness
  threshold, and the stock claim dropped entirely past 28 days. The header states only the count and
  window (`9 matching stands (1-3 of 9)`) and echoes no search term, so a named and a broad request
  over the same facts render byte-identical pages.
- **`pending_result_lists.broad` is written and never read.** The one piece of data in the system
  with no consumer, kept deliberately — dropping it is a migration on live data for no behavioral
  gain. Revisit it whenever that table next needs a migration for another reason.
- **Freshness threshold is 96 hours** and governs BOTH surfaces from one constant — the SMS label
  and the public map's stale warning (max, 2026-08-11). `PRODUCT_BRIEF` §freshness owns it.
- The scheduled farmer reminder reads `Items listed for <stand> (updated 7d ago):` over the item
  list, then `Reply SAME to confirm, or let us know what changed.` and the STOP footer (F-109). The
  stamp comes from the shown revision's `published_at` through the same `renderShortElapsed` as the
  SMS answer; a null date renders no recency claim. It names the RECORD, never the stand's current
  stock — a present-tense heading beside a stale timestamp is B-063. `LINK` is offered only on the
  over-ceiling fallback, where the farmer must retype a listing they cannot see.
- **Reminder capacity: 7/4/3 items** inside the two-segment ceiling at F-046's 22–57 characters per
  entry. Past it `scheduledPromptFitsSms` withdraws `SAME` and the farmer retypes. Re-measure before
  adding any line to that message; the opt-out footer alone costs one item at the small-entry end.
- **Four farm descriptions no longer restate their payment chips** (Holmestead, Lavender Hill,
  Littlest Bird, Plum Forest — hand-edited in production 2026-08-12). 0 of 39 descriptions now
  mention payment. Half the four disagreed with the chips by omission, which is why this was four
  reviewed edits and not a parser. Lavender Hill still duplicates its own "Wreaths" sentence.
- Neon `neondb` has **41 applied migrations (`0000`–`0040`)**. `0040` was applied 2026-08-11 ahead of
  the image that reads it and verified by schema effect: `broad`, `stand_total`, and `stand_offset`
  present on `pending_result_lists`, with farm/stand/item counts (39/37/237) unchanged across it.
- **B-057 is live but unproven on the live path.** A stock-out alert can now name one of the stand's
  usual offerings, not only its published inventory. No production report has named one yet — that
  needs a real inbound text, and it is what closes the item.
- **This repo has no CI.** There are no workflow files and `gh pr checks` reports none, so a green PR
  page means nothing on its own: the local suites are the only gate before a merge.

## Verification

- `main`: **1,926 unit tests, 916 local integration tests**, typecheck, and lint pass (2026-08-12).
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
  through in the first place. The same read confirms this session's copy: the header names no
  search term, and a stand with no stock line says `May have`, not `May also have`.
- **The 96-hour threshold changed the public map too**, not just SMS — its stale warning now starts
  two days later than before this deploy. Unverified by eye on the live map.
- **F-109 owes one live check:** read a real scheduled reminder on a handset — the heading must name
  the stand and carry `(updated Xd ago)` matching that listing's true age. No prompt has been sent
  since the change, and the schedule fires at 10:00 stand-local, so this waits for a due slot.
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
