import { afterEach, describe, expect, it, vi } from "vitest";
import { createLastMileSender, type PhoneResolver } from "@farm-friend/sms";
import { createTelnyxTransport } from "./composition";

// B-010 — the provider's explanation reaches storage instead of being discarded.
//
// The two responses reproduced here are the REAL ones from 2026-07-27, and each cost hours:
//
//   400 → "The source phone number was deemed invalid by the carrier."  (TELNYX_FROM_NUMBER
//          was not exact E.164 — the sentence names the broken field outright)
//   409 → code 40300, "Blocked due to STOP message"                      (the carrier block
//          rule behind B-011)
//
// Both were recovered by curling Telnyx by hand, because the database held only '400' and
// '409'. This suite exercises the transport against those exact payloads, through the same
// classifier the dispatcher uses, and asserts the sentence survives the trip.
//
// The transport was UNEXPORTED and therefore untested until now, which is how the discard
// went unnoticed: every test above it used the simulator, which never fails.

const recipientHash = "b".repeat(64);
const resolver: PhoneResolver = {
  async resolveForDelivery() {
    return "+15551230000";
  },
};

const transport = () =>
  createTelnyxTransport({
    apiKey: "test-key",
    messagingProfileId: "profile-1",
    fromNumber: "+12065550000",
  });

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Telnyx transport preserves what the provider said", () => {
  it("carries the 400 sentence that names the misconfigured field", async () => {
    respondWith(400, {
      errors: [
        {
          code: "40001",
          title: "Invalid source number",
          detail: "The source phone number was deemed invalid by the carrier.",
        },
      ],
    });

    const send = createLastMileSender({ resolver, transport: transport() });
    const result = await send({
      recipientHash,
      body: "hello" as never,
      idempotencyKey: "outbox-400",
    });

    // 400 stays a definitive rejection: B-010 adds diagnostics and changes NO dispatch
    // decision. The retry policy still reads `errorCode`.
    expect(result.outcome).toBe("definitive_rejection");
    expect(result).toMatchObject({ errorCode: "400", providerCode: "40001" });
    // The sentence that would have ended the investigation in one query.
    expect((result as { errorDetail?: string }).errorDetail).toContain(
      "deemed invalid by the carrier",
    );
  });

  it("carries the 40300 code and masks the phones in its message", async () => {
    // The genuine 40300 body, both E.164 numbers included.
    respondWith(409, {
      errors: [
        {
          code: "40300",
          title: "Blocked due to STOP message",
          detail:
            "Messages cannot be sent from '+12068645326' to '+15163178228' due to an existing block rule.",
        },
      ],
    });

    const send = createLastMileSender({ resolver, transport: transport() });
    const result = await send({
      recipientHash,
      body: "hello" as never,
      idempotencyKey: "outbox-409",
    });

    // 409 is NOT in DEFINITIVE_REJECTION_STATUSES, so it stays ambiguous — "may have been
    // accepted, never resend automatically". B-010 does not change that; B-011 is the
    // separate decision about whether 40300 should mean something more.
    expect(result.outcome).toBe("ambiguous");
    expect(result).toMatchObject({ errorCode: "409", providerCode: "40300" });

    const detail = (result as { errorDetail?: string }).errorDetail ?? "";
    expect(detail).toContain("Blocked due to STOP message");
    // Golden Rule #5: this text is bound for a stored column, and it must not become a
    // second raw-phone location in the table operators read while debugging.
    expect(detail).not.toContain("12068645326");
    expect(detail).not.toContain("15163178228");
    expect(detail).not.toMatch(/\d{7}/);
  });

  it("still sends when the provider's error body is not JSON", async () => {
    // A gateway 502 returning HTML is the realistic case. Losing the ability to RECORD a
    // dispatch result because an error body was malformed would be a worse defect than
    // losing the detail, so the transport must degrade rather than throw a parse error.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    );

    const send = createLastMileSender({ resolver, transport: transport() });
    const result = await send({
      recipientHash,
      body: "hello" as never,
      idempotencyKey: "outbox-502",
    });

    expect(result.outcome).toBe("ambiguous");
    expect(result).toMatchObject({ errorCode: "502" });
    expect((result as { providerCode?: string }).providerCode).toBeUndefined();
  });

  it("reports no diagnostics on success", async () => {
    respondWith(200, { data: { id: "msg-1" } });

    const send = createLastMileSender({ resolver, transport: transport() });
    const result = await send({
      recipientHash,
      body: "hello" as never,
      idempotencyKey: "outbox-ok",
    });

    expect(result).toEqual({ outcome: "accepted", providerMessageId: "msg-1" });
  });
});
