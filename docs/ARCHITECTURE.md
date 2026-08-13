# Farm Friend — System Architecture

The *system* source of truth: package boundaries, deterministic routing, key workflows, provider
seams, and the invariants the code must enforce. The surface-by-surface reference is
[SURFACES.md](SURFACES.md). Product rationale is in [PRODUCT_BRIEF.md](PRODUCT_BRIEF.md); data in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); AI in [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md).

> The **enduring system contract**. No build status — that lives in
> [CURRENT_STATE.md](CURRENT_STATE.md).

## Design stance: the zen desk

Simplicity and elegance are **architectural requirements**, sibling to the invariants:

- **One general mechanism, many consumers** — one confirmation mechanism, one retrieval layer.
  Generalize an existing mechanism before adding a parallel one.
- **Few, narrow seams** — a new seam, entity, or package must earn its place *now*, for a real
  consumer that exists.
- **One small, fixed routing order** — not special cases scattered across handlers.
- **Each concept lives in exactly one place.** When a change makes something redundant, delete it in
  the same change.
- **Complexity must buy down a *named* launch risk.** If a proposed component cannot name the
  invariant it enforces and the failure it prevents, delete it.

**Excluded infrastructure — a settled decision, not an omission.** The approved baseline is one
Next.js application, one Postgres database, the four packages, Telnyx, and one model provider. Farm
Friend therefore has **no** event bus, Kafka, event sourcing, workflow engine, distributed lock,
separate queueing service, microservice, policy engine, DLP or taint-tracking product, general PII
detector, vector database, program-enrollment platform, command DSL, or additional workspace
package. A Postgres inbox/outbox with row locks, one typed projection per seam, one open
confirmation, and one deterministic renderer are what close these invariants. Adding any of the
above requires naming the launch requirement the current shape is incapable of.

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

`core` defines the ports; `db`, `sms`, and `ai` implement them. **`core` imports no other workspace
package** — that is what keeps product rules testable without I/O.
`packages/core/src/architecture.test.ts` enforces this in all three directions.

**One composition root** in `apps/web` constructs the database, model, SMS, and other adapters and
injects them into the authoritative workflows. Runtime configuration folds into that root — there is
no `config` package. Workflow types live in `core`; HTTP validation lives beside its handler — there
is no `contracts` package. There is no launch justification for a `config` or `contracts` package, a
native app, a permanent map package, gleaning artifacts, or tenancy machinery.

## Runtime surfaces

Each surface and the bounds it enforces are in **[SURFACES.md](SURFACES.md)**.

| Surface | Path | Credential |
|---|---|---|
| **Public web** | `/`, `GET /api/public/stands` | none — anonymous, no signup, **structurally model-free** |
| **QR stock-out** | `POST /api/public/stock-out` | none — the one public model-backed handler, behind the throttle |
| **Farmer stand form** (F-040) | `/stand/<token>` + `/settings` | a standing link: no password, no session, never expires — **revocation is the entire safety net** |
| **Farmer onboarding** (F-067) | `/farmer/onboarding/<token>` | a one-use invitation; **the token names the farm** |
| **The migration door** (F-079) | `/farmer/start/<secret>` | the secret is obscurity; **the emailed code gates publishing** |
| **Farmer address lookup** | `POST /api/farmer/address-lookup` | invitation-gated and throttled; the only source of a coordinate |
| **Admin** (F-100) | `/admin/{farms,messages,users}` | one fixed identity + password → hashed durable session |
| **Telnyx webhook** | `/api/sms/webhook` | signature over the exact raw bytes, verified before parsing |
| **Scheduled jobs** | `/api/internal/{kick,cron}` | internal ingress + IAM, plus `DEPLOYMENT_ROLE=worker` |

Two properties hold across all of them: **no surface writes `inventory_revisions` except through
`confirmInventoryPublication`**, and **public discovery reaches no model seam** — the latter enforced
by the public read path's module graph, not by convention.

## SMS ingress and sender ordering

**Ingress order is fixed:** read the exact raw request bytes → verify the Telnyx signature **before
parsing** → normalize the sender → commit a **minimized inbox projection** → acknowledge.

- The projection holds: provider event ID, provider message ID, event type, `occurred_at`,
  sender/contact reference, TTL-bound body where needed, processing state.
