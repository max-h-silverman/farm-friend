import { describe, expect, it } from "vitest";
import { rankCandidates, type InquiryCandidate } from "./retrieval";

const NOW = new Date("2026-07-25T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

/*
  F-120 — HOW MANY OF THE REQUESTED THINGS A STAND HAS COMES FIRST.

  Measured live on 2026-08-18. "any stands have kale and eggs?" returned 13 stands led by:

      Bananas Barn         In stock (1d ago): Eggs ($8 / dozen)
      Littlest Bird Farm   In stock (1d ago): kale, eggs

  Littlest Bird carries BOTH and placed second, behind a stand carrying one — purely because its
  evidence was a few hours fresher inside the same day. The customer asked for a stand where they
  can get both, and the answer to that question was the second entry.

  Every fixture below puts the higher-match-count stand at the OLDER timestamp. That is what makes
  these tests falsifiable: if the match-count key were dropped, freshness would order them the
  other way and the assertion would fail rather than passing by coincidence.
*/
describe("catalog-match ordering", () => {
  it("orders every matching stand by freshest evidence", () => {
    const candidates: InquiryCandidate[] = Array.from({ length: 85 }, (_, index) => ({
      factId: `fact-${index}`,
      locationName: `Stand ${index}`,
      asOf: hoursAgo(84 - index),
      matchCount: 1,
    }));

    const ranked = rankCandidates(candidates);

    expect(ranked).toHaveLength(85);
    expect(ranked[0]!.factId).toBe("fact-84");
    expect(ranked[84]!.factId).toBe("fact-0");
  });

  it("uses location and fact identifiers to break equal-time ties deterministically", () => {
    const sameTime = hoursAgo(1);
    const candidates: InquiryCandidate[] = [
      {
        factId: "fact-b",
        locationName: "Z Stand",
        asOf: sameTime,
        matchCount: 1,
      },
      {
        factId: "fact-c",
        locationName: "A Stand",
        asOf: sameTime,
        matchCount: 1,
      },
      {
        factId: "fact-a",
        locationName: "A Stand",
        asOf: sameTime,
        matchCount: 1,
      },
    ];

    const ranked = rankCandidates(candidates);

    expect(ranked.map((candidate) => candidate.factId)).toEqual([
      "fact-a",
      "fact-c",
      "fact-b",
    ]);
  });

  it("ranks a stand supporting both requested names above one supporting only one", () => {
    const ranked = rankCandidates([
      // FRESHER, but carries one of the two asked for.
      { factId: "bananas", locationName: "Bananas Barn", asOf: hoursAgo(25), matchCount: 1 },
      // OLDER, and carries both.
      { factId: "littlest", locationName: "Littlest Bird Farm", asOf: hoursAgo(40), matchCount: 2 },
    ]);

    expect(ranked.map((c) => c.factId)).toEqual(["littlest", "bananas"]);
  });

  it("still orders by freshness within an equal match count", () => {
    const ranked = rankCandidates([
      { factId: "older-both", locationName: "A Stand", asOf: hoursAgo(40), matchCount: 2 },
      { factId: "fresher-both", locationName: "Z Stand", asOf: hoursAgo(10), matchCount: 2 },
      { factId: "fresher-one", locationName: "B Stand", asOf: hoursAgo(1), matchCount: 1 },
    ]);

    // Both two-match stands lead, freshest first; the freshest stand overall comes last because
    // it answers less of the question.
    expect(ranked.map((c) => c.factId)).toEqual(["fresher-both", "older-both", "fresher-one"]);
  });

  it("keeps location and fact id as the last tie-breakers within a match count", () => {
    const sameTime = hoursAgo(1);
    const ranked = rankCandidates([
      { factId: "fact-b", locationName: "Z Stand", asOf: sameTime, matchCount: 2 },
      { factId: "fact-c", locationName: "A Stand", asOf: sameTime, matchCount: 2 },
      { factId: "fact-a", locationName: "A Stand", asOf: sameTime, matchCount: 2 },
    ]);

    expect(ranked.map((c) => c.factId)).toEqual(["fact-a", "fact-c", "fact-b"]);
  });

  /*
    A SINGLE-ITEM REQUEST IS ORDERED EXACTLY AS IT IS TODAY. Every stand matches the one name, so
    the new key is constant and freshness leads — the same output as before the change.
  */
  it("leaves a single-item request ordered by freshness alone", () => {
    const ranked = rankCandidates(
      Array.from({ length: 5 }, (_, index) => ({
        factId: `fact-${index}`,
        locationName: `Stand ${index}`,
        asOf: hoursAgo(5 - index),
        matchCount: 1,
      })),
    );

    expect(ranked.map((c) => c.factId)).toEqual([
      "fact-4",
      "fact-3",
      "fact-2",
      "fact-1",
      "fact-0",
    ]);
  });

  /*
    A BROAD REQUEST MUST NOT BECOME A "CARRIES THE MOST ITEMS" LEADERBOARD.

    `operation: "broad"` selects the WHOLE catalog rather than anything the customer named, so a
    match count there measures how big a stand's listing is — not how well it answers a question
    nobody asked in item terms. The caller passes a constant count for broad requests, and this
    pins the consequence: identical counts collapse the new key and freshness leads, exactly as
    a broad answer is ordered today.
  */
  it("orders a broad request by freshness, not by listing size", () => {
    const ranked = rankCandidates([
      { factId: "big-old", locationName: "Big Old Farm", asOf: hoursAgo(40), matchCount: 1 },
      { factId: "small-fresh", locationName: "Small Fresh Farm", asOf: hoursAgo(2), matchCount: 1 },
    ]);

    expect(ranked.map((c) => c.factId)).toEqual(["small-fresh", "big-old"]);
  });
});
