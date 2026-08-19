import { describe, expect, it } from "vitest";
import {
  markerTipBox,
  markerTipUnitScale,
  sellerSeasonBadge,
  sellerOpenState,
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

/*
  F-118 revision — WHAT THE SELLER CARD SAYS AT REST.

  The card's two facts are both derived from the STANDS she sells at, and neither is a fact the
  seller record carries: a seller has no hours and no season of her own, she has places, and each
  place has both. Deriving them here rather than in the card is what lets a test hold the answer
  to account — and what stops the card inventing a seller-level season that no farmer stated.
*/
describe("whether a seller is open right now", () => {
  /*
    B-083 — THREE ANSWERS, BECAUSE THE FACT HAS THREE STATES.

    The card used to print a boolean, so everything that was not exactly `open` read as
    "Closed" — and 9 of 34 live seller cards were asserting a closure no farmer had made
    (8 stands that stated no hours, 1 by-appointment). That is Golden Rule #1 in the direction
    that matters: publishing a claim the farmer never made, on the strength of a blank column.

    The rule (max, 2026-08-18): **Closed is reserved for out of season, or outside stated
    hours.** A stand that stated nothing is `unknown` — not open, and not closed either.

    This is the same rule `applyStandFilters` already holds one list over
    (`map-view.ts` — *"`open`, `unknown` and `by_appointment` all stay. Only a stand we can
    positively say is shut … is removed."*). Stating it two ways in two lists is what let them
    disagree; the two now agree because `definitelyShut` below is the same set.
  */
  const open: GraphStand = { ...morganHill, id: "a", openState: "open" };
  const shut: GraphStand = { ...kelseys, id: "b", openState: "closed" };
  const unknown: GraphStand = { ...kelseys, id: "c", openState: "unknown" };
  const byAppointment: GraphStand = { ...kelseys, id: "d", openState: "by_appointment" };
  const outOfSeason: GraphStand = { ...kelseys, id: "e", openState: "out_of_season" };
  const closedToday: GraphStand = { ...kelseys, id: "f", openState: "closed_today" };
  const farmerClosed: GraphStand = { ...kelseys, id: "g", openState: "farmer_closed" };

  const atAll = (ids: string[]): GraphSeller => ({
    sellerId: "s",
    sellerName: "S",
    ownsAStand: false,
    sellingAt: ids.map((id) => ({
      salesLocationId: id,
      locationName: id,
      describesOwnStand: false,
      usualItems: [],
    })),
  });

  it("is open when ANY stand she sells at is open", () => {
    // She is buyable wherever any one of them is trading — one open stand is a yes.
    expect(sellerOpenState(atAll(["a", "b"]), [open, shut])).toBe("open");
  });

  it("is closed when every stand she sells at is shut", () => {
    expect(sellerOpenState(atAll(["b"]), [shut])).toBe("closed");
  });

  /*
    THE FOUR STATES THAT MAY PRINT "Closed", each because a farmer stated the fact that shuts
    it. Asserted one at a time rather than as a set: a regression that drops one from the
    closed set would otherwise hide behind the other three.
  */
  it.each([
    ["closed", shut],
    ["out_of_season", outOfSeason],
    ["closed_today", closedToday],
    ["farmer_closed", farmerClosed],
  ])("reads %s as closed, because the farmer stated what shuts it", (_label, stand) => {
    expect(sellerOpenState(atAll([stand.id]), [stand])).toBe("closed");
  });

  it("does NOT call a stand whose hours nobody stated open", () => {
    // `unknown` means the farm said nothing, not that it is trading.
    expect(sellerOpenState(atAll(["c"]), [unknown])).not.toBe("open");
  });

  it("does NOT call a stand whose hours nobody stated CLOSED either (B-083)", () => {
    /*
      The bug this file exists to keep fixed. A blank hours column is not a closure, and
      printing one puts words in the farmer's mouth on the surface customers act on.
    */
    expect(sellerOpenState(atAll(["c"]), [unknown])).toBe("unknown");
  });

  it("reads by-appointment as unknown rather than closed", () => {
    /*
      By-appointment is a real arrangement, not a shut door — she is reachable, the hours are
      simply not a schedule. `applyStandFilters` already keeps it under "Open now" for exactly
      this reason.
    */
    expect(sellerOpenState(atAll(["d"]), [byAppointment])).toBe("unknown");
  });

  it("prefers open over unknown when she sells at both", () => {
    // One stand trading answers the customer's question; the silent one cannot retract it.
    expect(sellerOpenState(atAll(["a", "c"]), [open, unknown])).toBe("open");
  });

  it("prefers unknown over closed when she sells at both", () => {
    /*
      ORDER MATTERS, and this is the case that fixes it. A seller with one shut stand and one
      that stated nothing is not closed — we cannot say she is, because one of her stands never
      told us. Answering "Closed" here is the same false claim in a subtler shape.
    */
    expect(sellerOpenState(atAll(["b", "c"]), [shut, unknown])).toBe("unknown");
  });

  it("is unknown when the map is not showing any of her stands", () => {
    /*
      A stand absent from the pin set cannot contribute. It is NOT evidence of a closure —
      previously this read as Closed, which told the customer something the data never said.
    */
    expect(sellerOpenState(atAll(["gone"]), [open])).toBe("unknown");
  });

  it("is unknown for a seller with no stands at all", () => {
    expect(sellerOpenState(atAll([]), [open])).toBe("unknown");
  });

  it("treats a state nobody has defined yet as unknown, never as closed", () => {
    /*
      The union has seven members today. A new one must not silently join the CLOSED set and
      start asserting closures — the default has to fail toward "we do not know".
    */
    const future: GraphStand = { ...kelseys, id: "h", openState: "sold_out_but_open_tomorrow" };
    expect(sellerOpenState(atAll(["h"]), [future])).toBe("unknown");
  });
});

describe("the tooltip's counter-scale (B-088)", () => {
  /*
    The tooltip lives inside the island SVG, so its font sizes are viewBox units scaled by the
    map's rendered size. On a 390px phone that put "Runs this stand" at 6.6 real pixels — text
    that got SMALLER as the screen did. These assert the inverse relationship that fixes it.
  */
  it("makes the box wider in island units as the map renders smaller", () => {
    // A 390px-wide map is 0.39 units-to-pixels, so the box must span ~2.56x the units.
    expect(markerTipUnitScale(0.39)).toBeCloseTo(2.564, 2);
    expect(markerTipUnitScale(0.7)).toBeCloseTo(1.428, 2);
  });

  it("never shrinks the tooltip below its designed size", () => {
    // A map rendered WIDER than its viewBox would otherwise scale the box down, making the
    // designed size a ceiling rather than a floor.
    expect(markerTipUnitScale(1.2)).toBe(1);
    expect(markerTipUnitScale(1)).toBe(1);
  });

  it("falls back to the designed size for a scale nothing has measured yet", () => {
    // First paint, before the ref has a box. A NaN or zero here would produce an Infinity-wide
    // foreignObject and blank the map.
    expect(markerTipUnitScale(0)).toBe(1);
    expect(markerTipUnitScale(Number.NaN)).toBe(1);
    expect(markerTipUnitScale(-1)).toBe(1);
  });
});

describe("the seller's season badge", () => {
  const yearRound: GraphStand = {
    ...morganHill,
    id: "a",
    availability: { season: { kind: "year_round" } },
  };
  const untilNovember: GraphStand = {
    ...kelseys,
    id: "b",
    availability: { season: { kind: "date_range", endMonth: 11, endDay: 24 } },
  };
  const summerOnly: GraphStand = {
    ...kelseys,
    id: "c",
    availability: { season: { kind: "date_range", endMonth: 8, endDay: 31 } },
  };

  const at = (ids: string[]): GraphSeller => ({
    sellerId: "s",
    sellerName: "S",
    ownsAStand: false,
    sellingAt: ids.map((id) => ({
      salesLocationId: id,
      locationName: id,
      describesOwnStand: false,
      usualItems: [],
    })),
  });

  it("says year-round when any stand she sells at is year-round", () => {
    expect(sellerSeasonBadge(at(["a", "c"]), [yearRound, summerOnly])).toBe("year-round");
  });

  it("says thru late November for a stand that runs that late", () => {
    expect(sellerSeasonBadge(at(["b"]), [untilNovember])).toBe("late-november");
  });

  /*
    THE LONGEST SEASON WINS, because the badge answers "how long can I buy from her" and she is
    buyable wherever any of her stands is open. A badge taken from the first stand in the list
    would make the same seller read differently depending on stand ordering.
  */
  it("takes the LONGEST season across her stands, not the first", () => {
    expect(sellerSeasonBadge(at(["c", "a"]), [summerOnly, yearRound])).toBe("year-round");
    expect(sellerSeasonBadge(at(["c", "b"]), [summerOnly, untilNovember])).toBe(
      "late-november",
    );
  });

  it("says nothing when no stand of hers stated a season that qualifies", () => {
    // Absent, never a guess. A stand with a summer range has said something true that neither
    // badge describes, and inventing a third badge here would be the card stating a season no
    // farmer chose.
    expect(sellerSeasonBadge(at(["c"]), [summerOnly])).toBeUndefined();
  });
});
