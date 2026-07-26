# Farm Friend

Farm Friend keeps Vashon Island Growers Association (VIGA) farm-stand information **current with
little or no routine VIGA data management**. VIGA's embedded Google My Map is the island's only
guide to what farm stands have, it carries free-form largely unfilterable text, and it runs stale
because a volunteer hand-enters farmer-submitted forms. Farm Friend lets farmers own and update
their own listings — mostly by **SMS** — so people can discover what they can buy locally now, and
lets customers privately flag a likely stock-out to the farmer. Nearly all stands are **unattended,
honor-system** stands with stable staples but variable stock, so the system shows *when* inventory
was last confirmed rather than pretending it is certain. Stale information stays visible with a
prominent warning rather than disappearing.

**Picture Farm Friend as a coordinator at a desk.** It's one trustworthy customer-service agent
serving VIGA and the community. On its desk are **files** (the source-of-truth data) and **ways to
answer** (the map, SMS replies, and its own **inference**). It answers *from the files* and says
when they're old; its inference *reads and drafts* but never rewrites the official files on a hunch
— the farmer or VIGA confirms; it has professional boundaries (a customer's word doesn't change a
farmer's listing — it passes the message along); and when unsure it asks or hands off to a human
rather than guessing. When a design question is unclear, ask *"what would a good coordinator at a
desk do?"* — this is the intuitive "why" beneath the Golden Rules below.

**And picture the desk itself: a zen office, not a bureaucracy.** The coordinator to build is the
one at a clean walnut desk — a few folders stacked neatly, color-coded labels on indexed racks,
like things grouped together — *not* the harried clerk behind an old metal desk buried in loose
paper. Same coordinator, second orientation layer: **simplicity and elegance are architectural
requirements**, not aesthetics. Few concepts, each load-bearing; one general mechanism where two
bespoke ones would creep in; a system a newcomer can hold in their head. The binding rule is
"Simplicity and elegance — the zen desk" below.

**And know what the coordinator is made of: an LLM-brain in a harness.** The brain does the
reading, drafting, and inferring — and it is **swappable by design**, so it is never *vouched for*,
only *measured* (evals) and *contained* (the harness: deterministic routing, confirmation gates,
retrieval, the safety boundary — all code). The trust contract: the brain is trusted for
**quality**, never for **authority**. Evaluate every feature and architectural decision against the
harness — *"if the brain were swapped for a weaker, or hostile, one tomorrow, which properties
survive?"* Everything that must survive lives in the harness. Full contract:
[docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md) "The trust contract."

## Status: clean-room contract settled — rebuild underway

**[docs/CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](docs/CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
is the design authority.** Read it before the other architecture docs. It carries the settled
product contract, the approved four-package architecture baseline, a repository audit, and the
refactor direction. Where any other doc disagrees with it, **the handoff wins**.

**Read the architecture docs as requirements, not as status.** A Phase 3 audit found the repository
is an over-specified foundation whose documented safety claims executable code does not enforce.
Each doc now carries a status note naming its own gaps. Do not cite a doc as evidence that a
guarantee holds — check the code and the test.

- **[docs/PRODUCT_BRIEF.md](docs/PRODUCT_BRIEF.md)** — the *product*: north star, canonical launch
  journeys, actors, honor-system reality, privacy posture, launch scope and non-goals.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the *system*: the zen desk stance, the
  four-package layout + dependency direction, the composition root, runtime surfaces, deterministic
  routing, workflow/transaction ownership, provider seams, invariants.
- **[docs/DATA_ARCHITECTURE.md](docs/DATA_ARCHITECTURE.md)** — the *data*: minimum durable records,
  the constraints the database must enforce, privacy/retention, the model-run MAY-store list.
- **[docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md)** — the *AI*: the trust contract, the
  semantic architecture (meaning is the model's, consequences are code's), the seam catalog, the
  model-vs-code line, the **static/runtime safety boundary plus verification**, validation, evals.
- **[docs/SMS_COMPLIANCE.md](docs/SMS_COMPLIANCE.md)** — keywords, consent, required behavior, the
  FLAG safety rail.

[docs/README.md](docs/README.md) is the index (*building X → read these*).
[docs/RUNBOOK.md](docs/RUNBOOK.md) is the operate/extend guide (local dev, env, migrations,
seeding, evals, deploy, Telnyx webhook requirements, and **how to extend**).
[docs/ADMIN_OPERATIONS.md](docs/ADMIN_OPERATIONS.md) is the VIGA operator guide.
[docs/SESSION_LOG.md](docs/SESSION_LOG.md) is build history — a **historical record** describing
decisions the clean-room contract has since superseded. The live snapshot of what's true is
"Current State" below.

---

# Development discipline

> These sections govern *how code gets written.* They are **binding**, and they make the repo work
> with the `/session-wrap`, `/pm`, and `docs-check` skills.

## Choose the best option, regardless of effort

**Never factor implementation effort into a technical decision.** Always choose the best option —
the most correct, robust, and architecturally sound one — regardless of how much work it is.
Effort is never a reason to pick a lesser design, take a shortcut, skip a test, or defer doing it
right. If the best option is large, **surface it and do it** (or plan it deliberately) — never
quietly substitute an easier one. This rule sits above the Golden Rules because it governs how
every decision below gets made.

## Simplicity and elegance — the zen desk

The companion rule to the one above, and its guard against misreading: "best regardless of effort"
is **never a license for complexity**. The best option is the **simplest, most elegant design that
fully honors the invariants** — and it is often *more* work, not less. Concretely:
- **Few concepts, each load-bearing.** One general mechanism with parameters/consumers beats a
  family of near-duplicates. Before adding anything new, ask whether an existing mechanism
  generalizes.
- **Every addition earns its place — now, for a real consumer that exists.** A new entity, seam,
  flag, dependency, or abstraction must pay for itself today. **Do not build for future programs.**
  Gleaning, volunteer coordination, and Farm Bucks transactions are plausible future work; the
  architecture leaves room for them by **staying small**, never by pre-creating their tables,
  states, packages, or UI.
- **Delete on the way through.** When a change makes code, a concept, or a doc line redundant,
  remove it in the same change — never leave two ways to do one thing.
- **Elegance is legibility.** Narrow seams, one small fixed routing order, each fact stated in
  exactly one place. If explaining a design takes longer than the design, simplify the design.

**Favor deletion and consolidation** over preserving speculative or already-documented machinery.
Treat code comments, test names, package names, green checks, abstractions, docs, and PM state as
**claims rather than proof**.

## Examples are illustrations, never requirements

Specific items, farm names, and question phrasings in these docs and in conversation (e.g. "bok
choy and green beans", "what is current at Provo Farms?") are **illustrations of mechanisms and
intent — not a spec**. Build to the general, open-ended design; the customer intent space is broad
and often ambiguous. Don't harden a stray example into a fixed interpretation — let the model
interpret and a code-owned general retrieval layer handle the variation, and ask a clarifying
question rather than guessing.

## Working a task (session workflow)

For agents starting cold. **Work is chunked in the `/pm` backlog and built across sessions;
`/session-wrap` carries continuity.** The loop for a non-trivial change:
1. **Orient.** Read this file + the handoff + the area's architecture docs (docs/README.md is the
   index). `/pm list` to see what's open, `/pm show <ID>` for acceptance criteria. Read "Current
   State" below for what's live vs. skeleton.
2. **Claim.** `/pm status <ID> in progress`; branch off `main` (**never work on `main`**), named
   for the item (`f-011-…`).
3. **Test-first, then build.** Write the failing test before the behavior (TDD below).
4. **Choose the best design.** When a decision has a better-but-harder option, take it.
5. **Verify before done.** Run the suites for what you touched (Commands below) + typecheck.
6. **Wrap.** Don't commit/push/deploy unless asked. Run **`/session-wrap`** before clearing
   context.

## Golden rules

The architecture's fatal-failure defenses expressed as code rules. Each is what a good
**coordinator at a desk** would do; violating one reintroduces a failure mode the architecture
exists to prevent.

1. **The farmer owns published state.** Nothing a customer does mutates the map, answers, or
   ranking. A customer stock-out report is a *separate private signal* that only prompts the
   farmer; only the farmer's confirmed action changes what a stand shows.
2. **Deterministic parsing before any model call.** Compliance + confirmation tokens
   (STOP/START/JOIN/HELP/FLAG, plus the context-bound confirmation tokens) are handled by code
   first. `STOP` always unsubscribes **globally** and can never be reinterpreted by conversation
   state. Provider events are deduplicated and ordinary stateful work is serialized per sender;
   STOP/START are ordered on a separate consent watermark, with STOP winning an exact timestamp tie.
   Launch has one registered operational SMS program: `JOIN`, `START`, and documented farmer
   onboarding establish that consent; launch message types are categories, not separate programs.
   A customer-initiated inquiry permits its relevant direct reply but creates no later proactive
   follow-up, follow-up-interest state, or `MUTE` path. Future programs get separate enrollment only
   when built, never speculative launch state.
   There is exactly one open inventory-publication confirmation per sender. Its `YES`/`NO` tokens
   are **context- and version-bound, never global**, commit **exactly once**, and **expire**.
3. **The LLM proposes; code commits.** The model interprets, extracts, classifies, drafts where a
   seam permits it, and selects or ranks identifiers from retrieved options — it never writes
   durable state, chooses recipients, decides consent, supplies authoritative factual answer text,
   invents availability, or overrides a rule. Publishing and alerting are code-controlled;
   publication is confirmation-gated and requires an approved farm.
4. **Grounded answers only, retrieval before fact selection — with open intent.** Customer intent
   is open-ended: after deterministic routing, the model interprets the request, **code** runs a
   **general** retrieval/ranking layer, and the model selects or orders identifiers from typed
   retrieved facts. Code validates that every ID belongs to the retrieved set and renders the
   authoritative factual answer with explicit "updated X ago" recency. **No fixed semantic
   strategy catalog** — ranking intent is an interpretation code validates and executes, not an
   enumerated constant. Farm Friend does not attempt to verify unrestricted model prose claim by
   claim. Empty retrieval → a code-rendered honest "no current listing" without a fact-selection
   model call.
5. **Privacy at the data layer.** Phone numbers are normalized at ingress; the raw E.164 lives in
   **exactly one column**, read only by the outbound send path; the **hash is the only lookup/log
   key** — raw numbers are never logged, never enter model context, and are masked in admin. Raw
   message context is short-lived (flagged threads exempt while under review); flags/audit are
   retained. Farm Friend must not accumulate a rich personal profile.
6. **Safety is enforced by code, never by the system prompt.** Anything that must not fail —
   privacy, consent, compliance, commitment, data minimization — is a **deterministic code
   guarantee the model cannot reach around** (a prompt can be jailbroken or prompt-injected, and we
   ingest untrusted public SMS). The boundary has **two enforcement barriers plus verification**:
   - **Static provenance barrier** — branded safe-context / redacted-outbound types whose only
     constructors are the task-specific context assemblers / redaction guard, so ordinary code
     cannot call the low-level model provider or send an SMS without going through them. This proves
     *provenance*, **not** *content* — `tsc` cannot inspect a runtime string.
   - **Runtime enforcement** — each model seam receives an explicit minimal projection, never an
     arbitrary record or unrelated history; the low-level adapter has no repository capability;
     consequential and cross-actor output is validated and code-rendered; and the outbound guard
     normalizes avoidable typographic Unicode and blocks the named raw-phone class. These are
     specific guarantees, **not** proof that arbitrary text is universally "clean."
   - **Verification suite** — type tests, workflow tests, and adversarial/prompt-injection evals
     demonstrate that the two barriers hold under hostile output. They are evidence, **not a third
     enforcement layer**, and require a hostile model rather than a cooperative stub.
   Farm Friend does not claim a general detector for every email, address, secret, or sensitive
   phrase a sender might voluntarily put in the current task text. Model-authored prose may return
   only to that same actor; cross-actor messages are code-rendered from permitted typed facts.
   A prompt may add defense-in-depth but is **never** the enforcement.

**No business code hard-codes what the model can understand**: no farm names or food vocabulary in
behavioral branches, no produce taxonomy as application policy, no `if vegetable, then …`. Farms,
foods, and listing details are **data**. Fixed compliance and authority controls stay
deterministic.

## TDD — required, not optional

Development is **test-first**: write the failing test that says what the behavior should be, watch
it fail, make it pass. **The test is the spec** — the architecture's guarantees are only real if
they are *tested invariants*, and the audit found several "proven" only by shape checks and
cooperative stubs. Suites:
- **Unit** — `npm test` (vitest). Keep pure core logic free of DB/SMS/LLM by injecting seams + `Clock`.
- **Integration** — `npm run test:integration` (vitest, Postgres). Must run migrations **from an
  empty database**, exercise complete use cases with real constraints and transactions, and prove
  the data invariants. The suite requires `DATABASE_URL`, creates and drops a uniquely named
  throwaway database, and fails explicitly when Postgres is unavailable.
- **Typecheck / lint** — `npm run typecheck` / `npm run lint`. The typecheck proves that ordinary
  callers cannot bypass the static provenance barrier; it does not prove runtime content safety.
- **Evals** — `npm run evals`. Required for any change touching a model seam. `critical` fixtures
  must pass **100%**; a provider/prompt change must pass the full suite at parity or better. Use
  **hostile** models that attempt invention, not cooperative canned ones.

## Before you ship a change that touches…

- **Compliance / routing:** test first that keyword + confirmation tokens bypass the model; duplicate
  events are no-ops; concurrent ordinary stateful work is serialized per sender; stale events fail
  closed; an older START cannot undo a newer STOP; one open inventory confirmation is enforced; a
  token predating its current prompt cannot commit; confirmation rechecks farmer authority and VIGA
  approval, commits exactly once, and expires.
- **A model seam:** trace it in AI_ARCHITECTURE.md; keep durable writes/recipient/consent out of
  model output; run the **swap test**; run evals. **To add a seam or a program, or swap a provider,
  follow docs/RUNBOOK.md "how to extend."**
- **A new query/list:** after any approved semantic interpretation, run retrieval in code before
  grounded fact selection; label recency; carry stable fact identifiers; accept only selected IDs
  from the retrieved set; render factual text in code.
- **Anything privacy-relevant:** phones hashed, never logged raw, never in model context. The
  guarantee is **code, not the prompt** — task-specific projections make other actors' private data
  unavailable before the call, the outbound guard blocks raw phones after, and consequential /
  cross-actor replies are code-rendered; add adversarial workflow proof that injection cannot
  extract unavailable data.
- **SMS ingress:** verify the Telnyx signature over the exact raw bytes, persist only the minimized
  unique inbox projection before acknowledgement, never retain the raw provider envelope, serialize
  stateful work per sender with Postgres row locks, and fail closed on stale events.
- **SMS delivery:** commit unique outbox work with business state; recheck consent at the atomic
  dispatch claim; suppress work when STOP commits first; do not claim recall after dispatch
  authorization; never automatically retry a possibly accepted ambiguous result.
- **The public map or feed:** it reads the **same published records** as SMS — web and SMS answers
  must agree. Render recency honestly.
- **A public unauthenticated model-backed surface:** route it through the abuse/cost throttle;
  normal public lookup is never artificially capped.

## Commands

- `npm test` · `npm run test:integration` · `npm run typecheck` · `npm run lint` · `npm run evals`
- Migrations / seeding / deploy: see docs/RUNBOOK.md (deploy only when asked).

## Skills

- **`pm`** — backlog in `~/pm/farm-friend/`. Never hand-edit; use the skill (`/pm list`, `/pm show
  <ID>`, `/pm status <ID> …`). Historical IDs `F-001`–`F-010` are retired and must not be reused.
- **`docs-check`** — runs after a manual commit to keep architecture docs fresh; honor it.
- **`session-wrap`** — end-of-session housekeeping (verify green, sync this file + docs + PM).
- **`verify` / `run`** — exercise a change in the running app / SMS simulator.

## Do not

- Do not commit, push, or deploy unless explicitly asked. Branch off `main` first.
- Do not let any customer action mutate published inventory, answers, or ranking (#1).
- Do not call the model before deterministic compliance + confirmation parsing (#2); do not let
  `STOP` be reinterpreted by state; do not let a token commit an unrelated pending action.
- Do not let the model commit state, choose recipients, decide consent, or state availability not
  present in retrieved rows (#3, #4).
- Do not hard-code farm names, food vocabulary, produce taxonomy, or a fixed strategy catalog into
  behavioral branches.
- Do not log raw phone numbers, raw provider payloads with PII, or put phones in model context (#5).
- **Do not rely on a system prompt to enforce privacy, consent, compliance, or commitment (#6).**
  Enforce it with the static provenance and runtime barriers; tests/evals verify those barriers and
  the prompt is at most defense-in-depth.
- Do not add **tenancy**, gleaning/volunteer/Farm Bucks-transaction machinery, native-app state, or
  multi-level roles — all are explicit non-goals at launch.
- Do not add arbitrary-origin SMS geocoding, a runtime geocoder/map package, model-backed
  natural-language web inquiry, or generated recipe/food-safety content at launch. Public proximity
  uses transient browser geolocation against seeded public coordinates; recipe requests receive
  grounded ingredient availability plus a code-rendered scope response.
- Do not add a **legacy-migration provenance model**: this is a greenfield build; existing map
  content is **reference input** that gets **seeded**, with no non-destructive migration
  requirement.
- Do not factor effort into a technical decision, or add speculative entities, seams, flags, or
  parallel near-duplicate mechanisms.

## Current State & Open Items

> Live snapshot, overwritten by `/session-wrap` — **not** a changelog. Record only **verified**
> facts (test counts from a real run, files read); replace stale lines, don't append.

**Live capability.** Farmers publish inventory by SMS behind a confirmation gate. Customers get
code-rendered grounded answers with recency and stale warnings. The web/QR stock-out path records a
private report and resolves the farmer in code. **The model never authors customer-facing factual
text or writes durable state** — it interprets and selects identifiers; code retrieves, validates
membership, and renders. Four model seams have explicit disjoint projections; there is no generic
assembler, and the low-level provider call is unexported. **The public map UI is built** (F-017):
`apps/web/app/page.tsx` renders the same published records SMS answers from, with code-rendered
recency on every card and stale listings visible-and-warned, plus optional browser-origin distance
sorting and destination-only routing links.

**The public read surface is model-free in its MODULE GRAPH, not just its handler (F-017).** The
public route and page import `apps/web/lib/public-context.ts` (db + clock) rather than the full
composition root, which constructs the model seams — so no seam is *reachable* from the public read
path, and `lib/public-surface-model-free.test.ts` walks the transitive imports of both entry points
and fails if one appears. `POST /api/public/stock-out` remains the single public model-backed
handler, fronted by the abuse/cost throttle.

**Verified July 26, 2026 (post-F-026, on `main` at `97fb965`):** `npm test` 255/255 across 26 files;
real-Postgres integration 138/138 across 9 files against PostgreSQL 16.12; typecheck + lint pass;
evals critical 10/10, advisory 4/4, adversarial 25/25; production Next.js build passes.

**Model prose never reaches a customer, and boundaries are booleans.** The inquiry seams' `ambiguous`
and `clarification` are **bare signals carrying no field but `kind`**; code renders the words. The
two launch scope boundaries use one mechanism: the model sets `outOfScopeRequest` (recipe/food-safety,
F-018) and `originDependent` (needs the customer's position, F-017) as **booleans that carry no
words**, and code appends `RECIPE_SCOPE_STATEMENT` / `ORIGIN_LIMITATION_STATEMENT`. A ranking
operation requiring an origin (`nearest`) is **refused, never silently downgraded** to recency. No
content scanner, classifier, or food taxonomy in business logic; there is no recipe seam and no
runtime geocoder.

**Geocoding is seed-time only, and proximity is arithmetic.** `MapProvider` and its
coordinate-inventing `StubMapProvider` are deleted; `packages/core/src/architecture.test.ts` fails if
either name, a `geocode(` call, or a mapping/routing dependency reappears.
`packages/core/src/public/proximity.ts` is pure (haversine, validation, destination-link building),
exported on the browser-safe `@farm-friend/core/proximity` subpath. The browser origin lives only in
React state in the customer's tab — never stored, logged, requested, or put in model context.

**Inbound SMS routes, and the workers have a trigger (F-023).** `apps/web/lib/routing.ts` decides in
one fixed order which existing handler owns a claimed event: compliance keywords → `FLAG` → the
context-bound `YES`/`NO` → free text. The model seams are reached **only** through a `freeText`
callback invoked after `parseCommand` returns `none`, so "no model call on the compliance path" is a
structural property of the function rather than a convention — `routing.test.ts` proves it with a
seam that throws on any call. The registered 10DLC auto-response copy now lives in
`packages/core/src/sms/auto-responses.ts`, verified character-for-character against
`docs/TELNYX_10DLC_FIELD_VALUES.txt` by a test that fails on drift in either direction; the console
stays the authority. `apps/web/app/api/internal/cron/route.ts` is the **single** authenticated
trigger for every scheduled pass, guarded by a required `CRON_SECRET` with no default and no
development bypass (`cron-auth.test.ts` fails if such a branch appears); each pass enumerates its own
work. `claimNextInboundEvent` exposes `providerEventId` because the consent watermark and
confirmation audit record provenance by it — our row UUID would break STOP/START tie-break ordering.

**Raw-context retention is a mechanism, not a claim (F-026).** `purgeExpiredBodies`
(`packages/db/src/transactions.ts`) clears expired bodies in `sms_messages` and `outbox_work` and
runs as the third pass on the one cron trigger, beside inbound and outbound — no second scheduling
mechanism. Only body text goes; the message row, its inbox projection, dispatch attempts, flags, and
audit events survive. The **flagged-thread exemption fails safe**: a body is purged only where the
absence of an `open` flag on its inbox event can be shown. **F-025 owns flag resolution**, so until
it ships a flagged body retains indefinitely — the exemption working, not a leak. Outbound bodies
clear only in a terminal state, so the purge can never race the dispatcher into an empty SMS. It
reports counts only, and `retention-wiring.test.ts` fails if it ever gains a `console.` call, a
`select` naming a body, or loses its call in the cron route. The `model_runs` MAY-store list was
**verified to already match the schema** — no content-bearing column exists, so the purge has
nothing to reach there.

**Launch consent is one program and executable.** `isProactiveSendPermitted`
(`packages/core/src/sms/consent.ts`) is the single pure predicate `authorizeDispatch` consults;
**active** consent is required for a proactive send. `outbox_work` carries one bounded
`message_category` (migration `0002`). The registered keyword lists are stated once in
`packages/core/src/sms/commands.ts` and `commands.test.ts` fails if the registered artifact and the
parser disagree in either direction. `YES`/`NO` are the only commitment tokens.

**The go-live gap is a WIRING gap, not a correctness gap.** Launch guarantees are proven at the
function boundary and mostly unreachable at the system boundary. Do not read a passing suite as a
working product — several of these gaps hide behind green tests whose fixtures supply what production
never creates:

- **F-025 — nothing can approve a farm**, yet `transactions.ts:711-715` refuses publication without a
  live `farm_approvals` row. The publication tests pass only because their fixtures insert it. Also: no
  admin UI (one page exists, the public map), the flag route is a `{ flags: [] }` stub, auth returns an
  empty role list.
- **F-024 — the configured provider is the stub.** The privacy gate is executable and fails closed, but
  no real vendor's terms have passed it, and it attests a declaration, not vendor practice.
- **B-002 — no seed utility**, so the map renders empty and inquiry retrieval finds nothing. Decided
  2026-07-26: ~30 stands transcribed **by hand** (no KML import), seeded with **zero inventory** (a
  seeded listing fact fabricates a confirmation) and **no phone numbers** (a seeded phone fabricates
  consent). Awaiting max's list; deferred to a later session.

**The four-package baseline is now enforced, not just documented (F-028).** F-021 did delete the
sources of `packages/config` and `packages/contracts`; what survived was two directories holding a
gitignored `tsconfig.tsbuildinfo` each — untracked build residue that made the repo *look* like six
packages while git tracked four. The pre-existing `workspaceDirectories` helper could not see them
(it skips any directory lacking a `package.json`, exactly an orphan's shape). Both directories are
gone, and `architecture.test.ts` now fails if either name returns as a **directory** (build output
included), a workspace entry, a dependency, a source import, or a tsconfig reference.

**Also open, each now owned:** F-027 (vestigial `tenantId` contradicting the tenancy non-goal), F-029
(go-live: deploy, Telnyx console wiring, first verified live `JOIN`). No per-stand pages or
filter/search UI. Message classification has no projection or consumer. `model_runs` has **no
production writer** — its only insert is in a test. SMS inquiry has no HTTP route **by design** —
reached from the Telnyx webhook worker.

**Standing test-suite rules, learned from two real defects (B-001 unanchored regex, B-003
date-dependence — see SESSION_LOG).** If an integration run fails: capture the test name and
assertion BEFORE rerunning (`npm run test:integration 2>&1 | tee /tmp/itest.log`) and run suites
**sequentially, never chained**. Treat a named failing test as a real defect until shown otherwise.
**A suite whose result depends on the calendar is not a suite** — fixture instants must be offsets
from a clock-derived anchor, never literals (`architecture.test.ts` enforces this). **B-001 is not
proof the intermittent-failure class is closed**: its original failing test name was never captured,
and a date boundary produces the same `1 failed | N passed` signature.

**Registered 10DLC copy: the console is the authority.** `docs/TELNYX_10DLC_FIELD_VALUES.txt` is a
**transcript** of live console state, not a draft — a candidate sample message once living only there
was misread as registered copy and cost a cycle. Change the console first, then transcribe.
`commands.test.ts` reads that file and fails if code and registration disagree either way.

**PM / authorization.** F-011–F-022 are done and merged; the clean-room finding backlog is complete.
**Open, each needing separate implementation authorization:** **F-024** (real provider), **F-025**
(operator surface — now also gates the end of the retention exemption), **B-002** (seed utility —
awaiting max's hand-written stand list), **F-027** (tenancy cleanup, not blocking). B-001 stays open
pending the caveat above. Any other new work needs a new PM item.
