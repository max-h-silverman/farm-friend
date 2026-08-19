# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves customer SMS inquiry and paging, farmer stock
  updates and reminders, stock-out reporting, farmer onboarding/settings, administrator tools, the
  public stand map/details, and the contact card at `/viga-farm-friend`.
- **SMS answers nothing substantive until the sender has agreed (F-121).** A sender with no consent
  record gets one invitation naming `JOIN` *instead of* their answer; a sender who opted out gets
  nothing. The exemption is the routing ORDER — the gate sits below the compliance branch, so the
  carrier-registered keywords (`STOP` + synonyms, `JOIN`/`START`/`VIGA`, `HELP`/`INFO`) pass by
  construction. Everything else gates, **`MAP` included**, so no model runs for an unconsented
  sender. `MAP` therefore lost its delayed-event exemption: a stale `MAP` now fails closed.
- **HELP answers with two messages, and issue reports reach VIGA (B-091 — merged, NOT deployed and
  migrations NOT applied).** The carrier-registered help body is followed by a code-rendered guide naming the
  keywords the sender can actually use; farmers and customers get different lists. The classifier
  gained an `issue_report` category that FILES NOTHING — the report is parked, the sender confirms,
  and code writes the flag into the same queue `FLAG` fills. `YES <email>` optionally leaves a reply
  address on that flag. Result pages now name the `MAP` keyword instead of carrying a URL, and the
  header reads `Results 4-6 of 12`.
- **A stand answering the whole request outranks one answering part of it (F-120).** `matchCount` is
  `rankCandidates`' first key, ahead of freshness. `broad` passes a constant, so a catalog-wide
  request is not a biggest-listing leaderboard.
- **The stand card is seller-major (F-119).** Each seller is a sub-heading carrying its own recency,
  its items bordered cards in a grid. It deliberately gives up F-114's "each item appears once" —
  two sellers carrying eggs print eggs twice, each with that seller's own price. B-088 (no
  sub-heading for a single-seller *section*) and F-118 (the name stays a link) both hold.
- **Customer inquiry classifies before it matches catalog.** One strict classifier sees the message
  alone; only inventory/payment make a second value-only matcher call. Code validates every match,
  expands it to every supporting stand and evidence voice, orders, pages, and renders.
- **Code owns closure timing and consequential output.** Models select bounded values; they never
  write public claims, authorize publication, resolve open-now state, or choose evidence.
- **An answer separates what was asked from what merely relates to it.** The matcher still expands
  by meaning (F-045 requires it), but `sortMatchesByExactness` — pure code, no model, no taxonomy —
  leads with values containing the customer's own word and files the rest under
  `Other stands with <category>:`. **Known limit:** `a choy` also treats `bok choy` as exact,
  because stripping question grammar removes the article; separating them needs a second food
  vocabulary the architecture does not allow. Marked INVERT WHEN that changes.
- **The matcher's catalog is built from the same rows the answer is filtered from.** Building it
  from a source that drops expired confirmations made stands past 28 days unreachable BY NAME
  rather than merely ranked last — the model cannot select a value it was never shown (B-087).
- **`Also selling here` is the heading on both the public stand card and the admin console**
  (max, 2026-08-18, renamed from "Who sells here"). On the public card two sections share it — the
  modelled-seller roster and the typed-names fallback — and they are **mutually exclusive by
  construction**: the roster excludes own-sellers so it needs a guest, and the fallback renders
  only when no guest exists. A test pins that they never both appear.
- **Three public states, not two.** `Open` / `Closed` / `Hours unknown`, and **Closed is reserved
  for out of season or outside stated hours** (max). `isDefinitelyShut` in `map-view.ts` is the one
  definition, read by both the map filter and the seller card, written as the set of states that
  ARE closed so a state added later defaults to unknown.
- **Every public and SMS link is on `farmfriend.vigavashon.org`** (F-113), and `vigavashon.org` DNS
  authenticates VIGA's mail (SPF includes Google; `_dmarc` at `p=none`).
