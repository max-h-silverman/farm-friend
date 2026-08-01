import { describe, expect, it } from "vitest";
import { preflightClosureTiming } from "./closure-timing";

describe("deterministic closure timing preflight", () => {
  it("resolves a month/day range in the current Vashon year", () => {
    expect(
      preflightClosureTiming(
        "Closed August 8 through August 10.",
        "2026-08-06",
      ),
    ).toEqual({
      kind: "proceed",
      evidence: {
        kind: "close",
        closureKind: "temporary",
        startsOn: "2026-08-08",
        closedThrough: "2026-08-10",
      },
    });
  });

  it("treats Sunday as part of this weekend, not the following weekend", () => {
    expect(preflightClosureTiming("Closed this weekend.", "2026-08-09")).toEqual({
      kind: "proceed",
      evidence: {
        kind: "close",
        closureKind: "temporary",
        startsOn: "2026-08-08",
        closedThrough: "2026-08-09",
      },
    });
  });

  it.each([
    "Closed for a while.",
    "The flower cooler is closed this weekend.",
    "Closed August 8-10 and again August 20-22.",
  ])("clarifies before a model for ambiguous input: %s", (taskText) => {
    expect(preflightClosureTiming(taskText, "2026-08-06").kind).toBe(
      "clarification",
    );
  });

  it("clarifies when an explicit end precedes its start", () => {
    expect(
      preflightClosureTiming(
        "Closed August 12 through August 10.",
        "2026-08-06",
      ).kind,
    ).toBe("clarification");
  });

  it("treats an unqualified whole-stand closure as open-ended from today", () => {
    expect(preflightClosureTiming("The stand is closed.", "2026-08-06")).toEqual({
      kind: "proceed",
      evidence: {
        kind: "close",
        closureKind: "temporary",
        startsOn: "2026-08-06",
      },
    });
  });
});
