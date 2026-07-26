// The registered 10DLC auto-response copy (F-023).
//
// These three bodies are REGISTERED WITH THE CARRIER. They are transcribed character for
// character from the AUTO-RESPONSES block of docs/TELNYX_10DLC_FIELD_VALUES.txt, which is a
// transcript of live Telnyx console state — not a draft. `auto-responses.test.ts` reads that
// file and fails if code and registration disagree in EITHER direction, exactly as
// commands.test.ts does for the keyword lists.
//
// So this is not copy to edit for tone. Changing what a recipient reads means changing the
// console first, then transcribing the result here. A code-side paraphrase would make live
// traffic differ from what the carrier approved.
//
// Every one of these is sent as the `required_reply` category: each answers the recipient's
// own inbound keyword, and the opt-out confirmation in particular must survive the STOP that
// provoked it (see `isProactiveSendPermitted`).

/** Sent when a registered opt-in keyword (JOIN/START) establishes or restores consent. */
export const REGISTERED_OPT_IN_AUTO_RESPONSE =
  "You have agreed to receive SMS updates from VIGA Farm Friend. Msg freq may vary. " +
  "Std msg & data rates apply. Reply STOP to opt out, HELP for help.";

/** Sent to confirm a registered opt-out keyword. Carrier-required, never suppressed. */
export const REGISTERED_OPT_OUT_AUTO_RESPONSE =
  "VIGA Farm Friend: You have been unsubscribed and will no longer receive messages " +
  "from us. Reply HELP for assistance.";

/** Sent in answer to a registered help keyword (HELP/INFO). */
export const REGISTERED_HELP_AUTO_RESPONSE =
  "VIGA Farm Friend: For help, reply HELP or contact us at board@vigavashon.org. " +
  "Msg frequency varies. Msg&data rates may apply. Reply STOP to opt out.";
