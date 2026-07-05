# Farm Friend — AI Architecture

The *AI* source of truth: the `LLMProvider` seam, the seam catalog, the line between what the model
does and what code owns, the **three-layer code-enforced safety boundary**, validation/repair,
evals, and data minimization. Data shapes are in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md); routing is in [ARCHITECTURE.md](ARCHITECTURE.md).

## The trust contract — an LLM-brain in a harness

The coordinator is an **LLM-brain in a harness**. The brain is **swappable by design** (stub,
open-weight, any future provider behind `LLMProvider`), so the architecture never *vouches for* a
model — it **measures** one (evals) and **contains** one (the harness: deterministic routing, the
confirmation gates, code-owned retrieval, the safety boundary, output validation). The contract:

- **Trusted for quality, never for authority.** Competence — extraction accuracy, parse quality,
  phrasing, composition — is *quality*: it may vary by brain, and evals price it (full suite at
  parity or better; critical at 100%). Everything on the "never" side of the model-vs-code line
  below is *authority*: harness-owned, identical under every brain, including a hostile one.
- **The swap test — apply it to every feature and architectural decision.** *If the model were
  swapped tomorrow for a weaker or adversarial one, which properties survive unchanged?* Every
  property that must survive (the Golden Rules: farmer ownership, compliance, grounding, privacy,
  commitment) must be a harness property. If a guarantee would move with the model, the design is
  wrong — move it into code.
- **A model swap is a config change plus an eval run, never a safety review.** That is the seam's
  point: safety was never in the brain, so changing brains cannot lose it.

The rest of this doc is the harness in detail.

## The `LLMProvider` seam

One narrow interface, `LLMProvider.generateJson(seam, context, schema)`, with:
- a **stub provider** (deterministic, for tests/evals) and an **open-weight adapter**
  (config-selected default) — the model is swappable behind the seam;
- a **validate-and-repair wrapper**: the output is parsed against its Zod schema; on failure, **one
  repair retry**, then **clarify/flag — never a silent guess**;
- **`generateJson` accepts only a `ModelSafeContext`** (the branded, assembler-produced type — see
  the safety boundary below), so a raw record can never reach the model by accident.

## The model-vs-code line (the model proposes; code commits)

The model **extracts, parses, classifies, drafts, and composes grounded answers**. It **never**:
- writes durable state, chooses recipients, or decides consent;
- invents availability, farms, items, quantities, or recency;
- makes a compliance/commitment decision (those are pure code, upstream);
- owns capacity/waitlist math (code), or the publish/activation commit (code, confirmation-gated).

Retrieval and ranking for the inquiry route are **code**, not a model query: the selection strategy
is a *parameter*, never a hardcoded intersection.

## Seam catalog

