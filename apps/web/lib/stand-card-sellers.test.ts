import { describe, expect, it } from "vitest";
import { standCardSellerGroups } from "./stand-card-sellers";
import type { StandCardSeller } from "./stand-card-sellers";
import type { PublicStandPayload } from "./map-view";

/*
  F-119 — THE STAND CARD, SELLER-MAJOR.

  The mockup regroups `In stock` and `Usually carries` so each SELLER is a sub-heading carrying
  its own recency, with that seller's items as cards beneath it. That is an inversion of the
  same data `standCardSections` already returns — no new query, no new payload field.

  WHAT THIS DELIBERATELY GIVES UP. Item-first (F-114 C.5) exists so one item appears ONCE however
  many sellers carry it. Seller-major cannot preserve that: two sellers carrying tomatoes means
  tomatoes appears under each. That is the mockup's explicit intent — the duplication is
  meaningful here because each copy sits under a different seller with that seller's own price
  and freshness, which is exactly what the customer is being asked to compare.
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
  openState: "open",
  confirmedItems: [],
  usualItems: [],
  ...overrides,
});

const withSellers = (sellers: StandCardSeller[]): PublicStandPayload => ({
  ...base,
  sellers,
});

/** The mockup's stand: a guest bakery beside the stand's own farm. */
const tianTianAndFernhorn = withSellers([
  seller({
    sellerName: "Tian Tian Farm",
    describesOwnStand: true,
    cardRecency: "Updated 3 days ago",
    confirmedItems: [
      { itemName: "gailan", priceText: "$4" },
      { itemName: "sungold tomatoes", priceText: "$5" },
      { itemName: "bok choy", priceText: "$3" },
    ],
    usualItems: [{ itemName: "scallions" }],
  }),
  seller({
    sellerName: "Fernhorn Bakery",
    cardRecency: "Updated today",
    confirmedItems: [
      { itemName: "sesame sourdough", priceText: "$8" },
      { itemName: "milk bread", priceText: "$7" },
    ],
    usualItems: [{ itemName: "fernhorn bread" }],
  }),
]);

