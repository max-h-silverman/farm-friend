import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The scheduled-worker trigger is never open (F-023).
//
// The passes behind these routes apply consent transitions and send real SMS to real people,
// so an unauthenticated trigger is a remote way to drive messaging. That has not changed.
// WHAT ENFORCES IT HAS.
//
// It used to be a shared `CRON_SECRET` bearer token compared in this process. On Cloud Run
// the route is reached only through Cloud Scheduler's OIDC identity against an
// internal-ingress service with IAM `run.invoker` — enforced by Google, before the request
// reaches this container, and not weakenable by application code.
//
// The secret was REMOVED rather than kept alongside IAM, and that is the stronger choice
// even though it reads like subtraction. It was one credential living in two places that had
// to match (the platform env var and the GitHub repository secret); a mismatch produced a 401
// that looks identical to success in any scheduler's UI, and rotating one side silently
// stopped every scheduled pass. Keeping it "for defence in depth" would preserve that exact
// failure mode while protecting against nothing — a caller who cannot satisfy IAM never
// reaches this code to present a token.
//
// What this file polices is the second door: the deployment-role guard, which must run BEFORE
// any application context is constructed and must never acquire an environment-dependent
// bypass. That last point is GL-019's durable lesson — a rule that relaxes off-production
// behaves one way everywhere it is tested and another way in the one place that matters.
//
// SOURCE assertions, because what must be proven is the ABSENCE of a construct and the ORDER
// of two statements. No single execution can demonstrate either.

const cronRoute = readFileSync(
  resolve(process.cwd(), "apps/web/app/api/internal/cron/route.ts"),
  "utf8",
);
const kickRoute = readFileSync(
  resolve(process.cwd(), "apps/web/app/api/internal/kick/route.ts"),
  "utf8",
);

/**
 * Executable code only — imports and comments stripped.
 *
 * This repo has now been bitten three times by source assertions matching incidental text: an
 * import line satisfying a `waitUntil` check, a loose alternation matching a CLI flag, and a
 * prohibition matching the comment that explained it. Prose about a construct is not the
 * construct.
 */
const executable = (source: string): string =>
  source
    .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const cronBody = executable(cronRoute);
const kickBody = executable(kickRoute);

describe("internal routes are refused on the public deployment", () => {
  it("guards the cron route by deployment role", () => {
    expect(cronBody).toMatch(/isInternalSurfaceEnabled\s*\(/);
  });

  it("guards the kick route by deployment role", () => {
    expect(kickBody).toMatch(/isInternalSurfaceEnabled\s*\(/);
  });

  it("checks the role BEFORE constructing application context", () => {
    // Order is the assertion. `appContext()` builds a database pool and resolves every
    // credential; doing that for a route this deployment does not serve spends a connection
    // from a five-connection budget on every probe, turning a scan of the public service into
    // database load.
    for (const body of [cronBody, kickBody]) {
      const guardIndex = body.indexOf("isInternalSurfaceEnabled");
      const contextIndex = body.indexOf("appContext()");
      expect(guardIndex).toBeGreaterThan(-1);
      expect(contextIndex).toBeGreaterThan(-1);
      expect(guardIndex).toBeLessThan(contextIndex);
    }
  });

  it("answers 404 rather than 403, leaking no hint the surface exists", () => {
    // 403 confirms the route is there and merely forbidden, which tells a scanner exactly
    // where to keep pushing. 404 is indistinguishable from a route that does not exist.
    for (const body of [cronBody, kickBody]) {
      expect(body).toMatch(/status:\s*404/);
    }
  });
});

describe("no environment-dependent bypass", () => {
  it("never branches on NODE_ENV or a development flag", () => {
    // The conditional-safety pattern Golden Rule #6 rejects. A route that skips its guard
    // outside production is one misconfigured deploy away from being open, and every suite
    // would stay green — because the suites run in exactly the environment that skips it.
    for (const body of [cronBody, kickBody]) {
      expect(body).not.toMatch(/NODE_ENV/);
      expect(body).not.toMatch(/isDev|isDevelopment|DEV_BYPASS|SKIP_AUTH/i);
    }
  });

  it("does not reintroduce a shared-secret comparison", () => {
    // If a bearer token ever comes back it must be a deliberate decision carrying its own
    // rationale, not something that reappears because adding one felt safer. The
    // two-places-that-must-match failure mode is precisely why it left.
    for (const body of [cronBody, kickBody]) {
      expect(body).not.toMatch(/CRON_SECRET|cronSecret/);
    }
  });
});

describe("the cron surface is POST-only", () => {
  it("exposes no GET handler", () => {
    // GET existed only because Vercel Cron issued it. A route that drives consent transitions
    // and outbound SMS should not be reachable by a browser navigation or a link prefetch.
    expect(cronBody).not.toMatch(/export\s+async\s+function\s+GET/);
    expect(cronBody).toMatch(/export\s+async\s+function\s+POST/);
  });
});
