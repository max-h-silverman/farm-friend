import { describe, expect, it } from "vitest";
import { standCardSections, type StandCardSeller } from "./stand-card";
import type { PublicStandPayload } from "./map-view";

/*
  F-114 Phase C.5 — THE STAND CARD, ITEM-FIRST.

  §customer behavior: *"Stand details stay centered on one In stock card, item-first: each item
  appears once and its supporting providers nest beneath it with their own price and freshness.
  No three duplicate Tomatoes rows."*

  ## What this replaces, and why it is not a second mechanism

  `standListingLines` decides a stand's listing body as SENTENCES — the shape SMS and the
  compact card need, and the shape that has held the no-timestamp rule since F-042. It is
  stand-level by construction: one confirmed heading, one usual heading, one recency phrase.
  After Phase B a stand has several sellers, each with its own freshness, so the DETAIL card
  needs a second axis that a flat list of sentences cannot carry.

  This function owns exactly that axis and nothing else. It does not decide recency wording
  (core does), does not decide who gets credited (`creditSeller` does), and does not decide the
  register (the reader does). It decides **which sections a card has and what nests under each
  item** — and the sentence-shaped cases still route through `standListingLines`, unchanged.

  ## The cases that carry the weight

  A test showing three sellers' tomatoes rendering would pass against the flat list this
  replaces — the tomatoes ARE all there, three times. So the assertions are on the COUNT of
  item groups and on what nests beneath each, never on presence.
*/

const base: PublicStandPayload = {
  id: "morgan-hill",
  farmName: "Morgan Hill Farm",
  locationName: "Morgan Hill Stand",
  visitability: "visitable",
  offeringType: "produce",
  address: "1 Vashon Hwy",
  latitude: 47.44,
  longitude: -122.45,
  availability: {},
  alsoSellingHere: [],
  links: [],
  paymentMethods: [],
  items: [],
  sellers: [],
};

const seller = (
  overrides: Partial<StandCardSeller> & { sellerName: string },
): StandCardSeller => ({
  providerId: `p-${overrides.sellerName}`,
  sellerId: `s-${overrides.sellerName}`,
  describesOwnStand: false,
  confirmedItems: [],
  usualItems: [],
  ...overrides,
});

const withSellers = (sellers: StandCardSeller[]): PublicStandPayload => ({
  ...base,
  sellers,
});

