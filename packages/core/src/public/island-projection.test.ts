import { describe, expect, it } from "vitest";
import {
  ISLAND_BOUNDS,
  ISLAND_VIEWBOX,
  projectToIsland,
} from "./island-projection";

// F-043 — putting a real coordinate on hand-drawn artwork.
//
// The map is DRAWN, not tiled (max, 2026-07-30): every tile provider bills per map view past a
// free tier on an embed VIGA links publicly, and a fixed island view needs no pan/zoom detail.
// But the pins are NOT hand-placed — they are projected from each stand's real
// `public_latitude` / `public_longitude`, so a pin sits where the farm actually is.
//
// That makes this function the join between real geography and the drawing, and the thing it
// can get wrong is subtle: a pin a few percent off looks perfectly plausible and puts a farm
// on the wrong side of a road. So the assertions below anchor to REAL Vashon landmarks with
// independently known coordinates, not to this function's own output.

describe("projectToIsland", () => {
  it("places a coordinate inside the drawing's viewBox", () => {
    const point = projectToIsland({ latitude: 47.4471, longitude: -122.4594 });

    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.x).toBeLessThanOrEqual(ISLAND_VIEWBOX.width);
    expect(point.y).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeLessThanOrEqual(ISLAND_VIEWBOX.height);
  });

  it("puts NORTH at the top — higher latitude is a SMALLER y", () => {
    // SVG's y axis grows downward while latitude grows northward. Getting this backwards
    // flips the island end for end and is entirely plausible-looking on artwork that is
    // roughly symmetrical, which is exactly why it is asserted rather than eyeballed.
    const north = projectToIsland({ latitude: 47.48, longitude: -122.45 });
    const south = projectToIsland({ latitude: 47.35, longitude: -122.45 });

    expect(north.y).toBeLessThan(south.y);
  });

  it("puts EAST at the right — higher longitude is a LARGER x", () => {
    // Vashon longitudes are all negative, so "larger" means less negative, i.e. further east.
    // A sign slip here mirrors the island left-to-right.
    const east = projectToIsland({ latitude: 47.42, longitude: -122.40 });
    const west = projectToIsland({ latitude: 47.42, longitude: -122.51 });

    expect(east.x).toBeGreaterThan(west.x);
  });

  it("places real Vashon landmarks in their true relative positions", () => {
    // Independently known coordinates for places on the island. The assertions are about
    // RELATIVE geography, which is what a customer reads off a map: the north-end ferry dock
    // is north of town, the south-end dock is at the bottom, Burton sits east of the highway
    // on the Quartermaster peninsula.
    const northFerry = projectToIsland({ latitude: 47.5133, longitude: -122.4636 });
    const town = projectToIsland({ latitude: 47.4471, longitude: -122.4594 });
    const burton = projectToIsland({ latitude: 47.3939, longitude: -122.4649 });
    const southFerry = projectToIsland({ latitude: 47.3428, longitude: -122.5089 });

    // North to south, in order.
    expect(northFerry.y).toBeLessThan(town.y);
    expect(town.y).toBeLessThan(burton.y);
    expect(burton.y).toBeLessThan(southFerry.y);

    // The south-end dock is well west of Burton.
    expect(southFerry.x).toBeLessThan(burton.x);
  });

  it("keeps the aspect ratio honest — the island is not stretched", () => {
    // At 47°N a degree of longitude is only ~0.68 of a degree of latitude in real distance.
    // Projecting lat/lon linearly onto a square would stretch the island noticeably wide.
    // This checks the correction is applied: a span that is square in TRUE distance must come
    // out square on the drawing.
    const centre = ISLAND_BOUNDS.north - (ISLAND_BOUNDS.north - ISLAND_BOUNDS.south) / 2;
    const latDelta = 0.02;
    // The longitude span covering the same ground distance as `latDelta` of latitude.
    const lonDelta = latDelta / Math.cos((centre * Math.PI) / 180);

    const origin = projectToIsland({ latitude: centre, longitude: -122.45 });
    const north = projectToIsland({ latitude: centre + latDelta, longitude: -122.45 });
    const east = projectToIsland({
      latitude: centre,
      longitude: -122.45 + lonDelta,
    });

    const verticalSpan = Math.abs(origin.y - north.y);
    const horizontalSpan = Math.abs(origin.x - east.x);

    // Equal ground distances must render as equal drawing distances, within a percent.
    expect(horizontalSpan).toBeCloseTo(verticalSpan, 0);
    expect(Math.abs(horizontalSpan - verticalSpan) / verticalSpan).toBeLessThan(0.02);
  });

  it("covers every real stand's coordinate", () => {
    // The measured extent of the 32 public stands that carry coordinates, from production on
    // 2026-07-30. Every one must land inside the drawing — a stand projected off-canvas is a
    // farm the customer cannot see, with nothing failing anywhere to say so.
    const corners = [
      { latitude: 47.3453265, longitude: -122.5109633 },
      { latitude: 47.4830376, longitude: -122.3945642 },
      { latitude: 47.3453265, longitude: -122.3945642 },
      { latitude: 47.4830376, longitude: -122.5109633 },
    ];

    for (const corner of corners) {
      const point = projectToIsland(corner);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(ISLAND_VIEWBOX.width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(ISLAND_VIEWBOX.height);
    }
  });

  it("is monotonic — two stands never swap places", () => {
    // Sweeps the real extent. Any non-monotonic step means two farms could render in the
    // wrong order relative to each other, which no single-point check would reveal.
    let previousX = -Infinity;
    for (let lon = ISLAND_BOUNDS.west; lon <= ISLAND_BOUNDS.east; lon += 0.005) {
      const { x } = projectToIsland({ latitude: 47.42, longitude: lon });
      expect(x).toBeGreaterThan(previousX);
      previousX = x;
    }

    let previousY = Infinity;
    for (let lat = ISLAND_BOUNDS.south; lat <= ISLAND_BOUNDS.north; lat += 0.005) {
      const { y } = projectToIsland({ latitude: lat, longitude: -122.45 });
      expect(y).toBeLessThan(previousY);
      previousY = y;
    }
  });

  it("clamps a coordinate outside the island rather than drawing off-canvas", () => {
    // Seattle is well east and north of the bounds. Nothing should ever pass one — the
    // seeder refuses out-of-range coordinates — but a pin escaping the artwork would overlay
    // the page's own layout, so the projection refuses to emit one.
    const seattle = projectToIsland({ latitude: 47.6062, longitude: -122.3321 });

    expect(seattle.x).toBeLessThanOrEqual(ISLAND_VIEWBOX.width);
    expect(seattle.y).toBeGreaterThanOrEqual(0);
    expect(seattle.clamped).toBe(true);
  });

  it("reports an in-bounds coordinate as NOT clamped", () => {
    // The complement, so `clamped` is not passing by always being true.
    const onIsland = projectToIsland({ latitude: 47.4471, longitude: -122.4594 });
    expect(onIsland.clamped).toBe(false);
  });
});
