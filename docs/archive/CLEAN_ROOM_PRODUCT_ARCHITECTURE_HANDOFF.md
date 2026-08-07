# Farm Friend Clean-Room Product and Architecture Handoff

**Reference date:** July 24, 2026  
**Repository:** `/Users/max/farm-friend`  
**Audited repository baseline:** clean `main` at `2cb39e4`, including PR #7  
**PM reset commit:** `da7e223` in `/Users/max/pm`

> # ⚠ HISTORICAL RECORD — NOT design authority, NOT current status.
>
> **Retired as the living design authority on 2026-07-28 (GL-031).** This is a **dated record of how
> the clean-room reset was decided** in July 2026, preserved so the *reasoning* behind a settled
> decision can be found. It is frozen: do not update it, do not cite it as a requirement, and do not
> resolve a disagreement in its favor.
>
> **The enduring contract it settled now lives in the documents that own it**, which are current and
> authoritative:
> [PRODUCT_BRIEF.md](PRODUCT_BRIEF.md) (product) · [ARCHITECTURE.md](ARCHITECTURE.md) (system) ·
> [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) (durable data) ·
> [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) (model trust boundary) ·
> [SMS_COMPLIANCE.md](SMS_COMPLIANCE.md) (consent and carrier).
> What is actually **built** is [CURRENT_STATE.md](CURRENT_STATE.md).
>
> **Much of what follows is now false as a description of the repository.** The Phase 3 audit below
> describes code that has since been deleted or built, the refactor proposal has been carried out,
> the "unresolved launch decisions" list has largely been decided, and the session-resumption
> procedure describes a design session that ended. Read it as history, not instruction.

## How the clean-room session was run

*Procedure from July 2026, recorded for provenance. That session is over; this is not a live
workflow.*

1. Read this document before the existing Farm Friend architecture documents.
2. Do not repeat the product discovery or clean-room derivation unless the user changes a settled
   product decision.
3. Read "Approved Phase 4 decisions" below. Use `CLAUDE.md` "Current State & Open Items" for the
   live review boundary and the Farm Friend PM backlog for current item status.
4. In Phase 4, present exactly one finding at a time:
   - cite concrete evidence;
   - explain the product or safety consequence;
   - recommend the smallest coherent correction;
   - state exactly what is kept, changed, consolidated, or deleted;
   - end with exactly one decision or agreement question;
   - wait for explicit agreement;
   - only after agreement, use the PM workflow to create or update the smallest necessary item;
   - synchronize the PM backlog and item file and commit the PM change before continuing.
5. Do not modify application code, schemas, architecture documents, branches, or PRs unless the
   user separately authorizes implementation.

Stable decision ownership: finding 1 is F-013, finding 2 is F-014, finding 3 is F-015, finding 4
is F-016, and finding 5 is F-017. Recipe safety is F-018; the natural-language web-inquiry boundary
is F-019; retrieval ordering clarifies F-013; the inventory-proposal lifecycle clarifies F-014;
keyword grammar clarifies F-012/F-016; and review-state ownership is F-020. Current status lives in
PM rather than this design authority.

## Session interaction rules

- Ask exactly one question per response.
- Ask only questions whose answers materially clarify the product or change the architecture.
- Restate each resulting decision in one or two sentences so the user can correct it.
- Do not batch decisions or findings.
- At each phase transition, summarize what is settled and wait for explicit approval.
- During findings review, present exactly one finding at a time.
- Favor deletion and consolidation over preserving speculative or already-documented machinery.
- Treat code comments, test names, package names, green checks, abstractions, docs, and PM state as
  claims rather than proof.

## Approved Phase 4 decisions

### Finding 1 — grounded factual output and stock-out recipient selection

Approved July 24, 2026:

- Customer inquiry retrieval returns typed authoritative facts with stable identifiers and `asOf`
  values.
- The model may interpret the request and select or order identifiers from that retrieved set. It
  does not author the factual answer.
- Code verifies that every selected identifier belongs to the retrieved set, dereferences the
  authoritative values, and renders names, inventory, recency, and stale warnings. Empty retrieval
  is also code-rendered.
- Comparative language is included only when code can derive the stated comparison from typed
  facts. Farm Friend does not claim that unrestricted model prose is deterministically verifiable.
- A launch stock-out report that can alert a farmer originates only from a web/QR surface carrying
  a code-bound sales-location identifier. A free-text SMS may direct the customer to that reporting
  surface but cannot select a location or queue a farmer alert.
- Code resolves the authorized farmer recipient from the bound location; farmer contact
  identifiers never come from model output.

This decision adds no general natural-language claim verifier, extensible query platform, fixed
semantic strategy catalog, policy engine, package, service, or database.

### Finding 2 — concurrent and out-of-order SMS routing

Approved July 24, 2026:

- Keep the fixed per-message deterministic routing order. Add a minimized durable Postgres inbox
  because that order alone cannot serialize concurrent messages or reject stale events.
