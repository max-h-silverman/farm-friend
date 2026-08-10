import { appContext } from "../../../../lib/composition";
import {
  isInternalSurfaceEnabled,
  resolveDeploymentRole,
} from "../../../../lib/deployment-role";
import {
  runDeliveryPass,
  runInboundPass,
  runOutboundPass,
  runRetentionPass,
} from "../../../../lib/workers";
import { runScheduledPromptPass } from "../../../../lib/scheduled-prompts";

// The scheduled worker trigger (F-023, docs/RUNBOOK.md §"Scheduled work").
//
// ONE internal route runs every scheduled pass: inbound routing, F-052 inventory prompting,
// outbound dispatch, B-012 delivery-callback application, and the F-026 retention purge. A new
// scheduled job adds its call below — one mechanism, not a second cron surface per job.
//
// ## Authentication moved OUT of this process, and that is a strengthening
//
// This route used to verify a shared `CRON_SECRET` bearer token. On Cloud Run it is reached
// only through Cloud Scheduler's OIDC identity against an internal-ingress service with IAM
// `run.invoker` — enforced by Google, before the request reaches this container, and not
// something application code can weaken by accident.
//
// The shared secret is gone rather than kept alongside, deliberately. It was a credential
// living in two places that had to match — the Vercel env var and the GitHub repository
// secret — where a mismatch produced a 401 that looks identical to success in any
// scheduler's UI, and a rotation could silently stop every scheduled pass. Keeping a second
// authenticator "just in case" would preserve exactly that failure mode while adding nothing:
// a caller who cannot pass IAM never reaches this code to present a token.
//
// What remains in-process is the role guard below — a second closed door, not the first, so
// that a Terraform mistake exposing the worker publicly still meets a refusal. It is checked
// BEFORE `appContext()` so the public deployment never even builds a database pool for a
// route it does not serve, and returns 404 rather than 403 to leave no hint the surface
// exists there.
//
// Each pass enumerates its own work. That is what makes this route callable at all: while
// the workers took caller-supplied ID lists, no scheduler could invoke them, which is why
// nothing routed inbound SMS.

export const dynamic = "force-dynamic";

async function runScheduledWork(): Promise<Response> {
  if (!isInternalSurfaceEnabled(resolveDeploymentRole())) {
    return new Response("Not Found", { status: 404 });
  }

  const context = appContext();

  // Inbound first: a STOP that arrives in this pass should suppress still-queued proactive
  // work in the SAME pass rather than waiting for the next one. `authorizeDispatch`
  // re-reads consent at the dispatch claim, so ordering these two is an improvement in
  // latency, never the thing that makes suppression correct.
  const inbound = await runInboundPass({
    db: context.db,
    farmerIntent: context.farmerIntent,
    customerIntent: context.customerIntent,
    stockOut: context.stockOut,
    interpreter: context.interpreter,
    inquiry: context.inquiry,
    clock: context.clock,
    publicBaseUrl: context.config.publicBaseUrl,
    publicMapUrl: context.config.publicMapUrl,
  });

  const prompts = await runScheduledPromptPass({
    db: context.db,
    clock: context.clock,
  });

  const outbound = await runOutboundPass({
    context,
    clock: context.clock,
  });

  // Delivery callbacks (B-012), after the outbound pass so a send dispatched in THIS pass
  // can have its callback applied in the next one. These are not per-sender conversational
  // work — no sender, no body — so they get their own bounded pass rather than the
  // serialized inbound path. Before this existed, nothing read them at all and
  // `delivery_status` was permanently NULL.
  const delivery = await runDeliveryPass({
    db: context.db,
    clock: context.clock,
  });

  // Retention last (F-026): it clears bodies the two passes above may have just written
  // or read, and it is the only pass whose work is never time-critical. Ordering is a
  // courtesy, not a correctness property — the purge skips outbox work the dispatcher has
  // not finished with, so it is safe at any point in the pass.
  //
  // The counts returned here are counts ONLY. A purge that reported what it deleted would
  // defeat its own purpose.
  const retention = await runRetentionPass({
    db: context.db,
    clock: context.clock,
  });

  return Response.json(
    { inbound, prompts, outbound, delivery, retention },
    { status: 200 },
  );
}

/**
 * POST only. Cloud Scheduler is configured to POST, and dropping GET removes a surface that
 * existed only because Vercel Cron issued GET — a route reachable by a plain browser
 * navigation is a worse shape for something that drives consent transitions and outbound SMS.
 */
export async function POST(): Promise<Response> {
  return runScheduledWork();
}
