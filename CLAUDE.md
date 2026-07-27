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

**Live capability.** Farmers publish inventory by SMS behind a confirmation gate; customers get
code-rendered grounded answers with recency and stale warnings; the web/QR stock-out path records a
private report and resolves the farmer in code. Inbound SMS **routes** (F-023): `apps/web/lib/routing.ts`
runs compliance keywords → `FLAG` → context-bound `YES`/`NO` → free text, and the model seams are
reachable only through a `freeText` callback invoked after `parseCommand` returns `none` — so "no
model on the compliance path" is structural, proven by a seam that throws. The webhook builds its
200, then starts that sender's inbound+outbound passes **registered via `waitUntil`** and never
awaits them (B-004, fixed by B-009). The public map UI is built (F-017) and is model-free in its
**module graph**, not just its handler.

**`waitUntil` is load-bearing (B-009).** A bare `void` is invisible to the Vercel runtime, which
suspends the invocation when the handler returns — in production that silently dropped *every*
inbound message. **No behavioural test in vitest can see this**: Node resolves floating promises, so
the whole kick suite passed throughout. `apps/web/lib/kick-survival.test.ts` therefore asserts the
registration against the route **source**. Claim latency after the fix: *never* → **4–8s**.

**The operator surface is built: sign-in request, approval, flag review, stock-out triage (F-025a,
F-030, F-032).**
Administrator identity is **email** (migration 0003; `contact_id` is optional and not the identity),
sign-in is a magic link whose verification proves an address and whose `administrators` lookup — not
the link — confers authority, so login is **not** first-user-wins. A session is a durable row storing
only the token's **hash**; `resolvePrincipal` re-looks-up roles per request, so revoking an
administrator or session takes effect on the **next request**. Three screens: `/admin` approves farms,
`/admin/flags` resolves or dismisses flags and shows the flagged thread, `/admin/reports` triages
stock-out reports. All four API routes share **one** guard (`apps/web/lib/admin-guard.ts`); the writes
live in `packages/db/src/admin.ts` and `review.ts`, which re-read administrator authority **inside**
each transaction and write the audit event in the same commit. The acting administrator comes from the
session, never the request body. Flags and reports dispose **exactly once** under a row lock — a
second operator gets 409, not a silent overwrite. Triage offers no action that could change a listing
(Golden Rule #1), proven by a byte-equality snapshot of every published revision, entry, and approval
across every operator action. The role lookup returns a **constant** `["admin"]` — an operator can
never acquire farmer capability, proven by sabotage. Bootstrap is
`packages/db/scripts/bootstrap-administrator.ts`.

**Requesting a sign-in link is built; delivering it is not (F-032).** `/admin/login` posts to the
public `POST /api/auth/request-link`, which mints a 15-minute token and hands a **code-rendered**
message to a `MailSender` seam. The seam **fails closed by throwing** — no provider is configured
(that is F-031), so no link is actually delivered and one must still be minted out of band with
`issueMagicToken`. The route's guarantees: the response is **byte-identical** for every address —
administrator, stranger, malformed, *and when the mail seam throws* — asserted by comparing whole
serialized responses, because mail is attempted only for a real administrator and a 500 would
rebuild the oracle through the error path. The throttle runs **before** the administrator lookup, so
a refused request performs no database read. The budget is per **client, never per address** (a
per-address budget is itself an oracle). The handler contains **no `console` call at all**, asserted
against its source, since a vendor SDK attaches the payload — carrying the live link — to the error
it throws. `/admin/login` works **without JavaScript**; the handler accepts form-encoded bodies as
well as JSON. `createModelCallThrottle` is now `createPublicActionThrottle` — one mechanism, two
consumers, separate budgets.

**The model never authors customer-facing factual text or writes durable state.** It interprets and
selects identifiers; code retrieves, validates membership, and renders. Four seams have explicit
disjoint projections; the low-level provider call is unexported. `ambiguous`/`clarification` and the
two scope boundaries (`outOfScopeRequest`, `originDependent`) are **bare signals carrying no words** —
code renders the text. A ranking operation needing an origin is refused, never downgraded.

**Privacy and retention are mechanisms, not claims.** Phones hashed, raw E.164 in one column read only
by the send path. `purgeExpiredBodies` (F-026) clears expired bodies from `sms_messages` and
`outbox_work` as the third pass on the one cron trigger; rows, projections, flags, and audit events
survive. The flagged-thread exemption **fails safe** — purge only where the absence of an `open` flag
can be shown — and **F-030 makes it terminate**: resolving *or* dismissing a flag releases the thread
with no grace period, proven end to end through the real purge (the dismissal case asserted
separately, since a drift to `<> 'resolved'` would exempt it forever). Outbound bodies clear only in a
terminal state, so the purge cannot race the dispatcher into an empty SMS. The admin surface carries
no raw phone: the approval and stock-out queues carry none at all, and the flag queue and thread
viewer mask at the **query** (`right(phone_e164, 4)`), so the full number never leaves the database.
`maskPhoneSuffix` **throws** on anything longer rather than truncating. Asserted by tests that grep
whole serialized responses for an E.164 and for any 64-hex run.

**The external scheduler is LIVE, and the retention purge has now actually run in production.**
Verified by effect on 2026-07-27, not by a dashboard: a body with `body_expires_at` in the past was
cleared by a real scheduled pass — `body` and `body_expires_at` both NULL, the `sms_messages` row
itself intact, and **exactly 1 of 21 bodies touched**. Before this, F-026's purge had never executed
against real data (every observed pass reported `0/0/0` because nothing was eligible), so a privacy
commitment moved from unenforced to demonstrated.
`.github/workflows/scheduled-worker.yml` on `*/5` is the trigger; `CRON_SECRET` is set as a
repository secret and a manual run returns 200. **The deployed build still has no `crons` block**
(stripped for the Hobby deploy), so this workflow is production's *only* scheduled trigger — the
`waitUntil` kick remains best-effort and owns no guarantee. Migration **0004** is applied to
production (both B-010 columns present, 5 migrations total).
`apps/web/lib/external-scheduler.test.ts` polices the workflow (source-asserting, same family as
`cron-schedule.test.ts`); its central assertion is that the run **checks `%{http_code}` against 200**,
because a bare `curl` exits 0 on a 401 and a stale secret would show green checkmarks forever. That
assertion's first draft survived its own sabotage by matching the word "status" elsewhere in the
file, so it is now anchored to the comparison. Interval is `*/5` and is **not** equivalent to
Vercel's one minute — GitHub schedules are best-effort and droppable; acceptable only because the
kick front-runs live traffic. **Delete the workflow when Pro lands**, never run both.
The retention purge has **never been verified by effect**; every observed pass reported `0/0/0`
because nothing was eligible. **That verification is still owed** — set a `body_expires_at` in the
past and confirm the purge clears it. A 401 looks identical to success in any scheduler's UI.

**One worker mechanism, two triggers; one consent program, one keyword source.** `apps/web/app/api/internal/cron/route.ts`
is the single authenticated trigger for every *scheduled* pass (`CRON_SECRET` required, no default, no
dev bypass) and the **only** trigger for F-026's retention purge. `apps/web/vercel.json` is what
actually schedules it (B-005 — it was missing entirely while the RUNBOOK documented it);
`cron-schedule.test.ts` asserts that config against the route it names, because the failure is
silent: the kick keeps replies fast while nothing recovers what it drops and the purge never runs.
`npm run db:migrate` applies migrations to a deployed database (B-006 — there was no way to migrate
at all; the RUNBOOK claimed the build did it). Deliberately not a build hook: that would migrate on
every preview deploy and rollback, including production from a branch build. The webhook's B-004 kick
(`apps/web/lib/kick.ts`) calls the same passes sooner for one sender and **owns no guarantee** — every
failure swallowed, each pass budgeted, cron recovers whatever it misses. Removing the kick entirely
must fail only latency tests, never durability ones. `isProactiveSendPermitted` is the single consent
predicate; **active** consent is required
for a proactive send. Registered keywords and auto-response copy are stated once in
`packages/core/src/sms/` and tested character-for-character against
`docs/TELNYX_10DLC_FIELD_VALUES.txt`, which is a **transcript of live console state** — change the
console first, then transcribe. `ALREADY_JOINED_RESPONSE` (B-011) lives beside those three but is
**not** registered copy and is **not** pinned to the transcript: it is ordinary code-rendered reply
text and must never be transcribed into that block.

**Architecture tripwires that must keep failing.** `packages/core/src/architecture.test.ts` fails if:
`MapProvider`/`StubMapProvider`/a `geocode(` call returns (F-017); `packages/config` or
`packages/contracts` returns as a directory, workspace entry, dependency, import, or tsconfig
reference (F-028); the tenancy identifier reappears in any source including tests (F-027); or a
fixture uses a date literal instead of a clock-derived offset (B-003).

**Farm Friend is deployed** (throwaway Hobby validation, not F-029 go-live):
https://farm-friend-web.vercel.app. Verified by live request — health `{"ok":true}`,
`/api/public/stands` `{"stands":[]}` against real Neon, cron **401** with no/wrong secret, admin API
**403** unauthenticated, sign-in responses **byte-identical** across addresses, throttle firing.
**Telnyx is now configured** (`SMS_PROVIDER=telnyx` + four credentials): the webhook answers **401**
where it answered 503, and all five signature-rejection paths return 401 — including
`signature_mismatch`, which proves `TELNYX_PUBLIC_KEY` decodes to a valid 32-byte ed25519 key rather
than merely being non-empty. Deploy with `npx vercel --prod` from a local checkout; the Git
integration built a stale commit three times. **Hobby rejects `vercel.json`'s one-minute cron**, so
deploying requires stripping the `crons` block from the working tree *uncommitted* and restoring it
after — never the stale `throwaway/hobby-deploy-test` branch. **Tear down the project and that branch
before go-live.**

**The webhook's config diagnostic is three-way, not two-way** (the RUNBOOK step-4 framing is wrong).
`route.ts` calls `appContext()` before the provider check, and `resolveConfig` **throws** on a missing
Telnyx var, which renders **500**. So: **401** = resolved; **503** = `SMS_PROVIDER` is not `telnyx`;
**500** = a credential is missing or blank. A missing credential is never 503. `vercel env pull`
cannot verify values — encrypted vars return `[SENSITIVE]`.

**Packaging defects are invisible locally — npm workspaces hoists.** `npm test`, `typecheck`, `lint`,
and `next build` from the repo root all pass against manifests that cannot survive an isolated
install, which is what a deploy does. **Six** such defects have now shipped undetected (B-005 no cron
config, B-006 no migrate command, B-007 undeclared dep + `transpilePackages` missing three packages +
root-only `typescript`/`@types/node`/`eslint`, **B-008** missing `@typescript-eslint`
plugin/parser). `packages/core/src/workspace-manifests.test.ts` is the only place this property is
asserted — and B-008 proves its reach is partial: it matches `@farm-friend/*` **in import
statements**, so external packages named in *config files* are outside its design.

**Verified July 27, 2026 (`main`, B-010 + B-011 + external scheduler merged):** `npm test`
**393/393 across 42 files**; `npm run test:integration` **226/226 across 16 files** on real
Postgres 16.12; `npm run evals` critical **11/11**, advisory 4/4, adversarial 25/25; typecheck +
lint pass; `next build` clean. Migration **0004** proven from an empty database by the integration
run. Nothing was verified against the live deployment: **the scheduler still needs its repository
secret and is not running** (below).
Newest session-log entry: the scheduler, B-010, and conforming to the carrier. Entries older than
the newest eight now live in `docs/SESSION_LOG_ARCHIVE.md` (rotated at 31 entries / 152k chars).

### Open work — each needs separate implementation authorization

Do not read a passing suite as a working product: several gaps hide behind green tests whose fixtures
supply what production never creates.

- **F-024 — the configured provider is the stub.** **Decided:** DeepInfra on a mid-size instruct model;
  the attested terms are **DeepInfra's** as inference host. The attestation is a **blocking TODO until
  max reads their data-processing terms** — never infer those values. An adversarial eval failure
  **stops and reports**; no fixture edits to go green.
- **B-002 — no seed utility**, so the map renders empty and inquiry retrieval finds nothing.
  **Decided:** typed TypeScript data file, zero inventory, no phone numbers, addresses only with
  seed-time coordinate lookup. **Blocked on max's ~30-stand list**; do not build speculatively.
- **F-034 — ROTATE EVERY EXPOSED CREDENTIAL. Hard blocker on F-029; do not go live without it.**
  `DATABASE_URL` (the full Neon URL was pasted in a transcript), `CRON_SECRET`, `TELNYX_API_KEY`, and
  possibly `MAGIC_LINK_SECRET` were all exposed during 2026-07-27 validation. **max deliberately
  deferred rotation to go-live** (2026-07-27) so it happens once rather than twice — sound *only*
  while this stays a throwaway project with no real numbers in the database. **The moment real
  farmer or customer numbers exist, this becomes urgent, not deferred.**
  `CRON_SECRET` lives in **two** places that must match — the Vercel env var and the GitHub
  repository secret — or every scheduled run 401s.
  **`PHONE_HASH_SALT` MUST NOT BE ROTATED, ever.** It is the input to the only lookup key for every
  phone in the system; rotating it orphans every hash with no way back. If it is ever believed
  compromised the answer is a designed re-hash migration, not a rotation. Record it, never rotate it.
  Verify each rotation **behaviourally** — Vercel values are write-only and `vercel env ls`'s
  timestamp column is not a last-updated field. Full checklist and proofs: `/pm show F-034`.
- **F-029 — go-live. The full SMS round trip now works end to end (2026-07-27).** Farm Friend sent
  its first SMS. Inbound keyword → deterministic route → queued reply → Telnyx dispatch with a real
  provider message ID → delivery callbacks (`message_sent`, `message_finalized`) returning through
  the same webhook. Six keywords were exercised against the live deployment (`stop`, `start`, `stop`,
  `join`, `help`, `start`), each routed to the correct registered copy, and consent verified against
  real traffic: the watermark holds only the latest transition and **`HELP` correctly did not move
  consent**. The supervised demo completed on a clean number: `start` → `join` → `help`, all three
  accepted with real provider message IDs. Three earlier blockers, each masking the next: (1) the
  number was never provisioned on the 10DLC campaign — an approved campaign and a profile-Active
  number do *not* imply provisioning, and messages died upstream of Telnyx's own records;
  (2) **B-009**, the kick never running; (3) `TELNYX_FROM_NUMBER` not in exact E.164 form, which
  returns `400` on every send. **What remains for go-live is not the SMS path** — it is **F-034
  (credential rotation, a hard blocker)**, tearing down the throwaway project and branch, B-002 seed
  data, F-024 a real model provider, and F-031 mail delivery.
- **B-012 — delivery callbacks are stored but never applied.** `applyPendingDeliveryEvent`
  (`apps/web/lib/workers.ts:316`) has **zero callers** — no pass, no webhook, not even a test. Found
  in production while verifying the scheduler: `message_received` 21/21 `processed`, but
  `message_sent` 9 and `message_finalized` 11 **all still `pending`**. So `sent` in `outbox_work`
  means "the provider accepted it", never "the handset got it" — and the rows accumulate with no
  terminal state. Same unowned-machinery shape as `model_runs`. Likely a fourth bounded pass on the
  one cron trigger; check `applyDeliveryEvent` is idempotent under replay first.
- **B-011 — the carrier owns STOP, and JOIN cannot undo it.** Telnyx auto-answers STOP/START in copy
  that is not ours, and **blocks our reply with `409 / 40300` while its block rule is active**.
  Verified: suppression is enforced **independently of the profile's auto-response fields**, so
  disabling that text would not restore deliverability — accepting carrier handling for STOP/START is
  the workable path. **`START` lifts the block; `JOIN` does not** (a `join` four minutes after a
  `stop` still 409'd). The live consequence: a farmer who texts STOP then JOIN is recorded `active`
  while the carrier blocks every message, so `isProactiveSendPermitted` returns true for sends that
  can never arrive. **FIXED and merged, integration-verified.** max's decision: *conform to the
  carrier* rather than reconcile after the fact — **`JOIN` enrolls only a first-time sender; once a
  consent record exists only `START` restores.** Our record can no longer claim consent the carrier
  will not honour, and **no provider response drives a consent transition** — a 409 is never
  consulted, so Golden Rule #2 is untouched. `STOP` still applies from every state; `START` is
  honoured from every state (it is the one word that lifts a block we cannot see).
  The rule lives **inside `applyConsentTransition`'s `for update` lock** (`firstTimeOnly`), never in
  the caller — a caller-side read-then-write would let two concurrent JOINs both see "no record".
  It keys on the **`sms_consents` row, not the watermark**, and a refused JOIN advances **no**
  watermark, or it could mask a later legitimate START. `ConsentTransitionResult.refusal`
  (`stale` | `already_enrolled`) disambiguates `applied: false`; routing keys on the **reason**, and
  keying on `!applied` **passed the whole routing suite** until a stale-JOIN fixture existed.
  `ALREADY_JOINED_RESPONSE` (114 chars, one segment) tells the farmer to text START — deliberately
  **not** a registered 10DLC auto-response, so it is editable without touching the carrier
  registration. **Honest limit: while the block is active that reply is itself 409'd and never
  arrives.** The remaining work is farmer-facing, not code — onboarding material must say **START**,
  not JOIN, for returning after an opt-out.
- **B-010 — FIXED and merged, integration-verified.** `outbox_dispatch_attempts` now carries
  `provider_code` (validated machine token) and `provider_error_detail` (phone-masked, 500-char
  bounded) via migration **0004**; `summarizeProviderError` never throws, so a malformed error body
  cannot break the send path. Nothing branches on either — `errorCode` is still what the retry policy
  reads. The item's own privacy question is answered: the real 40300 body **does** echo both E.164
  numbers, so phones are *masked* rather than the class being dropped, reusing the outbound guard's
  `PHONE_BODY` via `maskRawPhones`. `createTelnyxTransport` was **unexported and untested** — that is
  how the discard survived, since everything above it used the never-failing simulator. Triage query
  is in RUNBOOK §"Failure triage".
- **B-008 — lint does not run in deployed builds.** `apps/web` omits `@typescript-eslint/eslint-plugin`
  and `@typescript-eslint/parser`, so the plugin fails to load and Next skips lint non-fatally: the
  build goes green with the gate silently absent. Two-line manifest fix; the real work is extending
  `workspace-manifests.test.ts` to config-file dependency references.
- **F-031 — no mail provider, so no sign-in link is delivered.** F-032 built everything up to the
  wire (request route, throttle, `/admin/login`, code-rendered template, fail-closed seam). What
  remains is the transport: a vendor, its credentials, its **attested** data-handling terms, and
  SPF/DKIM/DMARC on the sending domain. **Blocked on what email infrastructure VIGA already runs** —
  max is finding out. Surveyed 2026-07-26 so it is not repeated: **GCP has no first-party
  transactional email API**; "email on GCP" means SendGrid via Marketplace, whose terms are
  **Twilio's, not Google's**. Never infer the attestation values. Until this lands a link must be
  minted out of band with `issueMagicToken`, so a non-technical operator still cannot sign in
  unaided.
- **B-001** stays open pending its caveat below. `model_runs` has **no production writer** — its only
  insert is in a test; unowned. No per-stand pages or filter/search UI. Message classification has no
  consumer. SMS inquiry has no HTTP route **by design** — reached from the Telnyx webhook worker.

### Standing rules learned from real defects

**Run suites sequentially, never chained**; capture a failing test name before rerunning
(`npm run test:integration 2>&1 | tee /tmp/itest.log`). Treat a named failing test as a real defect
until shown otherwise. **B-001 is not proof the intermittent-failure class is closed** — its original
failing test name was never captured, and a date boundary produces the same signature.

**Sabotage-test every claim: a test that cannot fail proves nothing.** This has caught real gaps
repeatedly — an exemption predicate drift (`= 'open'` → `<> 'resolved'`) that passed an entire suite
because no fixture isolated a dismissed-only thread, a role suite that passed an operator→farmer
privilege escalation, and B-004's own race tests, which stayed green through three separate claim
guards being disabled. **Verify agent reports rather than relaying them**; agents have reported
completion with uncommitted work and marked PM items "in review" ahead of reality.

**`Promise.all` over two async branches does not race them.** The first branch's transaction resolves
before the second starts, so a two-branch concurrency test serializes itself and cannot fail. Use
enough simultaneous claimants to actually contend (B-004 uses 8), and confirm by sabotage that the
test fails when exclusion is genuinely removed. Related: the load-bearing per-sender guard is the
**`sender_states` upsert row lock** — the explicit `for update`, the `alreadyProcessing` check, and
the `state = 'pending'` filter are defense-in-depth, and disabling any one alone changes nothing.

**`sharedDb` caches on first call and ignores the URL after that.** A second `createAppContext` in one
process cannot be pointed at another database, and `close()` on any context tears down the shared
pool. Assemble the capabilities a pass actually needs instead of building a second context.

**Inspect before proposing anything destructive — and guard it anyway.** A reset script was written
for a database assumed empty; it held the **older Farm Friend's** data (6 volunteers, 17 messages, 2
farms with phone numbers). Only its row-count guard prevented the loss. Read the actual state first,
then make the destructive step require an explicit confirmation **and** fingerprint its target, so a
mistyped connection string fails instead of erasing something else. Related: a confident
pooled-vs-direct Neon theory was wrong — the real cause was a colliding `flags` table that
`CREATE TABLE IF NOT EXISTS` silently skipped, and **the repeated migration failure was protecting
the old data**.

**Use isolated worktrees for parallel agents.** Two agents dispatched into one shared tree overwrote
each other repeatedly and spent more effort recovering than building.

**The local runtime is not the deployed runtime, and a green suite says nothing about the gap.**
B-009's whole class: vitest runs in Node, where a floating promise resolves, so the kick suite passed
while production dropped every message. Node semantics ≠ serverless lifecycle, just as a hoisted
`node_modules` ≠ an isolated install (B-005 → B-008). When a property belongs to the *platform*
rather than the code, assert it against the **source** — that is what `kick-survival.test.ts`,
`cron-schedule.test.ts`, `cron-auth.test.ts` and `workspace-manifests.test.ts` all are — and verify
the real thing by **effect** in the deployment.

**A source-reading test can match its own import statement — or any other incidental text.**
`kick-survival.test.ts` first asserted `/waitUntil\s*\(/` over the whole file and **survived
reverting the call site to the production defect**, because the import line satisfied it. Strip
imports, anchor to the call site, and never trust such a test until the sabotage has actually been
run. **This has now happened twice.** `external-scheduler.test.ts` asserted the workflow checks its
HTTP status with `/--fail|-f\b|http_code|status/` plus a bare `/exit 1/`, and survived a workflow
that accepted **every** status — the words were satisfied by the `-w '%{http_code}'` flag and by an
unrelated missing-secret guard. The general rule: **a source assertion must be anchored to the
construct it claims to prove** (the comparison, the call site), never to vocabulary that appears
near it. Loose alternation is the tell.

**An unexported seam is an untested seam.** `createTelnyxTransport` was module-private, so the one
code path that parses a real provider error had no test at all — every suite above it used the
simulator, which never fails. That is how B-010's discard survived. When a seam does the real I/O
parsing, export it and test it against real captured payloads, or its failure mode is invisible.

**`select … for update` cannot serialize a row that does not exist yet.** B-011's first guard read
`sms_consents` inside `applyConsentTransition` and refused on a hit, with a comment claiming the
existing `for update` on the watermark serialized it. It does not: `for update` locks rows that
EXIST, and a genuinely first-time sender has no watermark row, so eight concurrent JOINs all read
"no record" and **three enrolled**. Every unit test passed — stubs cannot model row contention.
For a first-insert race the arbiter must be a **unique index**, not a lock:
`insert … on conflict (key) do nothing returning …`, where the empty result *is* the signal that
someone else won. Without `returning`, winner and loser are indistinguishable.

**A tool that "isn't installed" may just not be on `PATH`.** Two lookups for Postgres came up empty
and a whole session proceeded on "no database available", writing that into the docs as an owed
gap — while Homebrew's `postgresql@16` was installed and *running* at
`/opt/homebrew/opt/postgresql@16/bin`. Running the integration suite is what exposed the race above.
Check `/opt/homebrew/opt`, `brew services list`, and the app directories before concluding a
dependency is absent; **a negative result from one lookup is not proof of absence**, and it is the
same reasoning-from-indirect-evidence error as trusting `vercel env ls`'s timestamp column.

**Do not infer configuration from a dashboard's timestamp column.** `vercel env ls` reported
`TELNYX_API_KEY` as "1h ago" while the web UI showed "Updated just now" — the CLI column is not last
-update. That produced a confidently wrong conclusion mid-diagnosis. Values in Vercel are
**write-only**: neither the UI nor `vercel env pull` reveals them (`[SENSITIVE]`), so the only honest
check is **behavioural**. Record every secret in a password manager *at the moment it is set* —
`PHONE_HASH_SALT` especially, since rotating it orphans every phone hash in the database and is
therefore unrecoverable in a way the others are not.
