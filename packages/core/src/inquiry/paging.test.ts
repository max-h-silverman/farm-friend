import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock";
import {
  PAGE_SIZE,
  renderNoPendingList,
  renderResultPage,
  type PageableFact,
} from "./paging";

const NOW = new Date("2026-07-25T12:00:00Z");
const clock = new FixedClock(NOW);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const offering = (n: number, name: string, address: string | null): PageableFact => ({
  factId: `o${n}`,
  farmName: name,
  locationName: name,
  publicAddress: address,
  matchedItems: [{ itemName: "eggs" }],
  asOf: hoursAgo(200),
  basis: "offering",
});

const nine = Array.from({ length: 9 }, (_, i) =>
  offering(i, `Farm Number ${i}`, `${10000 + i} SW 220th St`),
);

// NOTE: the two-segment ceiling that DRIVES page size is asserted in
// packages/sms/src/result-page-segments.test.ts. Segment arithmetic lives in the sms package
// and `core` imports no other package, so the assertion lives where the arithmetic does
// rather than being approximated here with a character count.

describe("case 2 — everything fits, so no paging machinery appears", () => {
  it("offers no MORE and states no count for a result set that fits", () => {
    const page = renderResultPage({
      itemsRequested: ["lamb"],
      facts: nine.slice(0, 3),
      offset: 0,
      total: 3,
      clock,
    });
    expect(page.body).not.toMatch(/MORE/i);
    // A count is noise when the customer can already see everything.
    expect(page.body).not.toMatch(/of 3/);
    expect(page.hasMore).toBe(false);
  });

  it("still lists a single result plainly", () => {
    const page = renderResultPage({
      itemsRequested: ["honey"],
      facts: nine.slice(0, 1),
      offset: 0,
      total: 1,
      clock,
    });
    expect(page.body).toContain("Farm Number 0");
    expect(page.body).not.toMatch(/MORE/i);
  });
});

describe("case 3 — more than fits", () => {
  it("renders the first page, states the total, and offers MORE", () => {
    const page = renderResultPage({
      itemsRequested: ["eggs"],
      facts: nine.slice(0, PAGE_SIZE),
      offset: 0,
      total: 9,
      clock,
    });
    expect(page.body).toMatch(/1-3 of 9/);
    expect(page.body).toMatch(/reply MORE/i);
    expect(page.hasMore).toBe(true);
  });

  it("puts the name and the address on separate lines", () => {
    // The parsing complaint: parenthesized addresses wrapped mid-entry, so a name and its
    // address split across visual lines. Separate lines cannot split that way.
    const page = renderResultPage({
      itemsRequested: ["eggs"],
      facts: nine.slice(0, 1),
      offset: 0,
      total: 1,
      clock,
    });
    expect(page.body).toContain("Farm Number 0\n10000 SW 220th St");
    expect(page.body).not.toMatch(/Farm Number 0 \(/);
  });

  it("numbers a later page from its true offset", () => {
    const page = renderResultPage({
      itemsRequested: ["eggs"],
      facts: nine.slice(3, 6),
      offset: 3,
      total: 9,
      clock,
    });
    expect(page.body).toMatch(/4-6 of 9/);
  });
});

describe("case 5 — the last page closes, rather than offering more", () => {
  it("offers the map instead of another MORE", () => {
    const page = renderResultPage({
      itemsRequested: ["eggs"],
      facts: nine.slice(6, 9),
      offset: 6,
      total: 9,
      clock,
    });
    expect(page.hasMore).toBe(false);
    expect(page.body).not.toMatch(/reply MORE/i);
    // Somewhere to go next, rather than a dead end.
    expect(page.body).toMatch(/map/i);
  });
});

describe("case 4 — confirmed stock is never paged away", () => {
  it("keeps confirmed facts on the first page ahead of offerings", () => {
    const confirmed: PageableFact = {
      factId: "c1",
      farmName: "Provo Farms",
      locationName: "Provo Farms",
      publicAddress: "10142 Vashon Hwy",
      matchedItems: [{ itemName: "lamb" }],
      asOf: hoursAgo(26),
      basis: "confirmed",
    };
    const page = renderResultPage({
      itemsRequested: ["lamb"],
      facts: [confirmed, nine[0]!, nine[1]!],
      offset: 0,
      total: 9,
      clock,
    });
    expect(page.body.indexOf("Provo Farms")).toBeLessThan(page.body.indexOf("Farm Number 0"));
    // Confirmed carries its recency; the honor-system rule forbids claiming more.
    expect(page.body).toMatch(/1 day ago/);
    expect(page.body).not.toMatch(/right now|currently has|guaranteed/i);
  });
});

describe("the (null) address bug shipped by F-045", () => {
  it("never prints the literal word null for a missing address", () => {
    const page = renderResultPage({
      itemsRequested: ["lamb"],
      facts: [offering(1, "Open Gate Lamb and Grazing", null)],
      offset: 0,
      total: 1,
      clock,
    });
    expect(page.body).not.toMatch(/\bnull\b/);
    expect(page.body).toMatch(/address not listed/i);
  });

  it("still lists a stand that has no address, because it is a real answer", () => {
    const page = renderResultPage({
      itemsRequested: ["lamb"],
      facts: [offering(1, "Open Gate Lamb and Grazing", null)],
      offset: 0,
      total: 1,
      clock,
    });
    expect(page.body).toContain("Open Gate Lamb and Grazing");
  });

  it("treats a blank or whitespace address the same as a missing one", () => {
    for (const blank of ["", "   "]) {
      const page = renderResultPage({
        itemsRequested: ["lamb"],
        facts: [offering(1, "Blank Address Farm", blank)],
        offset: 0,
        total: 1,
        clock,
      });
      expect(page.body, JSON.stringify(blank)).toMatch(/address not listed/i);
    }
  });
});

describe("case 6 — MORE with nothing pending", () => {
  it("answers honestly rather than failing silently", () => {
    const body = renderNoPendingList();
    expect(body.length).toBeGreaterThan(0);
    // Tells them what to do next instead of just saying no.
    expect(body).toMatch(/looking for|what/i);
  });

});
