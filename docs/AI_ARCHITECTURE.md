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

Code provides: an allowed task-specific context; authoritative records; deduplicated public catalogs;
constrained action options; typed facts with stable identifiers and `asOf` values; catalog-membership
validation; and deterministic rendering before any consequence. For customer inquiry, a classifier
first fixes the operation without seeing a catalog; only inventory/payment then lets a matcher select
public catalog values. Code expands those selections to every supporting stand and evidence row,
orders them, and renders authoritative factual text.

Farm Friend does not attempt to decompose and deterministically verify unrestricted natural-language
prose. Comparative text is rendered only when code can derive the stated comparison from typed facts.
Semantic matching stays open-ended: the model can relate "leafy greens" to farmer-authored names such
as "kale" and "lettuce" without a food taxonomy in code.

## The model-vs-code line (the model proposes; code commits)

| The model **may** | Deterministic code **owns** |
|---|---|
| interpret language; infer search intent | identity and authority |
| propose inventory or closure changes | launch-program consent and universal STOP |
| select public catalog names or typed options | recipient selection |
| draft non-authoritative language where a seam permits | commitments, transactions, durable writes, publication |
| suggest escalation | idempotency, retention, provider operations |
| | validation of selected values against code-supplied options |
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

**Prompt PRESENTATION is a per-seam property; schema and transport stay shared** (F-111). A
projection declares a `framing` — `extraction` (the default every pre-F-111 seam uses: `Task:` →
`Input (JSON):` → `Output requirements:`, with a system message about extracting structured data) or
`classification` (instruction first, then labelled fields, with a minimal role-only system message).
The adapter **reads the declaration and never infers one** from a seam name or schema shape, which
would silently re-frame the next seam that happened to resemble this one. This exists because
"extraction" had been baked into shared plumbing that then had to carry a non-extraction task: the
same instruction scored 41/47 under extraction framing and 52/53 under classification framing.
**Field values are JSON-encoded under every framing**, so the injection boundary does not vary with
presentation — a newline and a forged label inside sender text cannot become a second field.

| Seam | Permitted model input |
|---|---|
| request classification (F-111/B-069) | the sender's current message alone; a strict route-specific result fixes search/lookup operation and applicable flags — **no catalog, stand data, payment values, factual context, sender type, or service name** |
| inventory extraction | the current farmer message, opaque published or code-issued draft entry IDs and public item names from the sender's complete pending inventory when open (otherwise current published inventory), the current or pending canonical closure instruction for the farmer's own location, the exact current Vashon calendar date, and deterministic closure timing evidence derived by code before the call |
| stock-out item parsing | the current item text plus public item IDs/names for the code-bound location — its published inventory and its usual offerings, as one flat list carrying no indication of which is which |
| catalog matching (B-069) | the current customer SMS request, catalog type, and unique public item or payment values — **no route choice, stand IDs, names, associations, evidence type, or factual prose** |
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

**The inquiry projection carries meanings without stand associations.** Each unique public item and
payment name appears once. The model can decide that "leafy greens" matches "Kale" and "Lettuce", but
cannot include one stand and omit another carrying the same selected name, choose confirmed versus
usual evidence, or spend output reproducing stand identifiers. Code owns all expansion and ordering.

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
  resulting typed evidence, and code — never the model — owns closure timing outright. Where the
  message DOES carry closure evidence, model dates must match it exactly or code clarifies. Where
  code found **no** closure evidence, no closure value is admissible at all: the field is stripped
  before schema validation and dropped from the result, so a model that volunteers an unevidenced
  closure cannot cost the farmer the inventory update it rode in on (B-058). The exception is
  `kind: "closure"`, where the closure is the whole payload and a mismatch still clarifies. An
  omitted edit array reads as empty rather than failing the parse — absence has one meaning there,
  and it cannot manufacture an edit. The model still
  interprets arbitrary inventory language and must preserve inventory plus closure in one mixed result.
  Code validates the shape and authority and renders every public status; the model cannot publish or
  author a public closure note.
