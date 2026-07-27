import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// B-009 follow-up — production's ONLY scheduled recovery net.
//
// `vercel.json` declares a one-minute cron, but Hobby REJECTS that schedule, so every deploy
// to date has been uploaded with the `crons` block stripped from the working tree. The
// deployed system therefore runs no scheduled pass at all: the best-effort webhook kick is
// the only thing invoking the workers. That is the exact inversion B-009 was filed against —
// the path designed to be unreliable-but-fast became the only path — and it also means
// F-026's retention purge, which runs ONLY on this trigger, has never run in production.
//
// The external scheduler is what closes that gap until Vercel Pro is revisited at go-live.
// It lives in-repo as a GitHub Actions workflow rather than a SaaS dashboard specifically so
// this test can police it. A dashboard-configured job is unassertable, which is the silent
// failure mode B-005 was filed against: a stale secret returns 401, and 401 looks identical
// to success in a scheduler's UI.
//
// This is a SOURCE-asserting test, in the same family as cron-schedule.test.ts,
// cron-auth.test.ts and workspace-manifests.test.ts. The property belongs to the platform,
// not to any code vitest can execute — no behavioural test in Node can observe whether
// GitHub actually fires a workflow.

const workflowPath = resolve(process.cwd(), ".github/workflows/scheduled-worker.yml");
const workflowSource = readFileSync(workflowPath, "utf8");

/**
 * Comment lines are stripped before matching. B-009's own first test SURVIVED its sabotage
 * because an `import` line satisfied the pattern it asserted; the same trap here is a YAML
 * comment mentioning the endpoint or the secret. Only live config may satisfy these.
 */
const workflowConfig = workflowSource
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("the external scheduler invokes the deployed worker", () => {
  it("runs on a schedule rather than only by hand", () => {
    // `workflow_dispatch` alone would deploy clean and never fire. The recovery net has to be
    // automatic or it is not a net.
    expect(workflowConfig).toMatch(/schedule:/);
    expect(workflowConfig).toMatch(/cron:\s*['"]/);
  });

  it("targets the production cron endpoint", () => {
    // The drift this catches: a workflow pointing at a preview URL, or at a path no handler
    // serves, would run green every time while production kept no recovery net at all.
    expect(workflowConfig).toContain(
      "https://farm-friend-web.vercel.app/api/internal/cron",
    );
  });

  it("authenticates with the cron secret from repository secrets, never a literal", () => {
    // The route requires `Authorization: Bearer <CRON_SECRET>` with no default and no dev
    // bypass. A hardcoded secret in a committed workflow would be an exposed credential in a
    // file anyone who can read the repo can read.
    expect(workflowConfig).toMatch(/secrets\.CRON_SECRET/);
    expect(workflowConfig).toMatch(/Authorization: Bearer \$\{CRON_SECRET\}/);
  });

  it("passes the secret through the environment, not the command line", () => {
    // `${{ secrets.X }}` interpolated directly into a `run:` block is substituted into the
    // script text before the shell sees it, which puts the credential in the process's
    // argument list. Binding it to `env:` and referencing the shell variable keeps it out.
    expect(workflowConfig).toMatch(/CRON_SECRET:\s*\$\{\{\s*secrets\.CRON_SECRET\s*\}\}/);
    // The literal GitHub expression must NOT appear inside the curl invocation itself.
    expect(workflowConfig).not.toMatch(/Bearer \$\{\{\s*secrets\./);
  });

  it("fails the run when the endpoint does not return 200", () => {
    // THE central assertion, and the reason this file exists.
    //
    // A scheduler that ignores the response status is worse than no scheduler, because it
    // reports success while the worker never runs. A stale CRON_SECRET returns 401 and a
    // bare `curl` exits 0 on any HTTP status — the run goes green, the Actions tab shows a
    // tidy column of checkmarks, and nothing has executed since the day the secret rotated.
    //
    // ANCHORED TO THE COMPARISON ITSELF, and not loosely to "status" or "exit 1" anywhere in
    // the file. The first draft of this assertion matched `/--fail|-f\b|http_code|status/`
    // plus a bare `/exit 1/`, and SURVIVED its sabotage: the words were satisfied by the
    // `-w '%{http_code}'` flag and by the unrelated missing-secret guard, so a workflow that
    // accepted every HTTP status still passed. That is the identical trap B-009's own first
    // test fell into, where an `import` line satisfied the pattern.
    //
    // The status must be captured, compared against 200, and the mismatch must exit non-zero.
    expect(workflowConfig).toMatch(/-w\s+'%\{http_code\}'/);
    expect(workflowConfig).toMatch(
      /if\s+\[\s+"\$\{status\}"\s+!=\s+"200"\s+\]\s*;\s*then[\s\S]*?exit 1[\s\S]*?fi/,
    );
  });

  it("does not print the response body into the run log", () => {
    // The pass result is counts only, but the route is authenticated and its output is
    // operational detail; a public repo's Actions logs are world-readable. `-o /dev/null`
    // (or equivalent) keeps the body out of the log while still checking the status.
    expect(workflowConfig).toMatch(/-o\s+\/dev\/null|--output\s+\/dev\/null/);
  });
});
