import type { Clock, InventoryInterpreter } from "@farm-friend/core";
import type { FarmerMessageIntentModel, InquiryModel } from "@farm-friend/ai";
import {
  applyPendingDeliveryEvents,
  authorizeDispatch,
  claimNextInboundEvent,
  recordDispatchResult,
  recoverAbandonedDispatches,
  releaseAbandonedClaims,
  purgeExpiredBodies,
  type Db,
  type DeliveryPassResult,
  type RetentionPassResult,
} from "@farm-friend/db";
import { redactOutbound } from "@farm-friend/sms";
import type { AppContext } from "./composition";
import { handleFreeText } from "./free-text";
import { handleNextPage } from "./paging";
import { handleFarmerTarget, handleStandSelection } from "./farmer-targeting";
import { routeInboundMessage, type RoutedReply } from "./routing";
import { handleScheduledSame } from "./scheduled-same";

// Bounded workers (docs/ARCHITECTURE.md §outbound dispatch and recovery).
//
// External interpreter and SMS calls happen HERE, outside every business transaction.
// The transaction commits the decision and the outbox work; these workers perform the
// I/O and record the outcome. Abandoned inbound claims recover; an uncertain authorized
// send becomes ambiguous rather than being resent.

export interface InboundWorkerDeps {
  db: Db;
  farmerIntent: FarmerMessageIntentModel;
  interpreter: InventoryInterpreter;
  inquiry: InquiryModel;
  clock: Clock;
  /**
   * The CONFIGURED public origin a farmer's standing link is built against (F-040). Passed
   * down rather than read from the request, so no inbound header can influence where a
   * texted credential points.
   */
  publicBaseUrl: string;
  /** Configured canonical customer map URL for the deterministic MAP command. */
  publicMapUrl: string;
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

    // GL-002: staleness is PASSED to the router, not applied before it.
    //
    // This pass used to reject every stale event here, ahead of any parsing. That silently
    // discarded a `STOP` delayed behind a newer message — a compliance failure, because
    // consent orders itself on its own watermark and never needed the conversation one.
    // `routeInboundMessage` owns which messages the staleness rule may refuse; it returns a
    // `stale` outcome for those, which this loop finalizes exactly as before.
    //
    // Finalizing a routed stale event as `processed` cannot corrupt ordering:
    // `claimNextInboundEvent` guards the watermark update with `!isStale`, so a late STOP
    // never rolls the conversation watermark backwards.
    try {
      const routed = await routeInboundMessage(
        {
          db: deps.db,
          clock: deps.clock,
          publicBaseUrl: deps.publicBaseUrl,
          publicMapUrl: deps.publicMapUrl,
          freeText: (input) =>
            handleFreeText(
              {
                db: deps.db,
                farmerIntent: deps.farmerIntent,
                interpreter: deps.interpreter,
                inquiry: deps.inquiry,
                clock: deps.clock,
              },
              input,
            ),
          // F-046. No model dependency is passed, and none exists to pass: paging is code
          // end to end, so `MORE` cannot reach a seam even by mistake.
          nextPage: (input) =>
            handleNextPage({ db: deps.db, clock: deps.clock }, input),
          // F-051. These handlers receive database + configured origin only. In particular,
          // neither interpreter nor inquiry model crosses this deterministic seam.
          farmerTarget: (input) =>
            handleFarmerTarget(
              { db: deps.db, publicBaseUrl: deps.publicBaseUrl },
              input,
            ),
          selectStand: (input) =>
            handleStandSelection(
              { db: deps.db, publicBaseUrl: deps.publicBaseUrl },
              input,
            ),
          scheduledSame: (input) =>
            handleScheduledSame({ db: deps.db, clock: deps.clock }, input),
        },
        {
          senderHash: claimed.senderHash,
          body: claimed.body,
          occurredAt: claimed.occurredAt,
          providerEventId: claimed.providerEventId,
          inboxEventId: claimed.inboxEventId,
          isStale: claimed.isStale,
        },
      );

      if (routed.outcome.kind === "stale") {
        // Fail closed: an out-of-order event never mutates newer conversation state. The
        // router produced no replies and no durable consequence for it.
        await claimed.finalize({
          outcome: "rejected",
          now: deps.clock.now(),
          failureCode: routed.outcome.failureCode,
        });
        processed += 1;
        continue;
      }

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
 * Dispatch queued outbox work. The dispatch claim is committed first — it is STOP's
 * linearization point — and only then is the provider called.
 *
 * `outboxWorkIds` is optional and exists for tests driving specific rows; a pass with no
 * argument enumerates its own due work, which is what the scheduler calls.
 *
 * ## Abandoned claims (GL-003)
 *
 * The claim commits `dispatching` before the body read, redaction, recipient resolution,
 * provider call, and result recording — every one of which can throw, and the process can
 * die outright. Two defenses, and they are deliberately different in kind:
 *
 *   - **Per-row isolation.** A throw is caught around each row so ONE poisoned message
 *     cannot abort the pass and block every other sender's reply. The row is left
 *     `dispatching` rather than guessed at.
 *   - **A durable lease.** `recoverAbandonedDispatches` resolves rows stranded past
 *     `DISPATCH_LEASE_MS` into `ambiguous`. That is the honest state: we do not know whether
 *     the provider accepted the message, so it is never resent and never silently dropped.
 *
 * The catch cannot substitute for the lease — a killed process runs no catch block — and the
 * lease cannot substitute for the catch, which is why both exist.
 */
export async function runOutboundPass(
  deps: OutboundWorkerDeps,
  outboxWorkIds?: string[],
): Promise<{
  sent: number;
  suppressed: number;
  ambiguous: number;
  failed: number;
  recovered: number;
}> {
  const limit = deps.maxMessages ?? 25;
  let sent = 0;
  let suppressed = 0;
  let ambiguous = 0;
  let failed = 0;

  // Before claiming anything new, resolve claims a previous pass abandoned. Running it
  // first means a stranded row is quarantined in the same pass that would otherwise walk
  // past it, and it is bounded like every other pass.
  const recovered = await recoverAbandonedDispatches(deps.context.db, {
    now: deps.clock.now(),
    limit,
  });

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

    try {
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
        // B-010: carry the provider's own code and sentence into the row an operator reads.
        // Diagnostics only — nothing here changes what the dispatcher decides.
        providerCode: result.outcome === "accepted" ? undefined : result.providerCode,
        providerErrorDetail:
          result.outcome === "accepted" ? undefined : result.errorDetail,
        now: deps.clock.now(),
      });

      if (result.outcome === "accepted") {
        // The result transaction also opened an exact current confirmation prompt. A
        // non-confirmation message or an older proposal version matched nothing.
        sent += 1;
      }
      if (result.outcome === "ambiguous") ambiguous += 1;
    } catch {
      // GL-003 — isolate the row, never the pass.
      //
      // Deliberately NOT resolved here. The throw may have come from `sendSms` itself, in
      // which case the provider's view of this message is unknown: writing a terminal state
      // now would either claim a delivery that did not happen or requeue one that did. The
      // row stays `dispatching` and the lease resolves it as `ambiguous` — the state that
      // honestly says "we do not know" — after enough time has passed that no in-flight
      // call could still land.
      //
      // Nothing is logged: the failure carries a recipient correlation, and the durable row
      // is where an operator reads this. Counted so the pass result stops overstating
      // success (GL-016 will give this a content-free diagnostic).
      failed += 1;
    }
  }

  return { sent, suppressed, ambiguous, failed, recovered };
}