- Verify the Telnyx signature against the exact raw request bytes before parsing. After verification,
  store only the permitted inbox projection, uniquely keyed by the provider event ID; do not retain
  the raw provider envelope or another raw phone value. Acknowledge only after that insert commits.
- Claim at most one ordinary stateful inbox event per sender. A short Postgres transaction locks the
  sender, records the claim, and releases before any model or SMS call. The same inbox row is
  recoverable after an abandoned claim; retry never creates another logical event. Finalization
  re-locks the sender and applies a consequence only if the claim and relevant state are still
  current.
- Order stateful inbound events by Telnyx `occurred_at` plus provider event ID. An event older than
  the sender's accepted conversation watermark cannot mutate current conversation, confirmation, or
  publication state; code may ask the sender to resend. This deliberately does not reconstruct an
  arbitrarily reordered conversation.
- Order `STOP` and `START` against a separate consent-transition watermark so intervening free text
  cannot make a consent command stale. The chronologically later command wins; `STOP` wins an exact
  timestamp tie. Thus an older `START` delivered later cannot undo a newer `STOP`.
- Narrow stock-out alert behavior: an alert may ask the farmer to send current inventory, which then
  uses the ordinary inventory proposal and confirmation flow. `OUT` and `IGNORE` are not commitment
  tokens and there is no separate stock-out pending action.
- Permit exactly one open inventory-publication confirmation per sender, enforced by a database
  constraint. It stores the proposal/version, the allowed `YES`/`NO` tokens, expiry, and the prompt
  that activates it. New inventory text revises that one pending proposal rather than opening a
  second confirmation.
- A confirmation becomes live only after Telnyx accepts its current prompt. A token whose provider
  occurrence time does not follow that prompt cannot consume it. The confirmation transaction locks
  the sender and pending row, rechecks current farmer authority and VIGA approval, conditionally
  applies the allowed token once, publishes only for an accepted `YES`, and queues its response in
  the outbox. `NO` consumes and declines the proposal without publication.
- The outbox dispatch claim is STOP's honest linearization point. If STOP commits first, all still
  queued non-required work is suppressed. If dispatch authorization commits first, that request may
  still reach Telnyx; Farm Friend does not claim it can recall already authorized work.
- A definitive retryable rejection may follow a bounded retry policy. A timeout, connection reset,
  or other result that may have been accepted is recorded as ambiguous and is not automatically
  resent unless Telnyx provides a separately verified outbound idempotency facility. Delivery
  webhooks update state monotonically so out-of-order events cannot regress a terminal result.

This decision adds no Kafka, event bus, event sourcing, workflow engine, distributed lock, separate
queueing service, microservice, package, raw-webhook store, second confirmation mechanism, or
exactly-once carrier-delivery claim. External provider calls remain outside database transactions.

### Finding 3 — model privacy boundary and proof terminology

Approved July 24, 2026:

- The safety boundary has two enforcement barriers plus verification, not three enforcement layers:
  a static provenance barrier, runtime enforcement, and a verification suite.
- Branded safe-context and redacted-outbound types prove that ordinary callers used an approved
  constructor. They prove provenance, not runtime content safety.
- Runtime model safety comes from task-specific minimal input projections, an adapter with no
  repository/database/provider-thread capability, schema/evidence validation, and code-rendered
  consequential or cross-actor output. The outbound phone scan remains a named fail-closed
  backstop; it does not prove arbitrary text universally clean.
- The public generic `assembleContext<T>(seam, fields)` target is removed. Each launch seam has an
  explicit permitted projection: the current actor's task text where language interpretation needs
  it, plus only required public facts and opaque identifiers. It receives no raw contact data,
  another actor's text, unrelated thread history, authentication/consent/admin/audit records,
  internal notes, or secrets.
- Farm Friend does not claim universal detection of every email, address, secret, or sensitive
  phrase a sender voluntarily puts in their current task text. Model-authored prose may return only
  to that same actor; cross-actor messages are code-rendered from permitted typed facts and do not
  relay customer free text.
- The single configured model provider must not train on Farm Friend requests/responses; calls are
  stateless with no provider-managed conversation/file/memory/retrieval state; logging is disabled
  where supported; and unavoidable retention has an approved documented maximum compatible with
  Farm Friend's raw-context retention. A model-version change under the same contract is config plus
  evals; changing provider or its data-handling behavior re-runs this privacy gate.
- Type tests, full authoritative workflow tests, and hostile-model evals verify the barriers but do
  not enforce production values. Safety-relevant fixtures must cover accepted ingress through
  projection, hostile output, validation/code rendering, and the resulting outbox work.

This decision adds no general DLP, taint tracking, universal email/address detector, Kafka, event
bus, event sourcing, workflow engine, distributed lock, service, package, or additional provider.
It does not implement F-013 or F-014.

### Finding 4 — one launch SMS program; no passive customer follow-up

Approved July 24, 2026:

- Launch VIGA Farm Friend is one registered operational SMS program, matching the public opt-in and
  campaign description. Inventory prompts, publication confirmations, customer inquiry replies, and
  stock-out alerts are applicable message categories inside that program, not separate consent
  programs.
