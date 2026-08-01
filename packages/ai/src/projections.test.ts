import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  projectFactSelection,
  projectInquiryInterpretation,
  projectInventoryExtraction,
  projectStockOutParse,
  ProjectionError,
  type ModelSafeContext,
} from "./index";

// F-015 runtime enforcement. These tests prove what the projection DEMONSTRABLY does:
// it constructs one explicit minimal record from named arguments, so a caller cannot
// widen the model's view by handing it a bigger object. They do not claim the task text
// itself is scanned clean — a farmer may voluntarily type anything into their own message.

describe("inventory-extraction projection — the only permitted model input for the seam", () => {
  it("carries the farmer's own task text and opaque entry identifiers, and nothing else", () => {
    const ctx = projectInventoryExtraction({
      taskText: "tomatoes gone, added kale",
      currentEntries: [{ entryId: "e1", itemName: "tomatoes" }],
    });

    expect(ctx.seam).toBe("inventory-extraction");
    expect(Object.keys(ctx.fields).sort()).toEqual([
      "currentClosure",
      "currentEntries",
      "taskText",
    ]);
    expect(ctx.fields.taskText).toBe("tomatoes gone, added kale");
    expect(ctx.fields.currentEntries).toEqual([
      { entryId: "e1", itemName: "tomatoes" },
    ]);
    expect(ctx.fields.currentClosure).toBeNull();
  });

  it("copies only canonical closure facts and cannot leak a wider row", () => {
    const currentClosure = {
      result: "close" as const,
      closureKind: "temporary" as const,
      startsOn: "2026-08-02",
      closedThrough: "2026-08-04",
      farmerNote: "private note",
      ownerPhoneHash: "deadbeef",
    };
    const ctx = projectInventoryExtraction({
      taskText: "open again",
      currentEntries: [],
      currentClosure,
    });

    expect(ctx.fields.currentClosure).toEqual({
      result: "close",
      closureKind: "temporary",
      startsOn: "2026-08-02",
      closedThrough: "2026-08-04",
    });
    expect(JSON.stringify(ctx)).not.toContain("private note");
    expect(JSON.stringify(ctx)).not.toContain("deadbeef");
  });

  it("copies each entry field-by-field, so an over-broad record cannot widen the context", () => {
    // A caller passing a full database row must not leak its other columns: the
    // projection reads only the two fields the seam is defined to receive.
    const overBroad = {
      entryId: "e1",
      itemName: "tomatoes",
      farmerPhoneHash: "deadbeef",
      internalNote: "owner is behind on dues",
      salesLocationId: "loc-1",
    } as { entryId: string; itemName: string };

    const ctx = projectInventoryExtraction({
      taskText: "still have tomatoes",
      currentEntries: [overBroad],
    });

    expect(Object.keys(ctx.fields.currentEntries[0]!).sort()).toEqual([
      "entryId",
      "itemName",
    ]);
    expect(JSON.stringify(ctx)).not.toContain("deadbeef");
    expect(JSON.stringify(ctx)).not.toContain("behind on dues");
  });

  it("does not alias the caller's arrays or objects, so later mutation cannot widen it", () => {
    const entries = [{ entryId: "e1", itemName: "tomatoes" }];
    const ctx = projectInventoryExtraction({ taskText: "hi", currentEntries: entries });

    entries.push({ entryId: "e2", itemName: "secret crop" });
    (entries[0] as Record<string, unknown>).internalNote = "leaked";

    expect(ctx.fields.currentEntries).toHaveLength(1);
    expect(Object.keys(ctx.fields.currentEntries[0]!).sort()).toEqual([
      "entryId",
      "itemName",
    ]);
  });

  it("refuses a raw phone number in the retrieved public facts (named fail-closed rule)", () => {
    // Public listing text is Farm Friend-held data, so a raw phone there is our bug and
    // fails closed. This is the named raw-phone class only — not a universal detector.
    expect(() =>
      projectInventoryExtraction({
        taskText: "still have kale",
        currentEntries: [{ entryId: "e1", itemName: "call (206) 555-1234 for kale" }],
      }),
    ).toThrow(ProjectionError);
  });

  it("accepts the current sender's own text verbatim, including text it cannot vet", () => {
    // The farmer's own message returns only to that farmer. Farm Friend does not claim to
    // detect every sensitive phrase a sender voluntarily types about themselves.
    const ctx = projectInventoryExtraction({
      taskText: "reach me at 206-555-1234, kale is out",
      currentEntries: [],
    });
    expect(ctx.fields.taskText).toContain("kale is out");
  });

  it("produces a branded context the low-level provider accepts", () => {
    const ctx: ModelSafeContext = projectInventoryExtraction({
      taskText: "kale",
      currentEntries: [],
    });
    expect(ctx.seam).toBe("inventory-extraction");
  });
});

