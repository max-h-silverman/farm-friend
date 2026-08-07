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

// F-040 / F-080 — the FARMER keywords, and the line they must not cross.
//
// `LINK` asks for the web form link; `STAND` and `SETTINGS` reach a farmer's own surfaces. All
// are Farm Friend PRODUCT keywords, exactly like `FLAG` — they are not carrier compliance
// keywords and must never be registered as such. The assertions below hold that line in both
// directions, because the failure is silent either way: a product keyword transcribed into the
// registered block claims a registration nobody made, and a compliance keyword shadowed by a
// product one is a Golden Rule #2 violation.
//
// ## `SIGNUP` is gone, and an invitation is redeemed by `JOIN <token>` (F-080)
//
// `SIGNUP` was promoted nowhere and was never a registered keyword. max removed it (2026-08-06)
// outright — no grace window, because Farm Friend is pre-go-live and there is no farmer
// mid-onboarding to strand.
//
// **`JOIN` is a carrier-registered COMPLIANCE keyword**, deliberately parsed before every
// product keyword so a product word can never shadow compliance. Giving it an argument grammar
// inverts exactly that ordering, which is the risk this design has to answer.
//
// **The mitigation is structural, not a comment.** Bare `JOIN` matches first, in the unchanged
// compliance branch. `JOIN <64-hex>` matches in a SEPARATE, LATER branch — after compliance,
// after commitments, alongside the other argument grammars. The test named "bare JOIN is still
// the compliance opt-in" is the whole safety argument, and the sabotage that moves the token
// regex above the compliance lookup must fail it.

const registeredFieldValues = resolve(
  __dirname,
  "../../../../docs/TELNYX_10DLC_FIELD_VALUES.txt",
);

