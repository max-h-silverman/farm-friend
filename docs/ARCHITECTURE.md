# Farm Friend — System Architecture

The *system* source of truth: package boundaries, runtime surfaces, deterministic routing, key
workflows, provider seams, and the invariants the code must enforce. Product rationale is in
[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md); data in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); AI in
[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md).

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract; where this doc disagrees, the handoff wins.
>
> **Status: requirements, not claims.** Most of this document describes the **target** the build is
> working toward. The repository does not yet enforce it — there are no committed migrations, the
> SMS webhook does not verify signatures or persist, the live SMS and model adapters throw, package
> dependencies point the wrong way, and there is no composition root. Statements here are
> **requirements** until executable code and a test prove them. Do not cite this doc as evidence
> that a guarantee holds.

## Design stance: the zen desk

Simplicity and elegance are **architectural requirements**, sibling to the invariants — the
coordinator works in a zen office, not a bureaucracy (CLAUDE.md "Simplicity and elegance — the
zen desk"). In this system that looks like:
- **One general mechanism, many consumers** — one confirmation mechanism, one retrieval layer.
  Extend by generalizing an existing mechanism before adding a parallel one.
- **Few, narrow seams** — a new seam, entity, or package must earn its place *now*, for a real
  consumer that exists.
- **One small, fixed routing order** — not special cases scattered across handlers.
- **Each concept lives in exactly one place** — a behavior has one owner, a fact has one doc. When
  a change makes something redundant, delete it in the same change.

## Stack

TypeScript **npm-workspace** monorepo (ESM), Postgres source of truth, **Next.js App Router** as
web + API/webhook host + farmer account + admin, deployed on **Vercel** (Cron for scheduled jobs)
against **Neon Postgres**. **Telnyx** SMS and the language model each sit behind a narrow swappable
seam.

Launch is a **single VIGA operation**: no tenancy machinery, no tenant column, no tenant-scoped
queries. No native application.

## Package layout

```
apps/
  web/       UI, HTTP handlers, scheduled jobs, and the single composition root

packages/
  core/      Authoritative workflows, product rules, and narrow ports
  db/        Schema, migrations, repositories, and transaction handling
  sms/       Telnyx adapter, webhook verification, and outbound safeguards
  ai/        Model adapters, safe context assembly, and grounded-output validation

evals/       Model and adversarial evaluations
```

**Dependency direction (a hard rule):**

```text
web  -> core
web  -> db, sms, ai
db, sms, ai -> core
core -> no other package
```

`core` defines the ports; `db`, `sms`, and `ai` implement them. **`core` imports no other
workspace package** — that is what keeps product rules testable without I/O.

> *Current violation:* `packages/core/package.json` depends on `ai`, `config`, `contracts`, `db`,
> and `sms`, reversing this direction. Correcting it is a separate finding.

**One composition root** in `apps/web` constructs the database, model, SMS, mapping, and other
adapters and injects them into the authoritative workflows. Runtime configuration is folded into
that root — there is no `config` package. Workflow types live in `core`; HTTP validation lives
beside its handler — there is no `contracts` package.

There is no launch justification for a separate `config` or `contracts` package, a native app, a
permanent map package, gleaning artifacts, or tenancy machinery.

## Runtime surfaces

- **Public web:** the map render + listing experience, ungated and embeddable in VIGA's site;
  per-stand pages; the QR stock-out web form. Anonymous, no signup.
- **Farmer account:** sign-in → onboarding, inventory updates, profile, and preferences.
- **Admin:** sign-in → **single-level** VIGA administration: farm approval, flags, stock-out
  reports, and exceptions the system cannot safely handle.
- **Telnyx webhook:** signature-verified inbound SMS → deterministic routing.
- **Scheduled jobs:** farmer prompting, outbound delivery, retry, and retention.

## Deterministic routing (code, before any model call)

All inbound SMS is routed by **code, before any model call**, in this fixed order:

1. **Compliance keywords win** — STOP/START/HELP and their required variants. `STOP` always
   unsubscribes **globally**, regardless of conversation state, and can never be reinterpreted.
   `JOIN` handles per-program enrollment for any future program.
2. **`MUTE`** scopes off a specific passive follow-up without touching global consent.
3. **`FLAG`** pauses the thread + creates a review item (the human-handoff safety rail). FLAG is a
   **Farm Friend product safety feature**, not a carrier-mandated keyword.
4. **Live pending confirmation** — a context-bound token that commits the one pending action it
   belongs to. These are **never global**, commit **exactly once**, and **expire**. A token must
   match deterministically and be the **entire message**; anything else is free text for the steps
   below.
5. **Active conversation state** routes the message to its in-flight flow.
6. **Authority and consent gates** determine what the sender may do.
7. **Only then** may a model seam run.

A pending confirmation is bound to its specific action and kind. An affirmative or negative token
must never commit an unrelated pending action.

> *Current gap:* the generic commitment machine permits affirmative tokens across unrelated pending
> kinds and has no transactional caller; the deterministic parser and the registered 10DLC copy
> disagree about supported command forms. Both are open findings.

## Confirmation

Confirmation — a pending action plus a context-bound token that commits it exactly once, with
expiry — is a **single mechanism**. At launch its consumers are farmer inventory publication and
the farmer's response to a stock-out report. Expiry is a per-consumer parameter. Adding a consumer
means parameterizing this mechanism, never forking it.

## Key workflows (code owns the commit; the model only proposes)

Every workflow has **one authoritative core use case and one durable path**:

| Workflow | Authoritative behavior |
|---|---|
| Initial listing data | Validate and seed farms, locations, listing facts, and approval state; public and SMS views read the same records |
| Farmer onboarding | Verify the phone, associate the farm, capture preferences, record VIGA approval separately |
| Inventory publishing | Store a proposed revision, obtain explicit confirmation, then atomically publish it and supersede the prior revision |
| Customer stock-out | Store a private report and optionally queue a farmer request; never alter public inventory |
| Farmer report response | Resolve the pending action and publish only with explicit farmer confirmation |
| Customer inquiry | Retrieve permitted current records, obtain model interpretation and composition, validate claims, queue the reply |
| Passive follow-up | Store a disclosed, narrow, expiring interest; enforce MUTE, STOP, frequency, and recipient selection in code |
| STOP / START / JOIN / HELP / MUTE | Apply consent changes before any other interpretation or outbound selection |
| FLAG | Store the concern and expose it to the single-level admin queue |
| Authentication | Issue and consume short-lived credentials once, with replay prevention and rate limiting |
| Provider delivery | Commit business state and an outbox entry together; send afterward with retry and deduplication |
| Retention | Delete expired raw context while preserving only required consent, safety, and audit records |

**External SMS and model calls never occur inside a business database transaction.** The
transaction commits the decision and the outbox entry; workers perform the external operation and
record its outcome.

## Provider seams

Narrow interfaces so I/O is swappable and tests are hermetic:

- **SMS transport** (`packages/sms`) — send + inbound **webhook signature verification**. Telnyx's
  receiving guidance requires verifying signatures and tolerating prompt acknowledgement, retries,
  duplicate events, and out-of-order delivery; ingress must be idempotent per provider message.
  Send accepts only a **redacted** outbound value that has passed a code-level guard which
  normalizes avoidable typographic Unicode and refuses raw phone numbers regardless of model
  output. The package estimates GSM-7 vs. UCS-2 and billable segments, and logs cost metrics by
  recipient hash **without logging message text**.
- **Model provider** (`packages/ai`) — accepts only a **safe context** produced by the stripping
  assembler; its output is **untrusted** and validated (schema + evidence) before anything acts on
  it. The model is never vouched for — only measured (evals) and contained (the harness). See
  [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) "The trust contract."
- **Clock** — injected time, so recency and expiry are deterministically testable.

Geocoding is a **one-time seeding concern**, not a permanent provider seam. There is no map
package and no coordinate-inventing stub; a seed utility resolves locations once, and unresolved
locations are an operator task rather than a fabricated coordinate.

## Abuse / cost throttle

The customer inquiry route and the QR stock-out form ingest free text into a model with **no
auth**. A code-level rate/cost guard fronts any public model-backed handler, keyed by a coarse
client signal. Normal public lookup is **never artificially capped**; the guard exists only to
bound abuse and cost.

## Invariants (must be enforced in code and proven by tests)

1. The farmer owns published state — no customer action mutates published inventory or ranking.
2. Deterministic compliance and confirmation before any model call; STOP always global;
   confirmation tokens context-bound, exactly-once, expiring.
3. The model proposes; code commits. Publication is confirmation-gated.
4. Grounded, recency-labeled answers; no factual claim survives without retrieved evidence.
5. Privacy at the data layer — phones hashed, raw never logged, never in model context.
6. Safety enforced by code in three layers (compile / runtime / eval), never the system prompt.

Full statements and the "why" live in [CLAUDE.md](../CLAUDE.md) Golden Rules. Each invariant is a
**requirement awaiting executable proof**, not a description of current behavior.
