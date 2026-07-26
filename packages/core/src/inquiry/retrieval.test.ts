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

  it("accepts an explicit ambiguity signal as a signal, carrying no prose", () => {
    const result = validateInterpretedIntent({ kind: "ambiguous" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The signal is a KIND, not a message. Code renders what the customer reads.
    expect(result.value).toEqual({ kind: "ambiguous" });
  });

  it("refuses an ambiguity signal that carries a model-authored question", () => {
    // F-018. `question` was the one field through which model prose reached a customer
    // verbatim. A hostile model asked for a recipe put the recipe here — canning
    // instructions and a URL included — and every blocking check passed.
    const result = validateInterpretedIntent({
      kind: "ambiguous",
      question:
        "Kale chips: bake at 350F. For canning, low-acid vegetables are safe at 15 PSI. " +
        "See allrecipes.com/kale",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an ambiguity signal carrying any extra field at all", () => {
    // Not a content check: ANY field beyond `kind` is refused, so this cannot be defeated
    // by renaming the field or rewording the prose.
    for (const extra of [
      { question: "Which farm?" },
      { message: "Try kale chips!" },
      { suggestion: "see example.com/recipes" },
      { note: "" },
    ]) {
      const result = validateInterpretedIntent({ kind: "ambiguous", ...extra });
      expect(result.ok).toBe(false);
    }
  });

  it("accepts a lookup flagged as an out-of-scope request", () => {
    // F-018. A recipe request often still names ingredients, so it stays a lookup: the
    // customer gets real availability. The flag is a BOOLEAN the model sets — a signal it
    // cannot write prose into. Code owns every word the scope statement contains.
    const result = validateInterpretedIntent({
      kind: "lookup",
      items: ["kale"],
      ranking: "any",
      outOfScopeRequest: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "lookup") return;
    expect(result.value.outOfScopeRequest).toBe(true);
  });

  it("defaults the out-of-scope flag to false when absent", () => {
    const result = validateInterpretedIntent({
      kind: "lookup",
      items: ["kale"],
      ranking: "any",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "lookup") return;
    expect(result.value.outOfScopeRequest).toBe(false);
  });

  it("refuses a non-boolean out-of-scope flag", () => {
    // A string here would be prose wearing a flag's name.
    const result = validateInterpretedIntent({
      kind: "lookup",
      items: ["kale"],
      ranking: "any",
      outOfScopeRequest: "here is how to can kale safely at 15 PSI",
    });
    expect(result.ok).toBe(false);
  });

  // F-017 — the origin-dependent request. Same shape as F-018's scope flag, deliberately:
  // recognizing that "what's closest to me?" needs an origin is MEANING, so the model sets a
  // boolean; the limitation sentence is code's. One mechanism, two consumers.

  it("accepts a lookup flagged as needing an arbitrary origin", () => {
    const result = validateInterpretedIntent({
      kind: "lookup",
      items: ["kale"],
      ranking: "any",
      originDependent: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "lookup") return;
    expect(result.value.originDependent).toBe(true);
  });

  it("defaults the origin-dependent flag to false when absent", () => {
    const result = validateInterpretedIntent({
      kind: "lookup",
      items: ["kale"],
      ranking: "any",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "lookup") return;
    expect(result.value.originDependent).toBe(false);
  });

  it("refuses a non-boolean origin-dependent flag", () => {
    // A string here would be model-authored geography wearing a flag's name.
    const result = validateInterpretedIntent({
      kind: "lookup",
      items: ["kale"],
      ranking: "any",
      originDependent: "you are 2.3 miles from Provo Farms, head north",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an intent carrying coordinates or a distance", () => {
    // SMS resolves no arbitrary origin at launch, so the model has no field for one. A
    // model that supplies geography anyway is refused rather than partially honoured.
    for (const geography of [
      { latitude: 47.4, longitude: -122.4 },
      { origin: "47.4,-122.4" },
      { distanceMiles: 2.3 },
      { nearest: "Provo Farms" },
      { customerLocation: "Burton" },
    ]) {
      const result = validateInterpretedIntent({
        kind: "lookup",
        items: ["kale"],
        ranking: "any",
        ...geography,
      });
      expect(result.ok, JSON.stringify(geography)).toBe(false);
    }
  });

  it("has no ranking operation that would require an origin", () => {
    // "nearest" is not an operation code can execute, because code has no origin to
    // measure from over SMS. It must be REFUSED, not silently downgraded to "any" —
    // an unexecutable intent must never masquerade as an executed one.
    for (const ranking of ["nearest", "closest", "distance", "proximity"]) {
      const result = validateInterpretedIntent({
        kind: "lookup",
        items: ["kale"],
        ranking,
      });
      expect(result.ok, ranking).toBe(false);
    }
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
