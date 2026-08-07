// What Farm Friend says to a farmer during onboarding (F-040).
//
// **These are ORDINARY code-rendered copy, not registered carrier auto-responses.** The three
// bodies in `auto-responses.ts` are transcribed character-for-character from live Telnyx
// console state and pinned by a test in both directions; these are not, may be edited for
// clarity without touching the carrier registration, and must never be transcribed into that
// block. `onboarding-copy.test.ts` asserts they stay out of it.
//
// Each carries the STOP reminder. Not because a rule demands it on every message, but because
// these three are the messages a farmer receives while deciding whether Farm Friend is worth
// having — the opt-out must be in front of them, not one screen back.

/**
 * Sent when a farmer texts asking to be set up.
 *
 * **It must not read as a yes.** A request grants nothing — VIGA always approves — so the
 * copy says the ask was received and a person will act on it, and claims no outcome. A
 * farmer told "you're set up" who then cannot publish has been lied to by the system, and
 * a farmer who tries once and fails does not try again.
 */
export const FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT =
  "VIGA Farm Friend: Thanks - VIGA has your request. They will review it and text you " +
  "when your farm is ready to update. Reply STOP to opt out, HELP for help.";

/**
 * Sent alongside the acknowledgement when a SIGNUP leaves the farmer with no consent basis.
 *
 * **The dead end this closes.** SIGNUP by itself establishes nothing, so
 * `FARMER_AUTHORIZED_NOTIFICATION` — a proactive category — is suppressed at the dispatch
 * claim, and the farmer is authorized in silence with no reason to think the system works.
 * Web onboarding fixes the invited path by collecting an agreement first; this covers the
 * case where that agreement is not available to rest on: **an invitation whose box was never
 * ticked**, redeemed by text anyway.
 *
 * It used to cover a second case, a bare uninvited `SIGNUP`. F-080 removed that keyword
 * entirely, so redemption now requires a token — but this case did NOT collapse with it, as
 * was first assumed. `openFarmerOnboardingRequest` writes no consent when `agreed_to_sms_at`
 * is null, which an un-ticked invitation reaches with a token in hand.
 *
 * It names `JOIN` and not `START`, because the sender it reaches has no consent record at
 * all — `JOIN` is the first-time keyword, and `START` is for returning after an opt-out
 * (B-011). Naming both would ask a farmer to choose between two words for one act.
 *
 * A farmer who ALREADY has a record is deliberately sent nothing here: they need no
 * instruction, and telling them to JOIN would be false since JOIN no longer restores.
 */
export const FARMER_JOIN_INSTRUCTION =
  "VIGA Farm Friend: To get texts about your farm, reply JOIN. " +
  "Msg freq may vary. Msg & data rates may apply. Reply STOP to opt out.";

/**
 * Sent when VIGA authorizes a farmer. max's decision, and the reason is plain: a farmer
 * approved on Tuesday otherwise has no idea until they guess.
 *
 * It tells them what to DO, because an announcement with no instruction leaves the farmer
 * exactly where they were. "Text what you have" is the whole interface.
 *
 * **This is a proactive category, so it is subject to consent like every other one.**
 * Approval is not consent: a farmer who never texted JOIN/START has no consent basis, and
 * `authorizeDispatch` suppresses this message rather than sending it. That is correct — it
 * is a decision made by VIGA, not a message the farmer asked for.
 */
export const FARMER_AUTHORIZED_NOTIFICATION =
  "VIGA Farm Friend: Your farm is ready. Text today's availability, or text LINK for " +
  "your private web form. Preview it before it goes live. " +
  "Reply STOP to opt out.";

/**
 * Sent after a first-time JOIN or a START that successfully restores messaging.
 *
 * The carrier-required opt-in receipt is deliberately separate in `auto-responses.ts`; it
 * cannot carry product guidance without a carrier-console change. This ordinary reply makes
 * the next useful action plain without creating a customer account, asking for private
 * details, or promising future alerts.
 */
export const CUSTOMER_SMS_WELCOME =
  "Welcome to VIGA Farm Friend. Ask what is available, like eggs or kale. Text MAP for the " +
  "map, HELP for help, or STOP to opt out.";

/**
 * The message carrying a farmer's standing link.
 *
 * **Says nothing about expiry, because there is none.** max chose a link that works until it
 * is revoked, so a promise of a window would be false — and would teach farmers to
 * re-request links they do not need. What it does say is that the link is theirs, which is
 * the honest warning for a credential with no password behind it.
 */
export function renderFarmerLinkMessage(link: string): string {
  return (
    `VIGA Farm Friend: here is your private link for updating your stand - keep it to ` +
    `yourself. ${link} Reply STOP to opt out.`
  );
}
