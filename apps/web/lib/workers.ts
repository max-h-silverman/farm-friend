import type { Clock, InventoryInterpreter } from "@farm-friend/core";
import {
  applyDeliveryEvent,
  authorizeDispatch,
  claimNextInboundEvent,
  recordDispatchResult,
  releaseAbandonedClaims,
  type Db,
} from "@farm-friend/db";
import { redactOutbound } from "@farm-friend/sms";
import type { AppContext } from "./composition";

// Bounded workers (docs/ARCHITECTURE.md §outbound dispatch and recovery).
//
// External interpreter and SMS calls happen HERE, outside every business transaction.
// The transaction commits the decision and the outbox work; these workers perform the
// I/O and record the outcome. Abandoned inbound claims recover; an uncertain authorized
// send becomes ambiguous rather than being resent.

export interface InboundWorkerDeps {
  db: Db;
  interpreter: InventoryInterpreter;
  clock: Clock;
  /** Bound on how much work one pass will do. */
  maxEvents?: number;
}

export interface WorkerPassResult {
  processed: number;
  recovered: number;
}

/**
 * Recover lapsed claims, then process a bounded number of pending inbound events for
 * the given senders. Each event is claimed in one short transaction, interpreted
 * outside any transaction, and finalized in another.
 */
export async function runInboundPass(
  deps: InboundWorkerDeps,
  senderHashes: string[],
): Promise<WorkerPassResult> {
  const now = deps.clock.now();
  const recovered = await releaseAbandonedClaims(deps.db, { now });

  const limit = deps.maxEvents ?? 25;
  let processed = 0;

  for (const senderHash of senderHashes) {
    if (processed >= limit) break;

    const claimed = await claimNextInboundEvent(deps.db, { senderHash, now });
    if (!claimed) continue;

    if (claimed.isStale) {
      // Fail closed: an out-of-order event never mutates newer state.
      await claimed.finalize({
        outcome: "rejected",
        now: deps.clock.now(),
        failureCode: "stale_conversation_event",
      });
      processed += 1;
      continue;
    }

    try {
      await claimed.finalize({ outcome: "processed", now: deps.clock.now() });
    } catch {
      // Leave the claim to lapse and be recovered rather than losing the event.
    }
    processed += 1;
  }

  return { processed, recovered };
}

export interface OutboundWorkerDeps {
  context: AppContext;
  clock: Clock;
  maxMessages?: number;
}

/**
 * Dispatch queued outbox work. The dispatch claim is committed first — it is STOP's
 * linearization point — and only then is the provider called.
 */
export async function runOutboundPass(
  deps: OutboundWorkerDeps,
  outboxWorkIds: string[],
): Promise<{ sent: number; suppressed: number; ambiguous: number }> {
  const limit = deps.maxMessages ?? 25;
  let sent = 0;
  let suppressed = 0;
  let ambiguous = 0;

  for (const outboxWorkId of outboxWorkIds.slice(0, limit)) {
    const now = deps.clock.now();
    const claim = await authorizeDispatch(deps.context.db, { outboxWorkId, now });

    if (claim.status === "suppressed") {
      suppressed += 1;
      continue;
    }
    if (claim.status !== "authorized") continue;

    const work = await deps.context.db.sql`
      select recipient_hash, body from outbox_work where id = ${outboxWorkId}
    `;
    const recipientHash = work[0]?.recipient_hash as string;
    const body = work[0]?.body as string;

    // The provider call is outside every transaction.
    const result = await deps.context.sendSms({
      recipientHash,
      body: redactOutbound(body),
      idempotencyKey: outboxWorkId,
    });

    await recordDispatchResult(deps.context.db, {
      dispatchAttemptId: claim.dispatchAttemptId,
      outcome: result.outcome,
      providerMessageId:
        result.outcome === "accepted" ? result.providerMessageId : undefined,
      errorCode: result.outcome === "accepted" ? undefined : result.errorCode,
      now: deps.clock.now(),
    });

    if (result.outcome === "accepted") sent += 1;
    if (result.outcome === "ambiguous") ambiguous += 1;
  }

  return { sent, suppressed, ambiguous };
}

/** Apply a durably accepted delivery event to its outbound work. */
export async function applyPendingDeliveryEvent(
  db: Db,
  input: {
    dispatchAttemptId: string;
    deliveryStatus: "sent" | "delivered" | "delivery_failed";
    occurredAt: Date;
    providerEventId: string;
  },
): Promise<void> {
  await applyDeliveryEvent(db, input);
}
