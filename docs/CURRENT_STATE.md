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
- **F-114 Phases B, C.0 and C.1-records are merged to `main` and NOT deployed.** A stand has a
  name, metadata, and **nested sellers**: `sellers` is the identity root (renamed from `farms`,
  ids preserved), `sales_locations.own_seller_id` is the **self-pointer** naming the one nested
  seller that IS the stand and NULL for a venue like Morgan Hill, and `stand_providers` holds one
  row per seller-at-stand with `seller_id` NOT NULL — **there is no native brand slot**. Revisions,
  usual items, proposals, farmer links, prompt preferences, scheduled prompts and SMS targeting all
  carry a provider; one-current and one-usual-name are **per provider**, and one open SMS
  confirmation is per person **per provider-at-stand**. Public suppression follows the self-pointer,
  never a name match. `provider-invalidation.ts` is the pause/revoke/close mechanism. The governing
  contract is §the stand-and-sellers correction in
  `docs/plans/farmer-behavior-architecture-plan.md`, which overrides four reviewed decisions.
- **An authorization names a seller OR a stand** (C.1 records, `0043`), enforced by the
  biconditional `farmer_authorizations_subject_arm`, each arm with its own partial uniqueness
  index. The stand arm exists for the venue that has no seller of its own; **"stand owner" stays
  derived** through the self-pointer and is never stored, so this is not a second permission
  system. The nine composite keys onto `(authorization, seller)` are unchanged and a stand-armed
  row satisfies none of them. `stand_providers.host_may_update_stock` is the hosted seller's
  opt-in for the host stating their stock — **off by default and off for every backfilled row**.
  **No writer creates a stand-armed row yet**, so the arm is inert until the invitation sub-phase.
- **A venue still cannot record a closure** — `closure_revisions` demands a seller in three NOT
  NULL columns. **B-077**; it needs the closure writer's stand arm, not a nullable column.
- **The rest of C.1 — invitation, per-provider publication, the seller list, item-first cards — is
  NOT built.** Deliberately NOT renamed by C.0: `farm_bucks_*` (a VIGA program), `farm_approval_id`,
  every `farmer_*` table (those name the PERSON acting), the operator-facing **"Farms" tab label**,
  and `GENERIC_WORDS` in the corpus matcher.
- Neon `neondb` has **42 applied migrations (`0000`–`0041`)**.
  **Neither `0042` nor `0043` is applied to production**, and `0042`'s content changed: the merged
  `0042_multi_seller_stand_providers` was **replaced in place** by `0042_seller_root`, because no
  database anywhere had applied it (production ledger 42 rows `0000`–`0041`; every local database
  at most 40). Production therefore never sees the native-slot model at all. `0043` must follow
  `0042`, in that order.
- Cloud Run web `farm-friend-web-00082-2pl` and worker `farm-friend-worker-00077-rxp` serve digest
  `sha256:14347f34924bca7606d15065bebf145d1999feafa7bb222176d2a94f35cd727a`. Deployed 2026-08-14;
  neither revision has an error-level log. **B-074 and F-114 Phases B and C.0 are on `main` and
  undeployed**; production still serves the revisions above.
- **This repo has no CI.** Local suites are the merge gate; `gh pr checks` has no required checks.

## Verification

- **2,063 unit tests pass; 7 corpus-only tests skip.** Integration is **1077/1077 across 73 of 73
  files** against disposable local Postgres databases (2026-08-15).
- Typecheck, lint, and scripted evals pass: critical 11/11, advisory 4/4, adversarial 19/19. The
  build retains tracked Next configuration/lint warnings (B-008).
- Live model evals pass: containment 4/4, closure 7/7, quality 16/16, operation 5/5, catalog 7/7;
  broad/inventory 13/13, other operations 7/7, second-person boundaries 5/5, VIGA/domain 5/5. Last
  run 2026-08-14 — **F-114 Phases B, C.0 and C.1-records changed no seam projection, schema, or
  output contract**, so no live run was owed. Checked rather than assumed for C.1: the four seam
  files receive no authorization data, and the only matches for the term are comments saying so.
- The full top-level corpus is 52/53 with only the pre-existing `what is viga` miss. The gate fails
  on any new miss rather than treating that known baseline as a regression.
