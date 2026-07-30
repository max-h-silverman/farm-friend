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

## The documents and what each one owns

**Each architecture doc is authoritative for its own domain.** There is no master document above
them; where two disagree, the one that *owns* the subject wins. **None of them carries build
status** — that lives in exactly one place, "Current State & Open Items" at the bottom of this file.

**Read a contract doc as a requirement, not as evidence.** A doc sentence, a code comment, a test
name, and a green check are all *claims*. Do not cite one as proof that a guarantee holds — check
the code and the test, and sabotage the test to confirm it can fail.

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
**[docs/GO_LIVE_GUIDE.md](docs/GO_LIVE_GUIDE.md) is the prioritized work order to launch** — the
`GL-###` items, their priority bands, and the verification ladder. It controls **work order**; it
does not override the product contract, and its findings are leads to reconfirm against the code,
not a spec (one named a production credential that was not one). An item is open unless it carries
a `**Completed:**` line.
[docs/RUNBOOK.md](docs/RUNBOOK.md) is the operate/extend guide (local dev, env, migrations,
seeding, evals, deploy, Telnyx webhook requirements, **credential rotation**, and **how to extend**).
[docs/ADMIN_OPERATIONS.md](docs/ADMIN_OPERATIONS.md) is the VIGA operator guide.

