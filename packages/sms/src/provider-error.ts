import { maskRawPhones } from "./redaction";

// B-010 — preserve what the provider actually said, safely.
//
// Dispatch stored only the HTTP status. A status names a category, never a cause, and the
// gap cost hours twice on 2026-07-27: `error_code = '400'` was really "The source phone
// number was deemed invalid by the carrier" (a malformed `TELNYX_FROM_NUMBER`), and
// `error_code = '409'` was really code 40300, "Blocked due to STOP message" — the carrier
// block rule B-011 is about. Both sentences were recovered by curling Telnyx by hand.
//
// Two values come out of a failed response, and they are deliberately separate:
//
//   - `providerCode` — the provider's stable machine-readable code (40300). RULES may key on
//     this. It is not free text and is validated as such.
//   - `detail` — the human sentence. Diagnostic only; nothing branches on it.
//
// PRIVACY. The provider's message is untrusted third-party text and the real 40300 body
// contains both E.164 numbers. Golden Rule #5 keeps the raw E.164 in exactly one column read
// only by the send path, so storing this verbatim would create a second raw-phone location in
// the very table an operator reads while debugging. Phones are masked here, using the SAME
// detector the outbound guard owns — one mechanism, two consumers, rather than a near-duplicate.

/** How much provider text is worth keeping. Beyond this it is noise, and an unbounded
 *  third-party string is an unbounded write into our database. */
const MAX_DETAIL_LENGTH = 500;

/** A provider code is a short machine token. Anything else is treated as absent, so free
 *  text can never arrive somewhere a rule might key on it. */
const PROVIDER_CODE_RE = /^[A-Za-z0-9_.-]{1,32}$/;

export interface ProviderErrorSummary {
  /** The provider's own error code, when it supplied a well-formed one. */
  providerCode?: string;
  /** The provider's explanation, phone-masked and length-bounded. */
  detail?: string;
}

function firstError(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first = errors[0];
  return typeof first === "object" && first !== null
    ? (first as Record<string, unknown>)
    : undefined;
}

/**
 * Reduce a failed provider response to the two values worth storing.
 *
 * **Never throws.** This runs inside the dispatch path, where losing the ability to send
 * because an error body was malformed would be a far worse defect than losing the detail —
 * a gateway returning HTML instead of JSON is the realistic case. Every unparseable shape
 * degrades to an empty summary and the HTTP status still stands on its own.
 */
export function summarizeProviderError(input: {
  status: number;
  body: unknown;
}): ProviderErrorSummary {
  const error = firstError(input.body);
  if (!error) return {};

  const rawCode = error.code;
  const providerCode =
    typeof rawCode === "string" && PROVIDER_CODE_RE.test(rawCode) ? rawCode : undefined;

  // Title and detail are both useful and often complementary — the title names the class
  // ("Blocked due to STOP message") while the detail explains the instance.
  const parts = [error.title, error.detail].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  if (parts.length === 0) return providerCode ? { providerCode } : {};

  // Mask BEFORE truncating: truncation must never be what removes a phone, or a message
  // whose number sits past the cutoff would be stored raw.
  const masked = maskRawPhones(parts.join(" — "));
  const detail =
    masked.length > MAX_DETAIL_LENGTH ? `${masked.slice(0, MAX_DETAIL_LENGTH - 1)}…` : masked;

  return { ...(providerCode ? { providerCode } : {}), detail };
}
