import type { Clock, InventoryInterpreter } from "@farm-friend/core";
import type { InquiryModel } from "@farm-friend/ai";
import {
  applyDeliveryEvent,
  authorizeDispatch,
  claimNextInboundEvent,
  recordDispatchResult,
  releaseAbandonedClaims,
  CONFIRMATION_WINDOW_MS,
  type Db,
} from "@farm-friend/db";
import { redactOutbound } from "@farm-friend/sms";
import type { AppContext } from "./composition";
import { handleFreeText } from "./free-text";
import { routeInboundMessage, type RoutedReply } from "./routing";

// Bounded workers (docs/ARCHITECTURE.md §outbound dispatch and recovery).
//
// External interpreter and SMS calls happen HERE, outside every business transaction.
// The transaction commits the decision and the outbox work; these workers perform the
// I/O and record the outcome. Abandoned inbound claims recover; an uncertain authorized
// send becomes ambiguous rather than being resent.

export interface InboundWorkerDeps {
  db: Db;
  interpreter: InventoryInterpreter;
  inquiry: InquiryModel;
  clock: Clock;
  /** Bound on how much work one pass will do. */
  maxEvents?: number;
}

export interface WorkerPassResult {
  processed: number;
  recovered: number;
}

/**
 * Senders with a pending inbound event, most-delayed first.
 *
 * Enumeration belongs to the PASS, not to its caller. While these workers took a
 * caller-supplied ID list they could not be invoked by a scheduler at all — a cron route
 * has no way to know which senders are waiting — which is why nothing routed inbound SMS
 * (F-023). One sender appears once per pass: `claimNextInboundEvent` takes at most one
 * event per sender anyway, and the next pass picks up the rest.
 */
async function pendingSenderHashes(db: Db, limit: number): Promise<string[]> {
  const rows = await db.sql`
    select sender_hash, min(occurred_at) as oldest
    from provider_inbox_events
    where state = 'pending' and event_type = 'message_received'
      and sender_hash is not null
    group by sender_hash
    order by oldest asc
    limit ${limit}
  `;
  return rows.map((row) => (row as Record<string, unknown>).sender_hash as string);
}

/**
 * Queue the replies a routing decision produced. `on conflict do nothing` on the logical
 * key is what makes a recovered or replayed event reuse its row instead of sending a
 * second identical SMS to a real person.
 */
async function queueReplies(
  db: Db,
  recipientHash: string,
  replies: RoutedReply[],
  now: Date,
): Promise<void> {
  const bodyTtlMs = 30 * 24 * 60 * 60 * 1000;
  for (const reply of replies) {
    await db.sql`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at,
        available_at, created_at
      )
      values (
        ${reply.logicalKey}, ${recipientHash}, ${reply.category}, ${reply.body},
        ${new Date(now.getTime() + bodyTtlMs)}, ${now}, ${now}
      )
      on conflict (logical_key) do nothing
    `;
  }
}

/**
 * Recover lapsed claims, then route a bounded number of pending inbound events. Each event
 * is claimed in one short transaction, ROUTED outside any transaction, and finalized in
 * another.
 *
 * Routing is the deterministic order in `routing.ts`: compliance keywords and confirmation
 * tokens are handled by code before any model call, and only free text reaches a seam.
 *
 * `senderHashes` is optional and exists for tests that want to drive one sender; a pass
 * with no argument enumerates its own work, which is what the scheduler calls.
 */
export async function runInboundPass(
  deps: InboundWorkerDeps,
  senderHashes?: string[],
): Promise<WorkerPassResult> {
  const now = deps.clock.now();
  const recovered = await releaseAbandonedClaims(deps.db, { now });

  const limit = deps.maxEvents ?? 25;
  const senders = senderHashes ?? (await pendingSenderHashes(deps.db, limit));
  let processed = 0;

  for (const senderHash of senders) {
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
      const routed = await routeInboundMessage(
        {
          db: deps.db,
          clock: deps.clock,
          freeText: (input) =>
            handleFreeText(
              {
                db: deps.db,
                interpreter: deps.interpreter,
                inquiry: deps.inquiry,
                clock: deps.clock,
              },
              input,
            ),
        },
        {
          senderHash: claimed.senderHash,
          body: claimed.body,
          occurredAt: claimed.occurredAt,
          providerEventId: claimed.providerEventId,
          inboxEventId: claimed.inboxEventId,
        },
      );

      await queueReplies(
        deps.db,
        claimed.senderHash,
        routed.replies,
        deps.clock.now(),
      );

      await claimed.finalize({ outcome: "processed", now: deps.clock.now() });
    } catch {
      // Leave the claim to lapse and be recovered rather than losing the event. The
      // consent transition, if one committed, is already durable on its own watermark.
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

/** Outbox work that is queued and due, oldest first. */
async function queuedOutboxWorkIds(db: Db, now: Date, limit: number): Promise<string[]> {
  const rows = await db.sql`
    select id from outbox_work
    where state = 'queued' and available_at <= ${now}
    order by created_at asc
    limit ${limit}
  `;
  return rows.map((row) => (row as Record<string, unknown>).id as string);
}

/**
 * Start the confirmation window for a proposal whose prompt the provider just accepted.
 *
 * This is what makes "a token predating its prompt cannot commit" true in production: a
 * proposal is committable only from the moment Telnyx accepted the prompt describing the
 * version being confirmed. Before this runs, `confirmationEligibility` reports
 * `not_activated` and a `YES` commits nothing.
 */
async function activateAcceptedPrompt(
  db: Db,
  outboxWorkId: string,
  acceptedAt: Date,
): Promise<void> {
  await db.sql`
    update inventory_publication_proposals
    set activation_outbox_id = ${outboxWorkId},
        activated_version = proposal_version,
        activated_at = ${acceptedAt},
        expires_at = ${new Date(acceptedAt.getTime() + CONFIRMATION_WINDOW_MS)},
        updated_at = ${acceptedAt}
    where state = 'open'
      and sender_hash = (
        select recipient_hash from outbox_work where id = ${outboxWorkId}
      )
      and (
        select message_category from outbox_work where id = ${outboxWorkId}
      ) = 'inventory_confirmation'
  `;
}

/**
 * Dispatch queued outbox work. The dispatch claim is committed first — it is STOP's
 * linearization point — and only then is the provider called.
 *
 * `outboxWorkIds` is optional and exists for tests driving specific rows; a pass with no
 * argument enumerates its own due work, which is what the scheduler calls.
 */
export async function runOutboundPass(
  deps: OutboundWorkerDeps,
  outboxWorkIds?: string[],
): Promise<{ sent: number; suppressed: number; ambiguous: number }> {
  const limit = deps.maxMessages ?? 25;
  let sent = 0;
  let suppressed = 0;
  let ambiguous = 0;

  const work =
    outboxWorkIds ??
    (await queuedOutboxWorkIds(deps.context.db, deps.clock.now(), limit));

  for (const outboxWorkId of work.slice(0, limit)) {
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

    if (result.outcome === "accepted") {
      // The provider accepted this prompt, so the confirmation window opens now. A
      // non-confirmation message matches no open proposal and this is a no-op.
      await activateAcceptedPrompt(
        deps.context.db,
        outboxWorkId,
        deps.clock.now(),
      );
      sent += 1;
    }
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