**Historical records — do NOT load these to orient.** They are dated, frozen, and not authority:
`docs/CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md` and
`docs/ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md` (the July 2026 reset and its adversarial review —
retired as authority 2026-07-28; the contract they settled now lives in the docs above), and
**[docs/SESSION_LOG.md](docs/SESSION_LOG.md)** with its
[archive](docs/SESSION_LOG_ARCHIVE.md) (dated build history; older entries rotate into the archive
once the live log passes ~160k chars). Open one **deliberately**, to answer "why was this decided" or to dig into
a past defect — never as startup context. What is true *now* is "Current State" below.

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
1. **Orient.** Read this file + the area's architecture docs (docs/README.md is the index). `/pm
   list` to see what's open, `/pm show <ID>` for acceptance criteria. Read "Current State" below for
   what's live vs. skeleton. **Do not load the historical records** — session logs and the two
   handoffs are for answering a specific "why", not for orienting.
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
  model output; run the **swap test**; run evals **and `npm run evals:live`** — the scripted suite
  uses a stub that reads neither your instructions nor your schema, so it cannot see an output
  contract that describes the wrong job. Give the seam an entry in `SEAM_OUTPUT_SHAPES` (its
  examples are parsed through the real schema, so they cannot drift). **To add a seam or a program,
  or swap a provider, follow docs/RUNBOOK.md "how to extend."**
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
- `npm run evals:live` — the REAL model through the real seams (needs `DEEPINFRA_MODEL`;
  `DEEPINFRA_API_KEY` comes from `.env`). Required for any change to a seam's projection, schema, or
  output contract: a cooperative stub cannot see what a real model returns. `live-containment` must
  be 100% and a failure **stops and reports**.
- Migrations / seeding / offerings / deploy: see docs/RUNBOOK.md (deploy only when asked).

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
> facts (test counts from a real run, files read); replace stale lines, don't append. The *why*
> behind past changes lives in [docs/SESSION_LOG.md](docs/SESSION_LOG.md) — open it deliberately,
> never to orient.

**Verified 2026-07-29** (`main` @ `c3810da`, pushed): `npm test` **596/596** (61 files);
`npm run test:integration` **334/334** (20 files) on real Postgres 16, all 8 migrations from empty;
typecheck and lint exit 0; `infra/test_deploy_assertions.py` **10/10**. Evals **not** re-run — no
seam projection, schema, or output contract changed; last results stand (`evals` critical 11/11,
advisory 4/4, adversarial 29/29; `evals:live` containment 4/4, quality 6/6 on Mistral Small 24B).

**Deployed 2026-07-30** — revisions `farm-friend-web-00007-4mb` / `farm-friend-worker-00008-gg2`,
one digest `sha256:79ff89e8…` on both. `plan-assertions.py` **29/29**, `deploy_assertions.py`
PASSED (both revisions newer than every secret version). Verified by effect: health `{"ok":true}`,
`/api/public/stands` **34** stands, webhook **401** (config resolves), `/api/internal/cron` **404**
on the public service, `/admin` 200. The plan diff was read field by field — only the image digest
and the known non-converging `scaling` block changed.

### What works end to end

- **SMS round trip, on a real handset, on this runtime.** Inbound → deterministic route → queued
  reply → Telnyx dispatch with a real provider message ID → delivery callbacks back through the
  webhook. Compliance keywords, `FLAG`, context-bound `YES`/`NO`, then free text
  (`apps/web/lib/routing.ts`); model seams are reachable only through a `freeText` callback after
  `parseCommand` returns `none`, so "no model on the compliance path" is structural.
- **Public map**, model-free in its module graph, reading the same published records as SMS.
  35 stands seeded, **34 public** (see B-024), **212 offering tags** across 33.
- **Operator surface** — farm approval, flag review, stock-out triage, stand-data questions. Built
  and deployed, but **unreachable**: see B-023.
- **One-tap add-to-contacts** (F-039) — `GET /api/public/contact-card` serves a vCard built from
  `TELNYX_FROM_NUMBER`. **Deployed and serving 200**, but the wire bytes lose their CRLF line
  endings — see B-025.
- **Deployed on Cloud Run**: https://farm-friend-web-p5mfxfp5za-uw.a.run.app — one image, two
  services (`farm-friend-web` public, `farm-friend-worker` internal+IAM) differing only by
  `DEPLOYMENT_ROLE`. Cloud Scheduler drives four bounded passes (inbound, outbound, delivery,
  retention); Cloud Tasks drives the per-sender kick. Vercel is gone.
- **Production data**: `neondb`, 8 migrations, **1 contact** (max's real number), 35
  `sales_locations`, 212 offerings, **0** inventory revisions / entries / farmer authorizations /
  farm approvals / administrators, 4 `stand_data_flags`.

### Live invariants worth knowing before you touch anything

- **`LLM_PROVIDER` is required with no default** and no environment-dependent exemption — production
  once ran the deterministic stub its entire life, silently, with every suite green. Now
  `deepinfra` + `mistralai/Mistral-Small-24B-Instruct-2501`, so **model calls cost money on real
  traffic**.
- **The model authors no customer-facing factual text and writes no durable state.** Five seams have
  explicit disjoint projections; the low-level provider call is unexported. `ambiguous` /
  `clarification` / `outOfScopeRequest` / `originDependent` are **bare signals carrying no words** —
  code renders the text.
- **Consent**: `isProactiveSendPermitted` is the single predicate. **`JOIN` enrolls only a
  first-time sender; once a consent record exists only `START` restores** — the carrier owns
  STOP/START and 409s our reply while its block is active, so our record must not claim consent the
  carrier will not honour. No provider response ever drives a consent transition.
- **Privacy**: phones hashed, raw E.164 in one column read only by the send path; the admin surface
  masks at the **query** (`right(phone_e164, 4)`). `purgeExpiredBodies` clears expired bodies;
  flags/audit survive; the flagged-thread exemption fails safe and terminates on resolve *or*
  dismiss.
- **Post-response work is a durable queue, not a platform primitive.** The webhook commits,
  **enqueues a Cloud Task, and awaits that enqueue** before returning 200. `enqueueSenderWork` never
  throws and never retries — a queue outage must not turn a successful ingress into a 5xx.
- **An abandoned dispatch claim is quarantined, never resent** — recovery resolves to `ambiguous`,
  never `queued`, because a resend could duplicate an SMS someone already holds.
- **Registered keywords and auto-response copy** are stated once in `packages/core/src/sms/` and
  pinned character-for-character to `docs/TELNYX_10DLC_FIELD_VALUES.txt`, a **transcript of live
  console state** — change the console first, then transcribe. `ALREADY_JOINED_RESPONSE` lives
  beside them but is **not** registered copy and must never be transcribed into that block.
- **Architecture tripwires** (`packages/core/src/architecture.test.ts`) fail if: a `MapProvider` /
  `geocode(` call returns; `packages/config` or `packages/contracts` reappears; the tenancy
  identifier reappears; a fixture uses a date literal; or a publication-path source compares against
  a location-type enum **value**.
- **Seeding**: `npm run db:seed -- --form <f.csv> --map <m.csv>` (both required — the form has 2026
  details and no coordinates, the map has coordinates). The join is an **exact normalized key**
  (`matchStandName`), never a similarity score: a fuzzy matcher measured over the real corpus ranked
  Lavender Hill against Flora Hill. Offerings are a separate step,
  `npm run db:seed-offerings -- maps/offerings-proposals.json [--dry-run]`, keyed through that same
  normalization; an ambiguous name refuses the whole batch, and `--dry-run` resolves against the
  database.
- **Deploy** = `gcloud builds submit --config cloudbuild.yaml
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)`, then `tofu plan`, then
  `infra/plan-assertions.py` (29 checks), then apply, then `infra/deploy_assertions.py` — RUNBOOK
  §Deploy. **Read a plan's CONTENTS, never its count**: a permanent 2-resource diff on the top-level
  `scaling` block never converges and is expected steady state. Terraform owns infrastructure but
  **never secret values or the image**.
- **`PHONE_HASH_SALT` must never be rotated** — it is the input to the only lookup key for every
  phone; rotating it orphans every hash with no way back.

### Open work — each needs separate implementation authorization

Do not read a passing suite as a working product: several gaps hide behind green tests whose
fixtures supply what production never creates.

- **B-023 (HIGH) — production has no administrator.** `administrators` is 0 rows, so the whole
  operator surface is unreachable by anyone; a verified link for an address with no administrator row
  renders 401, correctly and permanently. The 4 seeded stand-data flags have nobody who can see
  them. **Not F-031 and not blocked by it** — that is mail transport, this is the authority row the
  link resolves against. `bootstrap-administrator.ts` exists and has never run against production.
  Needs a decision on whose address is first.
- **B-024 (HIGH) — a farmer's address we should not have published.** Handpicked Homestead is
  `is_public = false` in production (interim, max-approved): her form `extraNotes` said *"I don't
  have my own farmstand … do not add my address"*, yet the seed gave her a pin at her home. Address
  and coordinates preserved; the permanent shape (a *producer* whose goods sell at another farm's
  stand) is an open product question, and **no producer/host relationship was invented for one row**.
  **`extraNotes` is read only by `offering-type.ts`** — nothing consults it for visibility, so a
  second such instruction would republish. Exactly one instance corpus-wide.
- **F-042 (HIGH) — the offering tags are unread.** `listPublicStands` never selects
  `sales_location_offerings`, so the API exposes no offerings field and all 33 tagged stands still
  render *"No listing yet."* Seeding was necessary, not sufficient. The design question is the
  **vocabulary**: "usually carries" must never render as a confirmation.
- **F-040 (HIGH) — farmer onboarding; design settled, nothing built.**
  `farmer_authorizations` has **no writer outside tests**, so a real farmer who texts an update
  falls through to the *customer* branch and nothing reports why. Identity is separate from channel:
  **VIGA always approves** (a phone proves possession of a phone, not ownership of a farm), either
  side may start it, and on approval Farm Friend texts the farmer. Channels — SMS, a texted link, a
  bookmarked form — all land on the **same confirmation gate**, no bypass. No passwords. max chose a
  link that never expires until revoked, so **revocation is the only safety net**: it must take
  effect on the next request, VIGA must see and revoke every farmer, and a leaked link must at worst
  propose a wrong listing on ONE stand. **B-023 is upstream of this.**
- **B-025 (HIGH) — the served vCard loses its CRLF line endings.** `/api/public/contact-card` returns
  **147 bytes, 0 CRLF, 6 bare LF** in production where the renderer produces 153/6/0, and `file(1)`
  rejects it ("lines not separated by CRLF"). The handler applies no transform and it reproduces on
  HTTP/1.1 and HTTP/2, so the Next.js response path or the proxy layer is normalizing the body.
  **No local test can see it** — the renderer's CRLF assertion is correct and passes. Textbook
  "local runtime ≠ deployed runtime"; verify any fix by hex-dumping the wire bytes, not by a unit
  test. Display name `VIGA Farm Friend` (max, confirmed). A physical-handset check is now the
  deciding test, since a malformed card fails by opening **nothing**.
- **F-031 — no mail provider, so no sign-in link is delivered.** Everything up to the wire is built;
  what remains is a vendor, credentials, **attested** data-handling terms, and SPF/DKIM/DMARC.
  Blocked on what email infrastructure VIGA runs. **GCP has no first-party transactional email
  API** — "email on GCP" means SendGrid via Marketplace, whose terms are Twilio's. Never infer the
  attestation values.
- **F-036 — where the model may run.** Seed-time: built and run. Query-time on the public map:
  **blocked** (`public-surface-model-free.test.ts` polices the import graph). Farmer-authored web
  submission is a **third case**, needing farmer web auth that does not exist plus the same
  confirmation gate.
- **B-008 — lint does not run in deployed builds.** `apps/web` omits the `@typescript-eslint`
  plugin/parser, so Next skips lint non-fatally and the build goes green with the gate absent. The
  real work is extending `workspace-manifests.test.ts` to config-file dependency references.
- **B-020 — integration deadlock** (`40P01`) on a fixture `truncate`, between suites' truncates
  rather than Farm Friend's locking. Has not reproduced across many runs.
- **B-001** stays open pending its caveat. `model_runs` has **no production writer**. No per-stand
  pages or filter/search UI. Message classification has no consumer. SMS inquiry has no HTTP route
  **by design** — reached from the webhook worker.
### Standing rules learned from real defects

Each of these cost a session or a production incident. They are compressed here; the narratives are
in [docs/SESSION_LOG.md](docs/SESSION_LOG.md).

**Verify by effect, never by a success message.** `db:migrate` reported success while silently
skipping a migration whose journal timestamp fell *before* the newest applied one (Drizzle applies
only when `created_at < folderMillis`; equal counts as done). A green `tofu apply` created no
revision, so rotated secrets never reached the containers. A CLI deploy writes no GitHub deployment
record. **Compare a revision's creation time against the merge**; a forced restart is not a deploy.
Guard: `packages/core/src/migration-ordering.test.ts`.

**Sabotage-test every claim: a test that cannot fail proves nothing.** This has repeatedly caught
gaps — a predicate drift (`= 'open'` → `<> 'resolved'`) that passed a whole suite because no fixture
isolated a dismissed-only thread, a role suite that passed an operator→farmer escalation, race tests
that stayed green through three claim guards being disabled. **Verify agent reports rather than
relaying them**: agents have reported completion with uncommitted work, marked PM items ahead of
reality, and written a decision attributed to max that max had never made.

**A source assertion must be anchored to the construct it proves**, never to vocabulary near it.
This has now happened three times. A `/waitUntil\s*\(/` scan survived reverting the call site,
satisfied by the *import line*. A status-check assertion (`/--fail|-f\b|http_code|status/` plus a
bare `/exit 1/`) survived a workflow that accepted every status. A test asserting escaping over a
rendered card passed with the escaper deleted, because no value in it contained a delimiter. **Strip
imports and comments, anchor to the call site or comparison, and run the sabotage.** Loose
alternation is the tell.

**The local runtime is not the deployed runtime, and a hoisted `node_modules` is not an isolated
install.** vitest runs in Node, where a floating promise resolves — so the kick suite passed while
production dropped every message (B-009). Six packaging defects shipped undetected because the root
install hoists (B-005–B-008). When a property belongs to the *platform* or the *install*, assert it
against the **source** (`kick-survival.test.ts`, `workspace-manifests.test.ts`) and verify the real
thing by **effect** in the deployment.

**A cooperative stub cannot see what the real model does.** F-024's first live run failed **every**
seam while 471 unit tests and 44 scripted evals were green: the projections attached SMS-composition
guidance to JSON-extraction seams and never stated the output shape, and the stub reads neither the
instructions nor the schema. `evals/live.ts` is the assertion that catches it;
`output-contracts.test.ts` keeps instructions and validator from drifting. **A containment-only pass
is not evidence** — a refused call counts as contained, so containment read 4/4 while quality read
0/6.

**Concurrency tests need genuine contention.** `Promise.all` over two async branches does not race
them — the first transaction resolves before the second starts. Use enough simultaneous claimants to
contend (8), and **give each its own upstream row**: a race test sharing one administrator row passed
with the downstream `for update` deleted, because the authority re-read serialized everything first.
It measured the wrong lock. Related: `select … for update` **cannot serialize a row that does not
exist yet** — eight concurrent first-time JOINs all read "no record" and three enrolled. For a
first-insert race the arbiter must be a **unique index**:
`insert … on conflict (key) do nothing returning …`, where the empty result *is* the signal someone
else won. Without `returning`, winner and loser are indistinguishable.

**SQL's NULL semantics silently invert a guard.** A CHECK constraint **passes** on NULL, and
`array_length(array[]::integer[], 1)` returns NULL rather than 0 — so a `between 1 and 7` check
admitted the empty array it forbade; use `coalesce(…, 0)`. Postgres sorts NULLs **FIRST** under
`order by … desc`, so a left join without `nulls last` puts never-confirmed rows ahead of fresh ones.
Also: `Number(null)` is **0**, not NaN, which rendered an address-less farm at 0,0 — a pin in the
Atlantic — with no type error, and NaN in a comparator makes sort order input-dependent. All caught
only because a test asserted the specific **value**, not the shape.

**Measure against the real corpus before defending a deterministic approach.** The availability
parser looked fine until it ran over all 31 stands and flagged 12, ten spuriously, by conflating
"not stated" with "unparsed". The offerings parser looked fine until the corpus produced
"rotational grazing for chickens". A fuzzy name matcher ranked Lavender Hill against Flora Hill. The
corpus settled each question in minutes; arguing from the code would not have.

**Data present with no consumer is invisible.** `extraNotes` carried a farmer's explicit *"do not add
my address"* and was read only by the offering-type classifier, so the seeder published her home with
a pin (B-024). Same shape as an inventory left join that rendered "updated just now" for a
confirmation that never happened. **Seeding a fact is not surfacing it** — 212 offering tags landed
and no reader selects them (F-042). When you add data, name its reader.

**Inspect before proposing anything destructive — and guard it anyway.** A reset script written for a
database "assumed empty" met the older Farm Friend's real data (6 volunteers, 17 messages, 2 farms
with phone numbers); only its row-count guard prevented the loss. A legacy project "known" to hold no
real data held 37 Firestore documents. **Fingerprint the target** so a mistyped connection string
fails instead of erasing something else, and require explicit confirmation.

**An unexported seam is an untested seam.** `createTelnyxTransport` was module-private, so the one
path parsing a real provider error had no test and silently discarded it — everything above used the
never-failing simulator. Export the seam that does real I/O parsing and test it against captured
payloads, or its failure mode is invisible.

**Run suites sequentially, never chained**; capture a failing test name before rerunning
(`npm run test:integration 2>&1 | tee /tmp/itest.log`). Treat a named failing test as a real defect
until shown otherwise — but **a failure that MOVES between runs is environmental**, and `git stash`
is the cheap way to prove whose it is.

**Use isolated worktrees for parallel agents.** Two agents in one shared tree overwrote each other
repeatedly and spent more effort recovering than building. Note a worktree has no `node_modules` of
its own, so cross-package imports resolve into the main checkout until it is linked.

**`sharedDb` caches on first call and ignores the URL afterward.** A second `createAppContext` in one
process cannot be pointed at another database, and `close()` on any context tears down the shared
pool. Assemble the capabilities a pass needs instead of building a second context.

**A negative result from one lookup is not proof of absence.** A whole session proceeded on "no
database available" while Homebrew's `postgresql@16` was installed and *running* at
`/opt/homebrew/opt/postgresql@16/bin`. Check `/opt/homebrew/opt` and `brew services list` before
concluding a dependency is missing. The same error in another guise: **do not infer configuration
from a dashboard's timestamp column** — record every secret in a password manager at the moment it is
set, and verify configuration **behaviourally**.
