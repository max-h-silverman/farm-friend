import {
  destinationRoutingLink,
  isPlausibleOrigin,
  withApproximateDistance,
  type PublicCoordinates,
} from "@farm-friend/core/proximity";
import {
  NAMED_SEASON_MONTHS,
  openNow,
  type OpenState,
} from "@farm-friend/core/open-now";
import type { PublicClosure } from "./closure-projection";

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
  /** The sales-location type used for the public map marker language. */
  locationKind?: "farm_stand" | "farmers_market";
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
   * Sanitized public text from VIGA's source listing. Direct email addresses and phone numbers
   * are removed before this reaches the database; farmer-selected web and social links remain.
   */
  description?: string;
  /**
   * A VIGA-maintained payment fact. It is optional until the public reader has a verified
   * value for a stand; an absent value MUST NOT be rendered as either acceptance or refusal.
   */
  farmBucksAccepted?: boolean;
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
  /**
   * When this stand says it is open (F-043) — season, time of day, weekdays.
   *
   * **Always present, `{}` when the stand stated nothing.** The same asymmetry `usuallySells`
   * carries, and for the same reason: an empty object is a complete answer ("nothing stated"),
   * and its INNER fields are what distinguish stated from unstated. Making the object itself
   * optional would put two absences in a row and force every reader to handle both.
   */
  availability: StandAvailability;
  closure?: PublicClosure;
  /** Active owner-confirmed names; never item provenance and never profile links. */
  alsoSellingHere: string[];
  items: {
    itemName: string;
    quantity?: number;
    unit?: string;
    priceText?: string;
    approximation?: "some" | "limited" | "plentiful";
  }[];
}

export type MapMarkerKind =
  | "seasonal"
  | "year-round"
  | "flower-only"
  | "farmers-market"
  | "contact-only";

/**
 * Map marker language from facts already present in the public payload. The icon is a visual
 * index, not a second source of truth: market type and year-round season are structured facts;
 * flower-only is reserved for a listing whose approved usual offerings are all flower or
 * flower-product terms and whose reviewed payment fact says it does not accept VIGA Bucks.
 */
export function mapMarkerKind(stand: PublicStandPayload): MapMarkerKind {
  if (stand.visitability === "contact_only") return "contact-only";
  if (stand.locationKind === "farmers_market") return "farmers-market";

  if (stand.farmBucksAccepted === false && isFlowerOnlyStand(stand)) {
    return "flower-only";
  }

  return stand.availability.season?.kind === "year_round"
    ? "year-round"
    : "seasonal";
}

/** Whether every published usual offering is a flower or flower-derived product. */
export function isFlowerOnlyStand(stand: PublicStandPayload): boolean {
  const usualOfferings = stand.usuallySells ?? [];
  return (
    usualOfferings.length > 0 &&
    usualOfferings.every((item) =>
      /\b(?:flower(?:s|ing)?|lavender|wreaths?|essential oils?)\b/i.test(item),
    )
  );
}

/**
 * When a stand's season runs — F-035's structure, unresolved (F-043).
 *
 * `named_season` carries the NAMES, not months. F-035's rule is that a named season resolves
 * at query time against one documented constant, so a correction to what "summer" means on
 * Vashon changes that constant rather than requiring every row to be re-seeded. Resolving here
 * would bake the current answer into the wire format and quietly defeat that.
 */
export type StandSeason =
  | { kind: "year_round" }
  | {
      kind: "date_range";
      startMonth: number;
      startDay: number;
      endMonth: number;
      endDay: number;
    }
  | { kind: "named_season"; names: string[] }
  | { kind: "open_ended"; startMonth: number; startDay: number };

/**
 * When a stand is open during the day — F-035's structure, unresolved (F-043).
 *
 * The dusk kinds carry NO clock times, and that absence is the honesty. Migration 0005 is
 * explicit that storing dawn/dusk as fixed hours "would invent a precision the farmer never
 * stated" — dusk on Vashon moves roughly six hours across the year. The actual sun is computed
 * at read time from the date and the island's latitude (`openNow`), which is arithmetic rather
 * than an invented schedule.
 */
export type StandHours =
  | { kind: "dawn_to_dusk" }
  | { kind: "daylight_hours" }
  | { kind: "all_day" }
  | { kind: "by_appointment" }
  | { kind: "clock_range"; fromMinutes: number; untilMinutes: number }
  | { kind: "until_dusk"; fromMinutes: number };

