# Farm Friend — System Architecture

The *system* source of truth: package boundaries, runtime surfaces, deterministic routing, key
workflows, provider seams, and the invariants the code must enforce. Product rationale is in
[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md); data in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); AI in
[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md).

> This document states the **enduring system contract** — what must be true of Farm Friend's
> architecture. It carries no build status: what is actually built, deployed, and open lives in
> [CURRENT_STATE.md](CURRENT_STATE.md).

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
- **Complexity must buy down a *named* launch risk.** If a proposed component cannot name the
  invariant it enforces and the failure it prevents, delete it. "Earns its place" is not a feeling;
  it is a sentence someone can check.

**Excluded infrastructure — a settled architectural decision, not an omission.** The approved
baseline is one Next.js application, one Postgres database, the four packages, Telnyx, and one
model provider. That shape is sufficient for every launch invariant, so Farm Friend deliberately has
**no** event bus, Kafka, event sourcing, workflow engine, distributed lock, separate queueing
service, microservice, policy engine, DLP or taint-tracking product, general PII detector, vector
database, program-enrollment platform, command DSL, or additional workspace package. Reaching for
one of these is the signal that a mechanism has been generalized past its real consumer: a Postgres
inbox/outbox with row locks, one typed projection per seam, one open confirmation, and one
deterministic renderer are what close these invariants. Adding any of them requires naming the
launch requirement the current shape is incapable of.

## Stack

TypeScript **npm-workspace** monorepo (ESM), Postgres source of truth, **Next.js App Router** as
web + API/webhook host + farmer account + admin, deployed from one image to two **Cloud Run**
services against **Neon Postgres**. **Cloud Tasks** triggers immediate sender work; **Cloud
Scheduler** runs recovery, delivery, and retention. **Telnyx** SMS and the language model each sit
behind a narrow swappable seam.

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

`packages/core/src/architecture.test.ts` enforces this: `core`'s manifest may declare no workspace
dependency, core source may import no workspace adapter, and workspace edges are permitted only in
the direction above.

**One composition root** in `apps/web` constructs the database, model, SMS, and other
adapters and injects them into the authoritative workflows. Runtime configuration is folded into
that root — there is no `config` package. Workflow types live in `core`; HTTP validation lives
beside its handler — there is no `contracts` package.

There is no launch justification for a separate `config` or `contracts` package, a native app, a
permanent map package, gleaning artifacts, or tenancy machinery.

## Runtime surfaces

- **Public web:** the model-free map render + listing/filter experience, ungated and embeddable in
  VIGA's site; optional transient browser-origin proximity; per-stand pages; destination routing
  links; and the QR stock-out web form. Anonymous, no signup. There is **no launch natural-language
  web inquiry**.
  `GET /api/public/stands` serves discovery and the map UI at `apps/web/app/page.tsx` renders those
  published records — every card carries code-rendered recency, and a stale listing stays visible
  with a warning. Active owner-confirmed participant names appear as plain text under **Also
  selling here** on map cards and mobile detail, separate from aggregate inventory. One canonical
  read-time closure projection feeds the map/detail status, the
  `Open now` decision, destination actions, discovery, and customer SMS: an active owner-confirmed
  closure overrides the standing schedule, while a future closure is shown as upcoming. Optional
  browser geolocation sorts by approximate straight-line distance in the browser;
  destination-only Google Maps links delegate routing.
  `POST /api/public/stock-out` is the one public model-backed handler, behind the throttle.
  **The model-free property is structural, not a convention:** the public read path imports
  `lib/public-context.ts` (db + clock) rather than the full composition root, so no model seam is
  reachable from its module graph — asserted by `lib/public-surface-model-free.test.ts`, which walks
  the transitive imports of both public entry points.
