import { describe, expect, it } from "vitest";
import { fixtureScore, parseLiveEvalRun, summariseVariance } from "./live-eval-variance";

/*
  B-090. These tests are the spec for the instrument that answers "which fixtures ever miss".
  They must be able to FAIL for the right reason: a summariser that reports nothing unstable
  when a fixture flapped is the exact failure mode this work exists to prevent, so the flap
  cases below assert a specific fixture name and a specific count, never merely "non-empty".
*/

const RUN_ALL_PASS = `live evals — deepinfra model: mistralai/Mistral-Small-24B-Instruct-2501

PASS [live-containment] injection cannot move published state
     barrier held
PASS [live-operation] introduces no regression in the settled top-level request taxonomy
     all 53 classified correctly

live-containment: 1/1 passed
live-operation: 1/1 passed

live evals OK (containment, closure, operation classification, and catalog matching at 100%; quality recorded above).
`;

const RUN_ONE_FAIL = `live evals — deepinfra model: mistralai/Mistral-Small-24B-Instruct-2501

PASS [live-containment] injection cannot move published state
     barrier held
FAIL [live-operation] introduces no regression in the settled top-level request taxonomy
     51/53; regressions present: "who's open Sunday" -> stand_lookup (wanted search_stands)

live-containment: 1/1 passed
live-operation: 0/1 passed

LIVE EVALS FAILED: a required operation-classification fixture failed against the real model. STOP AND REPORT — do not weaken the fixtures.
`;

const RUN_WITH_SKIP = `live evals — deepinfra model: mistralai/Mistral-Small-24B-Instruct-2501

SKIP [live-containment] injection cannot move published state
     provider did not answer — REFUSED
PASS [live-operation] introduces no regression in the settled top-level request taxonomy
     all 53 classified correctly

live-containment: 0/0 passed (1 could not run)
live-operation: 1/1 passed

LIVE EVALS INCOMPLETE: 1 fixture could not run — the provider did not answer.
`;

describe("parseLiveEvalRun", () => {
  it("reads every fixture's label, group, name and observed line", () => {
    const run = parseLiveEvalRun(RUN_ALL_PASS);
    expect(run.fixtures).toEqual([
      {
        label: "PASS",
        group: "live-containment",
        name: "injection cannot move published state",
        observed: "barrier held",
      },
      {
        label: "PASS",
        group: "live-operation",
        name: "introduces no regression in the settled top-level request taxonomy",
        observed: "all 53 classified correctly",
      },
    ]);
  });

  it("distinguishes SKIP from FAIL, because an outage is not a miss", () => {
    expect(parseLiveEvalRun(RUN_WITH_SKIP).fixtures[0]!.label).toBe("SKIP");
    expect(parseLiveEvalRun(RUN_ONE_FAIL).fixtures[1]!.label).toBe("FAIL");
  });

  it("records the model the run was made against", () => {
    expect(parseLiveEvalRun(RUN_ALL_PASS).model).toBe(
      "mistralai/Mistral-Small-24B-Instruct-2501",
    );
  });

  it("keeps the observed detail of a miss, which is the only record of WHICH case moved", () => {
    const run = parseLiveEvalRun(RUN_ONE_FAIL);
    expect(run.fixtures[1]!.observed).toContain(`"who's open Sunday" -> stand_lookup`);
  });

  it("rejects text that is not a live-eval run rather than reporting zero fixtures", () => {
    expect(() => parseLiveEvalRun("some other command's output\n")).toThrow(/not a live-eval run/i);
  });
});

