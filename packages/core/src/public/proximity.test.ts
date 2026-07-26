import { describe, expect, it } from "vitest";
import {
  PROXIMITY_BASIS_LABEL,
  destinationRoutingLink,
  isPlausibleOrigin,
  straightLineMiles,
  withApproximateDistance,
  type PublicCoordinates,
} from "./proximity";

// F-017 — browser-origin proximity and destination routing links.
//
// Everything here is PURE: a transient origin in, a number or a URL out. There is no
// storage, no network call, no geocoder, and no provider. That is the whole point of the
// approved boundary — proximity is arithmetic over coordinates the operator already seeded,
// not a mapping platform.

const VASHON: PublicCoordinates = { latitude: 47.4471, longitude: -122.4594 };

describe("straightLineMiles", () => {
  it("is zero for a point compared with itself", () => {
    expect(straightLineMiles(VASHON, VASHON)).toBe(0);
  });

  it("computes a known separation to within a tolerance a customer would accept", () => {
    // One degree of latitude is ~69.05 statute miles. A great-circle implementation must
    // land on that; a naive degrees-as-miles subtraction would return 1.
    const oneDegreeNorth = { latitude: 48.4471, longitude: -122.4594 };
    expect(straightLineMiles(VASHON, oneDegreeNorth)).toBeCloseTo(69.05, 1);
  });

  it("accounts for latitude when comparing longitudes", () => {
    // A degree of longitude shrinks with the cosine of latitude. At 47.45N it is about
    // 46.7 miles, NOT the ~69 a flat unweighted calculation would produce. This is the
    // assertion that fails if someone "simplifies" the formula to plain Pythagoras.
    const oneDegreeEast = { latitude: 47.4471, longitude: -121.4594 };
    expect(straightLineMiles(VASHON, oneDegreeEast)).toBeCloseTo(46.66, 0);
  });

  it("is symmetric", () => {
    const other = { latitude: 47.5, longitude: -122.5 };
    expect(straightLineMiles(VASHON, other)).toBeCloseTo(
      straightLineMiles(other, VASHON),
      10,
    );
  });

  it("handles antimeridian-adjacent longitudes without inventing a trip around the world", () => {
    const west = { latitude: 0, longitude: -179.9 };
    const east = { latitude: 0, longitude: 179.9 };
    // 0.2 degrees apart across the seam, ~13.8 miles — not ~24,800.
    expect(straightLineMiles(west, east)).toBeLessThan(20);
  });
});

