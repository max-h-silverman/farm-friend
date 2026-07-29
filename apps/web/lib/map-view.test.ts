import { describe, expect, it } from "vitest";
import { buildMapView, type PublicStandPayload } from "./map-view";

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

    it("carries the two properties through for the UI to mark it", () => {
      // The UI needs these to say "order by contact — no stand to visit". Without them it
      // would have to infer the case from a missing address, which is how a renderer ends up
      // printing an empty address line.
      const view = buildMapView([contactOnly], null);
      expect(view.stands[0]!.visitability).toBe("contact_only");
      expect(view.stands[0]!.offeringType).toBe("by_order");
    });
  });
});
