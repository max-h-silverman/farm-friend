import { describe, expect, it } from "vitest";
import {
  applyStandFilters,
  buildMapView,
  mapMarkerKind,
  numberStands,
  hoistStand,
  sortStandsByNumber,
  standListingLines,
  type PublicStandPayload,
  type StandListingLine,
} from "./map-view";

// F-017 — the public map's view model.
//
// The UI is a rendering of this. Everything that could be WRONG about the map — a stale
// listing quietly hidden, a distance presented as a route, a stand pinned at a fabricated
// coordinate — is decided here, where it can be tested, rather than inside JSX.

const stands: PublicStandPayload[] = [
  {
    id: "fresh-far",
    farmName: "Alpha Farm",
    locationName: "Alpha Stand",
    visitability: "visitable",
    offeringType: "produce",
    address: "1 North Road",
    latitude: 47.6,
    longitude: -122.4594,
    updated: "updated 2 hours ago",
    stale: false,
    availability: {},
    alsoSellingHere: [],
    links: [],
    paymentMethods: [],
    items: [{ itemName: "Kale", quantity: 6, unit: "bunches" }],
  },
  {
    id: "stale-near",
    farmName: "Beta Farm",
    locationName: "Beta Stand",
    visitability: "visitable",
    offeringType: "produce",
    address: "2 South Road",
    latitude: 47.45,
    longitude: -122.4594,
    updated: "updated 9 days ago",
    stale: true,
    availability: {},
    alsoSellingHere: [],
    links: [],
    paymentMethods: [],
    items: [{ itemName: "Potatoes" }],
  },
];

const ORIGIN = { latitude: 47.4471, longitude: -122.4594 };

