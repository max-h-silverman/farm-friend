import { describe, expect, it } from "vitest";
import { FixedClock, PAGE_SIZE, renderResultPage, renderNoPendingList } from "@farm-friend/core";
import { estimateSmsSegments } from "./segments";

// F-046 — the constraint that DRIVES the page size, asserted where segment arithmetic lives.
//
// `core` renders the page and imports no other package, so it cannot measure segments itself.
// This is the other half: the sms package owns the billing arithmetic and can check that
// core's page size actually respects it. If PAGE_SIZE grows, this is what fails.
//
// The numbers come from the real production corpus, measured 2026-07-31: stand name plus
// address runs 22-57 characters, median 35. The 57-character worst case is the one that
// decides the ceiling, so it is what these fixtures use.

const NOW = new Date("2026-07-25T12:00:00Z");
const clock = new FixedClock(NOW);

/** The longest name + address in the real corpus. */
const longest = {
  factId: "worst",
  farmName: "Fruits des Vignes Farm",
  locationName: "Fruits des Vignes Farm",
  publicAddress: "20430 111th Ave SW Vashon WA 98070",
  matchedItems: [{ itemName: "leafy greens" }],
  asOf: new Date(NOW.getTime() - 200 * 3_600_000),
  basis: "offering" as const,
};

/**
 * `n` DISTINCT worst-case stands.
 *
 * Distinct matters: entries merge by stand, so repeating one fact would measure a single
 * entry while claiming to measure a full page — the cheapest possible message dressed as the
 * most expensive. Each name is padded to the corpus's longest so the cost is not understated.
 */
const worstCaseStands = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ...longest,
    factId: `worst-${i}`,
    locationName: `${longest.locationName} ${i}`,
    farmName: `${longest.farmName} ${i}`,
  }));

