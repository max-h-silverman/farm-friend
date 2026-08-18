# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves customer SMS inquiry and paging, farmer stock
  updates and reminders, stock-out reporting, farmer onboarding/settings, administrator tools, the
  public stand map/details, and the contact card at `/viga-farm-friend`.
- **Customer inquiry classifies before it matches catalog.** One strict classifier sees the message
  alone; only inventory/payment make a second value-only matcher call. Code validates every match,
  expands it to every supporting stand and evidence voice, orders, pages, and renders.
- **Code owns closure timing and consequential output.** Models select bounded values; they never
  write public claims, authorize publication, resolve open-now state, or choose evidence.
- **Every public and SMS link is on `farmfriend.vigavashon.org`** (F-113), and `vigavashon.org` DNS
  authenticates VIGA's mail (SPF includes Google; `_dmarc` at `p=none`).
- **This repo has no CI.** Local suites are the merge gate; `gh pr checks` has no required checks.
- **Client components must import `@farm-friend/core/seller-credit`, never the barrel.**
  `@farm-friend/core` re-exports `privacy/phone.ts` → `node:crypto`, which is unresolvable in a
  client bundle and **500s every farmer web screen in `next dev`**. jsdom resolves the barrel fine,
  so no suite catches it — only launching the app does.

## Unreleased on `main` — three merged tranches, none deployed

**F-114 + F-115 — the multi-seller model.** `sellers` is the identity root;
`sales_locations.own_seller_id` is the **self-pointer** naming the one nested seller that IS the
stand, NULL for a venue. `stand_providers` holds one row per seller-at-stand, and **every
suppression and labelling rule follows that pointer, never a name match** (`creditSeller` states it
once). `setProviderParticipation` is the sole writer for pause/resume/end. Two liveness predicates,
never one: `publicProviders` (active) and `reachableProviders` (active or paused) — **pausing hides
a seller's public facts and keeps her reachable**. Every public and SMS surface dates goods PER
SELLER. A seller's open-now state is the INTERSECTION with the stand's.

**F-101 — the admin console.** Three destinations: **Stands & Sellers · SMS Users · Alerts**; the
"Farms" tab is gone, not renamed, and `/admin` redirects to `/admin/stands`. **The lists are
entities, not states** — one row per stand or seller, a participation always a detail inside a row.
`POST /api/admin/participation` is the thin caller for the seam. **Remove is `end`, terminal, no
restore.** The adapting label reads as the stand being open/closed only where one arrangement is
its own seller's, computed from the whole set so it can never say "closed" while a guest sells.

**F-117 — self-selected hosted sellers.** A farmer onboarding on her own says where she sells:
**one question, four answers** — just my own stand · only at someone else's · both · a farm with no
stand people can visit. Two columns underneath (`visitability` describes *her* place; the
arrangement names *someone else's*), derived from the one answer. `approval_source = 'seller'`
(`0052`) is the honest third value. She is **live on submit**, non-fatally; the host is asked and
may deny (`pending_host_confirmations`, `0053`), answerable only while the question is the last
message in the thread. A host we cannot text still lists her.

**One recorded exception to "no produce taxonomy in a behavioral branch":** `map-view.ts`'s
`FLOWER_VOCABULARY` picks a pin glyph and answers the "Flowers only" filter. Kept because it is
DISPLAY only; `map-view.test.ts` measures the known failure and guards against growth. **A term for
anything that is not a flower means it should become data.**

**`paused` means two unrelated things and stays that way for now.**
`stand_providers.lifecycle_state = 'paused'` is a suspended selling relationship;
`inventory_prompt_preferences.cadence = 'paused'` is reminders off. Renaming the cadence value to
`off` is one migration with no behaviour change, deferred until `0042`–`0053` land.

**Deliberately unchanged:** VIGA's `issue_link` stays stand-shaped and REFUSES on ambiguity;
`farm_bucks_*`, `farm_approval_id`, every `farmer_*` table and `GENERIC_WORDS` keep their names.

**A 2026-08-18 UI pass sits on top of all three** (branch `admin-card-design`). The admin stand
card reads as a profile — a lead block for what is on the shelf and when it was confirmed, then
titled fact groups. The public map's list gained a **View stands / View sellers** toggle replacing
the link to `/sellers`; a chosen seller highlights the stands she sells at, and seller cards render
in the stand card's own shape. **`GEOCODING_API_KEY` now lives only in Secret Manager** —
`dev-setup.sh` fetches it per run and never writes it to `.env.local`.

**F-118 makes the map's two lists one two-way view** (branch `f-118-map-seller-architecture`,
uncommitted at time of writing). The stand/seller relationship is stated once in
`apps/web/lib/stand-seller-graph.ts` and rendered from both sides: a seller card names her stands
as tappable rows carrying their own pin numbers (and as a pin-number strip when collapsed), a
stand card says how many sellers it carries and makes each item credit the link to that seller,
and a pin tapped in seller mode opens a tooltip naming that stand's sellers rather than selecting
the stand. Contract and rules: SURFACES.md §the public map.