- **Farmer stand form** (F-040): `/stand/<token>` — a farmer's own listing form, reached by a
  **standing link with no password and no session**. The token is the whole credential and is
  re-resolved server-side on every request, so a revocation takes effect on the farmer's next load;
  it is posted in the request **body** to `/api/farmer/stand`, never a query string, because a
  standing credential must not reach proxy logs or history. **The web path gets no bypass of the
  confirmation gate**: a submission opens or revises the farmer's one pending proposal and
  publication happens only through `confirmInventoryPublication`, which re-reads farmer authority,
  VIGA approval, and whether VIGA has retired the stand (F-071) under lock — the retirement read
  comes from the location row that transaction already holds, so a retirement racing an in-flight
  confirmation resolves at the lock rather than by arrival order. The one honest difference from SMS is activation — there is no
  carrier prompt to be accepted, so the window is opened against a queued confirmation message the
  farmer also receives. A leaked link can at worst propose a wrong listing on ONE stand;
  `apps/web/lib/farmer-stand.integration.test.ts` asserts and sabotages each bound.
  `/stand/<token>/settings` reuses that same standing credential and revocation lifecycle. It
  exposes only the authorization's editable locations, stores one default SMS target, and lets the
  farmer explicitly choose or pause one inventory-reminder cadence per stand. It also owns the
  structured one-name-per-line participant save for the currently selected stand. That save is its
  own confirmation and audit event: it is routed through db + clock before full model composition,
  re-resolves the link, and cannot grant access or attach names to profiles. The settings page has
  no second login and no consent control; pausing reminders never changes launch-program consent.
- **Farmer onboarding** (F-067): `/farmer/onboarding/<token>` — a one-use invitation link that
  captures the SMS agreement and the farm's **listing details**, then hands off to a prepared
  `SIGNUP` text. The invitation token is the whole credential and, like the standing link, is
  posted in the request **body** (`/api/farmer/onboarding`, `/api/farmer/listing`), never a query
  string. **The token also names the farm**: a `farmId` in the request body is ignored, which is
  what stops one invitation writing another farm's listing.
  The listing step is the **first farmer-facing writer of public listing facts** — before it,
  `sales_locations` had exactly one non-test writer, the seeder. It asks whether there is a stand
  to visit before it can know whether an address is required, because
  `sales_locations_coherent_visitability` is all-or-nothing in both directions (F-038, B-024); the
  coordinate comes from the farmer dropping a pin on the drawn island through F-043's projection
  run backwards, optionally **pre-positioned by an address lookup the farmer must confirm**
  (F-069 — see §provider seams; there is still no mapping-provider seam). It also collects
  **structured season, hours, weekday and restocking facts** into F-035's filterable columns, and
  payment methods as a **closed set** plus a free-text tail — VIGA Farm Bucks excluded, since
  acceptance depends on an eligibility only VIGA grants. It publishes on submit (max, 2026-08-05)
  rather than waiting for the SIGNUP text, and it writes standing item state only — never a dated
  confirmation.
- **Farmer address lookup:** `POST /api/farmer/address-lookup` — invitation-gated, throttled,
  server-side geocoding that returns a **draft** coordinate and writes nothing.
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

Interpretation and delivery never happen inside ingress. After the inbox commit, the webhook
**awaits creation of a durable Cloud Task** for that sender, then acknowledges. Task creation is
bounded and never allowed to turn a successful ingress into a 5xx; if it fails, the scheduled pass
recovers the committed event. The task and schedule call the same Postgres-backed passes — see
[RUNBOOK.md](RUNBOOK.md) §"Scheduled work."

The queue owns immediate work rather than the webhook process: a task survives the originating
container and retries independently. This platform property is verified by effect in the deployed
database, not inferred from a local promise completing.

Ordinary stateful work is serialized per sender in Postgres. A short transaction locks the sender
row and claims at most one inbox event; it never spans a model or SMS call. That lock also prevents
a task and concurrent scheduled pass from both claiming the event. An abandoned claim is
recoverable; after external work, finalization re-locks the sender and applies a consequence only
if the claim and relevant state are still current.

Stateful events are ordered by `(occurred_at, provider_event_id)`. An event older than the sender's
accepted conversation watermark cannot mutate newer conversation, confirmation, or publication
state; code may ask the sender to resend. Farm Friend deliberately does not reconstruct an
arbitrarily reordered conversation.

`STOP` and `START` use a separate consent-transition watermark. The chronologically later command
wins, and `STOP` wins an exact timestamp tie, so intervening free text cannot make a consent command
stale and an older delayed `START` cannot undo a newer `STOP`.

