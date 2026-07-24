# Farm Friend — Independent Architecture Audit Handoff

**Date:** July 24, 2026  
**Branch audited:** `f-011-baseline-reset`  
**Audited commit:** `ea763eb`  
**Purpose:** preserve the independent review of the clean-room reset so it can be adjudicated in
a fresh session.

> **Status: review input, not design authority.**
> [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md) remains
> the settled contract. This document records findings and proposed corrections. A recommendation
> here changes the contract only after explicit review and agreement.
>
> No application code, schema, PM item, or settled architecture decision was changed as part of
> this audit.

## Executive verdict

The reset is directionally sound. It correctly deletes speculative tenancy, legacy-migration
provenance, gleaning, the native app, multi-level roles, and packages without a launch consumer.
Most rewritten documents also now distinguish target requirements from current executable facts.

The product boundary is clear enough to build a happy path. It is not yet precise enough to build
the claimed hostile-model, consent, commitment, privacy, grounding, and delivery guarantees
without consequential invention by the implementer.

The largest risk is not missing machinery. It is describing an invariant without defining a
small mechanism capable of enforcing it.

## The spiral-staircase constraint

Farm Friend needs a **spiral staircase, not a rocketship**. The underlying steps may be carefully
engineered, but the overall system must remain small enough for one competent engineer to hold in
their head.

Apply this filter to every finding:

1. **First ask whether the product promise can be narrowed without harming the north star.**
   Removing a marginal promise is better than building a general safety platform for it.
2. **If a mechanism is required, build the smallest one that directly closes the invariant.**
   Prefer one table constraint, one typed projection, one row lock, or one deterministic renderer
   over a framework.
3. **Use the existing system shape.** One Next.js application, one Postgres database, the four
   approved packages, Telnyx, and one model provider are enough. Do not add an event bus, workflow
   engine, policy engine, DLP product, vector database, microservice, or new package unless a
   concrete launch requirement makes the existing shape incapable.
4. **Do not generalize future programs into launch.** A current flow may parameterize an existing
   mechanism; it does not justify a future-program platform.
5. **Make guarantees structural where possible.** The smallest safe design is usually easier to
   reason about than a flexible design followed by a sophisticated validator.
6. **Complexity must buy down a named launch risk.** If a proposed component cannot name the
   invariant and failure it prevents, delete it.

Practical defaults for reviewing the findings:

- Grounded answers: prefer typed retrieved facts plus code-rendered factual fragments over a
  general natural-language claim-verification system.
- SMS concurrency: prefer a Postgres inbox/outbox, row locks, and one live pending confirmation
  over Kafka, distributed workflows, or an event-sourcing framework.
- Privacy: prefer seam-specific input projections over a generic PII-detection framework.
- Consent: prefer one launch operational SMS program plus universal STOP over a general program
  enrollment platform.
- Proximity: either narrow the promise or add one small origin-resolution port; do not restore a
  map package.
- Recipe risk: narrow or remove generative behavior before building a broad content-safety stack.

These defaults are audit recommendations, not yet settled design.

## Ranked findings

### 1. Grounding and recipient selection have no enforceable output protocol

**Classification:** wrong specification claim + unresolved mechanism + code drift.

The contract requires code to reject every factual claim that cannot be traced to retrieved
evidence:

- [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) "Semantic architecture"
- [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) "Untrusted-output validation"

It never defines the representation of a claim, the granularity of evidence, permitted derived
claims, or how arbitrary model prose is deterministically decomposed and checked. The current
`generateValidated` implementation performs JSON/schema validation only. The grounding eval uses
a cooperative empty answer with no evidence identifiers.

The same gap affects recipient selection. The model parses which location a stock-out report
concerns, while code is said to own recipient selection. Mapping a hostile model's chosen
location to that farm's authorized contact is still indirect model control over the recipient.
Existence of the location is not evidence that the customer meant it.

**Consequence:** a hostile but structurally valid output can invent availability, recency,
comparisons, or directions, or route a customer report to the wrong farmer.

**Smallest correction to review:**

- Define a small generic query algebra in `core`; it is an execution grammar, not a closed catalog
  of customer meanings.
- Retrieval returns typed immutable facts with evidence IDs and `asOf` values.
- The model selects/orders facts; code renders authoritative factual fragments and recency.
- Do not attempt a general deterministic verifier for unrestricted natural-language prose.
- QR reports bind the location in code. An SMS-derived location must be unambiguous under a
  deterministic rule or explicitly confirmed before a farmer alert is queued.

