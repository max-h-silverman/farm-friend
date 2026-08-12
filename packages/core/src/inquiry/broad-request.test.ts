// B-061 defect 4 — the deterministic broad-request check.
//
// Measured 2026-08-11 against the live model: "what do you have" returns `ambiguous` 10 runs
// out of 10 EVEN WHEN THAT EXACT PHRASE IS WRITTEN INTO THE INSTRUCTION as a broad lookup that
// is "never ambiguous". Three earlier instruction edits each moved which phrasings passed
// without fixing the family, and the widest regressed cases that previously worked. The family
// is not reachable by instruction, so the lever is code (B-061's own note).
//
// WHAT THIS IS NOT: a produce taxonomy or a food vocabulary. CLAUDE.md forbids hard-coding what
// the model can understand — no farm names, no food words in behavioral branches. This matches
// SHOPPING-INTENT GRAMMAR ONLY: an open "what/who ... have/sell/buy" question with no product
// noun in it. It never inspects a product word, so adding a crop to the island changes nothing
// here. Foods, farms, and listings remain data.

import { describe, expect, it } from "vitest";
import { isBroadAvailabilityRequest } from "./broad-request";

describe("isBroadAvailabilityRequest", () => {
  // The phrasings measured as instruction-immune. These are the finding, not examples.
  const BROAD = [
    "what do you have",
    "what's for sale",
    "what can I buy",
    "who has anything today",
    "show me what's out there",
    "what's available right now?",
    "anything good today?",
    // Held out from every instruction, so this proves grammar and not a copied list.
    "what are folks selling",
    "what have you got today",
    "anything for sale",
    "what do you got",
    "WHAT DO YOU HAVE?",
    "what is available",
    "what's in season",
  ];

  it.each(BROAD)("reads %j as a broad availability request", (text) => {
    expect(isBroadAvailabilityRequest(text)).toBe(true);
  });

  // The check must not swallow the cases the model already gets right. A greeting is genuinely
  // ambiguous, and a named product must stay a narrow lookup so the model still does the
  // semantic matching that broad paging skips.
  const NOT_BROAD = [
    "hi",
    "thanks",
    "are you a robot",
    "got any eggs?",
    "who has tomatoes",
    "do you have kale",
    "what do you have for tomatoes",
    "is Provo Farms open today",
    "STOP",
    "",
    "   ",
  ];

  it.each(NOT_BROAD)("leaves %j alone", (text) => {
    expect(isBroadAvailabilityRequest(text)).toBe(false);
  });

  // Deliberately NOT claimed. "whats at the farm stands" is a real broad request, and reading
  // it would take "farm"/"stand" as filler — domain vocabulary this check must not hold. The
  // model gets it right today (measured 3/3), and the check only ever overrides `ambiguous`
  // toward answering, so declining it costs nothing and keeps the architecture rule intact.
  it("declines a broad request it cannot read without domain vocabulary", () => {
    expect(isBroadAvailabilityRequest("whats at the farm stands")).toBe(false);
  });

  it("carries no food or farm vocabulary in its own source", async () => {
    // The architecture rule this check is most likely to violate as it grows: someone "fixes"
    // a miss by adding a crop word. Anchored to the source so that edit fails here.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./broad-request.ts", import.meta.url), "utf8");
    const body = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    for (const word of ["egg", "tomato", "kale", "produce", "lettuce", "berry", "farm stand"]) {
      expect(body.toLowerCase()).not.toContain(word);
    }
  });
});