**Conversation staleness applies only to what mutates conversation state, and the router — not the
worker — decides that** (GL-002). The two watermarks are independent, so the conversation one has no
standing over a compliance keyword: `routeInboundMessage` parses compliance keywords **before** the
staleness gate and applies the gate to free text and confirmation tokens only. A `STOP` delayed
behind a newer processed message therefore still reaches `applyConsentTransition` and still
suppresses later proactive dispatch. Finalizing such an event as `processed` cannot corrupt
ordering: `claimNextInboundEvent` advances the conversation watermark only for a non-stale event.

This was a real defect, not a hypothetical: `runInboundPass` used to reject every stale event ahead
of any parsing, so a delayed opt-out was discarded as `stale_conversation_event` while the sender
was recorded as still subscribed.

## Launch SMS consent

Launch VIGA Farm Friend is one registered operational SMS program. Each recipient has one current
launch-program consent state with capture provenance. `START` establishes **or restores** it from
any state; `JOIN` establishes it **only for a sender with no consent record** — see B-011 in
docs/SMS_COMPLIANCE.md, where the carrier's own opt-out list, which only `START` clears, is why;
documented farmer onboarding establishes it through that same `JOIN` rule — first-time senders only,
and only once an inbound `SIGNUP <token>` demonstrates control of the number the web agreement was
accepted for. Inventory prompts, publication confirmations, customer
inquiry replies, and stock-out alerts are message categories inside that program, not separate
program enrollments.

A customer-initiated inquiry permits its relevant direct response but creates no durable consent for
later proactive notifications. Launch stores no follow-up interest and has no scoped `MUTE` command.
Every proactive non-required dispatch requires active launch consent. Universal `STOP` applies
across all Farm Friend messaging and uses the ordered transition and dispatch boundary above.

**One predicate, one place.** The consent meaning is one pure predicate,
`isProactiveSendPermitted` in `packages/core/src/sms/consent.ts`, which the dispatch claim in
`authorizeDispatch` consults — so the rule lives in one place and takes no database or model. It
requires **active** consent for a proactive send: an absent consent row means the recipient never
opted in, and silence is not permission. (Before F-016 the gate asked only whether the recipient had
`STOP`ped, so a never-enrolled recipient was authorized.) `outbox_work` carries one bounded
`message_category` — the former free-text `message_kind` plus `is_required` boolean are deleted —
and `consentTransitionFor` maps `JOIN`/`START` onto that one program, differing in recorded
provenance and in whether an existing record blocks them (`JOIN` alone is first-time-only). The
first-time rule is enforced inside `applyConsentTransition` by an `insert … on conflict do nothing
returning` against `sms_consents`' primary key — **not** by a read, and not by the watermark's
`for update`, which cannot lock a row that does not exist yet.

There is exactly **one** consent writer. `applyConsentTransition` is a `begin` wrapper over
`applyConsentTransitionIn(tx, …)`, which web onboarding calls inside its own transaction so the
invitation redemption and the consent write commit together (the same shape as `queueOutbox`). The
first-time rule, the watermark ordering, and STOP's tie-break are therefore stated once and every
caller gets all of them — a second writer would be a second set of consent rules.

**Deterministic code decides three things about every outbound message, and the model decides none
of them: who may receive it, whether launch-program consent permits it, and whether it exceeds the
recipient's general message-frequency limit.** The first two are enforced at the dispatch claim.
The third remains a **requirement not yet built**: launch has no general cross-category rate cap,
and when one is set it belongs beside `isProactiveSendPermitted` at the same dispatch boundary —
never in a prompt, never in model output, and never as a second consent mechanism.

Scheduled inventory prompts have their narrower per-stand cadence now. They are created at 10:00
AM in the stand's reviewed timezone and carry an exact durable subject. At dispatch code rechecks
consent, designated authority, VIGA approval, preference version and due slot, current inventory
and closure bases, active closure, and newer farmer activity before claiming the SMS. Pausing is a
scheduling decision, never a second consent mechanism or the still-unbuilt general rate cap.

Future programs require their own disclosed enrollment when they are approved and built. Launch has
no program discriminator, future-program enrollment row, `JOIN <program>` grammar, or general
program-enrollment mechanism.

## Deterministic routing (code, before any model call)