describe("isPlausibleOrigin", () => {
  it("accepts a well-formed coordinate pair", () => {
    expect(isPlausibleOrigin(VASHON)).toBe(true);
  });

  it("rejects out-of-range, non-finite, and non-numeric values", () => {
    // The browser is not a trusted input: a spoofed or malfunctioning Geolocation API must
    // not put NaN into a distance the UI then renders as a fact.
    for (const bad of [
      { latitude: 91, longitude: 0 },
      { latitude: -91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: 0, longitude: -181 },
      { latitude: Number.NaN, longitude: 0 },
      { latitude: 0, longitude: Number.POSITIVE_INFINITY },
      { latitude: "47.4" as unknown as number, longitude: 0 },
      null as unknown as PublicCoordinates,
      undefined as unknown as PublicCoordinates,
    ]) {
      expect(isPlausibleOrigin(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("destinationRoutingLink", () => {
  it("is destination-only — it carries no origin", () => {
    const link = destinationRoutingLink(VASHON);
    // The customer's mapping application resolves the origin. Farm Friend never sends one,
    // so a routing link cannot become a channel for the customer's position.
    expect(link).not.toContain("origin");
    expect(link).not.toContain("saddr");
    expect(link).toContain("destination=47.4471%2C-122.4594");
  });

  it("routes by coordinate rather than by re-geocoding an address string", () => {
    // Handing Google an address would delegate resolution to a geocoder at click time and
    // could land the customer at the wrong "Provo Farms". The seeded, operator-validated
    // coordinate is the authoritative fact, and it is the only thing in the URL.
    const link = destinationRoutingLink(VASHON)!;
    const params = new URL(link).searchParams;
    expect([...params.keys()].sort()).toEqual(["api", "destination"]);
    expect(params.get("destination")).toBe("47.4471,-122.4594");
  });

  it("refuses to build a link from an invalid coordinate", () => {
    // Never emit a link that would drop the customer at 0,0 in the Gulf of Guinea.
    expect(destinationRoutingLink({ latitude: 999, longitude: 0 })).toBeNull();
    expect(destinationRoutingLink({ latitude: Number.NaN, longitude: 0 })).toBeNull();
  });
});

describe("withApproximateDistance", () => {
  const stands = [
    { factId: "far", latitude: 47.6, longitude: -122.4594 },
    { factId: "near", latitude: 47.45, longitude: -122.4594 },
    { factId: "middle", latitude: 47.5, longitude: -122.4594 },
  ];

  it("orders by distance and labels each one approximately", () => {
    const result = withApproximateDistance(stands, VASHON);
    expect(result.map((s) => s.factId)).toEqual(["near", "middle", "far"]);
    expect(result[0]!.distanceMiles).toBeCloseTo(0.2, 1);
    // Honest labelling: "away" is straight-line, never drive time or a route.
    expect(result[0]!.distanceLabel).toMatch(/mi(le)?s? away$/);
    expect(result[0]!.distanceLabel).not.toMatch(/min|drive|route|turn/i);
  });

  it("returns the stands unchanged and undistanced when there is no origin", () => {
    // Declining location permission must never empty the map.
    const result = withApproximateDistance(stands, null);
    expect(result.map((s) => s.factId)).toEqual(["far", "near", "middle"]);
    expect(result.every((s) => s.distanceMiles === undefined)).toBe(true);
    expect(result.every((s) => s.distanceLabel === undefined)).toBe(true);
  });

  it("ignores an implausible origin rather than ranking from garbage", () => {
    const result = withApproximateDistance(stands, {
      latitude: Number.NaN,
      longitude: 0,
    });
    expect(result.map((s) => s.factId)).toEqual(["far", "near", "middle"]);
    expect(result.every((s) => s.distanceMiles === undefined)).toBe(true);
  });

  it("does not mutate or retain the caller's stands or origin", () => {
    const origin = { ...VASHON };
    const input = stands.map((s) => ({ ...s }));
    const result = withApproximateDistance(input, origin);

    // Pure: the inputs are untouched and the outputs are new objects. Nothing here can
    // become a durable record because nothing here holds a reference.
    expect(input).toEqual(stands);
    expect(origin).toEqual(VASHON);
    expect(result[0]).not.toBe(input[0]);
  });

  it("labels sub-mile distances usefully rather than rounding them all to 0", () => {
    const close = [{ factId: "a", latitude: 47.454337, longitude: -122.4594 }];
    const [only] = withApproximateDistance(close, VASHON);
    expect(only!.distanceLabel).toBe("0.5 miles away");
  });

  it("says '1 mile away' rather than '1 miles away'", () => {
    // Grammar is a small thing that makes a listing read as written by someone who cared.
    const mile = [{ factId: "a", latitude: 47.4616, longitude: -122.4594 }];
    const [only] = withApproximateDistance(mile, VASHON);
    expect(only!.distanceLabel).toBe("1 mile away");
  });
});

describe("PROXIMITY_BASIS_LABEL", () => {
  it("states the basis honestly and promises no routing", () => {
    // The acceptance criterion is that the UI does not present straight-line distance as
    // route time or turn-by-turn directions. The label is where that promise is kept.
    expect(PROXIMITY_BASIS_LABEL).toMatch(/straight-line/i);
    expect(PROXIMITY_BASIS_LABEL).not.toMatch(/drive|driving|route time|turn-by-turn/i);
  });
});
