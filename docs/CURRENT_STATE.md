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

## F-114 — what is on `main` and NOT deployed

Phases B through C.4 are merged (C.4 as `ac3fcd5`, PR #128). **C.5 is built and green on
`f-114-c5-public-seller-views`, unmerged.** The governing contract is §the
stand-and-sellers correction in `docs/plans/farmer-behavior-architecture-plan.md`; the reasoning
behind each phase is in [SESSION_LOG.md](SESSION_LOG.md), not here.

- **A stand has a name, metadata, and nested sellers.** `sellers` is the identity root;
  `sales_locations.own_seller_id` is the **self-pointer** naming the one nested seller that IS the
  stand, NULL for a venue like Morgan Hill; `stand_providers` holds one row per seller-at-stand with
  `seller_id` NOT NULL — there is no native brand slot. **Every suppression and labelling rule
  follows that pointer, never a name match.** `provider-invalidation.ts` is the pause/revoke/close
  mechanism.
- **An authorization names a seller OR a stand** (`farmer_authorizations_subject_arm`, biconditional,
  one partial uniqueness index per arm). **"Stand owner" stays derived** and is never stored.
- **Two seams answer "may this phone write this".** `resolveProviderWriteAuthority` — whose STOCK:
  the seller's own phone, the stand's phone under `host_may_update_stock` (off by default, the
  seller's to grant), or the stand arm at a venue. `resolveStandWriteAuthority` — facts about the
  PLACE, because a shutdown is not any seller's stock and a venue has no provider to ask about.
  `PROVIDER_AUTHORITY_ARMS` states those three arms once for the readers that ask *which* providers
  a phone may reach; the two directions' agreement is a tested invariant, not shared SQL.
- **Hosting is invitation → acceptance, with no VIGA step.** A stand owner or VIGA names a seller and
  gets a one-use link to forward; the invited seller fills the ordinary onboarding form and texts
  `START`, which authorizes them and activates the relationship in one transaction. The hosting
  invitation IS the farmer invitation. Both doors take a **name, never a seller id**, return the URL
  once, and public-text-guard the name at the writer. No new SMS keyword — `LINK`/`SETTINGS` already
  text the farmer that page.
- **Two sellers at one stand publish and are reached independently.** Zoe states Gracie's Greens'
  stock at Kelsey's stand without touching Kelsey's listing, is targetable by SMS in her own right,
  and holds her own standing link. A target is a PROVIDER, not a stand; the menu names the seller
  only where it differs from the stand and asks *"Which listing do you mean?"*. A withdrawn opt-in or
  an ended relationship kills a bookmarked link on the next load.
- **A venue can record a closure** (B-077 closed). `closure_revisions_guard_arm` makes the STAND
  decide the arm, so no stand can take the venue's weaker arm and skip the approval gate.
- **Stock-out reports route by CONTRADICTION, not recency.** Listed in a provider's current revision
  → told; published a listing without it → agrees, skipped; no confirmed claim (usual-only or never
  listed) → never told, filed for VIGA. Candidates span every live provider, so a hosted seller's
  goods are reportable. **Live consequence, shipped deliberately (max, 2026-08-16): the 18 stands
  publishing no confirmed inventory stop receiving stock-out alerts entirely.**
- **A leaked farmer link can create a seller and a `pending` relationship at its own stand.** It
  authorizes nobody — acceptance needs the invited seller's own handset and a bare `START` — and
  `pending` is invisible to every public reader. Asserted beside F-040's other five bounds.
- **Reminder cadence is per LISTING**, in `inventory_prompt_preferences` alone — it holds the
  scheduler's cursor, so nothing else may carry the cadence. The write seam refuses the HOST arm:
  `host_may_update_stock` grants a physical observation about stock, and a schedule is not one, so
  only the seller's own arm sets it. The scheduler pass and the settings screen both follow the
  PREFERENCE'S seller, never the roof's.
- **A paused listing is offered re-opening, never refused**, gated at
  `confirmInventoryPublication` — the one seam a fresh update, a pre-pause prompt reply and `SAME`
  all funnel through. The consent is `reopening_stated_version` on the proposal, written when the
  prompt stating the consequence was composed and bound to that version; the farmer answers with an
  ordinary `YES` (max, 2026-08-16), no new keyword. Publishing re-opens the listing.
- **Every customer surface now reads PER SELLER**, from one seam
  (`readStandProviderFacts`). The map, SMS retrieval and the seller list had each kept the Phase
  A shape — `is_current` keyed on the stand — which after Phase B returned every seller's entries
  under one stand-wide `published_at`, dating one farmer's goods by another's update with nothing
  erroring. The stand card is **item-first**: each item once, its sellers nested with their own
  price and freshness; the stand's own seller renders unlabelled **by self-pointer** and every
  other is credited (`sellerCredit`/`creditSeller`, one predicate, two renderings, shared with the
  SMS menu and the settings screens). `items` and `usualOfferings` are DERIVED from the per-seller
  facts, so the two shapes cannot disagree.
- **A stand shutdown publishes nothing itemized** — both registers, every shape, and the recency
  that would date them. This REVERSED a prior deliberate choice (a closed stand used to keep its
  card), and `closure-public.integration.test.ts` records the reversal.
- **The seller list at `/sellers` is the only discovery path for a hosted-only seller**, who owns
  no stand and has no pin. It carries search over a seller's own name and goods — deliberately
  NOT the stands they sell at — and distinguishes "their own stand" from "selling at".
- **A seller's open-now state is the INTERSECTION with the stand's**, and
  `intersectAvailability` finally has a consumer. Closed inside an open stand; never open inside a
  closed one; an unstated stand schedule permits rather than closes.
- **An SMS fact id now names the provider** (`providerFactId`) — a suffix, because the offering
  variant's nibble encoding has four values and a stand has unbounded sellers.
  `standKeyOfFactId` strips it first, so every id already in a pending list still resolves.
- **Two defects found in passing and fixed**: the SMS offerings half joined `stand_items` on the
  stand, leaking a hosted seller's usual items from ended relationships, unaccepted invitations
  and retired sellers; and the ADMIN roster listed a two-seller stand **twice** with half its
  inventory each time. Both measured against a real database before and after.
- **Still stand-shaped on purpose:** VIGA's `issue_link`, which resolves its
  `(authorization, stand)` pair to one listing and REFUSES on ambiguity rather than picking.
- Deliberately NOT renamed: `farm_bucks_*`, `farm_approval_id`, every `farmer_*` table (those name
  the PERSON acting), the operator-facing **"Farms" tab label**, and `GENERIC_WORDS`.

## Deployment and migrations

- Neon `neondb` has **42 applied migrations (`0000`–`0041`)**. **`0042` through `0050` are all
  unapplied to production** and must land in that order. `0042`'s content changed: the merged
  `0042_multi_seller_stand_providers` was **replaced in place** by `0042_seller_root`, because no
  database anywhere had applied it — production therefore never sees the native-slot model at all.
  C.4 edited `0042` in place again for the same reason, deleting the duplicate cadence columns, and
  repaired a real defect in its snapshot: it carried **two `public.sellers` blocks**, the second
  being Phase B's deleted table. JSON keeps the last duplicate, so drizzle read the dead one —
  masked only because `0047` is the head `generate` diffs.
- **`0042` must be applied before the merged code runs.** Every writer now supplies `provider_id`;
  against the un-migrated schema they fail immediately. `0043`–`0050` add no such requirement on
  their own, but must not land ahead of `0042`.
- **`0045`–`0049` are constraint-only and were NOT generated** (`0050` adds one nullable column) — `drizzle-kit` does not
  emit them. **`0047`'s snapshot was built as a measured DELTA of `0046`'s**, not by introspection,
  and that is now the documented method: measured on this branch, `generate` on the merged base says
  *"No schema changes"*, an introspected `0047` snapshot makes it emit **16KB** of constraint churn,
  and the delta-edited snapshot returns it to *"No schema changes"*. Introspection repairs an
  already-drifted snapshot and DEGRADES a healthy one. DEVELOPMENT.md §gotchas owns the corrected
  procedure, including that `generate` appends a journal entry as a side effect.
- Cloud Run web `farm-friend-web-00082-2pl` and worker `farm-friend-worker-00077-rxp` serve digest
  `sha256:14347f34924bca7606d15065bebf145d1999feafa7bb222176d2a94f35cd727a`. Deployed 2026-08-14;
  neither revision has an error-level log. **B-074 and all of F-114 are on `main` and undeployed.**

## Verification

- **2,152 unit tests pass; 7 corpus-only tests skip.** Integration is **1347/1347 across 96 of 96
  files** against disposable local Postgres databases (2026-08-16).
- **`npm run test:integration` needs `PUBLIC_BASE_URL` exported as well as `DATABASE_URL`.** Without
  it eight `farmer-stand` cases fail `ConfigurationError: PUBLIC_BASE_URL is required` — identical on
  the untouched merged base, so it is an environment fact, not a regression.
- Typecheck, lint, and scripted evals pass: critical 11/11, advisory 4/4, adversarial 19/19.
  The build retains tracked Next configuration/lint warnings (B-008).
- Live model evals pass: containment 4/4, closure 7/7, quality 16/16, operation 5/5, catalog 7/7;
  broad/inventory 13/13, other operations 7/7, second-person boundaries 5/5, VIGA/domain 5/5. Last
  run 2026-08-14 — **no F-114 phase has changed a seam projection, schema, or output contract**, so
  no live run is owed. Checked rather than assumed each time. For C.3: `packages/ai` and
  `packages/core` are untouched, `projectStockOutParse` still projects exactly
  `{entryId, itemName}`, and `providerId` appears nowhere in the AI package — with the search proved
  against a known-present term (`entryId`) first. **For C.5**, which DOES change what retrieval
  returns: `packages/ai` is untouched, `providerId` still appears nowhere in it, and the matcher's
  catalog is a `Map` keyed on the lowercased name — so the extra per-seller rows collapse to the
  same unique values, with no stand or provider association, and the seam's projection is
  byte-identical for the same underlying data.
- **F-114 is sabotage-proved throughout.** 53 breakages across the seller root, authorization arms,
  hosting invitation and doors; 22 more across C.2; 19 more across C.3; 21 more across C.4;
  **31 more across C.5** — each caught by the case aimed at it. Every migration is proved against a **populated** copy of the schema that precedes it,
  asserting exact row effects plus a re-run proving it is a no-op.
- **Eighteen escapes across F-114, and every one was ONE failure: a guard is unfalsifiable until a
  case exists where it is the ONLY thing that could refuse.** All eighteen are closed by cases that
  construct exactly that. C.5 added four: `usually_carried` with no unusual item beside a usual
  one; a hidden-price case whose item had no price to hide; a venue case for the null self-pointer;
  and the SMS offerings gate with no hosted seller to refuse. **C.5 also produced three MIS-AIMED
  sabotages that looked like escapes** — a perl pattern that never matched, a `limit 1` inside an
  aggregate, and a spread that did not remove the key it appeared to. Confirm the sabotage
  actually applied before concluding a guard is redundant. **Assert the absence of the wrong behavior; and when a breakage changes no
  test result, ask which other guard answered first.** The per-phase enumerations are in
  [SESSION_LOG.md](SESSION_LOG.md); the standing forms are in DEVELOPMENT.md §gotchas.
- **`sellers_name_not_blank` admits a tab-and-newline name** — `trim()` strips spaces only. It
  predates F-114 and seventeen `*_not_blank` CHECKs share it. The suite asserts that measured truth
  in two cases rather than the constraint's name; **B-076** files the sweep, and the admitting case
  is marked INVERT WHEN FIXED.
- **One integration file failed intermittently under full-suite parallel load** (B-078) — 1124 tests
  passed beside a failed *file*. Re-run was 77/77 and both heavy candidates were green in isolation.
  Capture the full run to a file the next time it appears; the file name was lost to a summary grep.

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

- **`0042` through `0050`, in order, must be applied to production before the code that requires
  them.** All nine are Max's call.
- **VIGA's stock-out queue is the only destination for reports at the 18 stands publishing no
  confirmed inventory** — decided and accepted (max, 2026-08-16), not an open question. Those stands
  are texted today and will not be once C.3 deploys; it resolves as they start confirming inventory.
  Worth VIGA knowing their queue carries those reports in the meantime.
- Finish physical-handset checks: farmer onboarding/consent, contact card, paged SMS, administrator
  and settings flows, F-105 stand details at phone width, Squarespace embeds, and `?hidden=true`.
  Every texted link now carries `farmfriend.vigavashon.org` and none has been read on a handset.
- **C.5's two new customer surfaces owe a handset pass.** The item-first stand card (an item
  once, sellers nested with their own price and freshness, the stale one ambered) and the seller
  list at `/sellers` with its search box. Both were read in a browser and MEASURED — no horizontal
  overflow at 360px and 390px, credited lines wrap rather than spill, and no C.5 rule sits in a
  `prefers-color-scheme` block so the light-only palette holds under a dark OS. Neither has been
  seen on a real phone. The map also gained a **"Browse by seller"** link in its filter header.
- **C.4 adds ONE farmer-facing sentence owing a handset pass**: `Publishing this update will
  re-open your listing. Reply YES to confirm, NO to cancel.` — the paused listing's confirmation,
  which replaces the ordinary publish prompt rather than joining it. Verified GSM-7 by
  `reply-encoding.test.ts` and asserted in the rendered reply; not read on a phone. The settings
  screen's new per-listing labels (`Stand — Seller`) owe the same pass.
- **C.3's farmer-facing SMS copy owes a handset pass**: the menu now reads *"Which listing do you
  mean?"* and names the seller beside the stand where they differ, and `Using …` / `Update your
  listing for …` carry the same label. Verified in integration and by encoding (still GSM-7); not
  read on a phone.
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
  three administrator tabs — including the two new invitation controls, whose once-shown link sits in
  a read-only input a farmer has to be able to select on a handset. F-065, F-084, B-008, B-034,
  B-036, F-101, and B-048 remain planned.
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
