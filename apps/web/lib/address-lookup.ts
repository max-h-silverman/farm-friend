import { ISLAND_BOUNDS } from "@farm-friend/core";

// F-068 — turning a typed address into a DRAFT pin the farmer confirms.
//
// ## The reopened boundary, and what still holds it
//
// "No runtime geocoder" was a launch decision (PRODUCT_BRIEF §launch decisions, DEVELOPMENT
// §non-goals) with a tripwire in `packages/core/src/architecture.test.ts`. **max reopened it on
// 2026-08-05, scoped to farm stand onboarding**, after being shown the risk below and
// reaffirming.
//
// The original reason is still true: a `StubMapProvider` once invented deterministic
// pseudo-coordinates near Vashon for ANY address string, and a stand at a fabricated point is
// worse than a stand with no point — it sends a customer somewhere real and wrong. Rural Vashon
// is where geocoders are weakest, and a farm stand is frequently at the road rather than at the
// mailing address. Only the farmer knows that.
//
// So this is a DRAFT, never an answer. Three properties keep the farmer the authority:
//
//   1. **Off-island results are refused, never shown.** Farm Friend is one island, and
//      `ISLAND_BOUNDS` is the single statement of where it is — this module does not carry a
//      second envelope of its own, because two would drift and a farm on the wrong side of the
//      drift is a pin in Puget Sound.
//   2. **Every failure is "the farmer taps the map"** — the pre-F-068 behaviour. No result, a
//      malformed body, a provider error, a thrown request, an unset key: one answer, no
//      coordinate. This module cannot invent one, which is why there is no code path that
//      constructs a coordinate from anything but a provider number that passed the bounds check.
//   3. **The confirmation lives in the form.** `listing-step.tsx` commits only the pin the
//      farmer confirmed. This module hands over a suggestion.
//
// ## No SDK, deliberately
//
// The REST endpoint is called with `fetch`. A geocoding SDK would be the "permanent map package"
// the boundary still forbids everywhere else, and the dependency tripwire in
// `architecture.test.ts` stays fully armed — including for this file's own workspace.

/** What a lookup can tell the form. Never a coordinate unless it is ON the island. */
export type AddressLookupResult =
  | { status: "found"; latitude: number; longitude: number }
  /** Resolved, but not to a place on Vashon or Maury. The farmer places the pin. */
  | { status: "off_island" }
  /** Nothing usable came back. Indistinguishable, on purpose, from a provider failure. */
  | { status: "no_result" }
  /** No key in this deployment. The form falls back to pin-dropping in silence. */
  | { status: "not_configured" };

export interface AddressLookupDeps {
  /** Absent in a deployment without geocoding configured, which is a supported state. */
  apiKey: string | undefined;
  /** Injected so every path here is testable without a network call or a billed request. */
  fetch: typeof fetch;
}

/** Google's Geocoding REST endpoint. No SDK — see the note above. */
const GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

/**
 * A number from an untrusted JSON body, or `null`.
 *
 * Type-checked rather than coerced: `Number(undefined)` is NaN and `Number(null)` is 0, and 0 is
 * a real coordinate in the Atlantic. A malformed body must produce no pin, never a confident one.
 */
function coordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether a coordinate is on the island, per the ONE statement of where the island is. */
function onIsland(latitude: number, longitude: number): boolean {
  return (
    latitude >= ISLAND_BOUNDS.south &&
    latitude <= ISLAND_BOUNDS.north &&
    longitude >= ISLAND_BOUNDS.west &&
    longitude <= ISLAND_BOUNDS.east
  );
}

/**
 * Look up a typed address, returning a coordinate ONLY when it lands on the island.
 *
 * The query is biased to `ISLAND_BOUNDS` and to the US: "12345 Vashon Hwy" resolves in a dozen
 * states otherwise, and the nearest wrong match is the one a farmer is least likely to notice.
 * The bias is a hint to the provider, not a guarantee — which is why the result is bounds-checked
 * on the way back regardless of what was asked for.
 */
export async function lookupIslandAddress(
  deps: AddressLookupDeps,
  address: string,
): Promise<AddressLookupResult> {
  if (deps.apiKey === undefined || deps.apiKey === "") {
    return { status: "not_configured" };
  }
  const query = address.trim();
  if (query === "") return { status: "no_result" };

  const url = new URL(GEOCODE_ENDPOINT);
  url.searchParams.set("address", query);
  url.searchParams.set("key", deps.apiKey);
  url.searchParams.set("region", "us");
  url.searchParams.set(
    "bounds",
    `${ISLAND_BOUNDS.south},${ISLAND_BOUNDS.west}|${ISLAND_BOUNDS.north},${ISLAND_BOUNDS.east}`,
  );

  let body: unknown;
  try {
    const response = await deps.fetch(url.toString());
    if (!response.ok) return { status: "no_result" };
    body = await response.json();
  } catch {
    // A network failure degrades to pin-dropping. It is never surfaced as an error, because the
    // farmer's own tap was always the authority and remains available.
    return { status: "no_result" };
  }

  const payload = body as
    | { status?: unknown; results?: { geometry?: { location?: unknown } }[] }
    | null
    | undefined;
  if (payload?.status !== "OK" || !Array.isArray(payload.results)) {
    return { status: "no_result" };
  }

  // The first result is the provider's best match. Ranking alternatives would be this module
  // deciding between places, which is the farmer's call and not a geocoder's.
  const location = payload.results[0]?.geometry?.location as
    | { lat?: unknown; lng?: unknown }
    | undefined;
  const latitude = coordinate(location?.lat);
  const longitude = coordinate(location?.lng);
  if (latitude === null || longitude === null) return { status: "no_result" };

  if (!onIsland(latitude, longitude)) return { status: "off_island" };
  return { status: "found", latitude, longitude };
}
