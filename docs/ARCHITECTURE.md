# Farm Friend — System Architecture

The *system* source of truth: package boundaries, runtime surfaces, deterministic routing, key
workflows, provider seams, and the invariants the code must enforce. Product rationale is in
[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md); data in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); AI in
[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md).

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract; where this doc disagrees, the handoff wins.
>
> **Status: requirements, not claims.** Most of this document describes the **target** the build is
> working toward. The package boundary and dependency direction are enforced by an architecture
> test. The clean launch schema and initial migration are present and verified from an empty
> throwaway Postgres database, but the repository transactions and workflows described below are
> not implemented. The SMS webhook does not verify signatures or persist, live provider
> implementations and the composition root do not exist, and the generic AI assembler does not
> implement the approved task-specific privacy projections. Statements here are **requirements**
> until executable code and a test prove them. Do not cite this doc as evidence that a guarantee
> holds.

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
  ai/        Model adapters, task-specific context assembly, and typed selection validation

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

> *Verified current boundary:* `packages/core/package.json` has no workspace dependency, core source
> imports no workspace adapter, and the architecture test permits workspace edges only in the
> direction above. The composition root and adapter implementations remain later work.

**One composition root** in `apps/web` constructs the database, model, SMS, and other
adapters and injects them into the authoritative workflows. Runtime configuration is folded into
that root — there is no `config` package. Workflow types live in `core`; HTTP validation lives
beside its handler — there is no `contracts` package.

There is no launch justification for a separate `config` or `contracts` package, a native app, a
permanent map package, gleaning artifacts, or tenancy machinery.

## Runtime surfaces

- **Public web:** the model-free map render + listing/filter experience, ungated and embeddable in
  VIGA's site; optional transient browser-origin proximity; per-stand pages; destination routing
  links; and the QR stock-out web form. Anonymous, no signup. There is no launch natural-language
  web inquiry.
- **Farmer account:** sign-in → onboarding, inventory updates, profile, and preferences.
- **Admin:** sign-in → **single-level** VIGA administration: farm approval, flags, stock-out
  reports, and exceptions the system cannot safely handle.
- **Telnyx webhook:** signature-verified inbound SMS → deterministic routing.
- **Scheduled jobs:** farmer prompting, outbound delivery, retry, and retention.

## SMS ingress and sender ordering

The webhook reads the exact raw request bytes and verifies the Telnyx signature **before parsing**.
After verification it normalizes the sender, then commits a **minimized inbox projection** before
acknowledging: provider event ID, provider message ID, event type, `occurred_at`, sender/contact
reference, TTL-bound message body where needed, and processing state. The raw provider envelope and
a second raw E.164 are not stored. The provider event ID is unique; duplicate delivery is a
successful no-op.

Ordinary stateful work is serialized per sender in Postgres. A short transaction locks the sender
row and claims at most one inbox event; it never spans a model or SMS call. The claimed row is
recoverable after an abandoned claim, and retry uses that row rather than creating another logical
event. After external work, finalization re-locks the sender and applies a consequence only if the
claim and relevant state are still current.

Stateful events are ordered by `(occurred_at, provider_event_id)`. An event older than the sender's
accepted conversation watermark cannot mutate newer conversation, confirmation, or publication
state; code may ask the sender to resend. Farm Friend deliberately does not reconstruct an
arbitrarily reordered conversation.

`STOP` and `START` use a separate consent-transition watermark. The chronologically later command
wins, and `STOP` wins an exact timestamp tie, so intervening free text cannot make a consent command
stale and an older delayed `START` cannot undo a newer `STOP`.

## Launch SMS consent

Launch VIGA Farm Friend is one registered operational SMS program. Each recipient has one current
launch-program consent state with capture provenance. `JOIN` and `START` establish or restore it;
documented farmer onboarding may establish it only after number-control verification and records
how, when, and where consent was captured. Inventory prompts, publication confirmations, customer
inquiry replies, and stock-out alerts are message categories inside that program, not separate
program enrollments.

A customer-initiated inquiry permits its relevant direct response but creates no durable consent for
later proactive notifications. Launch stores no follow-up interest and has no scoped `MUTE` command.
Every proactive non-required dispatch requires active launch consent. Universal `STOP` applies
across all Farm Friend messaging and uses the ordered transition and dispatch boundary above.

Future programs require their own disclosed enrollment when they are approved and built. Launch has
no program discriminator, future-program enrollment row, `JOIN <program>` grammar, or general
program-enrollment mechanism.

## Deterministic routing (code, before any model call)