- **F-114's constraints are sabotage-proved.** 43 cases assert the exact row each index and CHECK
  refuses, now including C.0's replacements for the removed native slot: `seller_id` NOT NULL, no
  sellerless row anywhere, no `%native%` index, a venue getting zero fabricated providers, and
  `create_own_seller_provider` firing on insert, on a later self-pointer change, and idempotently
  on a no-op save. `0042` is verified against a **populated** copy of the pre-`0042` schema in that
  schema's own vocabulary — 13 assertions on exact row effects, including id preservation across
  the rename and no constraint or index left carrying the old names, plus a re-run proving it is a
  no-op. Thirteen deliberate breakages across the two suites were each caught by the case aimed at
  them.
- **C.1's two records are sabotage-proved too.** 20 cases across
  `authorization-arms-constraints` and `authorization-arms-migration`; six deliberate breakages —
  each half of the one-arm biconditional, a non-unique stand index, the stock right defaulting to
  `true`, the CHECK added `NOT VALID`, and a migration quietly moving a live authorization onto the
  stand arm — were each caught by the case aimed at them. `0043` is proved against a **populated**
  copy of the post-`0042` schema, including the one phone that acts for two sellers and a
  revoked-then-restored contact.
- **`sellers_name_not_blank` admits a tab-and-newline name** — `trim()` strips spaces only. It is
  the renamed `farms_name_not_blank` and predates F-114; seventeen `*_not_blank` CHECKs share it.
  The suite asserts that measured truth in two cases rather than the constraint's name; **B-076**
  files the sweep, and the admitting case is marked INVERT WHEN FIXED.

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

- **`0042` then `0043` must be applied to production before the code that requires them.** Every
  writer now supplies `provider_id`; against the un-migrated schema they fail immediately. `0043`
  adds no such requirement on its own — no writer produces a stand-armed row yet — but it must not
  land ahead of `0042`.
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

- **Vitest's tail names the wrong file, and a rename defect hides in `select`/read mismatch.** The
  scheduled-prompt failure was diagnosed as an undefined `own_seller_id` in the *db package*
  because that is what the last stack in the output pointed at. It was the SECOND failure; the
  FIRST, 45 lines earlier in the same log, named the real site — `apps/web/lib/scheduled-prompts.ts`
  — and carried its bind parameters (`[uuid, undefined, hash]`), which identified the exact query.
  Capture the whole run to a file and read failure `[1/N]`, never the tail. The defect itself is
  the rename trap's twin: the query `select`s `own_seller_id` and the code reads
  `.owner_seller_id`, so there is no error until the undefined reaches a bind parameter, far from
  the mismatch. Grep for every `.owner_*` read after any column rename.
- **A historical migration test must select its predecessors BY ORDER, never by exclusion.** Both
  populated-schema tests built their pre-migration set as *"every file that is not mine"*, which is
  correct only while that migration is the newest in the repo. The moment `0043` landed it was
  swept into `0042`'s pre-migration set and applied against a schema that had not yet renamed the
  column it alters — and **every future migration would have broken the file the same way**. Use
  `name < "00NN_"`. The failure is loud but names the wrong file, so it reads as a defect in the
  new migration rather than in the old test.
- **A hand-written migration leaves the generator's snapshot stale, and nothing notices until the
  next one.** `0042` renamed `farm`→`seller` columns across sixteen tables in SQL and never updated
  `0042_snapshot.json`, so `drizzle-kit generate` stopped and asked create-or-rename questions
  instead of diffing. Applying stays correct throughout — only generation breaks, which is why
  `migration-metadata.test.ts` (GL-006) checks the newest snapshot rather than any suite catching
  it. **Repair it by measurement, not by hand**: build a database from every migration, run
  `drizzle-kit introspect` against it, and chain that snapshot's `prevId` to its predecessor
  (replacing introspect's all-zero `id` with a real UUID). Hand-editing sixteen tables' worth of
  JSON would be fabricating the evidence the test exists to verify.
- **A historical migration test written in the CURRENT vocabulary proves nothing.** Two suites stop
  at an earlier schema and populate it; the C.0 sweep renamed their fixtures to `sellers` and
  `own_seller_id`, against databases that still had `farms` and `owner_farm_id`. Had the names
  happened to exist, the migration would have been proved against its own output rather than
  against the corpus it has to survive. A fixture's vocabulary must match the schema it populates,
  not the schema the repo is on.
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
