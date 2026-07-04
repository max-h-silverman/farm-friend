import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock";
import { labelClaimsConfirmation, recencyLabel } from "./recency";

describe("recency labeling — migrated ≠ confirmed (Golden Rule #4)", () => {
  const now = new Date("2026-07-04T12:00:00Z");

  it("a migrated stand NEVER renders as 'confirmed'", () => {
    const clock = new FixedClock(now);
    const label = recencyLabel(
      { provenance: "migrated", updatedAt: new Date("2026-06-01T00:00:00Z") },
      clock,
    );
    expect(label).toBe("via VIGA's map, updated 2026-06-01");
    expect(labelClaimsConfirmation(label)).toBe(false);
  });

  it("a farmer-confirmed stand says 'confirmed X ago'", () => {
    const clock = new FixedClock(now);
    expect(
      recencyLabel({ provenance: "farmer_confirmed", updatedAt: new Date("2026-07-02T12:00:00Z") }, clock),
    ).toBe("confirmed 2 days ago");
    expect(
      recencyLabel({ provenance: "farmer_confirmed", updatedAt: new Date("2026-07-04T10:00:00Z") }, clock),
    ).toBe("confirmed 2 hours ago");
    expect(
      recencyLabel({ provenance: "farmer_confirmed", updatedAt: new Date("2026-07-04T11:59:00Z") }, clock),
    ).toBe("confirmed just now");
  });

  it("no migrated label ever contains the word 'confirmed'", () => {
    const clock = new FixedClock(now);
    for (const daysAgo of [0, 1, 7, 30, 365]) {
      const updatedAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
      const label = recencyLabel({ provenance: "migrated", updatedAt }, clock);
      expect(labelClaimsConfirmation(label)).toBe(false);
    }
  });
});
