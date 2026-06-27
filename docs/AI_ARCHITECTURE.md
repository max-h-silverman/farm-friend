# Farm Friend AI Architecture

## Core Rule

The model proposes; code commits.

The LLM may extract, classify, draft, summarize, and answer with retrieved context. It must not directly write durable state, choose recipients, decide consent, invent farm availability, or override capacity/sign-up rules.

## Model Access

All model calls go through one provider interface:

```ts
interface LLMProvider {
  generateJson<T>(request: {
    seam: string;
    schemaVersion: string;
    messages: ModelMessage[];
    schema: JsonSchema;
    temperature?: number;
  }): Promise<T>;
}
```

Providers are swappable. Long term, prefer reliable open-weight models through self-hosting or neutral providers. MVP may use Llama, DeepSeek, Mistral, or another provider if it passes evals. No business logic imports provider SDKs directly.

Define schemas in TypeScript with Zod and generate JSON Schema for provider calls where needed. Zod remains the ergonomic source for shared validation, inferred types, and tests; provider adapters receive the generated schema shape.

## Seams

### `farmstand-inventory-extract`

Input: farmer free-form inventory text and farm context.

Output: proposed inventory lines, stand note, missing fields, confidence.

Code responsibilities:

- Validate farmer identity.
- Normalize item names.
- Preserve approximate quantities.
- Ask for confirmation.
- Publish only after confirmation.

### `farmstand-query-answer`

Input: customer question plus retrieved inventory records.

Output: answer text and referenced inventory ids.

Code responsibilities:

- Retrieve inventory before the model call.
- Pass only visible inventory records with explicit `updated at` recency and cadence context where available.
- Reject answers that reference ids not provided.
- Require "no listing found" when retrieval has no supporting record.

### `recipe-grounded-answer`

Input: customer cooking question, retrieved inventory, and general food constraints.

Output: recipe or meal idea grounded in retrieved inventory.

Code responsibilities:

- Allow general cooking knowledge.
- Require every availability claim to map to retrieved inventory.
- Avoid medical/nutrition claims beyond ordinary cooking descriptions.
- Avoid preservation, canning, fermentation, wild-foraging, food-safety, or medical diet advice beyond conservative high-level disclaimers and pointers to authoritative sources.

### `gleaning-opportunity-extract`

Input: VIGA staff free-form opportunity text and known farm/place context.

Output: proposed crop, location, date/time, volunteer range, organizer, reminders, missing fields.

Code responsibilities:

- Validate required fields.
- Ask clarifying questions.
- Confirm before broadcast.
- Compute signup counts from database.

### `message-classify`

Input: free-form inbound message after deterministic keyword parsing.

Output: likely program, intent, and target entity.

Code responsibilities:

- Run only after compliance keyword bypass.
- Use active conversation state before classification.
- Never treat a free-form "yes" as consent unless a pending confirmation or opportunity context exists.

## Validation And Repair

Every model seam uses:

1. JSON schema validation.
2. Domain validation by code.
3. One repair retry for malformed output if useful.
4. Fallback to clarify, flag, or no-answer rather than guessing.

Ambiguous input ends in one of three states:

- filed as a draft with missing fields,
- questioned with a specific clarification,
- flagged/parked for human review.

There is no silent confident guess.

## Evals

Evals are required before changing prompts, schemas, or model providers.

Minimum eval groups:

- Inventory extraction: item lists, approximate quantities, prices, notes, malformed texts.
- Inventory grounding: do not invent farms/items; recency handling; no-result answers.
- Recipe grounding: useful recipes, all availability claims grounded, no unsupported ingredient availability.
- Gleaning extraction: volunteer ranges, dates, locations, reminders, missing fields.
- Compliance bypass: STOP/HELP/JOIN/YES/NO/FLAG never route to the LLM.
- Adversarial: prompt injection inside SMS, fake system instructions, requests to expose private data.

Critical compliance, grounding, and commitment fixtures must pass 100%. Provider changes must pass the full eval suite at parity or better. A cheaper or more open model is not acceptable if it fails grounding or commitment safety.

Eval fixture groups should label cases as `critical` or `advisory`. Critical failures block launch and provider/prompt changes; advisory failures require review but do not automatically block unless they reveal a product safety issue.

## Data Minimization

Model context should include only what the seam needs:

- Use farm names and inventory rows, not raw histories.
- Use opaque ids where possible.
- Avoid phone numbers in model context.
- Do not persist raw prompts/responses in normal operation.
