import { describe, expect, it } from "vitest";
import {
  rankCandidates,
  validateInterpretedIntent,
  type InquiryCandidate,
} from "./retrieval";

const NOW = new Date("2026-07-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// Deliberately generic fixtures: the ranking layer must not know what a "vegetable" is.
const candidates: InquiryCandidate[] = [
  {
    factId: "a",
    farmName: "Alpha Farm",
    locationName: "Alpha Stand",
    matchedItemNames: ["kale"],
    asOf: hoursAgo(1),
  },
  {
    factId: "b",
    farmName: "Beta Farm",
    locationName: "Beta Stand",
    matchedItemNames: ["kale", "eggs"],
    asOf: hoursAgo(10),
  },
  {
    factId: "c",
    farmName: "Gamma Farm",
    locationName: "Gamma Stand",
    matchedItemNames: ["eggs"],
    asOf: hoursAgo(3),
  },
];

describe("interpreted-intent validation — an open interpretation code can execute", () => {
  it("accepts an intent naming items and an optional farm scope", () => {
    const result = validateInterpretedIntent({
      kind: "lookup",
      items: ["kale"],
      farmScope: "Alpha Farm",
      ranking: "freshest",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts each supported ranking interpretation", () => {
    for (const ranking of ["freshest", "coverage", "any"]) {
      const result = validateInterpretedIntent({ kind: "lookup", items: ["kale"], ranking });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects a ranking the retrieval layer cannot execute", () => {
    // Ranking intent is an interpretation code VALIDATES and EXECUTES. An interpretation
    // naming an operation code cannot perform is refused rather than silently ignored.
    const result = validateInterpretedIntent({
      kind: "lookup",
      items: ["kale"],
      ranking: "cheapest-by-driving-time",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts an explicit ambiguity signal", () => {
    const result = validateInterpretedIntent({
      kind: "ambiguous",
      question: "Which farm did you mean?",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an intent carrying a deliverable factual claim", () => {
    const result = validateInterpretedIntent({
      kind: "lookup",
      items: ["kale"],
      ranking: "any",
      answerText: "Alpha has kale",
    });
    expect(result.ok).toBe(false);
  });

  it("requires at least one item to look up", () => {
    expect(validateInterpretedIntent({ kind: "lookup", items: [], ranking: "any" }).ok).toBe(
      false,
    );
  });
});

describe("ranking — a general mechanism, with no food or farm vocabulary", () => {
  it("orders by recency for a freshest interpretation", () => {
    const ranked = rankCandidates(candidates, { ranking: "freshest", items: ["kale"] });
    expect(ranked.map((c) => c.factId)).toEqual(["a", "b"]);
  });

  it("orders by how many requested items a location covers", () => {
    const ranked = rankCandidates(candidates, {
      ranking: "coverage",
      items: ["kale", "eggs"],
    });
    // Beta covers both; the single-item stands follow.
    expect(ranked[0]!.factId).toBe("b");
    expect(ranked).toHaveLength(3);
  });

  it("breaks a coverage tie by recency, so ordering is total and stable", () => {
    const ranked = rankCandidates(candidates, { ranking: "coverage", items: ["eggs"] });
    // Beta and Gamma both cover eggs; Gamma is fresher.
    expect(ranked.map((c) => c.factId)).toEqual(["c", "b"]);
  });

  it("returns only locations matching a requested item", () => {
    const ranked = rankCandidates(candidates, { ranking: "any", items: ["eggs"] });
    expect(ranked.map((c) => c.factId).sort()).toEqual(["b", "c"]);
  });

  it("matches items case-insensitively without encoding a taxonomy", () => {
    const ranked = rankCandidates(candidates, { ranking: "any", items: ["KALE"] });
    expect(ranked.map((c) => c.factId).sort()).toEqual(["a", "b"]);
  });

  it("returns an empty set when nothing matches, rather than a nearest guess", () => {
    const ranked = rankCandidates(candidates, { ranking: "any", items: ["durian"] });
    expect(ranked).toEqual([]);
  });

  it("applies a farm scope when the interpretation carried one", () => {
    const ranked = rankCandidates(candidates, {
      ranking: "any",
      items: ["kale"],
      farmScope: "alpha farm",
    });
    expect(ranked.map((c) => c.factId)).toEqual(["a"]);
  });
});