/**
 * What a stand has stated about when it is open (F-043).
 *
 * **Every field is optional and they are INDEPENDENT** — unlike the place fields and the
 * recency fields, which correctly travel in groups. In production 8 stands state a season and
 * no hours, and 1 states hours and no season; grouping them would drop a real fact for a
 * quarter of the island.
 *
 * An absent field means THE FARMER NEVER SAID, which is not the same as "closed" and must
 * never render as one. 5 of 34 public stands state no season and 12 state no hours, so this is
 * the common path rather than an edge. `openNow` answers `"unknown"` for these, and the map
 * shows them under the Open-now filter marked as unconfirmed rather than hiding them — absence
 * of data is not evidence of being shut.
 */
export interface StandAvailability {
  season?: StandSeason;
  hours?: StandHours;
  /**
   * Which weekdays the stand is open, 0 = Sunday.
   *
   * **Absent island-wide today**: no production row carries a day set, though 14 stands state
   * a `specific_days` restocking cadence. The column is plumbed because the schema permits it
   * and an unread column is how F-042 and this item both came to exist — but nothing may
   * assume it is present.
   */
  days?: number[];
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
        stand.closure?.state !== "active" &&
        stand.latitude !== undefined &&
        stand.longitude !== undefined
          ? destinationRoutingLink({
              latitude: stand.latitude,
              longitude: stand.longitude,
            })
          : null,
    })),
  };
}

/** A stand carrying the number printed on its pin and its list entry (F-043). */
export type NumberedStand<Stand> = Stand & { standNumber: number };

/**
 * Assign each stand the number shown on its pin, keyed to its list entry.
 *
 * Adopted from VIGA's printed farm map, which numbers every stand so a pin and a list row
 * identify each other at a glance. The poster can do this trivially because its order never
 * changes; ours re-sorts by distance the moment a customer shares their location.
 *
 * SO THE NUMBER IS A PROPERTY OF THE FARM, NOT OF ITS ROW. Assigned alphabetically by farm
 * name, independent of the order the stands arrive in: sorting reorders cards and renumbers
 * nothing. A positional number would relabel all 32 pins the instant someone tapped "Sort by
 * distance" — authoritative-looking and wrong, which is worse than no number at all. It would
 * also mean the number a customer read on the poster, or wrote down a minute ago, pointed at
 * a different farm.
 *
 * Ties break on `id` so two stands sharing a farm name still get distinct numbers; without
 * that, a farm with two locations would put two pins on one list entry.
 */
export function numberStands<Stand extends { id: string; farmName: string }>(
  stands: readonly Stand[],
): NumberedStand<Stand>[] {
  const order = [...stands].sort(
    (a, b) =>
      a.farmName.localeCompare(b.farmName, "en") || a.id.localeCompare(b.id),
  );
  const numbers = new Map(order.map((stand, index) => [stand.id, index + 1]));

  // Returned in the ORDER GIVEN, carrying numbers from the alphabetical pass — the caller's
  // sort is preserved and the numbering is independent of it.
  return stands.map((stand) => ({
    ...stand,
    standNumber: numbers.get(stand.id)!,
  }));
}

/** Return a displayed stand set in the poster's numbered directory order. */
export function sortStandsByNumber<Stand extends { standNumber: number }>(
  stands: readonly Stand[],
): Stand[] {
  return [...stands].sort((a, b) => a.standNumber - b.standNumber);
}

/**
 * What a customer has asked the map to narrow down to (F-043).
 *
 * All filters are client-side over data already served. No new model call and
 * no new request — the public surface stays model-free, and a customer standing outdoors on a
 * phone gets an instant answer rather than a round trip.
 */
export interface StandFilters {
  /** Open right now — season AND weekday AND time of day. */
  openNow?: boolean;
  /** A farmer has confirmed this stand recently enough not to be flagged stale. */
  confirmedRecently?: boolean;
  /** Free text matched against confirmed items and usual-offering tags. */
  sells?: string;
  /** Has somewhere to go (F-038) — excludes by-order farms with no stand. */
  visitable?: boolean;
  /** Explicitly reviewed as accepting VIGA Bucks; an unstated payment fact does not pass. */
  acceptsFarmBucks?: boolean;
  /** Every published usual offering is a flower or flower-derived product. */
  flowersOnly?: boolean;
  /**
   * What is around later in the year.
   *
   * A different question from `openNow` and meaningful mostly when it is off: with Open now
   * on, out-of-season stands are already excluded, so this would be nearly inert.
   */
  season?: string;
}

/** The instant the filters are evaluated against. Injected, never read from the host. */
export interface FilterMoment {
  at: Date;
  utcOffsetMinutes: number;
}

/**
 * What the map can honestly say about a stand right now (F-043).
 *
 * Carried on every stand, not just the filtered-in ones, because the UI must be able to
 * distinguish "open" from "we don't know" for a stand it is SHOWING. Filtering a stand in and
 * then rendering it as though it were confirmed open is the same dishonesty as hiding it,
 * reached by a different route.
 */
export interface OpenStateFields {
  openState: OpenState;
}

export type FilteredStand = PublicStandPayload & OpenStateFields;

