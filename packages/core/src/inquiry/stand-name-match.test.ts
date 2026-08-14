import { describe, expect, it } from "vitest";
import {
  editDistanceWithin,
  fuzzyNameAllowance,
  isFuzzyNameMatch,
  meetsDistinctiveWordBar,
  resolveStandName,
} from "./stand-name-match";

/*
  B-065. The fuzzy tier of stand-name resolution, used ONLY inside an open clarification —
  Farm Friend has already asked "Which stand are you at?", so the reply is presumed to be an
  attempt at the answer rather than a new topic (max, 2026-08-12).

  The allowance is scaled to word length, and that is the load-bearing part. Measured against
  all 36 live stands 2026-08-12: at a FLAT distance of 2, "barts" — a correctly spelled
  partial that resolves exactly today — became a three-way tie with "Bananas Barn" and
  "Green Ears". Short words are where unrelated names collide, so short words get no slack.
*/

describe("fuzzy stand-name allowance", () => {
  it("gives short words no slack at all", () => {
    // Real distinctive words at these lengths sit within 2 edits of each other:
    // barn/barts/ears/bird/bear, green/tree/creek, peach/peak. Any slack ties them.
    for (const word of ["barn", "ears", "bird", "bear", "cart", "peak"]) {
      expect(fuzzyNameAllowance(word)).toBe(0);
    }
  });

  it("gives medium words one edit and long words two", () => {
    expect(fuzzyNameAllowance("green")).toBe(1);
    expect(fuzzyNameAllowance("forest")).toBe(1);
    expect(fuzzyNameAllowance("pinecone")).toBe(2);
    expect(fuzzyNameAllowance("venison")).toBe(1);
    expect(fuzzyNameAllowance("holmestead")).toBe(2);
  });

  it("never lets a long word spend its budget reaching a short one", () => {
    // The allowance is the MINIMUM of both sides. "greens" would otherwise reach "green" and
    // "creek" alike; the short side caps it. Asserted through isFuzzyNameMatch, since that is
    // where the min() lives — editDistanceWithin alone would pass on the length guard.
    // "bartz" is 5 characters and so earns one edit — it reaches "barts", which is the
    // measured and wanted behavior. What it must NOT reach is a 4-letter word, because the
    // short side caps the budget at 0.
    expect(isFuzzyNameMatch("bartz", "barts")).toBe(true);
    expect(isFuzzyNameMatch("bartz", "barn")).toBe(false);
    expect(isFuzzyNameMatch("pinecome", "pinecone")).toBe(true); // both long: 2 edits
  });

  it("holds the pairs a flat allowance collapsed", () => {
    // Every pair below is within 2 edits and belongs to DIFFERENT live stands. A flat
    // allowance of 2 tied them; the length scaling must keep them apart.
    const collisions: [string, string][] = [
      ["barn", "barts"],
      ["barn", "bird"],
      ["barn", "bear"],
      ["ears", "bear"],
      ["cart", "ears"],
      ["peach", "peak"],
      ["tree", "creek"],
    ];
    for (const [a, b] of collisions) {
      expect(isFuzzyNameMatch(a, b)).toBe(false);
    }
  });

  it("still separates the two homestead stands, which are one edit apart", () => {
    // Handpicked Homestead vs Holmestead Farms. Both words are long enough for a 2-edit
    // budget, so this pair CANNOT be separated by distance — it must tie and ask instead.
    // Asserted here so a future widening of the allowance does not silently start guessing.
    expect(isFuzzyNameMatch("homestead", "holmestead")).toBe(true);
  });
});

describe("cold stand-name resolution", () => {
  const stands = [
    { id: "pinecone", name: "Pinecone Gardens" },
    { id: "open-gate", name: "Open Gate Lamb and Grazing" },
    { id: "barts", name: "Bart's Cart" },
  ];

  it("resolves the one public stand the customer named", () => {
    expect(resolveStandName("where is Pinecone Gardens?", stands)).toEqual({
      kind: "match",
      id: "pinecone",
    });
    expect(resolveStandName("does barts have eggs?", stands)).toEqual({
      kind: "match",
      id: "barts",
    });
  });

  it("does not treat an ordinary word as a partial stand name", () => {
    expect(resolveStandName("what stands are open today?", stands)).toEqual({ kind: "none" });
  });

  it("asks when two complete names are present", () => {
    expect(resolveStandName("Pinecone Gardens or Bart's Cart?", stands)).toEqual({
      kind: "ambiguous",
    });
  });
});

