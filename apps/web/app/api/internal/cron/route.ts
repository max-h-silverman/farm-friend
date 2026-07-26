import { appContext } from "../../../../lib/composition";
import { runInboundPass, runOutboundPass } from "../../../../lib/workers";

// The scheduled worker trigger (F-023, docs/RUNBOOK.md §"Scheduled work").
//
// ONE authenticated internal route runs every scheduled pass. F-026's retention purge adds
// its call to the list below — one mechanism, not a second cron surface per job.
//
// Authentication is a shared secret, required with NO default and NO local-only bypass.
// An environment-dependent auth branch is exactly the conditional safety Golden Rule #6
// rejects: a route that skips its check outside production is one misconfigured deploy away
// from being public. `resolveConfig` throws when CRON_SECRET is absent, so a deployment
// missing it fails closed at startup rather than serving an unauthenticated worker endpoint.
// `cron-auth.test.ts` reads this file and fails if such a branch ever appears.
//
// Each pass enumerates its own work. That is what makes this route callable at all: while
// the workers took caller-supplied ID lists, no scheduler could invoke them, which is why
// nothing routed inbound SMS.

export const dynamic = "force-dynamic";

/**
 * Constant-time comparison, so a token cannot be recovered byte-by-byte from response
 * timing. Length is compared first because an early return on differing lengths leaks only
 * the length, which the attacker already controls.
 */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < provided.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Read the caller's bearer token. Vercel Cron sends `Authorization: Bearer <secret>`;
 * the same header is what an operator uses to run a pass by hand.
 */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]! : null;
}

async function runScheduledWork(req: Request): Promise<Response> {
  const context = appContext();

  const provided = bearerToken(req);
  if (provided === null || !secretMatches(provided, context.config.cronSecret)) {
    // No detail about which half failed, and no hint that the route exists at all beyond
    // the status itself.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Inbound first: a STOP that arrives in this pass should suppress still-queued proactive
  // work in the SAME pass rather than waiting for the next one. `authorizeDispatch`
  // re-reads consent at the dispatch claim, so ordering these two is an improvement in
  // latency, never the thing that makes suppression correct.
  const inbound = await runInboundPass({
    db: context.db,
    interpreter: context.interpreter,
    inquiry: context.inquiry,
    clock: context.clock,
  });

  const outbound = await runOutboundPass({
    context,
    clock: context.clock,
  });

  // F-026 adds `const retention = await runRetentionPass(...)` here.

  return Response.json({ inbound, outbound }, { status: 200 });
}

/** Vercel Cron issues GET. */
export async function GET(req: Request): Promise<Response> {
  return runScheduledWork(req);
}

/** POST is accepted so an operator can trigger a pass with the same contract. */
export async function POST(req: Request): Promise<Response> {
  return runScheduledWork(req);
}
