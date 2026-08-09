import { describe, expect, it } from "vitest";
import { parseStructuredEdit } from "./farmer-stand-edit";

// The boundary between the form's chips and the typed edit shape. This is untrusted public
// input: the parser owns SHAPE, and `validateInterpretation` owns MEMBERSHIP afterwards.
// Every refusal here is `null`, so a probing client cannot learn which field it got wrong.

describe("parseStructuredEdit", () => {
  it("parses a removal, which is what tapping a chip's × produces", () => {
    expect(
      parseStructuredEdit({ additions: [], changes: [], removals: [{ entryId: "e1" }] }),
    ).toEqual({ kind: "edits", additions: [], changes: [], removals: [{ entryId: "e1" }] });
  });

  it("parses an addition with the detail customers actually see", () => {
    // Quantity, unit and price reach the public map, so the chip has to carry them or the
    // web form would be a downgrade from what SMS already allows.
    expect(
      parseStructuredEdit({
        additions: [{ itemName: "Plum jam", quantity: 6, unit: "jars", priceText: "$6" }],
        changes: [],
        removals: [],
      }),
    ).toEqual({
      kind: "edits",
      additions: [{ itemName: "Plum jam", quantity: 6, unit: "jars", priceText: "$6" }],
      changes: [],
      removals: [],
    });
  });

  it("parses a change, which is editing a chip in place", () => {
    expect(
      parseStructuredEdit({
        additions: [],
        changes: [{ entryId: "e1", quantity: 6 }],
        removals: [],
      }),
    ).toEqual({
      kind: "edits",
      additions: [],
      changes: [{ entryId: "e1", quantity: 6 }],
      removals: [],
    });
  });

  it("keeps explicit nulls on changes so the editor can clear optional details", () => {
    expect(
      parseStructuredEdit({
        additions: [],
        changes: [{ entryId: "e1", quantity: null, unit: null, priceText: null }],
        removals: [],
      }),
    ).toEqual({
      kind: "edits",
      additions: [],
      changes: [{ entryId: "e1", quantity: null, unit: null, priceText: null }],
      removals: [],
    });
  });

  it("trims a padded item name rather than publishing the whitespace", () => {
    const parsed = parseStructuredEdit({
      additions: [{ itemName: "  Kale  " }],
      changes: [],
      removals: [],
    });
    expect(parsed?.additions[0]?.itemName).toBe("Kale");
  });

  describe("refusals", () => {
    it("refuses an edit that changes nothing", () => {
      // It would otherwise open a proposal the farmer is asked to confirm, publishing a new
      // revision whose only effect is to restate the current one as freshly confirmed.
      expect(parseStructuredEdit({ additions: [], changes: [], removals: [] })).toBeNull();
    });

    it("refuses an unknown key rather than stripping it", () => {
      // Stripping would silently reinterpret a request we do not understand as a valid edit.
      expect(
        parseStructuredEdit({
          additions: [],
          changes: [],
          removals: [{ entryId: "e1" }],
          publish: true,
        }),
      ).toBeNull();
    });

    it("refuses a consequential field smuggled onto an item", () => {
      expect(
        parseStructuredEdit({
          additions: [{ itemName: "Kale", recipientHash: "abc" }],
          changes: [],
          removals: [],
        }),
      ).toBeNull();
    });

    it("refuses a blank or missing item name", () => {
      expect(
        parseStructuredEdit({ additions: [{ itemName: "   " }], changes: [], removals: [] }),
      ).toBeNull();
      expect(
        parseStructuredEdit({ additions: [{ quantity: 3 }], changes: [], removals: [] }),
      ).toBeNull();
    });

    it("refuses a blank entry id", () => {
      expect(
        parseStructuredEdit({ additions: [], changes: [], removals: [{ entryId: "" }] }),
      ).toBeNull();
    });

    it("refuses a non-finite quantity", () => {
      // `Number(null)` is 0 and NaN survives a bare typeof check — both would reach the
      // database as a quantity a customer then reads.
      for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, "12"]) {
        expect(
          parseStructuredEdit({
            additions: [{ itemName: "Eggs", quantity }],
            changes: [],
            removals: [],
          }),
        ).toBeNull();
      }
    });

    it("refuses an approximation outside the permitted set", () => {
      expect(
        parseStructuredEdit({
          additions: [{ itemName: "Eggs", approximation: "loads" }],
          changes: [],
          removals: [],
        }),
      ).toBeNull();
    });

    it("refuses a missing array rather than defaulting it to empty", () => {
      expect(parseStructuredEdit({ removals: [{ entryId: "e1" }] })).toBeNull();
    });

    it("refuses anything that is not an object", () => {
      for (const value of [null, undefined, "edits", 42, [], true]) {
        expect(parseStructuredEdit(value)).toBeNull();
      }
    });

    it("refuses an array where an item object belongs", () => {
      expect(
        parseStructuredEdit({ additions: [["Kale"]], changes: [], removals: [] }),
      ).toBeNull();
    });

    it("never returns clear_all, which is not expressible from this door", () => {
      // Emptying a stand is removing every chip. A one-shot delete-everything verb reachable
      // from a parsed request body is a sharper edge than the interface needs.
      expect(parseStructuredEdit({ kind: "clear_all" })).toBeNull();
      const parsed = parseStructuredEdit({
        additions: [],
        changes: [],
        removals: [{ entryId: "e1" }],
      });
      expect(parsed?.kind).toBe("edits");
    });
  });
});
