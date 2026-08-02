import { describe, expect, it } from "vitest";
import {
  nextPromptDueSlot,
  type PromptCadence,
} from "./prompt-schedule";

const TZ = "America/Los_Angeles";

describe("scheduled inventory prompt cadence", () => {
  it.each<[PromptCadence, string]>([
    ["every_2_days", "2026-03-09T17:00:00.000Z"],
    ["weekly", "2026-03-14T17:00:00.000Z"],
    ["every_2_weeks", "2026-03-21T17:00:00.000Z"],
  ])("places %s at 10:00 local across spring DST", (cadence, expected) => {
    expect(
      nextPromptDueSlot({
        cadence,
        timeZone: TZ,
        laterOf: new Date("2026-03-07T18:00:00.000Z"),
      }).toISOString(),
    ).toBe(expected);
  });

  it("places the fall transition at 10:00 local rather than adding elapsed hours", () => {
    expect(
      nextPromptDueSlot({
        cadence: "every_2_days",
        timeZone: TZ,
        laterOf: new Date("2026-10-31T17:00:00.000Z"),
      }).toISOString(),
    ).toBe("2026-11-02T18:00:00.000Z");
  });

  it("returns no due slot for a paused preference", () => {
    expect(
      nextPromptDueSlot({
        cadence: "paused",
        timeZone: TZ,
        laterOf: new Date("2026-03-07T18:00:00.000Z"),
      }),
    ).toBeNull();
  });
});
