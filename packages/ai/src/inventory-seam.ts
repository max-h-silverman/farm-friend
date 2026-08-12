// The inventory-extraction seam: the live implementation of core's `InventoryInterpreter`
// port, which F-014 left tested only with deterministic fakes.
//
// The model interprets; CODE decides the consequence. This module owns exactly one step of
// that — turning the farmer's own words into a candidate interpretation. It does not write
// durable state, choose recipients, decide consent, or publish. `applyInterpretedInventory`
// validates whatever comes back against the retrieved snapshot before anything acts on it,
// and the confirmation the farmer sees is code-rendered from typed facts.

import { z } from "zod";
import {
  closureMatchesTiming,
  preflightClosureTiming,
  type ClosureInstruction,
} from "@farm-friend/core";
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
const closureSchema = z.union([
  z.object({ result: z.literal("reopen") }).strict(),
  z
    .object({
      result: z.literal("close"),
      closureKind: z.literal("temporary"),
      startsOn: z.string(),
      closedThrough: nullAsAbsent(z.string()),
    })
    .strict(),
  z
    .object({
      result: z.literal("close"),
      closureKind: z.literal("seasonal"),
      startsOn: z.string(),
    })
    .strict(),
]);

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
      // B-058: an OMITTED edit array defaults to empty rather than failing the whole output.
      // The seam note calls all three required-but-possibly-empty and the live model still
      // drops them (measured: 2 of 15 runs returned `edits` carrying only `removals`), which
      // failed the strict parse and turned a farmer's stock report into "I could not read
      // that." Defaulting invents nothing — an absent array has exactly one possible meaning,
      // and it cannot manufacture an addition, change, or removal. Every entryId that IS
      // present is still membership-checked by `validateInterpretation` against the snapshot.
      additions: z.array(z.object(itemFields).strict()).default([]),
      changes: z
        .array(
          z
            .object({
              entryId: z.string(),
              ...itemFields,
              itemName: nullAsAbsent(z.string().min(1)),
            })
            .strict(),
        )
        .default([]),
      removals: z.array(z.object({ entryId: z.string() }).strict()).default([]),
      closure: nullAsAbsent(closureSchema),
    })
    .strict(),
  z
    .object({ kind: z.literal("clear_all"), closure: nullAsAbsent(closureSchema) })
    .strict(),
  z.object({ kind: z.literal("closure"), closure: closureSchema }).strict(),
  z.object({ kind: z.literal("clarification"), question: z.string().min(1) }).strict(),
]);

/**
 * Drop an inadmissible `closure` key before validation (B-058).
 *
 * Applied ONLY when deterministic code found no closure evidence in the farmer's message, and
 * only to the shapes where closure is an optional side-field. `kind: "closure"` is left alone:
 * there the closure is the whole payload, so stripping it would turn a clean refusal into a
 * parse failure wearing the provider-error question.
 */
function stripClosure(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (!("closure" in record)) return value;
  if (record.kind !== "edits" && record.kind !== "clear_all") return value;
  const { closure: _dropped, ...rest } = record;
  return rest;
}

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
      currentClosure?: import("@farm-friend/core").ClosureInstruction | null;
      currentLocalDate: string;
    }) {
      const timing = preflightClosureTiming(
        request.taskText,
        request.currentLocalDate,
      );
      if (timing.kind === "clarification") {
        return { kind: "clarification" as const, question: timing.question };
      }
      // The ONLY context that crosses the seam, constructed field by field.
      const ctx = projectInventoryExtraction(request);

      // B-058: when code read NO closure evidence out of the message, no closure value the
      // model returns can be admissible — so the key is dropped before the schema sees it.
      // The live model echoes the `closureTiming is {"kind":"none"}` it was shown back as
      // `closureKind: "none"`, which is not a legal kind; letting that reach the strict schema
      // fails the ENTIRE output and throws away the farmer's inventory update with it.
      //
      // This narrows what the model may say, never what code accepts: the schema is unchanged,
      // and on a message that genuinely evidences a closure a malformed one is still refused.
      const schema =
        timing.evidence.kind === "none"
          ? z.preprocess(stripClosure, interpretationSchema)
          : interpretationSchema;

      const result = await generateValidated(provider, ctx, schema);

      if (!result.ok) {
        // Fail toward asking the farmer. A failed call must not look like "no items."
        return {
          kind: "clarification" as const,
          question:
            "Sorry, I could not read that. Could you list what your stand has right now?",
        };
      }
      if (result.value.kind === "clarification") return result.value;

      const closure: ClosureInstruction | undefined = result.value.closure;
      if (closureMatchesTiming(closure, timing.evidence)) return result.value;

      // The model's closure disagrees with what code deterministically read from the message.
      // Code owns closure timing outright, so the model's field carries no authority — but the
      // right consequence depends on whether anything else is in the result.
      //
      // B-058: on `edits`/`clear_all` the closure rides ALONGSIDE real inventory work, and the
      // live model attaches an unevidenced one on messages that mention no closure at all
      // (measured: 5 of 12 runs on "no eggs left at Pinecone Gardens"). Discarding the whole
      // result there answers a farmer's stock report with a question about dates they never
      // raised. When code found NO closure evidence in the message, the field is noise: drop
      // it and keep the work.
      if (timing.evidence.kind === "none" && result.value.kind !== "closure") {
        return { ...result.value, closure: undefined };
      }

      // Otherwise the message really did carry closure evidence and the model contradicted it —
      // a genuine disagreement about a consequential fact — or the result is `kind: "closure"`,
      // where the closure IS the whole payload and dropping it would leave nothing. Ask.
      return {
        kind: "clarification" as const,
        question: "What exact dates should I use for the closure?",
      };
    },
  };
}
