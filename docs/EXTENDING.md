# Farm Friend — Extending the system

Recipes for adding to Farm Friend without breaking an invariant: a future program, an admin surface, a
farmer-link surface, a model seam, or a provider swap. **Open the recipe for what you're adding** —
this is a reference, not a cold-start read.

Day-to-day operation (install, run, migrate, seed, deploy, rotate) is in [RUNBOOK.md](RUNBOOK.md). The
rules each recipe protects live in the architecture docs; [README.md](README.md) indexes them.


## Add a future program

Gleaning, volunteer coordination, and Farm Bucks transactions are **plausible future programs**,
deliberately unbuilt. When one arrives:

1. Define and externally disclose its **separate enrollment**. Extend the deterministic keyword grammar
   only then; launch `JOIN`/`START` refer only to the launch operational program. Universal STOP
   continues across all Farm Friend messaging.
2. Add only the program-specific consent state and UI the approved workflow actually consumes.
3. Add its branch to the deterministic routing — **before** any model call.
4. If it needs confirmation, make it a **consumer of the existing confirmation mechanism** by
   parameterizing it — do not fork it.
5. Test-first: keyword and confirmation bypass, consent gating, the commit path.

Do **not** pre-create a general program-enrollment platform or a future program's tables, states,
command arguments, packages, or UI.

## Add an admin route or surface

1. Load queue data in the server-rendered page after resolving the administrator. Do not add a
   duplicate queue GET API. For a browser action or the flag-thread fetch, guard the route with the
   shared `requireAdministrator` from `apps/web/lib/admin-guard.ts`.
2. Take the acting administrator from the **session**, never the request body.
3. Re-read the administrator's authority **inside the transaction that writes**, and commit the audit
   event in that same transaction. `packages/db/src/review.ts` and `admin.ts` are the pattern.
4. Project the minimum: no phone material unless the surface genuinely needs it, and mask it at the
   **query** (`right(phone_e164, 4)`) rather than in the renderer, so the raw number never leaves the
   database.
5. Test-first: assert an unauthorized caller is refused for every exported method. For a reader, test
   the server page or the real browser-consumed GET and grep the whole projection for an E.164 and any
   64-hex run.

**The public password-login route is the exception.** `POST /api/auth/login` is deliberately
unauthenticated, so `requireAdministrator` cannot apply. What replaces it:

- **Answer identically for every input.** Not "return 200 in both cases" — identical status, headers,
  and body, asserted by comparing whole serialized responses, including malformed input, missing
  configuration, revoked authority, and internal failure.
- **Reserve both durable budgets before verification:** account-wide first, then coarse client. The
  stable lock order prevents deadlocks and the aggregate prevents distributed guessing.
- **Run the maintained Argon2id verifier for every syntactically valid email**, then re-read the fixed
  authority row before comparing the email. Neither timing nor response reveals membership.
- **Return the raw session token only in the secure cookie.** Store only its hash.

## Add a surface behind a farmer's standing link (F-040)

A third auth shape: no session, no password, and a credential that **does not expire**. The rules
follow from that last fact.

1. **Resolve the token per request, through `resolveStandFromToken`.** Never cache the result into a
   cookie, a session, or the page. Revocation is the only safety net a standing link has, so anything
   that remembers the answer is a way around it.
2. **Take every identifier from the token's row, never from the request** — the sales location, the
   sender hash, all of it. The moment a caller can name what they are acting on, the blast radius stops
   being "one stand".
3. **Keep the projection minimal, and assert its exact shape.** `resolveFarmerLink` returns four
   fields; the test asserts `Object.keys(...)` equals exactly those. A projection that grows a farm list
   or a contact is how a leaked link becomes a way to read someone else's data.
4. **Publication goes through `confirmInventoryPublication`, always.** No surface function may write
   `inventory_revisions`, and no argument may skip the proposal step.
5. **Put the token in the request BODY, not the URL.** A path segment is unavoidable on the bookmarkable
   page itself; everywhere else it would land in proxy logs, analytics, and history.
6. **Test-first in `apps/web/lib/farmer-stand.integration.test.ts`**, one test per blast-radius bound,
   and **sabotage each one**. Six of these assertions were written wrong the first time and only
   sabotage found them — including one satisfiable by the exact attack it forbade. Where two independent
   defenses cover the same property, assert each **in isolation**, or one of them will eventually be
   deleted as dead code.

## Add a model seam

