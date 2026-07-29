import { describe, expect, it, vi } from "vitest";
import {
  createNoopImmediateWork,
  enqueueSenderWork,
  taskNameFor,
  type ImmediateWorkQueue,
} from "./immediate-work";

// The seam that replaces `waitUntil` (docs/GCP_MIGRATION_PLAN.md §"Immediate and scheduled
// work").
//
// WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT.
//
// `waitUntil` registered a promise with the Vercel runtime; it shared the function timeout
// and was CANCELLED when that elapsed, so the kick was best-effort by construction. A Cloud
// Task is durable the moment it is created: the queue owns it, retries it, and survives the
// container that enqueued it. That is a real gain and it is why the migration is worth doing
// at equal cost.
//
// It is NOT a licence to move a guarantee here. The scheduled pass remains the recovery net
// and the only trigger for the retention purge, exactly as before. Enqueueing is best-effort
// in the one direction that matters: a failure to enqueue must never fail an ingress whose
// durable commit already succeeded, because Telnyx would then retry a message Farm Friend
// has already accepted. The task makes the reply FAST; the database makes it CERTAIN.

const senderHash = "a".repeat(64);
const providerEventId = "evt-12345";

describe("task naming", () => {
  it("derives the task name from the provider event id", () => {
    // Deterministic naming is what makes duplicate enqueueing a no-op at the QUEUE, not
    // merely at the worker. Telnyx retries a webhook it thinks failed; without a stable
    // name, each retry creates another task and the sender's passes run N times.
    const a = taskNameFor(providerEventId);
    const b = taskNameFor(providerEventId);
    expect(a).toBe(b);
    expect(a).not.toBe(taskNameFor("evt-other"));
  });

  it("produces a name Cloud Tasks will accept", () => {
    // Cloud Tasks names permit only letters, digits, hyphens, and underscores. A provider
    // ID containing anything else must be normalized rather than rejected at the API, which
    // would turn a valid message into an enqueue failure.
    const name = taskNameFor("evt/with+odd:chars=");
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not collide for provider ids differing only in punctuation", () => {
    // Naive normalization (strip the offending characters) maps "a/b" and "ab" to one name,
    // silently dropping the second sender's work. The name must stay injective.
    expect(taskNameFor("evt/1")).not.toBe(taskNameFor("evt1"));
  });
});

describe("enqueueing sender work", () => {
  it("enqueues exactly one task carrying only the sender hash and event id", async () => {
    // The payload is a MINIMAL PROJECTION, like every other seam in this system. A task
    // body is stored by the queue and appears in operational surfaces, so it never carries
    // a phone number, a message body, or a provider envelope — only the two opaque
    // identifiers the worker needs to find its own work.
    const created: unknown[] = [];
    const queue: ImmediateWorkQueue = {
      enqueue: async (task) => {
        created.push(task);
      },
    };

    await enqueueSenderWork(queue, { senderHash, providerEventId });

    expect(created).toHaveLength(1);
    const task = created[0] as { name: string; senderHash: string; providerEventId: string };
    expect(task.senderHash).toBe(senderHash);
    expect(task.providerEventId).toBe(providerEventId);
    expect(task.name).toBe(taskNameFor(providerEventId));

    // Nothing else. Asserted over the whole serialized task so a future field cannot be
    // added without this failing.
    expect(Object.keys(task).sort()).toEqual([
      "name",
      "providerEventId",
      "senderHash",
    ]);
  });

  it("reports success when the queue says the task already exists", async () => {
    // The duplicate case is the NORMAL case, not an error: a Telnyx webhook retry reaches
    // ingress twice and both attempts enqueue the same deterministic name. Cloud Tasks
    // answers the second with ALREADY_EXISTS, which means "the work is queued" — precisely
    // what the caller wanted. Treating it as a failure would produce alarming operational
    // noise for the system working correctly.
    const queue: ImmediateWorkQueue = {
      enqueue: async () => {
        const error = new Error("already exists") as Error & { code?: number };
        error.code = 6; // gRPC ALREADY_EXISTS
        throw error;
      },
    };

    const result = await enqueueSenderWork(queue, { senderHash, providerEventId });
    expect(result.enqueued).toBe(true);
    expect(result.duplicate).toBe(true);
  });

  it("never throws when the queue is unreachable", async () => {
    // THE LOAD-BEARING PROPERTY. The inbox event is already committed and Telnyx is already
    // owed its 200 by the time this runs. If a queue outage could propagate out of here, an
    // ingress that SUCCEEDED would return 5xx, Telnyx would retry a message Farm Friend has
    // accepted, and a queue outage would become a duplicate-message incident.
    //
    // The scheduled pass recovers the sender within the minute either way, so the cost of
    // swallowing this is latency alone.
    const queue: ImmediateWorkQueue = {
      enqueue: async () => {
        throw new Error("DEADLINE_EXCEEDED: could not reach Cloud Tasks");
      },
    };

    const result = await enqueueSenderWork(queue, { senderHash, providerEventId });
    expect(result.enqueued).toBe(false);
    expect(result.duplicate).toBe(false);
  });

  it("never throws when the queue rejects the task synchronously", async () => {
    // Same guarantee against a synchronous throw, which a misconfigured client library
    // produces before it ever performs I/O.
    const queue: ImmediateWorkQueue = {
      enqueue: () => {
        throw new Error("queue client not configured");
      },
    };

    await expect(
      enqueueSenderWork(queue, { senderHash, providerEventId }),
    ).resolves.toEqual({ enqueued: false, duplicate: false });
  });

  it("does not retry a failed enqueue itself", async () => {
    // Retrying here would hold the response open on a failing dependency — the exact cost
    // the enqueue-then-return design exists to avoid. The queue has its own retry policy
    // and the minute worker is the durable net; this call gets one attempt.
    const enqueue = vi.fn(async () => {
      throw new Error("unavailable");
    });

    await enqueueSenderWork({ enqueue }, { senderHash, providerEventId });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("the no-op queue", () => {
  it("reports work as not enqueued rather than pretending it succeeded", async () => {
    // Used where no queue is configured — local development and tests. It must not claim
    // success: `enqueued: false` is what tells an operational surface that this deployment
    // relies entirely on the scheduled pass, and a cheerful `true` here would hide that.
    const result = await enqueueSenderWork(createNoopImmediateWork(), {
      senderHash,
      providerEventId,
    });
    expect(result.enqueued).toBe(false);
  });
});
