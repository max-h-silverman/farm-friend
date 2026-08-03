// The farmer-message-intent seam: classify an authorized farmer's free text before
// code resolves an inventory-update target.
//
// The model only supplies a route signal. It cannot choose a stand, publish inventory, or
// author a customer-facing reply. Every consequence remains in the existing code-owned
// inventory and inquiry workflows.

import { z } from "zod";
import { generateValidated, type LLMProvider } from "./index";
import { projectFarmerMessageIntent } from "./projections";

export const farmerMessageIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inventory_update") }).strict(),
  z.object({ kind: z.literal("farm_stand_question") }).strict(),
  z.object({ kind: z.literal("unclear") }).strict(),
]);

export type FarmerMessageIntent = z.infer<typeof farmerMessageIntentSchema>;

export interface FarmerMessageIntentModel {
  classify(input: { taskText: string }): Promise<FarmerMessageIntent>;
}

/** Build the finite intent classifier over the configured provider. */
export function createFarmerMessageIntentModel(
  provider: LLMProvider,
): FarmerMessageIntentModel {
  return {
    async classify(input) {
      const result = await generateValidated(
        provider,
        projectFarmerMessageIntent(input),
        farmerMessageIntentSchema,
      );
      if (!result.ok) return { kind: "unclear" };
      return result.value;
    },
  };
}
