import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock";
import {
  factsPerPage,
  groupFactsByStand,
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
    // F-107 puts the stand's claim lines between its name and its address; what matters is
    // that name and address never share a line and so cannot wrap into each other.
    expect(page.body).toMatch(/^Farm Number 0$/m);
    expect(page.body).toMatch(/^10000 SW 220th St$/m);
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
    expect(page.body).toMatch(/1d ago/);
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
    expect(page.body).toContain("2h ago");
  });

  it("shows an old listing with its age rather than hiding it", () => {
    const page = renderResultPage({
      itemsRequested: ["Kale"],
      facts: [harbor],
      offset: 0,
      total: 1,
      clock,
    });
    expect(page.body).toContain("Harbor Stand");
    // F-107 — the age IS the warning on this surface (max, 2026-08-11); the explicit phrase
    // moved to the public map, which pays nothing per character. The commitment this test
    // exists for is unchanged and still asserted: an old listing is SHOWN, never hidden, and
    // it is stamped so a customer can judge it.
    expect(page.body).toContain("3d ago");
    expect(page.body).not.toMatch(/may be out of date/i);
  });

  it("preserves the order it is given, since ranking is the model's interpretation", () => {
    // WITHIN a tier. The renderer has always imposed its own tiers on top of the model's
    // order — F-107 put every confirmed stand above every offering-only one, and B-063 split
    // the confirmed group by freshness — because those are honesty rules rather than
    // relevance judgements. What stays the model's to decide is the order among stands the
    // renderer considers equally current, which is what this asserts: two fresh
    // confirmations, handed over in a deliberate order, come out in it.
    const second = confirmed("f3", "Second Stand", "3 Second St", [{ itemName: "Kale" }], 4);
    const page = renderResultPage({
      itemsRequested: ["Kale"],
      facts: [second, provo],
      offset: 0,
      total: 2,
      clock,
    });
    expect(page.body.indexOf("Second Stand")).toBeLessThan(
      page.body.indexOf("Provo Stand"),
    );
  });

  it("demotes a stale confirmation below a fresh one whatever order it is given", () => {
    // The other half: freshness is NOT the model's call. Six days is past the 96-hour
    // threshold and Provo is two hours old, so Provo leads even though the model ranked the
    // stale stand first (B-063).
    const week = confirmed("f4", "Week Old Stand", "4 Week Way", [{ itemName: "Kale" }], 144);
    const page = renderResultPage({
      itemsRequested: ["Kale"],
      facts: [week, provo],
      offset: 0,
      total: 2,
      clock,
    });
    expect(page.body).toContain("Last seen (6d ago)");
    expect(page.body.indexOf("Provo Stand")).toBeLessThan(
      page.body.indexOf("Week Old Stand"),
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

  it("leads with confirmed stock and marks the two voices differently", () => {
    const body = pageOf(lamb);
    expect(body.indexOf("Provo")).toBeLessThan(body.indexOf("Alpha"));
    // F-107 moved the distinction from section headings onto the lines themselves: a customer
    // must still be able to see where confirmation stops and description begins.
    expect(body).toMatch(/^In stock /m);
    // "also" belongs only under a stock line in the SAME entry; these stands have none.
    expect(body).toMatch(/^May have: /m);
    expect(body).not.toMatch(/May also have/);
  });

  it("carries the address for both voices", () => {
    const body = pageOf([lamb[0]!, lamb[1]!]);
    expect(body).toContain("10142 Vashon Hwy");
    expect(body).toContain("240 SW 190th St");
  });

  it("gives confirmed stock a recency phrase and never claims present certainty", () => {
    const body = pageOf([lamb[0]!]);
    expect(body).toContain("1d ago");
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

// B-049 / B-061, now structural rather than guarded.
//
// Both bugs were the same shape: a section heading named the CUSTOMER'S word ("Confirmed
// mangoes:", "Confirmed eggs:") over stands whose rows did not support it. B-049 fixed the
// no-row case and B-061 the some-rows case, each by making the heading more careful.
//
// F-107 removed the heading instead. A stand's claims are now printed under that stand's own
// name, so there is no sentence left that could speak for a row other than its own — the
// defect class is unreachable rather than defended against, and the `some`/`every` guard and
// its four tests came out with it.
//
// What remains to prove is that removal: the customer's word must not appear as a claim
// anywhere the rows do not put it.
describe("no rendered claim names an item its rows do not carry (B-049, B-061)", () => {
  const unmatched: PageableFact = {
    factId: "confirmed-x",
    locationName: "Aeggy's Farm",
    farmName: "Aeggy's Farm",
    publicAddress: "13609 SW 220th St",
    // The category case: the model selected this stand for "mangoes" and none of its items
    // is one. Under the old layout this rendered `Confirmed mangoes:`.
    matchedItems: [{ itemName: "Eggs" }, { itemName: "blueberries" }, { itemName: "basil" }],
    asOf: hoursAgo(2),
    basis: "confirmed",
  };

  const matched: PageableFact = {
    ...unmatched,
    factId: "confirmed-y",
    locationName: "Mango Stand",
    farmName: "Mango Stand",
    matchedItems: [{ itemName: "mangoes" }],
  };

  /**
   * The stand entries alone — the header is excluded deliberately.
   *
   * The header names the customer's own query back to them ("Mangoes: 1 matching stand"), and
   * that is NOT the defect class B-049 and B-061 describe. It claims only that stands matched
   * the request, which is a statement about our search; the fatal claim was always a sentence
   * asserting that a particular stand CARRIES the item. So these assertions are anchored to
   * the entries, where such a claim would have to live to mislead anyone.
   */
  const standLinesOf = (body: string) => body.split("\n").slice(1).join("\n");

  it("never states the requested item except as a stand's own listed item", () => {
    const body = renderResultPage({
      itemsRequested: ["mangoes"],
      facts: [unmatched],
      offset: 0,
      total: 1,
      clock,
    }).body;
    // No stand line names the word, because no row carries it.
    expect(standLinesOf(body)).not.toMatch(/mango/i);
    // The stand is still a real answer the model selected — it must not vanish.
    expect(body).toContain("Aeggy's Farm");
    expect(body).toContain("Eggs, blueberries, basil");
  });

  it("prints the item under the stand that carries it, and not over the one that does not", () => {
    const body = renderResultPage({
      itemsRequested: ["mangoes"],
      facts: [matched, unmatched],
      offset: 0,
      total: 2,
      clock,
    }).body;
    const lines = body.split("\n");
    const mangoLine = lines.findIndex((line) => /mango/i.test(line) && line.startsWith("In stock"));
    const mangoStand = lines.indexOf("Mango Stand");
    const otherStand = lines.indexOf("Aeggy's Farm");
    // The only claim line naming mangoes belongs to Mango Stand's entry, not Aeggy's.
    expect(mangoLine).toBeGreaterThan(mangoStand);
    expect(mangoLine).toBeLessThan(otherStand);
  });

  it("applies the same rule to a stand carrying only typical offerings", () => {
    const body = renderResultPage({
      itemsRequested: ["dairy"],
      facts: [{ ...unmatched, basis: "offering" }],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(standLinesOf(body)).not.toMatch(/dairy/i);
    expect(body).toContain("Aeggy's Farm");
  });
});

/*
  F-107 — one entry per STAND, carrying both of its claims.

  The old layout grouped by claim type: a "Confirmed <item>:" section and an "Also list these
  as a typical offering:" section, each with a heading that made a factual claim about every
  stand beneath it. That heading is what B-061 defect 1 was — `Confirmed eggs:` printed over
  two stands that sell no eggs — and this format removes its job rather than making it more
  careful. A neutral lead-in cannot make a false claim.

  Each claim is now scoped to the stand it sits under, and the timestamp lives INSIDE the
  IN STOCK line so it cannot be read as covering the MAY ALSO HAVE items, which nobody
  confirmed and which therefore have no age.
*/
describe("street-only addresses (F-107)", () => {
  // Measured against the live corpus 2026-08-11: most stands store a bare street address, but
  // several carry a ", Vashon, WA 98070" tail — with and without commas. Every stand is on
  // Vashon, so that tail is ~16 characters of nothing on a surface that pays per character.
  const withAddress = (address: string): PageableFact => ({
    factId: "a1",
    farmName: "Alpha Farm",
    locationName: "Alpha Farm",
    publicAddress: address,
    matchedItems: [{ itemName: "eggs" }],
    asOf: hoursAgo(2),
    basis: "confirmed",
  });

  const bodyFor = (address: string) =>
    renderResultPage({
      itemsRequested: ["eggs"],
      facts: [withAddress(address)],
      offset: 0,
      total: 1,
      clock,
    }).body;

  it.each([
    ["10515 SW 140th St, Vashon, WA 98070", "10515 SW 140th St"],
    ["20430 111th Ave SW Vashon WA 98070", "20430 111th Ave SW"],
    ["13632 SW 220th St Vashon WA 98070", "13632 SW 220th St"],
    // Already street-only: unchanged, including a trailing abbreviation dot.
    ["9627 SW Elisha Ln.", "9627 SW Elisha Ln."],
    ["13705 Vashon Hwy SW", "13705 Vashon Hwy SW"],
  ])("renders %s as %s", (stored, expected) => {
    const body = bodyFor(stored);
    expect(body).toContain(expected);
    expect(body).not.toMatch(/98070/);
    expect(body).not.toMatch(/\bWA\b/);
  });

  it("keeps a street named Vashon, which is not the city tail", () => {
    // "Vashon Hwy SW" is a real road on the island. Stripping the word wherever it appears
    // would mangle the address of every stand on the main highway.
    expect(bodyFor("13705 Vashon Hwy SW")).toContain("13705 Vashon Hwy SW");
  });

  it("puts the address last in the entry, under the claims", () => {
    // Reordered 2026-08-11: name, claims, address. The address is what a customer needs only
    // once they have decided to go, so it no longer sits between the name and the answer.
    const body = bodyFor("20171 87th Ave SW");
    expect(body).toContain("Alpha Farm\nIn stock (2h ago): eggs\n20171 87th Ave SW");
  });
});

describe("one entry per stand (F-107)", () => {
  const provo: PageableFact = {
    factId: "c1",
    farmName: "Provo Farms",
    locationName: "Provo Farms",
    publicAddress: "1 Road",
    matchedItems: [{ itemName: "eggs" }, { itemName: "bok choy" }],
    // Deliberately just inside STALE_AFTER_HOURS: this fixture is about the LAYOUT, and a
    // staleness suffix in the same line would make the assertions test two things at once.
    asOf: hoursAgo(47),
    basis: "confirmed",
  };
  const provoOffering: PageableFact = {
    ...provo,
    factId: "o1",
    matchedItems: [{ itemName: "a choy" }],
    basis: "offering",
  };
  const sherman: PageableFact = {
    factId: "o2",
    farmName: "Sherman Creek Farm",
    locationName: "Sherman Creek Farm",
    publicAddress: "2 Road",
    matchedItems: [{ itemName: "eggs" }],
    asOf: hoursAgo(500),
    basis: "offering",
  };

  it("omits a stand left with no claim to make", () => {
    // FOUND against the live corpus (2026-08-11): "who has eggs today?" printed
    //
    //   Useful Bear Farm
    //   13705 Vashon Hwy SW
    //
    // and nothing else. The model selected the stand and then named none of its items as an
    // answer, so both claim lines rendered empty and the entry said only that a stand exists.
    // A name and an address make no claim about the question, so the honest move is to leave
    // it out rather than print a stand the customer cannot act on.
    const empty: PageableFact = { ...provo, matchedItems: [] };
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [empty],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body).not.toContain("Provo Farms");
  });

  it("keeps the stands that do make a claim when another is dropped", () => {
    const empty: PageableFact = {
      ...provo,
      factId: "c9",
      locationName: "Empty Stand",
      farmName: "Empty Stand",
      matchedItems: [],
    };
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [provo, empty],
      offset: 0,
      total: 2,
      clock,
    }).body;
    expect(body).toContain("Provo Farms");
    expect(body).not.toContain("Empty Stand");
  });

  it("says nobody has it rather than leading in to an empty list", () => {
    // The tail of the drop rule: if EVERY selected stand turns out to make no claim, the page
    // must not render "Here are matching stands:" over nothing. That would be a lead-in with
    // no answer under it — worse than the honest no-listing reply.
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [{ ...provo, matchedItems: [] }],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body).not.toMatch(/Here are matching stands/i);
    expect(body).toMatch(/No stand has a current listing/i);
  });

  it("merges a stand's confirmed and offering rows into one entry", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [provo, provoOffering],
      offset: 0,
      total: 2,
      clock,
    }).body;

    // Named once, not once per claim type.
    expect(body.match(/Provo Farms/g)).toHaveLength(1);
    expect(body).toContain("In stock (1d ago): eggs, bok choy");
    expect(body).toContain("May also have: a choy");
    // The old section headings are gone entirely.
    expect(body).not.toMatch(/Confirmed /i);
    expect(body).not.toMatch(/typical offering/i);
  });

  it("gives a stand with no confirmation a May have line and no timestamp", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [sherman],
      offset: 0,
      total: 1,
      clock,
    }).body;

    expect(body).toContain("May have: eggs");
    // Nobody confirmed it, so no elapsed phrase may appear anywhere in its entry.
    expect(body).not.toMatch(/ago\)/);
    expect(body).not.toMatch(/In stock/);
  });

  it("ranks stands with a confirmation above stands without one", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [sherman, provo],
      offset: 0,
      total: 2,
      clock,
    }).body;
    expect(body.indexOf("Provo Farms")).toBeLessThan(body.indexOf("Sherman Creek Farm"));
  });

  it("states a stale listing's age rather than warning about it", () => {
    // max's call (2026-08-11): the elapsed phrase IS the warning on this surface. "(3d ago)"
    // carries what "- may be out of date" carried, in four characters instead of twenty, and
    // the twenty pushed an all-stale page past its segment ceiling. The PUBLIC MAP keeps its
    // explicit warning — a browsed card has room for words a text message pays for.
    //
    // What must not change: the stale listing still appears, still ranked, still stamped.
    const stale: PageableFact = { ...provo, asOf: hoursAgo(72) };
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [stale, provoOffering],
      offset: 0,
      total: 2,
      clock,
    }).body;

    expect(body).not.toMatch(/may be out of date/i);
    expect(body).toContain("In stock (3d ago):");
    expect(body).toContain("Provo Farms");
  });

  describe("abbreviated elapsed — SMS pays per character", () => {
    it.each([
      [0.5, "(now)"],
      [1, "(1h ago)"],
      [5, "(5h ago)"],
      [23, "(23h ago)"],
      [24, "(1d ago)"],
      [72, "(3d ago)"],
    ])("renders %s hours as %s", (hours, expected) => {
      const body = renderResultPage({
        itemsRequested: ["eggs"],
        facts: [{ ...provo, asOf: hoursAgo(hours) }],
        offset: 0,
        total: 1,
        clock,
      }).body;
      expect(body).toContain(`${hours >= 96 ? "Last seen" : "In stock"} ${expected}`);
    });

    it("never states minutes", () => {
      // max's call: nothing a customer decides changes inside an hour.
      const body = renderResultPage({
        itemsRequested: ["eggs"],
        facts: [{ ...provo, asOf: hoursAgo(0.75) }],
        offset: 0,
        total: 1,
        clock,
      }).body;
      expect(body).not.toMatch(/minute/i);
    });
  });
});

