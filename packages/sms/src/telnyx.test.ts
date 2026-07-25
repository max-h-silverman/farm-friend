import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseTelnyxEvent,
  resolveSmsConfig,
  verifyTelnyxSignature,
} from "./telnyx";

type KeyPair = { privateKey: webcrypto.CryptoKey; publicKey: webcrypto.CryptoKey };

// F-014 — ingress verification and fail-closed configuration. Telnyx signs the exact raw
// request bytes with ed25519; verification happens BEFORE parsing, so a forged or
// replayed payload never reaches the inbox.

const keys = await webcrypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
]) as KeyPair;

const publicKey = Buffer.from(
  await webcrypto.subtle.exportKey("raw", keys.publicKey),
).toString("base64");

async function sign(timestamp: string, rawBody: string): Promise<string> {
  const signature = await webcrypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
  );
  return Buffer.from(signature).toString("base64");
}

const now = new Date("2026-07-25T12:00:00Z");
const timestamp = String(Math.floor(now.getTime() / 1000));

describe("Telnyx webhook signature verification", () => {
  const rawBody = JSON.stringify({ data: { event_type: "message.received" } });

  it("accepts a signature over the exact raw bytes", async () => {
    const result = await verifyTelnyxSignature({
      rawBody,
      signature: await sign(timestamp, rawBody),
      timestamp,
      publicKey,
      now,
    });

    expect(result).toEqual({ valid: true });
  });

  it("rejects a body altered after signing", async () => {
    const signature = await sign(timestamp, rawBody);
    const tampered = JSON.stringify({
      data: { event_type: "message.received", injected: true },
    });

    const result = await verifyTelnyxSignature({
      rawBody: tampered,
      signature,
      timestamp,
      publicKey,
      now,
    });

    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects a signature made with a different key", async () => {
    const other = (await webcrypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as KeyPair;
    const foreign = Buffer.from(
      await webcrypto.subtle.sign(
        "Ed25519",
        other.privateKey,
        Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
      ),
    ).toString("base64");

    const result = await verifyTelnyxSignature({
      rawBody,
      signature: foreign,
      timestamp,
      publicKey,
      now,
    });

    expect(result.valid).toBe(false);
  });

  it("rejects a timestamp outside the replay window", async () => {
    const old = String(Math.floor(now.getTime() / 1000) - 4000);

    const result = await verifyTelnyxSignature({
      rawBody,
      signature: await sign(old, rawBody),
      timestamp: old,
      publicKey,
      now,
    });

    expect(result).toEqual({ valid: false, reason: "timestamp_outside_window" });
  });

  it("rejects malformed signatures and timestamps without throwing", async () => {
    for (const bad of ["", "not-base64!!", "AAAA"]) {
      const result = await verifyTelnyxSignature({
        rawBody,
        signature: bad,
        timestamp,
        publicKey,
        now,
      });
      expect(result.valid).toBe(false);
    }

    const badTimestamp = await verifyTelnyxSignature({
      rawBody,
      signature: await sign(timestamp, rawBody),
      timestamp: "not-a-number",
      publicKey,
      now,
    });
    expect(badTimestamp.valid).toBe(false);
  });
});

describe("minimized Telnyx event parsing", () => {
  it("keeps only the permitted inbound projection", () => {
    const parsed = parseTelnyxEvent(
      JSON.stringify({
        data: {
          event_type: "message.received",
          id: "evt-1",
          occurred_at: "2026-07-25T12:00:00Z",
          payload: {
            id: "msg-1",
            from: { phone_number: "+12065550100" },
            to: [{ phone_number: "+12065550999" }],
            text: "potatoes",
            // Provider fields Farm Friend deliberately does not retain.
            cost: { amount: "0.004" },
            media: [{ url: "https://example.test/x.jpg" }],
          },
        },
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      event: {
        providerEventId: "evt-1",
        eventType: "message_received",
        providerMessageId: "msg-1",
        fromPhone: "+12065550100",
        body: "potatoes",
        occurredAt: new Date("2026-07-25T12:00:00Z"),
      },
    });
  });

  it("keeps only the permitted delivery projection", () => {
    const parsed = parseTelnyxEvent(
      JSON.stringify({
        data: {
          event_type: "message.finalized",
          id: "evt-2",
          occurred_at: "2026-07-25T12:05:00Z",
          payload: {
            id: "msg-1",
            to: [{ phone_number: "+12065550100", status: "delivered" }],
          },
        },
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      event: {
        providerEventId: "evt-2",
        eventType: "message_finalized",
        providerMessageId: "msg-1",
        deliveryStatus: "delivered",
        occurredAt: new Date("2026-07-25T12:05:00Z"),
      },
    });
  });

  it("rejects an unsupported or malformed event rather than guessing", () => {
    for (const raw of [
      "{",
      "{}",
      JSON.stringify({ data: { event_type: "call.initiated", id: "e" } }),
      JSON.stringify({ data: { event_type: "message.received", id: "e" } }),
    ]) {
      expect(parseTelnyxEvent(raw).ok).toBe(false);
    }
  });
});

describe("fail-closed SMS configuration", () => {
  it("requires the webhook key and credentials when live Telnyx is selected", () => {
    const result = resolveSmsConfig({
      SMS_PROVIDER: "telnyx",
      TELNYX_API_KEY: "KEY123",
      TELNYX_MESSAGING_PROFILE_ID: "profile-1",
      TELNYX_FROM_NUMBER: "+12065550999",
    });

    // The public verification key is required: without it ingress cannot be verified.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("TELNYX_PUBLIC_KEY");
    }
  });

  it("accepts a complete live configuration", () => {
    const result = resolveSmsConfig({
      SMS_PROVIDER: "telnyx",
      TELNYX_API_KEY: "KEY123",
      TELNYX_MESSAGING_PROFILE_ID: "profile-1",
      TELNYX_FROM_NUMBER: "+12065550999",
      TELNYX_PUBLIC_KEY: publicKey,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.config.provider === "telnyx") {
      expect(result.config.publicKey).toBe(publicKey);
    }
  });

  it("does not let the simulator silently supply live secrets", () => {
    const result = resolveSmsConfig({ SMS_PROVIDER: "simulator" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.provider).toBe("simulator");
      expect(JSON.stringify(result.config)).not.toMatch(/KEY123|profile-1/);
    }
  });

  it("refuses an unknown provider rather than defaulting to one", () => {
    expect(resolveSmsConfig({ SMS_PROVIDER: "carrier-x" }).ok).toBe(false);
    expect(resolveSmsConfig({}).ok).toBe(false);
  });
});
