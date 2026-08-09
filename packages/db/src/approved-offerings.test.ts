import { describe, expect, it } from "vitest";
import { findUnknownOfferingStands, parseApprovedOfferings } from "./approved-offerings";

describe("parseApprovedOfferings", () => {
  it("separates reviewed entries from unresolved extraction failures", () => {
    expect(
      parseApprovedOfferings([
        { standName: "Alpha Farm", items: ["eggs", "bok choy"] },
        { standName: "Needs Review" },
      ]),
    ).toEqual({
      approved: [{ standName: "Alpha Farm", items: ["eggs", "bok choy"] }],
      skippedNoItems: ["Needs Review"],
    });
  });

  it("refuses a malformed hand edit instead of seeding a blank tag", () => {
    expect(() =>
      parseApprovedOfferings([{ standName: "Alpha Farm", items: ["eggs", " "] }]),
    ).toThrow(/malformed items array/i);
  });

  it("finds reviewed entries the stand corpus cannot restore", () => {
    expect(
      findUnknownOfferingStands(
        [{ name: "Known Farm" }],
        [
          { standName: "Known Farms", items: ["eggs"] },
          { standName: "Missing Farm", items: ["flowers"] },
        ],
      ),
    ).toEqual(["Missing Farm"]);
  });
});
