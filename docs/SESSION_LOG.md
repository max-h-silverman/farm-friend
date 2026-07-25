# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [../CLAUDE.md](../CLAUDE.md) "Current State & Open Items"; this file
is the *why behind past changes*.

---

## 2026-07-25 — F-022 clean launch schema and initial migration

Starting from clean `main` at `3d89380` (merged PR #16), the database foundation was replaced
test-first without implementing F-012 through F-019. The first integration run was observed failing
because there was no committed migration, the schema still declared forbidden launch concepts, and
`DATABASE_URL` was absent. The implementation then:

- replaced the speculative schema with contacts, one-level administrator authorization, farms,
  farmer authorization, separate VIGA approval, public farm facts, actionable sales locations,
  farmer links, payment / Farm Bucks facts, immutable published inventory, minimized SMS state,
  launch consent, inventory-publication proposals, private stock-out reports, flags, outbox work,
  dispatch attempts, audit events, and model-run evidence;
- stored normalized raw E.164 once on `contacts` and used the unique phone hash for every workflow,
  queue, evidence, and foreign-key path;
- separated exact / approximate / hidden farm fallback projections from farm-stand and VIGA Farmers
  Market sales locations, with inventory and reports bound only to sales locations;
- added foreign keys, bounded checks, coherent-state checks, partial unique indexes, and explicit
  PostgreSQL guards for fallback projections and immutable published inventory history;
- generated `0000_clean_launch.sql` with its Drizzle journal/snapshot metadata, adding
  explicit SQL for constraints the pinned generator does not serialize;
- replaced the out-of-band / silently skipped integration assumption with a harness that requires
  `DATABASE_URL`, creates a uniquely named empty database, applies every migration, verifies a
  second journal run is a no-op, exercises the constraints, and drops the database; and
- kept initial VIGA content as reference input for a later validated seed utility rather than
  embedding data or compatibility state in the migration.

This tranche deliberately adds no repository transaction for sender claiming, consent ordering,
confirmation/publication, STOP-versus-dispatch ordering, delivery monotonicity, or retention. It
also adds no handler, provider, model seam, UI, campaign behavior, seed data, or deployment behavior
owned by F-012 through F-019.

**PM:** F-022 moved to `in progress` at PM commit `6cce6c7` on
`f-022-clean-launch-schema`.

**Verified:** the original red integration run failed 3/3 as intended; the completed
real-Postgres suite passes 12/12 against an isolated PostgreSQL 16.12 cluster; `npm test` passes
46/46 across 10 files; typecheck and lint PASS; evals critical 3/3, advisory 2/2, adversarial 4/4;
the production Next.js build and `git diff --check` PASS.

**Release:** implementation and verification are complete on `f-022-clean-launch-schema`; commit,
push, PR, and merge are pending the current session wrap. No deployment is owed for this
schema-only prelaunch tranche.

**Next:** review F-022 as the schema / empty-database migration foundation only. Do not absorb
F-012 through F-019 or treat the schema records as proof that their transactions and workflows are
implemented.

## 2026-07-25 — F-021 four-package boundary reset

The first implementation tranche after the clean-room review reset the repository to the approved
package boundary. The architecture test was written and observed failing first: it reported
`apps/mobile`, wildcard/deferred workspaces, all five reversed `core` dependencies, and the
disallowed web dependency on `contracts`. The implementation then:

- deleted `apps/mobile`, `packages/config`, and `packages/contracts`;
- made the root workspace list explicit and limited it to `apps/web` plus `core`, `db`, `sms`, and
  `ai`;
- removed every deleted workspace reference from manifests, TypeScript project references,
  Next.js transpilation, ESLint configuration, and `package-lock.json`;
- made `core` independent of workspace adapters in both its manifest and source imports, with the
  architecture test enforcing the approved allowed-edge direction;
- moved the still-used stock-out report-source type beside its authoritative core workflow and
  moved the health response validator beside its HTTP handler;
- deleted the obsolete migration-provenance/claim-state shared types and migration-aware recency
  helper rather than relocating them; and
- retained the deterministic model/SMS test doubles and target-compatible pure helpers while
  deleting the throwing open-weight and Telnyx placeholders that could be mistaken for operational
  adapters.

The tranche deliberately did not alter the legacy database schema, add migrations or workflows,
change campaign/provider/deployment configuration, resolve deferred product decisions, or absorb
F-012 through F-019. The schema's obsolete tenancy/gleaning/provenance structures therefore remain
an explicit later-schema gap rather than being partially reshaped here.

**PM:** F-021 moved to `in progress` at PM commit `caa07f3` and to `in review` at `1d5d284`;
implementation commit `bb9bf96` is recorded as the key commit.

**Verified:** `npm test` 46/46 across 10 files; typecheck and lint PASS; evals critical 3/3,
advisory 2/2, adversarial 4/4; production Next.js build PASS; `git diff --check` PASS.
`npm run test:integration` ran with all 3 Postgres tests skipped because `DATABASE_URL` is unset;
this is not green Postgres proof.

**Release:** implementation commit `bb9bf96` is pushed on `f-021-package-boundary-reset`;
[PR #16](https://github.com/max-h-silverman/farm-friend/pull/16) is open. No deployment was
performed or owed.

**Next:** review and merge PR #16, then separately plan the clean launch schema/migration tranche
without absorbing F-012 through F-019 or resolving decisions without a real schema consumer.

## 2026-07-25 — Architecture review closed; F-021 planned

The four-part review-to-build gate was completed against the current repository, the stable
clean-room handoff, the independent audit, the executable tests/evals, and current PM ownership:

- **Executable-proof claims:** the SMS requirements banner and runbook typecheck language were
  already corrected. Remaining false cleanliness, structural-proof, stock-out-shape, and helper-eval
  language was consolidated into F-013 and F-015 rather than becoming a cleanup framework.
- **Doc/code drift:** acknowledged foundation drift remains implementation backlog. F-014 now owns
  the narrow last-mile raw-E.164 delivery boundary and fail-closed Telnyx verification
  configuration; F-012 and F-017 retain campaign and map drift. No catch-all refactor item was
  created.
- **Unresolved decisions:** none blocks the first package-boundary tranche. Inventory snapshot
  semantics, contact/reassignment behavior, public-location projections, UX parameters, retention
  values, and provider/campaign choices remain just-in-time decisions for their first real
  consumers.
- **Deletion/buildability:** no deleted capability needs restoration. The consumerless
  message-classification seam should be removed through F-015. Runtime SMS-origin geocoding,
  speculative packages/state, and generic future-program machinery stay deleted. The approved
  product and four-package baseline are settled enough to build.

The architecture review was explicitly closed and planning of the first build tranche was
authorized. F-021 now specifies a test-first package-boundary reset: delete `apps/mobile`,
`packages/config`, and `packages/contracts`; move only still-valid types to their owners; and make
`core` independent of workspace adapters. F-021 is planning-only until a separate implementation
request; no Farm Friend application code, schema, campaign/provider configuration, implementation
branch, or deployment changed during the review.

**PM:** proof-language scope was committed at `b0fbdd9`; the delivery boundary at `3826ff1`;
just-in-time inventory semantics at `ab9de7c`; and planned F-021 at `552418b`.

**Verified during closeout:** `npm test` 46/46 across 10 files; typecheck and lint PASS; evals
critical 3/3, advisory 2/2, adversarial 4/4. `npm run test:integration` completed with all 3
Postgres tests skipped because `DATABASE_URL` is unset; real-Postgres verification remains owed for
the later schema/workflow tranche.

**Release:** documentation-only closeout branch `docs/architecture-review-closeout`; no deployment
applies.

**Next:** after this closeout merges, start F-021 from clean `main` only when the fresh-session
request explicitly authorizes implementation. Do not absorb F-012–F-019 or begin the launch schema.

## 2026-07-25 — Keyword grammar and review-state ownership (F-012 / F-020)

Two follow-on contradictions from the independent audit were reviewed separately against the
approved one-program consent boundary and the repository's existing documentation roles.

- **Keyword grammar:** F-016 already removed the audit's reason for a command-plus-argument grammar.
  Launch uses one fixed whole-normalized-message matcher; bare `JOIN` / `START` affect the one
  launch program, and extra text cannot become a program argument. Remaining registered/public
  copy, Telnyx profile/autoresponse, parser-variant, `STOPALL`, FLAG, and obsolete `OUT` / `IGNORE`
  alignment remains F-012 work. No new grammar or PM item was added.
- **Design authority versus stale session state:** the audit's original claim that Phase 4 had not
  begun was obsolete, but mutable next-step and PM-status text inside the handoff had gone stale.
  F-020 keeps the clean-room handoff as the single stable design authority, `CLAUDE.md` as the sole
  repository-local live snapshot, PM as item-status authority, and this log as dated history. No
  second authority document or status registry was added.

The handoff now records both approved decisions and stable ownership without a mutable current-phase,
exact-next-step, or live-PM-status section. `CLAUDE.md` names the four-part review-to-build gate.
No application code, schema, package, dependency, provider configuration, external campaign copy,
or deployment changed.

**PM:** F-012 was corrected at `a254e7d`; F-020 was created at `db1d92f` and moved to in progress
on `f-020-review-state-consolidation` at `5afac6b`.

**Verified:** `npm test` 46/46 across 10 files; typecheck and lint PASS; evals critical 3/3,
advisory 2/2, adversarial 4/4. `npm run test:integration` completed with all 3 Postgres tests
skipped because `DATABASE_URL` is unset; a real-Postgres run remains owed.

**Release:** documentation-only branch `f-020-review-state-consolidation`; no deployment applies.

**Next:** in a fresh session, close the four remaining review-to-build gates exactly one finding or
decision at a time: executable-proof claims, doc/code drift, genuinely unresolved-decision triage,
then the deletion/buildability verdict and phase-transition approval.

## 2026-07-24 — Finding 5 and follow-on architecture decisions (F-017–F-019)

Ranked finding 5 and the next four contradictions from the independent audit were reviewed one at
a time against the clean-room contract and spiral-staircase constraint:

- **Proximity (F-017):** launch uses optional transient browser geolocation for deterministic
  approximate proximity to validated seeded public coordinates. Destination-only Google Maps
  links delegate origin resolution/routing. SMS does not resolve arbitrary origins and returns a
  code-rendered limitation plus public-map link. No runtime geocoder, map package, invented
  coordinate, customer-location record, routing engine, service, or package was added.
- **Recipe safety (F-018):** Phase 1 removes generated meal ideas, recipes, preparation/food-safety
  guidance, and runtime recipe-link retrieval. A recipe request may receive grounded ingredient
  availability plus a code-rendered scope statement. No moderation system, classifier, policy
  engine, recipe catalog, provider, service, or package was added.
- **Natural-language web inquiry (F-019):** Phase 1 inquiry is SMS-only. Public web remains a
  model-free map/listing/filter/proximity surface over the same authoritative facts. The QR
  stock-out form keeps the public model abuse/cost throttle; ordinary lookup is uncapped. No web
  chat, inquiry endpoint, session, conversation state, or transport framework was added.
- **Retrieval ordering (F-013 clarification):** deterministic routing precedes every model call;
  model interpretation precedes code retrieval; grounded model selection sees only the retrieved
  facts; code validates/renders/queues. Empty retrieval skips grounded selection. The correction
  was folded into F-013 rather than creating another item.
- **Inventory proposal lifecycle (F-014 clarification):** unconfirmed inventory is a distinct
  pending proposal payload. `YES` creates the immutable published revision; `NO` and expiry create
  none. Full-snapshot versus patch semantics remain separately unresolved. The clarification was
  folded into F-014 rather than creating another item.

The design authority and companion product/system/data/AI/runbook/index guidance were synchronized.
No application code, schema, package, dependency, provider configuration, external campaign copy,
or deployment changed.

**PM:** F-017 was added in `~/pm` at `cf74275`, F-018 at `7edfaf8`, and F-019 at `5785436`.
Retrieval ordering was added to F-013 at `0cdc70b`; the pending-proposal lifecycle was added to
F-014 at `1806f46`; and F-013/F-017 channel ownership was aligned at `97d6e39`. F-012 through
F-019 remain planned and require separate implementation authorization.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical 3/3 + advisory
2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped because
`DATABASE_URL` is unset; a real-Postgres run remains owed. No deploy is required for this
documentation/PM-only tranche.

**Released:** repository commit `e7182c1` was pushed in PR #13. No deployment applies to this
documentation/PM-only change.

**Next:** review the audit's "Keyword grammar" contradiction exactly one finding at a time.

## 2026-07-24 — Ranked finding 4 decision: one launch SMS program (F-016)

Ranked finding 4 was reviewed against the clean-room contract, data architecture, SMS compliance
requirements, current schema/parser/webhook, and the registered/public 10DLC source copy. The audit
correctly found three incompatible consent meanings, but the correction separates a wrong launch
specification from an optional unresolved product promise.

Launch VIGA Farm Friend is one registered operational SMS program. `JOIN`, `START`, and documented
farmer onboarding establish or restore its consent with provenance. Inventory prompts, publication
confirmations, customer inquiry replies, and stock-out alerts are applicable message categories
inside that program, not separately enrolled programs. Universal STOP remains global and retains the
approved provider-time ordering and dispatch boundary from finding 2.

The marginal passive customer follow-up was removed. A customer-initiated inquiry permits its
relevant direct response but creates no durable consent for later proactive notifications. Launch
therefore has no follow-up-interest state and no scoped `MUTE` command. Future programs require their
own disclosed enrollment only when approved and built; launch pre-creates no program discriminator,
future-program rows, command arguments, tables, states, packages, or UI.

The correction deliberately introduces no per-category launch consent, general program-enrollment
platform, policy engine, reply-window mechanism, second subscription flow, Kafka, event bus, event
sourcing, workflow engine, distributed lock, service, package, or provider. F-012 remains the owner
of registered `OUT`/`IGNORE`, `STOPALL`, and FLAG campaign-copy drift. No application code, schema,
package, dependency, provider configuration, public campaign source copy, or deployment changed.

**PM:** F-016 was created as `planned`, high-priority `compliance-trust` work (`292bd30` in
`~/pm`). F-013, F-014, F-015, and F-016 remain unauthorized for implementation.

**Released:** repository commit `1a41fb5` was pushed on `f-016-sms-consent-boundary`; PR #12 is open
against `main`. No deploy is required for this documentation-only tranche.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical 3/3 + advisory
2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped because
`DATABASE_URL` is unset; a real-Postgres run remains owed. `git diff --check` passed.

**Next:** after this documentation tranche merges, review ranked finding 5 — runtime geocoding
versus the launch proximity promise — exactly one finding at a time.

## 2026-07-24 — Ranked finding 3 decision: model privacy boundary and proof (F-015)

Ranked finding 3 was reviewed against the approved clean-room contract and the actual assembler,
provider, redaction, and eval boundaries. The claimed "three-layer code-enforced safety boundary"
was incorrect: branded types provide a static provenance barrier, runtime projection/validation/
rendering provides enforcement, and tests/evals verify those barriers but cannot block an unsafe
production value.

The marginal promise was narrowed from "runtime scanning proves arbitrary content clean" to named
structural privacy guarantees. Each model seam receives one explicit minimal projection containing
only the current actor's task text where needed, required public facts, and opaque identifiers. The
low-level provider call is internal and has no database, repository, arbitrary-record, or
provider-managed conversation capability. Farm Friend does not claim a general detector for every
email, address, secret, or sensitive phrase a sender voluntarily includes.

Model-authored prose may return only to the actor whose current task text supplied its private
context. Cross-actor messages are code-rendered from permitted typed facts and do not relay customer
free text. The outbound phone refusal remains a named fail-closed backstop rather than proof that
every private value has been detected.

The single configured model provider must not train on Farm Friend request/response data; calls are
stateless; request/response logging is disabled where supported; and unavoidable provider retention
has an approved documented maximum compatible with Farm Friend's raw-context retention. A
model-version change under the same approved data-handling contract remains config plus evals, while
a provider or provider-data-handling change re-runs that privacy gate.

The correction deliberately introduces no general DLP, taint tracking, universal email/address
detector, Kafka, event bus, event sourcing, workflow engine, distributed lock, service, package, or
additional provider. It was synchronized across the clean-room handoff, AI/system/data architecture,
runbook, docs index, and `CLAUDE.md`. No application code, schema, package, dependency, provider
configuration, or deployment changed.

**Released:** repository commit `572ca43` was pushed on `f-015-model-safety-boundary`; PR #11 is
open against `main`. No deploy is required for this documentation-only tranche.

**PM:** F-015 was created as `planned`, high-priority `compliance-trust` work (`5e2c43d` in
`~/pm`). F-013 and F-014 remain planned; none of the three is authorized for implementation.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical 3/3 + advisory
2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped because
`DATABASE_URL` is unset; a real-Postgres run remains owed. `git diff --check` passed before the
session-log update and is re-run at handoff. No deploy is required for this documentation/PM-only
tranche.

**Next:** after this documentation tranche merges, review ranked finding 4 — the conflicting
consent meanings — exactly one finding at a time. Do not implement F-013, F-014, or F-015 or change
application code/schema before separate authorization.

## 2026-07-24 — Ranked finding 2 decision: concurrent and out-of-order SMS (F-014)

Ranked finding 2 was reviewed against the approved clean-room contract rather than treating the
independent audit as design authority. Narrowing the marginal promise removes the separate
stock-out `OUT`/`IGNORE` commitment: a code-bound web/QR stock-out report asks the farmer for
current inventory, then uses the ordinary inventory proposal and YES/NO publication path. That
preserves the north star while avoiding a second concurrent confirmation grammar.

The remaining launch invariants need a small Postgres mechanism inside the existing Next.js app:

- verify Telnyx against the raw request bytes, then transactionally insert a minimized inbox row
  keyed by provider event ID before acknowledging;
- serialize ordinary stateful work per sender with a short row lock/claim, order it by
  `(occurred_at, provider_event_id)`, and prevent stale events or stale model results from mutating
  newer state;
- keep a separate STOP/START consent watermark where later provider time wins and STOP wins an
  exact-timestamp tie;
- allow one live inventory-publication confirmation per sender, with its version, allowed YES/NO
  replies, expiry, and provider-accepted prompt activation recorded durably;
- perform model and Telnyx calls outside database transactions, then re-lock and revalidate before
  applying results;
- make the outbox dispatch claim the STOP linearization boundary, use bounded retry only for
  definitive retryable failures, and do not automatically resend after an ambiguous provider
  result without verified Telnyx idempotency support.

The correction deliberately introduces no Kafka, event bus, event sourcing, workflow engine,
distributed lock, service, package, general conversation replay, or exactly-once carrier claim.
It uses only the existing application boundary, Postgres transactions/rows/locks, Telnyx, and the
one approved model provider. The registered public campaign files still advertise `OUT`/`IGNORE`;
that external-copy drift remains F-012 rather than being silently changed in an architecture
decision.

The approved decision was synchronized across the clean-room handoff, product brief,
`ARCHITECTURE.md`, `DATA_ARCHITECTURE.md`, `SMS_COMPLIANCE.md`, admin operations, runbook, and
`CLAUDE.md`. No application code, schema, package, provider configuration, or deployment changed.
F-014 was created as planned, high-priority `compliance-trust` work (`19e0203` in `~/pm`); F-013
also remains planned and neither item is authorized for implementation.

**Verified during wrap:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical
3/3 + advisory 2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped
because `DATABASE_URL` is unset; a real-Postgres run remains owed. No deploy is required for this
documentation/PM-only tranche.

**Next:** after this documentation tranche merges, review ranked finding 3 — whether the claimed
three-layer safety boundary actually has three enforcement layers — exactly one finding at a time.
Do not implement F-013 or F-014 or change application code/schema before separate authorization.

## 2026-07-24 — Independent architecture audit + ranked finding 1 decision (F-013)

PR #8 merged the F-011 clean-room baseline reset to `main` (`565187c`). The follow-on independent
audit is preserved in
[ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md](ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md) and indexed
from the docs README as **review input, not design authority**. Its spiral-staircase constraint is
now the review rule: first narrow a marginal promise where that preserves the north star; otherwise
add only the smallest mechanism that closes a named launch invariant inside the existing
Next.js/Postgres/four-package system.

**Ranked finding 1 was approved.** The prior specification simultaneously allowed arbitrary
model-composed prose and claimed code could deterministically verify every factual claim; schema
validation and evidence IDs cannot provide that guarantee. It also let a model-parsed stock-out
location indirectly choose which farmer received an alert while claiming recipient selection was
code-owned.

The settled correction keeps natural-language understanding but narrows the consequential outputs:

- inquiry retrieval returns typed authoritative facts with stable identifiers and `asOf` values;
- the model interprets the request and selects/orders only identifiers from that retrieved set;
- code checks retrieved-set membership, dereferences authoritative values, and renders names,
  inventory, recency, stale warnings, and supported deterministic distance/comparison facts;
- unrestricted model prose is not treated as deterministically verifiable, and unsupported
  likelihood language such as "more likely" is not a launch promise;
- only a web/QR report with a code-bound sales-location identifier can queue a farmer stock-out
  alert; free-text SMS may return the reporting link but cannot select a location or recipient;
- code resolves the authorized farmer from the bound location.

This deliberately adds no natural-language claim verifier, extensible query platform, fixed
semantic strategy catalog, policy engine, package, service, event bus, workflow engine, vector
database, or model provider. The decision was synchronized across the clean-room handoff,
`PRODUCT_BRIEF.md`, `ARCHITECTURE.md`, `DATA_ARCHITECTURE.md`, `AI_ARCHITECTURE.md`, and
`CLAUDE.md`. No application code or schema changed.

**PM:** F-013 was created as `planned`, high-priority `compliance-trust` work (`6334373` in
`~/pm`). After confirming PR #8 had merged, F-011 was marked done and archived (`c5be625`).
F-012 remains the separate planned 10DLC-copy launch gate.

**Verified during wrap:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical
3/3 + advisory 2/2 + adversarial 4/4. `npm run test:integration` completed with all 3 tests skipped
because `DATABASE_URL` is unset; a real-Postgres run remains owed. No deploy is required for this
documentation/PM-only tranche. The branch is pushed for a user-managed follow-on PR/merge.

**Next:** in a fresh session, review ranked finding 2 — SMS concurrency and out-of-order events —
exactly one finding at a time. Do not implement F-013 or change code/schema until separately
authorized.

## 2026-07-24 — Clean-room baseline reset: F-011 (original review-sequence finding 1)

Branch `f-011-baseline-reset`. First finding of the original Phase 4 review sequence defined by
[CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md), which is
now **tracked in the repo and is the design authority** — previously it existed only as an
untracked working-tree file.

**Why this was finding 1.** The declared baseline (seven architecture docs, `CLAUDE.md`, PM
`product.md`) asserted as settled fact a product the clean-room contract had replaced. Because
`CLAUDE.md` auto-loads into every agent's context and instructs agents to treat those docs as
source of truth, the stale baseline was actively *manufacturing* the work later findings exist to
delete: any session starting cold would have built tenancy scoping, two-axis migration provenance,
and gleaning tables. It also made every later finding's acceptance criteria unverifiable, since
"correct" was defined by documents that were wrong.

Deleted from the declared baseline: gleaning/volunteer scope and its "tables in the spine" pledge,
tenancy, the two-axis migration provenance model and claim states, `config`/`contracts` packages,
Expo, multi-level staff roles, and the permanent `MapProvider` seam (geocoding is now a one-time
seeding concern, and the coordinate-inventing stub is gone). Declared instead: the four-package
baseline (`core`/`db`/`sms`/`ai` + `apps/web`), the `core → no other package` dependency rule, the
single composition root, and one authoritative use case + durable path per workflow.

**Two judgment calls worth recording.** First, the old docs enumerated a closed inquiry-ranking
strategy set (`proximity | freshness | coverage | any`) — precisely the "fixed semantic strategy
catalog" the contract forbids. Restated as an **open interpretation the model proposes and code
validates and executes**, which resolves a contradiction in the contract's own terms rather than
transcribing it. Second, unproven guarantees were **demoted to requirements**: every architecture
doc now opens with a status note naming its own gaps, because the Phase 3 audit found documented
safety claims that executable code does not enforce.

`SESSION_LOG.md` was left unchanged (history may record superseded decisions) and is now labeled as
such in the docs index. `SMS_COMPLIANCE.md` got narrow edits only — gleaning removed, scoped `MUTE`
added, `FLAG` marked a product safety feature rather than a carrier-mandated keyword, and
speculative-schema identifiers (`subscriptions`, `people.phone`, the removed activation flow)
replaced with durable-record language.

**Review found two defects.** The commit was amended (`6765e29` → `b292bc7`) to fix the stale
schema names, which the first pass had filtered for gleaning but not for schema references. The
second was filed as **F-012** rather than fixed: the registered 10DLC campaign copy still presents
`FLAG` as a supported keyword and documents `MUTE` nowhere, so F-011 wrote the "FLAG is not
carrier-mandated" rule and left the live violation one file away. Correcting a submitted carrier
campaign is a real decision with an external dependency and is a listed unresolved launch decision
— it is a hard SMS-compliance gate before public SMS, but blocks none of the intervening
architectural findings.

**Scope held:** docs + `CLAUDE.md` only; no file under `apps/`, `packages/`, or any schema path was
touched. Excluding the added handoff, the rewrite was ~956 insertions against 812 deletions — a
reset, not an expansion.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical 3/3 + advisory
2/2 + adversarial 4/4 — unchanged from baseline, as expected for a docs-only change. These checks
prove isolated helpers and structural claims, **not** launch workflows. `DATABASE_URL` remains
unset, so the 3 Postgres integration tests still skip; a real-Postgres run remains owed.

## 2026-07-13 — VIGA 10DLC copy + outbound SMS segment cost controls (PR #7)

Branch `fix/telnyx-sms-costs`; PR #7 is open against `main`. Added paste-ready Squarespace,
privacy/terms, and Telnyx campaign-field copy for **VIGA Farm Friend** (`752e85d`). It describes
only the current farm-stand MVP, uses the live VIGA-hosted opt-in/privacy paths, and omits the
rejected future volunteer/gleaning campaign. Telnyx's keyword field rejects spaces, so the final
opt-out list uses `STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT` and does not include `STOP ALL`.

Implemented provider-independent SMS cost controls (`e88c705`). `packages/sms` now estimates
GSM-7 vs. UCS-2 and billable segments (including two-septet GSM extension characters), normalizes
only unambiguous typographic variants at the mandatory `redactOutbound` boundary, and preserves
meaningful Unicode such as names, addresses, accents, and emoji. Outbound metrics contain only the
recipient hash, encoding, character/encoding-unit counts, and segments — never body text or raw
phones. `assembleSmsContext` adds a one-GSM-segment preference for coordinator replies while
explicitly forbidding destructive truncation. A 101-character smart-punctuation sample falls from
2 UCS-2 segments to 1 GSM-7 segment after normalization.

The repository does **not** yet contain a live Telnyx send: `TelnyxTransport.send` remains the
intentional Phase 0 throwing stub. PM F-010 was added (`~/pm` commit `1f6b87a`) as a high-priority
launch dependency; this session completed its provider-independent cost controls, while production
send, outbound-only raw phone lookup, post-acceptance metric emission, and adapter tests remain
open. No deploy is required for this library/documentation change.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS, `git diff --check` PASS;
evals critical 3/3 + advisory 2/2 + adversarial 4/4. `npm run test:integration` completed with all
3 tests skipped because `DATABASE_URL` is not configured; a real-Postgres run remains owed.

## 2026-07-05 — Architecture and SMS follow-up cleanup merged (PRs #5 + #6)

Closed architecture, schema, and deterministic SMS-parser contradictions after Phase 0. Activation
became staff-initiated manual onboarding for roughly 35 stands: staff record farmer identity and
SMS consent provenance, then trigger one pre-seeded confirm-or-revise message; the prior claim-link
and form-submit automation was deleted. `people.phone` became the one normalized raw-phone column,
read only by outbound sending, while `phone_hash` remained the lookup/log key.

Pruned overlapping schema state (`farms.status`, snapshot `hidden`, and
`expected_fresh_until`); `farm_stands.visibility` is the single hide switch. Activation `YES`
writes a new `farmer_confirmed` snapshot rather than mutating provenance. Set provisional raw-body
retention (30 days plus flagged-thread exemption), per-consumer commitment expiry (48 hours for
publish/stock-out, 14 days for activation), whole-message token matching with fixed YES/NO
variants, `JOIN <program>`, and stand-resolution-before-alert for SMS stock-out reports.

**Verified before merge:** `npm test` 39/39 (9 files), typecheck PASS, lint PASS; evals critical
3/3 + advisory 2/2 + adversarial 4/4. Integration remained DB-gated.

## 2026-07-04 — Phase 0 built (F-006a + F-006b + F-006c), verified, not committed

Branch `feature/f-006-platform-spine` (off `main` = `3f76949`, the archived scaffold; the working
tree was the intentional clean-slate wipe). Built the full Phase-0 spine test-first, per the
approved plan (`we-re-building-farm-friend-generic-clock.md`). **Not committed** — the user
directed no commit/push/deploy without explicit go-ahead.

**PM restructure first (via `/pm`).** Split the oversized F-006 three ways (F-006a docs, F-006b
spine, F-006c auth+evals); added F-007a/b, F-008, F-009; reframed F-002 (publish, two-axis
provenance), F-003 (open-intent inquiry), F-005 (console consolidation, with flag review pulled
out to F-009 as a hard pre-launch gate). Dependency order encoded via table position + "Depends
on" notes. Reconciled `product.md` (coordinator framing, `contracts` package, two-axis migration
model, code-enforced-safety golden rule). ID strategy: kept existing IDs, rewrote in place. F-006
retained as a `wont-fix` stub recording the split.

**F-006a — docs + CLAUDE.md.** CLAUDE.md in Nudgenik house style; the `docs/` set reading in order
via `docs/README.md`. Key decisions captured: the **two-axis migration model** (lifecycle `status`
= shown-on-map vs. provenance = honesty-about-age; migrated shows as `current` but is labeled
honestly, never "confirmed today"), the **sharpened type-safety claim** (branded types make it a
*compile error to bypass* the assembler/redactor — provenance, not content; the runtime scan +
adversarial evals prove content), the **`ai_runs` MAY-store list**, and the **abuse/cost throttle
seam** location (decided in ARCHITECTURE, built in F-003/F-008).

**F-006b — spine.** npm-workspace monorepo (`core`, `db`, `sms`, `ai`, `config`, `contracts`) +
web/mobile shells + 5 scripts. Tenant-scoped Drizzle schema with the restored columns
(`farm_stands.claim_status/migrated_at/migrated_source/visibility/lat/lng`, `farms.status`,
`inventory_snapshots.status+provenance+confirmed_by_person_id`), nullable-FK+text stock-out shape,
gleaning tables (designed, unused), `ai_runs` (no model input). Provider seams: `SmsTransport`
(+simulator +Telnyx stub +**outbound redaction guard**), `LLMProvider` (+stub +openweight
+**`ModelSafeContext` assembler** +validate-and-repair), `Clock`, `MapProvider` (+**offline
stub**). The **branded type-level safety boundary** — `ModelSafeContext`/`RedactedOutbound` whose
only public constructor is the assembler/redactor; a deliberate bypass fails `tsc`, **proven
non-vacuous** (removing a `@ts-expect-error` makes `tsc` fail: "string not assignable to
RedactedOutbound"). The **generic commitment state machine** designed against two consumers
(publish/activation + gleaning): context-bound, exactly-once, expiring. First unit tests cover all
eight named invariants.

**F-006c — auth + evals.** Magic-link auth (issue/verify, HMAC signature + expiry code-enforced),
a server-side `requireRole` helper (admin⇒staff implication + tenant match) used by routes, plus a
web callback route and a role-guarded admin route. The eval harness (`evals/run.ts`, run via
`tsx`) with critical/advisory groups and the **adversarial group** that proves — by exercising the
*real* assembler + commitment machine — that an injected SMS can't smuggle a phone into context or
force a commit. **Proven non-vacuous**: neutering the assembler's phone scan fails the adversarial
group and exits non-zero.

**Notable engineering decisions.**
- Relative imports are **extensionless** (`moduleResolution: "Bundler"`, source-first workspace
  consumption) so both `tsc -b` and Next's webpack resolve them; Next couldn't resolve `.js`
  specifiers pointing at `.ts` source.
- React pinned to `18.2.0` across web + mobile to satisfy React Native 0.74's exact peer.
- Integration suite is `DATABASE_URL`-gated (skips cleanly) so `npm test` stays hermetic and
  CI-without-a-DB doesn't fail; it runs against local/Neon Postgres when the URL is set.

**Verified this session:** `npm run typecheck` PASS, `npm run lint` PASS, `npm test` **38 passed
(9 files)**, `npm run test:integration` 3 skipped (DB-gated), `npm run evals` critical 3/3 +
advisory 2/2 + adversarial 4/4. `apps/web` builds and live-served `/api/health` (200), the Telnyx
webhook (deterministic routing through core — `STOP`→global compliance, free-text→`none`), the
magic-link callback (bad token→401), and the guarded admin route (unauth→403). `apps/mobile`
type-checks.

**Owed / next:** commit + PR when the user gives the go-ahead. Run the integration suite against a
real Postgres to exercise the schema + seed. Then the launch set: F-007a → F-007b → F-002 → F-008
→ F-003 → F-009.
