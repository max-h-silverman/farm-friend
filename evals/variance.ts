/*
  B-090 — characterise the live classifier's run-to-run variance.

  Runs `evals:live` N times and CAPTURES EVERY RUN TO ITS OWN FILE before anything is parsed.
  That ordering is the whole point: the red run on 2026-08-19 that four reruns could not
  reproduce was lost because it was never written down, so a crash, a Ctrl-C, or a parse error
  here must still leave the transcripts on disk.

  Usage:
    DEEPINFRA_MODEL=<model-id> npx tsx evals/variance.ts [runs] [--out <dir>]

  Reads an existing capture directory without spending money:
    npx tsx evals/variance.ts --summarise-only --out <dir>
*/

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLiveEvalRun, summariseVariance, type LiveEvalRun } from "@farm-friend/ai";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const summariseOnly = process.argv.includes("--summarise-only");
const runCount = Number(process.argv[2] ?? "20");
const outDir =
  arg("--out") ?? join("evals", "captures", new Date().toISOString().replace(/[:.]/g, "-"));

/** Run `npm run evals:live` once, returning its combined output whatever the exit code. */
function runOnce(): Promise<{ output: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "evals:live"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => resolve({ output, code: code ?? -1 }));
  });
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  if (!summariseOnly) {
    if (!Number.isInteger(runCount) || runCount < 1) {
      console.error(`run count must be a positive integer, got "${process.argv[2]}"`);
      process.exit(1);
    }
    console.log(`capturing ${runCount} live-eval runs to ${outDir}\n`);
    for (let i = 1; i <= runCount; i += 1) {
      const { output, code } = await runOnce();
      // Written FIRST, before any parsing can throw.
      const file = join(outDir, `run-${String(i).padStart(2, "0")}.txt`);
      writeFileSync(file, output);
      const misses = (output.match(/^FAIL \[/gm) ?? []).length;
      const skips = (output.match(/^SKIP \[/gm) ?? []).length;
      console.log(
        `run ${String(i).padStart(2, "0")}/${runCount}  exit ${code}  ` +
          `${misses} FAIL  ${skips} SKIP  -> ${file}`,
      );
    }
    console.log();
  }

  const files = readdirSync(outDir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".txt"))
    .sort();
  const runs: LiveEvalRun[] = [];
  for (const f of files) {
    try {
      runs.push(parseLiveEvalRun(readFileSync(join(outDir, f), "utf8")));
    } catch (error) {
      // Loud, and names the file: a run that cannot be parsed must not silently shrink the sample.
      console.error(`UNPARSEABLE ${f}: ${(error as Error).message}`);
    }
  }

  const summary = summariseVariance(runs);
  console.log(`variance across ${summary.runs} runs (${files.length} files in ${outDir})\n`);

  if (summary.alwaysFailed.length > 0) {
    console.log("FAILED EVERY RUN — a defect, not variance:");
    for (const f of summary.alwaysFailed) {
      console.log(`  [${f.group}] ${f.name}  ${f.failed}/${f.ran}`);
      for (const o of f.observedOnFailure) console.log(`      ${o}`);
    }
    console.log();
  }

  if (summary.unstable.length === 0) {
    console.log("No fixture missed in some runs and passed in others.");
  } else {
    console.log("UNSTABLE — missed in some runs, passed in others:");
    for (const f of summary.unstable) {
      console.log(`  [${f.group}] ${f.name}  missed ${f.failed}/${f.ran}`);
      for (const o of f.observedOnFailure) console.log(`      ${o}`);
    }
  }

  if (summary.scoreMoved.length > 0) {
    console.log("\nSCORE MOVED — passed every run, but the internal score changed between runs:");
    for (const f of summary.scoreMoved) {
      const r = f.scoreRange!;
      console.log(`  [${f.group}] ${f.name}  ${r.min}-${r.max} of ${r.total}`);
    }
  }

  const outages = summary.perFixture.reduce((n, f) => n + f.couldNotRun, 0);
  if (outages > 0) console.log(`\n${outages} fixture-runs could not run (provider did not answer).`);
}

void main();
