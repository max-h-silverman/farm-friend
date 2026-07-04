# Farm Friend

Farm Friend keeps Vashon Island's farm-stand map **fresh**. VIGA's embedded Google Map is the
island's only guide to what farm stands have, and it runs **2–7 days stale** because a volunteer
hand-enters farmer-submitted forms. Farm Friend lets farmers update their own stand directly —
mostly by **SMS** — so the map reflects reality, lets customers find and ask about local food,
and lets customers flag a likely stock-out to the farmer. Nearly all stands are **unattended,
honor-system** stands with stable staples but variable stock, so the system shows *when*
inventory was last confirmed rather than pretending it is certain.

**Picture Farm Friend as a coordinator at a desk.** It's one trustworthy customer-service agent
serving VIGA and the community. On its desk are **files** (the source-of-truth data) and **ways
to answer** (the map/feed, SMS replies, and its own **inference**). It answers *from the files*
and says when they're old; its inference *reads and drafts* but never rewrites the official files
on a hunch — the farmer or staff confirms; it has professional boundaries (a customer's word
doesn't change a farmer's listing — it passes the message along); and when unsure it asks or
hands off to a human rather than guessing. When a design question is unclear, ask *"what would a
good coordinator at a desk do?"* — this is the intuitive "why" beneath the Golden Rules below.

## Status: architecture **settled** — implementation underway

The clean-room architecture lives across the settled docs; the build is underway. The repo was
reset to a clean slate before this build — a prior scaffold's code/docs were removed and live
only in git history (HEAD `3f76949`). It is **archived, not inherited**: do not port its
ontology, file layout, or naming; where it disagrees with these docs, the docs win.

**The architecture docs — the source of truth. Read them in order.**
- **[docs/PRODUCT_BRIEF.md](docs/PRODUCT_BRIEF.md)** — the *product*: north star (a fresh map),
  the three flows + the inquiry route, actors, honor-system reality, the migration/activation
  moment, MVP scope, open questions.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the *system*: repo layout, runtime surfaces,
  deterministic program/commitment routing, key flows, provider seams, tenancy, the abuse/cost
  throttle seam, invariants.
- **[docs/DATA_ARCHITECTURE.md](docs/DATA_ARCHITECTURE.md)** — the *data*: entities (all
  tenant-scoped), constraints, the **two-axis freshness/provenance model** (lifecycle `status`
  vs. provenance), the stock-out-report-never-mutates-inventory rule, privacy/retention, the
  `ai_runs` MAY-store list.
- **[docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md)** — the *AI*: the `LLMProvider` seam, the
  seam catalog (extract, stock-out parse, **inquiry-parse → open intent + a code-owned general
  retrieval/ranking layer**, grounded query, grounded recipes, classify), the model-vs-code line,
  the **three-layer code-enforced safety boundary** (compile / runtime / eval),
  validation/repair, evals, data minimization.
- **[docs/SMS_COMPLIANCE.md](docs/SMS_COMPLIANCE.md)** — keywords, consent (global_sms +
  per-program), required behavior, the FLAG safety rail, provisional copy (A2P 10DLC assumed
  approved by launch — SMS is critical path).

[docs/README.md](docs/README.md) is the index (*building X → read these*).
[docs/RUNBOOK.md](docs/RUNBOOK.md) is the operate/extend guide (local dev, env, migrations, evals,
deploy, Telnyx webhook, importer input contract, and **how to extend** — add a program / add a
seam / swap a provider). [docs/ADMIN_OPERATIONS.md](docs/ADMIN_OPERATIONS.md) is the VIGA operator
guide. [docs/SESSION_LOG.md](docs/SESSION_LOG.md) is the newest-first, on-demand build history (the
*why* behind past changes). The live snapshot of what's true/unfinished is "Current State" below.

---

# Development discipline

> These sections govern *how code gets written.* They are **binding** from the moment the first
> feature lands, and they make the repo work with the `/session-wrap`, `/pm`, and `docs-check`
> skills.

