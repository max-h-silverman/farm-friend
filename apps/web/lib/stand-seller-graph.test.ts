import { describe, expect, it } from "vitest";
import {
  markerTipBox,
  sellerStandLinks,
  standSellerLinks,
  standsForSeller,
  type GraphSeller,
  type GraphStand,
} from "./stand-seller-graph";

/*
  The bipartite graph both public lists read (F-118).

  What could be WRONG here is the whole point of testing it: a link that points at a stand the
  map is not showing takes a customer to a card that does not exist; a pin number invented
  rather than looked up sends them to the wrong pin; a seller's own stand described as somebody
  else's is the exact confusion the seller list exists to clear up.
*/

const morganHill: GraphStand = {
  id: "morgan-hill",
  standNumber: 12,
  locationName: "Morgan Hill Stand",
  sellers: [
    {
      providerId: "p-1",
      sellerId: "morgan",
      sellerName: "Morgan Hill",
      describesOwnStand: true,
    },
    {
      providerId: "p-2",
      sellerId: "fernhorn",
      sellerName: "Fernhorn Bakery",
      describesOwnStand: false,
    },
  ],
};

const kelseys: GraphStand = {
  id: "kelsey",
  standNumber: 7,
  locationName: "Kelseys Stand",
  sellers: [
    {
      providerId: "p-3",
      sellerId: "kelseys",
      sellerName: "Kelseys Farm",
      describesOwnStand: true,
    },
    {
      providerId: "p-4",
      sellerId: "fernhorn",
      sellerName: "Fernhorn Bakery",
      describesOwnStand: false,
    },
  ],
};

const fernhorn: GraphSeller = {
  sellerId: "fernhorn",
  sellerName: "Fernhorn Bakery",
  ownsAStand: false,
  sellingAt: [
    {
      salesLocationId: "morgan-hill",
      locationName: "Morgan Hill Stand",
      describesOwnStand: false,
      usualItems: [{ itemName: "Sourdough" }, { itemName: "Baguettes" }],
    },
    {
      salesLocationId: "kelsey",
      locationName: "Kelseys Stand",
      describesOwnStand: false,
      usualItems: [{ itemName: "Sourdough" }],
    },
  ],
};

describe("a seller's stands, as destinations", () => {
  it("carries each stand's own pin number, looked up rather than invented", () => {
    const links = sellerStandLinks(fernhorn, [morganHill, kelseys]);

    expect(links.map((link) => [link.standId, link.standNumber])).toEqual([
      ["morgan-hill", 12],
      ["kelsey", 7],
    ]);
  });

  it("carries what she brings TO EACH STAND, never her pooled list", () => {
    // The per-stand facts are the reason to open the card at all: she brings two things to one
    // stand and one to the other, and a pooled list would claim both at both.
    const links = sellerStandLinks(fernhorn, [morganHill, kelseys]);

    expect(links[0]!.usualItems).toEqual(["Sourdough", "Baguettes"]);
    expect(links[1]!.usualItems).toEqual(["Sourdough"]);
  });

  it("says which stand is her own and which she is a guest at", () => {
    const owner: GraphSeller = {
      sellerId: "kelseys",
      sellerName: "Kelseys Farm",
      ownsAStand: true,
      sellingAt: [
        {
          salesLocationId: "kelsey",
          locationName: "Kelseys Stand",
          describesOwnStand: true,
          usualItems: [],
        },
        {
          salesLocationId: "morgan-hill",
          locationName: "Morgan Hill Stand",
          describesOwnStand: false,
          usualItems: [],
        },
      ],
    };

    const links = sellerStandLinks(owner, [morganHill, kelseys]);

    expect(links.map((link) => link.relation)).toEqual(["own", "guest"]);
  });

  it("keeps a stand the map is not showing, marked as unreachable", () => {
    /*
      A stand can be missing from the pin set for reasons that have nothing to do with the
      seller — a filter is on, or the stand has no coordinate. Dropping it would silently
      shorten "sells at 2 stands" to one and make the count on her card a lie. So it stays,
      named, with no number and no route — the customer is told where she sells and that this
      one is not on the map right now.
    */
    const links = sellerStandLinks(fernhorn, [morganHill]);

    expect(links).toHaveLength(2);
    expect(links[1]!.locationName).toBe("Kelseys Stand");
    expect(links[1]!.standNumber).toBeUndefined();
    expect(links[1]!.onMap).toBe(false);
    expect(links[0]!.onMap).toBe(true);
  });

  it("orders her own stands before the ones she is a guest at", () => {
    // Her own stand is the strongest answer to "where do I find her", so it leads.
    const mixed: GraphSeller = {
      ...fernhorn,
      ownsAStand: true,
      sellingAt: [
        { ...fernhorn.sellingAt[0]!, describesOwnStand: false },
        { ...fernhorn.sellingAt[1]!, describesOwnStand: true },
      ],
    };

    const links = sellerStandLinks(mixed, [morganHill, kelseys]);

    expect(links.map((link) => link.standId)).toEqual(["kelsey", "morgan-hill"]);
  });
});