describe("farmer keywords (F-040, F-080)", () => {
  it("parses LINK as a farmer command", () => {
    expect(parseCommand("LINK")).toEqual({ kind: "farmer", keyword: "LINK" });
  });

  it("SIGNUP is NO LONGER A KEYWORD and parses as free text", () => {
    // The failing test that names F-080. Every spelling the old table carried, including the
    // two-word form and the punctuated ones the normalizer used to fold into it.
    for (const raw of ["SIGNUP", "signup", "Sign up", "SIGN UP", "sign up!", "  SignUp  "]) {
      expect(parseCommand(raw).kind, raw).toBe("none");
    }
  });

  it("SIGNUP with a well-formed token is free text too, not an invitation", () => {
    // The token grammar went with the keyword. A farmer holding an old link texts free text
    // and reaches the model, rather than silently redeeming anything.
    expect(parseCommand(`SIGNUP ${"a".repeat(64)}`).kind).toBe("none");
  });

  it("BARE JOIN IS STILL THE COMPLIANCE OPT-IN", () => {
    // THE test that guards the inversion risk in this design. `JOIN` is carrier-registered;
    // adding a `JOIN <token>` grammar must not let a product branch capture the bare word.
    //
    // **What sabotage actually shows, stated precisely rather than as a claimed proof.** Two
    // independent properties protect the bare word, and each makes the other non-critical:
    //
    //   * The branch sits BELOW the compliance lookup, so bare `JOIN` is already consumed
    //     before the farmer grammar is reached.
    //   * The grammar REQUIRES a token, so it cannot match a bare `JOIN` from any position.
    //
    // So the single sabotages each pass, and neither alone demonstrates anything: moving the
    // strict regex above compliance passes (it still cannot match bare JOIN), and loosening
    // the grammar in place passes (compliance already consumed the word). **The sabotage that
    // fails is BOTH AT ONCE** — a looser grammar hoisted above compliance
    // (`/^JOIN ?([0-9A-F]{64})?$/` moved up), which is exactly the plausible mistake someone
    // makes while "tidying up" the two JOIN branches into one. Verified: it fails this test
    // and the shadowing test below.
    //
    // That is defence in depth rather than a single guard, and it is the honest description.
    expect(parseCommand("JOIN")).toEqual({
      kind: "compliance",
      keyword: "JOIN",
      global: false,
    });
    // And through the normalizer, the way a farmer actually sends it.
    for (const raw of ["join", " Join ", "JOIN."]) {
      expect(parseCommand(raw), raw).toEqual({
        kind: "compliance",
        keyword: "JOIN",
        global: false,
      });
    }
  });

  it("the JOIN grammar REQUIRES a token — an optional one would capture the bare word", () => {
    // The property that actually protects the registered keyword, asserted directly rather
    // than left implicit in the ordering. If the token ever became optional, bare `JOIN`
    // would match a farmer branch from any position, and the compliance opt-in would be
    // shadowed by a product grammar.
    //
    // Asserted through the parser's OWN behaviour: a bare `JOIN` yields a compliance result
    // carrying no invitation token at all, so there is no shape in which the farmer branch
    // saw it.
    const bare = parseCommand("JOIN");
    expect(bare.kind).toBe("compliance");
    expect(bare).not.toHaveProperty("invitationToken");

    // And `JOIN ` with trailing space, which the normalizer trims — still compliance, never a
    // farmer command with an empty token.
    expect(parseCommand("JOIN ").kind).toBe("compliance");
  });

  it("carries a one-use invite token through JOIN <token>", () => {
    expect(parseCommand(`JOIN ${"a".repeat(64)}`)).toEqual({
      kind: "farmer",
      keyword: "JOIN",
      invitationToken: "a".repeat(64),
    });
    // Case-folded on the way in, so the stored lowercase hash matches whatever the farmer's
    // keyboard produced.
    expect(parseCommand(`join ${"A".repeat(64)}`)).toEqual({
      kind: "farmer",
      keyword: "JOIN",
      invitationToken: "a".repeat(64),
    });
  });

  it("does not treat arbitrary text after JOIN as an invitation", () => {
    // The token is accepted only in its opaque 32-byte hex form, so ordinary words after JOIN
    // stay free text and cannot accidentally select an invitation.
    for (const raw of [
      "JOIN please help",
      "JOIN the club",
      `JOIN ${"a".repeat(63)}`,
      `JOIN ${"a".repeat(65)}`,
      `JOIN ${"z".repeat(64)}`,
    ]) {
      expect(parseCommand(raw).kind, raw).toBe("none");
    }
  });

  it("bypasses the model, like every other deterministic keyword", () => {
    // A farmer asking to be set up must not depend on a model being available, correct, or
    // affordable. This is Golden Rule #2's reason, applied to the words that decide whether
    // someone can use the product at all.
    expect(bypassesModel("LINK")).toBe(true);
    expect(bypassesModel(`JOIN ${"a".repeat(64)}`)).toBe(true);
    expect(bypassesModel("JOIN")).toBe(true);
  });

  it("normalizes case, surrounding space, and trailing punctuation", () => {
    for (const raw of ["link", " Link ", "LINK?"]) {
      expect(parseCommand(raw).kind, raw).toBe("farmer");
    }
  });

  it("collapses INTERNAL whitespace, not merely the ends", () => {
    // Sabotage originally found this untested against "SIGN UP", a literal table key where a
    // single space needed no collapsing. The collapse is still load-bearing for the JOIN
    // token grammar, where a double space or a wrapped newline is what a thumb produces.
    for (const raw of [
      `JOIN  ${"a".repeat(64)}`,
      `JOIN\n${"a".repeat(64)}`,
      `  join \t ${"a".repeat(64)}  `,
    ]) {
      expect(parseCommand(raw), raw).toEqual({
        kind: "farmer",
        keyword: "JOIN",
        invitationToken: "a".repeat(64),
      });
    }
  });

  it("matches only the WHOLE message, never a word inside a sentence", () => {
    // The same rule every keyword follows. A farmer writing "we have a link to our website"
    // is sending free text, and treating it as a command would swallow a real message.
    for (const raw of [
      "can you send me a link",
      "link me up",
      "can I join up",
      `here is my code JOIN ${"a".repeat(64)}`,
    ]) {
      expect(parseCommand(raw).kind, raw).toBe("none");
    }
  });

  it("never shadows a compliance keyword or a commitment token", () => {
    // The ordering that matters most. If a farmer keyword ever captured STOP, an opt-out
    // would stop working — the single worst failure this system has. JOIN is in this list,
    // so the token grammar is held to it too.
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

  it("keeps the PRODUCT keywords out of the carrier-registered lists", () => {
    // FLAG's rule: a Farm Friend product keyword is not a carrier-mandated one and must never
    // be registered as one. SIGNUP is absent because it no longer exists at all.
    const registeredWords: readonly string[] = [
      ...REGISTERED_OPT_OUT_KEYWORDS,
      ...REGISTERED_OPT_IN_KEYWORDS,
      ...REGISTERED_HELP_KEYWORDS,
    ];
    expect(registeredWords).not.toContain("SIGNUP");
    expect(registeredWords).not.toContain("LINK");
    // JOIN, by contrast, IS registered — that is precisely why the token grammar had to be
    // added below the compliance branch rather than beside the product keywords.
    expect(registeredWords).toContain("JOIN");

    // And the transcript of live console state, which is what the carrier actually has: a
    // word appearing there is one VIGA promised to honour as compliance.
    const registered = readFileSync(registeredFieldValues, "utf8");
    const keywordBlock = registered.slice(registered.indexOf("KEYWORDS"));
    expect(keywordBlock).not.toMatch(/\bSIGNUP\b/);
    expect(keywordBlock).not.toMatch(/\bLINK\b/);
    expect(keywordBlock).toMatch(/\bJOIN\b/);
  });
});
