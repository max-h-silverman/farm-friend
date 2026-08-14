# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves SMS stock-out reporting, broad-inquiry paging
  and stand details. The customer→farmer stock-out path is closed end to end and proven on real
  handsets: a report can name a published item **or** one of the stand's usual offerings (B-057,
  verified in production by effect), and a clarifying question now completes the report rather
  than dropping it (B-065).
- **The public map link carries a `#map` anchor** (F-110). The destination is stated twice — the
  `PUBLIC_MAP_URL` env var and the core constant customer copy embeds — and `resolvePublicMapUrl`
  **refuses to start** a non-local deployment where they disagree. `infra/terraform.tfvars` is
  gitignored, so another checkout lacks the value and gets a failed startup, not a stale link.
- **The SMS answer format is B-062/B-063's** (PR #107): one entry per stand,
  **name → claims → address**, `In stock (3h ago):` / `May also have:` — `May have:` with no stock
  line above it — a bare `Map:` closing the last page, `Last seen (6d ago)` past the freshness
  threshold, and the stock claim dropped entirely past 28 days. The header states only count and
  window and echoes no search term, so a named and a broad request over the same facts render
  byte-identical pages.
- **Stand cards lead with availability.** The inventory section always opens with an "In stock"
  heading — confirmed items under it, or "Nothing confirmed recently" — and Typical Offerings
  always follows.
- **Code owns closure timing outright** (B-058). Where a message carries no closure evidence the
  model's `closure` field is stripped before validation; `kind: "closure"` still clarifies on
  mismatch. Omitted `additions`/`changes` arrays read as empty rather than failing the parse.
- **The contact card is served at `/viga-farm-friend`** (B-052) — iOS titles a message preview from
  the URL's last path segment, so the path is copy, stated once in `CONTACT_CARD_PATH`.
  `/api/public/contact-card` binds to the same handler **permanently**: cards already texted point
  there and those threads cannot be edited.
- **Every keyword that establishes messaging offers the card** — `JOIN`, `START`, `VIGA` — and a
  farmer finishing onboarding gets it beside their listing-live message (max, 2026-08-12). The test
  is parameterised over the keywords so a fourth cannot regress it.
- **A farmer whose SMS box was never ticked reads the acknowledgement alone** (B-043) — no keyword
  reaches that; they wait on a person. Carrier-opt-out recovery is separate:
  `ALREADY_JOINED_RESPONSE` owns it and names START.
- **A removed farm leaves every public surface** (B-066). `visibleFarms` carries the farm clause
  **unconditionally** — `?hidden=true` and listed sender hashes grant sight of *fake* farms, never
  of a removed real one — and all four read surfaces inherit it; `confirmInventoryPublication` has
  its own locked gate returning `farm_retired`.
- **`stand_items` holds one item per row, corpus-wide** (B-067, fixed in production 2026-08-13,
  data-only). One row had held a whole nine-item offerings list as a single string. Zero
  comma-holding rows remain; `scripts/split-merged-stand-items.ts` finds the shape if an ingest
  reintroduces it.
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
- Cloud Run web `farm-friend-web-00075-bfw` and worker `farm-friend-worker-00070-7rw` serve
  immutable digest `sha256:449e072cb4afdbef88996b382e06ef5c5e3068fb8799af3ced03f9af2c2d62f4`,
  built from `main` `b187b7e` and deployed 2026-08-13. Serving digests were read back from both
  services and match the build; migration ledger stands at `0041` and none was owed.
  **Production carries F-111 Phase 2 and is level with `main`.**
- **This repo has no CI.** There are no workflow files and `gh pr checks` reports none, so a green PR
  page means nothing on its own: the local suites are the only gate before a merge.
- **F-111 Phase 2 is live.** One request classifier replaces the two sender-split intent seams,
  which are deleted. Order: deterministic routing 1–10 → the open stock-out clarification (B-065,
  now for **any** sender) → authority read from `farmer_authorizations` and **not** given to the
  model → one classifier call → a switch over six categories. A stand resolves only inside the arms
  that need one; step 11's pre-classification binding is gone. **Who may publish is the access fork
  in code** — customer → report, farmer holding the stand (or naming none) → publish, farmer
  without access → report (B-053) — and no enum value can express authority.
- **A stand name must be at least half-covered to bind** (Phase 2b, `meetsDistinctiveWordBar` in
  `packages/core/src/inquiry/stand-name-match.ts`). Closes the `open` → Open Gate defect at the
  matcher. **Known cost:** 33 single-word partials of longer names now ask which stand instead of
  binding — `morgan` no longer reaches Morgan Hill. Full names are unaffected.
- **`unclear` and the outage reply are different messages**, and must stay so: `unclear` says the
  sender's message was unhandleable; a failed classifier call says our side failed and blames
  nobody's wording (B-049). There is no fallback category.
- **B-068/B-069 are implemented and fully verified locally, not deployed.** The first classifier sees
  the message alone and returns a strict route-specific operation; inventory/payment alone use one
  value-only catalog matcher. Code owns stand resolution, expansion, ordering, paging, and copy.
