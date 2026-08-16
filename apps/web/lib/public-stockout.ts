import { z } from "zod";
import type { StockOutModel } from "@farm-friend/ai";
import type { Clock, PublicActionThrottle } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";
import { clientSignalFor } from "./client-signal";
import { recordStockOutReport } from "./stockout";

// The QR stock-out form — the ONE public, unauthenticated, model-backed surface at launch,
// and therefore the one thing the abuse/cost throttle fronts (F-019).
//
// This wraps F-013's `recordStockOutReport` rather than reimplementing it. The workflow
// already owns the invariants that matter — the location is code-bound from the scanned
// route, the farmer recipient is resolved in code, and a report never touches published
// inventory. What this layer adds is the public-surface concern the workflow should not
// know about: rationing anonymous model calls.
//
// Order matters and is the point. The throttle is consulted BEFORE the workflow runs, so a
// refused request costs a map lookup rather than a model call. Cheap deterministic
// rejections (an unknown location) also never reach the provider.

export interface PublicStockOutDeps {
  db: Db;
  model: StockOutModel;
  clock: Clock;
  throttle: PublicActionThrottle;
  /**
   * A coarse, hashed client signal for cost bucketing. It is NEVER identity, never a phone
   * number, and never a durable record — it exists only to keep one abuser from spending
   * the model budget.
   */
  clientSignal: string | null;
  /** Bound by the QR/web route in code — never model output, never client-chosen text. */
  salesLocationId: string;
  taskText: string;
}

export interface PublicStockOutResult {
  status: 202 | 400 | 429;
  /** Present only on a throttled response, for the `Retry-After` header. */
  retryAfterSeconds?: number;
  reportId?: string;
  /** The farmer to prompt, for the caller to queue as outbox work. Never rendered publicly. */
  /** One per contradicted provider (F-114 C.3); absent when the report contradicts nobody. */
  alertedRecipientHashes?: string[];
}

/**
 * Accept one public stock-out report. Returns a transport-shaped result the route renders;
 * it queues nothing itself and never reveals whether a farmer was reachable.
 */
export async function handleStockOutReport(
  deps: PublicStockOutDeps,
): Promise<PublicStockOutResult> {
  const decision = deps.throttle.admit(deps.clientSignal);
  if (!decision.allowed) {
    return { status: 429, retryAfterSeconds: decision.retryAfterSeconds };
  }

  const outcome = await recordStockOutReport(
    { db: deps.db, model: deps.model, clock: deps.clock },
    { salesLocationId: deps.salesLocationId, taskText: deps.taskText },
  );

  if (outcome.outcome === "rejected") {
    return { status: 400 };
  }
  if (outcome.outcome === "unclear") {
    // Nothing was recorded and no one is alerted. This is still a 202: the reporter is an
    // anonymous stranger, and telling them how their text was parsed invites probing at the
    // farmer's expense.
    return { status: 202 };
  }

  return {
    status: 202,
    reportId: outcome.reportId,
    ...(outcome.alertedRecipientHashes !== undefined
      ? { alertedRecipientHashes: outcome.alertedRecipientHashes }
      : {}),
  };
}

const reportSchema = z.object({
  // Bound by the scanned QR/web route; a UUID, never free text naming a farm. A stranger
  // cannot redirect a report at someone else's stand by typing its name.
  salesLocationId: z.string().uuid(),
  taskText: z.string().min(1).max(1_000),
});

/**
 * The HTTP handler for the QR stock-out form, over injected dependencies. It lives here
 * rather than in the route file because Next.js permits only its own fields as route
 * exports — and keeping it injectable is what lets the tests drive it with real `Request`
 * objects and a scripted provider.
 *
 * The response tells an anonymous reporter nothing about the farmer: not their identity,
 * not whether one was reachable, not how their text was parsed. A stranger gets "thank you."
 */
export async function handleStockOutRequest(
  req: Request,
  deps: Omit<
    PublicStockOutDeps,
    "clientSignal" | "salesLocationId" | "taskText"
  > & { signalSalt: string },
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) {
    // Rejected before the throttle and before any model call: a malformed body costs
    // nothing, so it must not consume a legitimate reporter's budget.
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await handleStockOutReport({
    db: deps.db,
    model: deps.model,
    clock: deps.clock,
    throttle: deps.throttle,
    clientSignal: clientSignalFor(req.headers, deps.signalSalt),
    salesLocationId: parsed.data.salesLocationId,
    taskText: parsed.data.taskText,
  });

  if (result.status === 429) {
    return Response.json(
      { error: "too_many_requests" },
      {
        status: 429,
        headers: { "retry-after": String(result.retryAfterSeconds ?? 60) },
      },
    );
  }
  if (result.status === 400) {
    return Response.json({ error: "unknown_location" }, { status: 400 });
  }

  // 202, and deliberately opaque. The recipient hash stays server-side; queuing the
  // farmer prompt is the outbox worker's job, not this response's.
  return Response.json({ accepted: true }, { status: 202 });
}
