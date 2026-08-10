// The customer-message-intent seam: classify an unauthenticated customer's free text before
// code decides whether to answer a question or open a stock-out report.
//
// WHY THIS IS A SIBLING OF THE FARMER SEAM RATHER THAN A FIELD ON THE INQUIRY SEAM.
// The inquiry-interpretation seam decides *what the customer wants looked up*, and every
// working customer answer flows through it. Teaching it a second job — "or is this a report?"
// — would put that path at risk for a message class it currently handles correctly. This is
// the same shape the authorized-farmer path already uses (`farmer-message-intent`), in the
// same position: a finite route signal, taken before the seam that does the real work. When
// the answer is `farm_stand_question` the customer path runs exactly as it did before.
//
// The model supplies a route signal and nothing else. It cannot name a stand, choose a
// recipient, record a report, or author a reply. Which stand a report belongs to is resolved
// by code from the customer's own answer to a code-rendered question — never from here.

import { z } from "zod";
import { generateValidated, type LLMProvider } from "./index";
import { projectCustomerMessageIntent } from "./projections";

export const customerMessageIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stock_out_report") }).strict(),
  z.object({ kind: z.literal("farm_stand_question") }).strict(),
]);

export type CustomerMessageIntent = z.infer<typeof customerMessageIntentSchema>;

export interface CustomerMessageIntentModel {
  classify(input: { taskText: string }): Promise<CustomerMessageIntent>;
}

/**
 * Build the finite customer intent classifier over the configured provider.
 *
 * **The fallback is `farm_stand_question`, not an `unclear` third arm.** Two reasons, and
 * both are load-bearing. First, it is the conservative direction: answering a question that
 * was really a report costs the customer a follow-up, while inventing a report nobody made
 * texts a farmer about stock that never sold out. Second, it preserves today's behavior
 * exactly — a refused or unreachable model leaves the customer path as it is rather than
 * degrading it, so this seam cannot break what already works by failing.
 */
export function createCustomerMessageIntentModel(
  provider: LLMProvider,
): CustomerMessageIntentModel {
  return {
    async classify(input) {
      const result = await generateValidated(
        provider,
        projectCustomerMessageIntent(input),
        customerMessageIntentSchema,
      );
      if (!result.ok) return { kind: "farm_stand_question" };
      return result.value;
    },
  };
}
