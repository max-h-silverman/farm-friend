import { createHmac } from "node:crypto";

// Phone privacy at the data layer: normalize to E.164-ish, then HMAC-hash for lookup/logging.
// The raw number is NEVER returned by the hash path and NEVER logged. See Golden Rule #5.

export class PhoneNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneNormalizationError";
  }
}

/** Normalize a US/CA phone to `+1XXXXXXXXXX`. Throws on anything that isn't a 10/11-digit number. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  throw new PhoneNormalizationError(`Not a valid US/CA phone: "${raw}"`);
}

/** HMAC-SHA256 of the normalized phone under a salt. Deterministic; one-way; the lookup key. */
export function hashPhone(raw: string, salt: string): string {
  const normalized = normalizePhone(raw);
  return createHmac("sha256", salt).update(normalized).digest("hex");
}

/** What an operator sees where a record has no sender at all. Never a fabricated mask. */
const UNKNOWN_SENDER_MASK = "(unknown sender)";

/**
 * Render the operator-visible form of a phone: the last four digits and nothing else (F-030).
 *
 * Note what this does NOT take: a phone number. The raw E.164 lives in one column read only by
 * the outbound send path, so the admin queries extract `right(phone_e164, 4)` in SQL and the
 * full number is never materialized in application memory. This function only renders the
 * four digits it is handed.
 *
 * It therefore REFUSES anything longer, rather than truncating: a caller that passes a whole
 * number has a bug, and silently masking it would hide the bug at exactly the place where
 * hiding it is most expensive. Failing closed here also means the helper can never become the
 * leak it exists to prevent.
 *
 * The mask is lossy and two numbers may share one. That is correct — it identifies a
 * conversation to a human, never a subscriber.
 */
export function maskPhoneSuffix(lastFour: string | null): string {
  if (lastFour === null) return UNKNOWN_SENDER_MASK;
  if (!/^\d{4}$/.test(lastFour)) {
    throw new PhoneNormalizationError(
      "maskPhoneSuffix takes exactly the last four digits, never a full number",
    );
  }
  return `(•••) •••-${lastFour}`;
}
