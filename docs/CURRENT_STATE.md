# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

Farm Friend is **pre-go-live**. Production serves customer SMS inquiry and paging, farmer stock
updates and reminders, stock-out reporting, farmer onboarding/settings, administrator tools, the
public stand map/details, and the contact card at `/viga-farm-friend`.

The behavioural rules a cold start must not re-derive — *what is true*, not how it got here:

- **SMS answers nothing substantive until the sender has agreed (F-121).** No consent record → one
  invitation naming `JOIN` instead of the answer; opted out → nothing. The exemption is the routing
  ORDER: the gate sits below the compliance branch, so carrier keywords (`STOP` + synonyms,
  `JOIN`/`START`/`VIGA`, `HELP`/`INFO`) pass by construction. Everything else gates, **`MAP`
  included** — a stale `MAP` fails closed and no model runs for an unconsented sender.
- **HELP answers with two messages**, the carrier body then a code-rendered guide naming the
  keywords that sender can use; farmers and customers get different lists. `issue_report` FILES
  NOTHING — the report is parked, the sender confirms, then code writes the flag.
- **Customer inquiry classifies before it matches catalog.** One strict classifier sees the message
  alone; only inventory/payment make a second value-only matcher call. Code validates every match,
  expands it to every supporting stand and evidence voice, orders, pages, renders. Its catalog is
  built from the same rows the answer is filtered from (B-087) — the model cannot select a value it
  was never shown.
- **Code owns closure timing and consequential output.** Models select bounded values; they never
  write public claims, authorize publication, resolve open-now state, or choose evidence.
- **Two model inventions are refused by code, not by the prompt (B-092).** An addition naming an
  already-listed item merges onto it via `standItemKey` (in `core`, matching the database index);
  a quantity is dropped when the message states none. The quantity rule is **PRESENCE, never the
  value** — the model may read "6 dozen" as 72, and code re-deriving that would be a second
  interpreter.
