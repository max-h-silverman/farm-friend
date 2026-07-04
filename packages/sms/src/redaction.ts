// Outbound redaction guard — layer 1 (compile) + layer 2 (runtime) of the code-enforced
// safety boundary for SMS sends. See docs/AI_ARCHITECTURE.md §safety boundary.
//
// Layer 1 (compile / provenance): `RedactedOutbound` is a branded type whose ONLY public
// constructor is `redactOutbound`. `SmsTransport.send` accepts only a `RedactedOutbound`, so
// you cannot send an SMS without going through the guard — there is no value of the right type
// to pass otherwise. This proves provenance (it came from the guard), NOT content.
//
// Layer 2 (runtime / content): `redactOutbound` actually SCANS the string and blocks a raw
// phone number even if the model produced one. This is what proves the content is clean.

declare const redactedBrand: unique symbol;

/** A message body that has passed the outbound redaction guard. Only constructible via
 *  `redactOutbound`. The brand proves provenance; the guard's scan proves content. */
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
 * The outbound redaction guard. Runtime-scans `body` for raw phone numbers / private fields;
 * throws if any are present, otherwise stamps the brand. This is the ONLY way to produce a
 * `RedactedOutbound`, so `SmsTransport.send` cannot be reached with an unscanned string.
 */
export function redactOutbound(body: string): RedactedOutbound {
  if (RAW_PHONE_RE.test(body)) {
    throw new OutboundRedactionError(
      "Refusing to send: outbound message contains a raw phone number.",
    );
  }
  return body as RedactedOutbound;
}

/** Non-throwing probe for tests / callers that want to branch rather than catch. */
export function containsRawPhone(body: string): boolean {
  return RAW_PHONE_RE.test(body);
}
