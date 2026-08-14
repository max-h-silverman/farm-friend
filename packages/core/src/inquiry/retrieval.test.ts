import { describe, expect, it } from "vitest";
import { rankCandidates, type InquiryCandidate } from "./retrieval";

const NOW = new Date("2026-07-25T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

describe("catalog-match ordering", () => {
  it("orders every matching stand by freshest evidence", () => {
    const candidates: InquiryCandidate[] = Array.from({ length: 85 }, (_, index) => ({
      factId: `fact-${index}`,
      locationName: `Stand ${index}`,
      asOf: hoursAgo(84 - index),
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
      },
      {
        factId: "fact-c",
        locationName: "A Stand",
        asOf: sameTime,
      },
      {
        factId: "fact-a",
        locationName: "A Stand",
        asOf: sameTime,
      },
    ];

    const ranked = rankCandidates(candidates);

    expect(ranked.map((candidate) => candidate.factId)).toEqual([
      "fact-a",
      "fact-c",
      "fact-b",
    ]);
  });
});