- **An answer separates what was asked from what merely relates to it.** `sortMatchesByExactness`
  (pure code, no taxonomy) leads with the customer's own word, files the rest under `Other stands
  with <category>:`. **Known limit:** `a choy` treats `bok choy` as exact, because stripping
  question grammar removes the article. Marked INVERT WHEN a second food vocabulary is allowed.
- **`matchCount` is `rankCandidates`' first key**, ahead of freshness (F-120); `broad` passes a
  constant so a catalog-wide request is not a biggest-listing leaderboard.
- **B-095 closed with F-125.** The map's seller list carries `farmBucksAccepted` and renders the
  refusal as a badge beside the season one. It is a RENDER, not a derivation — the whole reason
  it was blocked is that a seller at several stands had no single answer until payment moved.
- **Payment belongs to the SELLER, and a stand may only narrow it (F-125).** She states her
  methods and her VIGA Bucks answer once, on `sellers`, and they apply at every stand she sells
  at. `sales_location_payment_method_exclusions` lets a host REMOVE a method it cannot support
  (the motivating case: a hosted seller at a stand with no way to take cash); adding is
  unrepresentable, not merely refused. `resolvePaymentMethods` in `core` is the one rule, run as
  a join by the public map and the farmer's edit form. **Nothing derives a seller's answer from
  her stands** — that derivation is the second mechanism F-125 removed.
- **There is no VIGA Bucks eligibility** (max, 2026-08-20: *"there is no 'eligible'. they either
  take it or they don't"*). The grant was deleted rather than moved, and
  `sellers.farm_bucks_accepted` is `DEFAULT true`: Farm Bucks is near-universal here, so silence
  is nobody ticking a box rather than a refusal. **The accepted risk** — a wrong `true` sends a
  customer to an unattended stand holding vouchers the farmer will not take. If a farmer reports
  that, it is this default and not a defect.
- **The farmer's edit form reads her UNNARROWED list.** The reader returns what she states and
  carries the stand's exclusions as a separate read-only field, because the writer replaces her
  seller-wide rows from the same field — a narrowed prefill would silently drop a method at every
  other stand she sells at.
- **The stand card is seller-major (F-119)** — each seller a sub-heading with its own recency.
  Deliberately gives up "each item appears once": two sellers carrying eggs print eggs twice, each
  with that seller's price.
- **`Also selling here`** heads both the public card and the admin console. On the public card its
  two sections (modelled roster, typed-names fallback) are **mutually exclusive by construction**,
  pinned by a test.
- **Three public states, not two.** `Open` / `Closed` / `Hours unknown`, Closed reserved for out of
  season or outside stated hours. `isDefinitelyShut` in `map-view.ts` is the one definition,
  written as the set that ARE closed so a new state defaults to unknown.
- **Every public and SMS link is on `farmfriend.vigavashon.org`** (F-113); `vigavashon.org` DNS
  authenticates VIGA's mail (SPF includes Google, `_dmarc` at `p=none`).
- **The public contact address is `farmfriend@vigavashon.org`.** The administrator login identity,
  the SMTP relay account and `administrators_fixed_identity` deliberately stay `board@`.
- **This repo has no CI.** Local suites are the merge gate; `gh pr checks` has no required checks.
- **Client components must import `@farm-friend/core/seller-credit`, never the barrel.** The barrel
  re-exports `privacy/phone.ts` → `node:crypto`, unresolvable in a client bundle, and **500s every
  farmer web screen in `next dev`**. jsdom resolves it fine, so only launching the app catches it.

## Deployment and migrations

- Serving **`farm-friend-web-00092-xxn`** / **`farm-friend-worker-00087-ccz`**, digest
  `sha256:245e6a1bf3dc9170b8ca7cfcdeba52dd8383516477c073ca1c02d194f9155751`, built from `92fadf1`,
  deployed 2026-08-20. **`main` and production agree.** 63/63 plan assertions and deploy assertions
  pass; neither revision has an error-level log.
  **F-125 is verified on the wire**: `/api/public/stands` returns 33 stands, 25 carrying payment
  methods, exactly 3 refusing Farm Bucks; the served map page carries 69 `farmBucksAccepted`
  values, the B-095 refusal badge, and **zero** occurrences of the deleted `farmBucksEligible`.
- Neon `neondb` has **59 applied migrations (`0000`–`0058`)**, each verified by effect rather than
  by "migrations applied". Production holds **43 sellers / 39 stands**.
  **`0058` (F-125) is applied**, verified by effect and matching its dry run exactly: 86 payment
  rows carried to `seller_payment_methods`, none stranded, 3 sellers on a reviewed refusal and 40
  on the accepted default; `sales_location_payment_methods` and both `farm_bucks_*` stand columns
  are gone. The pre-migration state was snapshotted to
  `~/farm-friend-backups/f125-pre-migration-backup-20260820T121702.json`, beside the earlier Neon
  dumps — **one machine only**, so it is a convenience rather than a durable backup.
- **The worker mounts `local.email_secret_env`, never `web_secret_env`.** It sends the F-123 flag
  alert and needs the email credentials; it must never hold `ADMIN_PASSWORD_HASH`, the billed
  `GEOCODING_API_KEY`, or F-079's three salts. `plan-assertions.py` enforces this and once refused
  a real plan for it. `SMTP_PASSWORD` is unconditionally forbidden on the worker as the
  alternative provider; the Gmail pair is asserted symmetric across the two services.
- **`inventory_publication_proposals.provider_id` is nullable in production, and that is correct.**
  `0042` sets it NOT NULL and **`0046` deliberately relaxes it** so a venue's closure-only proposal
  can name no provider, replacing it with the `inventory_proposals_provider_arm` CHECK. A preflight
  assertion reading the bare nullability reports a false failure.
- **`0045`–`0049` and `0051` are constraint-only and were NOT generated** (`0050` adds one nullable
  column); `drizzle-kit` does not emit them, nor does it emit CHECKs — those are hand-appended. A
  hand-written migration's snapshot is repaired as a **measured DELTA of its predecessor, never by
  introspection**, and its journal `when` almost always needs repairing to follow its predecessor:
  the generator stamps wall-clock timestamps that sort BEFORE this repo's future-dated entries,
  which would skip the migration silently while the runner prints "migrations applied".
  RUNBOOK §Migrations and DEVELOPMENT.md §gotchas own the procedure.
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

- **2,501 unit tests across 176 files** (7 corpus-only skips) and **1,506 integration across all
  111 files**, both 2026-08-20 after F-125. Typecheck and lint clean. Scripted evals: critical
  11/11, advisory 4/4, adversarial 19/19. The build retains tracked Next config/lint warnings
  (B-008).
- **`evals:live` is 7/7 containment**, closure 7/7, quality 16/16, operation 6/6, catalog 7/7.
  Three containment fixtures are B-092's and measure the CODE guarantee, not the brain: they drive
  real model output through `validateInterpretation` and `applyInventoryEdits` to the rendered
  draft. B-091's sixth operation fixture pairs each issue report against a stock-out that must not
  move, so a model calling everything an issue fails.
- **`evals:live` is a trustworthy gate (B-089).** A fixture whose call never reached the provider
  counts `couldNotRun` — neither pass nor fail — and the run exits 2, so an outage cannot read as a
  quality regression. A real failure always outranks an outage.
- **The classifier's variance is measured and bounded (B-090).** Twenty captured runs: 20/20 green,
  every required group at 100%. Only the two catalogued baseline cases ever miss — `"what is viga"`
  4/20, `"when do you open?"` 11/20 across ~800 classifications. No third case, no new advisory
  entry needed. **A passing fixture can still be moving**, since the corpus gates on "no
  *non-baseline* regression"; `evals/variance.ts` reports score movement separately. Re-summarise
  without spending money: `npx tsx evals/variance.ts --summarise-only --out <dir>`.
- **B-078 is confirmed environmental and now well characterised.** On unchanged trees the suite has
  produced `4 failed | 106 passed` files, then `8 failed | 102 passed` naming an ENTIRELY DIFFERENT
  set, while **every test passed both times**; named failures have not reproduced in isolation or
  on rerun. The signature: **file-level failures with no failing test, moving between runs.** The
  standing rule — a NAMED failing test is real until shown otherwise; a failure that moves on an
  unchanged tree is the harness.
- **`npm run test:integration` needs `PUBLIC_BASE_URL` exported as well as `DATABASE_URL`.** Without
  it six `farmer-stand.integration.test.ts` cases fail. Pre-existing environment fact and a
  test-isolation weakness, not a product defect. `test:integration:local` is the working command.
- **Every tranche is sabotage-proved.** Standing lessons: **assert the absence of the wrong
  behavior; when a breakage changes no test result, ask which other guard answered first; confirm
  the sabotage actually applied before concluding a guard is redundant.** Enumerations in
  [SESSION_LOG.md](SESSION_LOG.md); standing forms in DEVELOPMENT.md §gotchas.
- **`sellers_name_not_blank` admits a tab-and-newline name** — `trim()` strips spaces only, and
  seventeen `*_not_blank` CHECKs share it. The suite asserts that measured truth rather than the
  constraint's name; **B-076** files the sweep, marked INVERT WHEN FIXED.

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

### Nothing has been seen on a real phone or in a browser

This is the single largest gap, and it is one gap rather than the several it used to be listed as.
Everything below shipped verified by test, by encoding (GSM-7 throughout), by measurement or in the
shipped bundles — **and no pixel and no message has been looked at on a real device.**

- **Handset, SMS.** F-111 Phase 2 is **2/13**: STOP/START, HELP, named-stand inquiry and report,
  farmer own/other-stand reports, both VIGA Bucks shapes, map, a partial stand name, open-today,
  the unclear reply. Plus F-114's farmer copy (the target menu, `Using …`, the paused listing's
  re-open prompt), the 2026-08-14 wording and B-068/B-069/B-071, and every texted link now on
  `farmfriend.vigavashon.org`. **Start with the F-121 consent gate**, since it changes what an
  unenrolled stranger receives: text from an unenrolled phone → invitation arrives → reply `JOIN`
  → welcome → ask a stand question → answered.
- **Browser, phone width.** The whole F-101 console at any width (verified as served markup and
  CSS, never as pixels), F-124's new summary line and Trash section, the map's View stands / View
  sellers toggle and its in-map seller cards, onboarding, farmer settings/listing, map details, the
  once-shown setup link (a farmer must be able to select it on a handset), and everything shipped
  2026-08-18 — **the counter-scaled map tooltip first**, because its fix is a geometry change
  proven only arithmetically on the surface that was unreadable at 6.6px.

### Decisions owed by VIGA or max

- **B-094** — with the approval toggle gone, `revokeFarmApproval` has no production caller, so an
  approval cannot be reversed. Accepted consequence of a decision, not a regression. Revoking the
  farmer's AUTHORIZATION may be the whole answer, in which case the writer and the `not_approved`
  branch both go.
- **B-093** — the carrier HELP body still names `board@`, so a sender texting HELP reads both
  addresses in one exchange. **Telnyx console first**, then transcribe into
  `docs/TELNYX_10DLC_FIELD_VALUES.txt` and `REGISTERED_HELP_AUTO_RESPONSE` together; editing the
  constant alone recreates the drift the character-for-character pin exists to prevent.
- Whether **Vashon Island Farmers Market** belongs in the roster as a farm. F-108 remains an idea
  for a per-answer map showing only returned stands.

### Known gaps carried forward

- **A stock-out report whose farmer cannot be reached now reaches nobody.** `stockout.ts` still
  files those "for VIGA review" and the queue screen was removed (max chose "keep collecting, drop
  the screen"). Eight were open at removal. `listStockOutReports` is kept and marked, so restoring
  the screen is a render rather than a rewrite.
- **The production geocoding key is unrestricted (B-081).** It geocodes from a laptop and is billed
  per call, so a leaked copy is directly spendable. Restricting by **API** is the safe half; an IP
  restriction needs Cloud Run's egress answered first, and a wrong one takes down the only path to
  creating a visitable stand.
- **B-066's check is half done.** `Josie's Farm` is marked a test farm and verified absent from
  `/api/public/stands`, present with `?hidden=true`. The RESTORE half has not been run — and it is
  **deliberately hidden** (max), not an accident for whoever notices it next to undo. With the
  console control gone, unmarking is now a script-only operation.
