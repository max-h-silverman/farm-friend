// Outbound guard — the static provenance barrier plus runtime enforcement for SMS sends.
// See docs/AI_ARCHITECTURE.md §"The code-enforced safety boundary and its verification."
//
// STATIC PROVENANCE: `RedactedOutbound` is a branded type whose ONLY public constructor is
// `redactOutbound`. `SmsTransport.send` accepts only a `RedactedOutbound`, so you cannot send
// an SMS without going through the guard — there is no value of the right type to pass
// otherwise. This proves PROVENANCE (it came from the guard), NOT content.
//
// RUNTIME ENFORCEMENT: `redactOutbound` normalizes avoidable typographic Unicode so every
// sendable body gets cost-safe segmentation, and refuses the NAMED RAW-PHONE CLASS below even
// if a model produced it.
//
// WHAT THIS DOES NOT CLAIM: this is not a general detector for private values. It does not
// find emails, street addresses, secrets, account numbers, or an obfuscated phone ("two oh
// six..."), and it cannot tell whether a legitimately-rendered fact should have been sent to
// this recipient. Those properties come from elsewhere in the boundary: cross-actor messages
// are code-rendered from permitted typed facts, and model-authored prose returns only to the
// actor whose own task text produced it. This guard is the last narrow net, not the design.

import { normalizeAvoidableSmsUnicode } from "./segments";

declare const redactedBrand: unique symbol;

/** A message body that has passed the outbound guard. Only constructible via
 *  `redactOutbound`. The brand proves provenance; the scan covers the named raw-phone class. */
export type RedactedOutbound = string & { readonly [redactedBrand]: true };

export class OutboundRedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRedactionError";
  }
}

// Matches North-American style raw phone numbers a leak would surface. Deliberately broad:
// this is a refuse-to-send guard, not a formatter. Covers +1 (206) 555-1234, 2065551234,
// 206-555-1234, 206.555.1234, etc.
//
// B-001: the digits must stand on their own. Without the boundaries below, any ten-digit run
// matched — including the hex digits inside a UUID, which happens for ~3% of random UUIDs.
// That made the guard randomly refuse legitimate outbound text carrying an identifier. A
// phone is not preceded or followed by another digit or by identifier characters (hex letters,
// underscore) that mark the run as part of a longer token.
const PHONE_BODY = String.raw`(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}`;
const RAW_PHONE_PATTERN = String.raw`(?<![0-9A-Za-z_])${PHONE_BODY}(?![0-9A-Za-z_])`;
const RAW_PHONE_RE = new RegExp(RAW_PHONE_PATTERN);

/**
 * The outbound guard. Normalizes avoidable typographic Unicode, then refuses the named
 * raw-phone class; otherwise stamps the normalized body with the brand. This is the ONLY way
 * to produce a `RedactedOutbound`, so `SmsTransport.send` cannot be reached with an
 * unprocessed string. It is not a general private-value detector — see the file header.
 */
export function redactOutbound(body: string): RedactedOutbound {
  const normalizedBody = normalizeAvoidableSmsUnicode(body);
  if (RAW_PHONE_RE.test(normalizedBody)) {
    throw new OutboundRedactionError(
      "Refusing to send: outbound message contains a raw phone number.",
    );
  }
  return normalizedBody as RedactedOutbound;
}

/** Non-throwing probe for tests / callers that want to branch rather than catch. */
export function containsRawPhone(body: string): boolean {
  return RAW_PHONE_RE.test(body);
}

/**
 * Replace every raw phone in a string with `[redacted]` (B-010).
 *
 * The outbound guard REFUSES a body carrying a phone, which is right for text Farm Friend is
 * about to send: it is our own message and a phone in it is a defect to surface loudly.
 * Inbound third-party text we merely want to *store* is the opposite case — a provider's
 * error explanation legitimately names the numbers it could not deliver between, and
 * refusing it would throw away the diagnostic entirely. So this masks rather than throws.
 *
 * Same detector, two dispositions. Deliberately not a second phone regex: `PHONE_BODY` and
 * its boundary rules — including the B-001 fix that stopped UUID hex from matching — are
 * stated once and both consumers inherit every future correction to them.
 *
 * This is NOT a general private-value detector; the file header's limits all apply.
 */
export function maskRawPhones(text: string): string {
  return text.replace(new RegExp(RAW_PHONE_PATTERN, "g"), "[redacted]");
}