- **request classification** (F-111) — any sender's free text → exactly one of six categories:
  `search_stands`, `stand_lookup`, `inventory_report`, `system_inquiry`, `chitchat`, `unclear`. One
  `.strict()` enum field and nothing else, so the seam has no channel through which a stand, a
  recipient, an attribute or prose could travel. **It replaces the two sender-split intent seams
  below**, which Phase 2 deletes.
  - **`inventory_report` is one category for every sender.** Splitting it by sender was measured and
    failed: "no eggs left at Pinecone Gardens" from a farmer classified as *their own* update 3/3,
    which is B-053 reintroduced. Who may act on a report is an **access** question code answers from
    `farmer_authorizations` — customer → report; farmer with access → update; farmer **without**
    access → report. The classifier cannot express authority at all.
  - **There is no fallback category.** A provider error or invalid output returns a failure the
    caller renders as an outage reply, rather than reusing a real category as its refusal value the
    way the two sender-split seams it replaced did — which made an outage indistinguishable from a
    classification and answered "no current listing" for a corpus nothing had searched.
  - **`unclear` is a real, reachable category**, not that fallback: a message outside what Farm
    Friend does gets an honest answer rather than being forced into product retrieval.
  - **Two code-owned fast paths run before the model**, each a shortcut to a category the model could
    also produce and never a route to a consequence its output could not reach. A **generic
    acceptance matcher** ("who takes X", subject + acceptance verb + object, carrying no payment or
    organisation vocabulary) and the **VIGA Bucks resolver**, which claims four shapes:
    acceptance at one named stand → `stand_lookup`; general acceptance or spending →
    `search_stands`; what they are or how to get them → `system_inquiry`; and an unsupported
    *statement* about them → `unclear`. That last arm is a domain override: "no viga bucks left" is
    grammatically identical to "no eggs left", so the model correctly applies an instruction rule we
    need for real reports — it simply lacks the domain fact that VIGA Bucks are not stand inventory.
    Recognising a fixed program of the service is the same act as recognising `MAP`; the
    no-hard-coded-vocabulary rule forbids *farm and food* vocabulary, which changes as stands and
    seasons turn.
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
- **request classification** (B-069) — the existing top-level call now returns a strict discriminated
  union. `search_stands` permits inventory, broad, payment, hours, or clarification;
  `stand_lookup` permits inventory, payment, hours, location, overview, or clarification. Applicable
  `outOfScopeRequest` and `originDependent` flags live on the relevant request variants. Non-inquiry
  kinds carry no inquiry fields, and the call sees the current message only.

- **catalog matching** (B-069) — inventory and payment alone make a second bounded call after the
  operation is fixed. It receives one deduplicated value list and returns only `{matches:[...]}`.
  A valid empty list means the request was understood but nothing matched; provider/schema failure is
  a separate result. The schema has no route, operation, stand identifier, evidence, factual value,
  flag, or customer-facing prose field.

  For `search_stands`, code supplies the unique item names found across both confirmed inventory and
  usual offerings or the unique payment names for the fixed operation. The matcher answers only the
  semantic question "which of these values match?" Code validates each returned value against that catalog, expands it to **every**
  stand carrying it, retains all confirmed/usual evidence for that name (B-068), orders by authoritative
  recency, pages, and renders. An empty inventory selection is the understood answer "no current
  listing," not a clarification.

  For `stand_lookup`, code resolves exactly one stand after classification and supplies only that
  stand's item or payment catalog when matching is needed. Location, hours, and overview are rendered
  directly from the stand's public record with no second model call.

  **A single-stand answer always carries that stand's whole listing, rendered by code** (B-071). A
  question naming no product is `overview` and reaches no seam at all; a stand-scoped `inventory`
  question leads with the yes/no the customer asked and then renders the same full listing. The
  matcher's only contribution is *which item* the verdict is about, still re-validated against the
  stand's catalog. This is deliberate containment rather than presentation: on a real eleven-value
  catalog the matcher omitted a confirmed item in 3 of 8 live runs, and a value it silently fails to
  return is indistinguishable from one the customer never asked about, so no downstream check can
  recover it. The model may select values; it may never decide which of a farmer's published facts a
  customer is allowed to see.

  `system_inquiry` and `chitchat` do not use this seam. System answers are fixed code-owned copy;
  VIGA Bucks explanations link the official VIGA page rather than embedding mutable pickup details.
  Chitchat returns `Ask me what a Vashon farm stand has, or tell us if something is sold out. 🌱`.
  VIGA Bucks search/lookup is also code-owned from the classifier's deterministic topic signal.

  **Code renders no claim the public rows do not support.** A selected catalog name expands only to
  rows carrying that exact code-owned name; model spelling never replaces farmer spelling, and an
  invented name refuses the result rather than naming a stand.

