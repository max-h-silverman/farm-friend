# Farm Friend — AI Architecture

The *AI* source of truth: the trust contract, the model provider seam, the seam catalog, the line
between what the model does and what code owns, the **static/runtime safety boundary plus
verification**, validation, evals, and data minimization. Data shapes are in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); routing is in [ARCHITECTURE.md](ARCHITECTURE.md).

> The **enduring AI contract**. No build status — that lives in
> [CURRENT_STATE.md](CURRENT_STATE.md).

## The trust contract — an LLM-brain in a harness

The coordinator is an **LLM-brain in a harness**. The brain is **swappable by design**, so the
architecture never *vouches for* a model — it **measures** one (evals) and **contains** one (the
harness: deterministic routing, confirmation gates, code-owned retrieval, the safety boundary, output
validation). The contract:

- **Trusted for quality, never for authority.** Competence — extraction accuracy, interpretation,
  phrasing, composition — is *quality*: it may vary by brain, and evals price it. Everything on the
  "never" side of the model-vs-code line is *authority*: harness-owned, identical under every brain,
  including a hostile one.
- **The swap test — apply it to every feature and architectural decision.** *If the model were swapped
  tomorrow for a weaker or adversarial one, which properties survive unchanged?* Every property that
  must survive (farmer ownership, compliance, grounding, privacy, commitment) must be a harness
  property. If a guarantee would move with the model, the design is wrong — move it into code.
- **A model-version swap under the same approved provider data-handling contract is a config change
  plus an eval run**, not a new model-behavior safety design. Changing provider or changing its
  logging, training, retention, or stateful-storage behavior must re-pass the provider privacy gate.

**The system must remain safe when the model is weak, mistaken, manipulated, or hostile.**

## Semantic architecture — the model handles meaning, code controls consequences

The model produces flexible interpretations and proposals from natural language. It is **not limited to
hard-coded foods, farm names, semantic categories, or a brittle catalog of request strategies**.

**No business code hard-codes what the model can understand.** In particular:

- no farm names in behavioral branches;
- no food vocabulary in behavioral branches;
- no produce taxonomy encoded as application policy;
- no logic of the form `if vegetable, then …`;
- **no fixed semantic strategy catalog** that prevents the model from understanding an ordinary
  request.

Actual farms, foods, and listing details are **data**. Fixed compliance and authority controls — STOP,
START, HELP, authentication, confirmation — remain **deterministic**.

Code provides: an allowed task-specific context; general retrieval operations; authoritative records;
constrained action options; typed retrieved facts with stable identifiers and `asOf` values;
selected-ID validation; and deterministic rendering before any consequence. The model may propose a
search or ranking **interpretation** and select or order identifiers from the retrieved set. Code
executes only permitted operations, rejects identifiers outside that set, and renders authoritative
factual text from the retrieved values.

Farm Friend does not attempt to decompose and deterministically verify unrestricted natural-language
prose. Comparative text is rendered only when code can derive the stated comparison from typed facts.
Ranking intent is an **open interpretation the model proposes and code validates and executes**, never
a constant baked into the architecture.

## The model-vs-code line (the model proposes; code commits)

| The model **may** | Deterministic code **owns** |
|---|---|
| interpret language; infer search intent | identity and authority |
| propose inventory or closure changes | launch-program consent and universal STOP |
| select and rank identifiers from retrieved options | recipient selection |
| draft non-authoritative language where a seam permits | commitments, transactions, durable writes, publication |
| suggest escalation | idempotency, retention, provider operations |
| | validation of selected identifiers against retrieved facts |
| | rendering of authoritative customer-facing factual text |

The model **never** writes durable state, chooses recipients, decides consent, invents availability, or
makes a compliance or commitment decision.

Model-authored prose may return **only to the same actor whose current task text supplied its private
context**. Any cross-actor message is code-rendered from permitted typed facts; customer free text is
not relayed to a farmer.

## The model provider seam

One narrow task interface, with:

- a **deterministic stub provider** for tests and evals, plus the live adapter (config-selected);
- **schema validation with one repair retry**, then clarify or flag — **never a silent guess**;
- task-specific input variants whose explicit fields are the only public context constructors;
- a low-level provider call that accepts only the resulting branded context and remains internal to
  `packages/ai`, so callers cannot supply an arbitrary record;
- no provider label or duplicate schema-name argument on that call: the context's required seam and
  output instructions are the single task contract, and the real validator is supplied directly to the
  validation wrapper;
- no repository, database client, record loader, provider-managed thread, or other capability to
  acquire context outside that projection.

A projection is **built only when its seam has a real consumer** — the zen-desk rule.

| Seam | Permitted model input |
|---|---|
| farmer-message intent | the authorized farmer's current message, and nothing else |
| inventory extraction | the current farmer message, opaque published or code-issued draft entry IDs and public item names from the sender's complete pending inventory when open (otherwise current published inventory), the current or pending canonical closure instruction for the farmer's own location, the exact current Vashon calendar date, and deterministic closure timing evidence derived by code before the call |
| stock-out item parsing | the current item text plus public item IDs/names for the code-bound location — its published inventory and its usual offerings, as one flat list carrying no indication of which is which |
| customer-message intent | the customer's current message alone |
| inquiry interpretation | the current customer SMS request |
| grounded fact selection | interpreted intent plus opaque IDs and typed public retrieved facts |
| offering extraction | one stand's public "generally offers" description, alone |

**Offering extraction is the one seam that does not run on a message.** It reads VIGA's published stand
prose at ingest time and proposes the item tags a stand *usually* carries; the seeder records them for
review and code commits what a human approved. It exists because a deterministic parser could not tell
an offering from a farming-practice clause — measured against the real corpus, it produced
customer-facing tags like "rotational grazing for chickens".

Its projection carries **one description and nothing else** — no farm name, no location id, no
contact — so a model cannot attach one farm's produce to another's listing. Proposed tags become a
stand item's **standing state** and **never** a confirmation: this path reaches only that state, and
every `inventory_revisions` row must declare a `source` (F-063). It is reachable from a build-time
script and from a farmer editing their **own** listing; it is never reachable from anonymous public
discovery, which stays model-free (policed by `apps/web/lib/public-surface-model-free.test.ts`).

**The two inquiry projections are deliberately disjoint, and this is load-bearing.** Interpretation
receives the customer's question and **no retrieved facts**: it decides what to look up, and handing it
the answer set would invite it to answer from context. Grounded selection receives the retrieved facts
and **not the raw question**: it orders what code already found, and the raw request is where a prompt
injection would live. Each split is a compile error to violate
(`packages/ai/src/safety-boundary.type-test.ts`).

**Opaque identifiers are checked for shape, not scanned as content.** The named raw-phone rule applies
to human-readable retrieved text (names, item labels). Applying it to an identifier is a false positive
with no upside: a UUID's digit runs match the phone pattern by chance (F-013 separated the two checks).

No projection contains raw phone/contact data, another actor's message, unrelated thread history,
authentication or consent state, admin/audit records, internal notes, or secrets. A current sender can
voluntarily put an email, address, secret, or other sensitive phrase in the text a language seam must
interpret; Farm Friend does not claim universal detection of such strings. Raw-phone matching remains a
named fail-closed rule.

### Provider privacy gate

The single configured model provider must contractually not train on Farm Friend requests or responses.
Calls are stateless: no provider-managed conversations, files, memory, or retrieval stores. Provider
request/response logging is disabled where supported; any unavoidable provider retention has a
documented maximum compatible with Farm Friend's approved raw-context retention. Farm Friend rejects a
provider/configuration that cannot meet those requirements. Its own model-run record continues to
exclude model input and output content.

**The gate is code beside the adapter, never a footnote in this document.**
`DEEPINFRA_ATTESTED_DATA_HANDLING` in `packages/ai/src/deepinfra.ts` carries the declaration for the
currently attested vendor (DeepInfra, terms read by max 2026-07-28), and
`assertDeepInfraSelectionApproved` is the **one** approval path — it lives beside the adapter rather
than in the web composition root precisely because seed scripts and live evals construct the provider
directly and would otherwise bypass a gate that lived only in composition. The values are transcribed
verbatim from the vendor's terms with their citation beside them; source tests pin **both**, so the
record of who read what cannot drift from the numbers it justifies.