- `JOIN`, `START`, and documented farmer onboarding establish or restore launch-program consent.
  Farmer onboarding records how, when, and where consent was captured before proactive farmer SMS.
- A customer-initiated inquiry permits its relevant direct reply but does not create durable consent
  for later proactive notifications.
- Remove the optional passive customer follow-up from launch. Consequently, launch has no
  follow-up-interest record and no scoped `MUTE` command.
- Universal `STOP` remains global across all Farm Friend messaging and keeps the approved separate
  provider-time STOP/START ordering and dispatch boundary.
- Any future Farm Friend program requires its own disclosed enrollment when it is approved and built.
  Launch does not pre-create a program discriminator, enrollment rows, command arguments, tables,
  states, packages, or UI for hypothetical future programs.
- F-012 remains the owner of registered `OUT`/`IGNORE`, `STOPALL`, and FLAG campaign-copy drift.

This decision adds no per-category launch consent, general program-enrollment platform, policy
engine, passive-follow-up reply window, second subscription mechanism, Kafka, event bus, event
sourcing, workflow engine, distributed lock, service, package, or additional provider. It does not
implement F-012, F-013, F-014, or F-015.

### Finding 5 — browser-origin proximity; no arbitrary-origin SMS geocoding

Approved July 24, 2026:

- Launch proximity uses optional transient browser geolocation on the public web experience,
  compared deterministically with validated, seeded public sales-location coordinates.
- Directions use destination-only Google Maps links; the customer's mapping application resolves
  its origin and performs routing.
- SMS does not resolve an arbitrary address or current location. An origin-dependent SMS request
  receives an honest code-rendered limitation and a link to the public web map.
- Precise customer origins are not stored, logged, put in model context, or retained as a customer
  preference.
- Sales-location geocoding remains a validated one-time seed/operator concern; unresolved
  locations become operator tasks and never receive invented coordinates.

This decision adds no runtime geocoder, permanent map package, coordinate-inventing stub, mapping
platform, routing engine, travel-time estimator, customer-location record, service, or package.
It is filed as F-017.

### Recipe safety — remove generative recipe assistance

Approved July 24, 2026:

- Phase 1 does not generate meal ideas, recipes, preparation instructions, or food-safety content,
  and it does not retrieve external recipe links.
- A recipe request may still receive code-rendered authoritative availability and recency for
  named ingredients, followed by a code-rendered statement that launch does not provide recipes or
  food-safety guidance.
- The recipe model projection/seam, model permission, launch promise, provider decision, and
  misleading advisory-eval claim are removed.

This decision adds no content-moderation service, safety classifier, policy engine, recipe
database, editorial workflow, runtime search provider, model, service, or package. It is filed as
F-018.

### Natural-language web inquiry — SMS only at launch

Approved July 24, 2026:

- Phase 1 natural-language customer inquiry is SMS-only.
- Public web remains an ungated, model-free map/listing surface with deterministic browsing,
  filtering/search, recency, location facts, and the F-017 browser-origin proximity behavior.
- Web and SMS share authoritative published facts and recency; fact parity does not require
  identical interaction mechanics.
- The anonymous public-model abuse/cost throttle remains for the QR stock-out form, not normal
  public lookup.

This decision adds no model-backed web query field, chat surface, inquiry endpoint, web session,
conversation state, transport framework, service, package, provider, or durable record. It is
filed as F-019.

### Retrieval-ordering clarification — F-013

Approved July 24, 2026:

1. Deterministic SMS routing runs before every model call.
2. The model interprets the current customer request.
3. Code validates the interpretation and retrieves authoritative facts.
4. If retrieval is non-empty, the model selects/orders identifiers from that exact fact set.
5. Code validates membership, renders the factual response, and queues delivery.

`Retrieval-first` means retrieval before grounded fact selection and factual rendering, not before
semantic interpretation. Empty retrieval is code-rendered without a grounded-selection call. This
adds no new seam or model call and is recorded in F-013 rather than a separate item.

### Inventory-proposal lifecycle clarification — F-014

Approved July 24, 2026:

- Unconfirmed structured inventory is a distinct pending proposal payload, not a draft inventory
  revision.
- New inventory text updates the one pending proposal and increments its version.
- `YES` locks and validates the current proposal, rechecks authority and approval, and atomically
  creates one immutable published revision plus entries while superseding the prior current
  revision.
- `NO` and expiry create no inventory revision.
- Full-snapshot versus patch proposal semantics remain a separate unresolved decision; either must
  produce one complete immutable published revision at confirmation.

This adds no draft-revision lifecycle, proposal-history table, second confirmation representation,
generic commitment framework, service, or package. It is recorded in F-014 rather than a separate
item.

### Keyword grammar clarification — F-012 / F-016

Approved July 25, 2026:

- Launch has one fixed whole-normalized-message matcher for deterministic keywords and confirmation
  tokens.
