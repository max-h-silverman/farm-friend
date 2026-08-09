import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderFarmerTargetMenu } from "./farmer-targeting";

// F-096 — the STOP footer comes off REPLY-SHAPED messages.
//
// The rule, and why it is not "remove the footer everywhere": no regulation requires opt-out
// language on every message. The obligations are the opt-in confirmation, the HELP response, and
// that STOP always works from any state — the first two are registered carrier copy, the third is
// enforced in `consent.ts` where no model can reach it. `docs/SMS_COMPLIANCE.md` states the duty
// as "honor opt-out immediately and durably", never "advertise it every time".
//
// So the footer stays where a recipient is DECIDING about Farm Friend (onboarding copy, the
// customer welcome) and on the one recurring proactive stream (the F-081 scheduled prompt, which
// carries its own — see `prompt-schedule.ts`). It comes off messages that answer something the
// farmer sent seconds ago, where it is boilerplate stapled to their own errand.

describe("farmer reply copy (F-096)", () => {
  it("keeps the stand menu free of the opt-out footer", () => {
    const menu = renderFarmerTargetMenu([
      { optionNumber: 1, locationName: "North Stand" },
      { optionNumber: 2, locationName: "Misty Isle Farm" },
    ] as Parameters<typeof renderFarmerTargetMenu>[0]);
    expect(menu).toContain("North Stand");
    expect(menu).not.toContain("STOP");
  });

  it("still tells the farmer how to answer the menu", () => {
    // Removing the footer must not remove the instruction that makes the menu usable — the
    // reply is a bare number, which is not guessable from a list of names.
    const menu = renderFarmerTargetMenu([
      { optionNumber: 1, locationName: "North Stand" },
    ] as Parameters<typeof renderFarmerTargetMenu>[0]);
    expect(menu.toLowerCase()).toContain("number");
  });

  /*
    The other three farmer replies are built inline inside `finishPurpose` and `handleStandSelection`,
    which need a database and a live authorization to reach. Their bodies are template literals in
    this file, so the assertion is made against the SOURCE.

    Anchored to the literal `body:` assignments rather than to loose vocabulary: a match on the
    word "STOP" anywhere in the file would be satisfied by this comment, and a match on the whole
    file would be satisfied by the import list. Comments are stripped before the check for exactly
    that reason, and the anchor is proven by a positive control below.
  */
  const source = readFileSync(resolve(__dirname, "farmer-targeting.ts"), "utf8");
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const bodyLines = [...withoutComments.matchAll(/^\s*body:\s*(.+)$/gm)].map((m) => m[1]!);

  it("finds the reply bodies it claims to be checking", () => {
    // The positive control. A source assertion that matches nothing passes vacuously forever;
    // this proves the extraction actually sees the lines the next test rules on.
    expect(bodyLines.length).toBeGreaterThanOrEqual(3);
    expect(bodyLines.some((line) => line.includes("don't share it"))).toBe(true);
    expect(bodyLines.some((line) => line.includes("what you have out there"))).toBe(true);
  });

  it("carries no opt-out footer on any inline farmer reply body", () => {
    for (const line of bodyLines) {
      expect(line).not.toContain("STOP");
    }
  });
});