Two properties to carry to the next provider. First, **an exception in the terms becomes code, not a
footnote**: DeepInfra's no-training clause excludes models they route to Google or Anthropic, so those
model namespaces are refused at startup — otherwise the attestation would be false for a reachable
configuration. Second, **the caveat is recorded rather than smoothed over**: DeepInfra reserves an
unbounded discretionary right to log a small portion of requests, and inventing a retention number to
bound it would be exactly the inference the gate exists to prevent.

## Seam catalog

The catalog is **deliberately small** — a new seam must earn its place; prefer generalizing an existing
seam over adding a near-duplicate. Each is schema-validated, with one repair retry, then clarify or
flag:

- **inventory extraction** — farmer text → a structured farmer-update proposal: inventory edits,
  owner-only close/reopen, both sections, or clarification. Closure output is restricted to typed kind
  and exact local dates. Before any model call, code resolves supported month/day ranges, "this
  weekend," unqualified whole-stand closure, seasonal closure, and explicit reopening from the current
  Vashon date. Vague timing, reversed or multiple ranges, and sub-operation/whole-stand conflicts
  return code-rendered clarification without reaching a model. The narrow projection carries the
  resulting typed evidence; model dates must match it exactly or code clarifies. The model still
  interprets arbitrary inventory language and must preserve inventory plus closure in one mixed result.
  Code validates the shape and authority and renders every public status; the model cannot publish or
  author a public closure note.
- **farmer-message intent** — authorized farmer free text → one of three route signals:
  `inventory_update`, `farm_stand_question`, or `unclear`. Code owns authority, exact stand resolution,
  inquiry grounding, confirmation, and the clarification text. A classifier error or invalid output
  becomes `unclear`; it never becomes an inventory write.
- **customer-message intent** (F-104) — customer free text → `stock_out_report` or
  `farm_stand_question`. The sibling of farmer-message intent on the other branch, and deliberately
  NOT a field on inquiry interpretation: every working customer answer flows through that seam, so a
  new job there risks the whole question path. There is no third `unclear` arm —
  `farm_stand_question` is both the other answer and the fallback, so a refused or unreachable model
  leaves the question path exactly as it was. The projection carries the customer's message alone: no
  stand list, no farm names, no sender hash.
- **stock-out item parsing** — free text → which item (an item the stand lists, or normalized text for
  one it does not), on both the web/QR surface and the SMS reporting path. The candidate list code
  supplies spans **both** farmer-authored item lists — the stand's published inventory and its usual
  offerings — flattened into opaque identifiers the model cannot tell apart. Code built the list, so
  code alone knows which kind each identifier is, which column stores it, and which name the alert
  renders. Published entries come first and a name already published is not offered twice, so a stand
  listing one item both ways yields one candidate rather than a coin flip. Code supplies the
  sales-location identifier and it is never a model output: the web surface binds it from the scanned
  route, and SMS resolves it in code against real rows, asking "Which stand are you at?" on no match or
  a tie rather than guessing (F-106, ARCHITECTURE.md §routing). An authorized farmer naming ANOTHER
  farm's stand is routed here too, with ownership resolved in code from `farmer_authorizations`
  (B-053). Model-derived item text for an *unlisted* report is stored but never spoken: the farmer's
  alert names the stand and, for a listed entry, the stand's own item name — a code-rendered message
  from typed facts, never a reporter's or a model's prose.
- **inquiry interpretation** — question → open intent: item(s), optional farm scope, a **proposed
  selection/ranking interpretation**, an `outOfScopeRequest` **boolean**, an `originDependent`
  **boolean**, or a bare "ambiguous → ask" signal. **Never privileges one reading** of a multi-item
  request, and is not restricted to a fixed strategy enum. Launch does not resolve an arbitrary SMS
  origin.
