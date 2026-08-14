import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  projectCatalogMatch,
  projectInventoryExtraction,
  projectOfferingExtraction,
  projectRequestClassification,
  projectStockOutParse,
  SEAM_OUTPUT_SHAPES,
} from "./projections";
import { interpretationSchema } from "./inventory-seam";
import { catalogMatchSchema, stockOutSchema } from "./inquiry-seam";
import { offeringsSchema } from "./offering-seam";
import {
  REQUEST_CATEGORIES,
  requestClassificationSchema,
} from "./request-classification";

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
  "catalog-match": catalogMatchSchema,
  "stock-out-parse": stockOutSchema,
  "offering-extraction": offeringsSchema,
  "request-classification": requestClassificationSchema,
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

  /**
   * The same coverage rule for the one seam whose schema is a bare enum rather than a
   * discriminated union.
   *
   * The test above skips non-union schemas, so without this a seventh category could be added
   * to `REQUEST_CATEGORIES` with no documented example — the model would be unable to use a
   * value its schema accepts, which is precisely the drift these tests exist to prevent.
   */
  it("every request category has a documented example, and vice versa", () => {
    const schemaKinds = [...REQUEST_CATEGORIES].sort();
    const exampleKinds = [...new Set(SEAM_OUTPUT_SHAPES["request-classification"]
      .map((shape) => (JSON.parse(shape) as { kind: string }).kind))].sort();
    expect(exampleKinds).toEqual(schemaKinds);
  });

  it("documents every allowed inquiry route and operation, and no impossible one", () => {
    const examples = SEAM_OUTPUT_SHAPES["request-classification"]
      .map((shape) => JSON.parse(shape) as { kind: string; request?: { operation: string } })
      .filter((value) => value.request !== undefined)
      .map((value) => `${value.kind}:${value.request!.operation}`)
      .sort();
    expect(examples).toEqual([
      "search_stands:broad", "search_stands:clarification", "search_stands:hours",
      "search_stands:inventory", "search_stands:payment", "stand_lookup:clarification",
      "stand_lookup:hours", "stand_lookup:inventory", "stand_lookup:location",
      "stand_lookup:overview", "stand_lookup:payment",
    ]);
  });

  it("each projection hands its seam's shapes to the model, verbatim", () => {
    const contexts = [
      projectInventoryExtraction({
        taskText: "x",
        currentEntries: [],
        currentLocalDate: "2026-08-06",
      }),
      projectCatalogMatch({
        taskText: "x",
        catalogType: "inventory",
        values: [],
      }),
      projectStockOutParse({ taskText: "x", listedItems: [] }),
      projectOfferingExtraction({ sourceText: "x" }),
      projectRequestClassification({ taskText: "x" }),
    ];
    // Every seam, no projection missed.
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
