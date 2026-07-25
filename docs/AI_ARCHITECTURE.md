# Farm Friend — AI Architecture

The *AI* source of truth: the trust contract, the model provider seam, the seam catalog, the line
between what the model does and what code owns, the **static/runtime safety boundary plus
verification**, validation, evals, and data minimization. Data shapes are in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); routing is in [ARCHITECTURE.md](ARCHITECTURE.md).

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract; where this doc disagrees, the handoff wins.
>
> **Status: requirements, not claims.** The live model adapter throws; the current public generic
> assembler accepts arbitrary objects and rejects only some detected phone-shaped text and key
> names rather than implementing the task-specific projections described here;
> output validation checks structure but does not yet enforce selected-ID membership or feed a
> code renderer; the grounding eval uses a cooperative canned model rather than one attempting
> unsupported selection; and the
> adversarial tests exercise helpers rather than an end-to-end hostile-model boundary. Everything
> below is a **requirement awaiting executable proof**.

## The trust contract — an LLM-brain in a harness

The coordinator is an **LLM-brain in a harness**. The brain is **swappable by design**, so the
architecture never *vouches for* a model — it **measures** one (evals) and **contains** one (the
harness: deterministic routing, confirmation gates, code-owned retrieval, the safety boundary,
output validation). The contract:

- **Trusted for quality, never for authority.** Competence — extraction accuracy, interpretation,
  phrasing, composition — is *quality*: it may vary by brain, and evals price it. Everything on the
  "never" side of the model-vs-code line below is *authority*: harness-owned, identical under every
  brain, including a hostile one.
- **The swap test — apply it to every feature and architectural decision.** *If the model were
  swapped tomorrow for a weaker or adversarial one, which properties survive unchanged?* Every
  property that must survive (farmer ownership, compliance, grounding, privacy, commitment) must be
  a harness property. If a guarantee would move with the model, the design is wrong — move it into
  code.
- **A model-version swap under the same approved provider data-handling contract is a config change
  plus an eval run, not a new model-behavior safety design.** Changing provider or changing its
  logging, training, retention, or stateful-storage behavior must re-pass the provider privacy gate.

**The system must remain safe when the model is weak, mistaken, manipulated, or hostile.**

## Semantic architecture — the model handles meaning, code controls consequences

The model produces flexible interpretations and proposals from natural language. It is **not
limited to hard-coded foods, farm names, semantic categories, or a brittle catalog of request
strategies**.

**No business code hard-codes what the model can understand.** In particular:

- no farm names in behavioral branches;
- no food vocabulary in behavioral branches;
- no produce taxonomy encoded as application policy;
- no logic of the form `if vegetable, then …`;
- **no fixed semantic strategy catalog** that prevents the model from understanding an ordinary
  request.

Actual farms, foods, and listing details are **data**. Fixed compliance and authority controls —
STOP, START, HELP, authentication, confirmation — remain **deterministic**.

Code provides: an allowed task-specific context; general retrieval operations;
authoritative records; constrained action options; typed retrieved facts with stable identifiers
and `asOf` values; selected-ID validation; and deterministic rendering before any consequence. The
model may propose a search or ranking **interpretation** and select or order identifiers from the
retrieved set. Code executes only permitted operations, rejects identifiers outside that set, and
renders authoritative factual text from the retrieved values.

Farm Friend does not attempt to decompose and deterministically verify unrestricted
natural-language prose. Comparative text is rendered only when code can derive the stated
comparison from typed facts.

This is the correction to an earlier design that enumerated a closed set of selection strategies:
ranking intent is an **open interpretation the model proposes and code validates and executes**,
never a constant baked into the architecture.

## The model-vs-code line (the model proposes; code commits)

The model **may**: interpret language; infer search intent; propose inventory changes; select and
rank identifiers from relevant retrieved options; draft non-authoritative language where a seam
permits it; suggest escalation. Model-authored prose may be returned only to the same actor whose
current task text supplied its private context. Any cross-actor message is code-rendered from
permitted typed facts; customer free text is not relayed to a farmer.