- **This repo has no CI.** Local suites are the merge gate; `gh pr checks` has no required checks.
- **Client components must import `@farm-friend/core/seller-credit`, never the barrel.**
  `@farm-friend/core` re-exports `privacy/phone.ts` → `node:crypto`, which is unresolvable in a
  client bundle and **500s every farmer web screen in `next dev`**. jsdom resolves the barrel fine,
  so no suite catches it — only launching the app does.

## Deployment and migrations

- Serving **`farm-friend-web-00088-8cw`** / **`farm-friend-worker-00083-28n`**, digest
  `sha256:bfbc1bc07b66b60d75620e82266ab5dd7c1c1928c99398d12a0aff9a2066e4e4`, built from `d9d0f6c`.
  Deployed 2026-08-19 (B-089/F-119/F-120/F-121). `main` is pushed and fully deployed. Plan was 0 add
  / 2 change / 0 destroy — only the image digest moved; 61/61 plan assertions, deploy assertions and
  served-card assertions all passed. Neither revision has an error-level log; the worker's recovery
  pass runs every minute returning 200. **F-119 verified in the shipped assets**: `items-cards`,
  `item-card-price`, `item-card-name` and `seller-block-heading` present in both the JS and CSS
  bundles, and the old `items-nested` / `item-sellers` absent.
- Neon `neondb` has **54 applied migrations (`0000`–`0053`)**. **`0054` and `0055` are written and
  locally verified but NOT applied and NOT deployed** (B-091): `0054` adds `pending_issue_reports`,
  `0055` adds `flags.reporter_email` / `reporter_email_hash`. Both carry hand-appended CHECKs
  (`drizzle-kit` does not emit them) and both needed their journal `when` repaired to follow their
  predecessor — the generator stamped wall-clock timestamps that sort BEFORE `0053`, which would have
  skipped them silently while the runner printed "migrations applied".
- **`inventory_publication_proposals.provider_id` is nullable in production, and that is correct.**
  `0042` sets it NOT NULL and **`0046` deliberately relaxes it** so a venue's closure-only proposal
  can name no provider, replacing it with the `inventory_proposals_provider_arm` CHECK. A preflight
  assertion reading the bare nullability reports a false failure.
- **`0045`–`0049` and `0051` are constraint-only and were NOT generated** (`0050` adds one nullable
  column); `drizzle-kit` does not emit them. A hand-written migration's snapshot is repaired as a
  **measured DELTA of its predecessor, never by introspection** — RUNBOOK §Migrations and
  DEVELOPMENT.md §gotchas own the procedure.
- **`paused` still means two unrelated things.** `stand_providers.lifecycle_state = 'paused'` is a
  suspended selling relationship; `inventory_prompt_preferences.cadence = 'paused'` is reminders
  off. Renaming the cadence value to `off` is one migration with no behaviour change, and the
  `0042`–`0053` condition that deferred it is now cleared — unblocked work, not blocked.

## Data resolutions a cold start should not re-litigate

- **Three hosted names are resolved** (`scripts/resolve-hosted-sellers.ts`, max 2026-08-18):
  Fernhorn Bakery is ONE seller with TWO arrangements (Tian Tian + Pacific Crest); Handpicked
  Homestead was linked to an existing seller, not created; Gracie's Greens is new.
  **`Vashon Island Honey Co.` and `Kareli Farm` stay unresolved** — nobody has decided them.
- **Morgan Hill keeps its self-pointer, permanently.** The seller it names carries VIGA's own
  description, 17 pooled items and a current revision, and four participant rows reference it
  through a composite FK with `ON DELETE RESTRICT`. Its four typed names are **decorative, not
  operational** — no handset, no seller rows, and no rule could attribute those items. Promoting
  them would create identities nobody owns or can update.
