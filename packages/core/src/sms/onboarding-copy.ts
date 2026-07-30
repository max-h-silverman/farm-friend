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
  "VIGA Farm Friend: Thanks - we passed your request to a VIGA coordinator, who will " +
  "set up your farm. Reply STOP to opt out, HELP for help.";

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
  "VIGA Farm Friend: You're all set - text us what your stand has today and we'll " +
  "confirm before it goes live. Reply STOP to opt out.";

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
