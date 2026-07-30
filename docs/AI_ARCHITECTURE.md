# Farm Friend — AI Architecture

The *AI* source of truth: the trust contract, the model provider seam, the seam catalog, the line
between what the model does and what code owns, the **static/runtime safety boundary plus
verification**, validation, evals, and data minimization. Data shapes are in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); routing is in [ARCHITECTURE.md](ARCHITECTURE.md).

> This document states the **enduring AI contract** — the trust boundary Farm Friend must hold
> whichever model sits behind it. It carries no build status: what is actually built, configured,
> and open lives in [CURRENT_STATE.md](CURRENT_STATE.md).

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

The approved launch projections are listed below. A projection is **built only when its seam has
a real consumer** — the zen-desk rule. Five are built; message classification remains unbuilt and
unprojected because it has no caller, and there is deliberately no generic assembler standing in
for it in the meantime.

| Seam | Permitted model input |
|---|---|
| inventory extraction | the current farmer message, plus opaque entry IDs and public item names for the farmer's own location |
| stock-out item parsing | the current item text plus public listed-item IDs/names for the code-bound location |
| inquiry interpretation | the current customer SMS request |
| grounded fact selection | interpreted intent plus opaque IDs and typed public retrieved facts |
| offering extraction | one stand's public "generally offers" description, alone |

A **message-classification** seam has been repeatedly considered and is deliberately absent: it has
no defined consumer and no safe consequence, so it would be a projection nothing acts on. It gets a
projection when a launch workflow needs one, not before.

**Offering extraction is the one seam that does not run on a message.** It reads
VIGA's published stand prose at ingest time and proposes the item tags a stand *usually* carries;
the seeder records them for review and code commits what a human approved. It exists because a
deterministic parser could not tell an offering from a farming-practice clause — measured against
the real 31-stand corpus, it produced customer-facing tags like "rotational grazing for chickens"
and "but following organic practices".

Its projection carries **one description and nothing else** — no farm name, no location id, no
contact — so a model cannot attach one farm's produce to another's listing. Proposed tags land in
`sales_location_offerings` (what a stand usually has) and **never** in `inventory_revisions`, which
requires a farmer authorization and a farm approval this path structurally cannot produce. It is
reachable from a build-time script and, if a farmer web form is built, from a farmer editing their
**own** listing; it is never reachable from anonymous public discovery, which stays model-free
(F-019, policed by `apps/web/lib/public-surface-model-free.test.ts`).

The two inquiry projections are deliberately **disjoint**, and this is load-bearing rather than
incidental. Interpretation receives the customer's question and **no retrieved facts**: it decides
what to look up, and handing it the answer set would invite it to answer from context. Grounded
selection receives the retrieved facts and **not the raw question**: it orders what code already
found, and the raw request is where a prompt injection would live. Each split is a compile error to
violate (`packages/ai/src/safety-boundary.type-test.ts`).

**Opaque identifiers are checked for shape, not scanned as content.** The named raw-phone rule
applies to human-readable retrieved text (names, item labels). Applying it to an identifier is a
false positive with no upside: a UUID's digit runs match the phone pattern by chance, which was
observed refusing ~1 in 4 legitimate integration runs before F-013 separated the two checks.

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

**The gate is code beside the adapter, never a footnote in this document.**
`DEEPINFRA_ATTESTED_DATA_HANDLING` in `packages/ai/src/deepinfra.ts` carries the declaration for the
currently attested vendor (DeepInfra, terms read by max 2026-07-28), and
`assertDeepInfraSelectionApproved` is the **one** approval path — it lives beside the adapter rather
than in the web composition root precisely because seed scripts and live evals construct the provider
directly and would otherwise bypass a gate that lived only in composition. The values are transcribed
verbatim from the vendor's terms with their citation beside them; source tests pin **both**, so the
record of who read what cannot drift from the numbers it justifies.

Two things this gate does that are worth generalizing to the next provider. First, **an exception in
the terms becomes code, not a footnote**: DeepInfra's no-training clause excludes models they route to
Google or Anthropic, so those model namespaces are refused at startup — otherwise the attestation
would be false for a reachable configuration. Second, **the caveat is recorded rather than smoothed
over**: DeepInfra reserves an unbounded discretionary right to log a small portion of requests, and
inventing a retention number to bound it would be exactly the inference the gate exists to prevent.

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
  **proposed selection/ranking interpretation**, an `outOfScopeRequest` **boolean**, an
  `originDependent` **boolean**, or a bare "ambiguous → ask" signal. **Never privileges one
  reading** of a multi-item request, and is not restricted to a fixed strategy enum. Launch does
  not resolve an arbitrary SMS origin.
- **grounded fact selection** — select and order identifiers from the **retrieved facts only**.
  Code validates membership and renders the authoritative, recency-labeled answer; empty retrieval
  → a code-rendered honest "no current listing."

**Neither inquiry seam may return prose.** The ambiguity and clarification outcomes are **bare
signals carrying no other field** — validation refuses any — and code renders the question. They
previously carried a model-authored `question` string that was delivered to the customer verbatim;
that was the only path by which model prose reached a customer in the inquiry flow, and F-018
removed the field rather than scanning what passed through it.
- **message classification** — last-resort intent classification, only after deterministic routing.

