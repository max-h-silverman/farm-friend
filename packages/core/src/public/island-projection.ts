// F-043 — projecting a real coordinate onto the hand-drawn island.
//
// The map is DRAWN, not tiled (max, 2026-07-30). Every tile provider bills per map view past
// a free tier, on an embed VIGA links publicly, for pan/zoom detail a fixed island view does
// not need — and drawn artwork matches VIGA's printed poster, which tiles cannot. This
// introduces NO runtime mapping-provider seam; `maps/README.md` records that there is
// deliberately none, and this file does not add one.
//
// But the pins are not hand-placed. Each one is projected from the stand's real
// `public_latitude` / `public_longitude`, so it sits where the farm actually is. That makes
// this the join between real geography and the drawing, and the failure it must not have is
// the quiet one: a pin a few percent off looks entirely plausible while putting a farm on the
// wrong side of the highway.

/** A drawing coordinate, in the artwork's own viewBox units. */
export interface IslandPoint {
  x: number;
  y: number;
  /**
   * True when the input fell outside the island and was pulled to the edge.
   *
   * Surfaced rather than silent: the seeder refuses out-of-range coordinates, so nothing
   * should ever be clamped in practice, and a caller seeing this is looking at a data defect
   * rather than a drawing decision.
   */
  clamped: boolean;
}

/**
 * The geographic box the artwork covers.
 *
 * Sized to contain the REAL coastline with a small margin, not merely the stands. The traced
 * shoreline (`apps/web/lib/island-geometry.ts`) spans 47.331–47.511 N and -122.528 to
 * -122.374 W; the earlier, tighter box was drawn around the farm extent and would clip the
 * island's own west shore and southern tip into straight edges.
 *
 * The 32 public stands that carry coordinates (47.345–47.483 N, -122.511 to -122.395 W,
 * production 2026-07-30) sit comfortably inside this, as do both ferry docks — landmarks a
 * customer orients by even though no stand is at either.
 */
export const ISLAND_BOUNDS = {
  north: 47.517,
  south: 47.326,
  west: -122.534,
  east: -122.368,
} as const;

/**
 * The artwork's viewBox.
 *
 * Height is derived from the bounds and the latitude correction below rather than chosen, so
 * the drawing cannot drift out of proportion with the projection that puts pins on it.
 */
const LATITUDE_SPAN = ISLAND_BOUNDS.north - ISLAND_BOUNDS.south;
const LONGITUDE_SPAN = ISLAND_BOUNDS.east - ISLAND_BOUNDS.west;

/**
 * How much a degree of longitude shrinks at this latitude.
 *
 * At 47°N a degree of longitude covers only about 0.68 of the ground distance a degree of
 * latitude does. Projecting the two linearly onto the same scale stretches the island wide —
 * subtly enough to look like a stylistic choice rather than an error, which is why it is
 * corrected here and asserted in the tests.
 */
const CENTRE_LATITUDE = (ISLAND_BOUNDS.north + ISLAND_BOUNDS.south) / 2;
const LONGITUDE_SCALE = Math.cos((CENTRE_LATITUDE * Math.PI) / 180);

export const ISLAND_VIEWBOX = {
  width: 1000,
  // The true-distance aspect ratio of the bounding box, so a mile north and a mile east are
  // the same number of drawing units.
  height: Math.round(
    (1000 * LATITUDE_SPAN) / (LONGITUDE_SPAN * LONGITUDE_SCALE),
  ),
} as const;

/**
 * Put a real coordinate on the drawing.
 *
 * An equirectangular projection with the standard cosine correction — appropriate because the
 * area is tiny (about 13 miles by 6) and the alternative, a conformal projection, would differ
 * by far less than the width of a pin while being harder to reason about against artwork.
 *
 * Y is INVERTED: latitude grows north, SVG's y axis grows down.
 */
export function projectToIsland(coordinate: {
  latitude: number;
  longitude: number;
}): IslandPoint {
  const { latitude, longitude } = coordinate;

  const rawX =
    ((longitude - ISLAND_BOUNDS.west) / LONGITUDE_SPAN) * ISLAND_VIEWBOX.width;
  const rawY =
    ((ISLAND_BOUNDS.north - latitude) / LATITUDE_SPAN) * ISLAND_VIEWBOX.height;

  const x = Math.min(ISLAND_VIEWBOX.width, Math.max(0, rawX));
  const y = Math.min(ISLAND_VIEWBOX.height, Math.max(0, rawY));

  return { x, y, clamped: x !== rawX || y !== rawY };
}

/** A real coordinate, as the database stores it. */
export interface IslandCoordinate {
  latitude: number;
  longitude: number;
}

/**
 * Read a point on the drawing back as a real coordinate — the pin drop (F-067).
 *
 * A farmer onboarding a visitable stand has to supply a coordinate pair, because
 * `coherentVisitability` refuses a visitable location without one. There is no geocoder to
 * turn their typed address into a pin and there deliberately never will be: a runtime
 * geocoder/map package is a named non-goal, and every address-lookup service bills per call
 * on top of placing pins in the wrong driveway. So the farmer points at the island instead,
 * which they know better than any lookup does.
 *
 * **This is the exact algebraic inverse of `projectToIsland`, and must stay that way.** The
 * two are one statement about where the island is, read in opposite directions. Writing this
 * as its own mapping — even a correct-looking one — would recreate exactly the failure the
 * header of this file warns about: two independent guesses at the geography that drift apart,
 * putting a farm on the wrong side of the highway with every test still green.
 *
 * Clamped to the bounds for the same reason the forward direction is: a tap that lands
 * slightly off the artwork must not become a pin in Puget Sound. `coherentVisitability` only
 * checks that the numbers are PRESENT, so it would accept one.
 */
export function unprojectFromIsland(point: {
  x: number;
  y: number;
}): IslandCoordinate {
  const x = Math.min(ISLAND_VIEWBOX.width, Math.max(0, point.x));
  const y = Math.min(ISLAND_VIEWBOX.height, Math.max(0, point.y));

  const longitude =
    ISLAND_BOUNDS.west + (x / ISLAND_VIEWBOX.width) * LONGITUDE_SPAN;
  const latitude =
    ISLAND_BOUNDS.north - (y / ISLAND_VIEWBOX.height) * LATITUDE_SPAN;

  return { latitude, longitude };
}
