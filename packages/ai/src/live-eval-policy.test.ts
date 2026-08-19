import { describe, expect, it } from "vitest";
import { liveEvalFailureReason, liveEvalOutcome } from "./live-eval-policy";

const passing = {
  "live-containment": { pass: 4, fail: 0, couldNotRun: 0 },
  "live-closure": { pass: 7, fail: 0, couldNotRun: 0 },
  "live-quality": { pass: 6, fail: 0, couldNotRun: 0 },
  "live-operation": { pass: 2, fail: 0, couldNotRun: 0 },
  "live-catalog": { pass: 5, fail: 0, couldNotRun: 0 },
};

describe("live eval release policy", () => {
  it("fails when an F-049 closure fixture fails", () => {
    expect(
      liveEvalFailureReason({
        ...passing,
        "live-closure": { pass: 6, fail: 1, couldNotRun: 0 },
      }),
    ).toMatch(/closure/i);
  });

  it("keeps unrelated observational quality non-fatal", () => {
    expect(
      liveEvalFailureReason({
        ...passing,
        "live-quality": { pass: 5, fail: 1, couldNotRun: 0 },
      }),
    ).toBeNull();
  });

  it("fails when required operation classification fails", () => {
    expect(
      liveEvalFailureReason({
        ...passing,
        "live-operation": { pass: 1, fail: 1, couldNotRun: 0 },
      }),
    ).toMatch(/operation/i);
  });

  it("fails when required catalog matching fails", () => {
    expect(
      liveEvalFailureReason({
        ...passing,
        "live-catalog": { pass: 4, fail: 1, couldNotRun: 0 },
      }),
    ).toMatch(/catalog/i);
  });
});

/*
  B-089. A provider outage failed ten fixtures as `{"kind":"unclear"}` — indistinguishable in the
  output from the model getting worse. A fixture whose model call never completed did not measure
  the model at all, so it is neither a pass nor a fail: it COULD NOT RUN, and the run as a whole is
  inconclusive rather than red.
*/
describe("transport failure is not model quality", () => {
  it("reports an incomplete run rather than a quality regression", () => {
    const outcome = liveEvalOutcome({
      ...passing,
      "live-operation": { pass: 0, fail: 0, couldNotRun: 2 },
      "live-quality": { pass: 0, fail: 0, couldNotRun: 6 },
    });
    expect(outcome.status).toBe("incomplete");
    expect(outcome.couldNotRun).toBe(8);
    expect(outcome.message).toMatch(/8 fixtures could not run/i);
    expect(outcome.message).not.toMatch(/quality|regress|got worse/i);
  });

  it("does not let an unreachable required group read as a clean pass", () => {
    const outcome = liveEvalOutcome({
      ...passing,
      "live-containment": { pass: 0, fail: 0, couldNotRun: 4 },
    });
    expect(outcome.status).not.toBe("pass");
    expect(outcome.exitCode).not.toBe(0);
  });

  it("still reports a real quality failure that happened alongside an outage", () => {
    const outcome = liveEvalOutcome({
      ...passing,
      "live-closure": { pass: 5, fail: 1, couldNotRun: 1 },
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/closure/i);
    // The outage is still surfaced; it just does not get to hide the genuine failure.
    expect(outcome.couldNotRun).toBe(1);
  });

  it("passes cleanly when every fixture actually ran", () => {
    const outcome = liveEvalOutcome(passing);
    expect(outcome.status).toBe("pass");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.couldNotRun).toBe(0);
  });

  it("counts a quality-only miss as a pass with the miss recorded", () => {
    const outcome = liveEvalOutcome({
      ...passing,
      "live-quality": { pass: 5, fail: 1, couldNotRun: 0 },
    });
    expect(outcome.status).toBe("pass");
    expect(outcome.couldNotRun).toBe(0);
  });
});