Each verified, accepted inbound SMS is routed by **code, before any model call**, in this fixed
order:

1. **Compliance keywords win** — STOP/START/JOIN/HELP and their required variants. `STOP` always
   unsubscribes **globally**, regardless of conversation state, and can never be reinterpreted.
   `JOIN` and `START` establish or restore the one launch-program consent state.
2. **`FLAG`** pauses the thread + creates a review item (the human-handoff safety rail). FLAG is a
   **Farm Friend product safety feature**, not a carrier-mandated keyword.
3. **Live inventory confirmation** — a context-bound `YES` or `NO` that applies to the sender's one
   open inventory proposal. It is **never global**, commits **exactly once**, and **expires**. A token
   must match deterministically and be the **entire message**; anything else is free text for the
   steps below.
4. **Active conversation state** routes the message to its in-flight flow.
5. **Authority and consent gates** determine what the sender may do.
6. **Only then** may a model seam run.

A confirmation token is accepted only for the sender's one open inventory proposal, after the
current prompt has been accepted by Telnyx, and only when the token's provider occurrence time
follows that activation. It must never commit an earlier proposal version.

> *Current drift:* the generic commitment machine still accepts `OUT` across unrelated pending
> kinds and has no transactional caller. The target below replaces it. The deterministic parser and
> registered 10DLC copy also disagree about supported command forms; campaign alignment remains
> F-012.

## Confirmation

Launch has one confirmation mechanism and one consumer: **inventory publication**. A database
constraint permits at most one open inventory proposal per sender. It records the proposal/version,
allowed `YES`/`NO` tokens, expiry, and the outbox prompt that activates it. New farmer inventory
text revises that same pending proposal rather than creating a second one; the proposal-version
change suspends token acceptance until Telnyx accepts the new prompt.

The structured proposal is a distinct pending payload, not a draft inventory revision. Inventory
revisions are immutable published history. `NO` or expiry creates no revision. A successful `YES`
transaction creates the new revision and entries, makes it current, and supersedes the prior
current revision. Full-snapshot versus patch proposal semantics remain a separate unresolved
decision; either must produce one complete published revision at confirmation.

The confirmation transaction locks the sender and pending row, verifies the prompt/version and
expiry, rechecks current farmer authority and VIGA approval, conditionally consumes the pending row
once, and queues its response in the outbox. `YES` publishes; `NO` declines without publication.
Revoked authority or approval produces no publication.

A stock-out alert is informational: it may ask the farmer to send current inventory. That reply
enters the ordinary proposal and `YES`/`NO` flow. `OUT` and `IGNORE` are not commitment tokens and
there is no stock-out pending-action kind.

## Key workflows (code owns the commit; the model only proposes)

Every workflow has **one authoritative core use case and one durable path**:

| Workflow | Authoritative behavior |
|---|---|
| Initial listing data | Validate and seed farms, locations, listing facts, and approval state; public and SMS views read the same records |
| Farmer onboarding | Verify the phone, associate the farm, capture preferences, record VIGA approval separately |
| SMS ingress | Verify the raw-body signature, commit one minimized provider event, serialize ordinary stateful work per sender, and fail closed on stale events |
| Inventory publishing | Maintain one open proposal per sender; after its current prompt is provider-accepted, consume `YES` once only after rechecking farmer authority and VIGA approval, then atomically publish and supersede the prior revision |
| Customer stock-out | Accept a code-bound web/QR location, store a private report, resolve the authorized farmer in code, and optionally ask for current inventory; a reply uses the ordinary inventory flow; free-text customer SMS cannot queue an alert; never alter public inventory |
| Customer inquiry | After deterministic SMS routing, obtain model interpretation of the current request; code validates it and retrieves typed current facts; for non-empty retrieval the model selects/orders fact IDs; code validates membership, renders the factual reply, and queues it; the direct response creates no later proactive subscription |
| Launch SMS consent | Maintain one launch-program consent state with provenance; `JOIN`, `START`, and documented farmer onboarding establish it; message categories do not have separate enrollment |
| STOP / START / JOIN / HELP | Apply deterministic consent behavior before any other interpretation; universal STOP applies across all Farm Friend messaging; order STOP/START on their separate provider-time watermark, with STOP winning an exact tie |
| FLAG | Store the concern and expose it to the single-level admin queue |
| Authentication | Issue and consume short-lived credentials once, with replay prevention and rate limiting |
| Provider delivery | Commit business state and unique outbox work together; recheck consent when claiming dispatch, retry only definitive retryable rejection, quarantine ambiguous results, and apply delivery events monotonically |
| Retention | Delete expired raw context while preserving only required consent, safety, and audit records |