export interface RetentionWorkerDeps {
  db: Db;
  clock: Clock;
  /** Bound on how many rows of each kind one pass will clear. */
  maxRows?: number;
}

/**
 * Clear raw message context whose retention window has closed (F-026).
 *
 * The third bounded pass, alongside inbound and outbound. Like them it enumerates its own
 * work — the trigger supplies no IDs and needs no knowledge of state — and returns counts
 * only. It deliberately reports NOTHING about what it purged: an operator learns how much
 * was cleared, never whose message or what it said.
 */
export async function runRetentionPass(
  deps: RetentionWorkerDeps,
): Promise<RetentionPassResult> {
  return purgeExpiredBodies(deps.db, {
    now: deps.clock.now(),
    limit: deps.maxRows,
  });
}

export interface DeliveryWorkerDeps {
  db: Db;
  clock: Clock;
  /** Bound on how many callbacks one pass will consume. */
  maxEvents?: number;
}

/**
 * Apply the delivery callbacks the webhook durably stored (B-012).
 *
 * The FOURTH bounded pass, alongside inbound, outbound, and retention. Like them it
 * enumerates its own work and returns counts only.
 *
 * This pass is what makes `outbox_work.delivery_status` mean anything. Without it the
 * webhook's `message.sent` / `message.finalized` rows sat `pending` forever — 20 of them in
 * production — so `sent` in the outbox recorded that Telnyx ACCEPTED a message and never
 * whether the carrier delivered it. That is precisely the distinction a farmer who never
 * received a prompt is diagnosed from, and the data B-011's carrier block would show up in.
 *
 * Deliberately NOT the per-sender inbound path: a delivery callback carries no sender and
 * no conversational meaning, so serializing it behind a farmer's conversation would be the
 * wrong shape, and advancing a conversation watermark from it would make that sender's next
 * real message look stale. `applyPendingDeliveryEvents` holds the claim and the exactly-once
 * guarantees; see its contract in packages/db/src/transactions.ts.
 */
export async function runDeliveryPass(
  deps: DeliveryWorkerDeps,
): Promise<DeliveryPassResult> {
  return applyPendingDeliveryEvents(deps.db, {
    now: deps.clock.now(),
    limit: deps.maxEvents,
  });
}
