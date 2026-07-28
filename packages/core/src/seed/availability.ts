// F-035 — parsing VIGA's stand prose into filterable data.
//
// This is a ONE-TIME seed concern, not a runtime one. It runs in a build-time script over a
// fixed corpus; nothing here is reachable from a request. That is what keeps the public map
// model-free and deterministic (F-019) while still getting structure out of free text.
//
// THE CONTRACT: never guess. Every function returns an explicit `unparsed` result when the
// input does not match a shape it understands, and the seeder turns that into a
// `stand_data_flags` row for a human. On a map whose premise is honesty about uncertainty, a
// confidently wrong day set is worse than an absent one.
//
// Vocabulary note (CLAUDE.md): this file contains no farm names and no produce taxonomy. It
// recognizes CALENDAR and CLOCK vocabulary — "Tuesday", "March", "dusk" — which is fixed
// language about time, not a claim about what food exists.
//
// SCOPE: availability only. What a stand OFFERS is deliberately not parsed here. A regex can
// split "eggs, plant starts, veggies" but not "Specializing in Asian vegetables, including
// gailan, bok choy" — and the failures are not cosmetic, since every item becomes a
// customer-facing filter tag. An early draft produced tags like "rotational grazing for
// chickens" and "special occasions...etc..". Offerings are extracted by a model seam that
// PROPOSES tags for review (F-036); code commits what a human approved.

/** Weekday indices, 0 = Sunday, matching Postgres `extract(dow)` and `Date.getDay()`. */
export const DAY = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

export type OpenHoursKind =
  | "dawn_to_dusk"
  | "daylight_hours"
  | "all_day"
  | "clock_range"
  | "until_dusk"
  | "by_appointment";

export type ParsedOpenHours =
  | { kind: OpenHoursKind; fromMinutes?: number; untilMinutes?: number }
  /**
   * The text states no time of day at all — "May 1 - Nov 1", "Year Round".
   *
   * Distinct from `unparsed` on purpose, and the distinction is the difference between a fact
   * and a defect. `not_stated` means VIGA never recorded hours for this stand, which is
   * ordinary and needs no human; `unparsed` means hours WERE stated and this parser did not
   * understand them, which needs one. Collapsing the two would bury the handful of genuine
   * ambiguities under a pile of stands that simply never listed a closing time.
   */
  | { kind: "not_stated" }
  | { kind: "unparsed" };

export type SeasonName = "spring" | "summer" | "fall" | "winter";

export type ParsedSeason =
  | { kind: "year_round" }
  | {
      kind: "date_range";
      startMonth: number;
      startDay: number;
      endMonth: number;
      endDay: number;
    }
  | { kind: "named_season"; names: SeasonName[] }
  | { kind: "open_ended"; startMonth: number; startDay: number }
  /** No season stated at all — the same fact-vs-defect distinction as `ParsedOpenHours`. */
  | { kind: "not_stated" }
  | { kind: "unparsed" };

export type StockingCadence =
  | "daily"
  | "specific_days"
  | "variable"
  | "as_needed"
  | "intermittent";