If this makes answers too constrained, narrow the grounding guarantee. Do not retain both
unrestricted composition and a claim of deterministic verification.

### 2. SMS routing orders one handler, not concurrent or out-of-order events

**Classification:** unresolved architecture + wrong current code.

The fixed routing order is clear, but no document specifies:

- concurrent messages from one sender;
- provider events arriving out of order;
- overlapping inventory and stock-out confirmations;
- consent or authority changing between proposal and confirmation;
- STOP racing an already-claimed outbound send;
- recovery after an outbound request with an ambiguous provider result.

Generic `YES`/`NO`/`OUT`/`IGNORE` tokens are claimed to be action-bound, but there is no rule that
only one confirmation may be live. Current code accepts `OUT` for a publish action and accepts an
affirmative token across pending kinds.

Telnyx documents duplicate, concurrent, and out-of-order webhooks and requires signature
verification against the raw body:

- <https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks>

**Consequence:** an older `START` may undo a newer `STOP`, `YES` may commit the wrong overlapping
action, revoked authority may still publish, or an ambiguous retry may send twice.

**Smallest correction to review:**

- Use a durable Postgres inbox keyed by the provider event/message ID.
- Verify and durably accept the raw webhook before acknowledging it.
- Serialize state transitions per sender with a row lock or equivalent Postgres mechanism.
- Permit one live pending confirmation per sender and store its allowed tokens.
- Recheck farmer authority and VIGA approval in the confirmation transaction.
- Define STOP's linearization point and the actual guarantee for already dispatch-authorized work.
- Define an at-most-once-biased recovery policy for ambiguous provider sends unless Telnyx exposes
  a usable outbound idempotency facility.

No separate queueing service or workflow engine is justified.

### 3. The three-layer boundary is two enforcement layers plus verification

**Classification:** wrong terminology/proof claim + code drift + unresolved privacy boundary.

The compile layer is correctly limited to provenance. The architecture then calls runtime
scrubbing proof of clean content and calls adversarial evals a third code-enforced guard.

Evals are verification, not runtime enforcement. Passing finite fixtures cannot block an unsafe
runtime value.

The current generic assembler accepts arbitrary objects and rejects only some phone-shaped text
and a small key-name blacklist. It permits private emails, addresses, unrelated thread history,
and other sensitive values. The outbound redactor checks only a class of North-American phone
formats. The adversarial fixtures invoke isolated helpers, not a hostile model through the full
workflow.

**Consequence:** a developer can satisfy the branded types and current evals while sending
over-broad private context to a model or leaking private non-phone content in a reply.

**Smallest correction to review:**

- Rename the layers to **type provenance barrier / runtime enforcement / verification suite**.
- Replace the public generic assembler with seam-specific constructors over explicit projections.
- Do not give the model adapter a capability to load arbitrary records.
- Define which sensitive data classes each seam may receive.
- Specify provider retention/training/logging requirements.
- Exercise the full ingress-to-outbox path with hostile outputs.

Do not build a general DLP or taint-analysis platform.

### 4. Consent has three incompatible meanings

**Classification:** internal contradiction.

The handoff and data architecture reserve separate program enrollment for future programs.
`SMS_COMPLIANCE.md` instead says inventory publication and stock-out alerts are separate programs,
each requiring its own enrollment. The submitted/public-facing campaign copy treats `JOIN` as one
opt-in to the whole launch operational service.

The passive customer follow-up is also disclosed with `MUTE`, but the docs do not decide whether
it is part of the customer's initiated exchange or a later proactive message requiring express
consent.

**Consequence:** implementations can be compliant with different documents while either blocking
ordinary launch messages or sending a follow-up without the consent basis the data model claims.

**Smallest correction to review:**

- Treat launch Farm Friend as one registered operational SMS program.
- `JOIN` and `START` establish launch-program enrollment; inventory prompts and stock-out alerts
  are message categories, not separate programs.
- Universal STOP remains global.
- Future programs require distinct enrollment when they actually exist.
- Require affirmative customer consent for a passive follow-up, or define and externally verify
  the narrow reply window that permits it. `MUTE` is not proof of prior consent.

### 5. Deleting runtime geocoding removed a stated launch capability

**Classification:** wrong deletion rationale unless product scope is narrowed.

The product promises distance-oriented questions and directions. Inquiry interpretation accepts an
optional origin and retrieval returns distance. The system architecture then says geocoding is
only a one-time seeding concern.

Browser geolocation covers web use and a Google Maps link can defer routing, but neither answers an
SMS such as "what is closest to 123 Main Street?"

**Consequence:** an implementer must silently drop origin-aware SMS queries, invent an unapproved
runtime provider, or trust the model's geography.

