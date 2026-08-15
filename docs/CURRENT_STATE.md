# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves customer SMS inquiry and paging, farmer stock
  updates and reminders, stock-out reporting, farmer onboarding/settings, administrator tools, the
  public stand map/details, and the contact card at `/viga-farm-friend`.
- **Customer inquiry classifies before it matches catalog.** One strict classifier sees the message
  alone; only inventory/payment make a second value-only matcher call. Code validates every match,
  expands it to every supporting stand and evidence voice, orders, pages, and renders. A single-stand
  answer is rendered wholly by code and calls no seam for a product-less question.
- **Code owns closure timing and consequential output.** Models select bounded values; they never
  write public claims, authorize publication, resolve open-now state, or choose evidence.
- **Every public and SMS link is on `farmfriend.vigavashon.org`** (F-113), and `vigavashon.org` DNS
  authenticates VIGA's mail (SPF includes Google; `_dmarc` at `p=none`).
- **A stand has providers** (F-114 Phase B, merged to `main`, **not deployed**). `stand_providers`
  holds one row per seller-at-stand; revisions, usual items, proposals, farmer links, prompt
  preferences, scheduled prompts, and SMS targeting all carry a provider.
  `inventory_revisions_one_current_per_location` became **one-current-per-provider** and
  `stand_items_one_per_location_name` became **one-per-provider-per-name**. One open SMS
  confirmation is now per person **per provider-at-stand**, fixing a defect that predates this work.
  `provider-invalidation.ts` is the pause/revoke/close mechanism that did not exist.
  **Phase B's native brand slot no longer exists** — C.0 replaced it, see below.
  **Hosted-seller behavior — invitation, per-provider publication, the seller list, item-first
  cards — is Phase C.1 and is NOT built.**
- **F-114 Phase C.0 re-roots identity on sellers** (branch `f-114-phase-c0-seller-root`, **PR #122
  open and deliberately unmerged, not deployed**). Max chose to hold it until the last four
  integration files are green, so `main` never carries a knowingly-red suite — this repo has no CI
  to flag one. Max corrected the model before C.1 was written: a stand has
  a name, metadata, and nested sellers. `farms` is renamed to `sellers` (ids preserved, so every
  key keeps pointing at the same rows); `owner_farm_id` is replaced by `own_seller_id`, the
  **self-pointer** naming the one nested seller that IS the stand, NULL for a venue like Morgan
  Hill; `stand_providers.seller_id` becomes NOT NULL and the **native brand slot is gone**. Public
  suppression now follows the self-pointer instead of a name match. Phase B's separate `sellers`
  table merged into the renamed record and its `revoked_at` pair went with it — `retired_at`
  already meant that. The contract section that governs this is §the stand-and-sellers correction
  in `docs/plans/farmer-behavior-architecture-plan.md`; it overrides four reviewed decisions.
- **C.0 is converted and nearly green.** The codebase moved to the seller vocabulary across ~160
  files; the admin route directories are `/admin/sellers`. Deliberately NOT renamed: `farm_bucks_*`
  (a VIGA program), `farm_approval_id`, every `farmer_*` table (those name the PERSON acting), the
  operator-facing **"Farms" tab label**, and `GENERIC_WORDS` in the corpus matcher — where "farms"
  is an English word farmers type into stand names.
- **Integration is 979/1046 across 67 of 71 files** (2026-08-15). Four files still fail:
  `stand-providers-constraints`, `multi-seller-migration`, and `stand-items-backfill` assert Phase
  B's **native brand slot**, a concept C.0 removed, so they need rewriting rather than repair;
  `apps/web/lib/scheduled-prompts.integration.test.ts` fails its whole fixture on an undefined
  `own_seller_id` read whose cause was not found — the column returns a value when queried
  directly, so the next session should measure inside the running fixture rather than infer.
- Neon `neondb` has **42 applied migrations (`0000`–`0041`)**.
  **`0042` is NOT applied to production, and its content changed**: the merged
  `0042_multi_seller_stand_providers` was **replaced in place** by `0042_seller_root`, because no
  database anywhere had applied it (production ledger 42 rows `0000`–`0041`; every local database
  at most 40). Production therefore never sees the native-slot model at all.
- Cloud Run web `farm-friend-web-00082-2pl` and worker `farm-friend-worker-00077-rxp` serve digest
  `sha256:14347f34924bca7606d15065bebf145d1999feafa7bb222176d2a94f35cd727a`. Deployed 2026-08-14;
  neither revision has an error-level log. **B-074 and F-114 Phase B are on `main` and undeployed**;
  production still serves the revisions above.
- **This repo has no CI.** Local suites are the merge gate; `gh pr checks` has no required checks.

## Verification

- **2,063 unit tests pass; 7 corpus-only tests skip.** Integration is **979/1046 across 67 of 71
  files** against disposable local Postgres databases (2026-08-15) — see the C.0 entry above for
  the four that remain.
- Typecheck, lint, and scripted evals pass: critical 11/11, advisory 4/4, adversarial 19/19. The
  build retains tracked Next configuration/lint warnings (B-008).
- Live model evals pass: containment 4/4, closure 7/7, quality 16/16, operation 5/5, catalog 7/7;
  broad/inventory 13/13, other operations 7/7, second-person boundaries 5/5, VIGA/domain 5/5. Last
  run 2026-08-14 — **F-114 Phase B changed no seam projection, schema, or output contract**, so no
  live run was owed for it.
- The full top-level corpus is 52/53 with only the pre-existing `what is viga` miss. The gate fails
  on any new miss rather than treating that known baseline as a regression.