- Bare `JOIN` and `START` establish or restore consent to the one launch operational SMS program.
- Launch has no `JOIN <program>` or other command-plus-argument grammar. Extra text does not become
  an argument and cannot change consent or commit an action.
- F-012 owns alignment of the registered/public campaign copy, Telnyx messaging-profile behavior,
  provider autoresponse handling, parser variants, and tests with the approved fixed keyword set.
- Obsolete `OUT` / `IGNORE` behavior is removed through the already planned campaign/confirmation
  work rather than preserved as another command family.

This adds no command DSL, fuzzy parser, program identifier, program discriminator, future-program
enrollment state, scoped `MUTE`, service, or package.

### Design-authority and live-state ownership — F-020

Approved July 25, 2026. **Superseded 2026-07-28 by GL-031** — the first bullet no longer holds;
authority moved to the owning documents named in the banner above. The rest still holds.

- ~~This handoff remains the single stable design authority.~~ **Superseded:** the handoff is a
  historical record. Each owning document is authoritative for its own domain.
- `CLAUDE.md` "Current State & Open Items" is the sole repository-local live snapshot and names the
  current review/build boundary.
- The Farm Friend PM backlog owns current item status.
- `docs/SESSION_LOG.md` remains dated history; earlier "Next" entries are not rewritten as current
  instructions.
- Mutable current-phase, exact-next-step, and live-PM-status claims do not live in this handoff.

This adds no second authority document, live appendix, status registry, generated-doc system,
service, or package and changes no product or runtime architecture.

## Settled product contract

### 1. Purpose

Farm Friend exists to keep VIGA's farm-stand information current with little or no routine VIGA
data management. It helps people discover what they can buy locally now, while giving farmers an
easy way to own and update their published information.

Six months after launch:

- VIGA board members and volunteers are largely relieved of manual map maintenance.
- A much higher percentage of farm-stand inventory is current.
- Farmers respond to proactive SMS prompts.
- Hundreds of unique customers use Farm Friend monthly.
- People have learned to text Farm Friend with natural requests about foods or preferred stands.
- The public web experience is substantially more useful than the existing embedded Google My Map.

### 2. Primary actors and outcomes

#### Customers

Customers use the public web map or SMS to get the same authoritative published facts. The web
offers model-free map/listing discovery, browser-origin proximity, and destination routing links;
SMS accepts natural-language questions and returns useful grounded matches with honest recency.

A useful answer may be concise rather than conversational:

```text
Provo Farms: potatoes, bok choy (updated yesterday)
Plum Forest: bok choy, strawberry preserves (updated 3 days ago)
```

Farm Friend may also present deterministically derived comparison facts:

```text
Paxton Farms lists both items and updated its stock today;
Plum Forest lists bok choy and updated its stock 3 days ago.
```

Answers must communicate uncertainty and recency honestly. Stale information remains visible with a
prominent warning rather than disappearing.

#### Farmers

Farmers receive proactive SMS prompts and can update inventory and communication frequency by SMS.
They can use a web form instead when they prefer it. The web product also supports profile,
preference, and broader listing changes.

The process must be at least as easy as the current ad-hoc Google Form.

#### VIGA administrators

VIGA initially verifies and approves participating farms. A minimal dashboard supports exceptions,
flags, approval, and requests the system cannot safely handle. There is one administrator level at
launch.

Routine inventory maintenance is not a VIGA responsibility.

### 3. Canonical launch journeys

#### Public discovery

1. A customer opens the ungated VIGA-branded Farm Friend web app, including when embedded on VIGA's
   website.
2. The default view centers on actionable purchase locations.
3. Other farm layers remain prominent and easy to view so farms without stands do not feel omitted.
4. The customer can inspect the same listing and inventory facts available through SMS.
5. With permission, transient browser geolocation may provide approximate straight-line proximity.
6. A destination-only Google Maps link may be offered; Google Maps resolves the origin and route.

#### SMS inquiry

1. A customer texts a free-form need or question.
2. The model interprets the meaning of the request.
3. Deterministic retrieval supplies permitted farm, location, inventory, and recency facts.
4. The model selects or orders identifiers from those retrieved facts.
5. Code validates the identifiers, renders the authoritative factual response and recency, and
   controls delivery.

A request that requires arbitrary-origin proximity receives a code-rendered limitation and public
map link. A recipe request may receive grounded ingredient availability plus a code-rendered scope
statement, but no generated recipe, preparation guidance, or external recipe link.

A customer-initiated inquiry permits its relevant direct response but does not create durable
consent for later proactive notifications. Launch sends no passive customer follow-up.

#### Farmer onboarding and activation

1. A farmer completes simple web onboarding.
2. The farmer verifies control of the SMS number.
3. The farmer provides listing details and communication preferences.
4. VIGA approves the farm for publication.
5. The farmer becomes the authority for subsequent inventory publication.

#### Farmer inventory update

1. Farm Friend requests an update at the farmer's preferred cadence, or the farmer initiates one.
2. The farmer describes stock naturally by SMS or web.
3. The model interprets the message and proposes a structured update.
4. The farmer explicitly confirms it.
5. Deterministic code publishes the confirmed revision.

