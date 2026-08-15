import { createHmac } from "node:crypto";

// Email privacy at the data layer (F-078) — the same shape as `phone.ts`, deliberately.
//
// VIGA's roster is largely PERSONAL addresses (`dhusch@hotmail.com`), so an email carries the
// same weight as a phone under Golden Rule #5: the raw value lives in exactly one column read
// only by the send path, and the HASH is the only lookup and log key.
//
// This is a second instance of one existing mechanism, not a second mechanism. Where the two
// differ, it is because the data differs: a phone has one canonical form derived by discarding
// punctuation, while an address is canonicalized by case and whitespace only. Everything
// structural — normalize at ingress, HMAC for lookup, refuse rather than guess, mask for
// operators — is the same discipline.

export class EmailNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailNormalizationError";
  }
}

/** What an operator sees where a farm has no address on file. Never a fabricated mask. */
const NO_EMAIL_MASK = "(no email on file)";

/**
 * A minimal address shape: something, an `@`, a dotted domain, no whitespace.
 *
 * Deliberately NOT an RFC 5322 validator, and the same rule `seed/farm-emails.ts` applies —
 * a stricter pattern rejects real addresses, a looser one stores prose nobody can verify
 * against. Because it forbids whitespace and requires exactly one `@`, it also rejects two
 * addresses run together, which is the failure this must not wave through.
 */
const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Canonicalize an address to the one spelling everything else uses. Throws on anything that
 * is not a single address.
 *
 * **The whitespace class is named explicitly** to match `seller_emails_one_per_farm_address`,
 * which indexes `lower(btrim(email, E' \t\r\n'))`. `btrim(text)` with no second argument
 * strips SPACES ONLY — migration 0020 shipped that naive form and a tab-only value passed its
 * not-blank CHECK. If this function and that index disagreed, the ingest would insert a value
 * the index collapses onto another one and the error would name a constraint instead of the
 * data.
 *
 * **Lowercasing the local part is not a claim about email semantics.** Addresses are
 * technically case-sensitive before the `@`; no provider VIGA's farmers use treats them that
 * way, and one spelling per address is what makes verification work at all.
 */
export function normalizeEmail(raw: string): string {
  const normalized = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase();
  if (!ADDRESS.test(normalized)) {
    // The raw value is NOT interpolated into this message. An address is personal data and an
    // error string reaches logs, which is exactly where a raw address must never appear.
    throw new EmailNormalizationError("Not a single valid email address");
  }
  return normalized;
}

/**
 * HMAC-SHA256 of the normalized address under a salt. Deterministic; one-way; the lookup key.
 *
 * Hashes the NORMALIZED form, so `Cathy@Example.com` and `cathy@example.com` are one farmer
 * rather than two — a farmer typing their address with different capitalization than VIGA
 * recorded must still verify.
 */
export function hashEmail(raw: string, salt: string): string {
  return createHmac("sha256", salt).update(normalizeEmail(raw)).digest("hex");
}

/**
 * Render the operator-visible form of an address (Golden Rule #5: masked in admin).
 *
 * Shows the first character and the whole domain. The domain is what makes two farmers
 * distinguishable to a human — several island sellers use the same provider, and a mask hiding
 * it would identify nobody.
 *
 * **The mask is a FIXED three dots regardless of the local part's length.** A mask that
 * tracked the length would leak it, and for a short local part that is most of the address.
 *
 * It refuses a malformed value rather than masking it, for the same reason
 * `maskPhoneSuffix` refuses a full number: a caller passing something else has a bug, and
 * silently masking it hides the bug exactly where hiding it is most expensive.
 */
export function maskEmail(address: string | null): string {
  if (address === null) return NO_EMAIL_MASK;
  const normalized = normalizeEmail(address);
  const atIndex = normalized.indexOf("@");
  return `${normalized.slice(0, 1)}•••${normalized.slice(atIndex)}`;
}