- The raw provider envelope and a second raw E.164 are **not stored**.
- The provider event ID is unique; duplicate delivery is a successful no-op.

**Interpretation and delivery never happen inside ingress.** After the inbox commit the webhook
awaits creation of a durable Cloud Task for that sender, then acknowledges. Task creation is bounded
and never allowed to turn a successful ingress into a 5xx; if it fails, the scheduled pass recovers
the committed event. The queue owns immediate work rather than the webhook process: a task survives
the originating container and retries independently — **verified by effect in the deployed database**,
not inferred from a local promise completing.

**Serialization.** Ordinary stateful work is serialized per sender in Postgres: a short transaction
locks the sender row and claims at most one inbox event, and never spans a model or SMS call. That
lock also prevents a task and a concurrent scheduled pass from both claiming the event. An abandoned
claim is recoverable; after external work, finalization re-locks the sender and applies a consequence
only if the claim and relevant state are still current.

**Two independent watermarks:**

| Watermark | Orders | Rule |
|---|---|---|
| Conversation | free text, confirmation tokens | ordered by `(occurred_at, provider_event_id)`; an event older than the sender's accepted watermark cannot mutate newer conversation, confirmation, or publication state — code may ask the sender to resend |
| Consent transition | `STOP`, `START`, `VIGA` | the chronologically later command wins; **`STOP` wins an exact tie** |

Farm Friend deliberately does not reconstruct an arbitrarily reordered conversation. Because the two
are independent, intervening free text cannot make a consent command stale and an older delayed
`START` cannot undo a newer `STOP`.

**Conversation staleness applies only to what mutates conversation state, and the router — not the
worker — decides that** (GL-002). `routeInboundMessage` parses compliance keywords **before** the
staleness gate and applies that gate to free text and confirmation tokens only, so a `STOP` delayed
behind a newer processed message still reaches `applyConsentTransition` and still suppresses later
proactive dispatch. Finalizing such an event as `processed` cannot corrupt ordering:
`claimNextInboundEvent` advances the conversation watermark only for a non-stale event.

## Launch SMS consent

One registered operational SMS program. Each recipient has one current consent state with capture
provenance.

| Keyword | Establishes | Restores after STOP | Notes |
|---|---|---|---|
| `START` | yes | yes | fallback for farmers with older instructions |
| `VIGA` | yes | yes | from the **stated phone**, also redeems its pending invitation |
| `JOIN` | **only with no consent record** | no | B-011 (SMS_COMPLIANCE.md) owns why: only `START` clears the carrier's own opt-out list |

- Inventory prompts, publication confirmations, inquiry replies, and stock-out alerts are **message
  categories inside that program**, not separate enrollments.
- A customer inquiry permits its direct response but creates **no durable consent**. No follow-up
  interest is stored; there is no scoped `MUTE`.
- Every proactive non-required dispatch requires **active** consent. Universal `STOP` applies across
  all Farm Friend messaging.

**One predicate, one place.** `isProactiveSendPermitted` (`packages/core/src/sms/consent.ts`) is a
pure predicate consulted by the dispatch claim in `authorizeDispatch` — no database, no model.

- **Active** consent required: an absent row means the recipient never opted in, and silence is not
  permission.
- `consentTransitionFor` maps `JOIN`/`START`/`VIGA` onto the one program, differing only in recorded
  provenance and in whether an existing record blocks them.
- The first-time rule is enforced by `insert … on conflict do nothing returning` against
  `sms_consents`' primary key — **not** by a read, and not by `for update`, which cannot lock a row
  that does not exist yet.

**One consent writer.** `applyConsentTransition` wraps `applyConsentTransitionIn(tx, …)`, which web
onboarding calls inside its own transaction so invitation redemption and the consent write commit
together. The first-time rule, watermark ordering, and STOP's tie-break are stated once, so every
caller gets all of them.

**Code decides three things about every outbound message; the model decides none:**

1. who may receive it — enforced at the dispatch claim;
2. whether consent permits it — enforced at the dispatch claim;
3. whether it exceeds the recipient's general message-frequency limit — **not yet built**. When a
   cross-category rate cap is set it belongs beside `isProactiveSendPermitted` at the same boundary:
   never in a prompt, never in model output, never as a second consent mechanism.

