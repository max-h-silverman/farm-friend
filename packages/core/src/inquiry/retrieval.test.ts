import { describe, expect, it } from "vitest";
import {
  MAX_INQUIRY_CANDIDATES,
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
    // Every candidate survives (F-045); recency decides the order.
    expect(ranked.map((c) => c.factId)).toEqual(["a", "c", "b"]);
  });

  it("orders by how many requested items a location covers", () => {
    const ranked = rankCandidates(candidates, {
      ranking: "coverage",
      items: ["kale", "eggs"],
    });
    // Beta covers both; the single-item stands follow. Coverage remains an ORDERING signal
    // over exact name overlap — a cheap hint that costs nothing when it hits and drops
    // nobody when it misses, since the model still sees every candidate.
    expect(ranked[0]!.factId).toBe("b");
    expect(ranked).toHaveLength(3);
  });

  it("breaks a coverage tie by recency, so ordering is total and stable", () => {
    const ranked = rankCandidates(candidates, { ranking: "coverage", items: ["eggs"] });
    // Beta and Gamma both cover eggs, so they lead, fresher first; Alpha covers none and
    // sorts last rather than disappearing.
    expect(ranked.map((c) => c.factId)).toEqual(["c", "b", "a"]);
  });

  it("applies a farm scope when the interpretation carried one", () => {
    // Farm scope stays a CODE filter. A farm name is an identifier the customer supplied
    // and code can compare exactly — unlike an item word, whose meaning is the model's job.
    const ranked = rankCandidates(candidates, {
      ranking: "any",
      items: ["kale"],
      farmScope: "alpha farm",
    });
    expect(ranked.map((c) => c.factId)).toEqual(["a"]);
  });
});

// F-045 — why code no longer filters candidates by item name.
//
// `rankCandidates` used to drop any candidate whose published item names did not EXACTLY
// equal a requested word. That put the only layer capable of understanding "beets are root
// vegetables" downstream of a filter that had already thrown beets away, so category
// questions could never be answered — the defect max hit on a real handset.
//
// Encoding a synonym table here instead would be food taxonomy as policy, which CLAUDE.md
// forbids and which no finite list would satisfy anyway. So code retrieves broadly and the
// model selects; code still validates every returned identifier against the retrieved set,
// so grounding is unchanged.
describe("ranking presents candidates for judgement rather than pre-filtering them (F-045)", () => {
  it("keeps a candidate whose item name never equals the requested word", () => {
    // The production case: "leafy greens" against a stand publishing "butter lettuce".
    // Code cannot see the relationship and must not pretend the answer is no.
    const greens: InquiryCandidate[] = [
      {
        factId: "lettuce",
        farmName: "Alpha Farm",
        locationName: "Alpha Stand",
        matchedItemNames: ["butter lettuce", "baby lettuce mix"],
        asOf: hoursAgo(2),
      },
      {
        factId: "beets",
        farmName: "Beta Farm",
        locationName: "Beta Stand",
        matchedItemNames: ["beets", "carrots"],
        asOf: hoursAgo(5),
      },
    ];

    const ranked = rankCandidates(greens, { ranking: "any", items: ["leafy greens"] });
    // Both survive: neither matches by string, and code is not the layer that decides.
    expect(ranked.map((c) => c.factId).sort()).toEqual(["beets", "lettuce"]);
  });

  it("keeps candidates for a word matching nothing, leaving the empty answer to selection", () => {
    // Code returning [] here would short-circuit to "no current listing" WITHOUT a model
    // call — which is exactly how a category question became a false negative.
    const ranked = rankCandidates(candidates, { ranking: "any", items: ["durian"] });
    expect(ranked.length).toBeGreaterThan(0);
  });

  it("still orders by recency so the cap keeps the most useful candidates", () => {
    const ranked = rankCandidates(candidates, { ranking: "freshest", items: ["anything"] });
    expect(ranked.map((c) => c.factId)).toEqual(["a", "c", "b"]);
  });

  it("bounds the candidate set with a stated cap rather than the corpus size", () => {
    // 34 stands is comfortable for one selection call; the bound must be a decision in
    // code, not an accident of how many farms VIGA happens to have.
    const many: InquiryCandidate[] = Array.from({ length: MAX_INQUIRY_CANDIDATES + 25 }, (_, i) => ({
      factId: `f${i}`,
      farmName: `Farm ${i}`,
      locationName: `Stand ${i}`,
      matchedItemNames: ["produce"],
      asOf: hoursAgo(i),
    }));

    const ranked = rankCandidates(many, { ranking: "freshest", items: ["produce"] });
    expect(ranked).toHaveLength(MAX_INQUIRY_CANDIDATES);
    // Truncation happens AFTER ordering, so the cap drops the least useful, not an
    // arbitrary slice of input order.
    expect(ranked[0]!.factId).toBe("f0");
  });

  it("applies the farm scope before the cap, so a scoped question is never truncated away", () => {
    const many: InquiryCandidate[] = Array.from({ length: MAX_INQUIRY_CANDIDATES + 25 }, (_, i) => ({
      factId: `f${i}`,
      farmName: i === MAX_INQUIRY_CANDIDATES + 20 ? "Rare Farm" : `Farm ${i}`,
      locationName: `Stand ${i}`,
      matchedItemNames: ["produce"],
      asOf: hoursAgo(i),
    }));

    const ranked = rankCandidates(many, {
      ranking: "any",
      items: ["produce"],
      farmScope: "Rare Farm",
    });
    expect(ranked.map((c) => c.factId)).toEqual([`f${MAX_INQUIRY_CANDIDATES + 20}`]);
  });
});