- **Handpicked Homestead sells only at Plum Forest.** Her own stand is retired (`is_public = false`,
  not deleted — its revisions are history) and her listing republished on that arrangement. Her
  authorization is bound to her SELLER, so her handset still works and now publishes there.

## Verification

- **2,439 unit tests pass across 173 files; 7 corpus-only tests skip**, and integration is
  **1,473/1,473 across all 108 files** (both 2026-08-19, after B-091). Typecheck and lint clean.
- **`evals:live` is green INCLUDING the new category** — containment 4/4, closure 7/7, quality 16/16,
  operation 6/6, catalog 7/7. The sixth operation fixture is new for B-091 and pairs each issue
  report against a stock-out that must not move; a set of issue reports alone would pass for a model
  that called everything an issue. Sabotage-proved: asserting a stock-out is an issue report fails.
- **`npm run test:integration` needs `PUBLIC_BASE_URL` exported as well as `DATABASE_URL`.** Without
  it, six `apps/web/lib/farmer-stand.integration.test.ts` cases fail `PUBLIC_BASE_URL is required`.
  **Verified pre-existing**: checking out `main` reproduces the identical six. An environment fact
  and a test-isolation weakness, not a regression and not a product defect.
- Typecheck, lint, and scripted evals pass: critical 11/11, advisory 4/4, adversarial 19/19.
  The build retains tracked Next configuration/lint warnings (B-008).
- **`evals:live` is a trustworthy gate (B-089).** A fixture whose model call never reached the
  provider is counted `couldNotRun` — neither pass nor fail — and the run exits 2 reporting "N
  fixtures could not run", so an outage no longer reads as a quality regression. A real failure
  always outranks an outage.
- **The classifier's variance is measured and bounded (B-090, 2026-08-19).** Twenty captured runs
  against `mistralai/Mistral-Small-24B-Instruct-2501`: **20/20 green, zero FAIL, zero SKIP**, every
  required group at 100% every run. Only the two already-catalogued baseline cases ever miss —
  `"what is viga"` 4/20, `"when do you open?"` 11/20 — across ~800 classifications. No third case.
  This also clears the live run owed from B-086/B-087.
  **`ADVISORY_CLASSIFIER_CASES` needs no new entry and no threshold**; the corpus holds at the
  existing gate. The earlier unreproducible `live-operation` 3/5 cannot come from these misses (the
  advisory list absorbs both), and predates B-089's outage labelling.
- **A passing fixture can still be moving**, because the corpus fixture gates on "no *non-baseline*
  regression" — 51/53 and 53/53 are both green. `evals/variance.ts` +
  `packages/ai/src/live-eval-variance.ts` capture each run to its own file and report **score
  movement separately** from pass/fail. Re-summarise a capture directory without spending money:
  `npx tsx evals/variance.ts --summarise-only --out <dir>`; this measurement's runs are in
  `evals/captures/2026-08-19-b090/`.
- **Every tranche here is sabotage-proved** — each guard has a breakage aimed at it that the suite
  caught. The standing lessons: **assert the absence of the wrong behavior; when a breakage changes
  no test result, ask which other guard answered first; and confirm the sabotage actually applied
  before concluding a guard is redundant.** Enumerations in [SESSION_LOG.md](SESSION_LOG.md);
  standing forms in DEVELOPMENT.md §gotchas.
- **`sellers_name_not_blank` admits a tab-and-newline name** — `trim()` strips spaces only.
  Seventeen `*_not_blank` CHECKs share it. The suite asserts that measured truth in two cases
  rather than the constraint's name; **B-076** files the sweep, and the admitting case is marked
  INVERT WHEN FIXED.
- **One integration file failed intermittently under full-suite parallel load** (B-078). **Not seen
  again** across several clean full runs since. Capture the full run to a file the next time it
  does; the file name was lost to a summary grep last time.

## Standing facts a cold start needs

- Farmer onboarding sends the farmer to text **VIGA** from their stated handset; `START` remains the
  carrier recovery fallback. Onboarding inventory publishes only after verified handset redemption.
