// F-069 — the structured availability a farmer states, and the in-memory mirror of the CHECK
// constraints that arbitrate it.
//
// F-035 added `sales_locations`' season / hours / stocking columns and five constraints
// (`0005_structured_stand_availability.sql`). Until F-069 the seeder was their only writer, so
// a farmer who onboarded through the form got filterable NULLs and prose in `hours_text` —
// which is exactly the unfilterable shape VIGA's existing map fails at.
//
// ## Why this duplicates the database
//
// The CONSTRAINT is the guarantee; this is how a farmer gets an answer instead of a 500. A
// constraint violation reaching the browser names a constraint, not a field, and tells them
// nothing about what to change. Neither layer is redundant: remove the constraint and a future
// writer reintroduces incoherent rows, remove this and the farmer hits an opaque error.
//
// The duplication is the reason `listing-availability.test.ts` asserts this module DIRECTLY
// rather than only through stored rows — the database applies its rule independently, so row
// assertions stay green while this check silently stops agreeing with it.
//
// ## `hours_text` is NOT replaced
//
// It survives beside these columns, display-only and never filtered on. "Saturday and Sunday
// when available" carries a caveat no day set can hold, and dropping it would make the map more
// confident than the farmer was (0005 migration).

/** How a stand states its season. `year_round` is distinct from NULL ("never stated"). */
export type SeasonKind = "year_round" | "date_range" | "named_season" | "open_ended";

/**
 * How a stand states its hours.
 *
 * The clockless kinds are VALUES, not missing data. Dusk on Vashon moves by roughly six hours
 * across the season, so "dawn to dusk" is not equivalent to any fixed pair of clock times, and
 * storing it as one would invent a precision the farmer never claimed.
 */
export type OpenHoursKind =
  | "dawn_to_dusk"
  | "daylight_hours"
  | "all_day"
  | "clock_range"
  | "until_dusk"
  | "by_appointment";

/** How often the stand is restocked. `specific_days` is the only kind carrying a day list. */
export type StockingCadence =
  | "daily"
  | "specific_days"
  | "variable"
  | "as_needed"
  | "intermittent";

export const SEASON_KINDS: readonly SeasonKind[] = [
  "year_round",
  "date_range",
  "named_season",
  "open_ended",
];

export const OPEN_HOURS_KINDS: readonly OpenHoursKind[] = [
  "dawn_to_dusk",
  "daylight_hours",
  "all_day",
  "clock_range",
  "until_dusk",
  "by_appointment",
];

export const STOCKING_CADENCES: readonly StockingCadence[] = [
  "daily",
  "specific_days",
  "variable",
  "as_needed",
  "intermittent",
];

/** The hours kinds that carry NO clock times at all. */
const CLOCKLESS_HOURS: readonly OpenHoursKind[] = [
  "dawn_to_dusk",
  "daylight_hours",
  "all_day",
  "by_appointment",
];

/**
 * The structured availability columns, as one value.
 *
 * Every field is nullable because "not stated" is a legitimate and common answer — a farmer may
 * state hours without a season, or neither. The three groups are independent.
 */
export interface ListingAvailability {
  seasonKind: SeasonKind | null;
  /** Inclusive endpoints, set only for `date_range` (all four) and `open_ended` (start only). */
  seasonStartMonth: number | null;
  seasonStartDay: number | null;
  seasonEndMonth: number | null;
  seasonEndDay: number | null;
  /** Set only for `named_season`, and never empty. The farmer's own season words. */
  seasonNames: string[] | null;
  openHoursKind: OpenHoursKind | null;
  /** Minute of day, 0-1439. `clock_range` needs both; `until_dusk` only the start. */
  openFromMinutes: number | null;
  openUntilMinutes: number | null;
  /** Weekdays 0-6, Sunday-first, matching the admin reader. Never empty. */
  openDays: number[] | null;
  stockingCadence: StockingCadence | null;
  stockingDays: number[] | null;
}

/** Availability with nothing stated — every column NULL. The starting point for a new form. */
export const NO_AVAILABILITY_STATED: ListingAvailability = {
  seasonKind: null,
  seasonStartMonth: null,
  seasonStartDay: null,
  seasonEndMonth: null,
  seasonEndDay: null,
  seasonNames: null,
  openHoursKind: null,
  openFromMinutes: null,
  openUntilMinutes: null,
  openDays: null,
  stockingCadence: null,
  stockingDays: null,
};

/**
 * A weekday set the database will accept: 1-7 DISTINCT days each in 0-6, or NULL.
 *
 * An EMPTY array is refused rather than treated as absent. NULL already says "not stated"; an
 * empty set asserts "open on no day", which no stand means. The constraint spells this with
 * `coalesce(array_length(...), 0)` because `array_length` of an empty array is NULL and a CHECK
 * PASSES on NULL — the first draft of that constraint admitted the exact value it forbade.
 */