/*
  The scannability pass (max, 2026-08-11), driven by the first real reply read on a handset.

  Three things that reply got wrong, and this describe block is the spec for all three:

    - the entry led with the address, so the eye hit a number before it hit a name
    - `IN STOCK` shouted in capitals on every line of every entry
    - the last page closed with "All of them. Map:", which reads as a fragment

  The field ORDER is the substantive change. A customer scans for a farm name, then for what
  it has; the address only matters once they have decided to go. Name, claims, address.
*/
describe("entry layout — name, then claims, then address", () => {
  const stand: PageableFact = {
    factId: "c1",
    farmName: "Bart's Cart",
    locationName: "Bart's Cart",
    publicAddress: "13610 SW 240th St",
    matchedItems: [{ itemName: "Bouquets of Nigella seed pods" }],
    asOf: hoursAgo(22),
    basis: "confirmed",
  };

  it("orders the lines name, claim, address", () => {
    const body = renderResultPage({
      itemsRequested: ["nigella"],
      facts: [stand],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body).toContain(
      "Bart's Cart\nIn stock (22h ago): Bouquets of Nigella seed pods\n13610 SW 240th St",
    );
  });

  it("never puts the address between the name and the claims", () => {
    const body = renderResultPage({
      itemsRequested: ["nigella"],
      facts: [stand],
      offset: 0,
      total: 1,
      clock,
    }).body;
    const lines = body.split("\n");
    expect(lines.indexOf("13610 SW 240th St")).toBeGreaterThan(
      lines.findIndex((line) => line.startsWith("In stock")),
    );
  });

  it("puts the address last even when the stand carries both claims", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs", "kale"],
      facts: [
        stand,
        { ...stand, factId: "o1", basis: "offering", matchedItems: [{ itemName: "kale" }] },
      ],
      offset: 0,
      total: 2,
      clock,
    }).body;
    const lines = body.split("\n");
    expect(lines.indexOf("13610 SW 240th St")).toBeGreaterThan(
      lines.findIndex((line) => line.startsWith("May also have")),
    );
  });

  it("writes the labels in sentence case, reserving capitals for MORE", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [
        stand,
        { ...stand, factId: "o1", basis: "offering", matchedItems: [{ itemName: "kale" }] },
      ],
      offset: 0,
      total: 9,
      clock,
    }).body;
    expect(body).toMatch(/^In stock \(22h ago\): /m);
    expect(body).toMatch(/^May also have: /m);
    expect(body).not.toContain("IN STOCK");
    expect(body).not.toContain("MAYBE");
    // The one shouted word the RENDERER contributes is the command the customer types back.
    // Farm names and addresses are the corpus's own capitalization ("SW", "CSA") and are not
    // this rule's business — so the check is scoped to the lines the renderer authors.
    const rendered = body
      .split("\n")
      .filter((line) => !/Bart's Cart|13610 SW 240th St/.test(line));
    expect(rendered.join("\n").match(/\b[A-Z]{2,}\b/g)).toEqual(["MORE"]);
  });

  it("renders a stand with no confirmation as May have", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [{ ...stand, factId: "o9", basis: "offering", matchedItems: [{ itemName: "eggs" }] }],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body).toContain("May have: eggs");
    expect(body).not.toMatch(/ago/);
  });
});