describe("buildMapView", () => {
  it("keeps every stand visible without an origin", () => {
    const view = buildMapView(stands, null);
    expect(view.stands.map((s) => s.id)).toEqual(["fresh-far", "stale-near"]);
    expect(view.sortedByDistance).toBe(false);
  });

  it("sorts nearest-first once an origin is available", () => {
    const view = buildMapView(stands, ORIGIN);
    expect(view.stands.map((s) => s.id)).toEqual(["stale-near", "fresh-far"]);
    expect(view.sortedByDistance).toBe(true);
    expect(view.stands[0]!.distanceLabel).toMatch(/miles? away$/);
  });

  it("NEVER hides a stale stand — it stays listed and flagged", () => {
    // The product rule, asserted where it could actually be broken. A "cleaner" map that
    // drops old listings is the failure mode the honor-system reality forbids: on an island
    // of unattended stands, "Beta had potatoes 9 days ago" beats a blank space.
    for (const origin of [null, ORIGIN]) {
      const view = buildMapView(stands, origin);
      const beta = view.stands.find((s) => s.id === "stale-near");
      expect(beta, String(origin)).toBeDefined();
      expect(beta!.stale).toBe(true);
      expect(beta!.items.map((i) => i.itemName)).toEqual(["Potatoes"]);
    }
  });

  it("carries the server's recency wording through unchanged", () => {
    // Web and SMS must agree. The label is rendered ONCE, by core, on the server; the
    // client re-wording it is how the two channels would drift apart.
    const view = buildMapView(stands, ORIGIN);
    expect(view.stands.map((s) => s.updated).sort()).toEqual([
      "updated 2 hours ago",
      "updated 9 days ago",
    ]);
  });

  it("carries owner-confirmed seller names separately from inventory", () => {
    const named = {
      ...stands[0]!,
      alsoSellingHere: ["Guest Growers", "Island Apiary"],
    };
    const view = buildMapView([named], null);

    expect(view.stands[0]!.alsoSellingHere).toEqual([
      "Guest Growers",
      "Island Apiary",
    ]);
    expect(view.stands[0]!.items).toEqual([
      { itemName: "Kale", quantity: 6, unit: "bunches" },
    ]);
  });

  it("gives every stand a destination-only routing link", () => {
    const view = buildMapView(stands, ORIGIN);
    for (const stand of view.stands) {
      expect(stand.routingLink).not.toBeNull();
      expect(stand.routingLink!).not.toContain("origin");
      // Even with an origin in hand, the customer's position is never put in the link.
      expect(stand.routingLink!).not.toContain("47.4471");
    }
  });

  it("offers no routing link for a stand with an unusable coordinate", () => {
    // Seeding should make this impossible, but a link to 0,0 would send someone to the
    // Atlantic. Absent beats wrong.
    const broken = [{ ...stands[0]!, latitude: Number.NaN }];
    const view = buildMapView(broken, null);
    expect(view.stands[0]!.routingLink).toBeNull();
  });

  it("offers NO routing link for a farm with no stand to visit (F-088)", () => {
    // THE PROTECTION THAT REPLACES THE OLD CONSTRAINT.
    //
    // F-038 kept a contact-only farm off the map by forbidding it a coordinate. F-088 lets it
    // be placed — so the thing that actually sends someone driving, the directions link, is
    // suppressed here instead. Without this, relaxing the constraint would reintroduce exactly
    // the defect it was built to prevent: turn-by-turn navigation to a farm with nothing to buy.
    //
    // The PIN survives. The farm is findable, carries its own "Farm, no stand" marker, and its
    // card says there is no stand to visit — what it does not do is invite the drive.
    const delivery = [
      { ...stands[0]!, visitability: "contact_only" as const },
    ];
    const view = buildMapView(delivery, ORIGIN);

    expect(view.stands[0]!.routingLink).toBeNull();
    expect(view.stands[0]!.latitude).toBeDefined();
    expect(view.stands[0]!.longitude).toBeDefined();
  });

  it("offers NO routing link when the farmer hid their address (F-088)", () => {
    // The link is built from the COORDINATE, not the address string — so hiding the address
    // does not suppress it on its own, and without this the "get directions" button would
    // still hand a customer turn-by-turn navigation to the farmer's front door. That is the
    // whole of what hiding an address is meant to prevent, so the suppression is explicit.
    //
    // The PIN survives: the stand keeps its coordinates and stays on the map. What goes away
    // is the printed address and the route to it.
    const hidden = [{ ...stands[0]!, address: undefined }];
    const view = buildMapView(hidden, ORIGIN);

    expect(view.stands[0]!.routingLink).toBeNull();
    expect(view.stands[0]!.latitude).toBeDefined();
    expect(view.stands[0]!.longitude).toBeDefined();
  });

  it("ignores a garbage origin rather than ranking from it", () => {
    const view = buildMapView(stands, { latitude: Number.NaN, longitude: 0 });
    expect(view.sortedByDistance).toBe(false);
    expect(view.stands.map((s) => s.id)).toEqual(["fresh-far", "stale-near"]);
  });

  it("handles an empty map without inventing anything", () => {
    const view = buildMapView([], ORIGIN);
    expect(view.stands).toEqual([]);
    expect(view.sortedByDistance).toBe(false);
  });

  describe("a stand nobody has confirmed yet (B-013)", () => {
    // B-002 seeds VIGA's stands with zero inventory, so `updated`/`stale` are ABSENT rather
    // than stale-but-present. The view model must not treat "never confirmed" as "fresh".
    const unconfirmed: PublicStandPayload = {
      id: "unconfirmed",
      farmName: "Gamma Farm",
      locationName: "Gamma Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "3 East Road",
      latitude: 47.46,
      longitude: -122.4594,
      availability: {},
      alsoSellingHere: [],
    links: [],
    paymentMethods: [],
      items: [],
    };

    it("is kept on the map", () => {
      const view = buildMapView([...stands, unconfirmed], null);
      expect(view.stands.map((s) => s.id)).toContain("unconfirmed");
    });

    it("is NOT marked stale", () => {
      // "Stale" means a farmer confirmed something and it has aged. Nothing was confirmed
      // here, so flagging it would tell a customer a listing went out of date when no
      // listing ever existed. The card reads this flag to age its dated line.
      expect(buildMapView([unconfirmed], null).stands[0]!.stale).toBeUndefined();
      const mixed = buildMapView([...stands, unconfirmed], null);
      expect(mixed.stands.filter((stand) => stand.stale === true)).toHaveLength(1);
    });

    it("still gets a routing link — location is known even when stock is not", () => {
      // The address and coordinates come from the seed and are real. Whether anyone has
      // confirmed produce is a different question from whether the stand can be found.
      const view = buildMapView([unconfirmed], null);
      expect(view.stands[0]!.routingLink).not.toBeNull();
    });

    it("carries no recency fields to render", () => {
      const view = buildMapView([unconfirmed], null);
      expect(view.stands[0]!.updated).toBeUndefined();
      expect(view.stands[0]!.stale).toBeUndefined();
    });
  });

  describe("a farm you contact rather than visit (F-038)", () => {
    // Open Gate Lamb: sells by order, no stand, no address, no coordinates. Listed on the map
    // by max's decision (2026-07-29) — clearly marked, not hidden — because a VIGA member
    // absent from the island's only guide is invisible.
    //
    // Distinct from B-013 above in the way that matters here: an unconfirmed stand HAS a
    // location and only lacks stock, so it still gets a routing link. This one has no location
    // at all, so a routing link would be a route to nowhere.
    const contactOnly: PublicStandPayload = {
      id: "contact-only",
      farmName: "Open Gate Lamb and Grazing",
      locationName: "Open Gate Lamb and Grazing",
      visitability: "contact_only",
      offeringType: "by_order",
      availability: {},
      alsoSellingHere: [],
    links: [],
    paymentMethods: [],
      items: [],
    };

    it("is kept on the map", () => {
      const view = buildMapView([...stands, contactOnly], null);
      expect(view.stands.map((s) => s.id)).toContain("contact-only");
    });

    it("gets NO routing link, because there is nowhere to route to", () => {
      // The concrete harm this prevents: `Number(null)` is 0, so the un-fixed reader produced
      // coordinates 0,0 — a pin in the Atlantic Ocean off Africa — and a routing link that
      // would navigate a customer toward it.
      const view = buildMapView([contactOnly], null);
      expect(view.stands[0]!.routingLink).toBeNull();
    });

    it("gets no distance even when the customer shared a position", () => {
      // Distance from a known point to an unknown one is not a number. Emitting 0, or a
      // distance computed against 0,0, would sort this farm to the top as the "nearest".
      const view = buildMapView([...stands, contactOnly], ORIGIN);
      const stand = view.stands.find((s) => s.id === "contact-only")!;
      expect(stand.distanceMiles).toBeUndefined();
      expect(stand.distanceLabel).toBeUndefined();
    });

    it("never sorts ahead of real stands when distances are known", () => {
      // The ordering consequence of the previous test. A contact-only farm has no distance,
      // so it must fall BEHIND every stand that has one rather than leading the list.
      const view = buildMapView([...stands, contactOnly], ORIGIN);
      expect(view.stands[view.stands.length - 1]!.id).toBe("contact-only");
    });

    it("is NOT marked stale", () => {
      expect(buildMapView([contactOnly], null).stands[0]!.stale).toBeUndefined();
    });

    it("shows published stock when it has some — the two facts are independent", () => {
      // max's decision, 2026-07-29: ANY farm may participate in SMS inventory. Open Gate Lamb
      // sells goods with real seasonal availability ("butchering in July and November"), so
      // "no place to visit" must never be read as "nothing to publish". A view model that
      // suppressed items for contact-only farms would silently remove a farmer's published
      // listing — Golden Rule #1 territory, since only the farmer owns that state.
      const withStock: PublicStandPayload = {
        ...contactOnly,
        updated: "updated 2 hours ago",
        stale: false,
        availability: {},
        items: [{ itemName: "Lamb shares", priceText: "$180 half" }],
      };

      const view = buildMapView([withStock], null);

      expect(view.stands[0]!.items.map((i) => i.itemName)).toEqual([
        "Lamb shares",
      ]);
      expect(view.stands[0]!.updated).toBe("updated 2 hours ago");
      // Still no route, though — stock and location remain independent.
      expect(view.stands[0]!.routingLink).toBeNull();
    });

    it("carries the two properties through for the UI to mark it", () => {
      // The UI needs these to say "order by contact — no stand to visit". Without them it
      // would have to infer the case from a missing address, which is how a renderer ends up
      // printing an empty address line.
      const view = buildMapView([contactOnly], null);
      expect(view.stands[0]!.visitability).toBe("contact_only");
      expect(view.stands[0]!.offeringType).toBe("by_order");
    });
  });

  describe("what a stand usually sells (F-042)", () => {
    it("carries the usual offerings through for the listing to render", () => {
      const tagged: PublicStandPayload = {
        ...stands[0]!,
        usuallySells: [
          { itemName: "salad greens" },
          // F-090 — a priced item travels whole. The price reaches the wire format as its own
          // field and is joined onto the item only in `standListingLines`, so a client that
          // wants to render it differently still can.
          { itemName: "tomatoes", priceText: "$4/lb" },
          { itemName: "flowers" },
        ],
      };

      const view = buildMapView([tagged], null);

      expect(view.stands[0]!.usuallySells).toEqual([
        { itemName: "salad greens" },
        { itemName: "tomatoes", priceText: "$4/lb" },
        { itemName: "flowers" },
      ]);
    });

    it("does NOT count a tagged, unconfirmed stand as stale", () => {
      // Staleness is a property of a CONFIRMATION. A tag nobody confirmed cannot be stale,
      // and counting it would put it in the up-front "N listings have not been confirmed
      // recently" notice — which claims a confirmation exists and has aged.
      const tagged: PublicStandPayload = {
        id: "tagged-unconfirmed",
        farmName: "Gamma Farm",
        locationName: "Gamma Stand",
        visitability: "visitable",
        offeringType: "produce",
        address: "3 East Road",
        latitude: 47.5,
        longitude: -122.46,
        usuallySells: [{ itemName: "eggs" }],
        availability: {},
        alsoSellingHere: [],
    links: [],
    paymentMethods: [],
        items: [],
      };

      const view = buildMapView([tagged], null);

      expect(view.stands[0]!.updated).toBeUndefined();
      expect(view.stands[0]!.stale).toBeUndefined();
    });
  });
});