**Deterministic code owns**: identity and authority; launch-program consent and universal STOP;
recipient selection; commitments; transactions; durable writes; publication; idempotency; retention;
provider operations; validation of selected identifiers against retrieved facts; and rendering of
authoritative customer-facing factual text.

The model **never** writes durable state, chooses recipients, decides consent, invents
availability, or makes a compliance or commitment decision.

## The model provider seam

One narrow task interface, with:
- a **deterministic stub provider** for tests and evals, plus the live adapter (config-selected);
- **schema validation with one repair retry**, then clarify or flag — **never a silent guess**;
- task-specific input variants whose explicit fields are the only public context constructors;
- a low-level provider call that accepts only the resulting branded context and remains internal to
  `packages/ai`, so callers cannot supply an arbitrary record;
- no repository, database client, record loader, provider-managed thread, or other capability to
  acquire context outside that projection.

The approved launch projections are:

| Seam | Permitted model input |
|---|---|
| inventory extraction | the current farmer message |
| stock-out item parsing | the current item text plus public listed-item IDs/names for the code-bound location |
| inquiry interpretation | the current customer SMS request |
| grounded fact selection | interpreted intent plus opaque IDs and typed public retrieved facts |
| message classification, if retained | the current sender's message only |

No projection contains raw phone/contact data, another actor's message, unrelated thread history,
authentication or consent state, admin/audit records, internal notes, or secrets. A current sender
can voluntarily put an email, address, secret, or other sensitive phrase in the text a language
seam must interpret; Farm Friend does not claim universal detection of such strings. Raw-phone
matching remains a named fail-closed rule.

### Provider privacy gate

The single configured model provider must contractually not train on Farm Friend requests or
responses. Calls are stateless: no provider-managed conversations, files, memory, or retrieval
stores. Provider request/response logging is disabled where supported; any unavoidable provider
retention has a documented maximum compatible with Farm Friend's approved raw-context retention.
Farm Friend rejects a provider/configuration that cannot meet those requirements. Its own model-run
record continues to exclude model input and output content.

## Seam catalog

The catalog is **deliberately small** — a new seam must earn its place; prefer generalizing an
existing seam over adding a near-duplicate. Each is schema-validated, with one repair retry, then
clarify or flag:

- **inventory extraction** — farmer text → a structured inventory proposal (items, quantities or
  approximate labels). Reused wherever a farmer describes stock naturally.
- **stock-out item parsing** — on the web/QR reporting surface, free text → which item (a listed
  entry or normalized text for an unlisted one). The surface supplies the sales-location identifier
  in code; it is never a model output. A free-text SMS may receive a link to the reporting surface
  but cannot select a location or queue a farmer alert.
- **inquiry interpretation** — question → open intent: item(s), optional farm scope, a
  **proposed selection/ranking interpretation**, or an "ambiguous → ask" signal. **Never
  privileges one reading** of a multi-item request, and is not restricted to a fixed strategy
  enum. Launch does not resolve an arbitrary SMS origin.
- **grounded fact selection** — select and order identifiers from the **retrieved facts only**.
  Code validates membership and renders the authoritative, recency-labeled answer; empty retrieval
  → a code-rendered honest "no current listing."
- **message classification** — last-resort intent classification, only after deterministic routing.

Recipe requests have no model composition seam. Code may render authoritative availability for
named ingredients through the ordinary grounded inquiry path, followed by a code-rendered statement
that launch does not provide recipes or food-safety guidance.

SMS composition adds quality guidance to prefer concise, plain-punctuation, emoji-free replies that
fit one GSM-7 segment when practical. This is a **cost and phrasing preference, never a truncation
rule**: important content, names, addresses, and meaning are preserved. The outbound code guard
still performs final normalization and segment estimation.