- **Both closed SMS defects are unverified on a handset** — see Open before go-live.

## Verification

- Current branch: **2,036 unit tests and 953 local integration tests (63 files)**; typecheck, lint,
  production build, and all suites pass (2026-08-13). Scripted evals: critical 11/11, advisory 4/4,
  adversarial 19/19.
- **Live evals are required for any seam change and pass** (2026-08-13): containment 4/4, closure
  7/7, quality 16/16, operation 5/5, catalog 7/7. The full top-level corpus remains 52/53 with only
  the pre-existing `what is viga` miss; broad/inventory is 13/13, other operations 7/7,
  second-person boundaries 5/5, and VIGA/domain handling 5/5.
- **The `DATABASE_URL` in Secret Manager is production Neon**, and the integration suite creates
  and drops a database per file — it must never point there. See the local-Postgres line below.
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
- **Broad availability is a first-class classification result** (B-069). Call #1 sees no catalog, so
  catalog contents cannot change broad into inventory. The old shopping-grammar override and private
  vocabulary are deleted; the live boundary fixture passes all 13 cases.
- **Live evals still carry one nondeterminism.** Roughly one
  run in three shows a provider error, labelled `[provider error, not a verdict — rerun]` and scored
  as a FAILURE on purpose: the seam returns the same `clarification` shape for "unreachable model"
  and "model declined", so accepting any clarification let an unreachable model read as correct.
- **The stock-out seam is measured on the real corpus** (B-059) — an eleven-case `evals/live.ts`
  fixture built from production rows. Build any future case from live rows; a ticket's cited
  examples go stale. The score measures the **current** model and expires when it is swapped.
- **Verified on real handsets (max, 2026-08-12):** B-062/B-063's answer format, B-065's held
  clarification surviving the round trip, F-109's scheduled reminder, and B-052's contact card
  previewing as `viga-farm-friend`. One unchangeable cosmetic: the card's second line reads
  `Contact Card · 153 bytes` (iOS's own label) over the Cloud Run host until a real domain exists.
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
- Inquiry resolution receives every unique public item/payment name once and no stand association.
  Code expands selected names to all supporting stands, renders three stands per page, and rechecks
  mutable facts such as open-now status before `MORE`.

## Open before go-live

- Finish physical-handset checks: farmer onboarding, consent, vCard, paged SMS, administrator/settings,
  and F-105’s stand-detail sheet at phone width in both appearances; verify VIGA’s Squarespace embeds and
  the `?hidden=true` behavior.
- **B-066 owes one console check** (now deployed): remove a test farm on `/admin/farms`, then
  confirm it is gone from the map and unreachable by text, and put it back. Both `visibleFarms`
  branches were verified live by stand counts, but no farm was retired at the time, so the
  retirement clause itself is proven only by integration test against production code.
- **F-111 Phase 2's handset pass is 2 of 13 done, and BOTH cases found defects** (2026-08-13).
  Neither closed defect has been confirmed on a handset — the map question and the `open` binding
  are proven by test and by deploy-by-effect only. Still unrun: STOP/START, HELP,
  `does Pinecone have eggs?`, `no eggs left at Pinecone`, farmer `out of kale`, farmer reporting
  another stand, both VIGA Bucks shapes, `where's the farm stand map?`, a one-word partial stand
  name, `what stands are open today`, and the `unclear` reply.
- **B-068/B-069 await review.** Production measurement found both Forest
  Garden cucumber records but the old stand-selection model omitted the 24-day confirmation. The new
  model selects `Cucumber` once from a deduplicated catalog; code expands it to every supporting stand
  and both confirmed/usual evidence voices, so the stale confirmation cannot be selectively omitted.
  Inquiry has at most two serial model calls: strict top-level route/operation classification from the
  message alone, then value-only catalog matching for inventory/payment. Broad, hours, location,
  overview, clarification, system inquiry, chitchat, and VIGA Bucks search/lookup make no second call.
  Open-now includes confirmed-open stands only, including later `MORE` pages; inventory pages drop
  stands that no longer list the searched item with no model call. All local and paid live checks pass.
- **The provider-failure reply is proven by test only, deliberately.** Forcing a real outage in
  production means every sender loses every answer for as long as it lasts, on VIGA's own API key.
  An integration test forces `{ok: false}` and asserts the outage copy, sabotage-verified against the
  `unclear` string. Seeing it on a handset needs a preview deployment with a bad model endpoint —
  a separate service, never the live one.
- **Classifier known miss, deliberate:** `what is viga` → `search_stands` (wanted
  `system_inquiry`). The domain resolver matches the `VIGA Bucks` concept, never bare `VIGA`.
  **The live corpus drives future classifier changes** — add real misrouted messages to the fixture
  and revisit with evidence; do not tune against the existing fixture, which is a regression suite.
  The bar for another regex/domain fast path: a stable, reproduced, production-relevant misroute
  that the semantic classifier provably cannot fix without measurable regressions elsewhere.
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
