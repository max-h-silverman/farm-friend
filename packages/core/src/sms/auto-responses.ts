// The Telnyx 10DLC auto-response copy (F-023).
//
// Telnyx sends the VIGA onboarding receipt below. The opt-out and help bodies are also
// registered with the carrier. They are transcribed character for character from the
// AUTO-RESPONSES block of docs/TELNYX_10DLC_FIELD_VALUES.txt, a transcript of live Telnyx
// console state — not a draft. `auto-responses.test.ts` fails if code and registration drift.
//
// So this is not copy to edit for tone. Changing what a recipient reads means changing the
// console first, then transcribing the result here. A code-side paraphrase would make live
// traffic differ from what the carrier approved.
//
// Farm Friend sends JOIN, opt-out, and help replies as `required_reply`. Telnyx, rather than
// Farm Friend, sends the VIGA onboarding receipt, so the successful onboarding reply can carry
// only the distinct listing-live milestone.

/** Sent by Farm Friend when JOIN establishes first-time community consent. */
export const JOIN_OPT_IN_AUTO_RESPONSE =
  "You have agreed to receive SMS updates from VIGA Farm Friend. Msg freq may vary. " +
  "Std msg & data rates apply. Reply STOP to opt out, HELP for help.";

/** Telnyx sends this after the VIGA farmer-onboarding opt-in keyword. */
export const TELNYX_FARMER_ONBOARDING_OPT_IN_AUTO_RESPONSE =
  "VIGA Farm Friend: Your phone is confirmed for farm-stand updates. Msg frequency varies. " +
  "Msg&data rates may apply. Reply HELP for help, STOP to opt out.";

/** Sent to confirm a registered opt-out keyword. Carrier-required, never suppressed. */
export const REGISTERED_OPT_OUT_AUTO_RESPONSE =
  "VIGA Farm Friend: You have been unsubscribed and will no longer receive messages " +
  "from us. Reply HELP for assistance.";

/** Sent in answer to a registered help keyword (HELP/INFO). */
export const REGISTERED_HELP_AUTO_RESPONSE =
  "VIGA Farm Friend: For help, reply HELP or contact us at board@vigavashon.org. " +
  "Msg frequency varies. Msg&data rates may apply. Reply STOP to opt out.";

/**
 * Answer to a `JOIN` from a sender who already has a consent record (B-011).
 *
 * Not one of the carrier-registered auto-responses above and deliberately kept apart from
 * them: those are transcribed from live Telnyx console state and a recipient reads them
 * verbatim, so `auto-responses.test.ts` pins them character-for-character. This one is
 * ordinary code-rendered reply copy — it may be edited for clarity without touching the
 * carrier registration, and it must never be transcribed INTO that registered block.
 *
 * Why it exists: `JOIN` no longer restores consent once a record exists, because only
 * `START` clears the carrier's own opt-out list. Without this the farmer would text JOIN,
 * get nothing, and have no way to learn the word that actually works.
 *
 * The honest limitation, worth stating where the copy lives: **if the carrier block is
 * active, this reply is itself blocked** (409 / 40300) and the farmer never sees it. It is
 * still correct to send — the block may not be active, it costs nothing when it is, and
 * B-010 now records the refusal with its reason. The durable fix is farmer-facing
 * onboarding material that says START, not JOIN, for returning after an opt-out.
 */
export const ALREADY_JOINED_RESPONSE =
  "VIGA Farm Friend: You have already joined. Reply START to restart messaging. " +
  "Reply STOP to opt out, HELP for help.";