**Smallest correction to review:**

- Preferred if acceptable: narrow launch to browser-origin distance and destination routing links.
- Otherwise add one narrow `OriginResolver`/`Geocoder` port in `core`, implemented at the web
  composition root, with transient treatment of precise customer origins.

Do not restore the old map package or coordinate-inventing stub.

## Other contradictions to resolve

### Recipe safety

The product says Farm Friend does not create an authoritative full recipe. The AI architecture
makes medical, preservation, foraging, and food-safety limits prompt-only advisory quality, while
also saying a model swap never requires a safety review.

Smallest options: restrict the model to meal ideas and code-selected vetted links; remove recipe
generation from launch; or narrow the hostile-model theorem and explicitly require a content-safety
review. Do not create a general content-moderation subsystem merely to preserve a marginal feature.

### Natural-language web inquiry

`PRODUCT_BRIEF.md` adds "SMS and web" natural-language inquiry. The authoritative handoff launch
scope specifies natural-language inquiry by SMS and public web map/listing discovery. The product
brief should lose "and web" unless this is deliberately added to launch.

### Retrieval ordering

`AI_ARCHITECTURE.md` labels retrieval as occurring "before any model call," then correctly describes
model interpretation followed by code retrieval. The heading should say "after interpretation,
before composition."

### Inventory proposal lifecycle

`DATA_ARCHITECTURE.md` defines a revision as a published version. `ARCHITECTURE.md` says a proposed
revision is stored before confirmation. Decide whether the proposal is a draft revision or a
distinct pending payload.

### Keyword grammar

`SMS_COMPLIANCE.md` says every keyword matches the entire normalized message, then defines
`JOIN <program>`. Define bare-keyword matching separately from command-plus-argument grammar.

### Design authority versus stale session state

The handoff remains design authority but also contains stale statements that Phase 4 has not begun
and no findings exist. Separate the settled contract from its dated audit/resume appendix, or
update the operational state without changing the contract.

## Guarantees still asserted as executable fact

The rewrite mostly succeeds in demoting unproven behavior to requirements. Exceptions:

- `SMS_COMPLIANCE.md` has no status banner and says STOP, FLAG, and routing operate today.
- `RUNBOOK.md` says typecheck proves "the safety boundary," rather than only the type-provenance
  barrier.
- `packages/ai/src/assembler.ts` and `packages/sms/src/redaction.ts` claim their narrow scans prove
  content clean.
- `packages/core/src/farmstand/stockout.ts` calls an output-shape restriction the tested guarantee.
- `evals/run.ts` calls isolated helper fixtures structural proof of hostile-model containment.

The docs/comments should change immediately; these are false descriptions of current proof, not
future requirements.

## Doc-versus-code drift

The following target/code differences are already acknowledged and the **code should change**:

- tenancy, legacy provenance, gleaning, multi-level roles, Expo, `config`, `contracts`, and the map
  stub remain;
- `core` imports other workspace packages;
- no composition root or committed migrations exist;
- the schema lacks the target approval, outbox, publication, consent, and uniqueness constraints;
- the live model and SMS adapters throw;
- the webhook does not verify, persist, deduplicate, apply consent, or dispatch;
- authentication has no durable session or authorization.

Additional active contradictions:

- `MUTE` and `JOIN <program>` parse as free text;
- `OUT` can commit a publish pending action;
- the campaign's `STOPALL` is not recognized;
- `SmsTransport.send` accepts a phone hash that cannot be dialed, while the target says only the
  outbound send capability may resolve raw E.164;
- auth and `.env.example` fall back to known development secrets;
- `.env.example` still advertises `MAP_PROVIDER` and lacks the Telnyx public verification key named
  by the runbook.

## Genuinely unresolved decisions

These are load-bearing and are not answered by another current document:

- full-snapshot versus patch semantics for farmer inventory updates;
- the generic query algebra and grounded-response representation;
- conversation concurrency, stale-event handling, pending-action overlap, and delivery
  linearization;
- authority revocation, multiple authorized farmers, phone reassignment, and approval rechecks;
- exact/approximate/hidden public-location projections across web, SMS, directions, and model
  context;
- whether customer report text is ever exposed to a farmer, rather than only sanitized structured
  facts;
- which database mechanisms enforce cross-record authority and publication invariants;
- model-provider privacy, retention, training, and request logging;
- audit reproducibility after raw context expires or prompts/models change;
- the enforceable boundary, if any, for generated recipe content.

