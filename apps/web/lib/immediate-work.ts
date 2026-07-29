import { createHash } from "node:crypto";

// The immediate-work seam (docs/GCP_MIGRATION_PLAN.md §"Immediate and scheduled work").
//
// This replaces `waitUntil` as the fast path from "a message arrived" to "the reply is
// sent". The difference is durability, and it is the reason the migration is worth doing
// even at equal cost:
//
//   - `waitUntil` registered a promise with the Vercel runtime. It shared the function
//     timeout and was CANCELLED when that elapsed, so the kick was best-effort BY
//     CONSTRUCTION — the platform could take it away mid-pass and nothing recorded that it
//     had. B-009 was the sharper version of the same lesson: a promise the runtime does not
//     know about does not run at all.
//   - A Cloud Task is durable the moment it is created. The queue owns it, retries it on its
//     own policy, and it survives the container that enqueued it. Post-response work stops
//     depending on the lifetime of the request that scheduled it.
//
// WHAT DOES NOT CHANGE. The scheduled pass remains the recovery net and the only trigger for
// F-026's retention purge. Every correctness guarantee still lives in Postgres — the inbox's
// unique provider event ID, `claimNextInboundEvent`'s row lock, `authorizeDispatch`'s consent
// recheck. This seam only decides how SOON that machinery runs, never whether it is correct.
// Removing it entirely must fail latency tests and no durability test.
//
// Deliberately NOT a Cloud Tasks client. This module is pure: it defines the seam, the task
// name, and the failure policy, and takes the queue as an argument. The adapter that talks
// to Google lives in `immediate-work-cloud-tasks.ts`, so nothing here needs a network, a
// credential, or a mock of one.

/** The minimal projection a task carries. Never a phone, a body, or a provider envelope. */
export interface SenderWorkTask {
  /** Deterministic, derived from the provider event id. */
  readonly name: string;
  readonly senderHash: string;
  readonly providerEventId: string;
}

/** The queue capability, injected so this module needs no client of its own. */
export interface ImmediateWorkQueue {
  enqueue(task: SenderWorkTask): Promise<void> | void;
}

export interface EnqueueResult {
  /** True when the work is queued — including when it was already queued. */
  readonly enqueued: boolean;
  /** True when the queue reported this exact task already existed. */
  readonly duplicate: boolean;
}

/** gRPC status code for ALREADY_EXISTS, which Cloud Tasks returns for a duplicate name. */
const GRPC_ALREADY_EXISTS = 6;

/**
 * Derive the task name for a provider event.
 *
 * Deterministic because that is what makes duplicate delivery a no-op AT THE QUEUE rather
 * than only at the worker. Telnyx retries a webhook whose response it did not like, and
 * without a stable name each retry would create another task and run the sender's passes
 * again — extra model calls, extra provider calls, and a race against the first task's own
 * claims. With it, the second creation is refused by the queue itself.
 *
 * The name is a hash rather than the ID with unsafe characters stripped. Cloud Tasks admits
 * only `[A-Za-z0-9_-]`, and stripping is not injective: "evt/1" and "evt1" would collapse to
 * one name and the second sender's work would vanish silently. Hashing keeps distinct events
 * distinct whatever the provider puts in an ID.
 */
export function taskNameFor(providerEventId: string): string {
  const digest = createHash("sha256").update(providerEventId).digest("hex");
  return `inbound-${digest.slice(0, 32)}`;
}

/**
 * Enqueue one sender's immediate work. NEVER THROWS.
 *
 * That is the load-bearing property, and it is a deliberate asymmetry rather than sloppiness.
 * By the time this is called the inbox event is durably committed and the 200 is already
 * built: ingress has SUCCEEDED. Letting a queue outage propagate would turn that success into
 * a 5xx, Telnyx would retry a message Farm Friend has already accepted, and an outage in a
 * latency optimization would become a duplicate-message incident affecting real people.
 *
 * The cost of swallowing it is bounded and small: the scheduled pass picks the sender up
 * within the minute. Latency degrades; nothing is lost. That trade is the same one
 * `kickSenderPasses` already makes, for the same reason.
 *
 * One attempt only — no retry loop. Retrying here would hold the response open on a failing
 * dependency, which is exactly what enqueue-then-return exists to avoid. The queue has its
 * own retry policy for tasks it accepted, and the scheduler covers the ones it never did.
 */
export async function enqueueSenderWork(
  queue: ImmediateWorkQueue,
  work: { senderHash: string; providerEventId: string },
): Promise<EnqueueResult> {
  const task: SenderWorkTask = {
    name: taskNameFor(work.providerEventId),
    senderHash: work.senderHash,
    providerEventId: work.providerEventId,
  };

  try {
    // Awaited inside the try so a synchronous throw from a misconfigured client is caught
    // alongside a rejected promise.
    await queue.enqueue(task);
    return { enqueued: true, duplicate: false };
  } catch (error) {
    // ALREADY_EXISTS is the system working, not failing. A webhook retry reaching ingress
    // twice produces the same deterministic name, and the queue refusing the second copy is
    // the deduplication doing its job. Reporting it as an error would make correct operation
    // look like an incident.
    if (isAlreadyExists(error)) {
      return { enqueued: true, duplicate: true };
    }
    // Everything else: swallowed by design. Nothing is logged here — the failure carries a
    // sender correlation, and the durable row in `provider_inbox_events` is where an
    // operator reads that this sender is waiting.
    return { enqueued: false, duplicate: false };
  }
}

function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === GRPC_ALREADY_EXISTS) return true;
  // The REST transport reports the same condition as HTTP 409.
  if (code === 409) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /already[ _]?exists/i.test(message);
}

/**
 * The queue used where none is configured — local development, tests, and any deployment
 * running on the scheduled pass alone.
 *
 * It reports `enqueued: false` rather than a cheerful success. That distinction is what lets
 * an operational surface tell "this deployment has no fast path" from "the fast path is
 * working", and a no-op claiming success would hide a missing queue configuration behind
 * green counters — the same shape of defect as GL-019's silent stub provider.
 */
export function createNoopImmediateWork(): ImmediateWorkQueue {
  return {
    enqueue: () => {
      throw new Error("no immediate-work queue configured");
    },
  };
}
