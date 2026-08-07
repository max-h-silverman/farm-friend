import { describe, expect, it } from "vitest";

import {
  CODE_LENGTH,
  CODE_TTL_MINUTES,
  generateVerificationCode,
  isCodeExpired,
  normalizeSubmittedCode,
  renderVerificationEmail,
} from "./email-verification";

describe("generateVerificationCode", () => {
  it("is digits only, so it can be read aloud and typed on any keypad", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateVerificationCode()).toMatch(
        new RegExp(`^[0-9]{${CODE_LENGTH}}$`),
      );
    }
  });

  it("keeps leading zeros, which a number would silently drop", () => {
    // Generated as a string throughout. A code stored or compared as a number turns
    // `012345` into `12345` and the farmer's correct code is refused.
    const codes = Array.from({ length: 500 }, () => generateVerificationCode());
    expect(codes.every((code) => code.length === CODE_LENGTH)).toBe(true);
  });

  it("does not repeat itself over many draws", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateVerificationCode()));
    // A constant or a weak generator collapses this to a handful of values.
    expect(codes.size).toBeGreaterThan(400);
  });
});

describe("normalizeSubmittedCode", () => {
  it("accepts what a farmer actually types", () => {
    // Copy-paste from an email brings spaces; some people space the groups themselves.
    for (const typed of [" 123456 ", "123 456", "123-456", "\t123456\n"]) {
      expect(normalizeSubmittedCode(typed)).toBe("123456");
    }
  });

  it("refuses anything that is not exactly the code's digits", () => {
    for (const bad of ["", "12345", "1234567", "12345a", "abcdef"]) {
      expect(normalizeSubmittedCode(bad)).toBeNull();
    }
  });
});

describe("isCodeExpired", () => {
  const issued = new Date("2026-08-06T12:00:00Z");

  it("accepts a code inside its window", () => {
    const justInside = new Date(issued.getTime() + (CODE_TTL_MINUTES - 1) * 60_000);
    expect(isCodeExpired(issued, justInside)).toBe(false);
  });

  it("refuses a code past its window", () => {
    const justOutside = new Date(issued.getTime() + (CODE_TTL_MINUTES + 1) * 60_000);
    expect(isCodeExpired(issued, justOutside)).toBe(true);
  });

  it("refuses exactly at the boundary rather than accepting it", () => {
    const exactly = new Date(issued.getTime() + CODE_TTL_MINUTES * 60_000);
    expect(isCodeExpired(issued, exactly)).toBe(true);
  });

  it("treats a clock that ran backwards as expired, never as valid forever", () => {
    const before = new Date(issued.getTime() - 60_000);
    expect(isCodeExpired(issued, before)).toBe(true);
  });
});

describe("renderVerificationEmail", () => {
  const rendered = renderVerificationEmail({
    code: "123456",
    farmName: "Lavender Hill",
    replyToAddress: "board@vigavashon.org",
  });

  it("puts the code in the SUBJECT, so it is readable without opening the mail", () => {
    // The single biggest reducer of "what is this?" replies: a farmer who can see the code in
    // their notification never has to interpret the message at all.
    expect(rendered.subject).toContain("123456");
  });

  it("names Farm Friend and VIGA in the subject, so it is not mistaken for spam", () => {
    expect(rendered.subject).toMatch(/VIGA|Farm Friend/);
  });

  it("names the farm, so the farmer knows which listing this is about", () => {
    expect(rendered.text).toContain("Lavender Hill");
  });

  it("states the code on its own line", () => {
    expect(rendered.text).toMatch(/^\s*123456\s*$/m);
  });

  it("says how long the code lasts, in the same words as the rule", () => {
    expect(rendered.text).toContain(String(CODE_TTL_MINUTES));
  });

  it("tells someone who did not request it that they can ignore it", () => {
    // Without this line, the wrong recipient's only reasonable move is to reply and ask.
    expect(rendered.text.toLowerCase()).toContain("ignore");
  });

  it("tells the farmer they can reply to a human, and names the address", () => {
    // Replies are expected and welcome; the goal is fewer CONFUSED replies, not zero replies.
    expect(rendered.text).toContain("board@vigavashon.org");
  });

  it("never REQUESTS a password or secret, and says so outright", () => {
    // A verification mail that asks for anything is indistinguishable from phishing, which
    // produces exactly the "is this real?" reply this copy exists to prevent.
    //
    // The assertion is on the REQUEST, not on the word: a flat ban on "password" would also
    // forbid the reassurance line, which is the opposite of the goal. Anchored to the verb
    // phrases that would constitute asking.
    expect(rendered.text).not.toMatch(
      /(?:send|enter|reply with|confirm|provide|give)[^.]{0,40}\b(?:password|passcode|card|account number|social)/i,
    );
    expect(rendered.text.toLowerCase()).toContain("never ask you for a password");
  });

  it("carries no link, so it cannot be confused with a phishing message", () => {
    expect(rendered.text).not.toMatch(/https?:\/\//);
  });

  it("is plain text with no markup for a mail client to mangle", () => {
    expect(rendered.text).not.toMatch(/<[a-z]/i);
  });

  it("refuses to render a code that is not a code", () => {
    expect(() =>
      renderVerificationEmail({
        code: "12345",
        farmName: "Lavender Hill",
        replyToAddress: "board@vigavashon.org",
      }),
    ).toThrow();
  });

  it("refuses a blank farm name rather than sending a sentence with a hole in it", () => {
    expect(() =>
      renderVerificationEmail({
        code: "123456",
        farmName: "   ",
        replyToAddress: "board@vigavashon.org",
      }),
    ).toThrow();
  });
});
