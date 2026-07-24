# Farm Friend — AI Architecture

The *AI* source of truth: the trust contract, the model provider seam, the seam catalog, the line
between what the model does and what code owns, the **three-layer code-enforced safety boundary**,
validation, evals, and data minimization. Data shapes are in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); routing is in [ARCHITECTURE.md](ARCHITECTURE.md).

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract; where this doc disagrees, the handoff wins.
>
> **Status: requirements, not claims.** The live model adapter throws; context assembly rejects
> some detected phone-shaped text but does not implement the broader minimization described here;
> output validation checks structure but **does not prove factual grounding**; the grounding eval
> uses a cooperative canned model rather than one attempting unsupported invention; and the
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
- **A model swap is a config change plus an eval run, never a safety review.**

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

Code provides: an allowed task-specific context; general retrieval and geographic operations;
authoritative records; constrained action options; evidence identifiers for factual claims; and
validation before any consequence. The model may propose a search or ranking **interpretation** and
compose the answer; code executes only permitted operations and **rejects claims that cannot be
traced to retrieved records**.

This is the correction to an earlier design that enumerated a closed set of selection strategies:
ranking intent is an **open interpretation the model proposes and code validates and executes**,
never a constant baked into the architecture.

## The model-vs-code line (the model proposes; code commits)

The model **may**: interpret language; infer search intent; propose inventory changes; rank
relevant retrieved options; draft replies; compose recipe ideas; suggest escalation.

**Deterministic code owns**: identity and authority; consent; universal STOP and scoped MUTE;
recipient selection; commitments; transactions; durable writes; publication; idempotency;
retention; provider operations; and **verification that factual claims are supported by retrieved
evidence**.

The model **never** writes durable state, chooses recipients, decides consent, invents
availability, or makes a compliance or commitment decision.

## The model provider seam

One narrow interface, with:
- a **deterministic stub provider** for tests and evals, plus the live adapter (config-selected);
- **schema validation with one repair retry**, then clarify or flag — **never a silent guess**;
- **acceptance of only a safe context** produced by the stripping assembler, so a raw record can
  never reach the model by accident.

## Seam catalog

The catalog is **deliberately small** — a new seam must earn its place; prefer generalizing an
existing seam over adding a near-duplicate. Each is schema-validated, with one repair retry, then
clarify or flag:

- **inventory extraction** — farmer text → a structured inventory proposal (items, quantities or
  approximate labels). Reused wherever a farmer describes stock naturally.
- **stock-out report parsing** — free text → which item (a listed entry or normalized text for an
  unlisted one) **and which location**. The QR web form carries the location itself; an SMS report
  must resolve the location from the text — if it cannot, **ask a clarifying question**, never
  guess a recipient.
- **inquiry interpretation** — question → open intent: item(s), optional farm scope, optional
  origin location, and a **proposed selection/ranking interpretation**, or an "ambiguous → ask"
  signal. **Never privileges one reading** of a multi-item request, and is not restricted to a
  fixed strategy enum.
- **grounded answer composition** — compose over the **retrieved rows only**, always
  recency-labeled; empty retrieval → an honest "no current listing."
- **recipe suggestion** — grounded in retrieved current inventory, with conservative disclaimers
  and no medical, preservation, foraging, or food-safety advice. *(These content limits are a
  **quality** property, enforced by prompt and measured by advisory evals — not a harness
  guarantee. Golden Rule #6's code-enforcement mandate covers privacy, consent, compliance, and
  commitment; this is not one of those.)*
- **message classification** — last-resort intent classification, only after deterministic routing.

SMS composition adds quality guidance to prefer concise, plain-punctuation, emoji-free replies that
fit one GSM-7 segment when practical. This is a **cost and phrasing preference, never a truncation
rule**: important content, names, addresses, and meaning are preserved. The outbound code guard
still performs final normalization and segment estimation.

## Retrieval and ranking (code, before any model call)

Interpretation yields intent. Code then runs a **general** retrieval and geographic layer: *given
items, optional farm scope, optional origin, and a proposed ranking interpretation → candidate
locations with distance and recency.* Intersection, coverage, nearest-N, and freshest-N are
**expressible interpretations**, not an enumerated architecture constant. Only retrieved rows reach
the compose step, and each composed claim carries an **evidence identifier** back to the record
that supports it.

## The three-layer code-enforced safety boundary

Because we ingest **untrusted public SMS** (a prime prompt-injection vector), **safety is enforced
by code, never by the system prompt** — across three distinct layers, **none substituting for
another**. This is Golden Rule #6, stated precisely (the branded-types claim is easy to over-state,
so read this carefully):

1. **Compile guard (provenance, not content).** The model call accepts only a branded **safe
   context**; the SMS send accepts only a branded **redacted outbound**. The *only* public
   constructors are the stripping **context assembler** and the **redaction guard**. So you
   **cannot call the model or send an SMS without going through them**. **What this buys:** you
   can't bypass the assembler or redactor by accident. **What it does NOT buy:** the brand proves
   the value *came from* the assembler, **not** that its content is clean — `tsc` cannot inspect a
   runtime string, so if the assembler had a bug and copied a phone into a "safe" field, the brand
   is still stamped and the build is green. **Necessary, not sufficient.**
2. **Runtime guard (content).** The assembler **actually strips** PII and secrets and passes only
   opaque IDs plus the minimal retrieved rows a seam needs (data minimization). The outbound guard
   **normalizes avoidable typographic Unicode, actually scans** the message, and **blocks a raw
   phone number** even if the model produced one. This is what proves the *content* is clean.
3. **Eval guard (adversarial proof).** The adversarial/prompt-injection eval group must prove an
   injected SMS **cannot** extract another person's number or force a commit — because the data is
   **absent from context**, the **guard blocks**, and **validation rejects**, *not* because a
   prompt refused. This is the end-to-end proof that layers 1–2 hold under attack, and it requires
   a **hostile** model, not a cooperative stub.

A system prompt may add defense-in-depth but is **never** the enforcement.

## Untrusted-output validation

Model output is **untrusted input**. Every seam validates against its schema **and its evidence**
before anything acts on it: structural validity is not grounding. A claim that is well-formed but
untraceable to a retrieved record must be **rejected**. A durable write, a recipient choice, or a
consent decision **never** comes from model output.

## Evals

Evals run against the stub provider in **critical** and **advisory** groups:

- **critical** (must pass **100%**): compliance bypass, grounding and no-invention, commitment
  safety, and the **adversarial/prompt-injection group**.
- **advisory**: extraction quality, stock-out parsing, inquiry interpretation and clarification,
  recipe grounding.

Required corrections to the eval suite: use **hostile models that invent farms, inventory, recency,
directions, or commitments**, and reject unsupported factual claims even when output is
structurally valid. Any change touching a model seam runs evals; a provider or prompt change must
pass the full suite at parity or better.

## Abuse / cost on public model surfaces

The customer inquiry route and the QR stock-out form are **public and unauthenticated**. They route
through the abuse/cost throttle defined in [ARCHITECTURE.md](ARCHITECTURE.md). Normal public lookup
is never artificially capped.