Each verified, accepted inbound SMS is routed by **code, before any model call**, in this fixed
order:

1. **Compliance keywords win** — STOP/START/JOIN/HELP and their required variants. `STOP` always
   unsubscribes **globally**, regardless of conversation state, and can never be reinterpreted.
   `START` establishes or restores the one launch-program consent state from any state; `JOIN`
   establishes it only for a sender with no record, and otherwise replies naming `START`.
2. **`MAP`** returns only the configured canonical public-map URL. It is stateless, model-free,
   and remains available for a delayed carrier event; its inquiry reply is still suppressed at
   dispatch if STOP has taken effect.
3. **`FLAG`** pauses the thread + creates a review item (the human-handoff safety rail). FLAG is a
   **Farm Friend product safety feature**, not a carrier-mandated keyword.
4. **Live farmer-update confirmation** — a context-bound `YES` or `NO` that applies to the sender's
   one open proposal, carrying inventory, owner-only closure/reopening, or both. It is **never
   global**, commits **exactly once**, and **expires**. A token
   must match deterministically and be the **entire message**; anything else is free text for the
   steps below.
5. **Scheduled snapshot confirmation** (F-052) — exact whole-message `SAME` may publish an
   identical inventory revision only for the sender's active, provider-accepted scheduled prompt
   whose complete snapshot was shown. With no such prompt it changes nothing; text such as
   "same eggs?" continues below as free text. It never confirms closure or profile data.
6. **Farmer product keywords** (F-040/F-051) — `SIGNUP` asks VIGA to set the farmer up, `LINK` asks
   for their private web-form link, `STAND` issues an exact numbered target menu, and `SETTINGS`
   opens the settings view through the existing standing link. Like `FLAG` these are **Farm Friend product keywords, never
   carrier-mandated ones**, and must never be registered as such. They are parsed **last among the
   keyword branches** so one can never shadow a compliance keyword or a commitment token — if a
   synonym ever collided with `STOP`, an opt-out would stop working. **Neither grants authority:**
   `SIGNUP` writes a record with no grant column, and `LINK` is refused unless the sender already
   holds a live authorization. An **invited** `SIGNUP` does establish launch *consent* when its
   invitation carries the web agreement — in the same transaction that redeems the invitation, so
   the two cannot come apart and strand a farmer with a spent invitation and no consent record.
7. **`MORE`** (F-046) returns the next page of the sender's pending result list. Also a **Farm
   Friend product keyword, never a carrier-mandated one**, and parsed **alongside the farmer
   keywords at the end** for the same reason: paging must never shadow an opt-out or a commitment
   token. It is **context-bound like a confirmation token, never global** — it means nothing
   without a pending list, and it must match the **entire message**, so "any more eggs?" stays a
   question. It is deliberately **independent of `YES`/`NO`**: a farmer with an open inventory
   confirmation can page and keep the confirmation, because the words do not overlap and blocking
   one for the other would solve a collision that does not exist.
8. **A positive whole-message number** selects only from the sender's live 12-hour `STAND` menu.
   The stored option binds an exact authorization+location pair; without that context it is a
   code-rendered refusal, never free text.
9. **Active conversation state** routes the message to its in-flight flow.
10. **Authority and consent gates** determine what the sender may do.
11. For authorized farmer free text, the **farmer-message intent seam** returns only
    `inventory_update`, `farm_stand_question`, or `unclear`. It runs before stand targeting so a
    general question does not create a target menu.
12. `inventory_update` continues through exact stand targeting and the existing proposal flow;
    `farm_stand_question` uses grounded inquiry; `unclear` gets a code-rendered clarification.
    No classification outcome publishes inventory.

Farmer update text resolves the sender's durable exact target in code after intent classification.
One live target is selected automatically; several with no selection issue the same numbered menu.
Every use revalidates the authorization and location under the shared sender → location →
authorization lock order. Neither the classifier nor the inventory interpreter receives a target
list or can select or change a target.

A confirmation token is accepted only for the sender's one open farmer-update proposal, after the
current prompt has been accepted by Telnyx, and only when the token's provider occurrence time
follows that activation. Recording Telnyx's acceptance and activating that exact current proposal
version are one database commit after the provider call; either both become durable or neither
does. It must never commit an earlier proposal version.