- VIGA Farm Bucks is a farmer-owned acceptance claim, stored apart from payment methods. `LINK`,
  `STAND`, and `SETTINGS` retain their deterministic farmer behavior.
- A dated stock claim has one source: `sms`, `web`, or `viga`. `visitability` controls whether a
  stand gets a map invitation and directions link.
- Inquiry matching receives each unique public item/payment value once and no stand association.
  `pending_result_lists.broad` is written but deliberately unread until that table next migrates.
- `DEEPINFRA_API_KEY` is VIGA-owned. Live evals intentionally fail provider errors rather than
  counting a contained refusal as model quality.
- Local integration tests require Postgres and run with `npm run test:integration:local`; the plain
  command fails loudly when `DATABASE_URL` is absent. `psql` lives under Homebrew's Postgres 16 path.
- Migration `when` stamps can land behind their predecessor on this machine; RUNBOOK §Migrations owns
  the repair. Every production plan must include `infra/production.tfvars`.
- `public_host` lives in tracked `production.tfvars`, NOT the gitignored `terraform.tfvars`: an apply
  that omits it destroys the domain mapping and silently reverts F-113.

## Open before go-live

- **The admin console is not yet stripped down (F-122).** Max asked for it this session and it is
  deliberately deferred, not forgotten: bare-minimum info and actions, built back out only as real
  admins ask. The four functions VIGA needs are edit, unpublish **and delete**, re-send onboarding
  links, and add an SMS owner. **Delete is new** — max chose "off the map, plus a real delete"
  (2026-08-19), and nothing in the console destroys anything today. Approval, test-farm marking, the
  Farm Bucks decision, pause/resume and the state chips are all candidates for removal, each needing
  its own decision rather than a blanket sweep.
- **Pause/end is reachable by both VIGA and the farmer.** The admin half is the toggle and Remove
  on Stands & Sellers; the seller half is on the settings screen `LINK`/`SETTINGS` already texts
  her, with `mayPause` riding each listing from the seam's own arm so no control is offered that
  the seam would refuse. **VIGA's pause now asks first** (2026-08-18); resume is not gated, because
  it puts something back.
- **VIGA's stock-out queue is the only destination for reports at the 18 stands publishing no
  confirmed inventory** — decided and accepted (max, 2026-08-16), not an open question. Those stands
  are texted today and will not be once C.3 deploys; it resolves as they start confirming inventory.
  Worth VIGA knowing their queue carries those reports in the meantime.
- Finish physical-handset checks: farmer onboarding/consent, contact card, paged SMS, administrator
  and settings flows, F-105 stand details at phone width, Squarespace embeds, and `?hidden=true`.
  Every texted link now carries `farmfriend.vigavashon.org` and none has been read on a handset.
