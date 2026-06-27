import { describe, expect, it } from "vitest";
import { describeInventoryRecency } from "./recency.js";

const now = new Date("2026-06-27T18:00:00.000Z");

describe("describeInventoryRecency", () => {
  it("returns updated-at recency without hiding older inventory", () => {
    const result = describeInventoryRecency({
      updatedAt: new Date("2026-06-25T18:00:00.000Z"),
      now,
    });

    expect(result.visible).toBe(true);
    expect(result.label).toBe("updated 2 days ago");
    expect(result.pastCadence).toBe(false);
  });

  it("marks listings past a farmer configured cadence", () => {
    const result = describeInventoryRecency({
      updatedAt: new Date("2026-06-26T17:00:00.000Z"),
      now,
      cadenceHours: 24,
    });

    expect(result.visible).toBe(true);
    expect(result.pastCadence).toBe(true);
    expect(result.label).toBe("updated 25 hours ago, older than this stand's usual update cadence");
  });
});
