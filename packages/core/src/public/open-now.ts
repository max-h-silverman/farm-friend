import { VASHON, localMinutesOfDay, sunTimes } from "./daylight";

// F-043 — "is this stand open right now".
//
// THIS IS THE FUNCTION THAT CAN LIE TO A CUSTOMER. A wrong answer sends someone driving
// across the island to a locked stand, or hides one that is open. Everything here is
// therefore pure and exhaustively tested, and every judgement it declines to make is
// explicit rather than defaulted.
//
// THE THREE-STATE RESULT (max, 2026-07-30). Production states no season for 5 of 34 public
// stands and no hours for 12. A boolean predicate has to call those `false`, which asserts
// "the farmer said closed" when the farmer said nothing — the map manufacturing certainty it
// does not have, which is the failure this whole product exists to avoid. So the answer is a
// STATE, `unknown` is a first-class one, and the UI shows unknown stands under the Open-now
// filter marked as unconfirmed rather than hiding them. Absence of data is not evidence of
// being shut.
//
// THE SUN IS COMPUTED, NOT STORED. Most stands say `dawn_to_dusk` rather than clock times,
// and migration 0005 refuses to store those as fixed hours because it "would invent a
// precision the farmer never stated". `daylight.ts` computes the real sunrise and sunset for
// the date and the island's latitude — arithmetic, not a schedule and not a service.

/** Which months each named season covers, 1-indexed. */
export const NAMED_SEASON_MONTHS: Record<string, readonly number[]> = {
  // THE ONE DOCUMENTED CONSTANT (F-035). Named seasons are stored as names and resolved here,
  // at the moment the question is asked, so a VIGA correction to what "summer" means on
  // Vashon changes this table once instead of requiring every seeded row to be rewritten.
  // Meteorological seasons, not astronomical: they align to whole months, which is how a
  // farmer filling in a form means them.
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  fall: [9, 10, 11],
  winter: [12, 1, 2],
};

export type StandSeasonFacts =
  | { kind: "year_round" }
  | {
      kind: "date_range";
      startMonth: number;
      startDay: number;
      endMonth: number;
      endDay: number;
    }
  | { kind: "named_season"; names: readonly string[] }
  | { kind: "open_ended"; startMonth: number; startDay: number };

export type StandHoursFacts =
  | { kind: "dawn_to_dusk" }
  | { kind: "daylight_hours" }
  | { kind: "all_day" }
  | { kind: "by_appointment" }
  | { kind: "clock_range"; fromMinutes: number; untilMinutes: number }
  | { kind: "until_dusk"; fromMinutes: number };

/**
 * What a stand has STATED about when it is open.
 *
 * Each field independently optional, because a farmer may give a season and no hours (8
 * production stands) or hours and no season (1). An absent field means "never said".
 */
export interface StandAvailabilityFacts {
  season?: StandSeasonFacts;
  hours?: StandHoursFacts;
  /** Weekdays the stand is open, 0 = Sunday. Absent island-wide today. */
  days?: readonly number[];
}

/**
 * What we can honestly say about a stand right now.
 *
 * `unknown` and `by_appointment` are NOT failures — they are the accurate answers when the
 * farmer stated nothing, or stated that visiting is arranged rather than scheduled. Neither
 * may be rendered as "closed".
 */
export type OpenState =
  | "open"
  | "closed"
  | "closed_today"
  | "out_of_season"
  | "by_appointment"
  | "unknown";

export interface OpenNowAnswer {
  state: OpenState;
  /**
   * The sunset this answer was computed against, in local minutes — present only when the
   * sun actually decided it (the dusk kinds).
   *
   * Exposed so the UI can say "open until sunset, about 9:11pm" from the SAME arithmetic that
   * made the filtering decision. A caller recomputing it could drift out of agreement with
   * the answer it is labelling.
   */
  sunsetMinutes?: number;
  sunriseMinutes?: number;
}

export interface OpenNowInput {
  availability: StandAvailabilityFacts;
  /** The instant being asked about. */
  at: Date;
  /** Minutes to add to UTC for local clock time. Explicit, never read from the host. */
  utcOffsetMinutes: number;
  /** The stand's own coordinate; the island's centre is used when it has none (F-038). */
  latitude?: number;
  longitude?: number;
}

/** The local calendar date parts for an instant, in the supplied offset. */
function localDateParts(at: Date, utcOffsetMinutes: number) {
  const shifted = new Date(at.getTime() + utcOffsetMinutes * 60_000);
  return {
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    // The LOCAL weekday. Reading this off the un-shifted date moves every day boundary by the
    // offset, so a Saturday-only stand reads as shut to anyone asking on Saturday evening.
    weekday: shifted.getUTCDay(),
  };
}

/** A month/day as a comparable ordinal, for whole-date comparisons within a year. */
const asOrdinal = (month: number, day: number): number => month * 100 + day;

/**
 * Whether today falls inside a stated season.
 *
 * `undefined` means the season could not be decided — either nothing was stated, or a named
 * season used a word this constant does not know. Both must surface as `unknown` rather than
 * as an exclusion, since guessing "not in season" silently removes a stand from the map.
 */