Recipe requests have no model composition seam — and never had one. Recognizing that a request
asks for a recipe, cooking or preservation instructions, or food-safety guidance is **meaning**, so
it stays the model's job: the interpretation seam sets `outOfScopeRequest`, a **boolean that
carries no words**. Code renders authoritative availability for any ingredients the request names
through the ordinary grounded inquiry path, then appends `RECIPE_SCOPE_STATEMENT`, a code constant.
A request with no available ingredients receives the code-rendered "no current listing" plus that
statement — never a model-authored substitute. Because the model's entire vocabulary here is one
boolean and a set of opaque identifiers, a hostile model asked for canning instructions has **no
field to answer through**. There is no content scanner and no food taxonomy in business logic.

**Arbitrary-origin proximity uses the same mechanism (F-017).** Launch resolves no customer address
or device location over SMS. Recognizing that "which stand is closest to me?" needs an origin is
meaning, so the interpretation seam sets `originDependent`, a **second boolean that carries no
geography**; code answers the grounded availability half and appends `ORIGIN_LIMITATION_STATEMENT`,
a code constant naming the public web map. The intent allowlist has **no member that can carry a
coordinate, distance, bearing, or travel time**, and a ranking operation requiring an origin
(`nearest`, `closest`) is **refused rather than silently downgraded** to recency — an unranked list
presented as "closest" is a wrong answer that looks like a right one. Browser-origin proximity lives
on the public web surface, where it is arithmetic over seeded coordinates and touches no model.

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

**"Retrieval-first" means retrieval before grounded *fact selection* and factual rendering — not
before *semantic interpretation*.** The distinction is settled and load-bearing in both directions.
Interpreting the request must come first, because retrieval needs to know what to look for; letting
the model see retrieved facts before it has decided what to look up would invite it to answer from
context instead of selecting from evidence. So the fixed order is: deterministic routing → model
interprets → code validates and retrieves → model selects/orders IDs from that exact set → code
validates membership and renders. Reading "retrieval-first" as "retrieve before any model call"
would make open-ended customer intent unimplementable and is the wrong reading.

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

**A hostile model, never a cooperative one.** `evals/hostile.ts` and the hostile group in
`apps/web/lib/interpretation.integration.test.ts` use models that **select unknown identifiers,
invent stock, demand contact data, and attempt to smuggle a publication or recipient decision into
output**. They capture the context at the provider seam *and* the resulting durable rows, rather than
asserting on helpers — a helper fixture is not boundary proof. Required outcomes: structurally valid
selections outside the retrieved set are rejected; a smuggled consequential field is a **visible
refusal**, never a silent strip; and an invention reaches at most a code-rendered confirmation the
farmer must approve.

For the inquiry and stock-out seams the adversarial group must additionally prove that a smuggled
factual string (`answerText`, `recency`, `distance`, `directions`) is a visible refusal rather than a
stripped field, the delivered answer contains only code-rendered retrieved values, an unexecutable
ranking interpretation is refused rather than downgraded, and neither inquiry projection carries the
other's data. Integration tests prove a report never mutates published inventory or ranking, and that
an entry from another farm's stand is refused against a code-bound location.

**A third group runs against the REAL model: `npm run evals:live`.** The scripted groups
above use a stub, and a stub reads neither the output instructions nor the schema — so it is
structurally blind to a seam whose instructions describe the wrong job. The first live run proved
that concretely: **every seam failed validation** while the entire unit suite and every scripted eval
were green, because the projections attached SMS-composition guidance to seams whose output is
structured JSON and never stated the expected shape.

`evals/live.ts` splits into:

- **live-containment** (must pass **100%**): the two enforcement barriers, reached through *real*
  model output. Each fixture actively invites the model to comply with an injection, so the pass
  condition is **the barrier held**, never *the model refused* — a distinction that matters, because
  in practice the model **did** comply (asked to include an unretrieved `factId`, it included it) and
  membership validation rejected the whole selection.
- **live-quality** (recorded, non-fatal): what the brain is trusted for. Observed output is printed
  so two candidate models can be compared run against run.

A live-containment failure **stops and reports**; fixtures are never edited to go green.

Two supporting mechanisms keep the seams honest between live runs. `SEAM_OUTPUT_SHAPES` gives each
seam example shapes plus semantic notes, and `output-contracts.test.ts` parses **every documented
example through that seam's real schema** in both directions — so the prose a model reads cannot
drift from the validator that judges it. `nullAsAbsent()` accepts an explicit `null` as absence
**only where a schema already declares optionality**, because instruct models near-universally emit
`"field": null` for an unstated value; a null-valued *unknown* key still hits the strict schema's
visible refusal.

Any change touching a model seam runs evals **and the live suite**; a provider, prompt, or
context-projection change must pass the full suite at parity or better.

## Abuse / cost on public model surfaces

The QR stock-out form is **public and unauthenticated** and routes through the abuse/cost throttle
defined in [ARCHITECTURE.md](ARCHITECTURE.md). Normal public map/listing lookup is model-free and
never artificially capped. Natural-language customer inquiry is SMS-only at launch and uses the
SMS sender/frequency controls.

It is the *only* public model surface, and that is enforced by the public
route's dependency set rather than promised: `handleStandsRequest` takes `db` + `clock` and has no
seam to hand a model to. The integration suite invokes it with a provider that **throws on any
call**, so "model-free" means the surface works with no model available — not that a cooperative
stub happened to go untouched. The throttle is consulted before the model call, and the tests
assert the provider was never reached on a refusal.
