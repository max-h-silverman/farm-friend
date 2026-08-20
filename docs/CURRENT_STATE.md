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
- **HELP answers with two messages, and issue reports reach VIGA (B-091 — deployed).** The carrier-registered help body is followed by a code-rendered guide naming the
  keywords the sender can actually use; farmers and customers get different lists. The classifier
  gained an `issue_report` category that FILES NOTHING — the report is parked, the sender confirms,
  and code writes the flag into the same queue `FLAG` fills. `YES <email>` optionally leaves a reply
  address on that flag. Result pages now name the `MAP` keyword instead of carrying a URL, and the
  header reads `Results 4-6 of 12`.
- **An addition naming an item the stand already lists reaffirms it, and an invented quantity is
  dropped (B-092 — deployed).** Both are code guarantees over model output, because
  the seam note forbids both behaviours and the real model ignores both. Measured before fixing:
  "We have kale" against a stand listing Kale returned an ADDITION in 8 of 8 runs, six inventing
  a quantity (`12` x3, `1` x3). `applyInventoryEdits` merges on `standItemKey` — moved from `db`
  to `core` so the draft path and the database index cannot disagree about "same item".
  `validateInterpretation` drops a quantity from a message stating none. **The quantity rule is
  PRESENCE, never the value**: the first shape checked for THAT number and threw away the real
  model's `72` for "6 dozen eggs today", caught by the live mirror fixture. A price's digits do
  not count.
- **The public contact address is `farmfriend@vigavashon.org`** (max, 2026-08-19), in the HELP
  guide for both audiences, the farmer onboarding start page and VIGA's three Squarespace copy
  blocks. **The carrier-registered HELP body still names `board@`** — it is transcribed
  character-for-character from live Telnyx console state, so the console changes first (B-093).
  The administrator login identity, the SMTP relay account and the `administrators_fixed_identity`
  CHECK all deliberately stay `board@`.
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

- Serving **`farm-friend-web-00091-dvz`** / **`farm-friend-worker-00086-n95`**, digest
  `sha256:3057ac40ed9e1bb708f3a734e7019463d20bc4138ad7c189dd4154b3622f3267`, built from `eb1ab86`.
  Deployed 2026-08-19 — F-123, the farmer-link SMS copy, B-092, the `farmfriend@` contact address
  and F-124. **`main` and production agree**, except for the infra fix below which was committed
  after the apply that contained it. 63/63 plan assertions, deploy assertions and served-card
  assertions all pass; neither revision has an error-level log.
- **The deploy plan was REFUSED the first time, and the gate was right.** F-123 gave the worker
  the flag-alert email by mounting the whole of `local.web_secret_env`, which also handed it
  `ADMIN_PASSWORD_HASH`, the billed `GEOCODING_API_KEY` and F-079's three salts — seven
  credentials a mail-sending process has no use for. `local.email_secret_env` now holds exactly
  the email credentials and both services mount that. The two `worker never mounts GMAIL_OAUTH_*`
  assertions were the other half: F-123 inverted the sender-address check and left these
  standing, so the plan was internally contradictory — the worker told where to send from and
  forbidden the credential to send with. They are now "only when the web service does too",
  which catches asymmetry; `SMTP_PASSWORD` stays unconditionally forbidden as the alternative
  provider. **It sat on `main` undeployed until the first plan refused it.**
- **`0057` is applied. Neon `neondb` has 58 migrations**, verified by effect: `flags.alerted_at`
  present as nullable `timestamptz`, seller/stand counts unchanged by the DDL (43 sellers /
  39 stands — one more of each than the last snapshot recorded, from real activity).
- **F-123 is verified by effect IN PRODUCTION, not by its own report.** Both pre-existing flags
  were claimed and alerted within seconds of the new revision starting
  (`alerted_at` 05:52:05 and 05:52:06), and **a second recovery pass left both timestamps
  byte-identical** — the once-only claim holds under a real re-run, not just under test
  contention. Two emails reached `farmfriend@vigavashon.org`; both flags were already
  dismissed/resolved, which is expected for the first pass over a backlog and will not recur.
- **A refusal reader that takes a `Response` is a trap, and the tests could not see it.** The
  first shape read the body itself; every caller had already parsed it, so each reached for
  `clone()` — which THROWS on a consumed body, landing in the caller's catch and printing the
  generic "That change did not go through". It shipped and never ran once. The reader now takes
  the STATUS and the ALREADY-PARSED PAYLOAD, so a drained stream cannot reach it. The regression
  test drives the real screen's failure path rather than the reader alone, and reproduces the
  production symptom when the old shape is restored. Neither revision has an error-level log; the worker's recovery
  pass runs every minute returning 200. **F-119 verified in the shipped assets**: `items-cards`,
  `item-card-price`, `item-card-name` and `seller-block-heading` present in both the JS and CSS
  bundles, and the old `items-nested` / `item-sellers` absent.