describe("map marker language", () => {
  const stand = (overrides: Partial<PublicStandPayload> = {}): PublicStandPayload => ({
    ...stands[0]!,
    usuallySells: [{ itemName: "vegetables" }],
    ...overrides,
  });

  it("uses the existing map categories from structured facts", () => {
    expect(mapMarkerKind(stand())).toBe("seasonal");
    expect(
      mapMarkerKind(stand({ availability: { season: { kind: "year_round" } } })),
    ).toBe("year-round");
    expect(
      mapMarkerKind(
        stand({
          farmBucksAccepted: false,
          usuallySells: [{ itemName: "fresh flowers" }, { itemName: "lavender" }],
        }),
      ),
    ).toBe("flower-only");
    expect(
      mapMarkerKind(
        stand({
          farmBucksAccepted: false,
          usuallySells: [{ itemName: "lavender" }, { itemName: "wreaths" }, { itemName: "essential oil" }],
        }),
      ),
    ).toBe("flower-only");
    expect(
      mapMarkerKind(stand({ locationKind: "farmers_market" })),
    ).toBe("farmers-market");
    expect(
      mapMarkerKind(stand({ visitability: "contact_only" })),
    ).toBe("contact-only");
  });

  it("does not call a mixed flower-and-produce listing flower-only", () => {
    expect(
      mapMarkerKind(
        stand({
          farmBucksAccepted: false,
          usuallySells: [{ itemName: "flowers" }, { itemName: "vegetables" }],
        }),
      ),
    ).toBe("seasonal");
    expect(
      mapMarkerKind(
        stand({
          usuallySells: [{ itemName: "flowers" }],
        }),
      ),
    ).toBe("seasonal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// F-042 — the listing lines.
//
// WHY THIS IS A PURE FUNCTION AND NOT JSX. The copy max approved rests on one rule: the
// "Usually sells" line NEVER carries a timestamp, because a date beside it reads as a
// confirmation and undoes the honesty the product is built on. A rule that load-bearing has
// to be a tested invariant, and a conditional buried in a component nothing renders in a
// test is not one. `standListingLines` owns the decision; the component prints its output.
//
// Every assertion below is anchored to the VALUE of a specific line — its `kind` and its
// `label` — never to a substring found somewhere in the whole block. A test that searched
// the rendered text for "Usually sells" would pass just as happily with the timestamp
// attached to it, which is the one thing being guarded.
describe("standListingLines (F-042)", () => {
  const base: PublicStandPayload = {
    id: "gamma",
    farmName: "Gamma Farm",
    locationName: "Gamma Stand",
    visitability: "visitable",
    offeringType: "produce",
    address: "3 East Road",
    latitude: 47.5,
    longitude: -122.46,
    availability: {},
    alsoSellingHere: [],
    links: [],
    paymentMethods: [],
    items: [],
  };

  /** The one line of a given kind, or undefined — asserting on kinds, not on prose. */
  function lineOfKind(
    lines: readonly StandListingLine[],
    kind: StandListingLine["kind"],
  ): StandListingLine | undefined {
    return lines.find((line) => line.kind === kind);
  }

  describe("tags, and nobody has confirmed anything (all 33 tagged stands today)", () => {
    const tagged: PublicStandPayload = {
      ...base,
      usuallySells: [{ itemName: "salad greens" }, { itemName: "tomatoes" }, { itemName: "flowers" }],
    };

    it("renders the approved 'Usually sells' line, with the tags in order", () => {
      const lines = standListingLines(tagged);

      const usual = lineOfKind(lines, "usual");
      expect(usual).toBeDefined();
      expect(usual!.label).toBe("Usually sells:");
      expect(usual!.items).toEqual(["salad greens", "tomatoes", "flowers"]);
    });

    it("renders a stated price beside its own item, and nothing beside the others", () => {
      // F-090. Anchored to the whole `items` array, so an implementation that appended every
      // price to every item — or to the label — fails rather than passing on a substring.
      const priced = standListingLines({
        ...base,
        usuallySells: [
          { itemName: "eggs", priceText: "$6/dozen" },
          { itemName: "tomatoes" },
          { itemName: "flowers", priceText: "$5 a bunch" },
        ],
      });

      const usual = lineOfKind(priced, "usual")!;
      expect(usual.items).toEqual(["eggs $6/dozen", "tomatoes", "flowers $5 a bunch"]);
    });

    it("keeps a price OFF the usual line's label and detail", () => {
      // The same load-bearing rule the timestamp test guards, one field over: the heading is
      // constant copy, and a price leaking into it would read as VIGA's claim rather than the
      // farmer's. `detail` stays absent because a price is not a confirmation.
      const usual = lineOfKind(
        standListingLines({
          ...base,
          usuallySells: [{ itemName: "eggs", priceText: "$6/dozen" }],
        }),
        "usual",
      )!;

      expect(usual.label).toBe("Usually sells:");
      expect(usual.detail).toBeUndefined();
    });

    it("NEVER puts a timestamp on the usual line — the load-bearing rule", () => {
      // Asserted on the line's own fields rather than on the absence of a string anywhere in
      // the block: a `detail` on THIS line is what would read as a confirmation. The stand
      // below also carries no confirmation at all, so there is no timestamp to leak — the
      // "both" case below re-asserts the same rule where one genuinely exists.
      const usual = lineOfKind(standListingLines(tagged), "usual")!;

      expect(usual.detail).toBeUndefined();
      expect(usual.label).not.toMatch(/ago|updated|confirmed/i);
    });

    it("says plainly that nothing has been confirmed", () => {
      const lines = standListingLines(tagged);

      const nothing = lineOfKind(lines, "nothing-confirmed");
      expect(nothing).toBeDefined();
      expect(nothing!.label).toBe("Nothing confirmed recently.");
      expect(nothing!.items).toBeUndefined();
    });

    it("puts availability before typical offerings, as it does for current stock", () => {
      expect(standListingLines(tagged).map((line) => line.kind)).toEqual([
        "nothing-confirmed",
        "usual",
      ]);
    });

    it("does NOT fall back to 'No listing yet' — the two facts are different", () => {
      // The bug this item was filed for. Every tagged stand rendered the untagged copy, so
      // the database's 212 tags were invisible. Anchored to the ABSENCE of that line kind.
      expect(lineOfKind(standListingLines(tagged), "no-listing")).toBeUndefined();
    });

    it("offers nothing for the stock-out flow to attach to", () => {
      // Rule 2. Reporting "the tomatoes are out" against a tag nobody confirmed is noise for
      // the farmer, so the confirmed-item set a stock-out form would key on is EMPTY here
      // even though three items are on screen.
      expect(standListingLines(tagged).flatMap((line) => line.reportableItems ?? [])).toEqual(
        [],
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  // A confirmation that has aged out (max, 2026-08-10).
  //
  // `readPublicStands` withholds the recency fields once a confirmation passes the display
  // threshold, so an expired stand arrives here shaped EXACTLY like a never-confirmed one.
  // These tests pin the consequence at this layer: no "In stock" heading, no item list under
  // it, and nothing for the stock-out flow to attach to.
  //
  // Asserted on line KINDS rather than on rendered prose, matching the rest of this block: a
  // test searching the text for "In stock" would pass just as happily with the heading still
  // present above an empty list.
  describe("a confirmation has aged past the display threshold", () => {
    // No `confirmedElapsed` and no `cardRecency` — what the reader now produces for an
    // expired row. `items` is deliberately still populated: the stand items are real rows,
    // and the rule under test is that nothing renders them as CURRENT STOCK without a date.
    const expired: PublicStandPayload = {
      ...base,
      usuallySells: [{ itemName: "salad greens" }, { itemName: "flowers" }],
      items: [{ itemName: "salad greens" }, { itemName: "tomatoes" }],
    };

    it("renders NO confirmed line — the bug: 'In stock' over a 90-day-old claim", () => {
      const lines = standListingLines(expired);

      expect(lineOfKind(lines, "confirmed")).toBeUndefined();
      expect(lineOfKind(lines, "confirmed-empty")).toBeUndefined();
    });

    it("never prints an item list as current stock", () => {
      // The sharp version. `items` is non-empty, so an implementation that kept rendering the
      // list and merely dropped the caption would fail here rather than pass on the heading
      // check above.
      expect(
        standListingLines(expired).some((line) => line.kind === "confirmed"),
      ).toBe(false);
      expect(
        standListingLines(expired).flatMap((line) => line.items ?? []),
      ).not.toContain("tomatoes");
    });

    it("falls through to the specialties and 'Nothing confirmed recently.'", () => {
      // Not blanked. The stand keeps everything that is still honestly known about it — the
      // honor-system rule that stale listings stay VISIBLE, just not asserted as stock.
      const lines = standListingLines(expired);

      const usual = lineOfKind(lines, "usual");
      expect(usual).toBeDefined();
      expect(usual!.label).toBe("Usually sells:");
      expect(usual!.items).toEqual(["salad greens", "flowers"]);
      expect(lineOfKind(lines, "nothing-confirmed")!.label).toBe(
        "Nothing confirmed recently.",
      );
    });

    it("offers nothing for the stock-out flow to attach to", () => {
      // Rule 2, at the far end of the age range. Reporting "the tomatoes are out" against a
      // claim nobody has confirmed in a month is noise for the farmer, not a signal.
      expect(
        standListingLines(expired).flatMap((line) => line.reportableItems ?? []),
      ).toEqual([]);
    });

    it("does NOT fall back to 'No listing yet' when the stand has specialties", () => {
      expect(lineOfKind(standListingLines(expired), "no-listing")).toBeUndefined();
    });

    it("says 'No listing yet' for an expired stand with no specialties either", () => {
      // Nothing honestly known at all: the expired confirmation is not evidence, and there
      // are no tags behind it. This is the same copy a genuinely untouched stand gets.
      const bare = standListingLines({ ...expired, usuallySells: [] });

      expect(lineOfKind(bare, "confirmed")).toBeUndefined();
      expect(lineOfKind(bare, "no-listing")).toBeDefined();
    });
  });

  describe("a farmer has confirmed, and the stand also has tags", () => {
    const both: PublicStandPayload = {
      ...base,
      usuallySells: [{ itemName: "salad greens" }, { itemName: "tomatoes" }, { itemName: "flowers" }, { itemName: "eggs" }],
      updated: "updated 4 hours ago",
      confirmedElapsed: "4 hours ago",
      stale: false,
      availability: {},
      items: [{ itemName: "salad greens" }, { itemName: "tomatoes" }],
    };

    it("leads with the approved 'Confirmed X ago' line", () => {
      const confirmed = lineOfKind(standListingLines(both), "confirmed");

      expect(confirmed).toBeDefined();
      expect(confirmed!.label).toBe("Confirmed 4 hours ago:");
      expect(confirmed!.items).toEqual(["salad greens", "tomatoes"]);
    });

    it("puts the confirmed line FIRST — the certain fact leads", () => {
      expect(standListingLines(both)[0]!.kind).toBe("confirmed");
    });

    it("renders the remaining tags as 'Also usually sells', subtracting the confirmed", () => {
      const usual = lineOfKind(standListingLines(both), "usual");

      expect(usual).toBeDefined();
      expect(usual!.label).toBe("Also usually sells:");
      // The two confirmed items are NOT repeated: seeing "tomatoes" under both headings
      // reads as two separate facts about tomatoes.
      expect(usual!.items).toEqual(["flowers", "eggs"]);
    });

    it("STILL puts no timestamp on the usual line, with a real one in hand", () => {
      // The sharp version of the load-bearing rule. Here a timestamp genuinely exists and is
      // rendered one line above, so the failure mode is live: reusing it on the usual line
      // would claim the farmer confirmed the flowers and eggs too.
      const usual = lineOfKind(standListingLines(both), "usual")!;

      expect(usual.detail).toBeUndefined();
      expect(usual.label).toBe("Also usually sells:");
      expect(usual.label).not.toMatch(/ago|updated|confirmed/i);
    });

    it("drops the usual line entirely when the confirmation covers every tag", () => {
      // "Also usually sells:" with nothing after it is a broken line, and a label with an
      // empty list is how that ships.
      const covered = standListingLines({
        ...both,
        usuallySells: [{ itemName: "salad greens" }, { itemName: "tomatoes" }],
      });

      expect(lineOfKind(covered, "usual")).toBeUndefined();
      expect(lineOfKind(covered, "confirmed")!.items).toEqual([
        "salad greens",
        "tomatoes",
      ]);
    });

    it("does NOT case-fold, because the two lists are one vocabulary now (F-066)", () => {
      // This test used to assert the opposite, and the inversion is the point of F-066.
      //
      // Before: the usual list came from `sales_location_offerings` and the confirmed list
      // from `inventory_entries`, two tables sharing no vocabulary, so this function
      // case-folded to stop "Tomatoes" printing under both headings. That fold was the data
      // model's missing reconciliation done in the view.
      //
      // Now both lists are a STAND ITEM's words: the usual list is the items marked as
      // standing claims, and a confirmed item is rendered in its item's `display_name`
      // (resolved in `readPublicStands`). A differently-cased pair reaching here means the
      // join upstream is broken — and this function must let that show rather than hide it,
      // because a silent fold here would mask the breakage for as long as it lasted.
      const usual = lineOfKind(
        standListingLines({
          ...both,
          usuallySells: [{ itemName: "Salad Greens" }, { itemName: "TOMATOES" }, { itemName: "flowers" }],
        }),
        "usual",
      )!;

      expect(usual.items).toEqual(["Salad Greens", "TOMATOES", "flowers"]);
    });

    it("subtracts a confirmed item from the usual list when they are one vocabulary", () => {
      // The behaviour that actually protects the card, stated in the terms that now hold:
      // identical words, because both sides are the same stand item.
      const usual = lineOfKind(
        standListingLines({
          ...both,
          usuallySells: [{ itemName: "salad greens" }, { itemName: "tomatoes" }, { itemName: "flowers" }],
        }),
        "usual",
      )!;

      expect(usual.items).toEqual(["flowers"]);
    });

    it("exposes ONLY the confirmed items to the stock-out flow", () => {
      // Rule 2, in the case that can actually get it wrong: four items are on screen and
      // exactly two are reportable.
      const reportable = standListingLines(both).flatMap(
        (line) => line.reportableItems ?? [],
      );

      expect(reportable).toEqual(["salad greens", "tomatoes"]);
      expect(reportable).not.toContain("flowers");
      expect(reportable).not.toContain("eggs");
    });

    it("says nothing about a confirmation when there are tags but no elapsed phrase", () => {
      // Defensive, and it guards a real shape: the server omits the recency fields TOGETHER
      // for an unconfirmed stand (B-013). If a future payload carried `items` with no
      // elapsed phrase, "Confirmed :" is the line that would ship. It must not.
      const lines = standListingLines({
        ...both,
        updated: undefined,
        confirmedElapsed: undefined,
        stale: undefined,
      });

      expect(lineOfKind(lines, "confirmed")).toBeUndefined();
      for (const line of lines) {
        expect(line.label).not.toMatch(/confirmed \w*:/i);
      }
    });
  });

  describe("a confirmed stand with no tags at all", () => {
    it("renders the confirmed line and no usual line", () => {
      const lines = standListingLines({
        ...base,
        updated: "updated 2 hours ago",
        confirmedElapsed: "2 hours ago",
        stale: false,
        availability: {},
        items: [{ itemName: "kale" }],
      });

      expect(lineOfKind(lines, "confirmed")!.label).toBe("Confirmed 2 hours ago:");
      expect(lineOfKind(lines, "usual")).toBeUndefined();
      expect(lineOfKind(lines, "nothing-confirmed")).toBeUndefined();
      expect(lineOfKind(lines, "no-listing")).toBeUndefined();
    });

    it("renders the confirmed-empty fact rather than inventing tags", () => {
      // A farmer who confirms an empty stand has said something real, and it is not the same
      // as "no listing yet". The date stays; the item list is empty.
      const lines = standListingLines({
        ...base,
        updated: "updated 1 hour ago",
        confirmedElapsed: "1 hour ago",
        stale: false,
        availability: {},
        items: [],
      });

      expect(lineOfKind(lines, "confirmed-empty")).toBeDefined();
      expect(lineOfKind(lines, "confirmed-empty")!.detail).toBe("1 hour ago");
      expect(lineOfKind(lines, "usual")).toBeUndefined();
      expect(lineOfKind(lines, "no-listing")).toBeUndefined();
    });
  });

  describe("neither tags nor a confirmation (the 2 untagged stands)", () => {
    it("keeps 'No listing yet' — it is still true there", () => {
      // Rule 3. This is the ONE case where the old copy is honest, and it must not quietly
      // become "usually sells nothing."
      const lines = standListingLines(base);

      expect(lineOfKind(lines, "no-listing")).toBeDefined();
      expect(lineOfKind(lines, "usual")).toBeUndefined();
      expect(lineOfKind(lines, "confirmed")).toBeUndefined();
    });

    it("treats an EMPTY tag array as no tags, not as a usual line with nothing in it", () => {
      // `usuallySells: []` is what a reader gets from a stand whose offerings join found
      // nothing, depending on how the server encodes it. "Usually sells:" followed by
      // nothing is worse than the honest fallback.
      const lines = standListingLines({ ...base, usuallySells: [] });

      expect(lineOfKind(lines, "usual")).toBeUndefined();
      expect(lineOfKind(lines, "no-listing")).toBeDefined();
    });

    it("keeps the contact-only wording for a farm with nowhere to visit", () => {
      // F-038's copy is a different fact from "No listing yet", and F-042 must not flatten
      // it: there is no stand that "may still have produce out".
      const lines = standListingLines({
        ...base,
        visitability: "contact_only",
        offeringType: "by_order",
        address: undefined,
        latitude: undefined,
        longitude: undefined,
      });

      expect(lineOfKind(lines, "contact-only")).toBeDefined();
      expect(lineOfKind(lines, "no-listing")).toBeUndefined();
    });

    it("prefers the tags over the contact-only fallback when a by-order farm has them", () => {
      // A farm you contact CAN have specialties — "lamb shares", "butchering in November".
      // Saying "contact this farm to ask what's available" while the database knows it sells
      // lamb throws away the more useful fact.
      const lines = standListingLines({
        ...base,
        visitability: "contact_only",
        offeringType: "by_order",
        address: undefined,
        latitude: undefined,
        longitude: undefined,
        usuallySells: [{ itemName: "lamb shares" }],
      });

      expect(lineOfKind(lines, "usual")!.items).toEqual(["lamb shares"]);
      expect(lineOfKind(lines, "no-listing")).toBeUndefined();
    });
  });
});

describe("applyStandFilters (F-043)", () => {
  // The four filters plus season, composed. All client-side over data already served — no new
  // model call, and the public surface stays model-free.
  //
  // THE RULE UNDER TEST THROUGHOUT (max, 2026-07-30): a stand that never stated its
  // availability is SHOWN under "Open now", marked unconfirmed — never hidden, never reported
  // closed. Production has 13 of 34 public stands partly unstated, so a filter that excluded
  // them would empty the most useful control of a third of the island on the strength of
  // something no farmer ever said.

  const JULY_NOON = new Date("2026-07-15T12:00:00-07:00");
  const PDT = -7 * 60;

  function stand(
    id: string,
    overrides: Partial<PublicStandPayload> = {},
  ): PublicStandPayload {
    return {
      id,
      farmName: `${id} Farm`,
      locationName: `${id} Stand`,
      visitability: "visitable",
      offeringType: "produce",
      address: `${id} Road`,
      latitude: 47.44,
      longitude: -122.46,
      availability: {},
      alsoSellingHere: [],
    links: [],
    paymentMethods: [],
      items: [],
      ...overrides,
    };
  }

  const openAllDay = {
    season: { kind: "year_round" },
    hours: { kind: "all_day" },
  } as const;
  const closedForTheYear = {
    season: {
      kind: "date_range",
      startMonth: 11,
      startDay: 1,
      endMonth: 12,
      endDay: 31,
    },
    hours: { kind: "all_day" },
  } as const;

  const ask = (
    stands: PublicStandPayload[],
    filters: Parameters<typeof applyStandFilters>[1],
  ) =>
    applyStandFilters(stands, filters, { at: JULY_NOON, utcOffsetMinutes: PDT });

  it("returns every stand when no filter is active", () => {
    const all = [stand("a"), stand("b", { availability: closedForTheYear })];

    const result = ask(all, {});

    expect(result.map((s) => s.id)).toEqual(["a", "b"]);
  });

  describe("open now", () => {
    it("keeps an open stand and drops one that is closed for the year", () => {
      const all = [
        stand("open", { availability: openAllDay }),
        stand("shut", { availability: closedForTheYear }),
      ];

      const result = ask(all, { openNow: true });

      expect(result.map((s) => s.id)).toEqual(["open"]);
    });

    it("KEEPS a stand that never stated its availability, marked unconfirmed", () => {
      // The decision this feature turns on. `unstated` said nothing; excluding it would
      // assert a closure no farmer made.
      const all = [
        stand("open", { availability: openAllDay }),
        stand("unstated", { availability: {} }),
      ];

      const result = ask(all, { openNow: true });

      expect(result.map((s) => s.id)).toEqual(["open", "unstated"]);
      // And the UI must be able to TELL them apart, or "shown" becomes "shown as open",
      // which is the same lie by a different route.
      expect(result.find((s) => s.id === "open")!.openState).toBe("open");
      expect(result.find((s) => s.id === "unstated")!.openState).toBe("unknown");
    });

    it("keeps a stand that stated a season but no hours", () => {
      // Production's most common partial shape — 8 of 34 stands.
      const all = [
        stand("season-only", {
          availability: { season: { kind: "year_round" } },
        }),
      ];

      const result = ask(all, { openNow: true });

      expect(result.map((s) => s.id)).toEqual(["season-only"]);
      expect(result[0]!.openState).toBe("unknown");
    });

    it("keeps a by-appointment stand rather than reporting it shut", () => {
      // Reporting `closed` hides a farm that would happily sell to someone today.
      const all = [
        stand("appointment", {
          availability: {
            season: { kind: "year_round" },
            hours: { kind: "by_appointment" },
          },
        }),
      ];

      const result = ask(all, { openNow: true });

      expect(result.map((s) => s.id)).toEqual(["appointment"]);
      expect(result[0]!.openState).toBe("by_appointment");
    });

    it("drops a dusk stand at night and keeps it at midday", () => {
      // The computed sun, reaching the filter. Same stand, same season, two times of day.
      const duskStand = [
        stand("dusk", {
          availability: {
            season: { kind: "year_round" },
            hours: { kind: "dawn_to_dusk" },
          },
        }),
      ];

      const atNoon = applyStandFilters(
        duskStand,
        { openNow: true },
        { at: JULY_NOON, utcOffsetMinutes: PDT },
      );
      const atMidnight = applyStandFilters(
        duskStand,
        { openNow: true },
        { at: new Date("2026-07-15T01:00:00-07:00"), utcOffsetMinutes: PDT },
      );

      expect(atNoon.map((s) => s.id)).toEqual(["dusk"]);
      expect(atMidnight).toEqual([]);
    });
  });

  describe("confirmed recently", () => {
    it("keeps only stands a farmer has confirmed and that are not stale", () => {
      const all = [
        stand("fresh", { updated: "updated 2 hours ago", stale: false }),
        stand("stale", { updated: "updated 9 days ago", stale: true }),
        stand("never"),
      ];

      const result = ask(all, { confirmedRecently: true });

      expect(result.map((s) => s.id)).toEqual(["fresh"]);
    });

    it("excludes a never-confirmed stand without treating it as stale", () => {
      // B-013's distinction, preserved through the filter: "never confirmed" and "confirmed
      // long ago" are different facts and `stale` is absent rather than false for the first.
      const all = [stand("never")];

      expect(ask(all, { confirmedRecently: true })).toEqual([]);
      expect(all[0]!.stale).toBeUndefined();
    });
  });

  describe("what they sell", () => {
    it("matches a confirmed item", () => {
      const all = [
        stand("has", { items: [{ itemName: "Tomatoes" }] }),
        stand("hasnt", { items: [{ itemName: "Kale" }] }),
      ];

      const result = ask(all, { sells: "tomatoes" });

      expect(result.map((s) => s.id)).toEqual(["has"]);
    });

    it("matches a usual offering tag as well as a confirmed item", () => {
      // The 212 tags F-042 made visible are the main thing there is to filter on — only one
      // stand in production has ever had a confirmation.
      const all = [
        stand("tagged", { usuallySells: [{ itemName: "duck eggs" }, { itemName: "flowers" }] }),
        stand("other", { usuallySells: [{ itemName: "lamb" }] }),
      ];

      const result = ask(all, { sells: "eggs" });

      expect(result.map((s) => s.id)).toEqual(["tagged"]);
    });

    it("does not treat participant names as item provenance", () => {
      const all = [
        stand("host", { alsoSellingHere: ["Island Apiary"] }),
        stand("inventory", { items: [{ itemName: "Apiary honey" }] }),
      ];

      expect(ask(all, { sells: "apiary" }).map((s) => s.id)).toEqual(["inventory"]);
    });

    it("is case-insensitive and matches partial words", () => {
      // Tags come from VIGA's form text and confirmations from a farmer's own SMS; nothing
      // normalizes casing between them, and a customer types "egg" not "duck eggs".
      const all = [stand("a", { usuallySells: [{ itemName: "Duck Eggs" }] })];

      expect(ask(all, { sells: "EGG" }).map((s) => s.id)).toEqual(["a"]);
      expect(ask(all, { sells: "duck" }).map((s) => s.id)).toEqual(["a"]);
    });

    it("ignores a blank or whitespace-only query rather than matching nothing", () => {
      const all = [stand("a"), stand("b")];

      expect(ask(all, { sells: "" }).map((s) => s.id)).toEqual(["a", "b"]);
      expect(ask(all, { sells: "   " }).map((s) => s.id)).toEqual(["a", "b"]);
    });

    it("matches the stand's own name", () => {
      // Someone who knows where they are going searches the name, not the produce. The map
      // is the island's stand directory, so a name that is on the card has to be findable.
      const all = [
        stand("pinecone", { locationName: "Pinecone Gardens" }),
        stand("bart", { locationName: "Bart's Cart" }),
      ];

      expect(ask(all, { sells: "pinecone" }).map((s) => s.id)).toEqual(["pinecone"]);
      expect(ask(all, { sells: "bart" }).map((s) => s.id)).toEqual(["bart"]);
    });

    it("matches the farm name even when the stand is named differently", () => {
      // A farm's name and its stand's name are separate facts and often differ. Both appear
      // on the card, so searching either has to work.
      const all = [
        stand("a", { farmName: "Plum Forest Farm", locationName: "The Red Shed" }),
        stand("b", { farmName: "Sylvan Garden", locationName: "Sylvan Stand" }),
      ];

      expect(ask(all, { sells: "plum forest" }).map((s) => s.id)).toEqual(["a"]);
      expect(ask(all, { sells: "red shed" }).map((s) => s.id)).toEqual(["a"]);
    });

    it("still does not treat participant names as searchable", () => {
      // The existing rule, restated against the widened haystack: a host stand carrying
      // "Island Apiary" as a participant must not answer a search for it. Widening search to
      // NAMES must not quietly widen it to every name on the card.
      const all = [
        stand("host", { alsoSellingHere: ["Island Apiary"] }),
        stand("inventory", { items: [{ itemName: "Apiary honey" }] }),
      ];

      expect(ask(all, { sells: "apiary" }).map((s) => s.id)).toEqual(["inventory"]);
    });
  });

  describe("payment and stand-type filters", () => {
    it("keeps only stands explicitly reviewed as accepting VIGA Bucks", () => {
      const all = [
        stand("accepts", { farmBucksAccepted: true }),
        stand("declines", { farmBucksAccepted: false }),
        stand("unknown"),
      ];

      expect(ask(all, { acceptsFarmBucks: true }).map((s) => s.id)).toEqual([
        "accepts",
      ]);
    });

    it("identifies flower-only stands from their published usual offerings", () => {
      const all = [
        stand("flowers", { usuallySells: [{ itemName: "fresh flowers" }, { itemName: "lavender" }] }),
        stand("mixed", { usuallySells: [{ itemName: "flowers" }, { itemName: "vegetables" }] }),
        stand("unknown"),
      ];

      expect(ask(all, { flowersOnly: true }).map((s) => s.id)).toEqual([
        "flowers",
      ]);
    });

    it("composes VIGA Bucks and flower-only filters", () => {
      const all = [
        stand("eligible", {
          farmBucksAccepted: true,
          usuallySells: [{ itemName: "cut flowers" }, { itemName: "wreaths" }],
        }),
        stand("no-bucks", {
          farmBucksAccepted: false,
          usuallySells: [{ itemName: "cut flowers" }],
        }),
      ];

      expect(
        ask(all, { acceptsFarmBucks: true, flowersOnly: true }).map((s) => s.id),
      ).toEqual(["eligible"]);
    });
  });

  describe("season", () => {
    it("keeps stands whose season covers the chosen one", () => {
      const all = [
        stand("summer", {
          availability: {
            season: { kind: "named_season", names: ["summer"] },
          },
        }),
        stand("winter", {
          availability: {
            season: { kind: "named_season", names: ["winter"] },
          },
        }),
        stand("always", { availability: { season: { kind: "year_round" } } }),
      ];

      const result = ask(all, { season: "summer" });

      // Year-round covers every season, so it belongs in the answer.
      expect(result.map((s) => s.id)).toEqual(["summer", "always"]);
    });

    it("keeps a stand with no stated season rather than hiding it", () => {
      // Same honesty rule as "open now": absence is not an exclusion.
      const all = [stand("unstated", { availability: {} })];

      expect(ask(all, { season: "summer" }).map((s) => s.id)).toEqual(["unstated"]);
    });

    it("matches a date range against the chosen season's months", () => {
      const all = [
        stand("may-oct", {
          availability: {
            season: {
              kind: "date_range",
              startMonth: 5,
              startDay: 1,
              endMonth: 10,
              endDay: 31,
            },
          },
        }),
      ];

      expect(ask(all, { season: "summer" }).map((s) => s.id)).toEqual(["may-oct"]);
      expect(ask(all, { season: "winter" })).toEqual([]);
    });
  });

  it("composes filters — every active one must pass", () => {
    const all = [
      stand("both", {
        availability: openAllDay,
        usuallySells: [{ itemName: "eggs" }],
      }),
      stand("open-only", { availability: openAllDay, usuallySells: [{ itemName: "lamb" }] }),
      stand("sells-only", {
        availability: closedForTheYear,
        usuallySells: [{ itemName: "eggs" }],
      }),
    ];

    const result = ask(all, { openNow: true, sells: "eggs" });

    expect(result.map((s) => s.id)).toEqual(["both"]);
  });

  it("preserves the incoming order, which is the server's confirmation ordering", () => {
    // Filtering must not resort. The server puts confirmed stands first, and distance sorting
    // is the customer's own separate choice.
    const all = [stand("c"), stand("a"), stand("b")];

    expect(ask(all, {}).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });
});

describe("numberStands (F-043 — the poster's numbered pins)", () => {
  // VIGA's printed farm map numbers every stand and keys the pin to a list entry. Adopting
  // that is what this covers, and it has ONE failure mode worth a test file: a number that
  // means a different farm depending on where the customer is standing.
  //
  // Our list re-sorts by distance when a customer shares location; the poster's never moves.
  // So the number is assigned ALPHABETICALLY BY FARM and is a property of the farm — the
  // sort reorders cards and renumbers nothing. A positional number would silently relabel
  // every pin the moment someone tapped "Sort by distance", which is worse than no number:
  // it would look authoritative and be wrong.

  const numbered = (...names: string[]) =>
    numberStands(
      names.map((name, index) => ({
        ...stands[0]!,
        id: `id-${index}`,
        farmName: name,
        locationName: `${name} Stand`,
      })),
    );

  it("numbers alphabetically by farm name, from 1", () => {
    const view = numbered("Zephyr Farm", "Alpha Farm", "Meadow Farm");

    expect(
      view.map((stand) => [stand.farmName, stand.standNumber]),
    ).toEqual([
      ["Zephyr Farm", 3],
      ["Alpha Farm", 1],
      ["Meadow Farm", 2],
    ]);
  });

  it("keeps a farm's number identical when the list is reordered", () => {
    // THE ASSERTION THIS EXISTS FOR — the distance-sort case, stated as an invariant rather
    // than by re-running the sort: same farms, different input order, same numbers.
    const byName = numbered("Zephyr Farm", "Alpha Farm", "Meadow Farm");
    const byDistance = numbered("Meadow Farm", "Zephyr Farm", "Alpha Farm");

    const numberOf = (view: typeof byName, farmName: string) =>
      view.find((stand) => stand.farmName === farmName)?.standNumber;

    for (const farmName of ["Alpha Farm", "Meadow Farm", "Zephyr Farm"]) {
      expect(numberOf(byDistance, farmName), farmName).toBe(
        numberOf(byName, farmName),
      );
    }
  });

  it("gives every stand a distinct number, including duplicate farm names", () => {
    // Two stands can share a farm name — a farm with two locations. Ties must still resolve
    // to distinct numbers, or two pins claim the same list entry.
    const view = numbered("Same Farm", "Same Farm", "Other Farm");
    const assigned = view.map((stand) => stand.standNumber).sort();

    expect(assigned).toEqual([1, 2, 3]);
  });

  it("keeps duplicate-named stands stable when the list is reordered", () => {
    // Asserting distinctness above is NOT enough: a sort with no tiebreak still yields
    // distinct numbers, because it falls back to input order. That makes the number
    // positional again for exactly the farms most likely to be confused — two stands with
    // the same name. Reorder the same stands and each id must keep its number.
    const twoLocations = (order: readonly string[]) =>
      numberStands(
        order.map((id) => ({
          ...stands[0]!,
          id,
          farmName: id === "other" ? "Other Farm" : "Same Farm",
        })),
      );

    const first = twoLocations(["north", "south", "other"]);
    const second = twoLocations(["other", "south", "north"]);

    const numberOf = (view: typeof first, id: string) =>
      view.find((stand) => stand.id === id)?.standNumber;

    for (const id of ["north", "south", "other"]) {
      expect(numberOf(second, id), id).toBe(numberOf(first, id));
    }
  });

  it("orders a directory by the stable poster number", () => {
    const numbered = numberStands([
      { id: "c", farmName: "Cedar Farm" },
      { id: "a", farmName: "Apple Farm" },
      { id: "b", farmName: "Birch Farm" },
    ]);

    expect(sortStandsByNumber([numbered[0]!, numbered[2]!, numbered[1]!]).map((s) => s.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("numbers a contact-only farm too, though it gets no pin", () => {
    // F-038 — no coordinate means no pin, but the stand is still IN the list and still needs
    // its own number, or the numbering skips and every later entry is off by one.
    const view = numberStands([
      { ...stands[0]!, id: "a", farmName: "Alpha Farm" },
      {
        ...stands[0]!,
        id: "b",
        farmName: "Beta Farm",
        latitude: undefined,
        longitude: undefined,
      },
      { ...stands[0]!, id: "c", farmName: "Gamma Farm" },
    ]);

    expect(view.map((stand) => stand.standNumber)).toEqual([1, 2, 3]);
  });
});

describe("hoistStand", () => {
  const stands = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("moves the named stand to the front, keeping the rest in order", () => {
    expect(hoistStand(stands, "c").map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(hoistStand(stands, "b").map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("leaves a list whose first stand is already selected untouched", () => {
    expect(hoistStand(stands, "a").map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("returns the original order when nothing is selected", () => {
    expect(hoistStand(stands, null).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("never drops a stand when the selection is not in the list", () => {
    // A selection can outlive a filter change that removes its stand. Silently dropping the
    // whole list, or the selected row, would empty the directory for a stale id.
    expect(hoistStand(stands, "filtered-out").map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the list it was given", () => {
    const original = [...stands];
    hoistStand(stands, "c");
    expect(stands).toEqual(original);
  });

  // SVG HAS NO Z-INDEX — paint order IS stacking order, so the only way to put the selected
  // pin in front of the ones that overlap it is to render it last. Same move as the directory
  // hoist, opposite end, which is why it is a parameter rather than a second function.
  describe("to the end", () => {
    it("moves the named stand to the end, keeping the rest in order", () => {
      expect(hoistStand(stands, "a", "end").map((s) => s.id)).toEqual(["b", "c", "a"]);
      expect(hoistStand(stands, "b", "end").map((s) => s.id)).toEqual(["a", "c", "b"]);
    });

    it("leaves a list whose last stand is already selected untouched", () => {
      expect(hoistStand(stands, "c", "end").map((s) => s.id)).toEqual(["a", "b", "c"]);
    });

    it("never drops a stand for an absent or empty selection", () => {
      expect(hoistStand(stands, null, "end").map((s) => s.id)).toEqual(["a", "b", "c"]);
      expect(hoistStand(stands, "filtered-out", "end").map((s) => s.id)).toEqual([
        "a",
        "b",
        "c",
      ]);
    });
  });
});
