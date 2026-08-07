import { z } from "zod";
import { appContext } from "../../../../lib/composition";
import {
  isInternalSurfaceEnabled,
  resolveDeploymentRole,
} from "../../../../lib/deployment-role";
import { kickSenderPasses } from "../../../../lib/kick";
import { runInboundPass, runOutboundPass } from "../../../../lib/workers";

// The Cloud Tasks target (docs/archive/GCP_MIGRATION_PLAN.md §"Immediate and scheduled work").
//
// This is what replaces `waitUntil`. The webhook commits the inbox event, enqueues a task,
// and returns 200; the queue then calls THIS route to run that sender's passes. The work
// moved out of the responding invocation entirely, which is the point:
//
//   - On Vercel the kick ran inside the webhook's own invocation, sharing its timeout and
//     cancelled when that elapsed. The kick was best-effort by construction, and B-009 was
//     the sharper failure — a promise the runtime never knew about did not run at all.
//   - Here the task is durable before the webhook responds. If this route fails, the queue
//     retries it on its own policy; if the container dies mid-pass, the task is redelivered.
//
// AUTHENTICATION IS NOT THIS ROUTE'S JOB, and saying so explicitly matters. Cloud Run's
// internal-only ingress plus IAM `run.invoker` on the worker service is what stops anyone
// else calling this — enforced by Google, outside this process, and not something
// application code can check. The role guard below is a SECOND door, not the first: it means
// a Terraform mistake that exposes the worker publicly, or traffic misrouted to the wrong
// service, still meets a refusal. Neither layer substitutes for the other.
//
// The route is deliberately thin. It re-runs the same bounded passes the scheduler runs,
// scoped to one sender. Every correctness guarantee stays in Postgres — the inbox's unique
// provider event ID, `claimNextInboundEvent`'s row lock, `authorizeDispatch`'s consent
// recheck — so a duplicate task, a retried task, and a concurrent scheduled pass are all
// safe by the same mechanisms that already made the Vercel kick safe.

export const dynamic = "force-dynamic";

/**
 * The task payload: two opaque identifiers and nothing else.
 *
 * `strict()` refuses unknown keys rather than ignoring them. A task carrying a phone number
 * or a message body is not something to tolerate quietly — it would mean something upstream
 * started putting personal data in a queue that stores and surfaces it.
 */
const taskPayload = z
  .object({
    senderHash: z.string().regex(/^[0-9a-f]{64}$/),
    providerEventId: z.string().min(1),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  // Before app context: the public deployment must not even construct a database pool for a
  // route it does not serve, and a 404 (not 403) leaves no hint the surface exists there.
  if (!isInternalSurfaceEnabled(resolveDeploymentRole())) {
    return new Response("Not Found", { status: 404 });
  }

  let parsed: z.infer<typeof taskPayload>;
  try {
    parsed = taskPayload.parse(await req.json());
  } catch {
    // A malformed task is not retryable — returning 4xx tells Cloud Tasks to stop rather
    // than redeliver something that can never succeed.
    return Response.json({ error: "invalid_task" }, { status: 400 });
  }

  const context = appContext();

  try {
    await kickSenderPasses(
      {
        runInbound: (senderHashes) =>
          runInboundPass(
            {
              db: context.db,
              farmerIntent: context.farmerIntent,
              interpreter: context.interpreter,
              inquiry: context.inquiry,
              clock: context.clock,
              publicBaseUrl: context.config.publicBaseUrl,
              publicMapUrl: context.config.publicMapUrl,
            },
            senderHashes,
          ),
        runOutbound: () => runOutboundPass({ context, clock: context.clock }),
      },
      parsed.senderHash,
    );
  } catch {
    // `kickSenderPasses` resolves on every failure by construction, so this is unreachable
    // in practice. It is here because the honest answer to an unexpected throw is "let the
    // queue retry", not "report success" — 500 is retryable and the pass is idempotent.
    return Response.json({ error: "pass_failed" }, { status: 500 });
  }

  // The response says the passes RAN, never that a reply was sent. Whether anything was
  // dispatched is recorded in the outbox, which is where an operator reads it; a task
  // result that claimed delivery would be a second, weaker source of truth.
  return Response.json({ ran: true }, { status: 200 });
}
