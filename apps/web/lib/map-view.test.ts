import { describe, expect, it } from "vitest";
import {
  buildMapView,
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

  it("ignores a garbage origin rather than ranking from it", () => {
    const view = buildMapView(stands, { latitude: Number.NaN, longitude: 0 });
    expect(view.sortedByDistance).toBe(false);
    expect(view.stands.map((s) => s.id)).toEqual(["fresh-far", "stale-near"]);
  });

  it("counts stale listings so the UI can warn once, up front", () => {
    expect(buildMapView(stands, null).staleCount).toBe(1);
    expect(buildMapView([stands[0]!], null).staleCount).toBe(0);
  });

  it("handles an empty map without inventing anything", () => {
    const view = buildMapView([], ORIGIN);
    expect(view.stands).toEqual([]);
    expect(view.staleCount).toBe(0);
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
      items: [],
    };

    it("is kept on the map", () => {
      const view = buildMapView([...stands, unconfirmed], null);
      expect(view.stands.map((s) => s.id)).toContain("unconfirmed");
    });

    it("is NOT counted as stale", () => {
      // "Stale" means a farmer confirmed something and it has aged. Nothing was confirmed
      // here, so counting it would inflate the up-front warning and tell customers a
      // listing went out of date when no listing ever existed.
      expect(buildMapView([unconfirmed], null).staleCount).toBe(0);
      expect(buildMapView([...stands, unconfirmed], null).staleCount).toBe(1);
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

    it("is NOT counted as stale", () => {
      expect(buildMapView([contactOnly], null).staleCount).toBe(0);
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
        usuallySells: ["salad greens", "tomatoes", "flowers"],
      };

      const view = buildMapView([tagged], null);

      expect(view.stands[0]!.usuallySells).toEqual([
        "salad greens",
        "tomatoes",
        "flowers",
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
        usuallySells: ["eggs"],
        items: [],
      };

      const view = buildMapView([tagged], null);

      expect(view.staleCount).toBe(0);
      expect(view.stands[0]!.updated).toBeUndefined();
      expect(view.stands[0]!.stale).toBeUndefined();
    });
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
      usuallySells: ["salad greens", "tomatoes", "flowers"],
    };

    it("renders the approved 'Usually sells' line, with the tags in order", () => {
      const lines = standListingLines(tagged);

      const usual = lineOfKind(lines, "usual");
      expect(usual).toBeDefined();
      expect(usual!.label).toBe("Usually sells:");
      expect(usual!.items).toEqual(["salad greens", "tomatoes", "flowers"]);
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

  describe("a farmer has confirmed, and the stand also has tags", () => {
    const both: PublicStandPayload = {
      ...base,
      usuallySells: ["salad greens", "tomatoes", "flowers", "eggs"],
      updated: "updated 4 hours ago",
      confirmedElapsed: "4 hours ago",
      stale: false,
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
        usuallySells: ["salad greens", "tomatoes"],
      });

      expect(lineOfKind(covered, "usual")).toBeUndefined();
      expect(lineOfKind(covered, "confirmed")!.items).toEqual([
        "salad greens",
        "tomatoes",
      ]);
    });

    it("matches a tag to a confirmed item case-insensitively", () => {
      // The tags are seeded from VIGA's form text and the confirmations come from a farmer's
      // SMS. Nothing normalizes casing between the two, so an exact-string subtraction would
      // print "Tomatoes" under both headings.
      const usual = lineOfKind(
        standListingLines({
          ...both,
          usuallySells: ["Salad Greens", "TOMATOES", "flowers"],
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
        usuallySells: ["lamb shares"],
      });

      expect(lineOfKind(lines, "usual")!.items).toEqual(["lamb shares"]);
      expect(lineOfKind(lines, "no-listing")).toBeUndefined();
    });
  });
});
