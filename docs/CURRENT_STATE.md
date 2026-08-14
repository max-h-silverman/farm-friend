# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves customer SMS inquiry and paging, farmer stock
  updates and reminders, stock-out reporting, farmer onboarding/settings, administrator tools,
  the public stand map/details, and the contact card at `/viga-farm-friend`.
- **Customer inquiry classifies before it matches catalog values** (B-068/B-069). The first model
  call sees the message alone and returns a strict route-specific operation. Inventory/payment alone
  use a second value-only catalog matcher; code validates matches, expands them to every supporting
  stand and evidence voice, orders, pages, and renders them. Broad, hours, location, overview,
  clarification, system inquiry, chitchat, and deterministic VIGA Bucks handling make no matcher call.
- **The SMS answer format is B-062/B-063's:** one entry per stand, name → claims → address, explicit
  recency, three stands per page, and a bare `Map:` close. Confirmed inventory remains `Last seen`
  through day 28; usual offerings remain `May have`/`May also have` and cannot displace confirmed
  evidence for the same item. Open-now returns only stands confirmed open at render time.
- **Broad availability is a first-class operation.** Call #1 sees no catalog, so catalog contents
  cannot change broad into inventory. Generic inventory nouns remain broad; meaningful categories
  narrow the catalog. `when do you open?` is a system inquiry, while second-person stand inventory
  and payment questions remain stand inquiries.
- **Stand cards lead with availability:** confirmed items or `Nothing confirmed recently`, then
  Typical Offerings. The shared freshness threshold is 96 hours for SMS and map warnings.
- **The customer→farmer stock-out path is closed end to end.** A report may name a published item or
  a usual offering; a clarifying question is held for 15 minutes and then completes the report.
- **A removed farm leaves every public surface** (B-066). Hidden test farms remain operator-visible;
  removed real farms do not. `stand_items` holds one item per row corpus-wide (B-067).
- **The public map link carries `#map`** (F-110). Production refuses to start when the configured URL
  differs from the constant embedded in customer copy.
- **Every opt-in keyword offers the contact card** — `JOIN`, `START`, `VIGA` — and farmer onboarding
  completion sends it beside the listing-live message. Carrier recovery remains `START`.
- **Code owns closure timing and consequential output.** Models select bounded values; they do not
  write public claims, authorize publication, resolve mutable open-now state, or choose evidence.
- Neon `neondb` has **42 applied migrations (`0000`–`0041`)**. This release adds no migration.
- Cloud Run web `farm-friend-web-00076-nn4` and worker `farm-friend-worker-00071-m2q` serve digest
  `sha256:03dd49d94130cbd7d247b68bf1ef2425decde4dc330706a6ac87f152f75616f5`, built from merged
  `main` `a636cbe` and deployed 2026-08-13. Mounted-secret freshness, public API, health, protected
  routes, and served-card assertions pass; neither revision has an error-level log.
- **This repo has no CI.** Local suites are the merge gate; `gh pr checks` has no required checks.

## Verification

- **2,036 unit tests pass; 7 corpus-only tests skip.** **953 integration tests across 63 files pass**
  against disposable local Postgres databases (2026-08-13).
- Typecheck, lint, production web build, and scripted evals pass: critical 11/11, advisory 4/4,
  adversarial 19/19. The build retains tracked Next configuration/lint warnings (B-008).
- Live model evals pass: containment 4/4, closure 7/7, quality 16/16, operation 5/5, catalog 7/7;
  broad/inventory 13/13, other operations 7/7, second-person boundaries 5/5, VIGA/domain 5/5.
- The full top-level corpus is 52/53 with only the pre-existing `what is viga` miss. The gate fails
  on any new miss rather than treating that known baseline as a B-069 regression.
- Production deployment is verified by immutable digest and revision readback, deploy assertions,
  health/public/protected-route checks, and served-card wire bytes. No schema change was owed.

## Standing facts a cold start needs

- Farmer onboarding sends the farmer to text **VIGA** from their stated handset; `START` remains the
  carrier recovery fallback. Onboarding inventory publishes only after verified handset redemption.
- VIGA Farm Bucks is a farmer-owned acceptance claim, stored apart from payment methods. `LINK`,
  `STAND`, and `SETTINGS` retain their deterministic farmer behavior.
- A dated stock claim has one provenance: `sms`, `web`, or `viga`. `visitability` controls whether
  a stand gets a map invitation and directions link.
- Inquiry matching receives each unique public item/payment value once and no stand association.
  `pending_result_lists.broad` is written but deliberately unread until that table next migrates.
- `DEEPINFRA_API_KEY` is VIGA-owned. Live evals intentionally fail provider errors rather than
  counting a contained refusal as model quality.
- Local integration tests require Postgres and run with `npm run test:integration:local`; the plain
  command fails loudly when `DATABASE_URL` is absent. `psql` lives under Homebrew's Postgres 16 path.
- Migration `when` stamps can land behind their predecessor on this machine; RUNBOOK §Migrations owns
  the repair. Every production plan must include `infra/production.tfvars`.

## Open before go-live

- Finish physical-handset checks: farmer onboarding/consent, contact card, paged SMS, administrator
  and settings flows, F-105 stand details at phone width, Squarespace embeds, and `?hidden=true`.
- **B-068/B-069 still need handset confirmation:** `cucumber` must retain Forest Garden's dated
  `Last seen` evidence, and representative inventory/broad/payment replies should confirm the reduced
  model-call path under production transport.
- **B-066 owes one console check:** remove a test farm, confirm map/SMS disappearance, then restore it.
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

- RUNBOOK owns migration generation/order, production fingerprinting, seeding, secret rotation,
  immutable-image deployment, and Neon reachability. DEVELOPMENT owns codebase/test gotchas.
