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
const RAW_PHONE_RE =
  /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/;

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