1. Add the seam to the catalog in [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) and define its schema.
2. Define the seam's explicit minimal input projection. It may contain only the current task text,
   required public facts, and opaque identifiers; never a raw record, transcript, other actor's text,
   contact/auth/consent/admin/audit data, internal note, or secret.
3. Add a task-specific context constructor and keep the low-level branded provider call internal to
   `packages/ai`; do not give the adapter a repository, database client, or provider-managed thread.
4. Validate the output against **schema and evidence**, one repair retry, then clarify or flag.
   Structural validity is not grounding.
5. Code-render every consequential or cross-actor message. Model-authored prose may return only to the
   same actor whose current task text supplied its private context.
6. Add a hostile full-workflow fixture that captures the provider context and resulting outbox row
   (advisory; **critical** if safety-relevant), then run the evals.

**Copy the worked example.** `inventory-extraction` is the pattern: `projectInventoryExtraction` in
`packages/ai/src/projections.ts` (steps 2–3 — note it copies each permitted field explicitly rather
than spreading a caller's object), `packages/ai/src/inventory-seam.ts` (step 4, and note every schema
member is `.strict()` so a smuggled consequential field is a visible refusal, not a silent strip),
`apps/web/lib/interpretation.ts` (step 5, plus snapshot-membership validation the schema cannot do),
and `evals/hostile.ts` with the hostile group in
`apps/web/lib/interpretation.integration.test.ts` (step 6). Add the new projection's own bypass
assertions to `packages/ai/src/safety-boundary.type-test.ts`.

**For a smaller worked example, read `offering-extraction`** (F-035): `projectOfferingExtraction` plus
`packages/ai/src/offering-seam.ts` is the whole seam in ~90 lines, and its four fixtures show the
minimum a new seam owes — refusing a smuggled consequential field, withholding everything but the task
text under injection, keeping provider failure distinguishable from an empty answer, and failing closed
on a raw phone in its input.

**Before writing a seam, check a deterministic version against real data first.** F-035's availability
parsing needed no model once "not stated" was separated from "unparsed"; offerings did, because a regex
could not tell an offering from a farming-practice clause. The corpus settled both questions. A seam
that a measured deterministic path would have covered does not earn its place.

## Swap a provider

- **Model version, same approved provider contract:** implement/select it by config; the branded context
  boundary remains unchanged and the full suite must pass at parity or better.
- **Model provider:** before selection, re-verify that it does not train on Farm Friend
  requests/responses, calls are stateless, request/response logging is disabled where supported, and
  unavoidable retention has an approved documented maximum. A provider swap is not exempt from this
  privacy gate. **Declare the terms in code**: add the provider's `ProviderDataHandling` to
  `resolveModelConfig` in `apps/web/lib/composition.ts`. `assertProviderApproved` runs at startup and
  **throws** on any violation, so a provider that cannot meet the terms never constructs. Note what
  this is: an operator-attested, version-controlled declaration checked in code — not a network audit
  of the vendor's actual practice.

  **`LLM_PROVIDER` is required and has no default (GL-019)** — absent or blank is a
  `ConfigurationError`, as is an unknown value, because a typo must never silently run the test double
  against real farmers. That is not hypothetical: production ran the stub for its entire life because
  nobody set the variable and the code defaulted to it. Deliberately **not** "required only in
  production" — a rule that relaxes off-production behaves one way everywhere it is tested and another
  way where it matters.

  **DeepInfra is attested** (F-024, reviewed 2026-07-28, directed by max).
  `DEEPINFRA_ATTESTED_DATA_HANDLING` in `packages/ai/src/deepinfra.ts` — beside the adapter it gates,
  so scripts and evals constructing the provider outside the composition root approve the same
  declaration via `assertDeepInfraSelectionApproved` — records the terms transcribed verbatim from
  <https://docs.deepinfra.com/account/data-privacy>: no training on API data, stateless inference,
  content logging off by default, zero stated retention, with the recorded caveat that DeepInfra
  reserves an unbounded discretionary right to log "a small portion of requests". The terms are the
  *inference host's*, not the model author's licence. **The carve-out is enforced in code**: an
  `anthropic/` or `google/` `DEEPINFRA_MODEL` is a startup `ConfigurationError`. Source tests pin the
  four values *and their citation* — changing either alone fails. If the terms change, move the
  binding, citation date, and pinned test together.
- **SMS:** implement the transport (send + **signature verification**); the redaction guard continues
  to normalize avoidable Unicode and block raw phones. After the provider accepts a send, record
  encoding, character count, and estimated billable segments — **by recipient hash, never with message
  text**. Preserve the outbox dispatch-authorization boundary.