- Neon `neondb` has **58 applied migrations (`0000`–`0057`)**, applied 2026-08-19 and **verified by
  effect**: all six trash columns, all six trash CHECKs, `pending_issue_reports`, and both
  `flags.reporter_email*` columns present; 42 sellers / 38 stands unchanged. `0054` adds
  `pending_issue_reports`, `0055` adds `flags.reporter_email` / `reporter_email_hash`, `0056` adds
  the trash columns. All three carry hand-appended CHECKs (`drizzle-kit` does not emit them) and all
  three needed their journal `when` repaired to follow their predecessor — the generator stamps
  wall-clock timestamps that sort BEFORE this repo's future-dated entries, which would have skipped
  them silently while the runner printed "migrations applied".
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

- **2,494 unit tests pass across 175 files; 7 corpus-only tests skip**, and integration is
  **1,494/1,494 across all 110 files** (both 2026-08-19, after F-124). Typecheck and lint clean.
- **`evals:live` was re-run for B-092 and is 7/7 containment** with every group green — closure
  7/7, quality 16/16, operation 6/6, catalog 7/7. Three of those containment fixtures are new:
  they drive REAL model output through `validateInterpretation` and `applyInventoryEdits` to the
  rendered draft, so they measure the code guarantee rather than the brain. On the passing run the
  model returned `quantity: 12` for "We have kale" and code stripped it.
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
- **B-078 recurred repeatedly and is confirmed environmental** (2026-08-19, twice). During F-124
  the same tree produced `4 failed | 106 passed` files, then `8 failed | 102 passed` naming an
  ENTIRELY DIFFERENT set — while all **1,494 TESTS passed both times**. Five further runs on that
  identical tree were clean, and a single named failure in one of them
  (`interpretation.integration.test.ts`) did not reproduce across the next three. The signature is
  now well characterised: **file-level failures with no failing test, moving between runs.**
  The standing rule holds — a NAMED failing test is a real defect until shown otherwise, and a
  failure that moves between runs on an unchanged tree is the harness.

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

- **VIGA is emailed when a flag arrives (F-123) — DEPLOYED and verified by effect.** One email to `farmfriend@vigavashon.org` per new `FLAG` or texted issue report,
  sent from the cron pass so a slow mail server can never delay the SMS webhook's answer to the
  carrier. The email carries the masked sender and a console link — never the number, the hash, or
  the message text. Once-only is the database's: `update … where alerted_at is null returning …`
  claims and returns in one statement, proven under six-way contention (the read-then-write
  sabotage produces four duplicate emails). A definitive rejection releases the claim to retry; an
  **ambiguous** one does not, because the relay may already have sent it.
  **The worker had NO email configuration** and would have found email unconfigured and sent
  nothing — the quietest possible failure for a safety notice. It now carries the provider config
  and credentials, the plan assertion `the worker is given no email configuration` is INVERTED,
  and two new assertions fail an apply that leaves `FLAG_ALERT_EMAIL` empty or the two services
  disagreeing about it. `flag_alert_email` lives in tracked `production.tfvars` for the same
  reason `public_host` does.
- **The admin console strip-down is COMPLETE across F-122 + F-124.** F-122 is merged to `main`
  and DEPLOYED 2026-08-19; F-124 finished the rest and is committed but unmerged. What the two
  landed between them:
  - **The trash**, replacing the "real delete" max first asked for — he revised it to trash the
    same day (2026-08-19). A trashed stand or seller leaves the roster and is restorable;
    **nothing destroys anything**, and "empty the trash" is deliberately not built because the
    referencing closure it must answer is its own item. `trashed_at` + `retired_by_trash` on both
    tables, migration `0056`, four hand-appended CHECKs. **The screen now exists (F-124).**
  - **Alerts is the flag queue alone.** Stock-outs and "Questions about our records" are gone
    with their components and their two API routes. `stand_data_flags` is written only by the
    SEEDER, so that queue was never a product surface.
  - **Invites** moved to a collapsed section atop Stands & Sellers; "Waiting for your decision"
    is now "Open invites".
  - Approval and test-farm marking are **removed (F-124)**, from the console AND from the
    routes — the integration suite asserts the server refuses all four actions, because a button
    that merely disappeared while the endpoint kept working is not a removal.
  - Farm Bucks and pause/resume **stay** (max, 2026-08-19, each decided on its own). The chips
    **collapsed to one summary per card** carrying two facts — `Open now · 2 sellers`,
    `Live · 2 stands` — replacing the chip row and the separate amber attention line, so two
    parallel mechanisms describing one record became one. `Unclaimed` replaces `Live` rather than
    joining it, and the page-level attention line is gone because approval was all it counted.
