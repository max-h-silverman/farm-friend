import { describe, expect, it } from "vitest";
import { filterSellers, sellerSellingSummary, type SellerListEntry } from "./seller-list";

/*
  F-114 Phase C.5 — THE SELLER LIST'S VIEW MODEL.

  §customer behavior: the list "carries search and shows where each seller is currently
  selling". Both of those are decisions, so both live here rather than in JSX — the same split
  `map-view.ts` already makes for the stand map.

  ## What search has to match, and what it must NOT

  A customer types either a produce word or a name. Both are the same question to them ("is what
  I want here?"), so one box answers both — exactly as `sellsMatch` does for the map.

  The bounded corpus matters as much as the matches. A seller's own name, and the items THEY
  carry. **Not the stand names they sell at**: searching "Morgan Hill" must not return every
  baker who happens to have a table there, because that answers "who is at Morgan Hill" with a
  list of sellers whose own identity has nothing to do with the query — and the map already
  answers that question properly, by stand.
*/

const seller = (overrides: Partial<SellerListEntry> = {}): SellerListEntry => ({
  sellerId: "s-1",
  sellerName: "Fernhorn Bakery",
  ownsAStand: false,
  sellingAt: [
    {
      salesLocationId: "l-1",
      locationName: "Venison Valley Stand",
      describesOwnStand: false,
      usualItems: [{ itemName: "sourdough" }],
    },
  ],
  ...overrides,
});

describe("filterSellers", () => {
  it("returns everyone for an empty query", () => {
    const sellers = [seller(), seller({ sellerId: "s-2", sellerName: "Aardvark Acres" })];
    expect(filterSellers(sellers, "").map((s) => s.sellerId)).toEqual(["s-1", "s-2"]);
  });

  it("matches a seller by name, case-insensitively and by substring", () => {
    expect(filterSellers([seller()], "fernhorn").map((s) => s.sellerId)).toEqual(["s-1"]);
    expect(filterSellers([seller()], "BAKE").map((s) => s.sellerId)).toEqual(["s-1"]);
  });

  it("matches a seller by something they carry", () => {
    // The hosted-only seller's whole discovery story: a customer wants sourdough and has no
    // idea whose it is or which stand it is at.
    expect(filterSellers([seller()], "sourdough").map((s) => s.sellerId)).toEqual(["s-1"]);
    // Substring, because a customer types "dough" and the item says "sourdough".
    expect(filterSellers([seller()], "dough").map((s) => s.sellerId)).toEqual(["s-1"]);
  });

  it("does not match a seller by the name of a stand they sell at", () => {
    /*
      THE BOUNDED CORPUS, and the one case that could catch a haystack that grew.

      "Venison Valley Stand" is in this seller's data but is not a fact ABOUT this seller.
      Matching it would answer "who is at Venison Valley" with Fernhorn — a seller whose own
      identity and goods have nothing to do with the query. The MAP answers that question, by
      stand, which is where it belongs.
    */
    expect(filterSellers([seller()], "Venison")).toEqual([]);
  });

  it("returns nothing rather than everything for a query nothing matches", () => {
    // The direction that fails open. A filter that returned the full list on no match would
    // look like a working search and answer every question with "everyone".
    expect(filterSellers([seller()], "kumquat")).toEqual([]);
  });

  it("ignores surrounding whitespace", () => {
    expect(filterSellers([seller()], "  bakery  ").map((s) => s.sellerId)).toEqual(["s-1"]);
  });

  it("searches every stand's items, not only the first", () => {
    const twoStands = seller({
      sellingAt: [
        {
          salesLocationId: "l-1",
          locationName: "A Stand",
          describesOwnStand: false,
          usualItems: [{ itemName: "sourdough" }],
        },
        {
          salesLocationId: "l-2",
          locationName: "B Stand",
          describesOwnStand: false,
          usualItems: [{ itemName: "cinnamon rolls" }],
        },
      ],
    });
    expect(filterSellers([twoStands], "cinnamon").map((s) => s.sellerId)).toEqual(["s-1"]);
  });
});

describe("sellerSellingSummary", () => {
  it("names the one stand a seller sells at", () => {
    expect(sellerSellingSummary(seller())).toBe("Selling at Venison Valley Stand");
  });

  it("names every stand, in the order given", () => {
    const twoStands = seller({
      sellingAt: [
        {
          salesLocationId: "l-1",
          locationName: "Aardvark Stand",
          describesOwnStand: false,
          usualItems: [],
        },
        {
          salesLocationId: "l-2",
          locationName: "Venison Valley Stand",
          describesOwnStand: false,
          usualItems: [],
        },
      ],
    });
    expect(sellerSellingSummary(twoStands)).toBe(
      "Selling at Aardvark Stand and Venison Valley Stand",
    );
  });

  it("joins three or more with commas and a final and", () => {
    const threeStands = seller({
      sellingAt: ["A", "B", "C"].map((name, index) => ({
        salesLocationId: `l-${index}`,
        locationName: name,
        describesOwnStand: false,
        usualItems: [],
      })),
    });
    expect(sellerSellingSummary(threeStands)).toBe("Selling at A, B and C");
  });

  it("says a seller runs their own stand rather than merely selling at it", () => {
    // The distinction a hosted-only seller's page exists to make legible. "Selling at" reads
    // as a guest arrangement, which is wrong for someone's own farm stand.
    const owner = seller({
      sellerName: "Venison Valley",
      ownsAStand: true,
      sellingAt: [
        {
          salesLocationId: "l-1",
          locationName: "Venison Valley Stand",
          describesOwnStand: true,
          usualItems: [],
        },
      ],
    });
    expect(sellerSellingSummary(owner)).toBe("Their own stand: Venison Valley Stand");
  });

  it("distinguishes a seller's own stand from the others they guest at", () => {
    const both = seller({
      sellerName: "Venison Valley",
      ownsAStand: true,
      sellingAt: [
        {
          salesLocationId: "l-1",
          locationName: "Venison Valley Stand",
          describesOwnStand: true,
          usualItems: [],
        },
        {
          salesLocationId: "l-2",
          locationName: "Morgan Hill Community Stand",
          describesOwnStand: false,
          usualItems: [],
        },
      ],
    });
    expect(sellerSellingSummary(both)).toBe(
      "Their own stand: Venison Valley Stand. Also selling at Morgan Hill Community Stand",
    );
  });

  it("says nothing rather than an empty sentence for a seller selling nowhere", () => {
    // The reader never returns such a seller, but a null here is what stops a renderer
    // printing a bare "Selling at" with nothing after it if one ever arrives.
    expect(sellerSellingSummary(seller({ sellingAt: [] }))).toBeNull();
  });
});