function inSeason(
  season: StandSeasonFacts | undefined,
  month: number,
  day: number,
): boolean | undefined {
  if (!season) return undefined;

  switch (season.kind) {
    case "year_round":
      return true;

    case "date_range": {
      const today = asOrdinal(month, day);
      const start = asOrdinal(season.startMonth, season.startDay);
      const end = asOrdinal(season.endMonth, season.endDay);
      // Both endpoints inclusive: a season stated as "May 1 - Oct 31" includes both days.
      // The wrapped case (start > end, e.g. November to February) is a real way to state a
      // winter season, and a plain start <= today <= end reports it out of season every day
      // of the year.
      return start <= end
        ? today >= start && today <= end
        : today >= start || today <= end;
    }

    case "named_season": {
      let recognized = false;
      for (const name of season.names) {
        const months = NAMED_SEASON_MONTHS[name.toLowerCase()];
        if (!months) continue;
        recognized = true;
        if (months.includes(month)) return true;
      }
      // A name the constant does not know cannot be judged. Returning `false` would hide the
      // stand on the strength of a word we failed to understand.
      return recognized ? false : undefined;
    }

    case "open_ended":
      // A stated start with an explicitly unknown end ("June 1, 2026 - TBD"). Unknown is not
      // zero: the farmer said they do not know when it ends, so it has not ended.
      return asOrdinal(month, day) >= asOrdinal(season.startMonth, season.startDay);
  }
}

/**
 * Is this stand open right now?
 *
 * Order of judgement, and it is deliberate:
 *
 *   1. SEASON FIRST. "Closed for the season" is the more useful and more durable answer —
 *      it tells someone not to come back tomorrow either, where "closed right now" invites
 *      them to try this evening. `Open now` also means in season (max, 2026-07-30): one
 *      control, one plain-language meaning.
 *   2. WEEKDAY, when stated.
 *   3. TIME OF DAY, computing the sun for the kinds that need it.
 *
 * At every step, a fact that was never stated yields `unknown` rather than an exclusion.
 */
export function openNow(input: OpenNowInput): OpenNowAnswer {
  const { availability, at, utcOffsetMinutes } = input;
  const { month, day, weekday } = localDateParts(at, utcOffsetMinutes);

  const seasonal = inSeason(availability.season, month, day);
  if (seasonal === false) return { state: "out_of_season" };

  // `by_appointment` is decided before the unknown-season check: it is a complete answer
  // about how to visit this farm, and it does not become more or less true for want of a
  // stated season.
  if (availability.hours?.kind === "by_appointment") {
    return { state: "by_appointment" };
  }

  if (availability.days && availability.days.length > 0) {
    if (!availability.days.includes(weekday)) return { state: "closed_today" };
  }

  const hours = availability.hours;
  // Nothing stated about the time of day, or the season is unresolved — either way there is
  // no honest way to claim the stand is open or shut right now.
  if (!hours || seasonal === undefined) return { state: "unknown" };

  const nowMinutes = localMinutesOfDay(at, utcOffsetMinutes);

  switch (hours.kind) {
    case "all_day":
      return { state: "open" };

    case "clock_range": {
      const { fromMinutes, untilMinutes } = hours;
      // Endpoints inclusive; a stand that says it opens at 9 is open at 9. The wrapped case
      // (from > until) is a range crossing midnight, which the schema permits.
      const open =
        fromMinutes <= untilMinutes
          ? nowMinutes >= fromMinutes && nowMinutes <= untilMinutes
          : nowMinutes >= fromMinutes || nowMinutes <= untilMinutes;
      return { state: open ? "open" : "closed" };
    }

    case "dawn_to_dusk":
    case "daylight_hours": {
      // Two phrasings of one fact, answered identically — VIGA's form uses both.
      const sun = sun_for(input);
      const open =
        nowMinutes >= sun.sunriseMinutes && nowMinutes <= sun.sunsetMinutes;
      return {
        state: open ? "open" : "closed",
        sunriseMinutes: sun.sunriseMinutes,
        sunsetMinutes: sun.sunsetMinutes,
      };
    }

    case "until_dusk": {
      // A STATED start and a COMPUTED end. The farmer's own opening time wins over the sun:
      // 7am in July is broad daylight, but a stand that says it opens at ten is shut.
      const sun = sun_for(input);
      const open =
        nowMinutes >= hours.fromMinutes && nowMinutes <= sun.sunsetMinutes;
      return {
        state: open ? "open" : "closed",
        sunriseMinutes: sun.sunriseMinutes,
        sunsetMinutes: sun.sunsetMinutes,
      };
    }
  }
  // No `by_appointment` case here, and no default: it is returned above, before the weekday
  // and season checks, so the compiler has already narrowed it out of this switch. A case for
  // it would not merely be dead — it would fail to compile, which is the type system holding
  // the ordering decision in place rather than a comment doing it.
}

/** The sun for this stand, falling back to the island's centre when it has no pin (F-038). */
function sun_for(input: OpenNowInput) {
  return sunTimes({
    date: input.at,
    latitude: input.latitude ?? VASHON.latitude,
    longitude: input.longitude ?? VASHON.longitude,
    utcOffsetMinutes: input.utcOffsetMinutes,
  });
}
