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
