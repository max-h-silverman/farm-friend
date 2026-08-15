import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ISLAND_VIEWBOX,
  projectToIsland,
} from "@farm-friend/core/island-projection";
import {
  ISLAND_HIGHWAY,
  ISLAND_PLACES,
  ISLAND_ROADS,
  ISLAND_SHORELINE,
  ISLAND_WOODS,
  projectedShoreline,
} from "./island-geometry";

// F-043 — the artwork has to agree with the geography it is drawn for.
//
// WHY THIS FILE EXISTS: the first version of the coastline passed every test in the suite —
// the projection was correct, the pins were inside the viewBox, every unit test was green —
// and SIXTEEN OF THIRTY-TWO real sellers rendered in open water. Nothing could catch it,
// because every existing test checked the projection against itself rather than checking the
// artwork against the projection.
//
// The bug class is specific and worth naming: a drawn map and projected pins are TWO
// statements about where the island is. They agree only if something makes them, and until
// this file nothing did. A coastline that is merely plausible looks completely fine in
// isolation; it is only wrong relative to the coordinates landing on it.
//
// So this test is the join. It takes the REAL coordinates of the public stands and asserts
// each one falls inside the polygon the artwork actually draws.

/** Ray-casting point-in-polygon, on the same projected coordinates the browser gets. */
function isInside(
  point: { x: number; y: number },
  polygon: readonly { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const straddles = a.y > point.y !== b.y > point.y;
    if (
      straddles &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Every public stand's real coordinate, from production on 2026-07-30.
 *
 * A FIXTURE OF REAL DATA, deliberately — not generated, not sampled from the bounds. The
 * defect this file was written for was invisible to synthetic points near the island's
 * centre, and only the actual west-shore and Maury sellers exposed it. Transcribed from
 * `select name, public_latitude, public_longitude from sales_locations where is_public`.
 */
const REAL_STANDS: readonly (readonly [string, number, number])[] = [
  ["Useful Bear Farm", 47.483, -122.4681],
  ["Forest Garden Farm", 47.4794, -122.4685],
  ["Farmstad", 47.4728, -122.4898],
  ["3 Brothers Outpost", 47.4676, -122.4548],
  ["Littlest Bird Farm", 47.4649, -122.48],
  ["Northbourne Farm", 47.4566, -122.4489],
  ["Green Ears", 47.4549, -122.4875],
  ["Vashon Island Farmers Market", 47.4481, -122.4607],
  ["Sweet Alyssum Farm", 47.4471, -122.4535],
  ["Venison Valley Farm & Creamery", 47.4315, -122.4571],
  ["Twisting Tree Farm", 47.4273, -122.5006],
  ["Plum Forest Farm", 47.4252, -122.4692],
  ["Provo Farms", 47.4233, -122.4455],
  ["Seedrain.org and Garden Cycles LLC", 47.4217, -122.4375],
  ["Fruits des Vignes Farm", 47.4206, -122.4759],
  ["Narwhal Farm", 47.4143, -122.464],
  ["Morgan Hill Community Farm Stand", 47.409, -122.4575],
  ["Peach Tree Hill", 47.4083, -122.5007],
  ["Ostara Farm & Flowers", 47.4081, -122.511],
  ["Sherman Creek Farm", 47.4073, -122.4464],
  ["Aeggy's Farm", 47.4072, -122.5096],
  ["Holmestead Farms", 47.398, -122.4738],
  ["Lavender Hill Farm", 47.3908, -122.4686],
  ["Pacific Crest Farm", 47.3907, -122.4251],
  ["Bart's Cart", 47.3901, -122.5101],
  ["Tian Tian Farm", 47.3882, -122.5027],
  ["Flora Hill", 47.388, -122.3946],
  ["Olive Farm", 47.3838, -122.4373],
  ["Bananas Barn", 47.3826, -122.4989],
  ["Alta Rosa Farm", 47.3794, -122.5004],
  ["Vashon Garlic", 47.3663, -122.4574],
  ["Peak Moon Nursery", 47.3453, -122.5052],
];

/** Great-circle metres. Roads are checked in real distance, not in drawing units. */
function haversineMetres(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): number {
  const R = 6_371_000;
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(toLat - fromLat);
  const dLon = toRad(toLon - fromLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * How far a point lies outside the drawn coastline, in metres. Zero when inside.
 *
 * Needed because the shoreline is simplified at ~25m, so a genuine waterfront road sits a few
 * metres outside a polygon that is itself an approximation. Without this the on-land test would
 * fail on correct data, and the honest fix is to measure the miss rather than loosen the test.
 */
function metresFromShore(lat: number, lon: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ISLAND_SHORELINE.length; i++) {
    const [aLat, aLon] = ISLAND_SHORELINE[i]!;
    const [bLat, bLon] = ISLAND_SHORELINE[(i + 1) % ISLAND_SHORELINE.length]!;
    // Locally flat is exact enough at island scale, and keeps the projection out of it.
    const scale = Math.cos((lat * Math.PI) / 180);
    const ax = aLon * scale;
    const ay = aLat;
    const bx = bLon * scale;
    const by = bLat;
    const px = lon * scale;
    const py = lat;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t =
      lengthSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    const nearLat = ay + t * dy;
    const nearLon = (ax + t * dx) / scale;
    best = Math.min(best, haversineMetres(lat, lon, nearLat, nearLon));
  }
  return best;
}

describe("the island artwork agrees with the projection", () => {
  it("draws a closed shape with enough vertices to be an island", () => {
    expect(ISLAND_SHORELINE.length).toBeGreaterThan(20);
  });

  it("puts EVERY real farm stand on land, not in the water", () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Reported as a list rather than failing on the first
    // one, because "which sellers are wrong" is what tells you whether the coastline is off in
    // one place or systematically too narrow — the difference between a nudge and a retrace.
    const polygon = projectedShoreline();
    const inWater = REAL_STANDS.filter(([, latitude, longitude]) => {
      const point = projectPoint(latitude, longitude);
      return !isInside(point, polygon);
    }).map(([name]) => name);

    expect(inWater).toEqual([]);
  });

  it("keeps every real farm stand inside the drawing", () => {
    // Weaker than the land check above and kept anyway: a pin outside the viewBox does not
    // merely look wrong, it overlays the embedding page's own layout.
    for (const [name, latitude, longitude] of REAL_STANDS) {
      const point = projectPoint(latitude, longitude);
      expect(point.x, name).toBeGreaterThanOrEqual(0);
      expect(point.x, name).toBeLessThanOrEqual(ISLAND_VIEWBOX.width);
      expect(point.y, name).toBeGreaterThanOrEqual(0);
      expect(point.y, name).toBeLessThanOrEqual(ISLAND_VIEWBOX.height);
    }
  });

  it("keeps EVERY road on land, never crossing open water", () => {
    // The roads are the other thing drawn from coordinates, and they can be wrong the same way
    // a pin can. An earlier highway ran straight from Burton to the Tahlequah dock and drew
    // the road floating across Quartermaster Harbour — the single detail on this map an
    // islander would spot instantly. Sampled ALONG each segment, not just at the vertices,
    // because a road can have both endpoints on land and still cut a corner over the water.
    //
    // Covers the secondary arteries too (F-070). Sampling density follows LENGTH rather than a
    // fixed count per segment: Vashon Highway has one legitimately straight 7km span, and ten
    // samples across it would check one point every 700m — wide enough to miss an inlet
    // entirely. Every road is checked at roughly 100m.
    //
    // The 25m tolerance is the SHORELINE's own resolution, not slack for the roads. The coast
    // is simplified at ~25m, so a genuine waterfront road (Quartermaster Drive, the highway at
    // Portage) sits a few metres outside a polygon that is itself approximate. Anything beyond
    // that is a road in the water, which is the defect this test exists for.
    const polygon = projectedShoreline();
    const offLand: string[] = [];

    const named: { name: string; line: readonly (readonly [number, number])[] }[] = [
      { name: "Vashon Highway", line: ISLAND_HIGHWAY },
      ...ISLAND_ROADS.map((road) => ({ name: road.name, line: road.line })),
    ];

    for (const road of named) {
      for (let i = 0; i < road.line.length - 1; i++) {
        const [fromLat, fromLon] = road.line[i]!;
        const [toLat, toLon] = road.line[i + 1]!;
        const metres = haversineMetres(fromLat, fromLon, toLat, toLon);
        const steps = Math.max(4, Math.ceil(metres / 100));
        for (let step = 0; step <= steps; step++) {
          const t = step / steps;
          const lat = fromLat + (toLat - fromLat) * t;
          const lon = fromLon + (toLon - fromLon) * t;
          if (isInside(projectPoint(lat, lon), polygon)) continue;
          if (metresFromShore(lat, lon) <= 25) continue;
          offLand.push(
            `${road.name} segment ${i} at ${lat.toFixed(4)}, ${lon.toFixed(4)} — ` +
              `${metresFromShore(lat, lon).toFixed(0)}m outside the drawn coast`,
          );
        }
      }
    }

    expect(offLand).toEqual([]);
  });

  it("draws each road as ONE connected line, with no leap to an unrelated place", () => {
    // The failure this catches is a stitching bug, not a data problem: joining two OSM ways
    // that do not actually meet draws a straight line between wherever they happen to end.
    // Its signature is a span that is both long AND a detour — the drawn line leaving the
    // road's own corridor.
    //
    // A long span alone is NOT the defect and must not be asserted as one. Vashon Highway runs
    // genuinely straight for 7km between Vashon town and Burton, deviating about 45m, so 164
    // source vertices simplify to two. An earlier version of this check flagged exactly that
    // and would have forced a false "fix" — bending a straight road to satisfy a test.
    //
    // So the assertion is on DIRECTNESS: each span is compared against the straight-line
    // distance between the road's own endpoints. A span longer than the road it belongs to is
    // incoherent by construction.
    const suspicious: string[] = [];

    for (const road of ISLAND_ROADS) {
      const [firstLat, firstLon] = road.line[0]!;
      const [lastLat, lastLon] = road.line[road.line.length - 1]!;
      const span = haversineMetres(firstLat, firstLon, lastLat, lastLon);
      for (let i = 0; i < road.line.length - 1; i++) {
        const [fromLat, fromLon] = road.line[i]!;
        const [toLat, toLon] = road.line[i + 1]!;
        const hop = haversineMetres(fromLat, fromLon, toLat, toLon);
        if (hop > span + 100) {
          suspicious.push(
            `${road.name} segment ${i}: ${(hop / 1000).toFixed(2)}km hop on a ` +
              `${(span / 1000).toFixed(2)}km road`,
          );
        }
      }
    }

    expect(suspicious).toEqual([]);
  });

  it("keeps the secondary roads visually subordinate to the highway", () => {
    // Not decoration: the one-road decision (F-043) existed because equal-weight roads turn an
    // orienting poster into a street map. F-070 added arteries for the farmer placing a pin,
    // and the thing that keeps that from undoing the original reasoning is the DRAWN WEIGHT.
    // Asserted against the stylesheet so "make them all the same" fails here rather than being
    // noticed on a screenshot, or not at all.
    const css = readFileSync(
      new URL("../app/globals.css", import.meta.url),
      "utf8",
    );
    const highway = /\.island-road\s*\{[^}]*stroke-width:\s*(\d+(?:\.\d+)?)/.exec(css);
    const minor = /\.island-road-minor\s*\{[^}]*stroke-width:\s*(\d+(?:\.\d+)?)/.exec(css);

    expect(highway, "the highway rule must exist").not.toBeNull();
    expect(minor, "the secondary-road rule must exist").not.toBeNull();
    expect(Number(minor![1])).toBeLessThan(Number(highway![1]));
  });

  it("keeps every wooded area ON LAND (F-043 interior detail)", () => {
    // The forest blocks are the same class of claim as the coastline and the highway: a
    // polygon drawn from coordinates that can silently sit in the water. VIGA's poster shows
    // Banner Forest and Island Center Forest as the island's two interior landmarks, and a
    // green blob half in Puget Sound is the most obviously wrong thing this map could draw.
    //
    // Every vertex, not a centroid — a wood can have its centre inland and still spill over
    // the shore, which is precisely how the west-shore parks would fail.
    const polygon = projectedShoreline();
    const offLand: string[] = [];

    for (const wood of ISLAND_WOODS) {
      for (const [latitude, longitude] of wood.ring) {
        if (!isInside(projectPoint(latitude, longitude), polygon)) {
          offLand.push(`${wood.name} at ${latitude}, ${longitude}`);
        }
      }
    }

    expect(offLand).toEqual([]);
  });

  it("keeps every place label ON LAND", () => {
    // Same failure, cheaper to make: a label anchored offshore reads as a town in the water.
    // The ferry docks are the deliberate exception — a terminal IS on the water, and both are
    // named as such.
    const polygon = projectedShoreline();
    const offLand = ISLAND_PLACES.filter(
      (place) =>
        !place.name.includes("ferry") &&
        !isInside(projectPoint(place.at[0], place.at[1]), polygon),
    ).map((place) => place.name);

    expect(offLand).toEqual([]);
  });

  it("draws the coastline entirely inside the drawing", () => {
    // The land itself must not be clipped by the viewBox, or the island renders with a
    // straight edge where a shore should be.
    for (const point of projectedShoreline()) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(ISLAND_VIEWBOX.width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(ISLAND_VIEWBOX.height);
    }
  });
});

/**
 * Project through the SAME function the artwork and the pins both use.
 *
 * Never reimplemented here. The artwork and the pins disagreeing is the exact defect this
 * file was written to catch, and a test carrying its own copy of the projection could not
 * detect it — it would agree with whichever version it had copied.
 */
function projectPoint(latitude: number, longitude: number) {
  return projectToIsland({ latitude, longitude });
}