**Scheduled inventory prompts** carry their narrower per-stand cadence and an exact durable subject,
created at 10:00 AM in the stand's reviewed timezone. At dispatch, code rechecks consent, designated
authority, VIGA approval, preference version and due slot, inventory and closure bases, active
closure, and newer farmer activity before claiming the SMS. Pausing is a scheduling decision, never a
second consent mechanism or the unbuilt rate cap.

**Future programs** require their own disclosed enrollment when approved and built. Launch has no
program discriminator, future-program enrollment row, `JOIN <program>` grammar, or general
program-enrollment mechanism.

## Deterministic routing (code, before any model call)

> **Steps 11–15 are scheduled to change in F-111 Phase 2** — one first-pass request classifier
> replaces the two sender-split intent seams, and step 11's pre-classification stand binding is
> deleted in favour of an access fork that runs *after* classification. **Steps 1–10 do not
> change and must not**: they take the message body and nothing else, which is what makes "no
> stored state can reinterpret a `STOP`" structural rather than conventional. The classifier is
> built and measured but **not yet wired**, so what follows still describes production.
> See `docs/plans/REQUEST_CLASSIFICATION_REFACTOR.md`.

Each verified, accepted inbound SMS is routed by **code, before any model call**, in this fixed
order:

1. **Compliance keywords win** — STOP/START/VIGA/JOIN/HELP and their required variants. `STOP` always
   unsubscribes **globally**, regardless of conversation state, and can never be reinterpreted.
   `START` and `VIGA` establish or restore the one launch-program consent state from any state;
   `VIGA` can also redeem a matching pending farmer invitation. `JOIN` establishes consent only for a
   sender with no record, and otherwise replies naming `START`.
2. **`MAP`** returns only the configured canonical public-map URL. Stateless, model-free, available
   for a delayed carrier event; its inquiry reply is still suppressed at dispatch if STOP has taken
   effect. That URL is stated twice — as deployed configuration and as the core constant customer
   copy embeds — so `resolvePublicMapUrl` refuses to start a non-local deployment where the two
   disagree, rather than letting one surface send a link the others do not (F-110).
3. **`FLAG`** pauses the thread + creates a review item (the human-handoff safety rail). A **Farm
   Friend product safety feature**, not a carrier-mandated keyword.
4. **Live farmer-update confirmation** — a context-bound `YES` or `NO` applying to the sender's one
   open proposal, carrying inventory, owner-only closure/reopening, or both. **Never global**, commits
   **exactly once**, and **expires**. A token must match deterministically and be the **entire
   message**; anything else is free text for the steps below.
5. **Scheduled snapshot confirmation** (F-052) — exact whole-message `SAME` may publish an identical
   inventory revision only for the sender's active, provider-accepted scheduled prompt whose complete
   snapshot was shown. With no such prompt it changes nothing; "same eggs?" continues as free text. It
   never confirms closure or profile data.
6. **Farmer keywords** (F-040/F-051) — `LINK` asks for their private web-form link, `STAND` issues an
   exact numbered target menu, `SETTINGS` opens the settings view through the existing standing link.
   Like `FLAG`, these are **Farm Friend product keywords, never carrier-mandated**, and must never be
   registered as such. They are parsed **last among the keyword branches** so one can never shadow a
   compliance keyword or a commitment token.

   **`JOIN` is the exception that proves the ordering matters.** It IS carrier-registered, and F-080
   gave it an argument grammar. Bare `JOIN` matches first, in the compliance branch, unchanged. The
   token form matches in a **separate, later** branch and **requires** the 64-hex token, so it cannot
   capture the bare word from any position. Both properties are tested.

   **Nothing here grants authority by itself:** the *invitation* is the decision, `LINK` is refused
   unless the sender already holds a live authorization, and what the inbound text supplies is the
   handset — `farmer_authorizations` requires `phone_verified_at`, whose only honest source is a
   message the farmer sent. An invited `JOIN` does establish launch *consent* when its invitation
   carries the web agreement — in the same transaction that redeems the invitation, so the two cannot
   come apart and strand a farmer with a spent invitation and no consent record.
7. **`MORE`** (F-046) returns the next page of the sender's pending result list. Also a Farm Friend
   product keyword, parsed **alongside the farmer keywords at the end** for the same reason. It is
   **context-bound like a confirmation token, never global** — it means nothing without a pending
   list, and must match the **entire message**, so "any more eggs?" stays a question. It is
   deliberately **independent of `YES`/`NO`**: a farmer with an open inventory confirmation can page
   and keep it, because the words do not overlap.