/** Does any of a stand's known produce vocabulary match what the customer typed? */
function sellsMatch(stand: PublicStandPayload, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;

  // Confirmed items AND usual tags. Only one production stand has ever carried a
  // confirmation, so tags are almost the whole corpus a customer can search — but a
  // confirmation is the more certain fact and must never be excluded from search.
  //
  // Substring rather than exact: a customer types "egg", the tag says "duck eggs". Case-folded
  // because tags come from VIGA's form text and confirmations from a farmer's own SMS, and
  // nothing normalizes casing between the two.
  const haystack = [
    ...stand.items.map((item) => item.itemName),
    ...(stand.usuallySells ?? []),
  ];
  return haystack.some((entry) => entry.toLowerCase().includes(needle));
}

/**
 * Could this stand be around in the named season?
 *
 * `undefined` means unknowable — nothing stated, or a season word the constant does not know.
 * The caller keeps those rather than hiding them.
 */
function coversSeason(
  stand: PublicStandPayload,
  seasonName: string,
): boolean | undefined {
  const season = stand.availability.season;
  if (!season) return undefined;

  const months = NAMED_SEASON_MONTHS[seasonName.toLowerCase()];
  if (!months) return undefined;

  switch (season.kind) {
    case "year_round":
      return true;
    case "named_season":
      return season.names.some(
        (name) => name.toLowerCase() === seasonName.toLowerCase(),
      );
    case "date_range": {
      // Does the stated range overlap ANY month of the chosen season? Month granularity is
      // the right resolution for a "what's around in autumn" question, and finer would imply
      // a precision the question does not have.
      const start = season.startMonth;
      const end = season.endMonth;
      const inRange = (month: number) =>
        start <= end
          ? month >= start && month <= end
          : month >= start || month <= end;
      return months.some(inRange);
    }
    case "open_ended":
      // Started and has no stated end, so it covers everything from its start month onward.
      return months.some((month) => month >= season.startMonth);
  }
}

/**
 * Narrow the stands to what the customer asked for (F-043).
 *
 * THE RULE THIS FUNCTION EXISTS TO HOLD (max, 2026-07-30): **a stand that never stated a fact
 * is never excluded by a filter over that fact.** Production has 13 of 34 public stands
 * partly unstated — 5 with no season, 12 with no hours — and hiding them under "Open now"
 * would assert a closure no farmer made, on the strength of a blank column. They stay in the
 * list carrying `openState: "unknown"`, and the UI marks them unconfirmed.
 *
 * Filters COMPOSE: every active one must pass. Order is preserved, because the server already
 * ordered by confirmation and distance sorting is the customer's separate choice.
 *
 * Pure, and takes its moment as an argument. A function that read the host clock could not be
 * tested for the dusk boundary that is the whole point of the Open-now filter.
 */
export function applyStandFilters<Stand extends PublicStandPayload>(
  stands: readonly Stand[],
  filters: StandFilters,
  moment: FilterMoment,
): (Stand & OpenStateFields)[] {
  return stands
    .map((stand) => ({
      ...stand,
      openState: openNow({
        availability: stand.availability,
        closure: stand.closure,
        at: moment.at,
        utcOffsetMinutes: moment.utcOffsetMinutes,
        ...(stand.latitude !== undefined && stand.longitude !== undefined
          ? { latitude: stand.latitude, longitude: stand.longitude }
          : {}),
      }).state,
    }))
    .filter((stand) => {
      if (filters.openNow === true) {
        // `open`, `unknown` and `by_appointment` all stay. Only a stand we can positively say
        // is shut — because the farmer stated the fact that shuts it — is removed.
        const definitelyShut =
          stand.openState === "farmer_closed" ||
          stand.openState === "closed" ||
          stand.openState === "closed_today" ||
          stand.openState === "out_of_season";
        if (definitelyShut) return false;
      }

      if (filters.confirmedRecently === true) {
        // `stale` is absent for a never-confirmed stand (B-013), so this excludes both the
        // stale and the never-confirmed without conflating them.
        if (stand.stale !== false) return false;
      }

      if (filters.sells !== undefined && !sellsMatch(stand, filters.sells)) {
        return false;
      }

      if (filters.visitable === true && stand.visitability !== "visitable") {
        return false;
      }

      if (filters.acceptsFarmBucks === true && stand.farmBucksAccepted !== true) {
        return false;
      }

      if (filters.flowersOnly === true && !isFlowerOnlyStand(stand)) {
        return false;
      }

      if (filters.season !== undefined && filters.season !== "") {
        // `undefined` — unstated, or a season word we do not know — is KEPT, same rule as
        // Open now. Only a definite "no" excludes.
        if (coversSeason(stand, filters.season) === false) return false;
      }

      return true;
    });
}
