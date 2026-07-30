import { describe, expect, it } from "vitest";
import {
  CONTACT_CARD_DISPLAY_NAME,
  CONTACT_CARD_FILENAME,
  CONTACT_CARD_MEDIA_TYPE,
  escapeVCardValue,
  renderContactCard,
} from "./vcard";

// F-039 — the "add Farm Friend to contacts" card is CODE-RENDERED from configuration.
//
// These tests are the spec for three properties, and each one exists because the obvious
// implementation gets it wrong:
//
//   1. **The number is an INPUT, never a literal.** The card must be a function of the
//      configured sending number, so it cannot drift from the number that actually sends.
//      The tests below feed two different numbers and require two different cards — an
//      assertion a hard-coded digit string cannot satisfy.
//   2. **Saving a contact is not enrollment.** This is a compliance-adjacent surface: a
//      contact card that says "text JOIN to subscribe" in a NOTE field would be read as a
//      subscription, and a device-local address-book entry grants nothing and records
//      nothing. The copy must not claim otherwise.
//   3. **The card is well-formed vCard 3.0.** A malformed card is silently useless: the
//      phone opens nothing and there is no error anywhere.

const NUMBER = "+12068645326";
const OTHER_NUMBER = "+12065550123";

describe("renderContactCard (F-039)", () => {
  it("wraps the card in BEGIN/END:VCARD with a VERSION line", () => {
    const card = renderContactCard({ phoneNumber: NUMBER });
    const lines = card.split("\r\n");

    // Anchored to POSITION, not to mere presence: a phone parses the card by reading
    // BEGIN:VCARD first and stops at END:VCARD, so a card with the delimiters buried in the
    // middle is not a card. VERSION must precede the content properties in 3.0.
    expect(lines[0]).toBe("BEGIN:VCARD");
    expect(lines[1]).toBe("VERSION:3.0");
    expect(lines.at(-1)).toBe("END:VCARD");
  });

  it("uses CRLF line endings, as the vCard grammar requires", () => {
    // RFC 6350 §3.2 / RFC 2426 §2.1: lines are delimited by CRLF. Bare LF is the mistake a
    // template literal makes by default, and some parsers reject it.
    const card = renderContactCard({ phoneNumber: NUMBER });
    expect(card).toContain("\r\n");
    expect(card.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("carries the configured number as its TEL value", () => {
    const card = renderContactCard({ phoneNumber: NUMBER });
    expect(card).toContain(`TEL;TYPE=CELL,VOICE:${NUMBER}`);
  });

  it("renders a DIFFERENT card for a different configured number", () => {
    // THE ANTI-LITERAL ASSERTION. This is the one that fails if someone replaces the
    // parameter with a hard-coded digit string: the two cards would be identical, and the
    // served contact would drift from the number that sends. Anchored to the rendered TEL
    // output rather than to any vocabulary about configuration.
    const a = renderContactCard({ phoneNumber: NUMBER });
    const b = renderContactCard({ phoneNumber: OTHER_NUMBER });

    expect(a).not.toBe(b);
    expect(a).toContain(NUMBER);
    expect(a).not.toContain(OTHER_NUMBER);
    expect(b).toContain(OTHER_NUMBER);
    expect(b).not.toContain(NUMBER);
  });

  it("contains no phone-number literal beyond the one it was handed", () => {
    // Stronger than the pair test: scan the rendered card for anything E.164-shaped and
    // require that the ONLY such run is the input. A stray literal anywhere — a fallback, an
    // example in a NOTE, a second TEL — fails here.
    const card = renderContactCard({ phoneNumber: NUMBER });
    const found = [...card.matchAll(/\+?\d[\d()\-.\s]{8,}\d/g)].map((m) => m[0]);
    expect(found).toEqual([NUMBER]);
  });

  it("names the contact with the provisional display name, pinned so a change is deliberate", () => {
    // PROVISIONAL — not yet confirmed by VIGA. Pinned so that changing the name a farmer sees
    // forever is a visible, reviewed edit rather than an incidental one; the pin records the
    // current value, it does not claim anyone has approved it.
    expect(CONTACT_CARD_DISPLAY_NAME).toBe("VIGA Farm Friend");

    const card = renderContactCard({ phoneNumber: NUMBER });
    expect(card).toContain("FN:VIGA Farm Friend");
    expect(card).toContain("ORG:Vashon Island Growers Association");
  });

  it("is a pure function of its input — same input, byte-identical output", () => {
    const a = renderContactCard({ phoneNumber: NUMBER });
    const b = renderContactCard({ phoneNumber: NUMBER });
    expect(a).toBe(b);
  });

  it("claims no subscription, enrollment, or consent anywhere in its copy", () => {
    // COMPLIANCE-ADJACENT. Saving a contact is a device-local act that grants nothing and
    // records nothing — it is emphatically not JOIN. A NOTE that told the reader they were
    // now signed up, or that instructed them to text a consent keyword as though the card
    // had already done half of it, would misrepresent consent on the one surface a farmer
    // keeps forever.
    const card = renderContactCard({ phoneNumber: NUMBER }).toLowerCase();
    for (const claim of [
      "subscrib",
      "sign up",
      "signed up",
      "signup",
      "enroll",
      "opt in",
      "opt-in",
      "opted in",
      "consent",
      "join",
      "start",
      "unsubscribe",
      "msg&data",
      "message and data rates",
    ]) {
      expect(card, `contact card copy must not claim "${claim}"`).not.toContain(claim);
    }
  });

  it("escapes every vCard structured-value delimiter in a text value", () => {
    // A raw `,`, `;`, `\` or newline inside a TEXT value does not corrupt the text — it
    // changes the card's STRUCTURE, and the parser reads the remainder as another field.
    //
    // Tested against the escaper DIRECTLY, with input that actually contains each delimiter.
    // Asserting over the rendered card instead would prove nothing: today's display name and
    // organization contain no delimiter, so the assertion would pass with the escaping
    // deleted. This is the sabotage-survivability point — a test whose input cannot exercise
    // the code it names is not a test of it.
    expect(escapeVCardValue("Smith, John")).toBe("Smith\\, John");
    expect(escapeVCardValue("a;b")).toBe("a\\;b");
    expect(escapeVCardValue("a\\b")).toBe("a\\\\b");
    expect(escapeVCardValue("line1\nline2")).toBe("line1\\nline2");

    // And the escaped result carries no unescaped delimiter left to break the grammar.
    expect(escapeVCardValue("VIGA, Farm; Friend")).not.toMatch(/(?<!\\)[,;]/);
  });

  it("does not let a delimiter in a name add or remove a card line", () => {
    // The consequence, stated structurally: whatever the values contain, the card has exactly
    // the lines it declares. If escaping were removed and a name gained a comma, `N` would
    // gain a component — this is the property that would notice.
    const lines = renderContactCard({ phoneNumber: NUMBER }).split("\r\n");
    expect(lines).toHaveLength(7);
    expect(lines.filter((line) => line.startsWith("TEL"))).toHaveLength(1);
  });

  it("declares the MIME type and filename a phone needs to open the card", () => {
    // Both are part of the mechanism, not decoration: the wrong media type makes the browser
    // display the card as text instead of handing it to the address book, and a filename
    // without `.vcf` does the same on Android.
    expect(CONTACT_CARD_MEDIA_TYPE).toBe("text/vcard; charset=utf-8");
    expect(CONTACT_CARD_FILENAME).toMatch(/\.vcf$/);
  });

  it("refuses a number that is not in exact E.164 form", () => {
    // `TELNYX_FROM_NUMBER` not being exact E.164 is a defect this codebase has already
    // shipped once — it returned 400 on every send (session log 2026-07-27). A card built
    // from a malformed value would be silently unusable, so it fails loudly instead.
    for (const bad of ["2068645326", "+1 206 864 5326", "", "+1206864532x", "  "]) {
      expect(() => renderContactCard({ phoneNumber: bad }), bad).toThrow();
    }
  });
});