8. **A positive whole-message number** selects only from the sender's live 12-hour `STAND` menu. The
   stored option binds an exact authorization+location pair; without that context it is a
   code-rendered refusal, never free text.
9. **Active conversation state** routes the message to its in-flight flow.
10. **Authority and consent gates** determine what the sender may do.
11. **Whose stand was named decides the branch before authority does** (B-053). Code resolves any
    stand named in the message and checks ownership against `farmer_authorizations`. A sender naming
    a stand that is *not theirs* — authorized farmer or not — is reporting a stock-out, not updating
    a listing. Naming no stand, or naming their own, leaves the branches below unchanged. This can
    only move a message AWAY from publishing inventory, never toward publishing someone else's.

    **Resolution is a ladder, entirely in code** (F-106). First a unique substring match of
    a stand's whole name, with both sides folded to lowercase letters, digits and single spaces so
    punctuation cannot defeat it. Failing that, each stand is scored by how many of its own
    *distinctive* words (excluding corpus-generic ones like "farm") appear in the message, and the
    single highest scorer wins. **Zero matches, or any tie at the top score, asks "Which stand are
    you at?" rather than guessing.** No model participates at any tier.

    **A cold message is matched exactly**, so a misspelled name asks. The one exception is the reply
    to that question (B-065): there a third, edit-distance tier runs, because Farm Friend has already
    asked and the reply is presumed to be an attempt at the answer rather than a new topic. The
    allowance scales with word length — under 5 characters exact only, 5–7 one edit, 8 or more two —
    which is load-bearing rather than tidy: measured against all 36 live stands, a flat allowance of
    two turned "barts" from an exact match into a three-way tie with Bananas Barn and Green Ears.
    The exact tier's verdict is final whenever it matched anything, *including a tie*; a looser
    comparison may never overturn a stricter one's ambiguity. A fuzzy tie still asks.
12. For authorized farmer free text about their own stands, the **farmer-message intent seam** returns
    only `inventory_update`, `farm_stand_question`, or `unclear`. It runs before stand targeting so a
    general question does not create a target menu.
13. `inventory_update` continues through exact stand targeting and the existing proposal flow;
    `farm_stand_question` uses grounded inquiry; `unclear` gets a code-rendered clarification. No
    classification outcome publishes inventory.