describe("a rendered page stays inside the two-segment ceiling (F-046)", () => {
  it("holds for a full page of the corpus's longest entries", () => {
    // The shipped F-045 format sent 488 characters / 4 segments for 9 stands. The entire
    // point of paging is that a reply costs two segments, not four. If this fails, PAGE_SIZE
    // is too large — do not relax the assertion.
    const page = renderResultPage({
      itemsRequested: ["leafy greens"],
      facts: worstCaseStands(PAGE_SIZE),
      offset: 0,
      total: 20,
      clock,
    });
    const estimate = estimateSmsSegments(page.body);
    expect(estimate.segmentCount).toBeLessThanOrEqual(2);
  });

  it("holds for the last page, which swaps the MORE offer for the map link", () => {
    // The closing page carries a URL, which is the longest single line in any reply. It must
    // not be the thing that pushes a page past the ceiling.
    //
    // THREE stands from the REAL corpus, not one fact repeated. The fixture used to pass the
    // same stand three times, which merges into ONE entry — so it measured the cheapest
    // possible message while claiming to measure a full page. Real names and addresses are
    // what the ceiling has to hold for; padded ones overstate it by a few characters and
    // would force the limit up for a message no customer receives.
    const page = renderResultPage({
      itemsRequested: ["leafy greens"],
      facts: [
        ["Fruits des Vignes Farm", "20430 111th Ave SW"],
        ["Ostara Farm & Flowers", "13632 SW 220th St"],
        ["Plum Forest Farm", "20020 107th Ave SW"],
      ].map(([name, address], i) => ({
        ...longest,
        factId: `real-${i}`,
        farmName: name!,
        locationName: name!,
        publicAddress: address!,
      })),
      offset: 17,
      total: 20,
      clock,
    });
    expect(page.hasMore).toBe(false);
    expect(estimateSmsSegments(page.body).segmentCount).toBeLessThanOrEqual(2);
  });

  it("stays within three segments even for padded worst-case names", () => {
    // The synthetic ceiling: names longer than anything in the corpus, on the closing page
    // that also carries the map URL. Measured at 313 characters / 3 segments — over the
    // 2-segment budget a real page keeps, and under the 3 max accepted for F-107's format.
    const page = renderResultPage({
      itemsRequested: ["leafy greens"],
      facts: worstCaseStands(PAGE_SIZE),
      offset: 17,
      total: 20,
      clock,
    });
    expect(estimateSmsSegments(page.body).segmentCount).toBeLessThanOrEqual(3);
  });

  /*
    F-107 — the fixtures above are all OFFERING-only stands, which render the SHORTEST possible
    entry: a name, one MAY HAVE line, an address. They passed this ceiling before the format
    changed and would have passed it after, while measuring none of the new cost.

    The real worst case is a stand carrying BOTH claims: an IN STOCK line with its elapsed
    phrase and staleness suffix, plus a MAY ALSO HAVE line. That is the ordinary shape against
    the production corpus — 33 of 37 stands carry a usual offering their published inventory
    does not — so it is what the ceiling has to hold for.
  */
  const bothClaims = [
    { ...longest, factId: "worst-confirmed", basis: "confirmed" as const,
      // Stale, which on this surface means only a larger elapsed phrase (F-107).
      asOf: new Date(NOW.getTime() - 72 * 3_600_000),
      matchedItems: [{ itemName: "leafy greens" }, { itemName: "butter lettuce" }] },
    { ...longest, factId: "worst-offering" },
  ];

  it("holds for a full page of stands carrying BOTH claim lines", () => {
    // Three segments, not two: F-107's two claim lines per stand cost more than the flat list
    // the old ceiling was set against, and the extra information is the point of the format.
    // Addresses were dropped to buy this back — see the renderer.
    const page = renderResultPage({
      itemsRequested: ["leafy greens"],
      // PAGE_SIZE distinct stands, each with a confirmed and an offering fact that merge into
      // one two-line entry.
      facts: Array.from({ length: PAGE_SIZE }, (_, i) =>
        bothClaims.map((fact) => ({
          ...fact,
          factId: `${fact.factId}-${i}`,
          locationName: `${fact.locationName} ${i}`,
          farmName: `${fact.farmName} ${i}`,
        })),
      ).flat(),
      offset: 0,
      total: 20,
      clock,
    });
    expect(estimateSmsSegments(page.body).segmentCount).toBeLessThanOrEqual(3);
  });

  it("spends no segment budget on the city, state, and ZIP", () => {
    // Addresses STAY — a stand nobody can find is not an answer (max, 2026-08-11). What goes
    // is the ", Vashon, WA 98070" tail, which is ~16 characters of nothing per stand on an
    // island where every address shares it.
    const page = renderResultPage({
      itemsRequested: ["leafy greens"],
      facts: worstCaseStands(PAGE_SIZE),
      offset: 0,
      total: 20,
      clock,
    });
    expect(page.body).toContain("20430 111th Ave SW");
    expect(page.body).not.toMatch(/98070|\bWA\b/);
  });

  it("holds with the longest header a real query can produce", () => {
    // The header now names the query back to the customer, so it grows with the request. A
    // multi-item question over a large corpus is its worst case, and it lands on the same
    // page as three both-claim stands — the two most expensive things in one message.
    const page = renderResultPage({
      itemsRequested: ["leafy greens", "winter squash"],
      facts: Array.from({ length: PAGE_SIZE }, (_, i) =>
        bothClaims.map((fact) => ({
          ...fact,
          factId: `${fact.factId}-${i}`,
          locationName: `${fact.locationName} ${i}`,
          farmName: `${fact.farmName} ${i}`,
        })),
      ).flat(),
      offset: 0,
      total: 45,
      clock,
    });
    expect(page.body).toContain("Leafy greens + winter squash: 45 matching stands");
    expect(estimateSmsSegments(page.body).segmentCount).toBeLessThanOrEqual(3);
  });

  it("holds when every stand on the page is stale (B-063)", () => {
    /*
      The worst case B-063's fix creates, and the one the previous attempt at this failed on.

      F-107 removed the "- may be out of date" suffix precisely because twenty characters per
      entry pushed an all-stale page over the ceiling. Changing the LABEL instead costs one
      character per entry ("Last seen" against "In stock"), because it replaces rather than
      appends — so the page that used to break the budget now sits inside it.

      Measured 2026-08-11: 416 characters on the first page, 438 on the closing page that also
      carries the map URL. Three segments, which is the ceiling max accepted for this format.
    */
    const stale = [
      ["Fruits des Vignes Farm", "20430 111th Ave SW"],
      ["Ostara Farm & Flowers", "13632 SW 220th St"],
      ["Plum Forest Farm", "20020 107th Ave SW"],
    ].flatMap(([name, address], i) => [
      {
        ...longest,
        factId: `stale-${i}`,
        farmName: name!,
        locationName: name!,
        publicAddress: address!,
        basis: "confirmed" as const,
        asOf: new Date(NOW.getTime() - 16 * 24 * 3_600_000),
        matchedItems: [{ itemName: "leafy greens" }, { itemName: "winter squash" }],
      },
      {
        ...longest,
        factId: `stale-offering-${i}`,
        farmName: name!,
        locationName: name!,
        publicAddress: address!,
        matchedItems: [{ itemName: "kale" }],
      },
    ]);

    for (const [offset, total] of [
      [0, 20],
      [17, 20],
    ]) {
      const page = renderResultPage({
        itemsRequested: ["leafy greens", "winter squash"],
        facts: stale,
        offset: offset!,
        total: total!,
        clock,
      });
      expect(page.body).toContain("Last seen (16d ago)");
      expect(page.body).not.toMatch(/In stock/);
      expect(
        estimateSmsSegments(page.body).segmentCount,
        `offset ${offset}`,
      ).toBeLessThanOrEqual(3);
    }
  });

  it("keeps the no-pending-list reply to a single segment", () => {
    expect(estimateSmsSegments(renderNoPendingList()).segmentCount).toBe(1);
  });

  it("renders as GSM-7, so a page is not silently billed at the unicode rate", () => {
    // A curly apostrophe in a farm name would flip the whole message to UCS-2 and cut the
    // per-segment budget from 153 to 67 characters. Farm names come from the corpus, so this
    // asserts the RENDERER adds no unicode of its own.
    const page = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [longest],
      offset: 0,
      total: 9,
      clock,
    });
    expect(estimateSmsSegments(page.body).encoding).toBe("GSM-7");
  });
});