/*
  The header states the count and the window — nothing else (max, 2026-08-11).

  It named the query back first ("Eggs: 10 matching stands"). The customer just typed the
  query, so echoing it spends characters on the one thing they already know, and it made the
  header a claim about the list that B-049 and B-061 both got wrong. A bare count cannot be
  false about any entry beneath it, and it reads identically for a named item and for "what do
  you have" — so the broad path needs no separate subject line.
*/
describe("the header states the count and the window", () => {
  const eggStand = (n: number): PageableFact => ({
    factId: `c${n}`,
    farmName: `Farm ${n}`,
    locationName: `Farm ${n}`,
    publicAddress: `${100 + n} SW 220th St`,
    matchedItems: [{ itemName: "eggs" }],
    asOf: hoursAgo(24),
    basis: "confirmed",
  });

  it("states the total and the window", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [eggStand(1), eggStand(2), eggStand(3)],
      offset: 0,
      total: 10,
      clock,
    }).body;
    expect(body.split("\n")[0]).toBe("10 matching stands (1-3 of 10)");
  });

  it("never echoes the requested items, however many were named", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs", "kale"],
      facts: [eggStand(1), eggStand(2), eggStand(3)],
      offset: 0,
      total: 6,
      clock,
    }).body;
    expect(body.split("\n")[0]).toBe("6 matching stands (1-3 of 6)");
    expect(body).not.toMatch(/eggs \+ kale/i);
  });

  it("says stand, singular, for exactly one", () => {
    const body = renderResultPage({
      itemsRequested: ["nigella"],
      facts: [eggStand(1)],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body.split("\n")[0]).toBe("1 matching stand");
    // A range of one over a total of one is noise.
    expect(body).not.toMatch(/\(1-1 of 1\)/);
  });

  it("omits the window when everything fits on one page", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [eggStand(1), eggStand(2)],
      offset: 0,
      total: 2,
      clock,
    }).body;
    expect(body.split("\n")[0]).toBe("2 matching stands");
  });

  it("counts the window from the page's true offset", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [eggStand(4), eggStand(5), eggStand(6)],
      offset: 3,
      total: 10,
      clock,
    }).body;
    expect(body.split("\n")[0]).toBe("10 matching stands (4-6 of 10)");
  });

  it("reads the same with no requested term at all", () => {
    const body = renderResultPage({
      itemsRequested: [],
      facts: [eggStand(1)],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body.split("\n")[0]).toBe("1 matching stand");
  });

  it("never says Here are matching stands", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [eggStand(1)],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body).not.toMatch(/here are matching stands/i);
  });

  it("counts STANDS, not the facts they were built from", () => {
    // B-062's shape: one stand contributing a confirmed AND an offering fact is ONE matching
    // stand. `total` is therefore a stand count, which is what `groupFactsByStand` returns —
    // the caller and the renderer agree on the unit, so "of 45" cannot outrun the island.
    const confirmed = eggStand(1);
    const offering: PageableFact = {
      ...confirmed,
      factId: "o1",
      basis: "offering",
      matchedItems: [{ itemName: "kale" }],
    };
    const grouped = groupFactsByStand([confirmed, offering], NOW);
    expect(grouped.standCount).toBe(1);

    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [confirmed, offering],
      offset: 0,
      total: grouped.standCount,
      clock,
    }).body;
    expect(body.split("\n")[0]).toBe("1 matching stand");
    // The two facts printed one entry, so there is nothing further to page to.
    expect(body).not.toMatch(/MORE/);
  });
});