Already explicitly unresolved, rather than missing: exact sign-in UX, raw-message retention period,
freshness thresholds, message timing/rate caps, initial data entry, final providers, and registered
campaign alignment.

Already settled, rather than unresolved: single-VIGA scope, greenfield seeding, no legacy
provenance, one admin level, no native app/gleaning/transactional Farm Bucks, package direction,
and the four-package layout.

## Deletion and over-specification verdict

Do **not** restore tenancy, legacy migration provenance, gleaning, the native app, multi-level
roles, or the `config`/`contracts` packages. None closes a current launch invariant.

The only deleted capability that presently meets the restoration burden is runtime origin
resolution, and only if origin-aware SMS proximity remains a launch promise. Restore a function,
not a subsystem.

The "message classification" AI seam has no defined consumer or safe consequence. Delete it until
a launch workflow proves it is needed.

The repeated zen-desk metaphor and "best regardless of effort" rule are taste and process guidance,
not correctness defects. They should not override scope, opportunity cost, or the spiral-staircase
constraint.

## Buildability verdict

A newcomer can build the visible product shape but cannot yet build the intended safety properties
without inventing important behavior. The most likely mistakes are:

- treating model-supplied evidence IDs as proof of grounding;
- allowing a model-selected location to choose a farmer recipient;
- assuming an outbox gives exactly-once SMS delivery;
- processing webhook arrival order as conversation order;
- allowing overlapping generic confirmation contexts;
- modeling launch message categories as separate consent programs;
- treating a generic regex scrubber as data minimization;
- silently dropping origin-aware SMS behavior;
- arbitrarily choosing patch or snapshot inventory semantics;
- implementing cross-record invariants only as application conventions.

## Verified repository state

On `f-011-baseline-reset` at `ea763eb`:

- `npm test`: 46/46 across 10 files;
- `npm run typecheck`: pass;
- `npm run lint`: pass;
- `npm run evals`: critical 3/3, advisory 2/2, adversarial 4/4;
- `npm run test:integration`: 3/3 skipped without `DATABASE_URL`.

These checks prove isolated helpers and type structure, not launch workflows or the guarantees
reviewed above.

## Recommended continuation

Review exactly one finding at a time. For each:

1. Restate the product risk in one sentence.
2. Ask whether narrowing the promise would still satisfy the product.
3. If not, propose the smallest mechanism in the existing application/Postgres shape.
4. State what is deleted or explicitly not introduced.
5. Update the settled docs and PM only after agreement.

Start with finding 1, but do not turn it into a generic claim-verification framework. The decision
to seek is whether authoritative factual text will be code-rendered from retrieved facts, or whether
the contract's deterministic-grounding guarantee should be narrowed.

## Fresh-session prompt

```text
You are continuing the Farm Friend clean-room architecture review.

Repo: /Users/max/farm-friend
Branch: f-011-baseline-reset (not main)

Read, in order:
1. CLAUDE.md
2. docs/CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md
3. docs/ARCHITECTURE_AUDIT_HANDOFF_2026-07-24.md
4. The architecture documents cited by the specific finding under review

The clean-room handoff remains design authority. The independent audit handoff is review input:
none of its recommendations is settled until I explicitly agree.

Central concern: do not over-architect this product. Farm Friend needs a spiral staircase, not a
rocketship. The mechanisms may be sophisticated where a safety invariant requires it, but the
system should remain one Next.js app, one Postgres database, the four approved packages, Telnyx,
and a model provider. Do not introduce an event bus, workflow engine, policy engine, DLP platform,
vector database, microservice, or new package unless the existing shape is demonstrably incapable
of satisfying a concrete launch requirement.

Review exactly one audit finding at a time. For each finding:
- distinguish WRONG from UNRESOLVED from CODE DRIFT from TASTE;
- state the concrete product/safety consequence;
- first ask whether narrowing or deleting the marginal product promise would preserve the north
  star;
- if a mechanism is necessary, propose the smallest mechanism that directly closes the invariant;
- state what the correction deliberately does not introduce;
- cite the exact repo passages;
- end with one decision question and wait for my answer.

Do not repeat the audit from scratch. Do not modify code, settled architecture docs, schemas, PM
state, branches, or PRs until I approve the specific correction. After approval, update only the
smallest coherent documentation/PM scope required by that decision.

Start with ranked finding 1: grounding and recipient selection have no enforceable output protocol.
Do not propose a general natural-language claim-verification framework. Help me decide between:
(a) code-rendering authoritative factual fragments from typed retrieved facts while the model
selects/orders them, or
(b) narrowing the deterministic-grounding guarantee/product behavior further.
```
