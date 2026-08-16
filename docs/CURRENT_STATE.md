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

Phases B, C.0, and C.1 (records + invitation) are merged. The governing contract is §the
stand-and-sellers correction in `docs/plans/farmer-behavior-architecture-plan.md`.

- **A stand has a name, metadata, and nested sellers.** `sellers` is the identity root (renamed from
  `farms`, ids preserved); `sales_locations.own_seller_id` is the **self-pointer** naming the one
  nested seller that IS the stand, NULL for a venue like Morgan Hill; `stand_providers` holds one
  row per seller-at-stand with `seller_id` NOT NULL — **there is no native brand slot**. Public
  suppression follows the self-pointer, never a name match. `provider-invalidation.ts` is the
  pause/revoke/close mechanism.
- **An authorization names a seller OR a stand**, enforced by the biconditional
  `farmer_authorizations_subject_arm`, each arm with its own partial uniqueness index. **"Stand
  owner" stays derived** through the self-pointer and is never stored.
- **Hosted-seller invitation is built.** A stand owner or VIGA names a seller and gets a one-use
  link to forward; the invited seller fills the ordinary onboarding form and texts `START`, which
  authorizes them and activates the relationship in one transaction. **No approval queue and no VIGA
  step** — the invitation is the approval. The hosting invitation IS the farmer invitation:
  `farmer_invitations.stand_provider_id` binds the relationship, and
  `invited_by_authorization_id` carries the vouching owner until acceptance can legally record it.
- **`stand_providers.host_may_update_stock` is the hosted seller's opt-in** — off by default, off
  for every backfilled row, and untouched by acceptance.
- **Both invite doors now have a person's way in.** VIGA's is a per-stand control inside each Farms
  card; the stand owner's is `invite_seller` on `/api/farmer/stand`, reached from "Invite someone to
  sell here" in stand settings and vouched by the authorization the link already resolved
  (`approval_source = 'host'` at acceptance). The farmer's door takes a **name, never a seller id** —
  the roster would widen the link's projection. **No new SMS keyword**: `LINK` and `SETTINGS`
  already text the farmer that page. Both doors answer with the complete onboarding URL, shown once.
  **A seller name is now public-text-guarded at the writer**, one place for both doors. Still not
  built: the invited seller's stand-scoped onboarding fields.
- **A leaked farmer link can now create a seller and a `pending` relationship at its own stand.** It
  still authorizes nobody — acceptance needs the invited seller's own handset and a bare `START` —
  and `pending` is invisible to every public reader. Asserted beside the other five bounds.
- **A venue still cannot record a closure** — `closure_revisions` demands a seller in three NOT NULL
  columns. **B-077**; it needs the closure writer's stand arm, not a nullable column.
- **The rest of C.1 — per-provider publication, the seller list, item-first cards — is NOT built.**
  Deliberately NOT renamed: `farm_bucks_*` (a VIGA program), `farm_approval_id`, every `farmer_*`
  table (those name the PERSON acting), the operator-facing **"Farms" tab label**, and
  `GENERIC_WORDS` in the corpus matcher.

## Deployment and migrations

- Neon `neondb` has **42 applied migrations (`0000`–`0041`)**. **`0042`, `0043`, and `0044` are all
  unapplied to production** and must land in that order. `0042`'s content changed: the merged
  `0042_multi_seller_stand_providers` was **replaced in place** by `0042_seller_root`, because no
  database anywhere had applied it — production therefore never sees the native-slot model at all.
- **`0042` must be applied before the merged code runs.** Every writer now supplies `provider_id`;
  against the un-migrated schema they fail immediately. `0043` and `0044` add no such requirement on
  their own, but must not land ahead of `0042`.
- Cloud Run web `farm-friend-web-00082-2pl` and worker `farm-friend-worker-00077-rxp` serve digest
  `sha256:14347f34924bca7606d15065bebf145d1999feafa7bb222176d2a94f35cd727a`. Deployed 2026-08-14;
  neither revision has an error-level log. **B-074 and all of F-114 are on `main` and undeployed.**

## Verification

- **2,074 unit tests pass; 7 corpus-only tests skip.** Integration is **1133/1133 across 77 of 77
  files** against disposable local Postgres databases (2026-08-15).
- Typecheck, lint, and scripted evals pass: critical 11/11, advisory 4/4, adversarial 19/19.
  The build retains tracked Next configuration/lint warnings (B-008).
- Live model evals pass: containment 4/4, closure 7/7, quality 16/16, operation 5/5, catalog 7/7;
  broad/inventory 13/13, other operations 7/7, second-person boundaries 5/5, VIGA/domain 5/5. Last
  run 2026-08-14 — **no F-114 phase has changed a seam projection, schema, or output contract**, so
  no live run is owed. Checked rather than assumed each time: the new columns appear only in the db
  package, migrations, and build output, with the search proved against a known-present term first.
- **F-114's constraints are sabotage-proved throughout.** 43 cases for the seller root, 20 for the
  authorization arms, and 21 for the hosting invitation. Across the three tranches **41 deliberate
  breakages were each caught by the case aimed at them**. Every migration is proved against a
  **populated** copy of the schema that precedes it, asserting exact row effects plus a re-run
  proving it is a no-op.
- **The two invitation doors add 12 sabotage-proved cases** (public-text guard both directions, the
  vouch column, stand scoping, revocation, the `sellerId` refusal, blank names, retired stands,
  save/invite separation on both the standalone and tab-committed paths, and the once-shown link).
  **One sabotage escaped and was closed**: asserting that Invite posts once said nothing about what
  Save does, so a `save()` that also invited went unnoticed until the tab-commit path got its own
  case. Two migrations' worth of caution applies to test claims too — the escaped one is why.
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

- **`0042`, then `0043`, then `0044` must be applied to production before the code that requires
  them.** All three are Max's call.
- Finish physical-handset checks: farmer onboarding/consent, contact card, paged SMS, administrator
  and settings flows, F-105 stand details at phone width, Squarespace embeds, and `?hidden=true`.
  Every texted link now carries `farmfriend.vigavashon.org` and none has been read on a handset.
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
