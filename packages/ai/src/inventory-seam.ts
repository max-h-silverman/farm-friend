// The inventory-extraction seam: the live implementation of core's `InventoryInterpreter`
// port, which F-014 left tested only with deterministic fakes.
//
// The model interprets; CODE decides the consequence. This module owns exactly one step of
// that — turning the farmer's own words into a candidate interpretation. It does not write
// durable state, choose recipients, decide consent, or publish. `applyInterpretedInventory`
// validates whatever comes back against the retrieved snapshot before anything acts on it,
// and the confirmation the farmer sees is code-rendered from typed facts.

import { z } from "zod";
import { generateValidated, nullAsAbsent, type LLMProvider } from "./index";
import { projectInventoryExtraction } from "./projections";

/**
 * The permitted output shapes. Structural validation here is the FIRST check, not the
 * grounding one: `validateInterpretation` in core still re-checks every selected entry ID
 * against the retrieved snapshot and rejects consequential fields. Both run — this schema
 * cannot see the snapshot, and core's validator is the authority on membership.
 */
const itemFields = {
  itemName: z.string().min(1),
  quantity: nullAsAbsent(z.number().finite()),
  unit: nullAsAbsent(z.string()),
  priceText: nullAsAbsent(z.string()),
  approximation: nullAsAbsent(z.enum(["some", "limited", "plentiful"])),
};

// Every member is `.strict()`, INCLUDING at the top level. Zod strips unknown keys by
// default rather than rejecting them, which would silently discard a smuggled `publish`
// or `recipientHash` instead of refusing the output that tried to carry it. Stripping
// would still be safe — code owns publication regardless — but "the model attempted a
// consequence" must be a visible refusal, not an invisible cleanup.
// Exported for output-contracts.test.ts, which proves the documented example shapes in
// projections.ts validate against this exact schema. Not part of the seam's runtime API.
export const interpretationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("edits"),
      additions: z.array(z.object(itemFields).strict()),
      changes: z.array(
        z
          .object({
            entryId: z.string(),
            ...itemFields,
            itemName: nullAsAbsent(z.string().min(1)),
          })
          .strict(),
      ),
      removals: z.array(z.object({ entryId: z.string() }).strict()),
    })
    .strict(),
  z.object({ kind: z.literal("clear_all") }).strict(),
  z.object({ kind: z.literal("clarification"), question: z.string().min(1) }).strict(),
]);

/** What the seam concluded, or why it could not. */
export type InterpretationAttempt =
  | { ok: true; value: z.infer<typeof interpretationSchema> }
  | { ok: false; reason: "invalid_output" | "provider_error" };

/**
 * Build the live inventory interpreter over a configured provider.
 *
 * The returned object satisfies core's `InventoryInterpreter` port, so the authoritative
 * workflow is unchanged: it still calls `interpret` outside every database transaction and
 * still validates the result against the base snapshot.
 *
 * On a provider error or unrepairable output, the seam returns a clarification rather than
 * guessing — never a silent invention (docs/AI_ARCHITECTURE.md §"The model provider seam").
 */
export function createInventoryInterpreter(provider: LLMProvider) {
  return {
    async interpret(request: {
      taskText: string;
      currentEntries: { entryId: string; itemName: string }[];
    }) {
      // The ONLY context that crosses the seam, constructed field by field.
      const ctx = projectInventoryExtraction(request);

      const result = await generateValidated(
        provider,
        ctx,
        "inventory-extraction",
        interpretationSchema,
      );

      if (!result.ok) {
        // Fail toward asking the farmer. A failed call must not look like "no items."
        return {
          kind: "clarification" as const,
          question:
            "Sorry, I could not read that. Could you list what your stand has right now?",
        };
      }
      return result.value;
    },
  };
}