No inventory update is published without farmer confirmation.

#### Customer stock-out report

1. A customer privately reports from a web/QR surface whose location is bound by code.
2. The report does not affect the map, answers, or ranking.
3. Code resolves the authorized farmer from that bound location and may ask them to send current
   inventory.
4. That reply follows the ordinary inventory proposal and `YES`/`NO` confirmation flow. Only the
   farmer's confirmed inventory revision can change published inventory.

A free-text SMS may direct the customer to the location-bound reporting surface, but it cannot
select a location or queue a farmer alert.

#### Recipe requests

Phase 1 does not generate meal ideas, recipes, preparation instructions, food-safety guidance, or
external recipe links. Farm Friend may answer the grounded ingredient-availability portion of the
request and then states the launch boundary in code-rendered text.

### 4. Operating model and ownership

The guiding metaphor is a helpful VIGA coordinator at a well-organized desk with indexed cabinets of
current, historical, and operational information.

- The language model is the coordinator's interpretive and compositional brain.
- The application is the harness, records, communication channels, and authority system.
- Farmers own their published listings and inventory.
- VIGA controls initial participation approval and exceptional oversight.
- Customers supply questions and private reports, never authoritative inventory.
- The public web app and SMS read from the same published truth.

Deterministic code decides who may receive a message, whether launch-program consent permits it, and
whether it exceeds frequency limits.

### 5. Trust and authority boundaries

The model may:

- interpret language;
- infer search intent;
- propose inventory changes;
- select and rank identifiers from relevant retrieved options;
- draft replies;
- suggest escalation.

Deterministic code owns:

- identity and authority;
- consent;
- one launch-program consent state and universal STOP;
- recipient selection;
- commitments;
- transactions;
- durable writes;
- publication;
- idempotency;
- retention;
- provider operations;
- validation of model-selected identifiers against the retrieved set;
- rendering of authoritative customer-facing factual text from retrieved values.

The system must remain safe when the model is weak, mistaken, manipulated, or hostile.

No business code should hard-code things the model can understand. In particular:

- no farm names in behavioral branches;
- no food vocabulary in behavioral branches;
- no produce taxonomy encoded as application policy;
- no logic such as `if vegetable, then ...`;
- no fixed semantic strategy catalog that prevents the model from understanding an ordinary request.

Actual farms, foods, and listing details are data. The model handles meaning; code controls
consequences. Fixed compliance and authority controls such as STOP, START, HELP, authentication, and
confirmation remain deterministic.

### 6. Privacy

Farm Friend may retain selected lightweight facts such as foods requested or preferred stands. It
must not feel as though it knows the customer's identity in depth.

- Raw message context is short-lived.
- Precise durable home addresses are not part of the customer profile.
- Raw phone numbers and private information are tightly contained.
- Only selected preference and safety records survive raw-context expiration.
- Public farm listings expose stand addresses and farmer-selected web or social links.
- Direct farmer phone numbers and email addresses are not public.
- A farmer may optionally publish a photo or short biography.
- A farm without a public stand chooses an exact, approximate, or hidden map location.

### 7. Launch scope

The full Phase 1 launch is publicly available to all participating farmers and customers for VIGA's
Eat Vashon Week beginning August 8, 2026.

Launch includes:

- public embedded web map and listing experience;
- natural-language customer inquiry by SMS;
- farmer onboarding and VIGA approval;
- farmer inventory updates by SMS and web;
- proactive farmer prompts and preference management;
- explicit farmer confirmation before publication;
- private customer stock-out reporting;
- optional browser-origin approximate proximity and destination routing links;
- one launch operational SMS program, universal STOP, JOIN, START, HELP, and safety escalation;
- minimal single-level VIGA administration;
- read-only payment methods and VIGA Farm Bucks acceptance or eligibility facts.

Explicit non-goals:

- native mobile applications;
- gleaning or volunteer coordination;
- VIGA Farm Bucks claim, redemption, or accounting transactions;
- reservations, ordering, or payment;
- direct customer-to-farmer contact;
- speculative support for multiple organizations.

Gleaning, volunteer coordination, and VIGA Farm Bucks transactions are plausible future Farm Friend
programs. Each future program requires separate enrollment. Universal STOP applies across all Farm
Friend messaging. The architecture should leave clean room for these programs without building their
tables, states, packages, or UI now.

Farm Friend is built for VIGA. Similar organizations may benefit later, but launch is a single VIGA
operation. Do not add speculative tenancy machinery.

### 8. Existing map relationship

The current VIGA page is:

<https://www.vigavashon.org/farm-stand-map>

It embeds a Google My Map containing free-form, largely unfilterable text. This is a greenfield build
with no production-data compatibility or non-destructive migration requirement. Existing content is
reference input, not a schema contract.

Legacy legend reference:

- Blue icon: farm stands open seasonally.
- Green icon: farms with farm stands open year-round.
- Red flower icon: flower-only farm stands that cannot accept VIGA Bucks.
- Red icon: farm with no farm stand.
- Purple icon: VIGA Farmers Market.