describe("inquiry-interpretation projection — the question, and no facts", () => {
  it("carries only the customer's own question", () => {
    const ctx = projectInquiryInterpretation({ taskText: "who has kale today?" });
    expect(ctx.seam).toBe("inquiry-interpretation");
    expect(Object.keys(ctx.fields)).toEqual(["taskText"]);
    expect(ctx.fields.taskText).toBe("who has kale today?");
  });

  it("cannot be handed retrieved facts, so it cannot answer from context", () => {
    // The type test proves this statically; this records the intent at runtime too.
    const ctx = projectInquiryInterpretation({ taskText: "kale?" });
    expect(JSON.stringify(ctx)).not.toContain("factId");
  });
});

describe("grounded-fact-selection projection — the facts, and no raw customer text", () => {
  const facts = [
    {
      factId: "f1",
      farmName: "Alpha Farm",
      locationName: "Alpha Stand",
      matchedItemNames: ["kale"],
      ageHours: 2,
      basis: "confirmed" as const,
    },
  ];

  it("carries the validated intent and the exact retrieved facts", () => {
    const ctx = projectFactSelection({ items: ["kale"], ranking: "freshest", facts });
    expect(ctx.seam).toBe("grounded-fact-selection");
    expect(Object.keys(ctx.fields).sort()).toEqual(["facts", "items", "ranking"]);
    expect(ctx.fields.facts[0]!.factId).toBe("f1");
  });

  it("does not carry the customer's raw text, where an injection would live", () => {
    const ctx = projectFactSelection({ items: ["kale"], ranking: "any", facts });
    expect(JSON.stringify(ctx)).not.toContain("taskText");
  });

  it("copies each fact field-by-field, so an over-broad row cannot widen it", () => {
    const overBroad = {
      factId: "f1",
      farmName: "Alpha Farm",
      locationName: "Alpha Stand",
      matchedItemNames: ["kale"],
      ageHours: 2,
      basis: "confirmed" as const,
      farmerPhoneHash: "deadbeef",
      internalNote: "owner behind on dues",
    } as (typeof facts)[number];

    const ctx = projectFactSelection({ items: ["kale"], ranking: "any", facts: [overBroad] });
    expect(Object.keys(ctx.fields.facts[0]!).sort()).toEqual([
      "ageHours",
      "basis",
      "factId",
      "farmName",
      "locationName",
      "matchedItemNames",
    ]);
    expect(JSON.stringify(ctx)).not.toContain("deadbeef");
    expect(JSON.stringify(ctx)).not.toContain("behind on dues");
  });

  it("omits ageHours for an offering rather than sending a fabricated zero (F-045)", () => {
    // An offering is a standing description nobody confirmed, so it has no age. A zero here
    // would read to the model as "confirmed just now" — the strongest possible claim
    // attached to the weakest possible fact.
    const ctx = projectFactSelection({
      items: ["lamb"],
      ranking: "any",
      facts: [
        {
          factId: "offering-1",
          farmName: "Alpha Farm",
          locationName: "Alpha Stand",
          matchedItemNames: ["frozen lamb"],
          basis: "offering",
        },
      ],
    });
    expect(Object.keys(ctx.fields.facts[0]!).sort()).toEqual([
      "basis",
      "factId",
      "farmName",
      "locationName",
      "matchedItemNames",
    ]);
    expect(JSON.stringify(ctx)).not.toContain("ageHours");
  });

  it("refuses a raw phone in retrieved public facts", () => {
    expect(() =>
      projectFactSelection({
        items: ["kale"],
        ranking: "any",
        facts: [{ ...facts[0]!, locationName: "Call 206-555-1234 Stand" }],
      }),
    ).toThrow(ProjectionError);
  });
});

