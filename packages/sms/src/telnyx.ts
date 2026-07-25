import { webcrypto } from "node:crypto";

// Telnyx ingress verification, minimized event parsing, and fail-closed configuration.
//
// Telnyx signs `${timestamp}|${rawBody}` with ed25519. Verification runs against the
// EXACT raw request bytes before any parsing, so a forged or altered payload never
// reaches the inbox. The raw envelope is discarded once the minimized projection commits.

/** How far a webhook timestamp may drift before it is treated as a replay. */
export const REPLAY_WINDOW_SECONDS = 300;

export interface VerifyTelnyxSignatureInput {
  /** The exact raw request body, unparsed and unmodified. */
  rawBody: string;
  signature: string;
  timestamp: string;
  /** Base64 ed25519 public key from the Telnyx portal. */
  publicKey: string;
  now: Date;
}

export type SignatureVerification =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "signature_mismatch"
        | "timestamp_outside_window"
        | "malformed_signature"
        | "malformed_key";
    };

function decodeBase64(value: string): Buffer | null {
  if (value === "") return null;
  const buffer = Buffer.from(value, "base64");
  // Buffer.from silently drops invalid characters, so round-trip to confirm.
  return buffer.toString("base64").replace(/=+$/, "") ===
    value.replace(/=+$/, "")
    ? buffer
    : null;
}

/** Verify a Telnyx webhook signature over the exact raw bytes. Never throws. */
export async function verifyTelnyxSignature(
  input: VerifyTelnyxSignatureInput,
): Promise<SignatureVerification> {
  const seconds = Number(input.timestamp);
  if (!Number.isFinite(seconds)) {
    return { valid: false, reason: "timestamp_outside_window" };
  }
  const driftSeconds = Math.abs(input.now.getTime() / 1000 - seconds);
  if (driftSeconds > REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: "timestamp_outside_window" };
  }

  const signature = decodeBase64(input.signature);
  if (!signature || signature.length !== 64) {
    return { valid: false, reason: "malformed_signature" };
  }
  const keyBytes = decodeBase64(input.publicKey);
  if (!keyBytes || keyBytes.length !== 32) {
    return { valid: false, reason: "malformed_key" };
  }

  try {
    const key = await webcrypto.subtle.importKey(
      "raw",
      keyBytes,
      "Ed25519",
      false,
      ["verify"],
    );
    const verified = await webcrypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      Buffer.from(`${input.timestamp}|${input.rawBody}`, "utf8"),
    );
    return verified ? { valid: true } : { valid: false, reason: "signature_mismatch" };
  } catch {
    return { valid: false, reason: "malformed_key" };
  }
}

/** The minimized inbound projection Farm Friend retains. */
export interface ParsedInboundEvent {
  providerEventId: string;
  eventType: "message_received";
  providerMessageId: string;
  /** Raw E.164 from the provider; normalized and hashed before it is stored. */
  fromPhone: string;
  body: string | null;
  occurredAt: Date;
}

/** The minimized delivery projection Farm Friend retains. */
export interface ParsedDeliveryEvent {
  providerEventId: string;
  eventType: "message_sent" | "message_finalized";
  providerMessageId: string;
  deliveryStatus: "sent" | "delivered" | "delivery_failed";
  occurredAt: Date;
}

export type ParsedTelnyxEvent = ParsedInboundEvent | ParsedDeliveryEvent;

export type TelnyxParseResult =
  | { ok: true; event: ParsedTelnyxEvent }
  | { ok: false; reason: string };

const DELIVERY_EVENT_TYPES: Record<string, "message_sent" | "message_finalized"> = {
  "message.sent": "message_sent",
  "message.finalized": "message_finalized",
};

function deliveryStatusFrom(
  payload: Record<string, unknown>,
): "sent" | "delivered" | "delivery_failed" | null {
  const recipients = payload.to;
  const status = Array.isArray(recipients)
    ? (recipients[0] as Record<string, unknown> | undefined)?.status
    : undefined;

  switch (status) {
    case "sent":
    case "sending":
      return "sent";
    case "delivered":
      return "delivered";
    case "delivery_failed":
    case "failed":
    case "delivery_unconfirmed":
      return "delivery_failed";
    default:
      return null;
  }
}

