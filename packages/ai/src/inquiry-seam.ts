// Customer inquiry model seams after operation classification.
// The catalog matcher selects unique public values; code validates membership, resolves
// stands, orders authoritative values, pages them, and renders every word customers read.

import { z } from "zod";
import { generateValidated, type LLMProvider } from "./index";
import {
  projectCatalogMatch,
  projectStockOutParse,
  type CatalogType,
  type ListedItemRef,
} from "./projections";

// Strict everywhere: a smuggled `answerText` or `recipient` must be a visible refusal, not a
// silently stripped field. The schemas are exported for output-contracts.test.ts, which proves the documented
// example shapes in projections.ts validate against them. Not part of the seams' runtime API.
export const stockOutSchema = z.discriminatedUnion("kind", [
  // A listed item, chosen by opaque ID from the code-bound location's entries.
  z.object({ kind: z.literal("listed"), entryId: z.string().min(1) }).strict(),
  // Or normalized text for something the stand does not currently list.
  z.object({ kind: z.literal("unlisted"), itemText: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("unclear") }).strict(),
]);

/**
 * One bounded match after the top-level classifier fixed the operation (B-069).
 *
 * No operation field exists, so seeing the catalog cannot change broad into inventory or an
 * understood no-match into clarification. There is no stand identifier or factual prose field.
 */
export const catalogMatchSchema = z.object({ matches: z.array(z.string()) }).strict();

export type CatalogMatchResult =
  | { ok: true; matches: string[] }
  | { ok: false; reason: "invalid_output" | "provider_error" };
export type StockOutParseOutput = z.infer<typeof stockOutSchema>;

/** The only model capability customer inquiry handling needs after classification. */
export interface CatalogMatcher {
  match(input: {
    taskText: string;
    catalogType: CatalogType;
    values: readonly string[];
  }): Promise<CatalogMatchResult>;
}

/**
 * Build the live inquiry seam over a configured provider.
 *
 * Invalid output is refused visibly; provider failure remains distinct so the workflow can
 * report an outage rather than blame the customer's wording.
 */
export function createCatalogMatcher(provider: LLMProvider): CatalogMatcher {
  return {
    async match(input) {
      const result = await generateValidated(
        provider,
        projectCatalogMatch(input),
        catalogMatchSchema,
      );
      if (!result.ok) return { ok: false as const, reason: result.reason };
      return { ok: true as const, matches: result.value.matches };
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
      const result = await generateValidated(provider, ctx, stockOutSchema);
      if (!result.ok) return { kind: "unclear" as const };
      return result.value;
    },
  };
}
