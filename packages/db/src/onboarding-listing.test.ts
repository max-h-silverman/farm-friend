import { describe, expect, it } from "vitest";
import { standItemKey } from "./onboarding-listing";

// F-066 / F-067 — the item-normalization line, asserted DIRECTLY.
//
// This exists because a sabotage got past the integration suite. Folding "tomatoes" to
// "tomatoe" corrupts the key without colliding with anything, so every stored-row assertion
// stayed green: the database index applies the correct rule independently, so the rows looked
// right while the in-memory key that dedupes a farmer's own submission had silently stopped
// agreeing with the index that arbitrates.
//
// The rule (max, 2026-08-05): normalization is CASE AND SURROUNDING WHITESPACE ONLY. Never
// singular/plural, never synonyms — that would be a produce taxonomy, which no business code
// may hard-code (CLAUDE.md). "tomato", "tomatoes" and "love apple" are three items a farmer
// might genuinely stock separately, and deciding otherwise is not this layer's call.
//
// THESE TESTS MUST BE DELETED BEFORE ANYONE CAN LOOSEN THAT. That is their job.

describe("standItemKey", () => {
  it("folds case", () => {
    expect(standItemKey("Eggs")).toBe(standItemKey("eggs"));
    expect(standItemKey("EGGS")).toBe(standItemKey("eggs"));
  });

  it("folds surrounding whitespace, naming the characters explicitly", () => {
    // `btrim(text)` with no second argument strips SPACES ONLY — not tabs, not newlines. The
    // index names ' \t\r\n' explicitly and this must match it exactly, or the two disagree
    // about what "same item" means. A real defect in the 0020 migration was exactly this.
    expect(standItemKey("  eggs  ")).toBe("eggs");
    expect(standItemKey("\teggs\n")).toBe("eggs");
    expect(standItemKey("\r\neggs\t ")).toBe("eggs");
  });

  it("does NOT fold singulars into plurals", () => {
    expect(standItemKey("tomato")).not.toBe(standItemKey("tomatoes"));
    expect(standItemKey("egg")).not.toBe(standItemKey("eggs"));
    expect(standItemKey("berry")).not.toBe(standItemKey("berries"));
  });

  it("does NOT fold synonyms", () => {
    expect(standItemKey("tomato")).not.toBe(standItemKey("love apple"));
    expect(standItemKey("courgette")).not.toBe(standItemKey("zucchini"));
  });

  it("returns the word itself, mangling nothing", () => {
    // The assertion the collision tests above CANNOT make. A normalizer that trims a trailing
    // letter changes the key without necessarily colliding with another item, so "these two
    // stay apart" can hold while the key is quietly wrong. Anchored to exact values.
    expect(standItemKey("tomatoes")).toBe("tomatoes");
    expect(standItemKey("plant starts")).toBe("plant starts");
    expect(standItemKey("Gailan")).toBe("gailan");
  });

  it("keeps interior whitespace, which is part of the farmer's words", () => {
    // Only SURROUNDING whitespace is normalized. "plant starts" is two words and stays two.
    expect(standItemKey("  plant starts  ")).toBe("plant starts");
    expect(standItemKey("plant  starts")).toBe("plant  starts");
  });
});