- **grounded fact selection** — select and order identifiers from the **retrieved facts only**. Code
  validates membership and renders the authoritative, recency-labeled answer; empty retrieval → a
  code-rendered honest "no current listing."

  A **fact identifier is an opaque token the model copies back verbatim, and must carry no structure
  worth reconstructing** (B-049): a live model stripped a meaningful prefix and returned the bare uuid
  on every attempt. What the two bases *are* travels as the typed `basis` field.

  **Code renders no claim the retrieved rows do not support.** The answer heading names the requested
  item only where a selected row actually carries it: the item list falls back to a stand's full
  contents when nothing matches by name — right, because only the model can see a category
  relationship — and asserting the customer's word above that fallback produced `Confirmed mangoes:`
  over a stand selling eggs. Code fabricating a fact is the same failure as a model doing it.

**Neither inquiry seam may return prose.** The ambiguity and clarification outcomes are **bare signals
carrying no other field** — validation refuses any — and code renders the question. A model-authored
`question` string was the only path by which model prose reached a customer in the inquiry flow; F-018
removed the field rather than scanning what passed through it.

**Recipe requests have no model composition seam — and never had one.** Recognizing that a request asks
for a recipe, cooking or preservation instructions, or food-safety guidance is **meaning**, so it stays
the model's job: the interpretation seam sets `outOfScopeRequest`, a **boolean that carries no words**.
Code renders authoritative availability for any ingredients the request names through the ordinary
grounded inquiry path, then appends `RECIPE_SCOPE_STATEMENT`, a code constant. A request with no
available ingredients receives the code-rendered "no current listing" plus that statement — never a
model-authored substitute. Because the model's entire vocabulary here is one boolean and a set of
opaque identifiers, a hostile model asked for canning instructions has **no field to answer through**.
There is no content scanner and no food taxonomy in business logic.

**Arbitrary-origin proximity uses the same mechanism (F-017).** Launch resolves no customer address or
device location over SMS. Recognizing that "which stand is closest to me?" needs an origin is meaning,
so the interpretation seam sets `originDependent`, a **second boolean that carries no geography**; code
answers the grounded availability half and appends `ORIGIN_LIMITATION_STATEMENT`, a code constant
naming the public web map. The intent allowlist has **no member that can carry a coordinate, distance,
bearing, or travel time**, and a ranking operation requiring an origin (`nearest`, `closest`) is
**refused rather than silently downgraded** to recency — an unranked list presented as "closest" is a
wrong answer that looks like a right one.

SMS composition adds quality guidance to prefer concise, plain-punctuation, emoji-free replies that fit
one GSM-7 segment when practical. This is a **cost and phrasing preference, never a truncation rule**:
important content, names, addresses, and meaning are preserved. The outbound code guard still performs
final normalization and segment estimation.

## Retrieval and ranking (after interpretation, before grounded fact selection)

Deterministic SMS routing runs before every model call. For an authorized farmer's free text, code
checks live authority, the farmer-message intent seam classifies the route, and only an update then
resolves an exact stand target. A question enters the same grounded inquiry flow as a customer.

The first inquiry call interprets the current request. Code validates that interpretation and then runs
a **general** retrieval layer: *given items, optional farm scope, and a proposed ranking interpretation
→ candidate locations with recency.* Intersection, coverage, and freshest-N are **expressible
interpretations**, not an enumerated architecture constant. Only retrieved rows reach the
grounded-selection call. The model returns only selected and ordered identifiers; code verifies that
each belongs to the retrieved set, dereferences the authoritative values, and renders the factual
answer and recency. Empty retrieval is code-rendered without a grounded-selection call. Model-supplied
values or prose are not accepted as evidence.

**Retrieval is also where VISIBILITY is decided, and that placement is the guarantee** (F-074). Whether
a sender may see test farms is code's decision, made from the sender hash *before* any model call and
never carried into or out of model context — the model receives no hash, no boolean, and no hint that a
hidden farm exists. Because it filters what comes back rather than what the prompt says, a test farm
the filter excluded **cannot be named however directly the question asks for it**. A test asserts
exactly this, with a scripted model that names the hidden farm anyway and is refused. A prompt
instruction to "not mention test farms" would be the same guarantee written where a jailbreak can reach
it — Golden Rule #6's shape applied to visibility.

