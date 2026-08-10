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
  });

  it("uses the verification code and Farm Friend in the exact subject", () => {
    expect(rendered.subject).toBe("123456 is your Farm Friend verification code");
  });

  it("renders the requested plain-text fallback exactly", () => {
    expect(rendered.text).toBe([
      "Hi there,",
      "",
      "Here’s your Farm Friend verification code:",
      "",
      "123456",
      "",
      `This code is valid for ${CODE_TTL_MINUTES} minutes.`,
      "",
      "If you didn’t request this, no worries. You can safely ignore this email.",
      "",
      "Thanks,",
      "VIGA Farm Friend",
    ].join("\n"));
  });

  it("renders an HTML version with a large, bold verification code", () => {
    expect(rendered.html).toContain("123456");
    expect(rendered.html).toMatch(/font-size:\s*32px/);
    expect(rendered.html).toMatch(/font-weight:\s*700/);
  });

  it("refuses to render a code that is not a code", () => {
    expect(() =>
      renderVerificationEmail({
        code: "12345",
      }),
    ).toThrow();
  });
});
