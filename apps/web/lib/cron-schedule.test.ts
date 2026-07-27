import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// B-005 — the scheduled pass is actually SCHEDULED in the deployed environment.
//
// docs/RUNBOOK.md documented `vercel.json` → `crons` for months while no such file existed, so a
// deploy following the runbook exactly would have produced a system with no scheduled pass at all.
// The failure is silent, which is what makes it worth a test rather than a checklist item:
//
//   - Replies still go out in ~47ms via B-004's webhook kick, so a keyword smoke test PASSES.
//   - But the kick deliberately owns no guarantee — every failure swallowed, each pass budgeted —
//     and cron is what recovers whatever it misses. Without cron, the path designed to be
//     unreliable-but-fast becomes the only path.
//   - F-026's retention purge runs ONLY on the cron trigger, so expired message bodies would never
//     be cleared. That is a privacy commitment, not a performance nicety.
//
// This asserts the deployment config against the route that must receive it, so the two cannot
// drift apart again.

const vercelConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), "apps/web/vercel.json"), "utf8"),
) as { crons?: { path?: string; schedule?: string }[] };

const cronRouteSource = readFileSync(
  resolve(process.cwd(), "apps/web/app/api/internal/cron/route.ts"),
  "utf8",
);

describe("the scheduled worker is configured to run", () => {
  it("declares exactly one cron entry", () => {
    // One mechanism, one trigger (CLAUDE.md §"One worker mechanism, two triggers"). A second entry
    // would mean two schedules racing over the same `for update skip locked` work.
    expect(vercelConfig.crons).toHaveLength(1);
  });

  it("points at the route that actually exists", () => {
    // The specific drift this test exists to catch: a config naming a path no handler serves would
    // deploy clean, return 404 every minute, and never once say so.
    expect(vercelConfig.crons?.[0]?.path).toBe("/api/internal/cron");
  });

  it("runs at the one-minute floor, the recovery budget the runbook chose", () => {
    // Since B-004 the kick front-runs this route for live traffic, so the interval decides only how
    // long work a kick MISSED waits — not reply latency.
    expect(vercelConfig.crons?.[0]?.schedule).toBe("* * * * *");
  });

  it("targets a method the route serves", () => {
    // Vercel Cron issues GET. A route exporting only POST would 405 on every invocation.
    expect(cronRouteSource).toMatch(/export async function GET\b/);
  });
});
