import { CONTACT_CARD_PATH } from "../public/vcard";

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

/*
  THE JOIN INSTRUCTION IS GONE (B-043, 2026-08-12), and this note is here so it is not rebuilt.

  It said "To get texts about your farm, reply START" and was sent alongside the acknowledgement
  when a redemption left the farmer with no consent basis. Two things were wrong with it:

    - **No caller could reach it.** `routing.ts` calls `invitedJoinReplyBodies` at one site,
      guarded by `onboarded` and passing a literal `authorized: true`, which returns before that
      branch. It had not been deliverable for some time and nothing reported that.
    - **It named the wrong word, and told the sender to send one they had just sent.** F-100 made
      `VIGA` the word the onboarding form teaches; this told a farmer who had just texted VIGA to
      reply START.

  The farmer it was written for — an invitation whose SMS box was never ticked, redeemed by text
  — is answered by the router's `awaitingCoordinator` branch with the acknowledgement alone. That
  is max's call (2026-08-12) and it is the honest one: they are waiting on a person, no keyword
  reaches their problem, and handing them one makes a dead end look like their own typo.

  If a farmer ever needs a recovery keyword after a carrier opt-out, that is a DIFFERENT message
  for a different reader, and `START`/`VIGA` both clear the block now — not a revival of this one.
*/

/**
 * Sent only after the pending invitation has redeemed and its listing is actually public.
 * Telnyx's VIGA auto-response has already confirmed the handset; this names the separate,
 * truthful product outcome and gives the farmer their private update page.
 */
export function renderFarmerOnboardingComplete(link: string | null): string {
  return link === null
    ? "VIGA Farm Friend: Your farm is ready. Text LINK to get your private update page."
    : [
        "VIGA Farm Friend: Your listing is live.",
        "",
        "Update it here:",
        link,
        "Text LINK if you lose this page.",
      ].join("\n");
}

/**
 * The farmer keywords this system is the only channel for (F-093).
 *
 * Stated ONCE, here, and asserted against `FarmerKeyword` in `commands.ts` by test — a keyword
 * cannot be added to the parser without being taught OR listed as deliberately untaught below,
 * which is exactly the gap F-093 closed.
 *
 * **`MORE`, `YES`/`NO` and `SAME` are deliberately absent.** Each is a reply to a message Farm
 * Friend sent, and the message that needs one teaches it in context. Listing them here would
 * make a farmer memorize four words for a conversation that hands them over one at a time.
 */
export const FARMER_TAUGHT_KEYWORDS = ["LINK", "STAND"] as const;

/**
 * Keywords the parser honours that farmer-facing copy deliberately does NOT teach.
 *
 * **Not an escape hatch — the place a decision has to be written down.** The keyword tripwire
 * requires every parsed keyword to appear in one list or the other, so dropping a word from the
 * taught set forces an entry here with a reason. Without that, a keyword nobody teaches and a
 * keyword somebody forgot look identical.
 *
 * **`SETTINGS` (max, 2026-08-09).** A farmer has exactly ONE edit page, and `LINK` already sends
 * them to it — the reminder cadence is a tab on that same page. So `SETTINGS` is a second word
 * for a door they already hold the key to, and teaching it in the welcome text spends a line on
 * a distinction that does not exist for them yet.
 *
 * It stays PARSED and stays working: a farmer who texts it still gets their settings link, and
 * the choice-expired reply in `farmer-targeting.ts` still names it. **When account settings
 * become a surface genuinely separate from the stand's edit page, this moves back to the taught
 * list** — that condition is why this constant exists rather than the word being deleted.
 */
