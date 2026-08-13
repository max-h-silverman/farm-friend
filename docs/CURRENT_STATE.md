# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves SMS stock-out reporting, broad-inquiry paging
  and stand details. The customer→farmer stock-out path is closed end to end and proven on real
  handsets: a report can name a published item **or** one of the stand's usual offerings (B-057,
  verified in production by effect), and a clarifying question now completes the report rather
  than dropping it (B-065).
- **The public map link carries a `#map` anchor** (F-110), so a customer texting `MAP` lands on
  VIGA's embed rather than above it. The destination is stated in two places — the `PUBLIC_MAP_URL`
  env var and the core constant customer copy embeds — and `resolvePublicMapUrl` **refuses to
  start** a non-local deployment where they disagree. `infra/terraform.tfvars` is gitignored, so
  another checkout lacks the value; the guard turns that into a failed startup, not a stale link.
- The SMS answer is the one B-062/B-063 rebuilt (PR #107): one entry per stand,
  **name → claims → address**, `In stock (3h ago):` / `May also have:` — `May have:` with no stock
  line above it — a bare `Map:` closing the last page, `Last seen (6d ago)` past the freshness
  threshold, and the stock claim dropped entirely past 28 days. The header states only the count and
  window (`9 matching stands (1-3 of 9)`) and echoes no search term, so a named and a broad request
  over the same facts render byte-identical pages.
- **Stand cards lead with availability.** The card's inventory section always opens with an
  "In stock" heading — confirmed items under it when there are any, "Nothing confirmed recently"
  when there are not — and Typical Offerings always follows. The map search placeholder reads
  `e.g. “eggs”, “flowers”, stand name…`, naming both halves of what the field actually matches.
- **Code owns closure timing outright; a volunteered closure cannot cost a farmer their update**
  (B-058, `e982cf0`, deployed 2026-08-12). Where the message carries no closure evidence, the
  model's `closure` field is stripped before schema validation and dropped from the result — it
  was discarding correct inventory edits three different ways. `kind: "closure"` still clarifies on
  mismatch, since there the closure is the whole payload. Omitted `additions`/`changes` arrays read
  as empty rather than failing the parse.
- **The contact card is served at `/viga-farm-friend`** (B-052). iOS titles a message preview from
  the URL's last path segment — not `Content-Disposition`, not the vCard's `FN`, both of which were
  already correct — so the path is copy, stated once in `CONTACT_CARD_PATH` and derived by every tap
  target. `/api/public/contact-card` binds to the same handler **permanently**: cards already texted
  point there and those threads cannot be edited. Both verified byte-identical in production.
- **Every keyword that establishes messaging now offers the card** — `JOIN`, `START`, and `VIGA`.
  F-100 made VIGA the onboarding word and taught it to the redemption branch but not to this
  condition, so the farmer, who gets months of prompts and alerts from this number, was the only
  sender never offered it. A farmer finishing onboarding gets the card beside their listing-live
  message (max, 2026-08-12); the test is parameterised over the keywords so a fourth cannot repeat it.
- **The farmer join instruction is deleted, not reworded** (B-043). It said "reply START", could not
  be reached by any caller (`routing.ts` passes a literal `authorized: true`, which returns first),
  and named the wrong word after VIGA became the onboarding keyword. A farmer whose SMS box was never
  ticked reads the acknowledgement alone — they wait on a person, and no keyword reaches that.
  Recovery after a carrier opt-out is unaffected: `ALREADY_JOINED_RESPONSE` owns it and names START.
- **Removing a farm now removes it from what customers see** (B-066, deployed 2026-08-13).
  `retireFarm` always wrote `farms.retired_at` correctly, but every public reader
  filtered the *stand's* `retired_at`, which a farm take-down deliberately never writes — so a
  removed farm stayed on the map, reachable by text, in the public pickers, and still publishing.
  `visibleFarms` now carries the farm clause **unconditionally** (`?hidden=true` and listed sender
  hashes grant sight of *fake* farms, never of a removed real one), and all four read surfaces
  inherit it; `confirmInventoryPublication` has its own locked gate returning `farm_retired`. The
  admin console was the only surface that was ever right, which is why F-100's suite stayed green —
  its test asserts through `listStandsForAdministration`.
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
- **A clarifying question holds the report until it is answered** (B-065).
  `pending_stock_out_reports` keeps one open clarification per sender — unique index as the arbiter,
  15-minute expiry judged by the **message's** clock — and the answer completes the report. The
  stand resolver has a third **edit-distance tier reachable only inside an open clarification**; a
  cold message still matches exactly, so a misspelled report with nothing held still asks (max,
  2026-08-11). The allowance scales with word length (under 5 chars exact, 5–7 one edit, 8+ two):
  a flat allowance of two turned "barts" from an exact match into a three-way tie. Resolution sits
  below all deterministic routing, so no held context can reinterpret a `STOP`.
- **No interpolated name can add a line to the stock-out alert** (B-060). `stand_items.display_name`
  and `sales_locations.name` are flattened to one line before rendering. **Provenance is not
  shape**: a Farm Friend-held fact is safe to speak, which says nothing about the characters in it —
  the CHECK admits `"Eggs\n\nVIGA Farm Friend: …"` because it is not blank.
- Neon `neondb` has **42 applied migrations (`0000`–`0041`)**. `0041` adds
  `pending_stock_out_reports`; its three CHECKs are hand-written, since `drizzle-kit generate` does
  not emit them.
- Cloud Run web `farm-friend-web-00074-4hk` and worker `farm-friend-worker-00069-bp6` serve
  immutable digest `sha256:f1f40aae16fd5eb4518943ac33a9da9238b561c7f01df8183990920a3cbaf7ed`,
  built from `main` `3f89523` and deployed 2026-08-13. Plan assertions 60/60 (the only delta was
  the image digest on both services); deploy and served-card assertions pass. The serving digest
  was read back from both services and matches the build. No migration was owed — the ledger
  stands at `0041`. **Production and `main` are level.** This deploy carried B-066, so a removed
  farm no longer reaches the map, the text answers, the public pickers, or publication.
  `/api/public/stands` returned 34 stands and 35 under `?hidden=true` immediately after, so both
  branches of `visibleFarms` are live and neither over-excludes.
- **This repo has no CI.** There are no workflow files and `gh pr checks` reports none, so a green PR
  page means nothing on its own: the local suites are the only gate before a merge.

## Verification

- `main` at B-066: **1,960 unit tests, 945 local integration tests**, typecheck and lint all pass
  (2026-08-13). Live evals are not owed: B-066 touched a SQL visibility fragment and a transactional
  gate — no seam projection, schema, or output contract, and no model call on either path.
- The integration count grew by four, all B-066: a removed farm leaving the map and the SMS answer
  (with the model scripted hostile), restore returning it to both, a stand retired on its own staying
  down across a farm restore, and publication refused while the farm is removed. Each was confirmed
  to fail before the fix, and both fixes were sabotaged to prove the tests catch them.
- The web production build retains the tracked Next configuration/lint warnings (B-008).
- **Migration `when` stamps can land behind their predecessor on this machine.** `0041`'s generated
  stamp was *earlier* than `0040`'s — the local clock runs behind the repo's — and the ordering
  tests caught it. RUNBOOK §Migrations has the fix; expect this on every new migration here.
- Local integration tests need Postgres on `localhost` and are run with `npm run test:integration:local`.
  `psql` is not on the default PATH (`postgresql@16` lives under Homebrew's `opt`), so a bare
  `psql`/`pg_isready` reports "command not found" — that is **not** evidence the database is absent.
- Stub evals pass critical 11/11, advisory 4/4, adversarial 29/29. The real DeepInfra model scores
  containment 5/5, closure 7/7, recall 5/5, quality **21/21** on the B-059 branch (2026-08-12) —
  20/20 twice consecutively once B-058 landed, against 19/20 before it, plus B-059's new corpus
  fixture. Note the per-category
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
- **Live evals still carry one nondeterminism.** Roughly one
  run in three shows a provider error, labelled `[provider error, not a verdict — rerun]` and scored
  as a FAILURE on purpose: the seam returns the same `clarification` shape for "unreachable model"
  and "model declined", so accepting any clarification let an unreachable model read as correct.
- **The stock-out seam is measured on the real corpus** (B-059). `evals/live.ts` carries an
  eleven-case fixture built from production rows, covering the corpus's near-duplicates and split
  comma lists; **11/11 on four consecutive runs**. Where the corpus genuinely admits two answers
  the fixture accepts either. Build any future case from live rows — the ticket's cited examples
  were stale. The score measures the **current** model and expires when it is swapped.
- **B-062 and B-063 are verified on a handset** (max, 2026-08-12): a stand confirmed past the
  freshness threshold reads `Last seen`, the header counts stands rather than rows, it echoes no
  search term, and a stand with no stock line reads `May have`.
- **B-065 is verified on a handset** (max, 2026-08-12): a stock-out misspelling the stand asked
  which stand, the answer completed the report, and the farmer's alert named the item. The held
  clarification survives the round trip on real handsets, not only in test.
- **F-109 is verified on a handset** (max, 2026-08-12): a real scheduled reminder read with the
  stand named in the heading and `(updated Xd ago)` matching the listing's age.
- **B-052 is verified on a handset** (max, 2026-08-12): a bare `VIGA` returned the carrier receipt,
  the offer, and the card previewing as **`viga-farm-friend`**. The same read confirmed the VIGA
  contact-card fix — that sender received no card at all before. As expected and unchangeable:
  the second line reads `Contact Card · 153 bytes` (iOS's own label) over the Cloud Run host,
  which stays until a real domain exists.
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
- **B-066 owes one console check** (now deployed): remove a test farm on `/admin/farms`, then
  confirm it is gone from the map and unreachable by text, and put it back. Both `visibleFarms`
  branches were verified live by stand counts, but no farm was retired at the time, so the
  retirement clause itself is proven only by integration test against production code.
- F-065: attribute every listing change to its actor; F-084: decide participant attribution during onboarding.
- B-008, B-034, B-036, F-101, and B-048 remain planned.
- **VIGA's call, not a code question:** whether the Vashon Island Farmers Market belongs in the
  roster as a farm at all — it is the market itself, not a stand with a farmer to onboard.
- **The 96-hour threshold changed the public map too**, not just SMS — its stale warning now starts
  two days later than before this deploy. Unverified by eye on the live map.
- F-108 (idea): a per-answer `MAP:` link resolving to a view of just those stands. Blocked on nothing;
  it is a new public surface plus a stored per-answer code, so it was kept out of F-107.
- **Unread on a handset: the card on the ONBOARDING path.** The verified read was a returning
  sender with no invitation waiting, so no listing-live message was owed and none came. The farmer
  case — an unredeemed invitation, where the card now arrives beside `renderFarmerOnboardingComplete`
  — is proven by integration test only. It is the path max's 2026-08-12 decision changed.

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