- **Everything F-114 added owes a handset pass**, all verified in integration and by encoding
  (GSM-7 throughout) but never read on a real phone:
  - **Customer surfaces (C.5):** the item-first stand card and the seller list. The map's "Browse
    by seller" LINK is gone as of 2026-08-18 — sellers are now a **View stands / View sellers**
    toggle on the map's own list, rendering in the stand card's shape. `/sellers` still exists and
    still works. The C.5 pages were read in a browser and MEASURED (no horizontal overflow at
    360px/390px, credited lines wrap, no rule in a `prefers-color-scheme` block); **the new toggle
    and the in-map seller cards have NOT been seen at any width.**
  - **Farmer SMS copy (C.3/C.4):** the target menu (*"Which listing do you mean?"*, naming the
    seller beside the stand where they differ), `Using …` / `Update your listing for …`, and the
    paused listing's `Publishing this update will re-open your listing. Reply YES to confirm, NO
    to cancel.` — which replaces the ordinary publish prompt rather than joining it.
  - **Farmer settings:** the new per-listing labels (`Stand — Seller`).
- **The 2026-08-14 SMS wording and B-068/B-069/B-071 changes owe a handset pass.** A grouped stand
  listing, a stale `In stock (over a week ago)` line, the farmer proposal's `Reply YES to publish, or
  NO to discard.`, the emoji-free greeting, `cucumber` retaining Forest Garden's dated evidence, and
  the single-stand listing all shipped verified in integration and against the live model — no
  message has been read on a real phone.
- **The antivirus block is addressed but NOT confirmed cleared.** The custom domain removes the
  `*.run.app` signal, but no one has re-tested the embed against Webroot, and reputation systems
  carry stale verdicts. Worth asking the farmer who reported it on 2026-08-14 to look again. Whether
  carrier filtering ever affected SMS links is unknown — never measured, so that half is a reasoned
  fix, not an observed one.
- **The production geocoding key is unrestricted (B-081).** Measured 2026-08-18: it geocodes from a
  laptop. It is billed per call, so a leaked copy is directly spendable. Restricting it by **API**
  is the safe half; an IP restriction needs Cloud Run's egress answered first, and a wrong one
  takes down the only path to creating a visitable stand.
- **B-066 owes one console check:** remove a test farm, confirm map/SMS disappearance, then restore.
- **F-111 Phase 2 handset pass is 2/13.** Remaining cases cover STOP/START, HELP, named-stand inquiry
  and report, farmer own/other-stand reports, both VIGA Bucks shapes, map, a partial stand name,
  open-today, and the unclear reply.
- **Classifier known miss:** `what is viga` → `search_stands` rather than `system_inquiry`. The full
  top-level corpus is 52/53 with only this pre-existing miss; the gate fails on any NEW miss rather
  than treating that baseline as a regression. Add real misroutes to the corpus; do not tune around
  this advisory fixture without production evidence.
- Provider-failure copy is integration-tested only. A real outage test belongs on an isolated preview
  service, never VIGA's production model account.
- **The F-121 consent gate is unexercised on a real handset.** It ships verified by integration
  (44 routing cases) and by unit tests, but exercising it in production means sending real texts, so
  the invitation copy has never been read on a phone. First handset check should be: text the number
  from an unenrolled phone, confirm the invitation arrives, reply `JOIN`, confirm the welcome, then
  ask a stand question and confirm it is answered.
- **Everything shipped 2026-08-18 is unseen in a browser.** The three-state open badge, the admin
  participation labels, Morgan Hill's restored typed names, the per-item recency rule, and the
  counter-scaled map tooltip were all verified by test, by measurement and (for the two label
  fixes) in the shipped JS bundles — but **no pixel of any of them has been looked at**. The
  tooltip is the one to check first: its fix is a geometry change proven only arithmetically, and
  it is the surface that was unreadable at 6.6px on a phone.
- Phone-width visual checks remain owed for onboarding, farmer settings/listing, map details, and the
  three administrator tabs — now **Stands & Sellers · SMS Users · Alerts** — including the once-shown
  setup link, which sits in a control a farmer has to be able to select on a handset. **The whole
  F-101 console is owed a look at any width**: it was verified as served markup and CSS, never as
  pixels. F-065, F-084, B-008, B-034, B-036, B-048 and **B-079** (four Alerts-page tests lost to
  F-101's cleanup) remain planned.
- VIGA must decide whether Vashon Island Farmers Market belongs in the roster as a farm. F-108 remains
  an idea for a per-answer map showing only returned stands.

## Where the traps live

The hard-won gotchas — vitest's misleading tail, populated-schema migration tests, snapshot
repair by measurement, sabotage that proves nothing, NULL semantics, first-insert races, the
GSM-7 encoding cliff — are in [DEVELOPMENT.md](DEVELOPMENT.md) §gotchas peculiar to this
codebase, which owns them. **Read that section before touching migrations, constraints, tests,
or SMS copy.**

- RUNBOOK owns migration generation/order, production fingerprinting, seeding, secret rotation,
  immutable-image deployment, and Neon reachability. DEVELOPMENT owns codebase/test gotchas.
