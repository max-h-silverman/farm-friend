// The offering-extraction seam (F-035, F-036): what a stand USUALLY carries.
//
// WHY A MODEL AND NOT A REGEX. Splitting "eggs, plant starts, veggies" on commas is easy;
// reading "Specializing in Asian vegetables, including gailan, bok choy, perilla, a choy, and
// more. Not certified, but following organic practices" is not. The deterministic draft this
// replaced produced customer-facing filter tags like "rotational grazing for chickens",
// "special occasions...etc..", "but following organic practices", and "plums ijuly)".
// Distinguishing an offering from a farming-practice clause requires reading the sentence,
// and no amount of regex tuning over 31 stands generalizes to the 32nd.
//
// WHAT THE MODEL IS TRUSTED WITH. Proposing tags from text VIGA already publishes. It is
// trusted for QUALITY, never AUTHORITY (CLAUDE.md's trust contract): it never writes, and the
// seeder records every proposal for human review before code commits it (Golden Rule #3).
//
// SPECIALTIES ARE NOT CURRENT STOCK. Tags land in `sales_location_offerings` and describe what
// a stand usually carries. Current availability comes only from a farmer's confirmed SMS
// through `inventory_revisions`, which requires an authorization and an approval this path
// structurally cannot produce.
//
// WHERE IT RUNS. A build-time ingest script, and — if F-036's farmer web form lands — a farmer
// editing their OWN listing. Never anonymous public discovery: that is the model-backed web
// inquiry surface F-019 removed, and the public map's module graph is policed by
// `apps/web/lib/public-surface-model-free.test.ts`.

import { z } from "zod";
import { generateValidated, type LLMProvider } from "./index";
import { projectOfferingExtraction } from "./projections";

/**
 * A tag is a filter label, not a sentence.
 *
 * `.strict()` at the top level is deliberate: Zod strips unknown keys by default, which would
 * silently discard a smuggled `publish` or `salesLocationId` instead of refusing the output
 * that carried it. Stripping would still be safe — code owns every write regardless — but a
 * model attempting a consequence must be a visible refusal, not an invisible cleanup.
 *
 * The 40-character bound and the four-word limit are what keep sentence fragments out. They
 * are shape rules, not vocabulary rules: no produce taxonomy lives here, and the seam has no
 * opinion about whether an aubergine is a vegetable (CLAUDE.md — no food vocabulary in
 * behavioural branches).
 */
// Exported for output-contracts.test.ts, which proves the documented example shape in
// projections.ts validates against this exact schema. Not part of the seam's runtime API.
export const offeringsSchema = z
  .object({
    items: z.array(z.string().trim().min(1).max(40)).max(40),
  })
  .strict()
  .refine(
    (value) => value.items.every((item) => item.trim().split(/\s+/).length <= 4),
    { message: "an offering tag must be at most four words" },
  );

export type OfferingExtraction =
  | { ok: true; items: string[] }
  | { ok: false; reason: "invalid_output" | "provider_error" };

/**
 * Propose the item tags a stand's description implies.
 *
 * An empty `items` array is a REAL answer — Holmestead's "We place a sign at the bottom of the
 * driveway when we are open" names no produce — and is deliberately distinguishable from a
 * failed call. Returning `[]` on provider failure would record "this stand offers nothing", a
 * claim nobody made, and the seeder would commit it silently.
 */
export async function extractOfferings(
  provider: LLMProvider,
  input: { sourceText: string },
): Promise<OfferingExtraction> {
  const context = projectOfferingExtraction({ sourceText: input.sourceText });

  const result = await generateValidated(
    provider,
    context,
    "offerings",
    offeringsSchema,
  );

  if (!result.ok) return { ok: false, reason: result.reason };

  // Normalize for storage: `sales_location_offerings` keys on (location, item), so casing
  // differences would otherwise create duplicate rows for the same produce.
  const items: string[] = [];
  for (const raw of result.value.items) {
    const item = raw.trim().toLowerCase();
    if (item !== "" && !items.includes(item)) items.push(item);
  }

  return { ok: true, items };
}
