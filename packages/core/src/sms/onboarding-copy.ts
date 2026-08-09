// What Farm Friend says to a farmer during onboarding (F-040).
//
// **These are ORDINARY code-rendered copy, not registered carrier auto-responses.** The three
// bodies in `auto-responses.ts` are transcribed character-for-character from live Telnyx
// console state and pinned by a test in both directions; these are not, may be edited for
// clarity without touching the carrier registration, and must never be transcribed into that
// block. `onboarding-copy.test.ts` asserts they stay out of it.
//
// **Which of these carry a STOP reminder, and why it is not all of them** (F-096).
//
// No rule requires opt-out language on every message. The requirements are the opt-in
// confirmation, the HELP response, and that STOP always works from any state — the first two
// are registered copy in `auto-responses.ts`, the third is enforced in `consent.ts` and cannot
// be reached around. `docs/SMS_COMPLIANCE.md` states the obligation as "honor opt-out
// immediately and durably", never "advertise it every time".
//
// So the footer is kept where a recipient is DECIDING about Farm Friend — the onboarding
// acknowledgement, the join instruction, the customer welcome — where the exit must be in
// front of them rather than one screen back. It is dropped from messages that answer something
// the farmer just sent, and from the setup message, where it competed for a segment budget
// against a real link and three keywords the farmer had no other way to learn.
//
// The recurring proactive stream — the F-081 scheduled prompt — carries its own reminder. That
// is the one place a periodic footer is genuinely earned, and it lives with that renderer.

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
 * **It names `START`, and that changed** (max 2026-08-07). It said `JOIN`, on the reasoning that
 * the sender it reaches has no consent record and `JOIN` is the first-time keyword. That is no
 * longer the whole story: onboarding is completed by matching a bare `START` against the phone
 * the farmer stated on the form, and `JOIN` completes nothing. Telling a farmer to reply `JOIN`
 * would enroll them for messages and still leave them unset-up, with nothing saying why.
 *
 * `START` is also the only word that clears the carrier's own opt-out list (B-011), so it is the
 * right instruction whether or not this handset has a history we cannot see.
 *
 * A farmer who ALREADY has a record is deliberately sent nothing here: they need no instruction.
 */
export const FARMER_JOIN_INSTRUCTION =
  "VIGA Farm Friend: To get texts about your farm, reply START. " +
  "Msg freq may vary. Msg & data rates may apply. Reply STOP to opt out.";

/**
 * The farmer keywords this system is the only channel for (F-093).
 *
 * Stated ONCE, here, and asserted against `FarmerKeyword` in `commands.ts` by test — a keyword
 * cannot be added to the parser without being taught, which is exactly the gap F-093 closed.
 *
 * **`MORE`, `YES`/`NO` and `SAME` are deliberately absent.** Each is a reply to a message Farm
 * Friend sent, and the message that needs one teaches it in context. Listing them here would
 * make a farmer memorize four words for a conversation that hands them over one at a time.
 */
export const FARMER_TAUGHT_KEYWORDS = ["LINK", "STAND", "SETTINGS"] as const;

/**
 * Sent when VIGA authorizes a farmer. max's decision, and the reason is plain: a farmer
 * approved on Tuesday otherwise has no idea until they guess.
 *
 * It tells them what to DO, because an announcement with no instruction leaves the farmer
 * exactly where they were. "Text what you have" is the whole interface.
 *
 * **It carries the link rather than only naming the word that fetches it** (F-094). It used to
 * say "text LINK for your private web form" and send nothing, so a farmer told they were live
 * had to send a SECOND text before they could see anything — and some fraction never did. It
 * still names `LINK`, because a farmer will lose or delete this text and the recovery word has
 * to be discoverable (max 2026-08-08). Deliver AND teach; not either.
 *
 * That is why this is a FUNCTION and not the constant it used to be: a real link means minting
 * one at authorization for every farmer, including farmers who never open it. max chose that
 * over a link-free message — an unopened token costs nothing and dies with its authorization.
 *
 * **No STOP footer** (F-096). Nothing requires opt-out language on every message; the
 * requirement is the opt-in confirmation, the HELP response, and that STOP always works. The
 * farmer has a segment budget to spend on a link and three keywords, and they read the footer
 * on the carrier receipt that arrives beside this.
 *
 * **This is a proactive category, so it is subject to consent like every other one.**
 * Approval is not consent: a farmer who never texted JOIN/START has no consent basis, and
 * `authorizeDispatch` suppresses this message rather than sending it. That is correct — it
 * is a decision made by VIGA, not a message the farmer asked for.
 */
