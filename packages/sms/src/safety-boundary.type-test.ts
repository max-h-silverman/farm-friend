// Compile-guard proof for SMS sends (Golden Rule #6, layer 1). Type-checked, never run.
// Asserts that a send BYPASSING the redaction guard is a COMPILE ERROR.
//
// GL-035: this is anchored to `LastMileSendInput` — the type the PRODUCTION send path
// actually takes (`createLastMileSender`, wired to the Telnyx transport in the web
// composition root). It previously guarded `OutboundMessage`/`SmsTransport`, a parallel
// delivery path nothing in production used, so the compile guard proved a property of code
// that never ran. A safety proof anchored to a dead path is not a safety proof.

import { redactOutbound, type LastMileSendInput, type RedactedOutbound } from "./index";

// OK: a body produced by the redaction guard is a RedactedOutbound and is accepted.
const safe: RedactedOutbound = redactOutbound("Reply YES to publish.");
const okSend: LastMileSendInput = {
  recipientHash: "abc",
  body: safe,
  idempotencyKey: "outbox-1",
};
void okSend;

// BYPASS 1 — a raw string body must not type-check as a RedactedOutbound.
const badSend: LastMileSendInput = {
  recipientHash: "abc",
  // @ts-expect-error un-redacted raw string cannot be sent (compile guard)
  body: "call (206) 555-1234",
  idempotencyKey: "outbox-2",
};
void badSend;

// BYPASS 2 — you cannot hand-forge the brand.
// @ts-expect-error the branded type is not constructible outside the redaction guard
const forged: RedactedOutbound = "anything";
void forged;