/*
  A confirmation old enough to stop meaning "in stock" (B-063).

  Found on a handset: `IN STOCK (16d ago): Zucchini, Carrots, garlic…`. The label is present
  tense and the elapsed phrase says two and a half weeks, so the same line makes two opposite
  claims — and the label is the one a customer reads first.

  F-107 dropped the "- may be out of date" suffix on the reasoning that the elapsed phrase
  carries the warning. That holds at "(3d ago)" and breaks down entirely by "(16d ago)". The
  fix changes the LABEL rather than restoring the suffix: "Last seen" is honest at any age,
  costs no extra characters (it replaces rather than appends), and leaves the segment ceiling
  where it is.

  Thresholds are the ones the public map already uses, so the two surfaces cannot come to
  disagree about the same row: `isStale` at 48 hours, `isConfirmationExpired` at 28 days.
*/
describe("a stale confirmation stops claiming present stock (B-063)", () => {
  const stand = (ageHours: number): PageableFact => ({
    factId: "c1",
    farmName: "Twisting Tree Farm",
    locationName: "Twisting Tree Farm",
    publicAddress: "12919 SW Cemetery Rd",
    matchedItems: [{ itemName: "Zucchini" }, { itemName: "Carrots" }],
    asOf: hoursAgo(ageHours),
    basis: "confirmed",
  });

  const bodyAt = (ageHours: number, items = ["zucchini"]) =>
    renderResultPage({
      itemsRequested: items,
      facts: [stand(ageHours)],
      offset: 0,
      total: 1,
      clock,
    }).body;

  it("says In stock inside the freshness threshold", () => {
    expect(bodyAt(3)).toContain("In stock (3h ago): Zucchini, Carrots");
    expect(bodyAt(3)).not.toMatch(/Last seen/);
  });

  it("still says In stock at the last hour before the threshold", () => {
    // 96 hours is where staleness STARTS, so 95 must still read as current.
    expect(bodyAt(95)).toContain("In stock (3d ago)");
  });

  it("switches to Last seen once the confirmation is stale", () => {
    // The live case. 16 days under a present-tense label was the defect.
    const body = bodyAt(16 * 24);
    expect(body).toContain("Last seen (16d ago): Zucchini, Carrots");
    expect(body).not.toMatch(/In stock/);
  });

  it("switches exactly at the shared threshold, not a second later", () => {
    // 96 hours, the same constant the public map warns on (max, 2026-08-11).
    expect(bodyAt(96)).toContain("Last seen (4d ago)");
    expect(bodyAt(95)).toContain("In stock (3d ago)");
  });

  it("keeps the stand listed, ranked, and stamped with its age", () => {
    // The honor-system commitment, and the thing that must NOT change: a stale listing still
    // appears and still carries its items and its age. Only the tense of the claim changes.
    const body = bodyAt(16 * 24);
    expect(body).toContain("Twisting Tree Farm");
    expect(body).toContain("12919 SW Cemetery Rd");
    expect(body).toContain("Zucchini, Carrots");
    expect(body).toContain("16d ago");
  });

  it("drops the stock claim entirely once the confirmation has expired", () => {
    // Past 28 days the map stops claiming stock at all rather than hedging, because a
    // two-month-old confirmation is not weaker evidence than a three-month-old one — it is no
    // evidence. SMS follows the same rule from the same shared function, so one row cannot
    // read as stock on one surface and not on the other.
    const body = bodyAt(40 * 24);
    expect(body).not.toMatch(/In stock/);
    expect(body).not.toMatch(/Last seen/);
    // With no claim left, the entry has nothing to say about the question and is dropped —
    // the same rule F-107 applies to a stand whose matched items were all filtered away.
    expect(body).toMatch(/No stand has a current listing/i);
  });

  it("keeps an expired stand when its usual offerings still answer", () => {
    // Losing the stock claim is not disappearing. The stand still carries what it usually
    // sells, which is exactly what the map falls back to.
    const body = renderResultPage({
      itemsRequested: ["zucchini"],
      facts: [
        stand(40 * 24),
        { ...stand(40 * 24), factId: "o1", basis: "offering" },
      ],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body).toContain("Twisting Tree Farm");
    // The expired confirmation is gone, so nothing remains for "also" to be additional to.
    expect(body).toContain("May have: Zucchini, Carrots");
    expect(body).not.toMatch(/In stock|Last seen/);
  });

  it("ranks a fresh confirmation above a stale one", () => {
    const fresh: PageableFact = {
      ...stand(2),
      factId: "c2",
      locationName: "Fresh Farm",
      farmName: "Fresh Farm",
    };
    const body = renderResultPage({
      itemsRequested: ["zucchini"],
      facts: [stand(16 * 24), fresh],
      offset: 0,
      total: 2,
      clock,
    }).body;
    expect(body.indexOf("Fresh Farm")).toBeLessThan(body.indexOf("Twisting Tree Farm"));
  });

  it("ranks a stand's usual offerings above someone else's stale claim", () => {
    /*
      max's third shape in the item, and the one that steers the customer correctly.

      A 16-day-old confirmation outranking a stand that reliably sells the thing is the wrong
      bet: neither is a promise, but the standing description is at least CURRENT as a
      description, while the confirmation is a fortnight-old snapshot. Fresh confirmations
      still lead both.
    */
    const offering: PageableFact = {
      ...stand(500),
      factId: "o9",
      locationName: "Reliable Stand",
      farmName: "Reliable Stand",
      basis: "offering",
    };
    const body = renderResultPage({
      itemsRequested: ["zucchini"],
      facts: [stand(16 * 24), offering],
      offset: 0,
      total: 2,
      clock,
    }).body;
    expect(body.indexOf("Reliable Stand")).toBeLessThan(
      body.indexOf("Twisting Tree Farm"),
    );
  });

  it("still ranks a fresh confirmation above a usual offering", () => {
    const offering: PageableFact = {
      ...stand(500),
      factId: "o9",
      locationName: "Reliable Stand",
      farmName: "Reliable Stand",
      basis: "offering",
    };
    const body = renderResultPage({
      itemsRequested: ["zucchini"],
      facts: [offering, stand(2)],
      offset: 0,
      total: 2,
      clock,
    }).body;
    expect(body.indexOf("Twisting Tree Farm")).toBeLessThan(
      body.indexOf("Reliable Stand"),
    );
  });
});

/*
  Paging by STAND rather than by fact (B-062).

  The first live reply said "1-3 of 45" over an island with 35 stands. The renderer merged a
  stand's two rows into one entry while the count and the page window were still taken over
  facts, so the total over-stated what exists — and, worse, a stand whose confirmed row ended
  one page and whose offering row began the next printed twice across two messages.

  These are the arithmetic the callers use to size an answer. The renderer proves the display;
  this proves the numbers behind it.
*/
describe("stand-level paging arithmetic", () => {
  const fact = (
    id: string,
    location: string,
    basis: PageableFact["basis"],
  ): PageableFact => ({
    factId: id,
    farmName: location,
    locationName: location,
    publicAddress: "1 Road",
    matchedItems: [{ itemName: "eggs" }],
    asOf: hoursAgo(3),
    basis,
  });

  it("counts one stand for a location retrieved on both bases", () => {
    const grouped = groupFactsByStand([
      fact("c1", "Alpha", "confirmed"),
      fact("o1", "Alpha", "offering"),
    ], NOW);
    expect(grouped.standCount).toBe(1);
    expect(grouped.factIds).toEqual(["c1", "o1"]);
  });

  it("keeps a stand's two facts adjacent, so no page can split them", () => {
    // Interleaved on the way in, which is what retrieval produces: all confirmed rows, then
    // all offering rows. Ungrouped, Alpha's offering row sits three places from its confirmed
    // one and a PAGE_SIZE slice lands between them.
    const grouped = groupFactsByStand([
      fact("c1", "Alpha", "confirmed"),
      fact("c2", "Beta", "confirmed"),
      fact("o1", "Alpha", "offering"),
      fact("o3", "Gamma", "offering"),
    ], NOW);
    const alphaFirst = grouped.factIds.indexOf("c1");
    expect(grouped.factIds[alphaFirst + 1]).toBe("o1");
    expect(grouped.standCount).toBe(3);
  });

  it("drops a claimless fact from both the count and the list", () => {
    const claimless: PageableFact = { ...fact("c9", "Empty", "confirmed"), matchedItems: [] };
    const grouped = groupFactsByStand([fact("c1", "Alpha", "confirmed"), claimless], NOW);
    expect(grouped.standCount).toBe(1);
    expect(grouped.factIds).toEqual(["c1"]);
  });

  it("takes enough facts to fill a page with whole stands", () => {
    // Three stands, one of which carries two facts: a page of 3 stands is 4 facts, not 3.
    const { factIds } = groupFactsByStand([
      fact("c1", "Alpha", "confirmed"),
      fact("o1", "Alpha", "offering"),
      fact("c2", "Beta", "confirmed"),
      fact("c3", "Gamma", "confirmed"),
      fact("c4", "Delta", "confirmed"),
    ], NOW);
    const facts = factIds.map((id) => {
      const location = { c1: "Alpha", o1: "Alpha", c2: "Beta", c3: "Gamma", c4: "Delta" }[id]!;
      return fact(id, location, id.startsWith("o") ? "offering" : "confirmed");
    });
    expect(factsPerPage(facts, 3)).toBe(4);
    // And the remainder starts cleanly on the next stand.
    expect(facts.slice(4).map((f) => f.factId)).toEqual(["c4"]);
  });

  it("never takes more facts than exist", () => {
    const facts = [fact("c1", "Alpha", "confirmed")];
    expect(factsPerPage(facts, 3)).toBe(1);
  });
});

/*
  General inventory questions have no search term (B-061 defect 4's path).

  "what do you have" is answered by code rather than by the model, and the header has to say
  something true about a question that named nothing. A bare count already does, so this path
  gets no special subject line — and the placeholder word code substitutes into
  `itemsRequested` ("produce") can no longer reach the customer, because nothing echoes it.
*/
describe("the general inventory header", () => {
  const stand = (n: number): PageableFact => ({
    factId: `c${n}`,
    farmName: `Farm ${n}`,
    locationName: `Farm ${n}`,
    publicAddress: `${100 + n} SW 220th St`,
    matchedItems: [{ itemName: "zucchini" }],
    asOf: hoursAgo(23),
    basis: "confirmed",
  });

  it("counts stands rather than naming a search term", () => {
    const body = renderResultPage({
      itemsRequested: ["produce"],
      facts: [stand(1), stand(2), stand(3)],
      offset: 0,
      total: 45,
      clock,
    }).body;
    expect(body.split("\n")[0]).toBe("45 matching stands (1-3 of 45)");
    // The placeholder the code path substitutes must never surface as the customer's word.
    expect(body).not.toMatch(/produce/i);
  });

  it("renders the same page whatever was requested, placeholder or real term", () => {
    // The `broad` flag existed to keep the placeholder out of the header. With no echo, a
    // general request and a named one produce byte-identical pages, so the flag has no
    // rendering job left and the placeholder cannot leak by any path.
    const page = (itemsRequested: string[]) =>
      renderResultPage({
        itemsRequested,
        facts: [stand(1), stand(2)],
        offset: 0,
        total: 9,
        clock,
      }).body;
    expect(page(["produce"])).toBe(page(["eggs", "kale"]));
  });
});

/*
  The last page closes with the map (max, 2026-08-11).

  "All of them. Map: <url>" read as a sentence fragment answering a question nobody asked. The
  header already states the range and the total, so the closing line has no counting to do —
  it only has to offer somewhere to go next.
*/
describe("the closing line", () => {
  const stand = (n: number): PageableFact => ({
    factId: `c${n}`,
    farmName: `Farm ${n}`,
    locationName: `Farm ${n}`,
    publicAddress: `${100 + n} SW 220th St`,
    matchedItems: [{ itemName: "eggs" }],
    asOf: hoursAgo(5),
    basis: "confirmed",
  });

  it("offers the bare map link on the final page", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [stand(4), stand(5), stand(6)],
      offset: 3,
      total: 6,
      clock,
    }).body;
    expect(body).toMatch(/\nMap: https:\/\/\S+$/);
    expect(body).not.toMatch(/all of them/i);
  });

  it("offers the map on a single-page answer too", () => {
    const body = renderResultPage({
      itemsRequested: ["nigella"],
      facts: [stand(1)],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body).toMatch(/\nMap: https:\/\/\S+$/);
  });

  it("offers MORE instead of the map when results remain", () => {
    const page = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [stand(1), stand(2), stand(3)],
      offset: 0,
      total: 10,
      clock,
    });
    expect(page.body).toMatch(/Reply MORE for the next 3\.$/);
    expect(page.body).not.toMatch(/Map:/);
    expect(page.hasMore).toBe(true);
  });

  it("counts down to the real remainder on the penultimate page", () => {
    // "next 3" on a page with two left is a small lie the customer catches immediately.
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [stand(1), stand(2), stand(3)],
      offset: 0,
      total: 5,
      clock,
    }).body;
    expect(body).toMatch(/Reply MORE for the next 2\.$/);
  });
});

