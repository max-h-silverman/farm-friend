// The "add Farm Friend to contacts" card (F-039) — a vCard rendered from configuration.
//
// WHY THIS EXISTS. Every SMS journey in this product starts with a number the person does not
// have saved: they read ten digits off a sign or a QR page and type them in. That is where
// digits get mistyped and intent gets lost. A vCard is the standard fix — a small text file
// that, served with the right media type, opens the native add-contact sheet on both iOS and
// Android. No app, no library, no third party.
//
// WHY IT IS A PURE FUNCTION IN CORE, like `renderSignInEmail` and `proximity.ts`:
//
//   - **No model, no database, no clock.** The card is a function of one string. There is no
//     parameter through which a request, a row, or model prose could reach it, so "the
//     contact card is code-rendered" is a property of the signature rather than a rule
//     someone has to remember. It also keeps the public surface's module graph model-free
//     (`apps/web/lib/public-surface-model-free.test.ts`).
//   - **The number is an INPUT.** The one real failure mode here is DRIFT: a hard-coded
//     number that quietly stops matching `TELNYX_FROM_NUMBER`, the value the send path reads
//     (`packages/sms/src/telnyx.ts`). The card would still download and still open the
//     add-contact sheet — it would simply be the wrong number, and a farmer would keep it
//     forever. So there is no default and no fallback: the caller supplies the configured
//     value or nothing renders.
//
// WHAT THIS IS NOT, and the reason matters for compliance: **saving a contact is not
// enrollment.** It is a device-local act that grants nothing and records nothing — no
// database write, no consent transition, no proactive-send permission. It is emphatically not
// `JOIN` (docs/SMS_COMPLIANCE.md). So the card's copy names no keyword and claims no
// subscription; `vcard.test.ts` asserts the absence of that vocabulary, because the tempting
// NOTE ("text JOIN to get updates") would read on a farmer's phone as though the card had
// already done half of it.

/**
 * The contact's display name.
 *
 * **PROVISIONAL — AWAITING VIGA'S DECISION.** This value has not been chosen by anyone; it is
 * a placeholder that matches how the public copy already names the service
 * (`docs/VIGA_10DLC_WEBSITE_COPY.md`). It is the string that sits on a farmer's phone
 * forever, and renaming a contact already saved on a device is something nobody can reach in
 * to do — so it is VIGA's call rather than an implementation detail, and it must be confirmed
 * before this route is deployed. `vcard.test.ts` pins the value so a change is deliberate and
 * visible in review, not so the value is settled.
 */
export const CONTACT_CARD_DISPLAY_NAME = "VIGA Farm Friend";

/** The organization line, matching how VIGA names itself in the public copy. */
export const CONTACT_CARD_ORGANIZATION = "Vashon Island Growers Association";

/**
 * The media type the response must carry.
 *
 * `text/vcard` is the registered type (RFC 6350 §10.1, which obsoleted RFC 2426's
 * `text/directory`), and it is what makes a browser hand the payload to Contacts instead of
 * rendering it as a page of text — the difference between a working tap and one that appears
 * to do nothing. `charset=utf-8` is the only permitted charset for vCard.
 *
 * ## A deliberate, documented version mismatch
 *
 * The card below is `VERSION:3.0`, while RFC 6350 defines `text/vcard` alongside version 4.0.
 * That pairing is chosen for DEVICE COMPATIBILITY, which is the only thing that matters for
 * this feature: iOS and Android address books parse 3.0 most reliably, and 3.0 is what the
 * overwhelming majority of `.vcf` files in the wild carry. A strictly-4.0 card risks the
 * silent failure this whole route exists to avoid — a tap that opens nothing.
 *
 * The mismatch is stated rather than hidden because it is the kind of detail a later reader
 * would otherwise "fix" into a spec-pure 4.0 card and regress real phones. If a device is ever
 * observed rejecting this card, the version is the first thing to test — not the last.
 */
export const CONTACT_CARD_MEDIA_TYPE = "text/vcard; charset=utf-8";

/**
 * The download filename. The `.vcf` extension is the half Android relies on when deciding
 * which application receives the file.
 */
export const CONTACT_CARD_FILENAME = "viga-farm-friend.vcf";