describe("the stands a seller sells at, as a highlight set", () => {
  it("is every stand she sells at", () => {
    expect(standsForSeller(fernhorn)).toEqual(new Set(["morgan-hill", "kelsey"]));
  });

  it("is empty for no seller, which is what makes no highlight the resting state", () => {
    expect(standsForSeller(undefined)).toEqual(new Set());
  });
});

describe("a stand's sellers, as cross-links", () => {
  it("names every seller at the stand, own stand first", () => {
    const links = standSellerLinks(morganHill);

    expect(links.map((link) => [link.sellerId, link.relation])).toEqual([
      ["morgan", "own"],
      ["fernhorn", "guest"],
    ]);
  });

  it("deduplicates a seller who publishes through two providers at one stand", () => {
    /*
      A stand's `sellers` is a PROVIDER list, and a seller can hold more than one provider row
      at the same stand. The card's cross-link answers "who sells here", which is a question
      about people, so the same name must never appear twice.
    */
    const doubled: GraphStand = {
      ...morganHill,
      sellers: [
        ...morganHill.sellers!,
        {
          providerId: "p-5",
          sellerId: "fernhorn",
          sellerName: "Fernhorn Bakery",
          describesOwnStand: false,
        },
      ],
    };

    expect(standSellerLinks(doubled).map((link) => link.sellerId)).toEqual([
      "morgan",
      "fernhorn",
    ]);
  });

  it("is empty for a stand nobody has been invited to", () => {
    expect(standSellerLinks({ ...morganHill, sellers: undefined })).toEqual([]);
    expect(standSellerLinks({ ...morganHill, sellers: [] })).toEqual([]);
  });
});

/*
  WHERE THE MARKER TOOLTIP SITS.

  The island is drawn inside a fixed viewBox and its figure CLIPS — `.island` is
  `overflow: hidden`. A tooltip centred on its pin runs off the edge for any pin near a shore,
  and Vashon is a long narrow island, so that is most of them. Measured in a browser before this
  existed: a west-shore pin's tooltip lost its whole left half, seller names included.

  The arithmetic is here rather than in the component for the reason all of it is: what could be
  wrong is a box that leaves the island, and a test can hold a number to account where it cannot
  hold a JSX expression.
*/
describe("placing the marker tooltip inside the island", () => {
  const VIEWBOX = { width: 1000, height: 1700 };
  const SIZE = { width: 400, height: 172 };

  it("centres the box on its pin when there is room on both sides", () => {
    const box = markerTipBox({ x: 500, y: 800 }, SIZE, VIEWBOX);

    expect(box.x).toBe(300);
  });

  it("holds the box on the island for a pin against the WEST shore", () => {
    // The failure measured in a browser: x went negative and the figure clipped it away.
    const box = markerTipBox({ x: 40, y: 800 }, SIZE, VIEWBOX);

    expect(box.x).toBeGreaterThanOrEqual(0);
  });

  it("holds the box on the island for a pin against the EAST shore", () => {
    const box = markerTipBox({ x: 980, y: 800 }, SIZE, VIEWBOX);

    expect(box.x + SIZE.width).toBeLessThanOrEqual(VIEWBOX.width);
  });

  it("drops the box BELOW a pin near the top, rather than off the north end", () => {
    /*
      The tooltip sits above its pin so it does not cover the thing it explains. For a pin near
      the north shore there is no room above, and clamping alone would leave the box lying ON the
      pin. It flips underneath instead — still attached, still not covering its own marker.
    */
    const box = markerTipBox({ x: 500, y: 30 }, SIZE, VIEWBOX);

    expect(box.y).toBeGreaterThan(30);
    expect(box.below).toBe(true);
  });

  it("keeps the box above the pin when there is room", () => {
    const box = markerTipBox({ x: 500, y: 800 }, SIZE, VIEWBOX);

    expect(box.y + SIZE.height).toBeLessThan(800);
    expect(box.below).toBe(false);
  });

  it("never leaves the island for a box wider than the map", () => {
    // Degenerate, but the clamp must not invert: a box that cannot fit is pinned to the left
    // edge rather than placed at a negative coordinate that clips its start.
    const box = markerTipBox({ x: 500, y: 800 }, { width: 1400, height: 100 }, VIEWBOX);

    expect(box.x).toBe(0);
  });
});