describe("editDistanceWithin", () => {
  it("accepts the real misspellings that motivated this", () => {
    // Every one of these was typed at or observed on a handset.
    for (const typo of ["pinecome", "pinecon", "pinecoen", "pinecomb"]) {
      expect(editDistanceWithin(typo, "pinecone", 2)).toBe(true);
    }
  });

  it("refuses a word beyond the budget", () => {
    expect(editDistanceWithin("pinecone", "pinecone", 0)).toBe(true);
    expect(editDistanceWithin("pinecome", "pinecone", 0)).toBe(false);
    expect(editDistanceWithin("pineapple", "pinecone", 2)).toBe(false);
  });

  it("counts insertions, deletions and substitutions alike", () => {
    expect(editDistanceWithin("kale", "kales", 1)).toBe(true); // insertion
    expect(editDistanceWithin("kales", "kale", 1)).toBe(true); // deletion
    expect(editDistanceWithin("kale", "kalo", 1)).toBe(true); // substitution
    expect(editDistanceWithin("kale", "kalos", 1)).toBe(false); // two edits
  });

  it("is symmetric", () => {
    expect(editDistanceWithin("pinecome", "pinecone", 2)).toBe(
      editDistanceWithin("pinecone", "pinecome", 2),
    );
  });

  it("handles the empty string without claiming a match", () => {
    expect(editDistanceWithin("", "pinecone", 2)).toBe(false);
    expect(editDistanceWithin("", "", 0)).toBe(true);
  });
});

/*
  F-111 Phase 2b — the scoring bar.

  The defect: a tier-2 score of 1 counted as identification. "Open Gate Lamb and Grazing"
  contributes the distinctive word `open`, so ANY message containing that common English word
  bound to that farm and was answered as a report about it. `GENERIC_NAME_WORDS` cannot help —
  it strips words common across STAND NAMES, and `open` is common in English, not in the corpus.

  The rule chosen, measured against the real 34-stand corpus in `maps/offerings-proposals.json`
  plus the two live stands the F-106/B-065 cases name (2026-08-13): matched distinctive words
  must be **at least half** of the stand's own distinctive words.

  Three rejected alternatives, each failing on the real corpus rather than in the abstract:
    - "require 2 for a multi-word name" breaks `barts` → Bart's Cart (2 distinctive words).
    - "keep a score of 1 only when the word is unique corpus-wide" fails outright: `open` IS
      unique to one stand, which is the whole bug.
    - adding a minimum word LENGTH to this rule costs nine more real partials at 5 characters
      and breaks `barts` at 6.
*/
describe("distinctive-word scoring bar (F-111 Phase 2b)", () => {
  it("rejects one word out of a four-word name — the `open` defect", () => {
    // Open Gate Lamb and Grazing → [open, gate, lamb, grazing]. One matched word is a
    // coincidence, not a name.
    expect(meetsDistinctiveWordBar(1, 4)).toBe(false);
    expect(meetsDistinctiveWordBar(1, 3)).toBe(false);
  });

  it("accepts a single-word name matched by its one word", () => {
    // Narwhal Farm → [narwhal]; Holmestead Farms → [holmestead]. The word IS the name.
    expect(meetsDistinctiveWordBar(1, 1)).toBe(true);
  });

  it("accepts one word of a two-word name — `barts` must keep resolving", () => {
    // Bart's Cart → [barts, cart]. F-106's case, and the reason a flat "require 2" was
    // rejected. Half of two is one.
    expect(meetsDistinctiveWordBar(1, 2)).toBe(true);
  });

  it("accepts two words of a four-word name and rejects one of five", () => {
    expect(meetsDistinctiveWordBar(2, 4)).toBe(true);
    expect(meetsDistinctiveWordBar(2, 5)).toBe(false);
    expect(meetsDistinctiveWordBar(3, 5)).toBe(true);
  });

  it("never accepts a score of zero, whatever the name's length", () => {
    // A stand that matched nothing is not a candidate at any bar. Guarding here as well as at
    // the call site keeps the rule true standing alone.
    expect(meetsDistinctiveWordBar(0, 1)).toBe(false);
    expect(meetsDistinctiveWordBar(0, 4)).toBe(false);
  });

  it("treats a name with no distinctive words as unmatchable", () => {
    // "The Farm Stand" folds to zero distinctive words. Tier 1 compares whole names and still
    // reaches it; tier 2 must not divide by nothing and call it a match.
    expect(meetsDistinctiveWordBar(0, 0)).toBe(false);
  });
});