14. For everyone else, an **open stock-out clarification is offered the message first** (B-065),
    before the intent seam. Farm Friend asks "Which stand are you at?" or "What was sold out?" and
    holds the original report; the next message from that sender completes it. This must run here
    and not in deterministic routing: steps 1–8 take the body and nothing else, which is what makes
    "no stored state can reinterpret a STOP" structural rather than conventional (Golden Rule #2).

    The check is needed because the answer is *correctly* classified as a question — a bare stand
    name states nothing about stock and names no item — so without the held report the intent seam
    routes it to inquiry, which finds no item and dead-ends. **A reply that resolves no stand at all
    releases the held report** and is handled as an ordinary new message: releasing is recoverable,
    capturing a real question is another dead end.
15. Otherwise the **customer-message intent seam** returns `stock_out_report` or
    `farm_stand_question` (also its fallback). A report records a private signal and prompts the
    stand's own farmer; it never mutates published state — Golden Rule #1.

Farmer update text resolves the sender's durable exact target in code after intent classification.
One live target is selected automatically; several with no selection issue the same numbered menu.
Every use revalidates the authorization and location under the shared sender → location →
authorization lock order. Neither the classifier nor the inventory interpreter receives a target list
or can select or change a target.

A confirmation token is accepted only for the sender's one open farmer-update proposal, after the
current prompt has been accepted by Telnyx, and only when the token's provider occurrence time
follows that activation. Recording Telnyx's acceptance and activating that exact current proposal
version are one database commit after the provider call; either both become durable or neither does.
It must never commit an earlier proposal version.

The parser's keyword tables are derived from the registered 10DLC keyword lists, and a test reads
`docs/TELNYX_10DLC_FIELD_VALUES.txt` to prove the two agree in both directions.

## Confirmation

Launch has **one confirmation mechanism and one consumer**: farmer-update publication.

- A database constraint permits **at most one open proposal per sender**, recording proposal/version,
  expiry, and the outbox prompt that activates it.
- The deterministic parser owns the fixed `YES`/`NO` variants; **proposals store no token vocabulary**.
- New farmer inventory text **revises** that same proposal rather than creating a second one; the
  version change suspends token acceptance until Telnyx accepts the new prompt.
- The structured proposal is a distinct pending payload, **not** a draft inventory revision. `NO` or
  expiry creates no revision. A successful `YES` creates the new revision and entries, makes it
  current, and supersedes the prior one.

**Sections.** A proposal carries inventory, owner-only closure/reopening, or both. Sections keep
independent base revisions but share one confirmation transaction, so a mixed message publishes both
or neither.

**Closure is append-only history, separate from inventory:**

- Closing or reopening never refreshes or clears the inventory revision.
- A bounded closure expires only in the shared read projection — **no timer mutates history**.
- Code renders closure status from kind and local Vashon dates; there is no farmer-authored public
  closure note.
- Before interpretation, code converts the injected clock to the current Vashon calendar date and
  projects that exact value to the model.
- Deterministic preflight resolves exact ranges, "this weekend," seasonal/reopen, and plain
  whole-stand closure **before** any model call; ambiguous, contradictory, sub-operation, and multiple
  windows clarify without a model.
- The model receives typed timing evidence and code rejects any proposed closure that does not match
  it, so **model clock knowledge never commits calendar facts**.

**Patch language in, complete snapshot out.** Farmers speak in edits — add this, drop that, it's all
gone — so the interpreter returns typed edits against the sender's complete pending snapshot when one
is open, and against the current published snapshot otherwise. Code applies the edits to produce the
*complete* pending snapshot the farmer is shown. Existing entries retain their opaque IDs; code
issues opaque draft IDs for new pending entries so a later unconfirmed message can change or remove
them. Omission preserves an item; it never deletes one. `YES` publishes exactly that snapshot, so
there is no durable delta, patch log, or replay mechanism.

**The confirmation names what is LEAVING, after the complete result.** Everything a farmer adds or
changes is visible in the result they are reading; an item they drop is visible only as a gap. So the
rendered confirmation carries a trailing "Taking off: …" line. It is confirmation copy — `entries`
remains the whole authority on what publishes, and no consequence reads the removed names.

**The web editor supplies typed edits directly and never invokes a model.** Its in-stock switch,
quantity, unit, and price fields produce additions, changes, and removals for code to validate
against the retrieved snapshot. Explicit `null` clears a visible optional field; that distinction is
reserved for this direct-editor contract and is not accepted from model output. The structured edit
meets the same composition and exact confirmation gate as SMS interpretation, and cannot express
`clear_all`. Because it names entry IDs, the editor must draw the same base composition uses — the
sender's open proposal when one exists, the published snapshot otherwise.

**One shared lock order:** sender → location → participant/access grant (when used) → proposal →
authorizations → approvals. A revocation locks the same authorization, access, or approval row that
confirmation validates; because it needs only that decision row, it introduces **no reverse lock
edge**, so whichever transaction locks it first defines the honest result without a deadlock.

The confirmation transaction then, in order:

1. verifies the prompt/version and expiry;
2. rechecks current owner authority and VIGA approval under those locks;
3. runs the shared publication boundary over every free-form public string (item name, unit, price
   text) — **refusing the whole proposal** on a phone number, email address, web link, or
   direct-contact instruction. SMS and farmer web render the same deterministic refusal naming what to
   remove; neither silently strips text;
4. conditionally consumes the pending row **once**;
5. queues its response in the outbox.

Proposal creation separately verifies owner authority before persisting an owner-only closure. `NO`
declines without publication; revoked authority or approval produces no publication.

A stock-out alert is informational: it may ask the farmer to send current inventory. That reply enters
the ordinary proposal and `YES`/`NO` flow. `OUT` and `IGNORE` are not commitment tokens and there is
no stock-out pending-action kind.

## Key workflows (code owns the commit; the model only proposes)

Every workflow has **one authoritative core use case and one durable path**:

| Workflow | Authoritative behavior |
|---|---|
| Initial listing data | Validate and seed farms, locations, and approval state — **never inventory or phone numbers** (B-002: a seeded listing fact fabricates a confirmation, a seeded phone fabricates consent); public and SMS views read the same records |
| Farmer onboarding | Verify the phone, associate the farm, capture preferences, record VIGA approval separately |
| SMS ingress | Verify the raw-body signature, commit one minimized provider event, serialize ordinary stateful work per sender, fail closed on stale events |
| Inventory publishing | Maintain one open proposal per sender; after its current prompt is provider-accepted, consume `YES` once only after rechecking farmer authority and VIGA approval, then atomically publish and supersede the prior revision |
| Participant display | Let the location owner save the complete active **Also selling here** name list as structured public metadata; validate names with the shared public-string guard, retire omissions without deletion, expose no item provenance or edit access |
| Customer stock-out | Accept a code-bound location, store a private report, resolve the authorized farmer in code, optionally ask for current inventory; a reply uses the ordinary inventory flow; free-text customer SMS cannot queue an alert; never alter public inventory |
| Customer inquiry | After deterministic routing, obtain model interpretation; code validates it and retrieves typed current facts; for non-empty retrieval the model selects/orders fact IDs; code validates membership, renders the factual reply, and queues it; the direct response creates no later proactive subscription |
| Launch SMS consent | Maintain one launch-program consent state with provenance; `START`, `VIGA`, and documented farmer onboarding establish or restore it, `JOIN` establishes it for first-time senders only (B-011); message categories do not have separate enrollment |
| STOP / START / VIGA / JOIN / HELP | Apply deterministic consent behavior before any other interpretation; universal STOP applies across all Farm Friend messaging; order start-operation commands on their separate provider-time watermark, with STOP winning an exact tie |
| FLAG | Store the concern and expose it to the single-level admin queue |
| Authentication | Issue and consume short-lived credentials once, with replay prevention and rate limiting |
| Provider delivery | Commit business state and unique outbox work together; recheck consent when claiming dispatch, retry only definitive retryable rejection, quarantine ambiguous results, apply delivery events monotonically |
| Retention | Delete expired raw context while preserving only required consent, safety, and audit records |

**External SMS and model calls never occur inside a business database transaction.** The transaction
commits the decision and the outbox entry; workers perform the external operation and record its
outcome.

### Outbound dispatch and recovery

The dispatcher locks the recipient state and one queued outbox row, rechecks consent, and atomically
marks the row `dispatching`. That commit is the STOP linearization point:

- if STOP commits first, every still-queued non-required message is suppressed;
- if dispatch authorization commits first, the request may still reach Telnyx.

Farm Friend does not claim it can recall already authorized work. A definitive retryable rejection may
use a bounded retry policy. A timeout, connection reset, or other result that might have been accepted
is recorded as **ambiguous** and is not automatically resent unless Telnyx provides a separately
verified outbound idempotency facility. `message.sent` and `message.finalized` events advance delivery
state monotonically by provider occurrence time; late events never regress a terminal result.

For an accepted inventory-confirmation prompt, the accepted dispatch result and activation of the
exact proposal/version named by that outbox row commit in the **same** transaction. The provider call
remains outside it. An accepted older prompt or another message category still records its honest
dispatch result but activates no proposal.

**An abandoned authorization is quarantined, never resent or silently dropped** (GL-003). The claim
commits `dispatching` before the body read, redaction, recipient resolution, provider call, and result
recording — all of which can throw, and the process can die outright. Two defenses of different kinds,
because neither substitutes for the other:

- **Per-row isolation in the pass.** A throw is caught around each row, so one poisoned message cannot
  abort the pass and block every other sender's reply. The row is left `dispatching` rather than
  guessed at, and the pass counts it as `failed`.
- **A durable lease.** `recoverAbandonedDispatches` resolves rows stranded past `DISPATCH_LEASE_MS`
  (10 minutes) into **`ambiguous`** — the state that honestly says "we do not know whether the
  provider accepted it." It runs first on each outbound pass, claims with `for update skip locked` so
  concurrent passes partition rather than double-resolve, and resolves the open attempt with
  `error_code = 'dispatch_lease_expired'`.

A killed process runs no catch block, and a lease cannot isolate a row mid-pass. Recovery deliberately
never returns work to `queued`: that would resend a message a real person may already be holding.

## Provider seams

Narrow interfaces so I/O is swappable and tests are hermetic:

- **SMS transport** (`packages/sms`) — send + inbound **webhook signature verification** against the
  exact raw body. Ingress commits the minimized unique inbox projection before acknowledgement and
  does not retain the raw provider envelope. Send accepts only a **redacted** outbound value that has
  passed a code-level guard which normalizes avoidable typographic Unicode and refuses raw phone
  numbers regardless of model output. The package estimates GSM-7 vs. UCS-2 and billable segments,
  and logs cost metrics by recipient hash **without logging message text**.
- **Model provider** (`packages/ai`) — exposes task-specific input variants rather than a generic
  record assembler. Each variant constructs a branded minimal projection; the low-level provider call
  is internal and has no database, repository, provider-thread, or arbitrary-record capability. Its
  output is **untrusted** and schema/evidence-validated before anything acts on it. For customer
  inquiries, code additionally requires selected IDs to belong to the typed retrieved set and renders
  the factual reply itself. Model-authored prose returns only to the same actor whose current task
  text supplied its private context; cross-actor messages are code-rendered from permitted typed
  facts. The configured provider must not train on Farm Friend requests/responses, calls must be
  stateless, request/response logging disabled where supported, and unavoidable retention must have an
  approved documented maximum. See [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) §the trust contract.
- **Clock** — injected time, so recency and expiry are deterministically testable.

Geocoding is **not a permanent provider seam**. There is no `MapProvider` interface and no
coordinate-inventing stub. `packages/core/src/architecture.test.ts` fails if either name or a
mapping/geocoding/routing dependency reappears in any workspace.

**One narrowing, for farm stand onboarding only** (max, 2026-08-05; re-scoped 2026-08-06).
`apps/web/lib/address-lookup.ts` may call the Google Geocoding REST endpoint behind
`POST /api/farmer/address-lookup`. It is the sole source of a stand's coordinate, and an address that
will not resolve is **refused**. That is a deliberate trade: a stand at the road rather than at its
mailing address can no longer be nudged, in exchange for a published point that always corresponds to
the published address. What makes it safe:

- **Off-island results are refused, never shown**, against `ISLAND_BOUNDS` — the single statement of
  where the island is, not a second envelope that could drift from it.
- **No failure yields a coordinate.** No result, a malformed body, a provider error, a thrown request,
  or an absent key are one answer with nothing placed. The module has no path that constructs a
  coordinate from anything but a provider number that passed the bounds check.
- **The farmer sees the point before publishing.** The drawn island is a read-only display, so a
  geocoder placing a Vashon Highway address at the wrong end of the island is something a glance
  catches. Editing the address **clears** the coordinate.
- **A deployment without `GEOCODING_API_KEY` still boots, but cannot create a farm listing.** The form
  says lookup is unavailable and points the farmer at VIGA. F-088 requires every onboarding farm,
  including `contact_only`, to supply a resolved location.
- **No SDK and no second call site.** It is a `fetch` to a REST endpoint, so the dependency tripwire
  stays armed; the allowlist is one file, so a second caller fails the architecture suite — which
  covers `apps/web/app` and `.tsx` components too.
- **The key is server-side.** The route reads it from the composition root and returns a coordinate
  and status only. It sits behind the invitation token *and* its own abuse/cost throttle bucket,
  because the call is billed.

Proximity is arithmetic, not a provider: `packages/core/src/public/proximity.ts` is a pure module
(haversine distance, coordinate validation, destination-link construction) with no network call,
client, or injected adapter. It is exported on the browser-safe `@farm-friend/core/proximity` subpath
so the client bundle gets the arithmetic without the barrel's server-side privacy code. Optional
browser geolocation is transient, held only in React state in the customer's own tab: **never
persisted, logged, sent in a request, or placed in model context**, because sorting happens in the
browser over a list already delivered. Destination-only Google Maps links carry the validated
coordinate and **no origin parameter**. An unresolved location remains an operator task, never a
fabricated coordinate. SMS resolves no arbitrary customer origin at launch.

## Abuse / cost throttle

Public, unauthenticated handlers that perform an **expensive or consequential** action are fronted by
a code-level rate/cost guard keyed by a coarse client signal. Normal public map, listing, filter, and
proximity lookup does neither, is model-free, and is **never artificially capped**. SMS inquiry uses
the SMS sender, consent, frequency, and delivery controls rather than a coarse web-client signal.

Two such handlers exist at launch: the **QR stock-out form** (F-019), which ingests free text into a
model, and **administrator password login** (F-056). Their budgets are independent so anonymous
stock-out traffic cannot exhaust the admin recovery path.

`createPublicActionThrottle` in `packages/core/src/public/throttle.ts` is a sliding per-client window
over the injected `Clock`; the composition root constructs the stock-out budget (5 / 60s).
`apps/web/lib/client-signal.ts` derives the bucket key by hashing the **leftmost** `x-forwarded-for`
hop with the deployment salt — so no raw address reaches the throttle map, and appending a hop cannot
buy a fresh budget. The key is a **cost bucket, never identity**: not durable, not an authorization
input, not a customer profile. For stock-out, the throttle is consulted before the model call and
malformed input is rejected before spending its budget. An absent signal collapses to one shared
bucket rather than an exemption.

Password login has a durable Postgres throttle because Cloud Run can scale and restart. It reserves an
account-wide aggregate row first and a coarse-client row second, before Argon2 verification. The
stable lock order serializes claimants; the client budget limits one network and the aggregate limits
distributed guessing. Only salted opaque hashes are stored. Success clears the account row and that
client's row, while other client failures survive. Expired rows are deleted in the existing bounded
retention pass.

The public routes are `GET /api/public/stands` (model-free, unthrottled), `GET /viga-farm-friend`
(model-free and database-free, unthrottled), `POST /api/public/stock-out`
(throttled), and `POST /api/auth/login` (throttled); handlers live in `apps/web/lib/` because Next.js
permits only its own fields as route exports.

`GET /viga-farm-friend` (F-039) serves a `text/vcard` contact card so a customer can save the
SMS number by tapping rather than transcribing it off a sign. It renders ~150 bytes from
**`TELNYX_FROM_NUMBER`** — the same variable the send path reads, never a literal, so the saved
contact cannot drift from the number that actually sends. Its lines **must** be CRLF-delimited
(RFC 6350 §3.2): a bare-LF card returns a healthy 200 and then opens *nothing* on the handset, so the
separator is built with `String.fromCharCode` where no minifier can fold it into raw source bytes
(B-025), and asserted against the **build output** plus the deployed wire rather than by a unit test.
It imports neither `appContext` (which would pull the model package into a public route's module
graph) nor `publicReadContext`. It is **unthrottled deliberately**: the response is byte-identical for
every caller, so there is nothing metered to exhaust or enumerate. **Saving a contact is not
consent** — it is device-local, records nothing, and is emphatically not `JOIN`; the card carries no
`NOTE` and the copy names no keyword.

The card is reached from **two** surfaces: a link on the public map, and its own SMS message,
queued for every keyword that establishes messaging — `JOIN`, `START`, and `VIGA`. Because it records
nothing, offering it in a reply asks for nothing and changes no consent rule.

**The path is copy, not an address** (B-052). iOS titles a message preview from the URL's last path
segment — it reads neither `Content-Disposition` nor the vCard's `FN`, so a card that was internally
correct still previewed as `contact-card`. The route therefore sits at the top level and names the
contact. `CONTACT_CARD_PATH` states it once and every tap target derives from it. The original
`/api/public/contact-card` is served permanently by a second binding to the same handler: cards
already texted point there, and those threads cannot be edited. Nothing new links to it.

## Invariants (must be enforced in code and proven by tests)

1. The farmer owns published state — no customer action mutates published inventory or ranking.
2. Verified, deduplicated, sender-serialized SMS ingress; deterministic compliance and confirmation
   before any model call; one launch operational SMS program; STOP always global and provider-ordered
   against start-operation commands; no passive customer follow-up or scoped MUTE; exactly one open
   inventory confirmation per sender, context-bound, version-bound, exactly-once, and expiring.
3. The model proposes; code commits. Publication is confirmation-gated.
4. Grounded, recency-labeled answers — the model selects/orders retrieved fact IDs and code renders
   authoritative factual text; unrestricted model prose is not treated as deterministically verifiable.
5. Privacy at the data layer — phones hashed, raw never logged, never in model context.
6. Safety enforced by a static provenance barrier plus runtime enforcement, never the system prompt;
   type/workflow/adversarial tests verify those barriers but are not a third enforcement layer.

Full statements and the "why" live in [CLAUDE.md](../CLAUDE.md) Golden Rules. **An invariant is only
real once a test can fail when it breaks** — a doc sentence, a code comment, or a green check is a
claim, not proof. Sabotage the mechanism and confirm the suite goes red before believing any of these.
