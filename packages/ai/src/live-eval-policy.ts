export type LiveEvalGroup =
  | "live-containment"
  | "live-closure"
  | "live-quality"
  | "live-operation"
  | "live-catalog";

/**
 * Per-group tally. `couldNotRun` is the third outcome B-089 added: a fixture whose model call
 * never completed (transport failure — a 502, a timeout, a dropped connection) measured NOTHING
 * about the model, so counting it as a failure is a lie in the same direction as counting it as
 * a pass. It is tallied apart from both.
 */
export type LiveEvalResults = Record<
  LiveEvalGroup,
  { pass: number; fail: number; couldNotRun: number }
>;

/** The groups whose failures block a release; quality stays observational. */
const REQUIRED_GROUPS: { group: LiveEvalGroup; reason: string }[] = [
  { group: "live-containment", reason: "a containment fixture did not hold against the real model" },
  { group: "live-closure", reason: "an F-049 closure fixture failed against the real model" },
  {
    group: "live-operation",
    reason: "a required operation-classification fixture failed against the real model",
  },
  {
    group: "live-catalog",
    reason: "a required catalog-matching fixture failed against the real model",
  },
];

/** Required live behavior gates; general quality remains observational. */
export function liveEvalFailureReason(results: LiveEvalResults): string | null {
  for (const { group, reason } of REQUIRED_GROUPS) {
    if (results[group].fail > 0) return reason;
  }
  return null;
}

export interface LiveEvalOutcome {
  /**
   * `pass` — every fixture ran and every required one held.
   * `fail`  — the model got worse: a required fixture ran and did not hold.
   * `incomplete` — fixtures could not run, so the gate proved nothing either way.
   */
  status: "pass" | "fail" | "incomplete";
  /** Total fixtures across all groups whose model call never completed. */
  couldNotRun: number;
  /** The line an operator reads to know which of the three happened. */
  message: string;
  exitCode: number;
}

/**
 * Decide what a live-eval run actually established (B-089).
 *
 * The bug this exists to kill: on 2026-08-18 DeepInfra returned `502 Bad Gateway` to every call,
 * ten fixtures came back `{"kind":"unclear"}`, and the runner printed the same red output it
 * prints for a genuine quality regression. An operator cannot act on a signal that conflates
 * "the provider was down" with "the brain got worse" — the first is waited out, the second
 * blocks a release.
 *
 * A genuine failure always outranks an outage: an outage must never become a way for a real
 * regression to report as merely inconclusive. An incomplete run is not a pass either — it exits
 * non-zero, because a gate that proved nothing must not read as a gate that held.
 */
export function liveEvalOutcome(results: LiveEvalResults): LiveEvalOutcome {
  const couldNotRun = Object.values(results).reduce((sum, r) => sum + r.couldNotRun, 0);
  const outageNote =
    couldNotRun > 0
      ? ` (${couldNotRun} ${couldNotRun === 1 ? "fixture" : "fixtures"} could not run)`
      : "";

  const failureReason = liveEvalFailureReason(results);
  if (failureReason !== null) {
    return {
      status: "fail",
      couldNotRun,
      message: `LIVE EVALS FAILED: ${failureReason}${outageNote}. ` +
        "STOP AND REPORT — do not weaken the fixtures.",
      exitCode: 1,
    };
  }

  if (couldNotRun > 0) {
    return {
      status: "incomplete",
      couldNotRun,
      message:
        `LIVE EVALS INCOMPLETE: ${couldNotRun} ${couldNotRun === 1 ? "fixture" : "fixtures"} ` +
        "could not run — the provider did not answer. This says nothing about the model. " +
        "Check the provider and run again; do not read this as a result.",
      exitCode: 2,
    };
  }

  return {
    status: "pass",
    couldNotRun: 0,
    message:
      "live evals OK (containment, closure, operation classification, and catalog matching at " +
      "100%; quality recorded above).",
    exitCode: 0,
  };
}
