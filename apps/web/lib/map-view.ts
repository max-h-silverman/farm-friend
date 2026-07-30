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
  /**
   * The bare elapsed phrase behind `updated` — "4 hours ago" (F-042).
   *
   * Present and absent exactly with `updated`, and rendered by the same core arithmetic, so
   * the map's "Confirmed 4 hours ago" heading and the SMS answer's "updated 4 hours ago"
   * cannot drift apart. Sent as its own field rather than sliced out of `updated` here: a
   * client that had to strip the verb off a sentence would be one wording change from
   * printing garbage.
   */
  confirmedElapsed?: string;
  /**
   * What this stand USUALLY sells — its seeded specialties, NOT current stock (F-042).
   *
   * A different fact from `items` and kept in a different field for that reason. These come
   * from VIGA's 2026 form; nobody confirmed them today, and no timestamp anywhere may attach
   * to them. Absent when the stand has no tags at all.
   */
  usuallySells?: string[];
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
 * One line of a stand's listing body, already decided (F-042).
 *
 * `kind` is what the renderer styles on; `label` and `items` are what it prints. Nothing
 * downstream re-derives which case a stand is in — that is the whole point of this type.
 */
export interface StandListingLine {
  kind:
    | "confirmed"
    | "confirmed-empty"
    | "usual"
    | "nothing-confirmed"
    | "contact-only"
    | "no-listing";
  /** The full text of the heading or sentence, including its colon where it has one. */
  label: string;
  /** The items listed after the label, in order. Absent for a line that is a sentence. */
  items?: string[];
  /**
   * A recency phrase belonging to THIS line.
   *
   * Only ever set on a line whose `kind` denotes a farmer's confirmation. A `usual` line
   * carries no `detail`, ever — see the rule in `standListingLines`.
   */
  detail?: string;
  /**
   * The items a stock-out report may be filed against, from this line.
   *
   * Confirmed items only. A tag nobody confirmed is not reportable: "the tomatoes are out"
   * against a specialty from a form is noise for the farmer, not a signal.
   */
  reportableItems?: string[];
}

/**
 * Decide a stand's listing body: what to print, in what order, under which heading.
 *
 * THE RULE THIS FUNCTION EXISTS TO HOLD (max, 2026-07-30): **a usual-offerings line never
 * carries a timestamp.** The two facts on a stand card are a farmer's confirmation and a
 * seeded specialty, and they are not the same kind of claim. A date beside "Usually sells"
 * reads as a confirmation of those items, which manufactures exactly the certainty the
 * honor-system product refuses to fake — the same failure B-013 caught on the recency
 * fields. So `detail` is set only on a confirmed line, and the usual line's label is a
 * constant with no interpolation available to it.
 *
 * The cases, in the order they are checked:
 *
 *   confirmed + tags  → "Confirmed X ago: …" then "Also usually sells: …" (tags minus the
 *                        confirmed items, so nothing appears under both headings)
 *   confirmed only    → "Confirmed X ago: …", or the confirmed-empty sentence
 *   tags only         → "Usually sells: …" then "Nothing confirmed recently."
 *   neither           → F-038's contact-only sentence, or "No listing yet"
 *
 * A stand with tags is never given the "neither" copy even when it has nowhere to visit: a
 * by-order farm's specialties are the most useful thing known about it.
 */
export function standListingLines(
  stand: PublicStandPayload,
): readonly StandListingLine[] {
  const confirmedItems = stand.items.map((item) => item.itemName);
  // A confirmation is only claimable with an elapsed phrase to date it. Without one there is
  // no honest heading — "Confirmed :" is the line that would otherwise ship.
  const elapsed = stand.confirmedElapsed;
  const hasConfirmation = elapsed !== undefined;

  // Case-folded, because tags are seeded from VIGA's form text and confirmations arrive in a
  // farmer's own SMS. Nothing normalizes casing between the two, so an exact-string
  // subtraction would print "Tomatoes" under both headings as though they were two facts.
  const confirmedKeys = new Set(confirmedItems.map((name) => name.toLowerCase()));
  const remainingTags = (stand.usuallySells ?? []).filter(
    (tag) => !confirmedKeys.has(tag.toLowerCase()),
  );

  const lines: StandListingLine[] = [];

  if (hasConfirmation) {
    // The certain fact leads. `detail` carries the elapsed phrase, and it is set HERE and
    // nowhere else in this function.
    lines.push(
      confirmedItems.length > 0
        ? {
            kind: "confirmed",
            label: `Confirmed ${elapsed}:`,
            items: confirmedItems,
            detail: elapsed,
            reportableItems: confirmedItems,
          }
        : {
            kind: "confirmed-empty",
            label: "The farmer confirmed this stand is empty right now.",
            detail: elapsed,
          },
    );
  }

  if (remainingTags.length > 0) {
    // No `detail`, no interpolation, both headings constant. The only difference between them
    // is whether a confirmation is already on screen above.
    lines.push({
      kind: "usual",
      label: hasConfirmation ? "Also usually sells:" : "Usually sells:",
      items: remainingTags,
    });
  }

  if (hasConfirmation) return lines;

  if (lines.length > 0) {
    // Tags with no confirmation. The absence is the message, stated plainly — a friendlier
    // "call ahead or take a chance" would nudge toward risk in VIGA's voice.
    lines.push({ kind: "nothing-confirmed", label: "Nothing confirmed recently." });
    return lines;
  }

  // Nothing known at all. F-038's wording first: a farm with no stand cannot "still have
  // produce out", and saying so would be the friendly-sounding lie.
  return stand.visitability === "contact_only"
    ? [
        {
          kind: "contact-only",
          label: "No current listing — contact this farm to ask what’s available.",
        },
      ]
    : [
        {
          kind: "no-listing",
          label:
            "No listing yet — this stand hasn’t been updated through Farm Friend. " +
            "It may still have produce out.",
        },
      ];
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