F-012 removed the superseded generic commitment machine and its `OUT`/`IGNORE` tokens; the
inventory confirmation described below is the one mechanism. The parser's keyword tables are
derived from the registered 10DLC keyword lists, and a test reads
`docs/TELNYX_10DLC_FIELD_VALUES.txt` to prove the two agree in both directions.

## Confirmation

Launch has one confirmation mechanism and one consumer: **farmer-update publication**. A database
constraint permits at most one open proposal per sender. It records the proposal/version,
expiry, and the outbox prompt that activates it. The deterministic parser owns the fixed
`YES`/`NO` variants; proposals store no token vocabulary. New farmer inventory
text revises that same pending proposal rather than creating a second one; the proposal-version
change suspends token acceptance until Telnyx accepts the new prompt.

A proposal has explicit complete sections: inventory, owner-only closure/reopening, or both. The
sections keep independent base revisions but share one confirmation transaction, so a mixed message
publishes both or neither. Closure is append-only history separate from inventory: closing or
reopening never refreshes or clears the inventory revision, and a bounded closure expires only in
the shared read projection. No timer mutates history. Code renders closure status from kind and
local Vashon dates; there is no farmer-authored public closure note. Before interpretation, code
converts the injected clock to the current Vashon calendar date and projects that exact value to the
model. Deterministic preflight resolves supported exact ranges, “this weekend,” seasonal/reopen, and
plain whole-stand closure before that call; ambiguous, contradictory, sub-operation, and multiple
windows clarify without a model. The model receives typed timing evidence, and code rejects any
proposed closure that does not match it, so model clock knowledge never commits calendar facts.

The structured proposal is a distinct pending payload, not a draft inventory revision. Inventory
revisions are immutable published history. `NO` or expiry creates no revision. A successful `YES`
transaction creates the new revision and entries, makes it current, and supersedes the prior
current revision.

**Patch language in, complete snapshot out.** Farmers speak in edits — add this, drop that, it's all
gone — so the interpreter returns typed edits against the sender's complete pending snapshot when
one is open, and against the current published snapshot otherwise. Code applies the edits to produce
the *complete* pending snapshot the farmer is shown. Existing entries retain their opaque IDs; code
issues opaque draft IDs for new pending entries so a later unconfirmed message can change or remove
them. Omission preserves an item; it never deletes one. `YES` publishes exactly that snapshot, so
there is no durable delta, patch log, or replay mechanism, and confirmation always yields one
complete immutable revision.

The confirmation transaction uses one shared lock order: **sender -> location -> participant/access
grant (when used) -> proposal -> authorizations -> approvals**. A revocation locks the same
authorization, access, or approval row that confirmation validates; because it needs only that
decision row, it introduces no reverse lock edge. Whichever transaction locks that row first defines
the honest result without a deadlock. Confirmation then verifies the prompt/version and expiry,
rechecks current owner authority and VIGA approval under those locks, conditionally consumes the
pending row once, and queues its response in the outbox. Proposal creation also verifies owner
authority before persisting an owner-only closure. Before `YES` consumes anything or inserts a
revision, the shared publication boundary validates every free-form public inventory string — item
name, unit, and price text — and refuses the whole proposal if it contains a phone number, email
address, web link, or direct-contact instruction. SMS and farmer web render the same deterministic
refusal naming what to remove; neither silently strips text. `YES` otherwise publishes; `NO`
declines without publication. Revoked authority or approval produces no publication.

A stock-out alert is informational: it may ask the farmer to send current inventory. That reply
enters the ordinary proposal and `YES`/`NO` flow. `OUT` and `IGNORE` are not commitment tokens and
there is no stock-out pending-action kind.

## Key workflows (code owns the commit; the model only proposes)

Every workflow has **one authoritative core use case and one durable path**:

| Workflow | Authoritative behavior |
|---|---|
| Initial listing data | Validate and seed farms, locations, and approval state — **never inventory or phone numbers** (B-002: a seeded listing fact fabricates a confirmation, and a seeded phone fabricates consent); public and SMS views read the same records |
| Farmer onboarding | Verify the phone, associate the farm, capture preferences, record VIGA approval separately |
| SMS ingress | Verify the raw-body signature, commit one minimized provider event, serialize ordinary stateful work per sender, and fail closed on stale events |
| Inventory publishing | Maintain one open proposal per sender; after its current prompt is provider-accepted, consume `YES` once only after rechecking farmer authority and VIGA approval, then atomically publish and supersede the prior revision |
| Participant display | Let the location owner save the complete active **Also selling here** name list as structured public metadata; validate names with the shared public-string guard, retire omissions without deletion, and expose no item provenance or edit access |
| Customer stock-out | Accept a code-bound web/QR location, store a private report, resolve the authorized farmer in code, and optionally ask for current inventory; a reply uses the ordinary inventory flow; free-text customer SMS cannot queue an alert; never alter public inventory |
| Customer inquiry | After deterministic SMS routing, obtain model interpretation of the current request; code validates it and retrieves typed current facts; for non-empty retrieval the model selects/orders fact IDs; code validates membership, renders the factual reply, and queues it; the direct response creates no later proactive subscription |
| Launch SMS consent | Maintain one launch-program consent state with provenance; `START` and documented farmer onboarding establish or restore it, `JOIN` establishes it for first-time senders only (B-011); message categories do not have separate enrollment |
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

For an accepted inventory-confirmation prompt, the accepted dispatch result and activation of the
exact proposal/version named by that outbox row commit in the **same** transaction. The provider
call remains outside it. An accepted older prompt or another message category still records its
honest dispatch result but activates no proposal.

**An abandoned authorization is quarantined, never resent or silently dropped** (GL-003). The claim
commits `dispatching` before the body read, redaction, recipient resolution, provider call, and
result recording — all of which can throw, and the process can die outright. Two defenses of
different kinds, because neither substitutes for the other:

- **Per-row isolation in the pass.** A throw is caught around each row, so one poisoned message
  cannot abort the pass and block every other sender's reply. The row is left `dispatching` rather
  than guessed at, and the pass counts it as `failed`.
- **A durable lease.** `recoverAbandonedDispatches` resolves rows stranded past `DISPATCH_LEASE_MS`
  (10 minutes) into **`ambiguous`** — the state that honestly says "we do not know whether the
  provider accepted it." It runs first on each outbound pass, claims with `for update skip locked`
  so concurrent passes partition rather than double-resolve, and resolves the open attempt with
  `error_code = 'dispatch_lease_expired'` so it stops reading as in flight.

A killed process runs no catch block, and a lease cannot isolate a row mid-pass. Recovery
deliberately never returns work to `queued`: that would resend a message a real person may already
be holding.

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

Geocoding is a **one-time seeding concern**, not a permanent provider seam. There is no `MapProvider`
interface and no coordinate-inventing stub — an earlier one fabricated deterministic
pseudo-coordinates near Vashon for **any** address string, which is exactly the fabrication an
unresolved location must never receive. `packages/core/src/architecture.test.ts` fails if either name
or a mapping/geocoding/routing dependency reappears in any workspace.

**One narrowing, for farm stand onboarding only** (max, 2026-08-05). `apps/web/lib/address-lookup.ts`
may call the Google Geocoding REST endpoint to offer a **draft pin**, behind
`POST /api/farmer/address-lookup`. What did *not* change is what makes it safe:

- **It is a suggestion, not an answer.** The farmer confirms the spot or taps the map to move it,
  and `listing-step.tsx` submits only a confirmed coordinate. A stand is frequently at the road
  rather than at its mailing address, which only the farmer knows.
- **Off-island results are refused, never shown**, against `ISLAND_BOUNDS` — the single statement of
  where the island is, not a second envelope that could drift from it.
- **Every failure degrades to tapping the map**, the pre-existing behaviour. No result, a malformed
  body, a provider error, or an absent key are one answer with no coordinate; a deployment without
  `GEOCODING_API_KEY` is fully supported.
- **No SDK and no second call site.** It is a `fetch` to a REST endpoint, so the dependency tripwire
  stays armed; the allowlist is one file, so a second caller fails the architecture suite.
- **The key is server-side.** The route reads it from the composition root and returns a coordinate
  and status only. It sits behind the invitation token *and* its own abuse/cost throttle bucket,
  because the call is billed.

