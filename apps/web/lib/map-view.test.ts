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
});