export interface ParsedStocking {
  cadence: StockingCadence | "not_stated" | "unparsed";
  days?: number[];
  /** The farmer's qualifier, kept verbatim for display. Never filtered on. */
  note?: string;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

/** Days in each month; February is 28 because a season end is a recurring annual boundary. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const WEEKDAY_WORDS: Record<string, number> = {
  sunday: DAY.sunday, sun: DAY.sunday,
  monday: DAY.monday, mon: DAY.monday,
  tuesday: DAY.tuesday, tue: DAY.tuesday, tues: DAY.tuesday,
  wednesday: DAY.wednesday, wed: DAY.wednesday,
  thursday: DAY.thursday, thu: DAY.thursday, thurs: DAY.thursday,
  friday: DAY.friday, fri: DAY.friday,
  saturday: DAY.saturday, sat: DAY.saturday,
};

/** Convert "10:00am", "8 am", "6pm" to minutes past midnight. */
function clockToMinutes(hour: string, minute: string | undefined, meridiem: string): number {
  let h = Number(hour) % 12;
  if (/pm/i.test(meridiem)) h += 12;
  return h * 60 + Number(minute ?? 0);
}

const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)`;

/**
 * How a stand states its time of day.
 *
 * Order matters: `until_dusk` must be tested before `clock_range`, because "10AM - Dusk"
 * contains a clock time and would otherwise match a half-formed range.
 */
export function parseOpenHours(text: string): ParsedOpenHours {
  const t = text.trim();
  if (t === "") return { kind: "not_stated" };

  if (/by\s+appointment/i.test(t)) return { kind: "by_appointment" };

  // A clock start running to dusk, before the general clock-range test below.
  const untilDusk = new RegExp(`${CLOCK}\\s*(?:-|–|—|to)\\s*dusk`, "i").exec(t);
  if (untilDusk) {
    return {
      kind: "until_dusk",
      fromMinutes: clockToMinutes(untilDusk[1]!, untilDusk[2], untilDusk[3]!),
    };
  }

  const range = new RegExp(`${CLOCK}\\s*(?:-|–|—|to)\\s*${CLOCK}`, "i").exec(t);
  if (range) {
    return {
      kind: "clock_range",
      fromMinutes: clockToMinutes(range[1]!, range[2], range[3]!),
      untilMinutes: clockToMinutes(range[4]!, range[5], range[6]!),
    };
  }

  // "8 am to 6 pm" where only the second carries a meridiem is still a range; so is
  // "9am-8pm". Handled above. What remains are the relative kinds.
  if (/dawn\s*(?:-|–|—|to)?\s*(?:to\s*)?dusk/i.test(t)) return { kind: "dawn_to_dusk" };
  if (/daylight\s+hours/i.test(t)) return { kind: "daylight_hours" };
  if (/24\s*\/\s*7|24\s*hrs?\b|24\s*hours?\b/i.test(t)) return { kind: "all_day" };

  // Nothing matched. Decide whether the text TRIED to state a time of day: if it carries no
  // clock, no meridiem, and none of the relative-time words, then hours were simply never
  // recorded ("May 1 - Nov 1") and there is nothing for a human to resolve.
  const mentionsTime =
    /\d\s*[ap]\.?m\.?|\b(?:dawn|dusk|daylight|noon|midnight|sunrise|sunset|hours?|open until|close[sd]?)\b/i.test(
      t,
    );
  return mentionsTime ? { kind: "unparsed" } : { kind: "not_stated" };
}

/** Last calendar day of a 1-indexed month. */
function lastDayOf(month: number): number {
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

function monthOf(word: string): number | undefined {
  return MONTHS[word.toLowerCase().replace(/\./g, "")];
}

/**
 * How a stand states its season.
 *
 * Named seasons are NOT resolved to months here. Resolution happens at query time against one
 * documented constant, so a correction to what "summer" means on Vashon changes that constant
 * rather than requiring every seeded row to be rewritten.
 */
export function parseSeason(text: string): ParsedSeason {
  const t = text.trim();
  if (t === "") return { kind: "not_stated" };

  if (/\b(?:all\s+year|year[\s-]*round|year\s+around)\b/i.test(t)) {
    return { kind: "year_round" };
  }

  // `(?:mid-|early |late )?` handles "Mid-May thru October": the modifier narrows the start
  // within the month, which this parser does not model, so it reads the month and lets the
  // seeder keep the farmer's exact words in the display-only note.
  const monthWord = String.raw`(?:mid[\s-]*|early\s+|late\s+)?([A-Za-z]{3,9})\.?`;
  const sep = String.raw`\s*(?:-|–|—|to|thru|through)\s*`;

  // "May 1- Nov 1", "July 1 to Oct 15" — both endpoints carry a day.
  const dated = new RegExp(`${monthWord}\\s+(\\d{1,2})(?:,\\s*\\d{4})?${sep}${monthWord}\\s+(\\d{1,2})`, "i").exec(t);
  if (dated) {
    const startMonth = monthOf(dated[1]!);
    const endMonth = monthOf(dated[3]!);
    if (startMonth && endMonth) {
      return {
        kind: "date_range",
        startMonth,
        startDay: Number(dated[2]),
        endMonth,
        endDay: Number(dated[4]),
      };
    }
  }

  // "June 1, 2026 - TBD" — a stated start, an explicitly unknown end.
  const openEnded = new RegExp(`${monthWord}\\s+(\\d{1,2})(?:,\\s*\\d{4})?${sep}TBD`, "i").exec(t);
  if (openEnded) {
    const startMonth = monthOf(openEnded[1]!);
    if (startMonth) {
      return { kind: "open_ended", startMonth, startDay: Number(openEnded[2]) };
    }
  }

  // "March to December", "April- October", "March-November" — whole months. Start on the 1st
  // and end on the last day: the only reading that does not narrow what the farmer said.
  const monthRange = new RegExp(`\\b${monthWord}${sep}${monthWord}`, "i").exec(t);
  if (monthRange) {
    const startMonth = monthOf(monthRange[1]!);
    const endMonth = monthOf(monthRange[2]!);
    if (startMonth && endMonth) {
      return {
        kind: "date_range",
        startMonth,
        startDay: 1,
        endMonth,
        endDay: lastDayOf(endMonth),
      };
    }
  }

  // Named seasons, in calendar order regardless of how they were written.
  const ORDER: SeasonName[] = ["spring", "summer", "fall", "winter"];
  const found = ORDER.filter((name) => {
    const alternatives = name === "fall" ? "fall|autumn" : name;
    return new RegExp(`\\b(?:${alternatives})\\b`, "i").test(t);
  });
  if (found.length > 0) return { kind: "named_season", names: found };

  // Did the text try to state a season? A month name or an explicit season word means yes,
  // and a failure to parse one is a real ambiguity for a human. Anything else simply never
  // mentioned a season.
  const mentionsSeason =
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:spring|summer|fall|autumn|winter|season)\b/i.test(
      t,
    );
  return mentionsSeason ? { kind: "unparsed" } : { kind: "not_stated" };
}

/**
 * Collect weekday words in calendar order, de-duplicated.
 *
 * The full names are listed before the abbreviations, and the alternation is ordered
 * longest-first. Both details are load-bearing: a pattern that tries `sat` first matches the
 * opening of "Saturday" and then fails its trailing word boundary, so the day is silently
 * missed. The optional `s` handles "Mondays and Fridays", which the corpus writes plural.
 */
const WEEKDAY_WORD = String.raw`(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thu|fri|sat)s?`;

function weekdaysIn(text: string): number[] {
  const found = new Set<number>();

  // A DASHED RANGE FIRST. "Thursday - Sunday" means Thu, Fri, Sat, Sun — four days, not the
  // two whose names appear. Collecting weekday words alone silently dropped the interior
  // days, so Green Ears was stocked "Thursday - Sunday" but invisible to a customer
  // filtering for Friday, with nothing reporting an error. Found by seeding the real corpus.
  const rangePattern = new RegExp(
    `\\b${WEEKDAY_WORD}\\s*(?:-|–|—|to|thru|through)\\s*${WEEKDAY_WORD}\\b`,
    "gi",
  );
  for (const match of text.matchAll(rangePattern)) {
    const from = WEEKDAY_WORDS[match[1]!.toLowerCase()];
    const to = WEEKDAY_WORDS[match[2]!.toLowerCase()];
    if (from === undefined || to === undefined) continue;
    // Walk forward, wrapping through the end of the week: "Saturday - Monday" is Sat, Sun,
    // Mon. Bounded by 7 so a malformed pair cannot loop forever.
    for (let i = 0, day = from; i < 7; i++, day = (day + 1) % 7) {
      found.add(day);
      if (day === to) break;
    }
  }

  // Then any remaining individually named days ("Mondays and Fridays"), which are a LIST.
  const wordPattern = new RegExp(`\\b${WEEKDAY_WORD}\\b`, "gi");
  for (const match of text.matchAll(wordPattern)) {
    const day = WEEKDAY_WORDS[match[1]!.toLowerCase()];
    if (day !== undefined) found.add(day);
  }

  return [...found].sort((a, b) => a - b);
}

/**
 * How often a stand restocks.
 *
 * `variable`, `as_needed` and `intermittent` are real answers rather than missing data — an
 * honest description of an honor-system stand. Modelling them as absent would make them
 * indistinguishable from a stand nobody asked.
 */
export function parseStocking(text: string): ParsedStocking {
  const t = text.trim();
  if (t === "") return { cadence: "not_stated" };

  // Daily first: "Everyday, but mostly on Tuesdays and Saturdays" is genuinely daily, and the
  // qualifier is nuance to preserve rather than a day set that would overstate it.
  if (/\b(?:daily|every ?day)\b/i.test(t)) {
    const qualifier = /,\s*(but\b.*)$/i.exec(t) ?? /\.\s*(.*(?:change|harvest).*)$/i.exec(t);
    return {
      cadence: "daily",
      ...(qualifier ? { note: qualifier[1]!.trim() } : {}),
    };
  }

  if (/\bas\s+(?:needed|stock\s+runs\s+low)\b|as\s+stock\s+runs\s+low/i.test(t)) {
    return { cadence: "as_needed" };
  }
  if (/\bevery\s+few\s+days\b/i.test(t)) return { cadence: "as_needed" };
  if (/\bintermittent/i.test(t)) return { cadence: "intermittent" };
  if (/\bvariable\b/i.test(t)) return { cadence: "variable" };

  const days = weekdaysIn(t);
  if (days.length > 0) return { cadence: "specific_days", days };

  // "Weekends" names days without naming weekdays.
  if (/\bweekends?\b/i.test(t)) {
    return { cadence: "specific_days", days: [DAY.sunday, DAY.saturday] };
  }

  return { cadence: "unparsed" };
}