**Neither inquiry seam may return prose.** Clarification is an operation fixed by classification, and
code renders the question without a matching call. A model-authored `question` string was the only
path by which model prose reached a customer in the inquiry flow; F-018 removed the field rather than
scanning what passed through it.

**Recipe requests have no model composition seam — and never had one.** Recognizing that a request asks
for a recipe, cooking or preservation instructions, or food-safety guidance is **meaning**, so it stays
the model's job: request classification sets `outOfScopeRequest`, a **boolean that carries no words**.
Code renders authoritative availability for any ingredients the request names through the ordinary
grounded inquiry path, then appends `RECIPE_SCOPE_STATEMENT`, a code constant. A request with no
available ingredients receives the code-rendered "no current listing" plus that statement — never a
model-authored substitute. Because the model's entire vocabulary here is one boolean and a set of
catalog names, a hostile model asked for canning instructions has **no field to answer through**.
There is no content scanner and no food taxonomy in business logic.

**Arbitrary-origin proximity uses the same mechanism (F-017).** Launch resolves no customer address or
device location over SMS. Recognizing that "which stand is closest to me?" needs an origin is meaning,
so request classification sets `originDependent`, a **second boolean that carries no geography**; code
answers the grounded availability half and appends `ORIGIN_LIMITATION_STATEMENT`, a code constant
naming the public web map. The intent allowlist has **no member that can carry a coordinate, distance,
bearing, travel time, or nearest-stand claim**. Code appends the limitation rather than presenting a
recency-ordered list as "closest."

SMS composition adds quality guidance to prefer concise, plain-punctuation, emoji-free replies that fit
one GSM-7 segment when practical. This is a **cost and phrasing preference, never a truncation rule**:
important content, names, addresses, and meaning are preserved. The outbound code guard still performs
final normalization and segment estimation.

## Inquiry flow (after top-level classification)

Deterministic SMS routing runs before every model call. One request classifier then runs for every
sender, and only `inventory_report` from a farmer holding the resolved stand reaches an exact stand
target — access is checked in code after the category is known. Inquiry categories then follow the
category-specific flows above.

The classifier fixes the inquiry operation from the message alone. Broad, hours, location, overview,
and clarification make no second model call — and a product-less question about ONE stand is
`overview`, so it is code-rendered rather than matched (B-071). Inventory/payment then build an
island-wide catalog for search or resolve one stand and build its catalog for lookup; one generic
matcher selects values. Code
validates membership, expands names to authoritative rows, combines confirmed inventory with usual
offerings without losing either evidence voice, orders deterministically, and renders. Model-supplied
values or prose are never accepted as evidence.

**Retrieval is also where VISIBILITY is decided, and that placement is the guarantee** (F-074). Whether
a sender may see test farms is code's decision, made from the sender hash *before* any model call and
never carried into or out of model context — the model receives no hash, no boolean, and no hint that a
hidden farm exists. Because it filters what comes back rather than what the prompt says, a test farm
the filter excluded **cannot be named however directly the question asks for it**. A test asserts
exactly this, with a scripted model that names the hidden farm anyway and is refused. A prompt
instruction to "not mention test farms" would be the same guarantee written where a jailbreak can reach
it — Golden Rule #6's shape applied to visibility.

**Broad availability is a first-class classification result.** Because Call #1 sees no catalog, broad
cannot be inferred from what happens to match. Code expands it to the full public catalog, orders every
matching stand, renders the first page, and persists the remainder for `MORE`; no matcher runs.

The fixed order is: deterministic routing → model classifies message without catalog → optional code
stand resolution → inventory/payment alone build one unique catalog → model matches values → code
validates, expands, orders, pages, and renders.
For VIGA Bucks system/search/lookup and chitchat, the category-specific code path renders directly and
there is no second model call.

"Open now" means **confirmed open only**. Code evaluates public hours, season, closure, daylight, and
Vashon time; unknown, by-appointment, closed, and out-of-season stands are excluded on the first page
and rechecked before a saved `MORE` page renders.

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
it. For customer inquiry, structural validity is not grounding: every selected item or payment name
must belong to the exact code-supplied catalog, and code renders the factual response from the public
rows carrying those names. A durable write, recipient choice, factual answer value, or consent decision
**never** comes from model output.

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
- **advisory**: extraction quality, stock-out item parsing, catalog matching, and clarification.

