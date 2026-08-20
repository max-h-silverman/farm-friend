/**
 * What HELP actually answers with, beside the carrier's registered reply (B-091).
 *
 * ## Why this is a second message rather than a better first one
 *
 * The registered help auto-response says "For help, reply HELP" — it answers a request for
 * help by naming the word the sender just texted. It cannot be fixed where it lives:
 * `auto-responses.ts` is transcribed from live Telnyx console state and pinned
 * character-for-character, because a code-side paraphrase would make live traffic differ from
 * the copy the carrier approved. Improving it there means a console edit first.
 *
 * So the compliance obligation and the useful answer are two different messages with two
 * different owners. The registered one keeps carrying the rate and opt-out language the
 * carrier requires; this one carries the keywords and a route to a human, which is what a
 * sender texting HELP is actually asking for.
 *
 * ## Why the audience is a parameter
 *
 * A customer and a farmer have different interfaces — a customer has MAP and free-text
 * inquiry, a farmer has LINK and STAND — and a list of words that do nothing for the reader
 * is worse than a shorter list. The caller knows which one it is talking to; this does not
 * guess.
 *
 * Keywords named here are deliberately the TAUGHT ones. `SETTINGS` stays untaught for the
 * reason recorded on `FARMER_UNTAUGHT_KEYWORDS`, and this must not become the copy that
 * quietly re-teaches it.
 */

/**
 * Where a customer's question goes when Farm Friend cannot answer it.
 *
 * Its own constant rather than a literal, because the customer and farmer routes are one
 * address today and VIGA may split them later (max, 2026-08-19). When that happens the
 * change is a value here — not a hunt through copy working out which mention of `board@`
 * meant which reader.
 *
 * `farmfriend@` rather than `board@` (max, 2026-08-19): the address a member of the public is
 * given is the product's own, not VIGA's board mailbox. The administrator login identity is a
 * separate fact and deliberately stays `board@`.
 */
export const VIGA_CUSTOMER_CONTACT = "farmfriend@vigavashon.org";

/** Where a farmer's question goes. One address with the above today; see that constant. */
export const VIGA_FARMER_CONTACT = "farmfriend@vigavashon.org";

export type HelpAudience = "customer" | "farmer";

/**
 * Two segments at most, which is a real constraint and not a style note: HELP is answered
 * for anyone who texts it, including senders with no consent and senders who have opted out,
 * so its cost is unbounded by our own sending decisions.
 *
 * FLAG is named to BOTH audiences. It is the one word that reaches a person, and a farmer
 * who finds something wrong is as likely to text it as a customer.
 */
export function renderHelpGuide(audience: HelpAudience): string {
  if (audience === "farmer") {
    return [
      "VIGA Farm Friend. What you can text:",
      "LINK for your update page. STAND to switch stands.",
      "FLAG to report a problem. STOP to opt out.",
      `Questions: ${VIGA_FARMER_CONTACT}`,
    ].join("\n");
  }

  return [
    "VIGA Farm Friend. What you can text:",
    "Ask what is available, like eggs or kale. MAP for the map.",
    "FLAG to report a problem. STOP to opt out.",
    `Questions: ${VIGA_CUSTOMER_CONTACT}`,
  ].join("\n");
}