export const FARMER_UNTAUGHT_KEYWORDS = ["SETTINGS"] as const;

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
export function renderFarmerAuthorizedNotification(
  link: string | null,
  options: { standCount?: number } = {},
): string {
  /*
    WHETHER TO NAME `STAND` (max, 2026-08-09).

    `STAND` picks between a farmer's stands, so for the farmer with one it is an instruction
    for a situation they are not in — a line spent teaching a word they can never usefully
    send, in the message whose whole job is teaching the product.

    The keyword is untouched: still parsed, still honoured, still in
    `FARMER_TAUGHT_KEYWORDS` (which is what `farmer-keywords.test.ts` asserts against). What
    is conditional is whether THIS message spends a line on it.

    Defaults to naming it. A caller that does not know the count is not evidence of one
    stand, and the failure directions are asymmetric: a farmer with two stands who was never
    taught the word has no other way to learn it, while a farmer with one who reads it loses
    a few characters.
  */
  const severalStands = (options.standCount ?? 2) > 1;

  return [
    // Names the CHANNEL, because that is what the farmer needs to understand first: this
    // number is the product, not a no-reply sender. "You're all set" said the state without
    // saying what to do with it.
    "VIGA Farm Friend: Welcome! This is the number you can text to manage your listing.",
    "",
    /*
      HOW TO SAY IT, shown rather than described (max, 2026-08-09).

      "Just text us what you have out" states the interface without demonstrating it, and a
      farmer's first message is the one most likely to be a stilted list — because they are
      guessing at a format that does not exist. The example carries the real shape: ordinary
      phrasing, several operations at once, add and remove and restock mixed together.

      Deliberately NOT a template to copy. The words are a farmer's own, misspelling included,
      which is the point — the interpreter reads sentences, not a syntax.
    */
    'You can send natural phrasing like "we\'re out of eggs, replenished kale and added ' +
      'radishes".',
    "",
    // A farmer with no stand yet cannot be issued a link: `issueFarmerLinkIn` needs a
    // `sales_locations` row, and the ADMIN authorization path can run before one exists (the
    // invited path always has one — the farmer published the listing on the form). Naming the
    // word is the honest fallback; inventing a URL that resolves to nothing would be worse
    // than asking for one more text.
    ...(link === null
      ? [
          "You can also update your listing on the web. Text LINK to get your edit link.",
        ]
      : [
          "You can also update your listing on the web:",
          link,
          "Text LINK if you lose it.",
        ]),
    // Only for a farmer who has a second stand to pick between — see `severalStands`.
    ...(severalStands ? ["", "Text STAND to select a different stand."] : []),
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
    /*
      WHAT TAPPING IT DOES, and why the sentence grew (F-097, max 2026-08-08).

      On a real handset the attachment previews as "contact-card · 153 bytes" over the bare
      host — the filename and a byte count, which say nothing about what it is for. "Save VIGA
      Farm Friend in your contacts:" named the action but not the payoff, so the offer sat
      beside an inscrutable file and read as something the system had emitted at the farmer.

      Naming the CONSEQUENCE is what makes it worth a tap: the alternative is every later
      message — a reminder, a stock-out alert — arriving from an unnamed number.
    */
    "Tap to save our number, so our texts show up as VIGA Farm Friend and not a stranger:",
    contactCardUrl(publicBaseUrl),
  ].join("\n");
}

/**
 * The served contact card's address (F-039), built from the same base every reply uses.
 *
 * The path comes from `CONTACT_CARD_PATH` rather than a literal: it is the string iOS titles
 * the message preview with (B-052), so a copy of it here would let the texted link and the
 * served route drift into two different names for one card.
 */
export function contactCardUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${CONTACT_CARD_PATH}`;
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

/**
 * Ask a stand's owner to confirm a seller who put herself there (F-117).
 *
 * **Code-rendered from typed facts**, never model prose: this is a cross-actor message — it
 * tells one farmer something another farmer did — and Golden Rule #6 permits only code-rendered
 * text across that boundary. The only variable is a seller name, which
 * `validatePublicStrings` has already refused if it carries contact details.
 *
 * **The two words are stated plainly** because the answer is deterministic: `YES` and `NO` are
 * parsed before any model call, and a host who answers in a sentence gets no commitment. Naming
 * them is what makes the reply answerable.
 *
 * **No deadline is stated**, matching the farmer target menu's reasoning. The question closes
 * when anything else passes in the thread rather than on a clock, so there is no honest number
 * to give — and the host's settings screen carries Remove either way, which is the sentence
 * that actually helps. GSM-7: no em-dash, no curly quotes.
 */
export function renderHostConfirmationRequest(sellerName: string): string {
  return [
    `VIGA Farm Friend: ${sellerName} says they sell at your farm stand.`,
    "Reply YES to confirm, or NO if that is wrong and we will remove them.",
  ].join("\n");
}
