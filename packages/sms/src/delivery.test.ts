import { describe, expect, it, vi } from "vitest";
import { createLastMileSender, type PhoneResolver } from "./delivery";
import { redactOutbound } from "./redaction";

// F-014 — the last-mile capability is the ONLY place a dialable raw E.164 is resolved.
// Queued work, workflow values, idempotency keys, metrics, and logs stay hash-only, and
// no second raw-phone field is created anywhere.

const recipientHash = "a".repeat(64);
const rawPhone = "+12065550123";

const resolver: PhoneResolver = {
  async resolveForDelivery(hash) {
    return hash === recipientHash ? rawPhone : null;
  },
};

describe("last-mile delivery capability", () => {
  it("resolves the raw number only at the provider call", async () => {
    const transport = vi.fn(async () => ({ providerMessageId: "pm-1" }));
    const send = createLastMileSender({ resolver, transport });

    const result = await send({
      recipientHash,
      body: redactOutbound("Your listing is updated."),
      idempotencyKey: "outbox-1",
    });

    expect(result).toEqual({ outcome: "accepted", providerMessageId: "pm-1" });
    expect(transport).toHaveBeenCalledWith({
      toPhone: rawPhone,
      body: "Your listing is updated.",
      idempotencyKey: "outbox-1",
    });
  });

  it("never returns or logs the raw number", async () => {
    const logged: unknown[] = [];
    const send = createLastMileSender({
      resolver,
      transport: async () => ({ providerMessageId: "pm-2" }),
      logger: (entry) => logged.push(entry),
    });

    const result = await send({
      recipientHash,
      body: redactOutbound("hello"),
      idempotencyKey: "outbox-2",
    });

    expect(JSON.stringify(result)).not.toContain(rawPhone);
    expect(JSON.stringify(logged)).not.toContain(rawPhone);
    // Logs identify the recipient by hash only.
    expect(JSON.stringify(logged)).toContain(recipientHash);
  });

  it("fails closed when the recipient has no stored number", async () => {
    const transport = vi.fn(async () => ({ providerMessageId: "pm-3" }));
    const send = createLastMileSender({ resolver, transport });

    const result = await send({
      recipientHash: "b".repeat(64),
      body: redactOutbound("hello"),
      idempotencyKey: "outbox-3",
    });

    expect(result.outcome).toBe("definitive_rejection");
    expect(transport).not.toHaveBeenCalled();
  });

  it("classifies a timeout as ambiguous rather than retryable", async () => {
    const send = createLastMileSender({
      resolver,
      transport: async () => {
        const error = new Error("socket hang up") as Error & { code?: string };
        error.code = "ETIMEDOUT";
        throw error;
      },
    });

    const result = await send({
      recipientHash,
      body: redactOutbound("hello"),
      idempotencyKey: "outbox-4",
    });

    // The provider may have accepted it; resending could duplicate a real SMS.
    expect(result.outcome).toBe("ambiguous");
  });

  it("classifies an explicit provider rejection as definitive", async () => {
    const send = createLastMileSender({
      resolver,
      transport: async () => {
        const error = new Error("invalid number") as Error & { status?: number };
        error.status = 422;
        throw error;
      },
    });

    const result = await send({
      recipientHash,
      body: redactOutbound("hello"),
      idempotencyKey: "outbox-5",
    });

    expect(result.outcome).toBe("definitive_rejection");
  });

  it("treats a 5xx or unknown failure as ambiguous", async () => {
    for (const status of [500, 502, undefined]) {
      const send = createLastMileSender({
        resolver,
        transport: async () => {
          const error = new Error("boom") as Error & { status?: number };
          error.status = status;
          throw error;
        },
      });

      const result = await send({
        recipientHash,
        body: redactOutbound("hello"),
        idempotencyKey: `outbox-${status}`,
      });

      expect(result.outcome).toBe("ambiguous");
    }
  });
});
