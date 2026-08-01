import { describe, expect, it } from "vitest";
import { validateInterpretation, type PublishedSnapshot } from "./proposal";

const published: PublishedSnapshot = {
  revisionId: "rev-1",
  entries: [{ entryId: "entry-1", itemName: "Eggs" }],
};

describe("closure interpretation is one section of the farmer update proposal", () => {
  it("accepts closure-only, reopening, and mixed inventory+closure results", () => {
    expect(
      validateInterpretation(
        {
          kind: "closure",
          closure: {
            result: "close",
            closureKind: "temporary",
            startsOn: "2026-08-02",
            closedThrough: "2026-08-04",
          },
        },
        published,
      ).ok,
    ).toBe(true);
    expect(
      validateInterpretation(
        { kind: "closure", closure: { result: "reopen" } },
        published,
      ).ok,
    ).toBe(true);
    expect(
      validateInterpretation(
        {
          kind: "edits",
          additions: [{ itemName: "Kale" }],
          changes: [],
          removals: [],
          closure: {
            result: "close",
            closureKind: "seasonal",
            startsOn: "2026-08-02",
          },
        },
        published,
      ).ok,
    ).toBe(true);
  });

  it("refuses every decisive missing/NULL-equivalent and contradictory close shape", () => {
    const invalid = [
      { result: "close", startsOn: "2026-08-02" },
      { result: "close", closureKind: "temporary" },
      { result: "close", closureKind: "temporary", startsOn: null },
      {
        result: "close",
        closureKind: "seasonal",
        startsOn: "2026-08-02",
        closedThrough: "2026-08-04",
      },
      {
        result: "close",
        closureKind: "temporary",
        startsOn: "2026-08-04",
        closedThrough: "2026-08-02",
      },
      { result: "close", closureKind: "temporary", startsOn: "2026-02-30" },
      { result: "reopen", startsOn: "2026-08-02" },
    ];

    for (const closure of invalid) {
      expect(
        validateInterpretation({ kind: "closure", closure }, published).ok,
        JSON.stringify(closure),
      ).toBe(false);
    }
  });

  it("refuses notes, multiple windows, and other unsupported closure fields visibly", () => {
    for (const closure of [
      { result: "reopen", note: "call first" },
      {
        result: "close",
        closureKind: "temporary",
        startsOn: "2026-08-02",
        windows: [{ startsOn: "2026-08-10" }],
      },
      {
        result: "close",
        closureKind: "temporary",
        startsOn: "2026-08-02",
        recipientHash: "attacker",
      },
    ]) {
      expect(validateInterpretation({ kind: "closure", closure }, published).ok).toBe(
        false,
      );
    }
  });
});

