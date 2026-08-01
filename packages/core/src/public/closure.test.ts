import { describe, expect, it } from "vitest";
import { openNow } from "./open-now";
import {
  projectClosure,
  renderClosureStatus,
  VASHON_TIME_ZONE,
  vashonLocalDate,
  type ClosureInstruction,
} from "./closure";

const at = (iso: string) => new Date(iso);

describe("canonical stand closure projection", () => {
  it("uses the one reviewed island timezone", () => {
    expect(VASHON_TIME_ZONE).toBe("America/Los_Angeles");
    expect(vashonLocalDate(at("2026-08-01T06:30:00Z"))).toBe("2026-07-31");
  });

  it("keeps a bounded temporary closure active through its inclusive local end date", () => {
    const instruction: ClosureInstruction = {
      result: "close",
      closureKind: "temporary",
      startsOn: "2026-08-01",
      closedThrough: "2026-08-03",
    };

    const lastLocalMinute = projectClosure(instruction, at("2026-08-04T06:59:00Z"));
    expect(lastLocalMinute.state).toBe("active");
    expect(renderClosureStatus(lastLocalMinute)).toBe("Closed through Aug 3.");

    const nextLocalDay = projectClosure(instruction, at("2026-08-04T07:00:00Z"));
    expect(nextLocalDay).toEqual({ state: "none" });
  });

  it("projects future, seasonal, open-ended, and reopened instructions without inventing a cron", () => {
    expect(
      projectClosure(
        {
          result: "close",
          closureKind: "temporary",
          startsOn: "2026-08-10",
          closedThrough: "2026-08-12",
        },
        at("2026-08-05T19:00:00Z"),
      ).state,
    ).toBe("upcoming");

    expect(
      renderClosureStatus(
        projectClosure(
          { result: "close", closureKind: "seasonal", startsOn: "2026-08-01" },
          at("2026-08-05T19:00:00Z"),
        ),
      ),
    ).toBe("Closed for the season.");

    expect(
      projectClosure(
        { result: "close", closureKind: "temporary", startsOn: "2026-08-01" },
        at("2026-08-05T19:00:00Z"),
      ).state,
    ).toBe("active");

    expect(
      projectClosure({ result: "reopen" }, at("2026-08-05T19:00:00Z")),
    ).toEqual({ state: "none" });
  });

  it("active closure overrides every standing availability fact; future closure does not", () => {
    const availability = {
      season: { kind: "year_round" as const },
      hours: { kind: "all_day" as const },
    };
    const active = projectClosure(
      { result: "close", closureKind: "temporary", startsOn: "2026-08-01" },
      at("2026-08-05T19:00:00Z"),
    );
    const upcoming = projectClosure(
      { result: "close", closureKind: "temporary", startsOn: "2026-08-10" },
      at("2026-08-05T19:00:00Z"),
    );

    expect(
      openNow({
        availability,
        closure: active,
        at: at("2026-08-05T19:00:00Z"),
        utcOffsetMinutes: -7 * 60,
      }).state,
    ).toBe("farmer_closed");
    expect(
      openNow({
        availability,
        closure: upcoming,
        at: at("2026-08-05T19:00:00Z"),
        utcOffsetMinutes: -7 * 60,
      }).state,
    ).toBe("open");
  });
});