## Retrieval and ranking (after interpretation, before grounded fact selection)

Deterministic SMS routing runs before every model call. The first inquiry call interprets the
current request. Code validates that interpretation and then runs a **general** retrieval layer:
*given items, optional farm scope, and a proposed ranking interpretation → candidate locations with
recency.* Intersection, coverage, and freshest-N are **expressible interpretations**, not an
enumerated architecture constant. Only retrieved rows reach the grounded-selection call. The model
returns only selected and ordered identifiers; code verifies that each belongs to the retrieved set,
dereferences the authoritative values, and renders the factual answer and recency. Empty retrieval
is code-rendered without a grounded-selection call.
Model-supplied values or prose are not accepted as evidence.

## The code-enforced safety boundary and its verification

Because we ingest **untrusted public SMS** (a prime prompt-injection vector), **safety is enforced
by code, never by the system prompt**. The boundary has two enforcement barriers and a separate
verification suite. This is Golden Rule #6, stated precisely:

1. **Static provenance barrier.** The low-level model call accepts only a branded **safe context**;
   the SMS send accepts only a branded **redacted outbound**. The only constructors are the
   task-specific assemblers and the redaction guard. Ordinary code therefore cannot bypass them by
   accident. **What this does not buy:** the brand proves where a value came from, not that a
   runtime string is safe; `tsc` cannot inspect content.
2. **Runtime enforcement.** Each assembler constructs one explicit minimal projection and the
   adapter has no capability to load arbitrary records. Other actors' private data is absent from
   model context. Model output is schema/evidence validated; consequential and cross-actor text is
   code-rendered. The outbound guard normalizes avoidable typographic Unicode and blocks raw phone
   numbers. Each claim is specific: the system does **not** claim this proves arbitrary text
   universally "clean."

**Verification suite — evidence, not enforcement.** Type tests prove ordinary callers cannot bypass
the static barrier. Workflow tests and the adversarial/prompt-injection eval group must exercise the
full accepted-ingress → projection → hostile model → validation/code rendering → outbox path and
prove an injected SMS cannot extract unavailable data or force a commit. This requires a hostile
model, not a cooperative canned response. A passing finite suite increases confidence in the two
barriers; it cannot block an unsafe production value and is not a third guard.

A system prompt may add defense-in-depth but is **never** the enforcement.

## Untrusted-output validation

Model output is **untrusted input**. Every seam validates against its schema before anything acts
on it. For customer inquiry, structural validity is not grounding: every selected identifier must
belong to the retrieved set, and code renders the factual response from the corresponding
authoritative values. A durable write, a recipient choice, a factual answer value, or a consent
decision **never** comes from model output.

## Evals

Evals run against the stub provider in **critical** and **advisory** groups:

- **critical** (must pass **100%**): compliance bypass, grounding and no-invention, commitment
  safety, and the **adversarial/prompt-injection group**.
- **advisory**: extraction quality, stock-out item parsing, inquiry interpretation, and
  clarification.

Required corrections to the eval suite: use **hostile models that select unknown identifiers or
attempt to smuggle factual strings, directions, or commitments into output**; reject structurally
valid selections outside the retrieved set; prove the queued factual response contains only
code-rendered retrieved values; and prove a free-text SMS stock-out report cannot select a
location or queue a farmer alert. Capture and inspect the context at the provider seam, then inspect
the resulting outbox row through the full authoritative workflow; helper-only fixtures are
insufficient. Any change touching a model seam runs evals; a provider, prompt, or context-projection
change must pass the full suite at parity or better.

## Abuse / cost on public model surfaces

The QR stock-out form is **public and unauthenticated** and routes through the abuse/cost throttle
defined in [ARCHITECTURE.md](ARCHITECTURE.md). Normal public map/listing lookup is model-free and
never artificially capped. Natural-language customer inquiry is SMS-only at launch and uses the
SMS sender/frequency controls.