**A hostile model, never a cooperative one.** `evals/hostile.ts` and the hostile group in
`apps/web/lib/interpretation.integration.test.ts` use models that **select unknown values, invent
stock, demand contact data, and attempt to smuggle a publication or recipient decision into output**.
They capture the context at the provider seam *and* the resulting durable rows, rather than asserting
on helpers — a helper fixture is not boundary proof. Required outcomes: selections outside the
code-supplied options are rejected; a smuggled consequential field is a **visible refusal**, never
a silent strip; and an invention reaches at most a code-rendered confirmation the farmer must approve.

For the inquiry and stock-out seams the adversarial group must additionally prove that a smuggled
factual string (`answerText`, `recency`, `distance`, `directions`) is a visible refusal rather than a
stripped field, the inquiry projection deduplicates catalogs and carries no stand association, and the
delivered answer contains only code-rendered public values. Integration tests prove catalog selections
expand to every supporting stand/evidence row, a report never mutates published inventory or ranking,
and an entry from another farm's stand is refused against a code-bound location.

**A third group runs against the REAL model: `npm run evals:live`.** The scripted groups use a stub,
and **a stub reads neither the output instructions nor the schema** — so it is structurally blind to a
seam whose instructions describe the wrong job. The first live run proved that concretely: every seam
failed validation while the entire unit suite and every scripted eval were green.

`evals/live.ts` splits into:

- **live-containment** (must pass **100%**): the two enforcement barriers, reached through *real* model
  output. Each fixture actively invites the model to comply with an injection, so the pass condition is
  **the barrier held**, never *the model refused* — a distinction that matters, because in practice the
  model **did** comply and membership validation rejected the whole selection.
- **live-closure** (must pass **100%**): required closure interpretations whose correctness depends on
  the configured model.
- **live-operation** (must pass **100%**): top-level regression, broad/inventory, route-specific
  operations, second-person boundaries, and deterministic VIGA Bucks/domain handling.
- **live-catalog** (must pass **100%**): category recall, honest empty matches, payment matching, and
  the inventory → empty-match sequence for an absent item.
- **live-quality** (recorded, non-fatal): what the brain is trusted for. Observed output is printed so
  two candidate models can be compared run against run.

A required-group failure **stops and reports**; fixtures are never edited to go green.

**A run reports three outcomes, not two (B-089).** Every seam collapses `provider_error` into its
ordinary failure outcome *on purpose* — a sender who could not be understood is owed the same honest
reply either way — so a provider outage once surfaced as ten fixtures returning `{"kind":"unclear"}`,
indistinguishable from the model getting worse. `createTransportObserver` wraps the provider and
counts throws out of `generateJson`, the last place the difference still exists; a fixture whose call
never landed is tallied **`couldNotRun`** — neither pass nor fail — and the run exits **2** reporting
"N fixtures could not run". Three rules make it trustworthy: a genuine failure always **outranks** an
outage, so an outage cannot launder a regression into "inconclusive"; an incomplete run is **not** a
pass, because a gate that proved nothing must not read as one; and a fixture that **passed** through
a dead provider still passes, because a code-enforced barrier holding against no answer is exactly
what a containment fixture asserts.

**The classifier's accepted misses are one shared list.** `ADVISORY_CLASSIFIER_CASES`
(`classifier-baseline.ts`) records genuinely ambiguous phrasings — `what is viga`, `when do you
open` — so the corpus fixture and the second-person fixture cannot grade the same phrase under two
policies. They once did, and identical code therefore scored 4/5 or 5/5 run to run. **It is a record
of what was already measured and accepted, never a place to file a case the model started failing**:
a fixture edited to match whatever the model currently does has stopped being a guard.

**How much the classifier actually varies is a measured number, not an impression (B-090).** Twenty
captured runs against `mistralai/Mistral-Small-24B-Instruct-2501` on 2026-08-19: 20/20 green, every
required group at 100% every run, and **only the two catalogued cases ever missed** — `what is viga`
4/20, `when do you open?` 11/20, across ~800 classifications. So the list above is the whole of the
accepted variance, and no threshold is needed. Re-measure this way before ever concluding the model
"flaps" from remembered runs: **a fixture that PASSES can still be moving**, because the corpus
fixture gates on the absence of a *non-baseline* regression, so 51/53 and 53/53 are both green and a
pass/fail tally reports it as perfectly stable. `evals/variance.ts` captures each run to its own file
before parsing and reports score movement separately from pass/fail.

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
