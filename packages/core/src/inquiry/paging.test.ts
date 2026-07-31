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

// The grounding assertions that used to live against `renderGroundedAnswer` in
// answer.test.ts. F-046 part 3 left ONE renderer for SMS answers, so they belong here — the
// claims are unchanged, and dropping them with the old function would have quietly retired
// the honor-system rules they encode.
describe("grounded rendering — every value comes from typed facts", () => {
  const confirmed = (
    id: string,
    name: string,
    address: string,
    items: PageableFact["matchedItems"],
    ageHours: number,
  ): PageableFact => ({
    factId: id,
    locationName: name,
    farmName: name,
    publicAddress: address,
    matchedItems: items,
    asOf: hoursAgo(ageHours),
    basis: "confirmed",
  });

  const provo = confirmed(
    "f1",
    "Provo Stand",
    "11 Stand Way",
    [
      { itemName: "Kale", quantity: 6, unit: "bunches" },
      { itemName: "Eggs", approximation: "limited", priceText: "$6" },
    ],
    2,
  );
  const harbor = confirmed("f2", "Harbor Stand", "9 Dock Rd", [{ itemName: "Kale" }], 72);

  it("renders items and recency from typed values", () => {
    const page = renderResultPage({
      itemsRequested: ["Kale"],
      facts: [provo],
      offset: 0,
      total: 1,
      clock,
    });
    expect(page.body).toContain("Provo Stand");
    expect(page.body).toContain("Kale (6 bunches)");
    expect(page.body).toContain("Eggs (limited, $6)");
    expect(page.body).toContain("updated 2 hours ago");
  });

  it("carries a prominent staleness warning rather than hiding an old listing", () => {
    const page = renderResultPage({
      itemsRequested: ["Kale"],
      facts: [harbor],
      offset: 0,
      total: 1,
      clock,
    });
    expect(page.body).toContain("Harbor Stand");
    expect(page.body).toContain("updated 3 days ago");
    expect(page.body).toContain("may be out of date");
  });

  it("preserves the order it is given, since ranking is the model's interpretation", () => {
    const page = renderResultPage({
      itemsRequested: ["Kale"],
      facts: [harbor, provo],
      offset: 0,
      total: 2,
      clock,
    });
    expect(page.body.indexOf("Harbor Stand")).toBeLessThan(
      page.body.indexOf("Provo Stand"),
    );
  });
});

// F-045. Production holds zero inventory revisions, so every SMS question answered "no stand
// has a current listing" while the map showed 212 offering tags. An answer can carry TWO
// kinds of claim, and they must never be confusable: one is a farmer's confirmation, the
// other a standing description of what a stand typically stocks.
describe("two voices — confirmed stock and typical offerings (F-045)", () => {
  const lamb: PageableFact[] = [
    {
      factId: "confirmed-1",
      locationName: "Provo Stand",
      farmName: "Provo Farms",
      publicAddress: "10142 Vashon Hwy",
      matchedItems: [{ itemName: "lamb" }],
      asOf: hoursAgo(26),
      basis: "confirmed",
    },
    {
      factId: "offering-1",
      locationName: "Alpha Stand",
      farmName: "Alpha Farm",
      publicAddress: "240 SW 190th St",
      matchedItems: [{ itemName: "lamb" }],
      asOf: hoursAgo(26),
      basis: "offering",
    },
    {
      factId: "offering-2",
      locationName: "Beta Stand",
      farmName: "Beta Farm",
      publicAddress: "12 Beta Rd",
      matchedItems: [{ itemName: "frozen lamb" }],
      asOf: hoursAgo(900),
      basis: "offering",
    },
  ];

  const pageOf = (facts: PageableFact[]) =>
    renderResultPage({
      itemsRequested: ["lamb"],
      facts,
      offset: 0,
      total: facts.length,
      clock,
    }).body;

  it("leads with confirmed stock and lists offerings under a separate label", () => {
    const body = pageOf(lamb);
    expect(body.indexOf("Provo")).toBeLessThan(body.indexOf("Alpha"));
    // The second voice is introduced, not silently concatenated: a customer must be able to
    // see where confirmation stops and description begins.
    expect(body).toMatch(/also list|typical offering/i);
  });

  it("carries the address for both voices", () => {
    const body = pageOf([lamb[0]!, lamb[1]!]);
    expect(body).toContain("10142 Vashon Hwy");
    expect(body).toContain("240 SW 190th St");
  });

  it("gives confirmed stock a recency phrase and never claims present certainty", () => {
    const body = pageOf([lamb[0]!]);
    expect(body).toContain("1 day ago");
    // The honor-system rule: showing WHEN a farmer confirmed is precisely how we avoid
    // asserting what is on the table now. "right now"/"currently has" would be that claim.
    expect(body).not.toMatch(/right now|currently has|in stock now|guaranteed/i);
  });

  it("gives an offering NO timestamp, because nobody confirmed anything", () => {
    // An offering is a standing description. Attaching an elapsed phrase would manufacture a
    // confirmation that never happened — the dishonesty F-042's two map line styles avoid.
    const body = pageOf([lamb[1]!, lamb[2]!]);
    // Scoped to the STAND lines. The lead-in may say nobody confirmed anything — that
    // sentence IS the honesty. What must never appear is an elapsed phrase on a stand line.
    const standLines = body
      .split("\n")
      .filter((line: string) => /Alpha Stand|Beta Stand/.test(line));
    expect(standLines).toHaveLength(2);
    for (const line of standLines) {
      expect(line).not.toMatch(/ago|updated|confirmed/i);
    }
  });

  it("does not attach the stale warning to an offering", () => {
    // 900 hours old by asOf, well past STALE_AFTER_HOURS. Staleness is a property of a
    // CONFIRMATION going cold; an offering was never fresh, so the warning would imply a
    // confirmation existed.
    expect(pageOf([lamb[2]!])).not.toContain("may be out of date");
  });

  it("renders offerings alone when nothing is confirmed, without a confirmed section", () => {
    // The real production case behind max's screenshot: 212 tags, 0 revisions.
    const body = pageOf([lamb[1]!, lamb[2]!]);
    expect(body).toContain("Alpha Stand");
    expect(body).toContain("Beta Stand");
    expect(body).not.toMatch(/^Confirmed /im);
  });
});