The underlying facts remain useful. The new product does not need to preserve the legacy icon system.
The VIGA Farmers Market is a distinct destination type rather than merely another farm-stand color.

### 9. Observable success

- A substantially higher percentage of published inventory is current.
- Farmers regularly respond to prompts and can update without VIGA intervention.
- VIGA performs zero or minimal routine oversight.
- Hundreds of unique customers use Farm Friend each month.
- Web and SMS answers agree because they use the same published data.
- Recency warnings are visible and honest.
- Customer reports never alter inventory without farmer confirmation.
- Consent, privacy, authority, and delivery invariants survive hostile model behavior.

## Approved clean-room architecture baseline

### Architectural verdict

Use one web-based system with four focused packages:

```text
apps/
  web/       UI, HTTP handlers, scheduled jobs, and the single composition root

packages/
  core/      Authoritative workflows, product rules, and narrow ports
  db/        Schema, migrations, repositories, and transaction handling
  sms/       Telnyx adapter, webhook verification, and outbound safeguards
  ai/        Model adapters, task-specific context assembly, and typed selection validation

evals/       Model and adversarial evaluations
```

Dependency direction:

```text
web -> core
web -> db, sms, ai
db, sms, ai -> core
core -> no other package
```

One composition root in `apps/web` constructs the database, model, SMS, and other adapters
and injects them into authoritative workflows.

Runtime surfaces:

- public and embeddable web app;
- farmer account and forms;
- minimal admin dashboard;
- Telnyx webhook;
- scheduled prompting, delivery, retry, and retention jobs.

There is no launch justification for separate `config` or `contracts` packages, an Expo application,
a permanent map package, gleaning artifacts, or tenancy machinery.

### Semantic architecture

The model produces flexible interpretations and proposals from natural language. It is not limited to
hard-coded foods, farm names, semantic categories, or a brittle catalog of request strategies.

Code provides:

- an allowed task-specific context;
- general retrieval operations for SMS inquiry and deterministic geographic operations for the
  model-free public web;
- authoritative records;
- constrained action options;
- typed retrieved facts with stable identifiers and `asOf` values;
- validation of selected identifiers before any consequence;
- deterministic rendering of authoritative factual text.

The model may propose a search or ranking interpretation and select or order identifiers from the
retrieved set. Code executes only permitted operations, rejects identifiers outside that set, and
renders the factual answer from authoritative values. Farm Friend does not attempt to decompose and
verify unrestricted natural-language prose.

### Minimum durable data

- farms and sales locations;
- farmer contacts and authorization;
- VIGA approval;
- structured public listing facts;
- inventory revisions and inventory entries;
- customer stock-out reports;
- minimized provider inbox and message records with limited retention, plus sender processing
  watermarks;
- one current launch-program consent state per recipient, capture provenance, universal STOP, and an
  ordered consent-transition watermark; no program discriminator or future-program enrollment state;
- one open inventory-publication confirmation per sender, carrying the distinct pending proposal
  payload/version; inventory revisions are created only after confirmation;
- flags and admin dispositions;
- transactional outbox;
- minimal audit and model-run evidence.

Do not create tenant, gleaning, volunteer, mobile, or legacy-migration state at launch.

## Phase 3 repository audit

### Overall verdict

The repository is an over-specified foundation with several documented safety claims that executable
code does not enforce. The correct path is destructive consolidation into the approved baseline, not
completion of every existing abstraction.

At the audited baseline:

- unit tests pass 46 of 46;
- typecheck and lint pass;
- critical evals pass 3 of 3;
- advisory evals pass 2 of 2;
- adversarial evals pass 4 of 4;
- three Postgres integration tests are skipped without `DATABASE_URL`.

These checks primarily prove isolated helpers and structural claims, not launch workflows.

### Concrete evidence

- `packages/core/package.json` depends on `ai`, `config`, `contracts`, `db`, and `sms`, reversing the
  claimed dependency direction.
- `apps/web/app/api/sms/webhook/route.ts` parses JSON and echoes a command without webhook signature
  verification, persistence, idempotency, consent application, or dispatch.
- `apps/web/lib/auth.ts` validates an email token but returns an empty role list and a synthetic
  `viga` tenant, with no durable session or database authorization.
- Live AI and Telnyx adapter methods throw "not implemented."
- There is no single composition root.
- There are no committed database migrations.
- The schema contains tenancy, gleaning, migration provenance, roles, and future states but lacks
  several constraints needed to enforce the claimed invariants.
- The stock-out test proves only that a returned object lacks an `inventory` property. It does not
  prove that the end-to-end report workflow cannot change published inventory.
- The generic commitment machine permits affirmative tokens such as `OUT` across unrelated pending
  commitment kinds and has no transactional caller.
- The deterministic command parser and registered 10DLC copy disagree about supported command forms.
- The map stub invents coordinates for arbitrary addresses.
- AI context assembly rejects some detected phone-shaped text but does not implement the broader
  minimization and stripping guarantees claimed by the architecture docs.
