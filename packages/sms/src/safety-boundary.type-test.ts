// Compile-guard proof for SMS sends (Golden Rule #6, layer 1). Type-checked, never run.
// Asserts that a send BYPASSING the redaction guard is a COMPILE ERROR.

import { redactOutbound, SmsSimulator, type OutboundMessage, type RedactedOutbound } from "./index";

const sim = new SmsSimulator();

// OK: a body produced by the redaction guard is a RedactedOutbound and is accepted.
const safe: RedactedOutbound = redactOutbound("Reply YES to publish.");
const okMsg: OutboundMessage = { toPhoneHash: "abc", body: safe };
void sim.send(okMsg);

// BYPASS 1 — a raw string body must not type-check as a RedactedOutbound.
// @ts-expect-error un-redacted raw string cannot be sent (compile guard)
const badMsg: OutboundMessage = { toPhoneHash: "abc", body: "call (206) 555-1234" };
void badMsg;

// BYPASS 2 — you cannot hand-forge the brand.
// @ts-expect-error the branded type is not constructible outside the redaction guard
const forged: RedactedOutbound = "anything";
void forged;