describe("standCardSellerGroups", () => {
  it("groups a register's items under each seller, in the payload's seller order", () => {
    const [inStock] = standCardSellerGroups(tianTianAndFernhorn);

    expect(inStock?.register).toBe("confirmed");
    expect(inStock?.sellers.map((s) => s.sellerName)).toEqual([
      "Tian Tian Farm",
      "Fernhorn Bakery",
    ]);
    expect(inStock?.sellers[0]?.items.map((i) => i.itemName)).toEqual([
      "gailan",
      "sungold tomatoes",
      "bok choy",
    ]);
    expect(inStock?.sellers[1]?.items.map((i) => i.itemName)).toEqual([
      "sesame sourdough",
      "milk bread",
    ]);
  });

  it("keeps confirmed and usual as separate sections", () => {
    const groups = standCardSellerGroups(tianTianAndFernhorn);
    expect(groups.map((g) => g.register)).toEqual(["confirmed", "usual"]);
    expect(groups[1]?.sellers.flatMap((s) => s.items.map((i) => i.itemName))).toEqual([
      "scallions",
      "fernhorn bread",
    ]);
  });

  /*
    RECENCY MOVES TO THE SELLER SUB-HEADING, which is its honest home: each seller publishes
    independently, so the phrase describes the SELLER, not the item and not the stand.
  */
  it("carries each seller's own recency on the seller, never on the item", () => {
    const [inStock] = standCardSellerGroups(tianTianAndFernhorn);
    expect(inStock?.sellers[0]?.recency).toBe("Updated 3 days ago");
    expect(inStock?.sellers[1]?.recency).toBe("Updated today");
    for (const item of inStock?.sellers.flatMap((s) => s.items) ?? []) {
      expect(item).not.toHaveProperty("recency");
    }
  });

  /*
    NO RECENCY ON A USUAL SECTION, EVER (F-114's rule, inherited). A standing claim is dated by
    nothing, and a hosted seller is often public on standing claims alone — a date beside one
    would read as a confirmation nobody made.
  */
  it("never dates a usual section, even though the seller has a recency", () => {
    const usual = standCardSellerGroups(tianTianAndFernhorn)[1];
    for (const group of usual?.sellers ?? []) {
      expect(group.recency).toBeUndefined();
      expect(group.stale).toBeUndefined();
    }
  });

  it("omits a seller from a register they claim nothing in", () => {
    const groups = standCardSellerGroups(
      withSellers([
        seller({
          sellerName: "Tian Tian Farm",
          describesOwnStand: true,
          confirmedItems: [{ itemName: "gailan" }],
        }),
        seller({ sellerName: "Fernhorn Bakery", usualItems: [{ itemName: "bread" }] }),
      ]),
    );
    expect(groups[0]?.sellers.map((s) => s.sellerName)).toEqual(["Tian Tian Farm"]);
    expect(groups[1]?.sellers.map((s) => s.sellerName)).toEqual(["Fernhorn Bakery"]);
  });

  /*
    B-088's RULE, CARRIED FORWARD. A single-seller stand must not grow a sub-heading that merely
    repeats what the section heading already said. 33 of 37 production stands are single-seller,
    so this is the COMMON case, not the edge one.
  */
  it("suppresses the sub-heading on a single-seller stand", () => {
    const [inStock] = standCardSellerGroups(
      withSellers([
        seller({
          sellerName: "Morgan Hill Farm",
          describesOwnStand: true,
          cardRecency: "Updated 2 hours ago",
          confirmedItems: [{ itemName: "eggs", priceText: "$6/dozen" }],
        }),
      ]),
    );
    expect(inStock?.sellers).toHaveLength(1);
    expect(inStock?.sellers[0]?.showHeading).toBe(false);
  });

  it("shows the sub-heading as soon as a second seller shares the register", () => {
    const [inStock] = standCardSellerGroups(tianTianAndFernhorn);
    expect(inStock?.sellers.every((s) => s.showHeading)).toBe(true);
  });

  /*
    A stand whose OWN seller is the only one in `In stock` gets no sub-heading there, while a
    `Usually carries` shared with a guest does. The rule is per-SECTION, because that is where
    the redundancy actually is.
  */
  it("decides the sub-heading per section, not per stand", () => {
    const groups = standCardSellerGroups(
      withSellers([
        seller({
          sellerName: "Tian Tian Farm",
          describesOwnStand: true,
          cardRecency: "Updated 3 days ago",
          confirmedItems: [{ itemName: "gailan" }],
          usualItems: [{ itemName: "scallions" }],
        }),
        seller({ sellerName: "Fernhorn Bakery", usualItems: [{ itemName: "bread" }] }),
      ]),
    );
    expect(groups[0]?.sellers[0]?.showHeading).toBe(false);
    expect(groups[1]?.sellers.every((s) => s.showHeading)).toBe(true);
  });

  /*
    F-118 — THE CREDIT IS THE CROSSING. The seller name is the door into the seller list, so the
    group must carry the id the link needs, INCLUDING for the stand's own seller: unlike the
    nested credit line, a sub-heading prints a name for everyone it shows.
  */
  it("carries the seller id so the sub-heading can stay a link", () => {
    const [inStock] = standCardSellerGroups(tianTianAndFernhorn);
    expect(inStock?.sellers[0]?.sellerId).toBe("s-Tian Tian Farm");
    expect(inStock?.sellers[1]?.sellerId).toBe("s-Fernhorn Bakery");
  });

  /*
    PRICE IS FREE TEXT THE FARMER TYPED. The mockup shows a bare "$4", but the real corpus holds
    "$6/dozen", "$5 a bunch", "$1.50/lb", "$180 half" and even a phone number. Nothing may parse,
    reformat or assume a shape.
  */
  it("passes a farmer's price text through exactly as typed", () => {
    const [inStock] = standCardSellerGroups(
      withSellers([
        seller({
          sellerName: "Morgan Hill Farm",
          describesOwnStand: true,
          confirmedItems: [
            { itemName: "eggs", priceText: "$6/dozen" },
            { itemName: "flowers", priceText: "$5 a bunch" },
            { itemName: "lamb", priceText: "call the owner at 206-555-0000" },
            { itemName: "garlic" },
          ],
        }),
      ]),
    );
    expect(inStock?.sellers[0]?.items.map((i) => i.priceText)).toEqual([
      "$6/dozen",
      "$5 a bunch",
      "call the owner at 206-555-0000",
      undefined,
    ]);
  });

  it("keeps quantity and approximation alongside the price", () => {
    const [inStock] = standCardSellerGroups(
      withSellers([
        seller({
          sellerName: "Morgan Hill Farm",
          describesOwnStand: true,
          confirmedItems: [
            { itemName: "eggs", quantity: 12, unit: "dozen", priceText: "$6" },
            { itemName: "kale", approximation: "limited" },
          ],
        }),
      ]),
    );
    expect(inStock?.sellers[0]?.items[0]).toMatchObject({ quantity: 12, unit: "dozen" });
    expect(inStock?.sellers[0]?.items[1]).toMatchObject({ approximation: "limited" });
  });

  it("marks a stale seller so the sub-heading can warn", () => {
    const [inStock] = standCardSellerGroups(
      withSellers([
        seller({
          sellerName: "Tian Tian Farm",
          describesOwnStand: true,
          cardRecency: "Updated 3 weeks ago",
          stale: true,
          confirmedItems: [{ itemName: "gailan" }],
        }),
        seller({
          sellerName: "Fernhorn Bakery",
          cardRecency: "Updated today",
          confirmedItems: [{ itemName: "bread" }],
        }),
      ]),
    );
    expect(inStock?.sellers[0]?.stale).toBe(true);
    expect(inStock?.sellers[1]?.stale).toBeUndefined();
  });

  /*
    A STAND SHUTDOWN OVERRIDES EVERY SELLER. Inherited from `standCardSections` rather than
    re-decided: a closed stand is a locked box, so nothing itemized renders.
  */
  it("renders nothing itemized while the stand is shut", () => {
    expect(
      standCardSellerGroups({
        ...tianTianAndFernhorn,
        closure: { state: "active" },
      } as PublicStandPayload),
    ).toEqual([]);
  });

  it("returns nothing to itemize when no seller claims anything", () => {
    expect(standCardSellerGroups(withSellers([]))).toEqual([]);
    expect(
      standCardSellerGroups(withSellers([seller({ sellerName: "Empty Farm" })])),
    ).toEqual([]);
  });
});