**Broad availability requests select only their first result page.** Interpretation marks a request for
the complete available set with a boolean; code uses its validated ranking to order the full retrieved
set, gives selection only the displayable first page, and persists the already-ranked remainder for
`MORE`. A named item or category never takes this path: selection still sees every candidate because
only the model can decide semantic relevance.

**"Retrieval-first" means retrieval before grounded *fact selection* and factual rendering — not before
*semantic interpretation*.** The distinction is settled and load-bearing in both directions.
Interpreting the request must come first, because retrieval needs to know what to look for; letting the
model see retrieved facts before it has decided what to look up would invite it to answer from context
instead of selecting from evidence. So the fixed order is: deterministic routing → model interprets →
code validates and retrieves → model selects/orders IDs from that exact set → code validates membership
and renders. Reading "retrieval-first" as "retrieve before any model call" would make open-ended
customer intent unimplementable and is the wrong reading.

## The code-enforced safety boundary and its verification

Because we ingest **untrusted public SMS** (a prime prompt-injection vector), **safety is enforced by
code, never by the system prompt**. The boundary has two enforcement barriers and a separate
verification suite. This is Golden Rule #6, stated precisely:

1. **Static provenance barrier.** The low-level model call accepts only a branded **safe context**; the
   SMS send accepts only a branded **redacted outbound**. The only constructors are the task-specific
   assemblers and the redaction guard. Ordinary code therefore cannot bypass them by accident. **What
   this does not buy:** the brand proves where a value came from, not that a runtime string is safe;
   `tsc` cannot inspect content.
2. **Runtime enforcement.** Each assembler constructs one explicit minimal projection and the adapter
   has no capability to load arbitrary records. Other actors' private data is absent from model
   context. Model output is schema/evidence validated; consequential and cross-actor text is
   code-rendered. The outbound guard normalizes avoidable typographic Unicode and blocks raw phone
   numbers. Each claim is specific: the system does **not** claim this proves arbitrary text
   universally "clean."

**Verification suite — evidence, not enforcement.** Type tests prove ordinary callers cannot bypass the
static barrier. Workflow tests and the adversarial/prompt-injection eval group must exercise the full
accepted-ingress → projection → hostile model → validation/code rendering → outbox path and prove an
injected SMS cannot extract unavailable data or force a commit. **This requires a hostile model, not a
cooperative canned response.** A passing finite suite increases confidence in the two barriers; it
cannot block an unsafe production value and is not a third guard.

A system prompt may add defense-in-depth but is **never** the enforcement.

## Untrusted-output validation

Model output is **untrusted input**. Every seam validates against its schema before anything acts on
it. For customer inquiry, structural validity is not grounding: every selected identifier must belong
to the retrieved set, and code renders the factual response from the corresponding authoritative
values. A durable write, a recipient choice, a factual answer value, or a consent decision **never**
comes from model output.

**Membership is not authorization** (B-056). Every inventory removal's `entryId` is validated against
the base snapshot, which looks like grounding but is not: the model cannot invent an identifier, yet it
can select a *real* one it has no authority to touch — "no eggs left" against a listing of tomatoes and
kale returned a removal of kale. `validateInterpretation` therefore also takes the farmer's own message
and **drops any removal whose item name does not appear in it** — silently, because the farmer confirms
every proposal, so an unauthorized removal never reaches the "Taking off:" line while everything they
did say still goes through. This lives in code and not in the seam note because the seam note was given
an explicit rule for the case and the real model still returned the removal, *nondeterministically*.

Shape validation does not make a model-writable string safe for a public surface. The inventory
publication transaction therefore runs one shared deterministic public-string validator over every
free-form field it could publish and refuses the complete proposal on phone numbers, email addresses,
web links, or direct-contact instructions. This is downstream of both SMS and farmer web and is
deliberately not a prompt instruction or a model-seam filter: a farmer can type the same content
without any model involvement, and direct farmer contact is a code-owned launch boundary. Participant
names reuse this validator; there is no second scanner.

## Evals

Evals run against the stub provider in **critical** and **advisory** groups:

