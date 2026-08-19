import type { LiveEvalGroup } from "./live-eval-policy";

/*
  B-090 — the instrument for "which fixtures ever miss".

  A live run is paid and its result is not reproducible from code, so the only honest way to
  characterise the model's variance is to keep every run and count across them. The red run on
  2026-08-19 that four reruns could not reproduce was lost to an uncaptured invocation; that loss
  is why this parses a SAVED transcript rather than tallying in-process.

  This reads the runner's own printed output. It is deliberately not a second source of truth
  about a fixture's outcome: the runner decides PASS/FAIL/SKIP, and this only counts what the
  runner already said.
*/

/** One fixture line from a captured run. */
export interface LiveEvalFixtureLine {
  label: "PASS" | "FAIL" | "SKIP";
  group: LiveEvalGroup;
  name: string;
  /** The runner's observed detail — for a miss, the only record of WHICH case moved. */
  observed: string;
}

export interface LiveEvalRun {
  model: string;
  fixtures: LiveEvalFixtureLine[];
}

const HEADER = /^live evals — deepinfra model: (.+)$/m;
const FIXTURE = /^(PASS|FAIL|SKIP) \[(live-[a-z]+)\] (.+)$/;

/**
 * Read one captured `npm run evals:live` transcript.
 *
 * Throws on text that is not a run. An unparseable file must be loud: silently returning zero
 * fixtures would let a mis-globbed path read as "nothing ever missed", which is the answer this
 * whole exercise must not produce by accident.
 */
export function parseLiveEvalRun(text: string): LiveEvalRun {
  const header = HEADER.exec(text);
  if (header === null) {
    throw new Error("not a live-eval run: missing the runner's model header");
  }

  const lines = text.split("\n");
  const fixtures: LiveEvalFixtureLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = FIXTURE.exec(lines[i]!);
    if (match === null) continue;
    // The runner always prints the observed detail on the next line, indented five spaces.
    const detail = (lines[i + 1] ?? "")
      .replace(/^ {5}/, "")
      .replace(/^provider did not answer — /, "");
    fixtures.push({
      label: match[1] as LiveEvalFixtureLine["label"],
      group: match[2] as LiveEvalGroup,
      name: match[3]!,
      observed: detail,
    });
  }

  if (fixtures.length === 0) {
    throw new Error("not a live-eval run: header present but no fixture lines");
  }
  return { model: header[1]!, fixtures };
}

/** A fixture's internal score, when its observed line carries one. */
export interface FixtureScore {
  correct: number;
  total: number;
}

/*
  The runner prints a sub-score in two shapes: `all N classified correctly` when everything
  passed, and `M/N; <detail>` otherwise. Both are anchored to the START of the observed line,
  because ratios also appear inside quoted customer messages and inside JSON payloads, and a
  loose search would read one of those as the fixture's score.
*/
const SCORE_ALL = /^all (\d+) classified correctly$/;
const SCORE_RATIO = /^(\d+)\/(\d+)(?:;|$)/;

/**
 * Read a fixture's internal score from its observed line, or null when it has none.
 *
 * This matters because a fixture can PASS at two different scores: the top-level corpus fixture
 * gates on "no non-baseline regression", so 51/53 and 53/53 are both green. Counting only
 * PASS/FAIL would report that fixture as perfectly stable while the number that actually moved
 * is the one B-090 exists to characterise.
 */
export function fixtureScore(observed: string): FixtureScore | null {
  const all = SCORE_ALL.exec(observed);
  if (all !== null) {
    const n = Number(all[1]);
    return { correct: n, total: n };
  }
  const ratio = SCORE_RATIO.exec(observed);
  if (ratio !== null) {
    return { correct: Number(ratio[1]), total: Number(ratio[2]) };
  }
  return null;
}

/** How one fixture behaved across every captured run. */
export interface FixtureVariance {
  group: LiveEvalGroup;
  name: string;
  /** Runs in which the fixture actually measured the model (PASS or FAIL, never SKIP). */
  ran: number;
  failed: number;
  couldNotRun: number;
  /** Distinct observed details from the runs where it missed. */
  observedOnFailure: string[];
  /** The spread of the fixture's internal score across runs, when it reports one. */
  scoreRange: { min: number; max: number; total: number } | null;
}

export interface VarianceSummary {
  runs: number;
  /** Every fixture, ordered most-missed first. */
  perFixture: FixtureVariance[];
  /** Missed in SOME runs and not others — the flap this item exists to characterise. */
  unstable: Omit<FixtureVariance, "couldNotRun" | "scoreRange">[];
  /** Missed in EVERY run that measured it — a defect to fix, not variance to record. */
  alwaysFailed: FixtureVariance[];
  /**
   * Passed every run but scored differently between them. Invisible to a PASS/FAIL tally, and
   * the precise shape of the 51/53-vs-53/53 flap this item was opened for.
   */
  scoreMoved: FixtureVariance[];
}

/**
 * Count which fixtures ever missed across N captured runs.
 *
 * The distinction that matters: a fixture failing every run is a defect with a reproducible
 * cause, while a fixture failing some runs is the model's own variance. Conflating them is how a
 * real regression gets filed as "flaky" and waved through.
 */
export function summariseVariance(runs: LiveEvalRun[]): VarianceSummary {
  if (runs.length === 0) {
    throw new Error("no runs to summarise; capture at least one live-eval transcript");
  }

  const byFixture = new Map<string, FixtureVariance>();
  for (const run of runs) {
    for (const fixture of run.fixtures) {
      const key = `${fixture.group} ${fixture.name}`;
      let entry = byFixture.get(key);
      if (entry === undefined) {
        entry = {
          group: fixture.group,
          name: fixture.name,
          ran: 0,
          failed: 0,
          couldNotRun: 0,
          observedOnFailure: [],
          scoreRange: null,
        };
        byFixture.set(key, entry);
      }
      // A SKIP measured nothing about the model: neither a miss nor evidence of stability.
      if (fixture.label === "SKIP") {
        entry.couldNotRun += 1;
        continue;
      }
      entry.ran += 1;
      const score = fixtureScore(fixture.observed);
      if (score !== null) {
        entry.scoreRange =
          entry.scoreRange === null
            ? { min: score.correct, max: score.correct, total: score.total }
            : {
                min: Math.min(entry.scoreRange.min, score.correct),
                max: Math.max(entry.scoreRange.max, score.correct),
                total: entry.scoreRange.total,
              };
      }
      if (fixture.label === "FAIL") {
        entry.failed += 1;
        if (!entry.observedOnFailure.includes(fixture.observed)) {
          entry.observedOnFailure.push(fixture.observed);
        }
      }
    }
  }

  const perFixture = [...byFixture.values()].sort(
    (a, b) => b.failed - a.failed || a.name.localeCompare(b.name),
  );

  return {
    runs: runs.length,
    perFixture,
    unstable: perFixture
      .filter((f) => f.failed > 0 && f.failed < f.ran)
      .map(({ group, name, ran, failed, observedOnFailure }) => ({
        group,
        name,
        failed,
        ran,
        observedOnFailure,
      })),
    alwaysFailed: perFixture.filter((f) => f.ran > 0 && f.failed === f.ran),
    scoreMoved: perFixture.filter(
      (f) => f.scoreRange !== null && f.scoreRange.min !== f.scoreRange.max,
    ),
  };
}
