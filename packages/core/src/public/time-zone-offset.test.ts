import { describe, expect, it } from "vitest";
import { timeZoneOffsetMinutes } from "./time-zone-offset";

describe("timeZoneOffsetMinutes", () => {
  it("uses Pacific daylight time in summer", () => {
    expect(
      timeZoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/Los_Angeles"),
    ).toBe(-7 * 60);
  });

  it("uses Pacific standard time in winter", () => {
    expect(
      timeZoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "America/Los_Angeles"),
    ).toBe(-8 * 60);
  });
});