describe("standCardSections", () => {
  describe("item-first grouping", () => {
    it("prints one row per item however many sellers carry it", () => {
      /*
        THE HEADLINE CASE. Three sellers, one item. The flat list this replaces printed three
        `Tomatoes` rows; asserting the LENGTH is what tells the two apart — a presence check
        passes against both.
      */
      const sections = standCardSections(
        withSellers([
          seller({
            sellerName: "Morgan Hill Farm",
            describesOwnStand: true,
            confirmedItems: [{ itemName: "tomatoes", priceText: "$4" }],
            cardRecency: "Last updated 2 hours ago",
          }),
          seller({
            sellerName: "Tian Tian",
            confirmedItems: [{ itemName: "tomatoes", priceText: "$3" }],
            cardRecency: "Last updated 1 day ago",
          }),
          seller({
            sellerName: "Cascade Bakery",
            confirmedItems: [{ itemName: "tomatoes", priceText: "$5" }],
            cardRecency: "Last updated 3 weeks ago",
          }),
        ]),
      );

      const confirmed = sections.find((s) => s.register === "confirmed");
      expect(confirmed?.items).toHaveLength(1);
      expect(confirmed?.items[0]?.itemName).toBe("tomatoes");
      expect(confirmed?.items[0]?.providers).toHaveLength(3);
    });

    it("gives each nested seller its own price and its own freshness", () => {
      // §customer behavior — this resolves the different-price/different-freshness collision
      // "without a price range or a suppressed price: each provider carries its own price and
      // its own confirmation time, always."
      const sections = standCardSections(
        withSellers([
          seller({
            sellerName: "Morgan Hill Farm",
            describesOwnStand: true,
            confirmedItems: [{ itemName: "eggs", priceText: "$8" }],
            cardRecency: "Last updated 2 hours ago",
          }),
          seller({
            sellerName: "Tian Tian",
            confirmedItems: [{ itemName: "eggs", priceText: "$7" }],
            cardRecency: "Last updated 1 day ago",
          }),
        ]),
      );

      const providers = sections[0]!.items[0]!.providers;
      expect(providers.map((p) => p.priceText)).toEqual(["$8", "$7"]);
      expect(providers.map((p) => p.recency)).toEqual([
        "Last updated 2 hours ago",
        "Last updated 1 day ago",
      ]);
    });
  });

  describe("who gets credited", () => {
    it("leaves the stand's own seller unlabelled and names every other", () => {
      const sections = standCardSections(
        withSellers([
          seller({
            sellerName: "Morgan Hill Farm",
            describesOwnStand: true,
            confirmedItems: [{ itemName: "eggs", priceText: "$8" }],
            cardRecency: "Last updated 2 hours ago",
          }),
          seller({
            sellerName: "Tian Tian",
            confirmedItems: [{ itemName: "eggs", priceText: "$7" }],
            cardRecency: "Last updated 1 day ago",
          }),
        ]),
      );

      const providers = sections[0]!.items[0]!.providers;
      // `undefined` rather than the stand's name: the line renders bare, and there is no string
      // for a renderer to print in the credit slot.
      expect(providers[0]?.credit).toBeUndefined();
      expect(providers[1]?.credit).toBe("Tian Tian");
    });

    it("credits by the self-pointer even when the seller's name matches the stand's", () => {
      // The defect §suppression follows a pointer names: a hosted "Hill Farm" at a "Hill Farm
      // Stand" must still be credited. This case and the next are the only two that could
      // catch a reader that compared strings.
      const sections = standCardSections({
        ...base,
        locationName: "Hill Farm Stand",
        sellers: [
          seller({
            sellerName: "Hill Farm",
            confirmedItems: [{ itemName: "plums" }],
            cardRecency: "Last updated 1 hour ago",
          }),
        ],
      });
      expect(sections[0]!.items[0]!.providers[0]?.credit).toBe("Hill Farm");
    });

    it("suppresses the stand's own seller even when the two names differ", () => {
      const sections = standCardSections({
        ...base,
        locationName: "The Red Shed",
        sellers: [
          seller({
            sellerName: "Plum Forest Farm",
            describesOwnStand: true,
            confirmedItems: [{ itemName: "plums" }],
            cardRecency: "Last updated 1 hour ago",
          }),
        ],
      });
      expect(sections[0]!.items[0]!.providers[0]?.credit).toBeUndefined();
    });

    it("credits every seller at a venue, because none of them is the stand", () => {
      // Morgan Hill Community Stand sells nothing itself. §customer behavior's second example:
      // no empty native line, no implication that the stand itself has stock.
      const sections = standCardSections(
        withSellers([
          seller({
            sellerName: "Tian Tian",
            confirmedItems: [{ itemName: "eggs", priceText: "$7" }],
            cardRecency: "Last updated 1 day ago",
          }),
          seller({
            sellerName: "Cascade Bakery",
            confirmedItems: [{ itemName: "eggs", priceText: "$9" }],
            cardRecency: "Last updated 3 hours ago",
          }),
        ]),
      );
      expect(sections[0]!.items[0]!.providers.map((p) => p.credit)).toEqual([
        "Tian Tian",
        "Cascade Bakery",
      ]);
    });
  });

  describe("the usual register", () => {
    it("publishes a hosted seller's usual items with no timestamp anywhere on the line", () => {
      /*
        §customer behavior — "A hosted seller's usual items are public BEFORE any confirmation
        exists… Such a line renders in the usual register with NO TIMESTAMP and never as a bare
        item line that could read as current stock."

        The seller is given a `cardRecency` on purpose. A renderer that simply passed the
        provider's recency through would print it, and the absence below is what refuses.
      */
      const sections = standCardSections(
        withSellers([
          seller({
            sellerName: "Fernhorn Bakery",
            usualItems: [{ itemName: "sourdough", priceText: "$8 / loaf" }],
            cardRecency: "Last updated 2 hours ago",
          }),
        ]),
      );

      const usual = sections.find((s) => s.register === "usual");
      expect(usual).toBeDefined();
      expect(usual!.items[0]?.itemName).toBe("sourdough");
      expect(usual!.items[0]?.providers[0]?.recency).toBeUndefined();
      expect(usual!.items[0]?.providers[0]?.credit).toBe("Fernhorn Bakery");
      // The price is a standing claim exactly like the item, so it DOES travel.
      expect(usual!.items[0]?.providers[0]?.priceText).toBe("$8 / loaf");
    });

    it("keeps confirmed and usual apart for the same item name", () => {
      const sections = standCardSections(
        withSellers([
          seller({
            sellerName: "Morgan Hill Farm",
            describesOwnStand: true,
            confirmedItems: [{ itemName: "eggs" }],
            cardRecency: "Last updated 2 hours ago",
          }),
          seller({ sellerName: "Tian Tian", usualItems: [{ itemName: "eggs" }] }),
        ]),
      );

      expect(sections.map((s) => s.register)).toEqual(["confirmed", "usual"]);
      expect(sections[0]!.items[0]?.providers).toHaveLength(1);
      expect(sections[1]!.items[0]?.providers).toHaveLength(1);
    });

    it("puts the confirmed section before the usual one", () => {
      const sections = standCardSections(
        withSellers([
          seller({
            sellerName: "Morgan Hill Farm",
            describesOwnStand: true,
            confirmedItems: [{ itemName: "eggs" }],
            usualItems: [{ itemName: "jam" }],
            cardRecency: "Last updated 2 hours ago",
          }),
        ]),
      );
      expect(sections.map((s) => s.register)).toEqual(["confirmed", "usual"]);
    });
  });

  describe("what a card says when there is nothing to say", () => {
    it("renders no sections for a stand whose sellers claim nothing", () => {
      expect(standCardSections(withSellers([seller({ sellerName: "Quiet Farm" })]))).toEqual([]);
    });

    it("renders no sections for a stand with no sellers at all", () => {
      // An un-invited venue. The card falls back to `standListingLines`' sentences, which is
      // what already handles "no listing yet" — this returns nothing rather than inventing a
      // second empty-state vocabulary.
      expect(standCardSections(base)).toEqual([]);
    });
  });

  describe("a stand shutdown overrides every seller", () => {
    /*
      §customer behavior and the F-114 criterion: **a stand shutdown renders nothing itemized.**

      A closed stand is a locked box. Whatever any seller published, and however fresh it is,
      none of it is buyable — so the card must not print an item list beside a closure notice.
      Enforced HERE rather than in the component, so the map card, the seller detail page and
      anything later reading these sections all inherit it from one place.
    */
    const stocked: StandCardSeller[] = [
      seller({
        sellerName: "Morgan Hill Farm",
        describesOwnStand: true,
        confirmedItems: [{ itemName: "eggs", priceText: "$8" }],
        usualItems: [{ itemName: "jam" }],
        cardRecency: "Last updated 2 hours ago",
      }),
      seller({
        sellerName: "Tian Tian",
        confirmedItems: [{ itemName: "eggs", priceText: "$7" }],
        cardRecency: "Last updated 1 day ago",
      }),
    ];

    it("renders nothing itemized while a closure is active", () => {
      const sections = standCardSections({
        ...withSellers(stocked),
        closure: { state: "active", closureKind: "temporary", startsOn: "2026-08-10", label: "Closed this week" },
      });
      expect(sections).toEqual([]);
    });

    it("still renders items when the closure is only upcoming", () => {
      // The other direction, and the case that makes the one above falsifiable. An upcoming
      // closure is information about next week; the stand is open now and its stock is real.
      const sections = standCardSections({
        ...withSellers(stocked),
        closure: { state: "upcoming", closureKind: "temporary", startsOn: "2026-08-10", label: "Closing Monday" },
      });
      expect(sections.find((s) => s.register === "confirmed")?.items).toHaveLength(1);
    });

    it("suppresses a hosted seller's usual items too, not only confirmed stock", () => {
      // The half most easily missed: a shutdown is about the PLACE, so a standing claim is as
      // unbuyable as a dated one. A guard that only filtered confirmed items would leave the
      // usual section printing under a closure notice.
      const sections = standCardSections({
        ...base,
        sellers: [
          seller({
            sellerName: "Fernhorn Bakery",
            usualItems: [{ itemName: "sourdough" }],
          }),
        ],
        closure: { state: "active", closureKind: "seasonal", startsOn: "2026-08-10", label: "Closed for the season" },
      });
      expect(sections).toEqual([]);
    });
  });

  describe("ordering", () => {
    it("keeps the reader's seller order inside each item", () => {
      // The stand's own seller first, then hosted sellers — decided in the reader so the map,
      // SMS and the seller list agree. This asserts the card does not re-sort it.
      const sections = standCardSections(
        withSellers([
          seller({
            sellerName: "Morgan Hill Farm",
            describesOwnStand: true,
            confirmedItems: [{ itemName: "eggs" }],
            cardRecency: "a",
          }),
          seller({ sellerName: "Aardvark Farm", confirmedItems: [{ itemName: "eggs" }], cardRecency: "b" }),
        ]),
      );
      expect(sections[0]!.items[0]!.providers.map((p) => p.credit)).toEqual([
        undefined,
        "Aardvark Farm",
      ]);
    });

    it("keeps items in the order they were first seen", () => {
      const sections = standCardSections(
        withSellers([
          seller({
            sellerName: "A",
            describesOwnStand: true,
            confirmedItems: [{ itemName: "tomatoes" }, { itemName: "eggs" }],
            cardRecency: "a",
          }),
          seller({
            sellerName: "B",
            confirmedItems: [{ itemName: "eggs" }, { itemName: "apples" }],
            cardRecency: "b",
          }),
        ]),
      );
      expect(sections[0]!.items.map((i) => i.itemName)).toEqual([
        "tomatoes",
        "eggs",
        "apples",
      ]);
    });
  });
});
