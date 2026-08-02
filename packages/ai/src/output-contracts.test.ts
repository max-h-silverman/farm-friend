import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  projectFactSelection,
  projectInquiryInterpretation,
  projectInventoryExtraction,
  projectOfferingExtraction,
  projectStockOutParse,
  SEAM_OUTPUT_SHAPES,
} from "./projections";
import { interpretationSchema } from "./inventory-seam";
import { intentSchema, selectionSchema, stockOutSchema } from "./inquiry-seam";
import { offeringsSchema } from "./offering-seam";

// F-024's first live-model run exposed a defect every scripted suite is structurally blind
// to: the projections attached SMS-composition guidance ("Write a concise SMS reply...") to
// seams whose schemas accept only structured JSON, and nothing anywhere told the model what
// shape was wanted. The real model reasonably returned {"smsReply":"..."}; every seam failed
// validation; and 471 unit tests plus all scripted evals stayed green, because the stub reads
// neither the instructions nor the schema.
//
// These tests pin the correction. The instructions now carry example shapes per seam, and the
// examples are parsed through the REAL schema here — so the prose the model reads cannot
// drift from the validator that judges its output. Instructions remain QUALITY, never
// enforcement: a model that ignores them meets the same validation barriers as ever.

const SCHEMAS: Record<keyof typeof SEAM_OUTPUT_SHAPES, z.ZodTypeAny> = {
  "inventory-extraction": interpretationSchema,
  "inquiry-interpretation": intentSchema,
  "grounded-fact-selection": selectionSchema,
  "stock-out-parse": stockOutSchema,
  "offering-extraction": offeringsSchema,
};

describe("declared-optional fields accept an explicit null as absence (F-024)", () => {
  // The second live-run failure class: instruct models near-universally emit
  // `"quantity": null` for a value the input does not state, and `.optional()` refuses
  // `null`. Null reads as absence ONLY where the schema already declares optionality —
  // the same reasoning as the adapter's code-fence stripping. Unknown keys, null-valued
  // or not, still hit the strict schema's visible refusal.
  it("inventory: nulls in optional item fields parse as absent values", () => {
    const parsed = interpretationSchema.parse({
      kind: "edits",
      additions: [
        {
          itemName: "tomatoes",
          quantity: null,
          unit: null,
          priceText: null,
          approximation: null,
        },
        { itemName: "eggs", quantity: 12, unit: "dozen", priceText: null, approximation: null },
      ],
      changes: [{ entryId: "e1", itemName: null, quantity: 6 }],
      removals: [],
    });
    if (parsed.kind !== "edits") throw new Error("expected edits");
    expect(parsed.additions[0]!.quantity).toBeUndefined();
    expect(parsed.additions[0]!.approximation).toBeUndefined();
    expect(parsed.additions[1]!.quantity).toBe(12);
    expect(parsed.changes[0]!.itemName).toBeUndefined();
  });

  it("inventory: a null-valued UNKNOWN key is still a visible refusal, not a strip", () => {
    const result = interpretationSchema.safeParse({
      kind: "edits",
      additions: [],
      changes: [],
      removals: [],
      publish: null,
    });
    expect(result.success).toBe(false);
  });

  it("intent: nulls in the optional lookup fields parse as absent values", () => {
    const parsed = intentSchema.parse({
      kind: "lookup",
      items: ["bok choy"],
      farmScope: null,
      ranking: "freshest",
      outOfScopeRequest: null,
      originDependent: null,
    });
    if (parsed.kind !== "lookup") throw new Error("expected lookup");
    expect(parsed.farmScope).toBeUndefined();
    expect(parsed.outOfScopeRequest).toBeUndefined();
  });
});

describe("seam output contracts (F-024)", () => {
  it("every documented example shape validates against its seam's real schema", () => {
    for (const [seam, shapes] of Object.entries(SEAM_OUTPUT_SHAPES)) {
      const schema = SCHEMAS[seam as keyof typeof SCHEMAS];
      for (const shape of shapes) {
        const result = schema.safeParse(JSON.parse(shape));
        expect(
          result.success,
          `seam "${seam}" documents an example its schema refuses: ${shape}`,
        ).toBe(true);
      }
    }
  });

  it("every kind a union schema accepts has a documented example, and vice versa", () => {
    // A schema gaining a shape the instructions never mention would leave the model unable
    // to use it; an instruction mentioning a removed shape would teach a refused output.
    for (const [seam, schema] of Object.entries(SCHEMAS)) {
      if (!(schema instanceof z.ZodDiscriminatedUnion)) continue;
      const schemaKinds = (schema.options as z.AnyZodObject[])
        .map((option) => (option.shape.kind as z.ZodLiteral<string>).value)
        .sort();
      const exampleKinds = [
        ...new Set(
          SEAM_OUTPUT_SHAPES[seam as keyof typeof SEAM_OUTPUT_SHAPES].map(
            (shape) => (JSON.parse(shape) as { kind: string }).kind,
          ),
        ),
      ].sort();
      expect(exampleKinds, `seam "${seam}" examples do not cover its kinds`).toEqual(
        schemaKinds,
      );
    }
  });

  it("each projection hands its seam's shapes to the model, verbatim", () => {
    const contexts = [
      projectInventoryExtraction({
        taskText: "x",
        currentEntries: [],
        currentLocalDate: "2026-08-06",
      }),
      projectInquiryInterpretation({ taskText: "x" }),
      projectFactSelection({ items: ["kale"], ranking: "freshest", facts: [] }),
      projectStockOutParse({ taskText: "x", listedItems: [] }),
      projectOfferingExtraction({ sourceText: "x" }),
    ];
    // All five seams, no projection missed.
    expect(contexts.map((ctx) => ctx.seam).sort()).toEqual(
      Object.keys(SEAM_OUTPUT_SHAPES).sort(),
    );
    for (const ctx of contexts) {
      const shapes = SEAM_OUTPUT_SHAPES[ctx.seam as keyof typeof SEAM_OUTPUT_SHAPES];
      for (const shape of shapes) {
        expect(
          ctx.outputInstructions,
          `projection for "${ctx.seam}" does not carry its documented shapes`,
        ).toContain(shape);
      }
    }
  });

  it("puts closure decision rules before shape templates and requires mixed facts to survive", () => {
    const ctx = projectInventoryExtraction({
      taskText: "Closed this weekend; still have eggs.",
      currentEntries: [],
      currentLocalDate: "2026-08-06",
    });
    const instructions = ctx.outputInstructions;

    expect(instructions).toContain("EVERY independent fact");
    expect(instructions).toContain("closureTiming");
    expect(instructions.indexOf("EVERY independent fact")).toBeLessThan(
      instructions.indexOf('{"kind":"edits"'),
    );
  });
});
