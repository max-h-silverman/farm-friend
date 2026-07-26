// The customer inquiry seams: interpretation, then grounded fact selection.
//
// Two calls with a code-owned retrieval step between them (docs/AI_ARCHITECTURE.md
// §"Retrieval and ranking"). The order is load-bearing:
//
//   deterministic routing → interpret(question) → CODE retrieves → select(facts) → CODE renders
//
// The first call decides *what to look up* and never sees a fact. The second orders *what code
// found* and never sees the raw question. Neither authors a word the customer reads: selection
// returns identifiers, and the renderer in `@farm-friend/core` dereferences authoritative
// values. A model that wants to invent availability has nowhere to put it.

import { z } from "zod";
import { generateValidated, type LLMProvider } from "./index";
import {
  projectFactSelection,
  projectInquiryInterpretation,
  projectStockOutParse,
  type RetrievedFactRef,
  type ListedItemRef,
} from "./projections";

// Strict everywhere: a smuggled `answerText` or `recipient` must be a visible refusal, not a
// silently stripped field. Ranking is validated again in core against what code can execute.
const intentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("lookup"),
      items: z.array(z.string().min(1)).min(1),
      farmScope: z.string().min(1).optional(),
      ranking: z.string().min(1),
      // A boolean, never a message. The model may recognize a recipe/food-safety request;
      // code renders the scope statement (F-018).
      outOfScopeRequest: z.boolean().optional(),
      // Likewise a boolean (F-017). The model may recognize that the request needs the
      // customer's position; launch resolves no arbitrary origin over SMS, so code renders
      // the limitation and the public-map link. `.strict()` below is what makes a smuggled
      // `latitude`, `distanceMiles`, or `nearest` a visible refusal rather than a stripped
      // field — the model has no way to supply geography at all.
      originDependent: z.boolean().optional(),
    })
    .strict(),
  // A bare signal. `question` was removed in F-018: it was the one field through which
  // model prose reached a customer verbatim. Code renders the clarification.
  z.object({ kind: z.literal("ambiguous") }).strict(),
]);

const selectionSchema = z.discriminatedUnion("kind", [
  // Identifiers only. There is deliberately no field here that could carry prose.
  z.object({ kind: z.literal("selection"), factIds: z.array(z.string()) }).strict(),
  // Likewise a bare signal (F-018) — code renders the question.
  z.object({ kind: z.literal("clarification") }).strict(),
]);

const stockOutSchema = z.discriminatedUnion("kind", [
  // A listed item, chosen by opaque ID from the code-bound location's entries.
  z.object({ kind: z.literal("listed"), entryId: z.string().min(1) }).strict(),
  // Or normalized text for something the stand does not currently list.
  z.object({ kind: z.literal("unlisted"), itemText: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("unclear") }).strict(),
]);

export type InterpretedIntentOutput = z.infer<typeof intentSchema>;
/** The seam refused the model's output. `invalid_output` means the shape was rejected. */
export type SeamRefusal = { kind: "refused"; reason: "invalid_output" | "provider_error" };
export type FactSelectionOutput = z.infer<typeof selectionSchema> | SeamRefusal;
export type StockOutParseOutput = z.infer<typeof stockOutSchema>;

/** The inquiry seams, as the workflow consumes them. */
export interface InquiryModel {
  interpret(input: { taskText: string }): Promise<InterpretedIntentOutput>;
  select(input: {
    items: readonly string[];
    ranking: string;
    facts: readonly RetrievedFactRef[];
  }): Promise<FactSelectionOutput>;
}

/**
 * Build the live inquiry seams over a configured provider.
 *
 * Both calls fail toward asking rather than guessing: an unrepairable or erroring model
 * yields a clarification, never a fabricated lookup or an empty selection that would read as
 * "nobody has this."
 */
export function createInquiryModel(provider: LLMProvider): InquiryModel {
  return {
    async interpret(input) {
      const ctx = projectInquiryInterpretation({ taskText: input.taskText });
      const result = await generateValidated(
        provider,
        ctx,
        "inquiry-interpretation",
        intentSchema,
      );
      if (!result.ok) {
        // Fail toward asking rather than guessing. The words are code's, rendered by the
        // caller from this signal.
        return { kind: "ambiguous" as const };
      }
      return result.value;
    },

    async select(input) {
      const ctx = projectFactSelection({
        items: input.items,
        ranking: input.ranking,
        facts: input.facts,
      });
      const result = await generateValidated(
        provider,
        ctx,
        "grounded-fact-selection",
        selectionSchema,
      );
      if (!result.ok) {
        // Distinguish the two failures rather than collapsing them. A provider error is a
        // transient malfunction the customer should be asked about; INVALID OUTPUT means the
        // model returned a shape this seam refuses — typically a smuggled factual string —
        // and the workflow must be able to reject that visibly rather than see a polite
        // clarification. Either way no invented text is deliverable; the difference is
        // whether an attack is observable.
        return { kind: "refused" as const, reason: result.reason };
      }
      return result.value;
    },
  };
}

/** The stock-out item-parsing seam, used only by the code-bound web/QR surface. */
export interface StockOutModel {
  parseItem(input: {
    taskText: string;
    listedItems: readonly ListedItemRef[];
  }): Promise<StockOutParseOutput>;
}

export function createStockOutModel(provider: LLMProvider): StockOutModel {
  return {
    async parseItem(input) {
      const ctx = projectStockOutParse({
        taskText: input.taskText,
        listedItems: input.listedItems,
      });
      const result = await generateValidated(provider, ctx, "stock-out-parse", stockOutSchema);
      if (!result.ok) return { kind: "unclear" as const };
      return result.value;
    },
  };
}