/*
  Item-level precedence (F-107 + this pass).

  A stand can be retrieved on both bases and the two rows can name the SAME item — the corpus
  has several, where a farmer published the thing they also list as a usual offering. Printing
  it twice tells the customer we are not sure which it is.
*/
describe("an item never appears under both claims for one stand", () => {
  const base: PageableFact = {
    factId: "c1",
    farmName: "Fruits des Vignes Farm",
    locationName: "Fruits des Vignes Farm",
    publicAddress: "20430 111th Ave SW",
    matchedItems: [{ itemName: "eggs" }],
    asOf: hoursAgo(48),
    basis: "confirmed",
  };

  it("drops a confirmed item from the May also have line", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs", "kale"],
      facts: [
        base,
        {
          ...base,
          factId: "o1",
          basis: "offering",
          matchedItems: [{ itemName: "eggs" }, { itemName: "kale" }],
        },
      ],
      offset: 0,
      total: 2,
      clock,
    }).body;
    expect(body).toContain("In stock (2d ago): eggs");
    expect(body).toContain("May also have: kale");
    // Exactly one line claims eggs.
    expect(body.split("\n").filter((line) => /eggs/.test(line))).toHaveLength(1);
  });

  it("drops the May also have line entirely when it adds nothing", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [base, { ...base, factId: "o1", basis: "offering" }],
      offset: 0,
      total: 2,
      clock,
    }).body;
    expect(body).toContain("In stock (2d ago): eggs");
    expect(body).not.toMatch(/May also have/);
  });

  it("compares item names case-insensitively", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [
        { ...base, matchedItems: [{ itemName: "Eggs" }] },
        { ...base, factId: "o1", basis: "offering", matchedItems: [{ itemName: "eggs" }] },
      ],
      offset: 0,
      total: 2,
      clock,
    }).body;
    expect(body).not.toMatch(/May also have/);
    // The farmer's own capitalization survives.
    expect(body).toContain("In stock (2d ago): Eggs");
  });

  it("keeps a stand whose only claim is what it usually sells", () => {
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [{ ...base, factId: "o1", basis: "offering" }],
      offset: 0,
      total: 1,
      clock,
    }).body;
    expect(body).toContain("May have: eggs");
    expect(body).not.toMatch(/In stock/);
  });

  it("uses May also have only in the entry that carries a stock line", () => {
    const confirmed = { ...base, factId: "c1", matchedItems: [{ itemName: "eggs" }] };
    const body = renderResultPage({
      itemsRequested: ["eggs"],
      facts: [
        confirmed,
        { ...base, factId: "o1", basis: "offering", matchedItems: [{ itemName: "kale" }] },
        {
          ...base,
          factId: "o2",
          locationName: "Other Stand",
          basis: "offering",
          matchedItems: [{ itemName: "eggs" }],
        },
      ],
      offset: 0,
      total: 2,
      clock,
    }).body;
    // One entry has a confirmation above its offering line; the other has nothing above it.
    expect(body).toMatch(/^May also have: kale$/m);
    expect(body).toMatch(/^May have: eggs$/m);
  });
});
