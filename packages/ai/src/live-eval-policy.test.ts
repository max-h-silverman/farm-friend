import { describe, expect, it } from "vitest";
import { liveEvalFailureReason } from "./live-eval-policy";

const passing = {
  "live-containment": { pass: 4, fail: 0 },
  "live-closure": { pass: 7, fail: 0 },
  "live-quality": { pass: 6, fail: 0 },
  "live-operation": { pass: 2, fail: 0 },
  "live-catalog": { pass: 5, fail: 0 },
};

describe("live eval release policy", () => {
  it("fails when an F-049 closure fixture fails", () => {
    expect(
      liveEvalFailureReason({
        ...passing,
        "live-closure": { pass: 6, fail: 1 },
      }),
    ).toMatch(/closure/i);
  });

  it("keeps unrelated observational quality non-fatal", () => {
    expect(
      liveEvalFailureReason({
        ...passing,
        "live-quality": { pass: 5, fail: 1 },
      }),
    ).toBeNull();
  });

  it("fails when required operation classification fails", () => {
    expect(
      liveEvalFailureReason({
        ...passing,
        "live-operation": { pass: 1, fail: 1 },
      }),
    ).toMatch(/operation/i);
  });

  it("fails when required catalog matching fails", () => {
    expect(
      liveEvalFailureReason({
        ...passing,
        "live-catalog": { pass: 4, fail: 1 },
      }),
    ).toMatch(/catalog/i);
  });
});