- Output validation checks structure but does not prove factual grounding.
- The grounding eval uses a cooperative canned model rather than attempting unsupported invention.
- Adversarial tests exercise helpers rather than an end-to-end hostile-model boundary.

The current documentation describes these intended guarantees as settled and operational:

- `docs/ARCHITECTURE.md`
- `docs/DATA_ARCHITECTURE.md`
- `docs/AI_ARCHITECTURE.md`
- `docs/RUNBOOK.md`
- `docs/ADMIN_OPERATIONS.md`
- `CLAUDE.md`

They are audit evidence, not current design authority.

### Provider requirements that must be enforced

Telnyx's receiving guidance requires verification of webhook signatures and describes prompt
acknowledgement, retries, duplicate events, and possible out-of-order delivery:

- <https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks>
- <https://developers.telnyx.com/docs/messaging/messages/receive-message>

Telnyx's campaign and keyword requirements center on opt-in, opt-out, help, and their confirmation
behavior:

- <https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages>
- <https://support.telnyx.com/en/articles/9940291-10dlc-campaign-compliance-requirements>

FLAG is a Farm Friend product safety feature. It should not be represented as a carrier-mandated
keyword.

## Pointed refactor proposal

### Current-to-target map

| Current area | Target treatment |
|---|---|
| `apps/web` | Replace placeholders with the public product, farmer account, admin dashboard, operational endpoints, jobs, and composition root |
| `apps/mobile` | Delete |
| `packages/config` | Fold runtime configuration into the web composition root |
| `packages/contracts` | Move workflow types into `core`; keep HTTP validation beside handlers |
| `packages/core` | Remove infrastructure dependencies and future-program machinery; make it the owner of authoritative use cases |
| `packages/db` | Replace speculative schema with launch schema, constraints, migrations, repositories, and transactions |
| `packages/sms` | Keep useful segmentation and redaction concepts; implement secure Telnyx ingress, delivery, and consent enforcement |
| `packages/ai` | Replace generic context passing with task-specific safe inputs and evidence-backed output validation |
| map abstractions | Remove the permanent provider seam; retain a one-time seed/import utility and this legacy reference |
| documentation | Rewrite intended safety as requirements until executable proof exists |
| tests and evals | Replace shape checks and cooperative stubs with workflow, transaction, provider, and hostile-model tests |

### Exact deletion and consolidation direction

Delete or remove:

- `apps/mobile`;
- `packages/config`;
- `packages/contracts`;
- launch tenancy;
- gleaning tables and `gleaning_signup` commitment machinery;
- legacy-map migration provenance and claim states;
- the coordinate-inventing map stub;
- multi-level administrator and staff roles;
- generic abstractions with only one real consumer;
- throwing provider implementations presented as operational;
- documentation that describes unimplemented guarantees as facts.

Keep and refine:

- SMS segment calculation;
- phone normalization and hashing;
- time abstraction where time controls product behavior;
- schema-based model-output validation;
- the distinction between model proposals and deterministic commitments;
- legacy map facts as reference input.

### Initial database migration

Create a clean launch migration containing only the minimum durable records described above.

Database constraints must enforce:

- unique provider-event acceptance and processing;
- one claimed ordinary stateful inbox event per sender;
- one open inventory-publication confirmation per sender;
- one currently published inventory revision per sales location;
- farmer authority over inventory publication;
- universal STOP before outbox dispatch authorization;
- unique outbox work and bounded dispatch-attempt states;
- bounded valid states and transitions;
- separation between private customer reports and published inventory.

### Workflow and transaction ownership

Every workflow has one authoritative core use case and one durable path.

| Workflow | Authoritative behavior |
|---|---|
| Initial map data | Validate and seed farms, locations, listing facts, and approval state; public and SMS views read the same records |
| Farmer onboarding | Verify the phone, associate the farm, capture preferences, and record VIGA approval separately |
| SMS ingress | Verify the raw-body signature, commit a minimized unique inbox event, serialize ordinary stateful work per sender, and fail closed on stale events |
| Inventory publishing | Maintain one open proposal per sender; after the current prompt is provider-accepted, consume `YES` once only after rechecking farmer authority and VIGA approval, then atomically publish and supersede the prior revision |
| Customer stock-out | Accept a code-bound web/QR location, store a private report, resolve the authorized farmer in code, and optionally ask for current inventory; a reply uses the ordinary inventory proposal/confirmation flow; free-text customer SMS cannot queue an alert; never alter public inventory |
| Customer inquiry | After deterministic SMS routing, obtain model interpretation of the current request; code validates it and retrieves typed current facts; for non-empty retrieval the model selects/orders fact IDs; code validates membership, renders the factual reply, and queues it |
| Launch SMS consent | Maintain one launch-program consent state with capture provenance; `JOIN`, `START`, and documented farmer onboarding establish it; a customer-initiated inquiry permits only its relevant direct reply and creates no proactive subscription |
| STOP, START, JOIN, HELP | Apply deterministic consent behavior before other interpretation; universal STOP applies across all Farm Friend messaging; order STOP/START on their separate provider-time watermark, with STOP winning an exact tie |
| FLAG | Store the concern and expose it to the single-level admin queue |
| Authentication | Issue and consume short-lived credentials once, with replay prevention and rate limiting |
| Provider delivery | Commit business state and unique outbox work together; recheck consent when atomically claiming dispatch; retry only definitive retryable rejection, quarantine ambiguous results, and apply delivery webhooks monotonically |
| Retention | Delete expired raw context while preserving only required consent, safety, and audit records |