/**
 * Where the card is served. Stated once here so the route's location and every tap target on
 * the public surfaces are derived from the same string — a route moved without updating a
 * hand-written href is a dead link on the map, and nothing would report it.
 */
export const CONTACT_CARD_PATH = "/api/public/contact-card";

/**
 * Exact E.164, the same form the send path requires.
 *
 * Validated rather than trusted because this codebase has already shipped the malformed
 * version once: a `TELNYX_FROM_NUMBER` carrying spaces returned 400 on every send and cost a
 * debugging session (session log 2026-07-27). A card built from that value would be silently
 * unusable — it would download and open a sheet containing a number that cannot be texted.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export interface ContactCardInput {
  /**
   * The SMS number in exact E.164 form, read from `TELNYX_FROM_NUMBER` by the caller.
   *
   * Required, with no default. A fallback here is the drift defect: it would let the card
   * render successfully while the configuration that actually sends says something else.
   */
  phoneNumber: string;
}

/**
 * Escape a value for a vCard content line (RFC 6350 §3.4).
 *
 * `\`, `;`, `,`, and newlines are STRUCTURAL in a vCard value — an unescaped one does not
 * corrupt the text, it changes the card's shape, and the parser reads the remainder as a
 * different field. None of today's values contain one, and escaping is what keeps that from
 * quietly becoming load-bearing the first time an organization name gains a comma.
 */
export function escapeVCardValue(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/**
 * The vCard line separator, built from character codes rather than written as a string.
 *
 * ## This is B-025, and the indirection is the fix
 *
 * A plain `"\r\n"` here is CORRECT in source and was still served as a bare LF in production:
 * 147 bytes, 0 CR, rejected by `file(1)`. The minifier folded the `.join("\r\n")` that used
 * this value into a single template literal and wrote the separators as **raw CR and LF bytes
 * in the source text**. ECMA-262 normalizes a literal CRLF inside a template literal to a
 * single LF at *parse* time (§12.9.6), so the CR was gone before the string ever existed.
 *
 * Neither the Next.js response path nor the Cloud Run proxy touches the body — both were
 * measured against the wire and both pass CRLF through byte-for-byte. The corruption was
 * entirely the build's.
 *
 * `String.fromCharCode` cannot be folded into literal source bytes: the CR has no textual
 * representation in the emitted file, so there is nothing for a parser to normalize. This is
 * the one place in the codebase where an obvious literal is deliberately refused, which is why
 * the reasoning is written here rather than in a commit message.
 *
 * `apps/web/lib/contact-card-build.test.ts` asserts the property against the BUILD OUTPUT,
 * because that is the only place the defect was ever visible.
 */
const CRLF = String.fromCharCode(13, 10);

/**
 * Render the contact card.
 *
 * Deliberately MINIMAL — `FN`, `N`, `ORG`, `TEL`. A contact card is not a brochure, and every
 * additional field is another thing that can be wrong on a device nobody can reach to fix.
 * There is no `NOTE` and no `URL`: a note is where consent language would creep in, and a URL
 * in an address-book entry is not what anyone taps.
 *
 * Lines are joined with CRLF, which the grammar requires (RFC 6350 §3.2) — see `CRLF` above
 * for why that separator is built from character codes instead of written as `"\r\n"`.
 */
export function renderContactCard(input: ContactCardInput): string {
  const phoneNumber = input.phoneNumber.trim();
  if (!E164.test(phoneNumber)) {
    throw new Error(
      "the contact card requires the SMS number in exact E.164 form (e.g. +12065550000); " +
        "a malformed TELNYX_FROM_NUMBER produces a card whose number cannot be texted",
    );
  }

  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVCardValue(CONTACT_CARD_DISPLAY_NAME)}`,
    // `N` is mandatory in 3.0 and is structured (family;given;…). An organization has no
    // surname, so the given-name slot carries the whole display name and the rest are empty —
    // the same thing a phone shows for a business contact.
    `N:;${escapeVCardValue(CONTACT_CARD_DISPLAY_NAME)};;;`,
    `ORG:${escapeVCardValue(CONTACT_CARD_ORGANIZATION)}`,
    // `CELL` so the phone offers "Message" as the primary action: texting is the whole point.
    `TEL;TYPE=CELL,VOICE:${phoneNumber}`,
    "END:VCARD",
  ].join(CRLF);
}