- **F-114 Phase B's constraints are sabotage-proved.** 36 cases assert the exact row each new index
  and CHECK refuses; seven deliberate breakages were each caught by the suite it was aimed at. The
  migration is verified against a **populated** copy of the pre-`0042` schema — 11 assertions on
  exact row effects, plus a re-run proving it is a no-op.

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

- **`0042` must be applied to production before the code that requires it.** Every writer now
  supplies `provider_id`; against the un-migrated schema they fail immediately.
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
- **Classifier known miss:** `what is viga` → `search_stands` rather than `system_inquiry`. Add real
  misroutes to the corpus; do not tune around this advisory fixture without production evidence.
- Provider-failure copy is integration-tested only. A real outage test belongs on an isolated preview
  service, never VIGA's production model account.
- Phone-width visual checks remain owed for onboarding, farmer settings/listing, map details, and the
  three administrator tabs. F-065, F-084, B-008, B-034, B-036, F-101, and B-048 remain planned.
- VIGA must decide whether Vashon Island Farmers Market belongs in the roster as a farm. F-108 remains
  an idea for a per-answer map showing only returned stands.

## Traps worth not rediscovering

- **A schema rename passes typecheck and breaks every raw SQL string.** Renaming `farms` to
  `sellers` and `owner_farm_id` to `own_seller_id` produced a fully green `npm run typecheck`
  across all three workspaces while 63 non-test files still named the old columns inside tagged
  template literals. Drizzle infers column types from `schema.ts`, so identifier renames propagate
  invisibly; raw SQL is just text. After any rename, grep the old names — never trust the compiler.
- **A populated-schema migration test caught five defects an empty one would have passed.** On
  F-114 C.0: a composite foreign key created before its unique target; six keys rooted on the
  column being dropped; two map-projection triggers depending on that column; 25 constraints and
  13 indexes left asserting `farm_*` names on renamed `seller_*` tables (renaming a table renames
  neither); and eight backfill joins still matching a removed native slot. Only the last two were
  data-dependent — the rest simply never ran in an empty-schema test because nothing referenced
  the column yet.
- **`ALTER TABLE … RENAME` has no `IF EXISTS` form**, so an unguarded rename makes a migration
  non-idempotent and the integration suite applies every file twice. Wrap each in a
  `to_regclass`/`information_schema` guard. Related: a `UNIQUE` constraint's backing index raises
  `duplicate_table`, not `duplicate_object`, so the usual `EXCEPTION WHEN duplicate_object`
  handler lets the error through.
- **Sabotage a guard against the state it actually forbids.** A first attempt to prove the
  map-projection trigger "passed" only because the *other* trigger had already rolled back the
  setup statement — the projection column was still empty, so nothing was ever tested. Read the
  row back before believing a negative result.

- RUNBOOK owns migration generation/order, production fingerprinting, seeding, secret rotation,
  immutable-image deployment, and Neon reachability. DEVELOPMENT owns codebase/test gotchas.
- **`drizzle-kit generate` writes a migration that passes on an empty database and fails on a real
  one.** It emits `ADD COLUMN … NOT NULL` with no default and no backfill; against any table already
  holding a row that is an instant 23502. Add the column nullable, backfill, then `SET NOT NULL` —
  and test against a POPULATED copy of the previous schema, because an empty-schema test is green
  for this entire class of defect.
- **`inventory_revisions` has a trigger that refuses almost every UPDATE.**
  `guard_inventory_revision_history` permits exactly one transition — superseding a current revision
  — so a backfill cannot touch the table at all. `0042` disables it for one statement, re-enables it
  immediately, and widens it to cover the new column. Do not weaken the guard; it is a Golden Rule #1
  protection.
- **The schema vocabulary forbids certain words outright**, `provenance` among them
  (`schema.integration.test.ts` §removes forbidden concepts). It scans schema text, the index file,
  `0000`, and the snapshot — so a constraint NAME or even a doc comment trips it. The camelCase key
  `sourceProvenance` survives only because the pattern is `\bprovenance\b`.
- **A tagged template turns an interpolation into a bind PARAMETER.** Composing shared SQL text into
  a `` driver(db)`…` `` query sends the clause as a string value and dies at parse
  (`syntax error at or near "$1"`). Any query composing `visibleFarms` or the B-074 join fragments
  must use `.unsafe(…)`. Invisible to typecheck and to every test not run against a real database.
- **An assertion on an empty collection can be green whatever the code returns.** The admin roster's
  `currentItems` had one test in the whole suite, checking `[]` on a never-published stand — a query
  returning nothing for every farm would have passed. When a reader's only coverage is its empty
  case, it has no coverage; assert a populated value.
- **One emoji doubles a message's cost.** A single non-GSM-7 character re-encodes the WHOLE body to
  UCS-2, dropping per-segment capacity from 153 to 67. An encoding effect, not a length effect, and
  invisible by inspection. `reply-encoding.test.ts` sweeps every code-owned reply; measure with
  `estimateSmsSegments` before adding any decoration.
- **`npm run test:integration` needs `DATABASE_URL` exported** or every file fails instantly with no
  tests run — the suite failing loudly by design. RUNBOOK §top has the two export lines.
- **A domain mapping reports `Ready: True` before TLS serves** — ~6 minutes ahead on F-113, and a
  request in that window fails certificate verification; inside an iframe that is a silent blank.
  Poll the real request for a 200; never cut an embed over on the mapping's status.
- **Every plan shows two spurious `scaling` updates** (B-073) — a provider artifact, not the
  container template. Real diffs still have to be read; do not learn to skim "2 to change".
- **A stale local server can serve headers the config no longer describes.** A `curl` returned a 200
  with no headers against a build whose manifest clearly contained them — a process left running from
  before the rebuild. Restart before believing either the config or the wire.