External SMS and model calls do not occur inside business database transactions. The transaction
commits the decision and outbox work; workers perform external operations and record their outcome.

### Required test and eval corrections

- Run migrations from an empty Postgres database in CI.
- Exercise complete use cases with real database constraints and transactions.
- Prove concurrent and duplicate farmer confirmations publish only once and only while current
  authority and VIGA approval still hold.
- Prove customer reports cannot change public availability or ranking.
- Prove stock-out alerts create no `OUT`/`IGNORE` commitment path and instead feed the ordinary
  inventory update flow.
- Prove STOP suppresses queued and future non-required messages when it commits before dispatch
  authorization, and document the inverse race honestly.
- Prove launch message categories share one consent enrollment; farmer onboarding records consent
  provenance before proactive SMS; a customer inquiry permits its relevant direct response without
  creating a later proactive subscription; and no follow-up-interest or `MUTE` path exists.
- Test raw-body webhook signature verification, minimized durable acceptance, duplicate no-op,
  sender-level concurrency, stale-event rejection, and separate STOP/START ordering.
- Test rollback, abandoned inbox-claim recovery, bounded outbox recovery, ambiguous-send quarantine,
  and monotonic out-of-order delivery status.
- Test farmer authorization and VIGA approval.
- Test authentication expiry, replay prevention, and rate limiting.
- Test retention and deletion of raw context.
- Prove raw phones, other actors' messages, unrelated history, contact/auth/consent/admin/audit
  data, internal notes, and secrets are absent from model projections and logs.
- Prove model-authored prose returns only to the actor whose current text supplied its private
  context; cross-actor outbox work is code-rendered and does not relay customer free text.
- Capture the provider context and resulting outbox work through full authoritative workflows with
  hostile outputs; type tests and helper fixtures alone are not enforcement proof.
- Verify the selected provider's no-training, stateless-call, logging, and bounded-retention
  configuration before live use and whenever provider data handling changes.
- Use hostile models that invent farms, inventory, recency, directions, or commitments.
- Reject structurally valid selections containing identifiers outside the retrieved set.
- Prove the final factual response is rendered only from the selected authoritative facts.
- Prove a free-text SMS stock-out report cannot select a location or queue a farmer alert.
- Add real provider contract tests.
- Delete tenancy and gleaning tests.
- Replace returned-object shape tests with tests of published product state.

### Safe refactor order

1. Align the product configuration, documentation, and PM baseline with the approved product
   contract.
2. Delete deferred packages and correct dependency direction.
3. Establish the launch schema, initial migration, repositories, transactions, and outbox.
4. Build secure SMS ingress, deterministic command handling, consent, and reliable delivery.
5. Build farmer verification, onboarding, VIGA approval, and minimal admin.
6. Build the shared inventory proposal and confirmation workflow for web and SMS.
7. Build the public map and listing experience from the same source of truth.
8. Add grounded SMS customer inquiry.
9. Add private stock-out reports, FLAG, and retention.
10. Complete provider, adversarial, operational, and launch-readiness testing.

## Unresolved launch decisions

These do not change the target architecture and can be resolved when the associated finding reaches
them:

- exact farmer and admin sign-in experience;
- raw-message retention period;
- freshness warning thresholds;
- proactive farmer-prompt timing and rate caps;
- initial listing-data entry process;
- full-snapshot versus patch semantics for farmer inventory proposals;
- final model, one-time seed-geocoding, and image providers;
- verification that the registered 10DLC campaign and public compliance pages match the one launch
  operational program, universal STOP, and the approved launch keyword set.

## Proposed finding-review sequence

This ordering is a guide, not prior approval of any finding:

1. Replace the stale declared product and architecture baseline.
2. Correct package boundaries, dependency direction, and composition ownership.
3. Replace the speculative schema with launch entities, migrations, and enforced constraints.
4. Establish one authoritative transaction and outbox path per workflow.
5. Rebuild SMS ingress, consent, provider delivery, idempotency, and recovery.
6. Establish farmer verification, authorization, onboarding, and VIGA approval.
7. Make inventory publication and the public map one farmer-controlled source of truth.
8. Establish the model-semantic and grounded-answer boundary.
9. Add private reports, FLAG, administration, and retention.
10. Replace overstated tests and evals with launch-invariant proof.

Do not combine findings merely because they affect the same package. Combine only work that forms one
inseparable correction with one owner and one acceptance boundary.