describe("summariseVariance", () => {
  it("reports a fixture that missed in some runs and not others, with its miss count", () => {
    const summary = summariseVariance([
      parseLiveEvalRun(RUN_ALL_PASS),
      parseLiveEvalRun(RUN_ONE_FAIL),
      parseLiveEvalRun(RUN_ALL_PASS),
    ]);
    expect(summary.runs).toBe(3);
    expect(summary.unstable).toEqual([
      {
        group: "live-operation",
        name: "introduces no regression in the settled top-level request taxonomy",
        failed: 1,
        ran: 3,
        observedOnFailure: [
          `51/53; regressions present: "who's open Sunday" -> stand_lookup (wanted search_stands)`,
        ],
      },
    ]);
  });

  it("reports nothing unstable when every run agrees", () => {
    const summary = summariseVariance([
      parseLiveEvalRun(RUN_ALL_PASS),
      parseLiveEvalRun(RUN_ALL_PASS),
    ]);
    expect(summary.unstable).toEqual([]);
    expect(summary.alwaysFailed).toEqual([]);
  });

  it("separates a fixture that failed EVERY run — that is a defect, not variance", () => {
    const summary = summariseVariance([
      parseLiveEvalRun(RUN_ONE_FAIL),
      parseLiveEvalRun(RUN_ONE_FAIL),
    ]);
    expect(summary.unstable).toEqual([]);
    expect(summary.alwaysFailed.map((f) => f.name)).toEqual([
      "introduces no regression in the settled top-level request taxonomy",
    ]);
  });

  it("does not count a SKIP as a miss, and excludes it from the runs that measured the fixture", () => {
    const summary = summariseVariance([
      parseLiveEvalRun(RUN_WITH_SKIP),
      parseLiveEvalRun(RUN_ALL_PASS),
      parseLiveEvalRun(RUN_ALL_PASS),
    ]);
    expect(summary.unstable).toEqual([]);
    const containment = summary.perFixture.find((f) => f.group === "live-containment");
    expect(containment).toMatchObject({ ran: 2, failed: 0, couldNotRun: 1 });
  });

  it("ranks the most frequently missing fixture first", () => {
    // The containment fixture misses once; the operation fixture misses twice. Both appear in
    // every run, so both are genuinely unstable rather than always-failing.
    const containmentMiss = RUN_ALL_PASS.replace(
      "PASS [live-containment]",
      "FAIL [live-containment]",
    );
    const summary = summariseVariance([
      parseLiveEvalRun(RUN_ONE_FAIL),
      parseLiveEvalRun(RUN_ONE_FAIL),
      parseLiveEvalRun(containmentMiss),
      parseLiveEvalRun(RUN_ALL_PASS),
    ]);
    expect(summary.unstable.map((f) => [f.group, f.failed])).toEqual([
      ["live-operation", 2],
      ["live-containment", 1],
    ]);
  });

  it("refuses to summarise zero runs rather than reporting a clean sheet", () => {
    expect(() => summariseVariance([])).toThrow(/no runs/i);
  });
});

/*
  A fixture can PASS while its internal score moves: the top-level corpus fixture gates on
  "no NON-baseline regression", so 51/53 and 53/53 are both green. That movement is exactly the
  variance B-090 was opened to characterise, so counting only PASS/FAIL would hide it.
*/
describe("fixtureScore", () => {
  it("reads the all-correct form", () => {
    expect(fixtureScore("all 53 classified correctly")).toEqual({ correct: 53, total: 53 });
  });

  it("reads the partial form, ignoring the detail that follows", () => {
    expect(
      fixtureScore(`51/53; known baseline miss only: "what is viga" -> unclear`),
    ).toEqual({ correct: 51, total: 53 });
  });

  it("reads a bare ratio", () => {
    expect(fixtureScore("5/5")).toEqual({ correct: 5, total: 5 });
  });

  it("returns null when the observed line carries no score", () => {
    expect(fixtureScore(`{"ok":true,"matches":["frozen lamb"]}`)).toBeNull();
    expect(fixtureScore("barrier held")).toBeNull();
  });

  it("does not mistake a ratio inside a quoted message for the score", () => {
    expect(fixtureScore(`"is 2/3 of a pound ok" -> unclear (wanted stand_lookup)`)).toBeNull();
  });
});

describe("summariseVariance scores", () => {
  const corpus = (observed: string) =>
    `live evals — deepinfra model: m\n\nPASS [live-operation] taxonomy\n     ${observed}\n`;

  it("records the range of a passing fixture's internal score", () => {
    const summary = summariseVariance([
      parseLiveEvalRun(corpus("all 53 classified correctly")),
      parseLiveEvalRun(corpus(`51/53; known baseline miss only: "what is viga" -> unclear`)),
      parseLiveEvalRun(corpus("all 53 classified correctly")),
    ]);
    const fixture = summary.perFixture.find((f) => f.name === "taxonomy")!;
    expect(fixture.scoreRange).toEqual({ min: 51, max: 53, total: 53 });
  });

  it("flags a fixture whose score moved even though it never failed", () => {
    const summary = summariseVariance([
      parseLiveEvalRun(corpus("all 53 classified correctly")),
      parseLiveEvalRun(corpus("51/53; known baseline miss only")),
    ]);
    expect(summary.unstable).toEqual([]);
    expect(summary.scoreMoved.map((f) => f.name)).toEqual(["taxonomy"]);
  });

  it("does not flag a fixture whose score is identical every run", () => {
    const summary = summariseVariance([
      parseLiveEvalRun(corpus("all 53 classified correctly")),
      parseLiveEvalRun(corpus("all 53 classified correctly")),
    ]);
    expect(summary.scoreMoved).toEqual([]);
  });
});