export function renderFarmerAuthorizedNotification(link: string | null): string {
  return [
    // "You're all set" rather than "on the map": the no-stand branch below reaches a farmer
    // whose farm has no stand yet, and telling them they are on the map would be false for
    // exactly the farmer least able to check.
    "VIGA Farm Friend: you're all set.",
    "Just text us what you have out today - that is all it takes.",
    // A farmer with no stand yet cannot be issued a link: `issueFarmerLinkIn` needs a
    // `sales_locations` row, and the ADMIN authorization path can run before one exists (the
    // invited path always has one — the farmer published the listing on the form). Naming the
    // word is the honest fallback; inventing a URL that resolves to nothing would be worse
    // than asking for one more text.
    ...(link === null
      ? ["Text LINK when you need to update your listing."]
      : [
          "To change your listing, open your own page here:",
          link,
          "Lost it? Text LINK for a new one.",
        ]),
    // STAND is named even though most farmers have one stand, because the tripwire in
    // `farmer-keywords.test.ts` requires every keyword the parser honours to be taught — and a
    // farmer who DOES have two has no other way to learn the word that picks between them.
    "Text SETTINGS to change how often we text you, or STAND if you have more than one stand.",
  ].join("\n");
}

/**
 * Sent after a first-time JOIN or a START that successfully restores messaging.
 *
 * The carrier-required opt-in receipt is deliberately separate in `auto-responses.ts`; it
 * cannot carry product guidance without a carrier-console change. This ordinary reply makes
 * the next useful action plain without creating a customer account, asking for private
 * details, or promising future alerts.
 *
 * **The contact card left this message** (max 2026-08-08) and is now `renderContactCardOffer`,
 * sent as its own text. It was a trailing "Save us:" plus a raw API path, after the opt-out
 * instruction, and it read as plumbing rather than an offer — see that function for the rest.
 *
 * With the URL gone this no longer depends on configuration, so it is a CONSTANT again rather
 * than a function taking a base URL it would ignore. One GSM-7 segment, which is what it was
 * originally sized for: it rides beside the opt-in receipt, and a second segment here doubles
 * the cost of every JOIN.
 */
export const CUSTOMER_WELCOME = [
  "Welcome to VIGA Farm Friend. Ask what is available, like eggs or kale.",
  "Text MAP for the map, HELP for help, or STOP to opt out.",
].join("\n");

/**
 * The contact-card offer, as its own message (max 2026-08-08).
 *
 * **Why it is not a line on the welcome.** It was a trailing fragment — "Save us:" followed by
 * a raw `/api/public/contact-card` URL, jammed after the opt-out instruction — and it read as
 * machine plumbing rather than as an offer. What it actually does needs a sentence, and a
 * sentence plus a URL competing with four other instructions in one message is how the whole
 * thing gets skipped.
 *
 * Sent to farmers as well as customers, and that is the point: the number stays unnamed in the
 * handset otherwise, so every later message — a scheduled prompt, a stock-out alert — arrives
 * from a stranger.
 *
 * Saving a contact is device-local and records nothing: no consent transition, no `contacts`
 * row, no send permission. Offering it asks for nothing, which is why it needs no footer.
 */
export function renderContactCardOffer(publicBaseUrl: string): string {
  return [
    "Save VIGA Farm Friend in your contacts:",
    contactCardUrl(publicBaseUrl),
  ].join("\n");
}

/** The served contact card's address (F-039), built from the same base every reply uses. */
export function contactCardUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/api/public/contact-card`;
}

/**
 * The message carrying a farmer's standing link.
 *
 * **Says nothing about expiry, because there is none.** max chose a link that works until it
 * is revoked, so a promise of a window would be false — and would teach farmers to
 * re-request links they do not need. What it does say is that the link is theirs, which is
 * the honest warning for a credential with no password behind it.
 *
 * **The link is on its own line, and there is no STOP footer** (F-096). This answers a `LINK`
 * the farmer sent seconds ago — a reply-shaped message, where the footer is noise — and the URL
 * is the one thing on the screen they need to tap.
 */
export function renderFarmerLinkMessage(link: string): string {
  return [
    "VIGA Farm Friend: here is your page for updating your stand.",
    link,
    "This link is just for you - please don't share it.",
  ].join("\n");
}