**External SMS and model calls never occur inside a business database transaction.** The
transaction commits the decision and the outbox entry; workers perform the external operation and
record its outcome.

### Outbound dispatch and recovery

The dispatcher locks the recipient state and one queued outbox row, rechecks consent, and
atomically marks the row `dispatching`. That commit is the STOP linearization point:

- if STOP commits first, every still-queued non-required message is suppressed;
- if dispatch authorization commits first, the request may still reach Telnyx.

Farm Friend does not claim it can recall already authorized work. A definitive retryable rejection
may use a bounded retry policy. A timeout, connection reset, or other result that might have been
accepted is recorded as **ambiguous** and is not automatically resent unless Telnyx provides a
separately verified outbound idempotency facility. `message.sent` and `message.finalized` events
advance delivery state monotonically by provider occurrence time; late events never regress a
terminal result.

## Provider seams

Narrow interfaces so I/O is swappable and tests are hermetic:

- **SMS transport** (`packages/sms`) — send + inbound **webhook signature verification**. Telnyx's
  receiving guidance requires verification against the exact raw body, prompt acknowledgement,
  retries, duplicate events, and out-of-order delivery. Ingress commits the minimized unique inbox
  projection before acknowledgement; it does not retain the raw provider envelope.
  Send accepts only a **redacted** outbound value that has passed a code-level guard which
  normalizes avoidable typographic Unicode and refuses raw phone numbers regardless of model
  output. The package estimates GSM-7 vs. UCS-2 and billable segments, and logs cost metrics by
  recipient hash **without logging message text**.
- **Model provider** (`packages/ai`) — exposes task-specific input variants rather than a generic
  record assembler. Each variant constructs a branded minimal projection; the low-level provider
  call is internal and has no database, repository, provider-thread, or arbitrary-record capability.
  Its output is **untrusted** and schema/evidence-validated before anything acts on it. For customer
  inquiries, code additionally requires selected IDs to belong to the typed retrieved set and
  renders the factual reply itself. Model-authored prose returns only to the same actor whose current
  task text supplied its private context; cross-actor messages are code-rendered from permitted
  typed facts. The model is never vouched for — only measured (evals) and contained (the harness).
  The configured provider must not train on Farm Friend requests/responses, calls must be stateless,
  request/response logging must be disabled where supported, and unavoidable retention must have an
  approved documented maximum. See
  [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) "The trust contract."
- **Clock** — injected time, so recency and expiry are deterministically testable.

Geocoding is a **one-time seeding concern**, not a permanent provider seam. There is no map
package and no coordinate-inventing stub; a seed utility resolves locations once, and unresolved
locations are an operator task rather than a fabricated coordinate. Optional browser geolocation
is transient and used only for deterministic approximate proximity to those validated public
coordinates; it is not persisted, logged, or sent to the model. Destination-only Google Maps links
delegate origin resolution and routing to the customer's mapping application. SMS does not resolve
arbitrary customer origins at launch.

## Abuse / cost throttle

The QR stock-out form ingests free text into a model with **no auth**. A code-level rate/cost guard
fronts that public model-backed handler, keyed by a coarse client signal. Normal public map,
listing, filter, and proximity lookup is model-free and **never artificially capped**. SMS inquiry
uses the SMS sender, consent, frequency, and delivery controls rather than a coarse web-client
signal.

## Invariants (must be enforced in code and proven by tests)

1. The farmer owns published state — no customer action mutates published inventory or ranking.
2. Verified, deduplicated, sender-serialized SMS ingress; deterministic compliance and confirmation
   before any model call; one launch operational SMS program; STOP always global and
   provider-ordered against START; no passive customer follow-up or scoped MUTE; exactly one open
   inventory confirmation per sender, context-bound, version-bound, exactly-once, and expiring.
3. The model proposes; code commits. Publication is confirmation-gated.
4. Grounded, recency-labeled answers — the model selects/orders retrieved fact IDs and code renders
   authoritative factual text; unrestricted model prose is not treated as deterministically
   verifiable.
5. Privacy at the data layer — phones hashed, raw never logged, never in model context.
6. Safety enforced by a static provenance barrier plus runtime enforcement, never the system
   prompt; type/workflow/adversarial tests verify those barriers but are not a third enforcement
   layer.

Full statements and the "why" live in [CLAUDE.md](../CLAUDE.md) Golden Rules. Each invariant is a
**requirement awaiting executable proof**, not a description of current behavior.