**Verified:** 2318 unit tests green, typecheck and lint clean, six sabotages caught (the relation
label, the count threshold, the pooled-line collapse, the tab switch, and both tooltip clamps).
Driven in a real browser against the local database at ~500px: all four crossings work, every
tooltip measured fully inside the island on all four edges with no content clipping, and the
seller card's expanded body measured aligned with its name (47/47, was 47/81). **Not verified:**
any width below 500px — Chrome would not resize smaller — and the item-credit crossing has no
local seed data, so it is covered by unit tests only. `/sellers` still exists and still works, but
nothing links to it and it now renders a weaker seller card than the map does.

## Deployment and migrations

- Neon `neondb` has **42 applied migrations (`0000`–`0041`)**. **`0042` through `0053` are all
  unapplied to production** and must land in that order. `0052` adds
  `stand_provider_approval_source = 'seller'` (F-117) and `0053` adds `pending_host_confirmations`;
  both are proved against a populated schema, and `0052`'s new enum value is proved WRITABLE in a
  statement after the migration — Postgres refuses a new enum value inside the transaction that
  added it, so a clean apply proves nothing on its own. **`0042` must be applied before the merged
  code runs** — every writer now supplies `provider_id`, and against the un-migrated schema they
  fail immediately. `0043`–`0050` add no such requirement on their own but must not land ahead of it.
  **`0051` is a second such gate**: it makes the `stand_providers` uniqueness partial, and
  `inviteSellerToStand` now names that predicate in its `ON CONFLICT`, so against the un-migrated
  index EVERY invitation raises *"no unique or exclusion constraint matching the ON CONFLICT
  specification"*.
- **`0045`–`0049` and `0051` are constraint-only and were NOT generated** (`0050` adds one nullable
  column); `drizzle-kit` does not emit them. A hand-written migration's snapshot is repaired as a **measured
  DELTA of its predecessor, never by introspection** — RUNBOOK §Migrations and DEVELOPMENT.md
  §gotchas own the procedure and the evidence for it.
- Cloud Run web `farm-friend-web-00082-2pl` and worker `farm-friend-worker-00077-rxp` serve digest
  `sha256:14347f34924bca7606d15065bebf145d1999feafa7bb222176d2a94f35cd727a`. Deployed 2026-08-14;
  neither revision has an error-level log. **B-074, F-114/F-115, all of F-101, all of F-117 and
  the 2026-08-18 UI pass (`b14155f`, PR #133) are on `main` and undeployed.** max's call on
  2026-08-18: leave it undeployed for now — the migration queue is scheduled separately, and
  none of the UI work has been seen rendered.

## Verification

- **2,285 unit tests pass across 165 files; 7 corpus-only tests skip** (2026-08-18). Integration is
  **1,435/1,441 across 106 of 107 files** against disposable local Postgres databases (2026-08-17,
  not re-run this session — nothing touched a writer or a query).
- **`npm run test:integration` needs `PUBLIC_BASE_URL` exported as well as `DATABASE_URL`.** Without
  it, six `apps/web/lib/farmer-stand.integration.test.ts` cases fail `PUBLIC_BASE_URL is required`.
  **Verified pre-existing**: checking out `main` reproduces the identical six. An environment fact
  and a test-isolation weakness, not a regression and not a product defect.
- Typecheck, lint, and scripted evals pass: critical 11/11, advisory 4/4, adversarial 19/19.
  The build retains tracked Next configuration/lint warnings (B-008).
- Live model evals pass: containment 4/4, closure 7/7, quality 16/16, operation 5/5, catalog 7/7;
  broad/inventory 13/13, other operations 7/7, second-person boundaries 5/5, VIGA/domain 5/5. Last
  run 2026-08-14. **No live run is owed** — checked rather than assumed each time: nothing in
  F-114, F-115, F-101, F-117 or the 2026-08-18 UI pass changed a seam projection or output
  contract, and `git diff main` shows `packages/ai` and `evals/` untouched.
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

- **`0042` through `0051`, in order, must be applied to production before the code that requires
  them.** All ten are Max's call.
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
