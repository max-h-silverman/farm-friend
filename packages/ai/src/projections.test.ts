import { describe, expect, it } from "vitest";
import {
  projectInventoryExtraction,
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
    expect(Object.keys(ctx.fields).sort()).toEqual(["currentEntries", "taskText"]);
    expect(ctx.fields.taskText).toBe("tomatoes gone, added kale");
    expect(ctx.fields.currentEntries).toEqual([
      { entryId: "e1", itemName: "tomatoes" },
    ]);
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