Their replacement is arithmetic, not a provider: `packages/core/src/public/proximity.ts` is a pure
module (haversine distance, coordinate validation, destination-link construction) with no network
call, no client, and no injected adapter. It is exported on the browser-safe `@farm-friend/core/
proximity` subpath so the client bundle gets the arithmetic without the barrel's server-side
privacy code. Optional browser geolocation is transient, held only in React state in the customer's
own tab: it is **never persisted, logged, sent in a request, or placed in model context**, because
sorting happens in the browser over a list already delivered. Destination-only Google Maps links
carry the validated coordinate and **no origin parameter**, delegating routing to the customer's
own mapping application. An unresolved location remains an operator task, never a fabricated
coordinate. SMS resolves no arbitrary customer origin at launch.

## Abuse / cost throttle

Public, unauthenticated handlers that perform an **expensive or consequential** action are fronted
by a code-level rate/cost guard keyed by a coarse client signal. Normal public map, listing, filter,
and proximity lookup does neither, is model-free, and is **never artificially capped**. SMS inquiry
uses the SMS sender, consent, frequency, and delivery controls rather than a coarse web-client
signal.

Two such handlers exist at launch: the **QR stock-out form** (F-019), which ingests free text into a
model, and **administrator password login** (F-056). Their budgets are independent so anonymous
stock-out traffic cannot exhaust the admin recovery path.

`createPublicActionThrottle` in
`packages/core/src/public/throttle.ts` is a sliding per-client window over the injected `Clock`; the
composition root constructs the stock-out budget (5 / 60s).
`apps/web/lib/client-signal.ts` derives the bucket key by hashing the **leftmost**
`x-forwarded-for` hop with the deployment salt — so no raw address reaches the throttle map, and
appending a hop cannot buy a fresh budget. The key is a **cost bucket, never identity**: it is not
durable, not an authorization input, and not a customer profile.

For stock-out, the throttle is consulted before the model call and malformed input is rejected before
spending its budget. An absent signal collapses to one shared bucket rather than an exemption.

Password login has a durable Postgres throttle because Cloud Run can scale and restart. It reserves
an account-wide aggregate row first and a coarse-client row second, before Argon2 verification. The
stable lock order serializes claimants; the client budget limits one network and the aggregate limits
distributed guessing. Only salted opaque hashes are stored. Success clears the account row and that
client's row, while other client failures survive. Expired rows are deleted in the existing bounded
retention pass.

The public routes are `GET /api/public/stands` (model-free, unthrottled),
`GET /api/public/contact-card` (model-free and database-free, unthrottled),
`POST /api/public/stock-out` (throttled), and `POST /api/auth/login` (throttled); handlers
live in `apps/web/lib/` because Next.js permits only its own fields as route exports.

`GET /api/public/contact-card` (F-039) serves a `text/vcard` contact card so a customer can save the
SMS number by tapping rather than transcribing it off a sign. It renders ~150 bytes from
**`TELNYX_FROM_NUMBER`** — the same variable the send path reads, never a literal, so the saved
contact cannot drift from the number that actually sends — and its lines **must** be CRLF-delimited
(RFC 6350 §3.2): a bare-LF card returns a healthy 200 and then opens *nothing* on the handset, so the
separator is built with `String.fromCharCode` where no minifier can fold it into raw source bytes
(B-025), and asserted against the **build output** plus the deployed wire rather than by a unit test — and imports neither `appContext` (which
would pull the model package into a public route's module graph) nor `publicReadContext` (there is
nothing to read). It is **unthrottled deliberately**: the response is byte-identical for every
caller, so there is nothing metered to exhaust or enumerate, and the throttle exists for expensive or
consequential actions. **Saving a contact is not consent** — it is device-local, records nothing, and
is emphatically not `JOIN`; the card carries no `NOTE` and the copy names no keyword.

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

Full statements and the "why" live in [CLAUDE.md](../CLAUDE.md) Golden Rules. **An invariant is only
real once a test can fail when it breaks** — a doc sentence, a code comment, or a green check is a
claim, not proof. Sabotage the mechanism and confirm the suite goes red before believing any of
these; that discipline has repeatedly caught guards that were already inert.