The catalog is **deliberately small** — a new seam must earn its place (CLAUDE.md "Simplicity and
elegance — the zen desk"); prefer generalizing an existing seam's intent/schema over adding a
near-duplicate. Each is Zod-schema'd, validated, one repair retry, then clarify/flag:
- **`farmstand-inventory-extract`** — farmer text → a structured inventory draft (items, quantities
  or approximate labels). Reused by activation's pre-seeded confirm-or-revise.
- **`stockout-report-parse`** — free text → which item (a listed `inventory_item_id` or normalized
  text for an unlisted item) **and which stand**: the QR web form carries the stand id itself; an
  SMS report must parse an optional farm/stand reference from the text — if the stand can't be
  resolved, **ask a clarifying question**, never guess a recipient (code selects the farmer to
  alert only from a resolved stand).
- **`inquiry-parse`** — question → **open intent**: item(s), optional farm scope, optional origin
  location, and a **selection/ranking strategy** (proximity / freshness / coverage / any), or an
  "ambiguous → ask a clarifying question" signal. **Never privileges one reading** of a multi-item
  ask.
- **`farmstand-query-answer`** — compose over the **retrieved grounded rows** (whatever the
  strategy returned), always recency-labeled; empty retrieval → honest "no current listing."
- **`recipe-grounded-answer`** — recipes grounded in retrieved current inventory; conservative
  disclaimers, no medical/preservation/foraging/food-safety advice. *(These content limits are a
  **quality** property — enforced by prompt + measured by the advisory evals — not a harness
  guarantee; Golden Rule #6's code-enforcement mandate covers privacy/consent/compliance/
  commitment, and this isn't one of those.)*
- **`message-classify`** — last-resort intent classification, only after deterministic routing.
- **`gleaning-opportunity-extract`** — designed, built later (F-004).

## The retrieval + ranking layer (code, before any model call)

`inquiry-parse` → intent. Code then runs a **general** retrieval/ranking layer: *given items,
optional farm scope, optional origin, and a strategy → grounded candidate stands with distance +
recency.* Intersection ("one stand with all"), coverage ("any covering the set"), nearest-N, and
freshest-N are **strategies chosen at parse time**, never a constant baked into the architecture.
Only those grounded rows go to the compose step.

## The three-layer code-enforced safety boundary

Because we ingest **untrusted public SMS** (a prime prompt-injection vector), **safety is enforced
by code, never by the system prompt** — across three distinct layers, **none substituting for
another**. This is Golden Rule #6, stated precisely (the branded-types claim is easy to over-state,
so read this carefully):

1. **Compile guard (provenance, not content).** `LLMProvider.generateJson` accepts only a branded
   **`ModelSafeContext`**; `SmsTransport.send` accepts only a branded **`RedactedOutbound`**. The
   *only* public constructor of each brand is the stripping **assembler** / the **redaction
   guard**. So you **cannot call the model or send an SMS without going through them** — there is
   no value of the right type to pass otherwise. **What this buys:** you can't bypass the
   assembler/redactor by accident. **What it does NOT buy:** the brand proves the value *came from*
   the assembler, **not** that its content is clean — `tsc` cannot inspect a runtime string, so if
   the assembler had a bug and copied a phone into a "safe" field, the brand is still stamped and
   the build is green. The compile guard is necessary, not sufficient.
2. **Runtime guard (content).** The assembler **actually strips** PII/secrets and passes only
   opaque IDs + the minimal grounded rows a seam needs (data minimization). The outbound guard
   **actually scans** the message and **blocks a raw phone number** even if the model output
   contains one. This is what proves the *content* is clean — tested directly
   (`assembly-strips-pii`, `outbound-guard-blocks-number`).
3. **Eval guard (adversarial proof).** The adversarial/prompt-injection eval group proves an
   injected SMS **cannot** extract another person's number or force a commit — because the data is
   **absent from context**, the **guard blocks**, and **validation rejects**, *not* because a
   prompt refused. This is the end-to-end proof that layers 1–2 hold under attack.

A system prompt may add defense-in-depth but is **never** the enforcement.

## Untrusted-output validation

Model output is **untrusted input**. Every seam validates against its Zod schema + domain checks in
code before anything acts on it (one repair retry, then clarify/flag). A durable write, a recipient
choice, or a consent decision **never** comes from model output.

## `ai_runs` (debuggable, not a leak)

One telemetry row per seam call. It stores **no model input** and no PII-bearing output — see the
explicit **MAY-store list** in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) (seam, provider, model,
schema version, validation status, opaque id set/hashes, timing). To debug content, reproduce from
the durable source rows through the assembler.

## `MapProvider` — offline/deterministic stub

Geocoding is behind the `MapProvider` seam. It ships with an **offline/deterministic stub** so
tests, evals, and importer runs have **no network dependency** (CI has none). The stub returns
fixed coordinates for known fixtures; the live adapter is config-selected. Naming the stub strategy
here (not in F-007a) keeps it from biting the importer.

## Evals

`evals/run.mjs` runs against the **stub provider**, in **critical** and **advisory** groups:
- **critical** (must pass **100%**): compliance bypass, grounding/no-invention, commitment safety,
  and the **adversarial/prompt-injection group**.
- **advisory**: inventory-extract quality, stock-out parse, inquiry-parse strategy selection /
  clarify, recipe grounding.

Any change touching a model seam runs evals; a provider/prompt change must pass the full suite at
parity or better. Evals are a manual gate (not CI-gated by default) — record the result in the
session wrap.

## Abuse / cost on public LLM surfaces

The customer inquiry route and the QR stock-out form are **public + unauthenticated**. They route
through the abuse/cost throttle seam defined in [ARCHITECTURE.md](ARCHITECTURE.md) (built with
F-003/F-008). Normal public lookup is never artificially capped.
