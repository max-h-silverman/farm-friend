import {
  destinationRoutingLink,
  isPlausibleOrigin,
  withApproximateDistance,
  type PublicCoordinates,
} from "@farm-friend/core/proximity";

// The public map's view model (F-017).
//
// The page component renders this and decides nothing. Every judgement that could make the
// map dishonest — hiding a stale listing, ranking from a garbage origin, emitting a routing
// link to a coordinate that isn't real — is made here, in a pure function, where a test can
// hold it to account.
//
// This runs in the BROWSER, and that placement is the privacy design rather than an
// implementation detail: the customer's position is used to sort a list already in their
// hands and is never put in a request. It reaches no server, no log, no database, and no
// model context, because it never leaves the device.

/** One stand exactly as `GET /api/public/stands` serves it. */
export interface PublicStandPayload {
  id: string;
  farmName: string;
  locationName: string;
  /**
   * Where to go — present, all three together, only for a `visitable` location (F-038).
   *
   * **Absent for a contact-only farm.** Open Gate Lamb sells by order and has no stand, so
   * there is nowhere to route to. Optional here so the compiler forces every renderer to
   * decide what to show rather than printing an empty address line or dropping a pin at 0,0.
   */
  address?: string;
  latitude?: number;
  longitude?: number;
  /** Whether there is a place to go at all (F-038). */
  visitability: "visitable" | "contact_only";
  /** What the farm provides (F-038) — produce, services, or goods by order. */
  offeringType: "produce" | "services" | "by_order";
  /**
   * Code-rendered on the server by the same helper the SMS answer uses.
   *
   * **Absent when no farmer has ever confirmed this stand** (B-013) — a seeded stand starts
   * that way. Optional here so the compiler forces every renderer to decide what to show
   * instead of silently emitting an empty recency line.
   */
  updated?: string;
  stale?: boolean;
  items: {
    itemName: string;
    quantity?: number;
    unit?: string;
    priceText?: string;
    approximation?: "some" | "limited" | "plentiful";
  }[];
}

export interface MapViewStand extends PublicStandPayload {
  /** Straight-line miles. Absent unless the customer shared a position. */
  distanceMiles?: number;
  distanceLabel?: string;
  /** Destination-only Google Maps link, or null when the coordinate is unusable. */
  routingLink: string | null;
}

export interface MapView {
  stands: MapViewStand[];
  /** True when the list is ordered nearest-first, so the UI can say so honestly. */
  sortedByDistance: boolean;
  /** How many listings carry a staleness warning, for the one up-front notice. */
  staleCount: number;
}

/**
 * Build the map view from the served stands and an optional transient origin.
 *
 * With no usable origin the stands are returned in server order, undistanced, and
 * `sortedByDistance` is false — the customer who declines location sees the entire map, just
 * unsorted. Location is an enhancement; it is never a gate on seeing what is available.
 *
 * Stale stands are ALWAYS included. They are flagged, counted, and rendered with a warning,
 * because on an island of unattended honor-system stands "confirmed 9 days ago" is real
 * information and a blank space is not.
 */
export function buildMapView(
  stands: readonly PublicStandPayload[],
  origin: PublicCoordinates | null | undefined,
): MapView {
  const located = withApproximateDistance(
    stands.map((stand) => ({ ...stand, factId: stand.id })),
    origin,
  );

  return {
    sortedByDistance: isPlausibleOrigin(origin) && stands.length > 0,
    staleCount: stands.filter((stand) => stand.stale).length,
    stands: located.map(({ factId: _factId, ...stand }) => ({
      ...stand,
      // F-038 — no coordinates means no route. `destinationRoutingLink` already refuses an
      // implausible coordinate, but it cannot be handed `undefined`, and defaulting to 0 here
      // would ask it to route to the Gulf of Guinea.
      routingLink:
        stand.latitude !== undefined && stand.longitude !== undefined
          ? destinationRoutingLink({
              latitude: stand.latitude,
              longitude: stand.longitude,
            })
          : null,
    })),
  };
}
