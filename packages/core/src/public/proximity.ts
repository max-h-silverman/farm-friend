// Public-web proximity and destination routing links (F-017).
//
// The approved launch boundary in one sentence: proximity is ARITHMETIC over coordinates an
// operator already validated during seeding, computed against an origin the browser hands us
// for the duration of one render — never a geocoder, a routing engine, or a stored location.
//
// Everything in this file is therefore PURE. There is no `Db`, no `Clock`, no provider, and
// no model. A transient origin goes in; a number and a code-rendered label come out. The
// privacy guarantee ("precise browser origins are not stored in Postgres, logs, model
// context, or durable preferences") is structural rather than promised: a pure function over
// a value it does not retain has nowhere to put one.
//
// Two things this deliberately is NOT:
//
//   - It is not routing. `straightLineMiles` is a great-circle distance — "as the crow
//     flies" over an island with one highway and a ferry. Presenting that as drive time
//     would be a dishonest answer dressed as a precise one, so the label says what it is
//     and `PROXIMITY_BASIS_LABEL` says it again in the UI.
//   - It is not a mapping platform. Directions are a destination-only link handed to the
//     customer's own map application, which resolves their origin itself. Farm Friend never
//     transmits the customer's position anywhere.

/** A validated public coordinate pair. Seeded for a stand; transient for a customer. */
export interface PublicCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * The honest statement of what the distance figure means. Rendered next to the sorted list
 * so "0.5 miles away" is never mistaken for a route.
 */
export const PROXIMITY_BASIS_LABEL =
  "Distances are approximate straight-line estimates from your device, not travel times.";

const EARTH_RADIUS_MILES = 3958.7613;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * True when a coordinate pair could be a real position on Earth.
 *
 * The browser Geolocation API is an untrusted input like any other: a malfunctioning device,
 * a spoofing extension, or a hand-edited value must not put `NaN` into a figure the UI then
 * renders as a fact. Everything downstream refuses to compute without this passing.
 */
export function isPlausibleOrigin(candidate: PublicCoordinates | null | undefined): boolean {
  if (candidate === null || candidate === undefined) return false;
  const { latitude, longitude } = candidate;
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * Great-circle distance in statute miles.
 *
 * The haversine formula rather than a flat approximation: a degree of longitude is ~46.7
 * miles at Vashon's latitude and ~69 at the equator, and a customer told the wrong stand is
 * nearest has been given a wrong answer, not an imprecise one. Haversine also crosses the
 * antimeridian correctly, which a naive coordinate subtraction does not.
 */
export function straightLineMiles(
  from: PublicCoordinates,
  to: PublicCoordinates,
): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * A destination-only Google Maps link, built from the stand's authoritative seeded
 * coordinate.
 *
 * Two deliberate choices:
 *
 *   - The destination is the COORDINATE, not the address string. Handing over the address
 *     would delegate resolution to a geocoder at click time, which could land the customer
 *     at a different "Provo Farms" than the one VIGA validated. The name rides along only
 *     as the pin's label.
 *   - There is NO origin parameter. Google resolves that from the customer's own device.
 *     This is what keeps directions from becoming a channel that transmits the customer's
 *     position to anyone, including us.
 *
 * The stand's NAME is deliberately not a parameter. A farmer-authored listing name is
 * untrusted text, and the validated coordinate alone is sufficient and unambiguous — adding
 * the name would put attacker-influenced characters in a URL for no navigational gain.
 *
 * Returns `null` for an invalid coordinate rather than emitting a link that would drop the
 * customer at 0,0.
 */
export function destinationRoutingLink(
  destination: PublicCoordinates,
): string | null {
  if (!isPlausibleOrigin(destination)) return null;

  const point = `${destination.latitude},${destination.longitude}`;
  const params = new URLSearchParams({ api: "1", destination: point });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Anything carrying a public coordinate — a stand, in practice. */
export interface Locatable extends PublicCoordinates {
  factId: string;
}

export type WithDistance<T> = T & {
  /** Straight-line miles from the transient origin. Absent when there is no usable origin. */
  distanceMiles?: number;
  /** The code-rendered label. Never a travel time. */
  distanceLabel?: string;
};

/** Render a distance the way a person would say it, and never as a route. */
function renderDistance(miles: number): string {
  const rounded = miles < 10 ? Math.round(miles * 10) / 10 : Math.round(miles);
  const value = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return `${value} ${rounded === 1 ? "mile" : "miles"} away`;
}

/**
 * Annotate stands with approximate distance and order them nearest-first.
 *
 * With no origin — permission declined, unavailable, or implausible — the stands are
 * returned in the order they arrived, undistanced. That is the graceful path the acceptance
 * criteria require: a customer who declines location still sees the whole map, just not
 * sorted by proximity. Location is an enhancement, never a gate.
 *
 * The inputs are copied rather than mutated, so nothing here retains the origin.
 */
export function withApproximateDistance<T extends Locatable>(
  stands: readonly T[],
  origin: PublicCoordinates | null | undefined,
): WithDistance<T>[] {
  if (!isPlausibleOrigin(origin)) {
    return stands.map((stand) => ({ ...stand }));
  }
  const from = origin as PublicCoordinates;

  return stands
    .map((stand) => {
      const distanceMiles = straightLineMiles(from, stand);
      return { ...stand, distanceMiles, distanceLabel: renderDistance(distanceMiles) };
    })
    .sort((a, b) => a.distanceMiles - b.distanceMiles || a.factId.localeCompare(b.factId));
}