function validDaySet(days: number[] | null): boolean {
  if (days === null) return true;
  if (days.length < 1 || days.length > 7) return false;
  for (const day of days) {
    if (!Number.isInteger(day) || day < 0 || day > 6) return false;
  }
  // `<@ array[0..6]` admits duplicates, but the length ceiling then makes a duplicated set
  // indistinguishable from an oversized one. Refused explicitly so the farmer's stated set is
  // the set stored.
  return new Set(days).size === days.length;
}

/** A minute of day the database will accept. 0 is midnight, a real time — never "absent". */
function validMinute(minute: number | null): boolean {
  if (minute === null) return true;
  return Number.isInteger(minute) && minute >= 0 && minute <= 1439;
}

function validMonth(month: number | null): boolean {
  if (month === null) return true;
  return Number.isInteger(month) && month >= 1 && month <= 12;
}

function validDayOfMonth(day: number | null): boolean {
  if (day === null) return true;
  return Number.isInteger(day) && day >= 1 && day <= 31;
}

/**
 * `sales_locations_coherent_season` plus `sales_locations_valid_season_dates`.
 *
 * Endpoints are NOT ordered: November-to-February is an ordinary Vashon season, and requiring
 * start < end would force a farmer with a winter season to misstate it.
 */
function coherentSeason(availability: ListingAvailability): boolean {
  const {
    seasonKind,
    seasonStartMonth,
    seasonStartDay,
    seasonEndMonth,
    seasonEndDay,
    seasonNames,
  } = availability;

  if (
    !validMonth(seasonStartMonth) ||
    !validMonth(seasonEndMonth) ||
    !validDayOfMonth(seasonStartDay) ||
    !validDayOfMonth(seasonEndDay)
  ) {
    return false;
  }

  const hasStart = seasonStartMonth !== null && seasonStartDay !== null;
  const anyStart = seasonStartMonth !== null || seasonStartDay !== null;
  const anyEnd = seasonEndMonth !== null || seasonEndDay !== null;
  const hasEnd = seasonEndMonth !== null && seasonEndDay !== null;
  const hasNames = seasonNames !== null;

  switch (seasonKind) {
    case null:
      // Dates with no kind to explain them: the reader cannot tell what they mean.
      return !anyStart && !anyEnd && !hasNames;
    case "year_round":
      return !anyStart && !anyEnd && !hasNames;
    case "date_range":
      return hasStart && hasEnd && !hasNames;
    case "named_season":
      // Empty is refused: see `validDaySet` for why the emptiness check is explicit.
      return hasNames && seasonNames.length > 0 && !anyStart && !anyEnd;
    case "open_ended":
      return hasStart && !anyEnd && !hasNames;
  }
}

/** `sales_locations_coherent_open_hours` plus `valid_open_minutes` and `valid_open_days`. */
function coherentOpenHours(availability: ListingAvailability): boolean {
  const { openHoursKind, openFromMinutes, openUntilMinutes, openDays } = availability;

  if (!validMinute(openFromMinutes) || !validMinute(openUntilMinutes)) return false;
  if (!validDaySet(openDays)) return false;

  // Compared against null explicitly rather than by truthiness, so minute 0 — midnight — reads
  // as a stated time instead of a missing one.
  const hasFrom = openFromMinutes !== null;
  const hasUntil = openUntilMinutes !== null;

  if (openHoursKind === null) return !hasFrom && !hasUntil;
  if (CLOCKLESS_HOURS.includes(openHoursKind)) return !hasFrom && !hasUntil;
  if (openHoursKind === "clock_range") return hasFrom && hasUntil;
  // `until_dusk`: a stated opening time, closing at a time nobody can name in advance.
  return hasFrom && !hasUntil;
}

/** `sales_locations_coherent_stocking_cadence` plus `valid_stocking_days`. */
function coherentStocking(availability: ListingAvailability): boolean {
  const { stockingCadence, stockingDays } = availability;
  if (!validDaySet(stockingDays)) return false;
  // `specific_days` is the only cadence that carries days, in both directions: without them it
  // promises a set the reader cannot find, and any other cadence with them is contradictory.
  return (stockingCadence === "specific_days") === (stockingDays !== null);
}

/**
 * Whether the database will accept this availability.
 *
 * All three groups must hold — a coherent season does not excuse contradictory hours, since the
 * row is written as one statement and one constraint failure refuses all of it.
 */
export function coherentAvailability(availability: ListingAvailability): boolean {
  return (
    coherentSeason(availability) &&
    coherentOpenHours(availability) &&
    coherentStocking(availability)
  );
}