/**
 * Parse a verified Telnyx webhook into the minimal permitted projection. Unsupported or
 * malformed events are rejected rather than guessed at, and provider fields Farm Friend
 * does not retain (cost, media, carrier metadata) are simply never read.
 */
export function parseTelnyxEvent(rawBody: string): TelnyxParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }

  const data = (parsed as { data?: Record<string, unknown> })?.data;
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "missing_data" };
  }

  const providerEventId = data.id;
  const eventType = data.event_type;
  const occurredAtRaw = data.occurred_at;
  if (typeof providerEventId !== "string" || typeof eventType !== "string") {
    return { ok: false, reason: "missing_event_identity" };
  }
  if (typeof occurredAtRaw !== "string") {
    return { ok: false, reason: "missing_occurred_at" };
  }
  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    return { ok: false, reason: "invalid_occurred_at" };
  }

  const payload = data.payload;
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "missing_payload" };
  }
  const record = payload as Record<string, unknown>;
  const providerMessageId = record.id;
  if (typeof providerMessageId !== "string") {
    return { ok: false, reason: "missing_message_id" };
  }

  if (eventType === "message.received") {
    const from = (record.from as Record<string, unknown> | undefined)?.phone_number;
    if (typeof from !== "string") {
      return { ok: false, reason: "missing_sender" };
    }
    const text = record.text;
    return {
      ok: true,
      event: {
        providerEventId,
        eventType: "message_received",
        providerMessageId,
        fromPhone: from,
        body: typeof text === "string" ? text : null,
        occurredAt,
      },
    };
  }

  const deliveryType = DELIVERY_EVENT_TYPES[eventType];
  if (!deliveryType) {
    return { ok: false, reason: "unsupported_event_type" };
  }
  const deliveryStatus = deliveryStatusFrom(record);
  if (!deliveryStatus) {
    return { ok: false, reason: "missing_delivery_status" };
  }

  return {
    ok: true,
    event: {
      providerEventId,
      eventType: deliveryType,
      providerMessageId,
      deliveryStatus,
      occurredAt,
    },
  };
}

export type SmsConfig =
  | {
      provider: "telnyx";
      apiKey: string;
      messagingProfileId: string;
      fromNumber: string;
      publicKey: string;
    }
  | { provider: "simulator" };

export type SmsConfigResult =
  | { ok: true; config: SmsConfig }
  | { ok: false; missing: string[]; reason: string };

const REQUIRED_TELNYX_VARS = [
  "TELNYX_API_KEY",
  "TELNYX_MESSAGING_PROFILE_ID",
  "TELNYX_FROM_NUMBER",
  "TELNYX_PUBLIC_KEY",
] as const;

/**
 * Resolve SMS configuration, failing closed. Selecting live Telnyx without the webhook
 * public verification key or delivery credentials is a configuration error, not a
 * silently degraded mode — and the simulator never inherits live secrets.
 */
export function resolveSmsConfig(
  env: Record<string, string | undefined>,
): SmsConfigResult {
  const provider = env.SMS_PROVIDER;

  if (provider === "simulator") {
    return { ok: true, config: { provider: "simulator" } };
  }

  if (provider !== "telnyx") {
    return {
      ok: false,
      missing: ["SMS_PROVIDER"],
      reason:
        provider === undefined
          ? "SMS_PROVIDER is required"
          : `unsupported SMS_PROVIDER: ${provider}`,
    };
  }

  const missing = REQUIRED_TELNYX_VARS.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      missing: [...missing],
      reason: "live Telnyx requires delivery credentials and the webhook public key",
    };
  }

  return {
    ok: true,
    config: {
      provider: "telnyx",
      apiKey: env.TELNYX_API_KEY as string,
      messagingProfileId: env.TELNYX_MESSAGING_PROFILE_ID as string,
      fromNumber: env.TELNYX_FROM_NUMBER as string,
      publicKey: env.TELNYX_PUBLIC_KEY as string,
    },
  };
}