## Choose the best option, regardless of effort

**Never factor implementation effort into a technical decision.** Always choose the best option —
the most correct, robust, and architecturally sound one — regardless of how much work it is.
Effort is never a reason to pick a lesser design, take a shortcut, skip a test, or defer doing it
right. If the best option is large, **surface it and do it** (or plan it deliberately) — never
quietly substitute an easier one. This rule sits above the Golden Rules because it governs how
every decision below gets made.

## Examples are illustrations, never requirements

Specific items, farm names, and question phrasings in these docs and in conversation (e.g. "bok
choy and green beans", "recipes from Provo Farms") are **illustrations of mechanisms and intent —
not a spec**. Build to the general, open-ended design; the customer intent space is broad and
often ambiguous. Don't harden a stray example into a fixed interpretation — let the parse step +
a code-owned strategy layer handle the variation, and ask a clarifying question rather than
guessing.

## Working a task (session workflow)

For agents starting cold. **Work is chunked in the `/pm` backlog and built across sessions;
`/session-wrap` carries continuity.** The loop for a non-trivial change:
1. **Orient.** Read this file + the area's architecture docs (docs/README.md is the index). `/pm
   list` to see what's open, `/pm show <ID>` for the item's acceptance criteria — don't guess
   priorities, they're recorded there. Read "Current State" below for what's live vs. skeleton
   and the next-session prompt the last wrap left.
2. **Claim.** `/pm status <ID> in progress`; branch off `main` (**never work on `main`**), named
   for the item (`f-002-…`).
3. **Test-first, then build.** Write the failing test before the behavior (TDD below). Build to
   the item's acceptance criteria.
4. **Choose the best design.** When a decision has a better-but-harder option, take it — effort
   is not a factor (see "Choose the best option" above).
5. **Verify before done.** Run the suites for what you touched (Commands below) + typecheck.
6. **Wrap.** Don't commit/push/deploy unless asked. Run **`/session-wrap`** before clearing
   context — it verifies green, syncs this file's "Current State" + docs + PM, and leaves the
   next-session prompt so the following session resumes with full continuity.

## Golden rules

The architecture's fatal-failure defenses expressed as code rules (and always applied under
"Choose the best option, regardless of effort" above). Each is what a good **coordinator at a
desk** would do; violating one reintroduces a failure mode the architecture exists to prevent.

1. **The farmer owns published state.** Nothing a customer does mutates the map. A customer
   stock-out report is a *separate signal* that only alerts the farmer; only the farmer's
   confirmed action changes what a stand shows. (data: `stockout_reports` never write inventory.)
2. **Deterministic parsing before any model call.** Compliance + commitment tokens
   (STOP/START/JOIN/HELP/INFO/YES/NO/FLAG/UNSUBSCRIBE/END/QUIT, plus OUT/IGNORE for stock-out
   alerts) are handled by code first. `STOP` always unsubscribes globally and can never be
   reinterpreted by conversation state. YES/NO/OUT/IGNORE are **context-bound, never global**,
   commit **exactly once**, and their pending confirmation **expires**.
3. **The LLM proposes; code commits.** The model extracts, parses, classifies, drafts, and
   composes grounded answers — it never writes durable state, chooses recipients, decides
   consent, invents availability, or overrides a rule. Publishing and alerting are
   code-controlled; publishing is confirmation-gated.
4. **Grounded answers only, retrieval-first — with open intent.** Customer inquiry intent is
   open-ended (which stands, how many, ranked by proximity vs. freshness vs. coverage, or "any"):
   `inquiry-parse` reads the intent + selection strategy (or asks when ambiguous); code runs a
   **general** retrieval/ranking layer (strategy is a parameter, never a hardcoded intersection);
   the model composes only over the retrieved farmer-confirmed rows, always with explicit "updated
   X ago" recency. No invented farms/items; empty retrieval → an honest "no current listing,"
   never a guess. **Migrated data is labeled by provenance + real/import date, never as
   "confirmed."**
5. **Privacy at the data layer.** Phone numbers are normalized + hashed for lookup/logging; raw
   numbers are never logged; raw SMS bodies are TTL-bounded; flags/audit are retained. Model
   context never includes phone numbers.
6. **Safety is enforced by code, never by the system prompt.** Anything that must not fail —
   privacy, consent, compliance, commitment, data minimization — is a **deterministic code
   guarantee the model cannot reach around**, not an LLM instruction (a prompt can be jailbroken
   or prompt-injected, and we ingest untrusted public SMS). This is enforced in **three distinct
   layers, none substituting for another**:
   - **Compile guard** — branded `ModelSafeContext` / `RedactedOutbound` types whose only public
     constructor is the stripping assembler / redaction guard, so you **cannot call the model or
     send an SMS without going through them**. This proves *provenance* (the value came from the
     assembler/redactor), **not** *content* — `tsc` cannot inspect a runtime string, so a brand
     is not proof the string is clean.
   - **Runtime guard** — the assembler actually strips PII/secrets before the call; the outbound
     guard actually scans and blocks a raw phone number after, regardless of what the model
     produced. This is what proves the *content* is clean.
   - **Eval guard** — the adversarial/prompt-injection eval group proves an injected SMS can't
     extract another number or force a commit — blocked by code (data absent + guard +
     validation), not by a prompt refusal.
   A prompt may add defense-in-depth but is **never** the enforcement. (Nudgenik: the boundary is
   the rules/auth layer, *never* the client — here it is code, *never* the prompt.)

## TDD — required, not optional

Development is **test-first**: write the failing test that says what the behavior should be, watch
it fail, make it pass. **The test is the spec** — the architecture's guarantees (farmer ownership
of published state, deterministic compliance, grounded answers, privacy, the code-enforced safety
boundary) are only real if they are *tested invariants*. Suites:
- **Unit** — `npm test` (vitest). Pure core logic is the highest-value target: keep it free of
  DB/SMS/LLM by injecting the provider seams + `Clock`.
- **Integration** — `npm run test:integration` (vitest, Postgres). Data invariants: tenant
  scoping, signup/capacity constraints, *a stock-out report cannot write inventory*, and importer
  idempotency.
- **Typecheck / lint** — `npm run typecheck` / `npm run lint`. The typecheck also **proves the
  safety boundary**: a deliberate un-stripped model call or un-redacted send fails `tsc`.
- **Evals** — `npm run evals`. Required for any change touching a model seam. `critical` fixtures
  (compliance bypass, grounding/no-invention, commitment safety, the adversarial group) must pass
  **100%**; a provider/prompt change must pass the full suite at parity or better.

## Before you ship a change that touches…

- **Compliance / program routing:** test first that keyword + commitment tokens bypass the model
  and that `STOP` is always global; a non-contextual YES/OUT must not commit; a pending confirm
  commits exactly once and expires.
- **A model seam:** trace it in AI_ARCHITECTURE.md (seam catalog + the model-vs-code line); keep
  durable writes/recipient/consent out of model output; run evals. **To add a seam or a program,
  or swap a provider, follow docs/RUNBOOK.md "how to extend" — it is not inlined here.**
- **A new query/list:** add the retrieval in code before any model call; label recency.
- **Anything privacy-relevant:** phones hashed, never logged raw, never in model context. The
  guarantee is **code, not the prompt** — assembly strips PII before the call (compile + runtime),
  the outbound guard blocks it after (compile + runtime); add the adversarial eval proving
  injection can't extract it.
- **The map importer or public feed:** honor the documented input contract (RUNBOOK); the importer
  is re-runnable/idempotent and never clobbers a farmer who has activated; migrated rows render
  **honestly aged** (lifecycle `status=current`, provenance `migrated`, "via VIGA's map, updated
  [date]"), never "confirmed."
- **A public unauthenticated LLM-backed surface** (customer inquiry, QR stock-out): route it
  through the abuse/cost throttle seam (located in ARCHITECTURE.md); normal public lookup is never
  artificially capped.

## Commands

- `npm test` · `npm run test:integration` · `npm run typecheck` · `npm run lint` · `npm run evals`
- Migrations / importer / deploy: see docs/RUNBOOK.md (deploy only when asked).

## Skills

- **`pm`** — backlog in `~/pm/farm-friend/`. Never hand-edit; use the skill (`/pm list`, `/pm show
  <ID>`, `/pm status <ID> …`).
- **`docs-check`** — runs after a manual commit to keep architecture docs fresh; honor it.
- **`session-wrap`** — end-of-session housekeeping (verify green, sync this file + docs + PM).
- **`verify` / `run`** — exercise a change in the running app / SMS simulator.

## Do not

- Do not commit, push, or deploy unless explicitly asked. Branch off `main` first.
- Do not let any customer action mutate published inventory / the map (Golden Rule #1).
- Do not call the model before deterministic compliance + commitment parsing (#2); do not let
  `STOP` be reinterpreted by state.
- Do not let the model commit state, choose recipients, decide consent, or state availability not
  present in retrieved rows (#3, #4); do not render migrated data as "confirmed" (#4).
- Do not log raw phone numbers, raw provider payloads with PII, or put phones in model context (#5).
- **Do not rely on a system prompt to enforce privacy, consent, compliance, or commitment (#6).**
  If a safety property matters, enforce it in code the model cannot bypass across all three layers
  (compile + runtime + eval); the prompt is at most defense-in-depth. Do not send model output
  without code validation + the outbound guard.
- Do not factor effort into a technical decision, or treat the archived prior scaffold as
  inherited architecture.

## Current State & Open Items

> Live snapshot, overwritten by `/session-wrap` — **not** a changelog. Record only **verified**
> facts (test counts from a real run, files read); replace stale lines, don't append.

**Phase:** architecture settled; **Phase 0 (F-006a + F-006b + F-006c) is BUILT and verified**,
**not committed**, on branch `feature/f-006-platform-spine` (off `main` = `3f76949`). Detail +
rationale: [docs/SESSION_LOG.md](docs/SESSION_LOG.md) 2026-07-04.

- **Live:** the 6-package monorepo (`core`, `db`, `sms`, `ai`, `config`, `contracts`); tenant-scoped
  Drizzle schema (two-axis migration model; gleaning designed-unused; `ai_runs` no-input); provider
  seams (`SmsTransport`+sim+Telnyx stub+redaction guard; `LLMProvider`+stub+openweight+
  `ModelSafeContext` assembler+validate-and-repair; `Clock`; `MapProvider`+offline stub); the
  branded compile + runtime safety boundary; the generic commitment state machine (two consumers);
  magic-link auth + server-side `requireRole`; the eval harness + adversarial group.
- **Skeleton:** `apps/web` (map placeholder + `/api/health` + Telnyx webhook stub + auth callback +
  one guarded admin route); `apps/mobile` Expo shell; `maps/` scaffold (importer is F-007a).
- **Verified this session:** `typecheck` PASS (compile guard proven non-vacuous), `lint` PASS,
  `npm test` **38 passed / 9 files**, `test:integration` 3 skipped (DB-gated — no Postgres run yet),
  `evals` critical 3/3 + advisory 2/2 + **adversarial 4/4** (proven non-vacuous).
- **Owed:** commit + PR on the user's go-ahead; run integration vs. real Postgres.
- **Next (launch set, dependency order):** F-007a → F-007b → F-002 → F-008 → F-003 → F-009 (hard
  SMS-compliance gate), all by Eat Vashon week (SMS critical path); then F-004, F-005. Start with
  `/pm show <ID>`, branch off `main`, TDD.
