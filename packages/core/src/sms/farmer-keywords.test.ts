import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bypassesModel,
  parseCommand,
  REGISTERED_HELP_KEYWORDS,
  REGISTERED_OPT_IN_KEYWORDS,
  REGISTERED_OPT_OUT_KEYWORDS,
} from "./commands";

// F-040 — the two FARMER keywords, and the line they must not cross.
//
// `SIGNUP` asks VIGA to set the farmer up; `LINK` asks for the web form link. Both are Farm
// Friend PRODUCT keywords, exactly like `FLAG` — they are not carrier compliance keywords and
// must never be registered as such. The assertions below are what hold that line in both
// directions, because the failure is silent either way: a product keyword transcribed into
// the registered block claims a registration nobody made, and a compliance keyword shadowed
// by a product one is a Golden Rule #2 violation.
//
// They are deterministic for the same reason every other keyword is: a farmer asking to be
// set up must never depend on a model being available, correct, or affordable.

const registeredFieldValues = resolve(
  __dirname,
  "../../../../docs/TELNYX_10DLC_FIELD_VALUES.txt",
);

describe("farmer keywords (F-040)", () => {
  it("parses SIGNUP and LINK as farmer commands", () => {
    expect(parseCommand("SIGNUP")).toEqual({
      kind: "farmer",
      keyword: "SIGNUP",
    });
    expect(parseCommand("LINK")).toEqual({ kind: "farmer", keyword: "LINK" });
  });

  it("bypasses the model, like every other deterministic keyword", () => {
    // A farmer asking to be set up must not depend on a model being available, correct, or
    // affordable. This is Golden Rule #2's reason, applied to the two words that decide
    // whether someone can use the product at all.
    expect(bypassesModel("SIGNUP")).toBe(true);
    expect(bypassesModel("LINK")).toBe(true);
  });

  it("normalizes case, surrounding space, and trailing punctuation", () => {
    for (const raw of ["signup", "  SignUp  ", "SIGNUP.", "Sign up", "sign up!"]) {
      expect(parseCommand(raw).kind, raw).toBe("farmer");
    }
    for (const raw of ["link", " Link ", "LINK?"]) {
      expect(parseCommand(raw).kind, raw).toBe("farmer");
    }
  });

  it("collapses INTERNAL whitespace, not merely the ends", () => {
    // Sabotage found this untested: "SIGN UP" is a literal table key, so a single space
    // needs no collapsing and the previous case passed with the collapse deleted. What the
    // collapse actually buys is the messier reality — a double space from a thumb, or a
    // newline from a wrapped message — and that was unasserted while looking covered.
    for (const raw of ["sign  up", "SIGN\nUP", "sign \t up", "  Sign   Up  "]) {
      expect(parseCommand(raw), raw).toEqual({
        kind: "farmer",
        keyword: "SIGNUP",
      });
    }
  });

  it("matches only the WHOLE message, never a word inside a sentence", () => {
    // The same rule every keyword follows. A farmer writing "we have a link to our website"
    // is sending free text, and treating it as a command would swallow a real message.
    for (const raw of [
      "can you send me a link",
      "signup please",
      "I want to signup for this",
      "link me up",
    ]) {
      expect(parseCommand(raw).kind, raw).toBe("none");
    }
  });

  it("never shadows a compliance keyword or a commitment token", () => {
    // The ordering that matters most. If a farmer keyword ever captured STOP, an opt-out
    // would stop working — the single worst failure this system has.
    for (const word of [
      ...REGISTERED_OPT_OUT_KEYWORDS,
      ...REGISTERED_OPT_IN_KEYWORDS,
      ...REGISTERED_HELP_KEYWORDS,
    ]) {
      expect(parseCommand(word).kind, word).toBe("compliance");
    }
    for (const word of ["YES", "NO", "Y", "N"]) {
      expect(parseCommand(word).kind, word).toBe("commitment");
    }
  });

  it("keeps SIGNUP and LINK OUT of the carrier-registered keyword lists", () => {
    // FLAG's rule, applied to the two new words: a Farm Friend product keyword is not a
    // carrier-mandated one and must never be registered as one.
    const registeredWords: readonly string[] = [
      ...REGISTERED_OPT_OUT_KEYWORDS,
      ...REGISTERED_OPT_IN_KEYWORDS,
      ...REGISTERED_HELP_KEYWORDS,
    ];
    expect(registeredWords).not.toContain("SIGNUP");
    expect(registeredWords).not.toContain("LINK");

    // And not in the transcript of live console state either — that file is what the carrier
    // actually has, and a word appearing there is a word VIGA promised to honour as
    // compliance.
    const registered = readFileSync(registeredFieldValues, "utf8");
    const keywordBlock = registered.slice(registered.indexOf("KEYWORDS"));
    expect(keywordBlock).not.toMatch(/\bSIGNUP\b/);
    expect(keywordBlock).not.toMatch(/\bLINK\b/);
  });
});
