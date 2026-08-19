import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderHelpGuide, VIGA_CUSTOMER_CONTACT, VIGA_FARMER_CONTACT } from "./help-guide";
import { REGISTERED_HELP_AUTO_RESPONSE } from "./auto-responses";

// B-091 — the second message HELP sends, beside the carrier's registered reply.
//
// The registered reply answers HELP with "reply HELP" and an email, which tells a sender
// nothing they can act on. It cannot be improved in code: it is transcribed from live Telnyx
// console state and pinned character-for-character, so a code-side paraphrase would make live
// traffic differ from what the carrier approved. This message is ORDINARY code-rendered copy
// carrying the guidance the registered one cannot, and the assertions below keep it out of
// that registered block.

const registeredFieldValues = resolve(
  __dirname,
  "../../../../docs/TELNYX_10DLC_FIELD_VALUES.txt",
);

describe("the help guide (B-091)", () => {
  it("teaches the words a customer can actually use", () => {
    const body = renderHelpGuide("customer");
    for (const word of ["MAP", "FLAG", "STOP"]) {
      expect(body).toContain(word);
    }
    expect(body).toContain(VIGA_CUSTOMER_CONTACT);
  });

  it("teaches the farmer's own words, which a customer has no use for", () => {
    const body = renderHelpGuide("farmer");
    for (const word of ["LINK", "STAND", "STOP"]) {
      expect(body).toContain(word);
    }
    expect(body).toContain(VIGA_FARMER_CONTACT);
  });

  it("routes the two audiences to their own contact", () => {
    // One address today, but each audience reads its own constant — so giving farmers a
    // separate inbox is a value change here, never a hunt through copy for which mention
    // of board@ meant which reader.
    expect(renderHelpGuide("customer")).toContain(VIGA_CUSTOMER_CONTACT);
    expect(renderHelpGuide("farmer")).toContain(VIGA_FARMER_CONTACT);
  });

  it("says how to report a problem, which is the question HELP usually means", () => {
    for (const audience of ["customer", "farmer"] as const) {
      expect(renderHelpGuide(audience)).toMatch(/FLAG/);
    }
  });

  /*
    Segment cost, asserted WITHOUT importing the segment estimator: that lives in the `sms`
    adapter, and core must not depend on an adapter (`architecture.test.ts` enforces it).

    So this asserts the property the estimator would measure, from the two facts that decide
    it. GSM-7 packs 153 septets per segment in a concatenated message; a single character
    outside that alphabet switches the whole body to UCS-2 and drops the budget to 67 — which
    is exactly how an em dash silently cost this copy a third segment while it looked short.
  */
  it("costs at most two segments for either audience", () => {
    // The GSM-7 alphabet, plus the extension characters that each cost two septets.
    const gsm7 =
      "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
      "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
    const extended = "^{}\\[~]|€";

    for (const audience of ["customer", "farmer"] as const) {
      const body = renderHelpGuide(audience);
      for (const character of body) {
        expect(gsm7.includes(character) || extended.includes(character), character).toBe(true);
      }
      const septets = [...body].reduce(
        (total, character) => total + (extended.includes(character) ? 2 : 1),
        0,
      );
      expect(septets).toBeLessThanOrEqual(153 * 2);
    }
  });

  it("is not a registered auto-response and never claims to be", () => {
    const registered = readFileSync(registeredFieldValues, "utf8");
    for (const audience of ["customer", "farmer"] as const) {
      const body = renderHelpGuide(audience);
      expect(registered).not.toContain(body);
      expect(body).not.toBe(REGISTERED_HELP_AUTO_RESPONSE);
    }
  });

  it("embeds no phone number, keeping the campaign declaration truthful", () => {
    for (const audience of ["customer", "farmer"] as const) {
      expect(renderHelpGuide(audience)).not.toMatch(
        /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
      );
    }
  });
});