describe("stock-out-parse projection — no location identifier in or out", () => {
  it("carries the reporter's text and the bound location's listed items", () => {
    const ctx = projectStockOutParse({
      taskText: "the kale bin was empty",
      listedItems: [{ entryId: "e1", itemName: "Kale" }],
    });
    expect(ctx.seam).toBe("stock-out-parse");
    expect(Object.keys(ctx.fields).sort()).toEqual(["listedItems", "taskText"]);
    expect(ctx.fields.listedItems[0]!.entryId).toBe("e1");
  });

  it("never carries a sales-location identifier — code binds that from the surface", () => {
    const ctx = projectStockOutParse({
      taskText: "empty",
      listedItems: [{ entryId: "e1", itemName: "Kale" }],
    });
    expect(JSON.stringify(ctx)).not.toContain("salesLocation");
    expect(JSON.stringify(ctx)).not.toContain("recipient");
  });

  it("copies listed items field-by-field", () => {
    const overBroad = {
      entryId: "e1",
      itemName: "Kale",
      salesLocationId: "loc-1",
    } as { entryId: string; itemName: string };

    const ctx = projectStockOutParse({ taskText: "empty", listedItems: [overBroad] });
    expect(Object.keys(ctx.fields.listedItems[0]!).sort()).toEqual(["entryId", "itemName"]);
    expect(JSON.stringify(ctx)).not.toContain("loc-1");
  });
});

describe("opaque identifiers are checked for shape, never scanned as content", () => {
  // Regression: UUIDs contain long digit runs and matched the raw-phone pattern by chance
  // (~1 in 4 integration runs), which randomly refused legitimate requests. An identifier has
  // no phone semantics to protect; scanning one is a false positive with no upside.
  it("accepts UUID identifiers across many draws, in every projection", () => {
    for (let i = 0; i < 500; i++) {
      const id = randomUUID();
      expect(() =>
        projectInventoryExtraction({
          taskText: "kale",
          currentEntries: [{ entryId: id, itemName: "Kale" }],
        }),
      ).not.toThrow();
      expect(() =>
        projectFactSelection({
          items: ["kale"],
          ranking: "any",
          facts: [
            {
              factId: id,
              farmName: "Alpha Farm",
              locationName: "Alpha Stand",
              matchedItemNames: ["Kale"],
              ageHours: 1,
              basis: "confirmed" as const,
            },
          ],
        }),
      ).not.toThrow();
      expect(() =>
        projectStockOutParse({ taskText: "gone", listedItems: [{ entryId: id, itemName: "Kale" }] }),
      ).not.toThrow();
    }
  });

  it("accepts a UUID that literally contains a phone-shaped digit run", () => {
    // Constructed to match RAW_PHONE_RE if it were scanned as content.
    const id = "2065551234-4d1f-4c2b-8f3a-1234567890ab";
    expect(() =>
      projectFactSelection({
        items: ["kale"],
        ranking: "any",
        facts: [
          {
            factId: id,
            farmName: "Alpha Farm",
            locationName: "Alpha Stand",
            matchedItemNames: ["Kale"],
            ageHours: 1,
            basis: "confirmed" as const,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("still refuses free text smuggled through an identifier field", () => {
    // The guarantee an ID needs is that it IS an id, not that it is phone-free.
    for (const notAnId of ["call me at 206-555-1234", "id with spaces", "", "a".repeat(200)]) {
      expect(() =>
        projectStockOutParse({
          taskText: "gone",
          listedItems: [{ entryId: notAnId, itemName: "Kale" }],
        }),
      ).toThrow(ProjectionError);
    }
  });

  it("still refuses a raw phone in human-readable retrieved text", () => {
    // The content rule stays where it means something: display text.
    expect(() =>
      projectFactSelection({
        items: ["kale"],
        ranking: "any",
        facts: [
          {
            factId: randomUUID(),
            farmName: "Alpha Farm",
            locationName: "Call 206-555-1234 Stand",
            matchedItemNames: ["Kale"],
            ageHours: 1,
            basis: "confirmed" as const,
          },
        ],
      }),
    ).toThrow(ProjectionError);
  });
});
