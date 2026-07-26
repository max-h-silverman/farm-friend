import { describe, expect, it, vi } from "vitest";
import { kickSenderPasses, type KickDeps } from "./kick";

// B-004 — the low-latency kick's OWN contract, isolated from the database.
//
// The kick exists so an inbound reply does not wait for the next scheduled sweep. Its
// contract is deliberately small and almost entirely NEGATIVE: it must be incapable of
// affecting the webhook response. Everything durable still belongs to the passes it calls
// and to the cron recovery net behind it.
//
// These tests drive the failure modes a real serverless invocation produces — a pass that
// rejects, a pass that hangs — because those are exactly the cases where a kick could
// otherwise turn a successful ingress into a 500 and make Telnyx retry a message that was
// already durably accepted.

/** A kick whose passes both resolve, recording the order they ran in. */
function recordingDeps(order: string[]): KickDeps {
  return {
    runInbound: async () => {
      order.push("inbound");
      return { processed: 1, recovered: 0 };
    },
    runOutbound: async () => {
      order.push("outbound");
      return { sent: 1, suppressed: 0, ambiguous: 0 };
    },
  };
}

describe("the inbound kick (B-004)", () => {
  it("runs the inbound pass before the outbound pass", async () => {
    // Ordering is what makes ONE kick deliver a reply: the inbound pass queues the outbox
    // row that the outbound pass then dispatches. Reversed, the reply would wait for cron
    // and the kick would buy nothing.
    const order: string[] = [];
    await kickSenderPasses(recordingDeps(order), "sender-hash");

    expect(order).toEqual(["inbound", "outbound"]);
  });

  it("passes the ONE sender's hash to the inbound pass, not an unbounded sweep", async () => {
    // The kick is scoped to the sender whose webhook just arrived. An unscoped kick would
    // make every inbound webhook a full sweep of all pending senders — the cron pass's job,
    // and a way to multiply work under load.
    const seen: (string[] | undefined)[] = [];
    await kickSenderPasses(
      {
        runInbound: async (senderHashes) => {
          seen.push(senderHashes);
          return { processed: 0, recovered: 0 };
        },
        runOutbound: async () => ({ sent: 0, suppressed: 0, ambiguous: 0 }),
      },
      "sender-hash",
    );

    expect(seen).toEqual([["sender-hash"]]);
  });

  it("resolves rather than rejecting when the inbound pass throws", async () => {
    // A rejecting kick must never become the webhook's problem. If this rejected, the
    // route's floating call would raise an unhandled rejection and — depending on the
    // runtime — fail an invocation whose 200 was already correct.
    const outbound = vi.fn(async () => ({ sent: 0, suppressed: 0, ambiguous: 0 }));

    await expect(
      kickSenderPasses(
        {
          runInbound: async () => {
            throw new Error("inbound pass exploded");
          },
          runOutbound: outbound,
        },
        "sender-hash",
      ),
    ).resolves.toBeUndefined();
  });

  it("still attempts the outbound pass when the inbound pass throws", async () => {
    // The two passes fail independently. Outbox work queued by an EARLIER inbound pass is
    // still due, so a broken inbound pass must not also strand a ready reply until cron.
    const outbound = vi.fn(async () => ({ sent: 0, suppressed: 0, ambiguous: 0 }));

    await kickSenderPasses(
      {
        runInbound: async () => {
          throw new Error("inbound pass exploded");
        },
        runOutbound: outbound,
      },
      "sender-hash",
    );

    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("resolves rather than rejecting when the outbound pass throws", async () => {
    await expect(
      kickSenderPasses(
        {
          runInbound: async () => ({ processed: 1, recovered: 0 }),
          runOutbound: async () => {
            throw new Error("outbound pass exploded");
          },
        },
        "sender-hash",
      ),
    ).resolves.toBeUndefined();
  });

  it("gives up on a hung pass instead of running until the invocation is killed", async () => {
    // A pass that never settles must not hold the kick open indefinitely. The budget is
    // what keeps a wedged model or provider call from consuming the whole invocation; the
    // abandoned work is recovered by cron exactly like any other lapsed claim.
    vi.useFakeTimers();
    try {
      const kick = kickSenderPasses(
        {
          runInbound: () => new Promise(() => {}),
          runOutbound: async () => ({ sent: 0, suppressed: 0, ambiguous: 0 }),
        },
        "sender-hash",
        { budgetMs: 1_000 },
      );

      await vi.advanceTimersByTimeAsync(1_500);
      await expect(kick).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