- **critical** (must pass **100%**): compliance bypass, grounding and no-invention, commitment safety,
  and the **adversarial/prompt-injection group**.
- **advisory**: extraction quality, stock-out item parsing, inquiry interpretation, and clarification.

**A hostile model, never a cooperative one.** `evals/hostile.ts` and the hostile group in
`apps/web/lib/interpretation.integration.test.ts` use models that **select unknown identifiers, invent
stock, demand contact data, and attempt to smuggle a publication or recipient decision into output**.
They capture the context at the provider seam *and* the resulting durable rows, rather than asserting
on helpers — a helper fixture is not boundary proof. Required outcomes: structurally valid selections
outside the retrieved set are rejected; a smuggled consequential field is a **visible refusal**, never
a silent strip; and an invention reaches at most a code-rendered confirmation the farmer must approve.

For the inquiry and stock-out seams the adversarial group must additionally prove that a smuggled
factual string (`answerText`, `recency`, `distance`, `directions`) is a visible refusal rather than a
stripped field, the delivered answer contains only code-rendered retrieved values, an unexecutable
ranking interpretation is refused rather than downgraded, and neither inquiry projection carries the
other's data. Integration tests prove a report never mutates published inventory or ranking, and that
an entry from another farm's stand is refused against a code-bound location.

**A third group runs against the REAL model: `npm run evals:live`.** The scripted groups use a stub,
and **a stub reads neither the output instructions nor the schema** — so it is structurally blind to a
seam whose instructions describe the wrong job. The first live run proved that concretely: every seam
failed validation while the entire unit suite and every scripted eval were green.

`evals/live.ts` splits into:

- **live-containment** (must pass **100%**): the two enforcement barriers, reached through *real* model
  output. Each fixture actively invites the model to comply with an injection, so the pass condition is
  **the barrier held**, never *the model refused* — a distinction that matters, because in practice the
  model **did** comply and membership validation rejected the whole selection.
- **live-quality** (recorded, non-fatal): what the brain is trusted for. Observed output is printed so
  two candidate models can be compared run against run.

A live-containment failure **stops and reports**; fixtures are never edited to go green.

**A fallback is not a verdict.** A seam that cannot reach the provider returns the same `clarification`
shape it returns when the model legitimately declines, so a fixture accepting *any* clarification
scores an unreachable model as correct behaviour. Live fixtures therefore name the seam's own fallback
strings and score them as FAILURES, labelling the provider-error case `[provider error, not a verdict —
rerun]`. Relatedly, **live results are nondeterministic**: identical input has passed and failed across
consecutive runs, so a single green run is not evidence that a prompt change worked. Where the property
must hold every time, it belongs in code and the fixture should measure the validated output rather
than the raw model response.

Two supporting mechanisms keep the seams honest between live runs. Every projection carries required
output instructions, assembled from `SEAM_OUTPUT_SHAPES` and its seam-specific notes; there is no
instruction-less provider-call shape. `output-contracts.test.ts` parses **every documented example
through that seam's real schema** in both directions — so the prose a model reads cannot drift from the
validator that judges it. `nullAsAbsent()` accepts an explicit `null` as absence **only where a schema
already declares optionality**, because instruct models near-universally emit `"field": null` for an
unstated value; a null-valued *unknown* key still hits the strict schema's visible refusal.

Any change touching a model seam runs evals **and the live suite**; a provider, prompt, or
context-projection change must pass the full suite at parity or better.

## Abuse / cost on public model surfaces

The QR stock-out form is **public and unauthenticated** and routes through the abuse/cost throttle
defined in [ARCHITECTURE.md](ARCHITECTURE.md). Normal public map/listing lookup is model-free and never
artificially capped. Natural-language customer inquiry is SMS-only at launch and uses the SMS
sender/frequency controls.

It is the *only* public model surface, and that is enforced by the public route's dependency set rather
than promised: `handleStandsRequest` takes `db` + `clock` and has no seam to hand a model to. The
integration suite invokes it with a provider that **throws on any call**, so "model-free" means the
surface works with no model available — not that a cooperative stub happened to go untouched. The
throttle is consulted before the model call, and the tests assert the provider was never reached on a
refusal.