- **The Trash view and F-122's remaining removals are done (F-124 — merged and DEPLOYED).** `Move to trash` on both card kinds behind a
  confirmation that says what happens AND that it is reversible; a `Trash` section below the
  roster, shut with a count, mirroring how Invites sits above it (max chose this over a fourth
  tab). Restore is one press with no confirmation, and a FAILED restore keeps the row and says so
  — a row that vanished would tell the operator it worked. `restoreStandFromTrash` /
  `restoreFarmFromTrash` complete the named doors. Both routes gained `trash` /
  `restore_from_trash` rather than routes of their own.
  **A defect this work introduced was caught by its own test and never shipped:**
  `retirementStatusFor` had no `trashed` case, so the writer succeeded while the route answered
  409 — a stand genuinely trashed while the screen reported a conflict.
  **`test-farms.tsx` was dead surface kept alive only by its own test**; both are deleted.
  **Owed:** a browser pass at phone width on the new summary line and the Trash section. The
  markup was rendered and read in jsdom — which is how a copy error was found — but no pixel of
  either has been looked at.
- **Removing the approval toggle left `revokeFarmApproval` with no production caller (B-094).**
  Measured, not assumed: the only remaining references are two integration tests and one doc
  comment. Publication still refuses with `not_approved` and onboarding still auto-approves, so
  the gate works and every farm passes it — what no longer exists is any way to make a farm STOP
  passing it. **This is the accepted consequence of max's decision, not a regression.** The writer
  is deliberately kept, because deleting it would leave the `not_approved` branch permanently
  unreachable. The nearest live control is revoking the farmer's AUTHORIZATION on the seller card,
  which may be the whole answer.
- **A stock-out report whose farmer cannot be reached now reaches nobody.** `stockout.ts` files
  those "for VIGA review" and VIGA's queue was removed (max chose "keep collecting, drop the
  screen", 2026-08-19). Eight were open at removal. `listStockOutReports` is kept and marked with
  the reason, so restoring the screen is a render rather than a rewrite.
- **Pause/end is reachable by both VIGA and the farmer.** The admin half is the toggle and Remove
  on Stands & Sellers; the seller half is on the settings screen `LINK`/`SETTINGS` already texts
  her, with `mayPause` riding each listing from the seam's own arm so no control is offered that
  the seam would refuse. **VIGA's pause now asks first** (2026-08-18); resume is not gated, because
  it puts something back.
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
- **B-066's check is half done.** Marking `Josie's Farm` a test farm (2026-08-19, through the real
  `setTestFarm` writer) was verified by effect: absent from `/api/public/stands`, present with
  `?hidden=true`. The RESTORE half — unmark and confirm it returns — has not been run, and Josie's
  Farm is a live listing with one authorized handset **deliberately hidden from customers** (max,
  2026-08-19, confirmed at wrap) — not an accident to be undone by whoever notices it next.
- **F-111 Phase 2 handset pass is 2/13.** Remaining cases cover STOP/START, HELP, named-stand inquiry
  and report, farmer own/other-stand reports, both VIGA Bucks shapes, map, a partial stand name,
  open-today, and the unclear reply.
- **Classifier known miss:** `what is viga` → `search_stands` rather than `system_inquiry`. The full
  top-level corpus is 52/53 with only this pre-existing miss; the gate fails on any NEW miss rather
  than treating that baseline as a regression. Add real misroutes to the corpus; do not tune around
  this advisory fixture without production evidence.
- **The carrier-registered HELP body still names `board@vigavashon.org` (B-093).** Every other
  user-facing mention became `farmfriend@`, so a sender who texts HELP today reads BOTH addresses
  in one exchange — the carrier's body says `board@`, the code-rendered guide that follows says
  `farmfriend@`. Low severity: `board@` is a real monitored VIGA mailbox, so nobody is stranded.
  The order is fixed and cannot be shortcut: change the Telnyx console first, then transcribe the
  result into `docs/TELNYX_10DLC_FIELD_VALUES.txt` and `REGISTERED_HELP_AUTO_RESPONSE` together.
  Editing the constant alone would make our source disagree with what the carrier sends, which is
  the drift the character-for-character pin exists to prevent.
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
