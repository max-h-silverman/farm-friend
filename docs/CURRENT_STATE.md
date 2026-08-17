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

## F-114 — the multi-seller model, on `main` and NOT deployed

All phases (B through C.5) are merged; C.5 was the last. The governing contract is §the
stand-and-sellers correction in `docs/plans/farmer-behavior-architecture-plan.md`; the reasoning,
the per-phase sabotage enumerations, and the defects found on the way are in
[SESSION_LOG.md](SESSION_LOG.md), not here.

**The model.** `sellers` is the identity root; `sales_locations.own_seller_id` is the
**self-pointer** naming the one nested seller that IS the stand, NULL for a venue like Morgan
Hill; `stand_providers` holds one row per seller-at-stand. **Every suppression and labelling rule
follows that pointer, never a name match** — `sellerCredit`/`creditSeller` state it once, and
since F-115 the public cards, the SMS menu, the settings screen and the reminder rows all
compose them (`listing-label-agreement.test.tsx` compares the surfaces, not the helper). An
authorization names a seller OR a stand; "stand owner" stays derived. `setProviderParticipation` (F-115) is the writer for pause, resume
and end, and `provider-invalidation.ts` is the consequence it triggers for all three.

**What a farmer can do.** Two sellers at one stand publish, are targeted by SMS, hold their own
standing link, and carry their own reminder cadence — independently. Hosting is invitation →
acceptance with no VIGA step; the hosting invitation IS the farmer invitation, and both doors take
a name, never a seller id. A paused listing is offered re-opening rather than refused. Two seams
answer "may this phone write this": `resolveProviderWriteAuthority` (whose STOCK) and
`resolveStandWriteAuthority` (facts about the PLACE). **Pausing HIDES a seller's current public
facts and keeps her reachable** (max, 2026-08-17): `provider-liveness.ts` states those as two
fragments — `publicProviders` (active only) and `reachableProviders` (active or paused) —
composed by all ten sites that hand-wrote one predicate before F-115.

**What a customer sees.** Every public and SMS surface reads PER SELLER from one seam
(`readStandProviderFacts`), so one farmer's goods can never be dated by another's update. The
stand card is item-first — each item once, its sellers nested with their own price and freshness.
`/sellers` is the only discovery path for a hosted-only seller, who has no pin. A seller's
open-now state is the INTERSECTION with the stand's. **A stand shutdown publishes nothing
itemized** (this reversed a prior deliberate choice). Stock-out reports route by CONTRADICTION,
not recency.

**Live consequences shipped deliberately (max, 2026-08-16):** the 18 stands publishing no
confirmed inventory stop receiving stock-out alerts entirely, and a closed stand's card loses its
item list. **A paused listing now leaves the map, `/sellers`, the stand card and both SMS
retrieval queries** (max, 2026-08-17) — two tests asserted the opposite, both written while
`paused` was a state nothing could enter.

**Deliberately unchanged:** VIGA's `issue_link` stays stand-shaped and REFUSES on ambiguity;
`farm_bucks_*`, `farm_approval_id`, every `farmer_*` table, the operator-facing "Farms" tab label,
and `GENERIC_WORDS` keep their names.

## Deployment and migrations

- Neon `neondb` has **42 applied migrations (`0000`–`0041`)**. **`0042` through `0051` are all
  unapplied to production** and must land in that order. **`0042` must be applied before the merged
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
  run 2026-08-14 — **no F-114 phase changed a seam projection, schema, or output contract**, so no
  live run is owed. Checked rather than assumed each time, including for C.5, which DOES change
  what retrieval returns: `packages/ai` is untouched, `providerId` appears nowhere in it, and the
  matcher's catalog is a `Map` keyed on the lowercased name, so the extra per-seller rows collapse
  to the same unique values with no stand or provider association.
- **F-114 is sabotage-proved throughout** — 146 deliberate breakages across its phases, each
  caught by the case aimed at it, and every migration proved against a **populated** copy of the
  schema that precedes it. **Eighteen escapes, and every one was ONE failure: a guard is
  unfalsifiable until a case exists where it is the ONLY thing that could refuse.** All are closed.
  **Assert the absence of the wrong behavior; when a breakage changes no test result, ask which
  other guard answered first; and confirm the sabotage actually applied before concluding a guard
  is redundant** — C.5 produced three mis-aimed sabotages that read exactly like escapes. The
  per-phase enumerations are in [SESSION_LOG.md](SESSION_LOG.md); the standing forms are in
  DEVELOPMENT.md §gotchas.
- **`sellers_name_not_blank` admits a tab-and-newline name** — `trim()` strips spaces only. It
  predates F-114 and seventeen `*_not_blank` CHECKs share it. The suite asserts that measured truth
  in two cases rather than the constraint's name; **B-076** files the sweep, and the admitting case
  is marked INVERT WHEN FIXED.
- **One integration file failed intermittently under full-suite parallel load** (B-078). **Not seen
  again since** — two full runs this session were clean at 1347/1347, and the suite has grown by
  four files since it last appeared. Capture the full run to a file the next time it does; the file
  name was lost to a summary grep last time.

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