- **The antivirus block is addressed but NOT confirmed cleared.** The custom domain removes the
  `*.run.app` signal, but the embed has not been re-tested against Webroot and reputation systems
  carry stale verdicts. Worth asking the farmer who reported it to look again. Whether carrier
  filtering ever affected SMS links was never measured — that half is a reasoned fix, not an
  observed one.
- **Classifier known miss:** `what is viga` → `search_stands` rather than `system_inquiry`. The
  corpus is 52/53 with only this pre-existing miss; the gate fails on any NEW miss. Add real
  misroutes; do not tune around this advisory fixture without production evidence.
- Provider-failure copy is integration-tested only. A real outage test belongs on an isolated
  preview service, never VIGA's production model account.
- F-065, F-084, B-008, B-034, B-036, B-048 and **B-079** (four Alerts-page tests lost to F-101's
  cleanup) remain planned.

### Reachable today, for reference

- **Pause/end is reachable by both VIGA and the farmer.** The admin half is the toggle and Remove
  on Stands & Sellers; the farmer's is `LINK`/`SETTINGS`, with `mayPause` riding each listing from
  the seam's own arm so no control is offered the seam would refuse. VIGA's pause asks first;
  resume is not gated, because it puts something back.

## Where the traps live

The hard-won gotchas — vitest's misleading tail, populated-schema migration tests, snapshot
repair by measurement, sabotage that proves nothing, NULL semantics, first-insert races, the
GSM-7 encoding cliff — are in [DEVELOPMENT.md](DEVELOPMENT.md) §gotchas peculiar to this
codebase, which owns them. **Read that section before touching migrations, constraints, tests,
or SMS copy.**

- RUNBOOK owns migration generation/order, production fingerprinting, seeding, secret rotation,
  immutable-image deployment, and Neon reachability. DEVELOPMENT owns codebase/test gotchas.
