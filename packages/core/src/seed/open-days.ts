// B-039 — which WEEKDAYS a stand is open.
//
// ## Why this is a separate parser from `parseOpenHours`
//
// VIGA's form asks "Open Hours & Days" as ONE question, and farmers answer both axes in one
// sentence: "10-6, Wednesday & Saturday" is a clock range and a day set. The database has held
// two columns for this all along — `open_hours_kind` for the time of day, `open_days` for the
// weekdays — and `parseOpenHours` only ever read the first.
//
// So 13 of 35 stands rendered "Hours not listed" beside an answer stating exactly when they are
// open, because the answer was a DAY pattern and nothing could read one. This reads only days;
// `parseOpenHours` reads only times; a stand may have either, both, or neither.
//
// ## It refuses rather than guesses
//
// A wrong open-day sends a customer to a stand that is shut — the same class of harm as a wrong
// pin, and the reason `SUPPLEMENTAL_COORDINATES` exists rather than a geocoder guess. Every rule
// below was measured against the real 2026 corpus, and anything outside them returns
// `undefined`, which the card renders as saying nothing about days at all.
//
// The sharpest refusal is the SEASONAL SPLIT: Sweet Alyssum states "Spring: Fri- Sun, Summer:
// everyday", and one day set cannot express two seasons. Picking either publishes the wrong days
// for half the year, so the stand keeps its data flag and states nothing.

/** 0 = Sunday, matching `sales_locations.open_days` and JavaScript's `getDay()`. */
const DAY_INDEX = new Map<string, number>([
  ["sunday", 0], ["sun", 0], ["su", 0],
  ["monday", 1], ["mon", 1], ["m", 1],
  ["tuesday", 2], ["tues", 2], ["tue", 2], ["tu", 2],
  ["wednesday", 3], ["weds", 3], ["wed", 3], ["w", 3],
  ["thursday", 4], ["thurs", 4], ["thur", 4], ["thu", 4], ["th", 4],
  ["friday", 5], ["fri", 5], ["f", 5],
  ["saturday", 6], ["sat", 6], ["sa", 6],
]);

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/**
 * Answers that mean the whole week without naming a day.
 *
 * `24/7`, `24 hours` and `24hrs` say it through the clock rather than the calendar — a stand
 * open around the clock is open every day, which is what the farmer means and what the map
 * should say.
 */
const WHOLE_WEEK =
  /\b(?:all\s+days?|every\s*day|daily|24\s*\/\s*7|24\s*(?:hrs?|hours?)|7\s*days?(?:\s+a\s+week)?)\b/i;

/**
 * A schedule that is not a weekday pattern at all.
 *
 * `by appointment` is a way to arrange a visit, not a day the stand is open, and `open_hours_kind`
 * already carries it. Publishing it as days would put a stand on the map for days nobody can
 * turn up.
 */
const NOT_A_DAY_PATTERN = /by\s+appointment/i;

/**
 * An answer that states DIFFERENT days in different seasons.
 *
 * Real row: "Open when sign is out! Spring: Fri- Sun, Summer: everyday". The column holds one
 * set, so any choice here is wrong for part of the year. Detected by a season word carrying its
 * own schedule — a bare mention ("summer squash") has no colon and does not match.
 */
const SEASONAL_SPLIT = /\b(?:spring|summer|fall|autumn|winter)\s*:/i;

/** Every day name or abbreviation, longest-first so "sun" never wins inside "sunday". */
const DAY_WORD = String.raw`(?:sunday|saturday|thursday|wednesday|tuesday|monday|friday|thurs|thur|weds|sun|sat|thu|tue|wed|mon|fri|su|sa|th|tu|we|mo|fr|m|w|f)`;

/** "Thursday - Sunday", "M-F", "Thursday afternoon through Sunday". */
const RANGE = new RegExp(
  String.raw`\b(${DAY_WORD})\b[^,;.]{0,20}?\s*(?:-|–|—|thru|through|to)\s*\b(${DAY_WORD})\b`,
  "i",
);

/** Sort ascending and drop repeats, so the `1..7 distinct values` CHECK always holds. */
function normalize(days: number[]): number[] | undefined {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  return unique.length === 0 ? undefined : unique;
}

/**
 * Read which weekdays a stand states it is open.
 *
 * Returns `undefined` — never a guess — when the answer names no days, states only a time of
 * day, or states different days in different seasons.
 */
export function parseOpenDays(text: string): number[] | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  if (NOT_A_DAY_PATTERN.test(t)) return undefined;

  // Checked BEFORE everything else: the seasonal rows also contain day names and a "whole week"
  // word, so any later rule would happily read one season's schedule as the stand's answer.
  if (SEASONAL_SPLIT.test(t)) return undefined;

  if (WHOLE_WEEK.test(t)) return [...EVERY_DAY];

  // "Weekends" is the one collective term farmers actually use here.
  if (/\bweekends?\b/i.test(t)) return normalize([0, 6]);

  // A range before individual days: "Thursday - Sunday" contains two day words, and reading it
  // as a list would publish Thursday and Sunday while omitting the Friday and Saturday between.
  const range = RANGE.exec(t);
  if (range) {
    const from = DAY_INDEX.get(range[1]!.toLowerCase());
    const to = DAY_INDEX.get(range[2]!.toLowerCase());
    if (from !== undefined && to !== undefined) {
      const days: number[] = [];
      // Walks FORWARD and wraps, so "Friday - Monday" is Fri/Sat/Sun/Mon rather than the four
      // days the stand is shut. `<= 6` bounds it at a full week for `from === to`.
      for (let step = 0; step <= 6; step += 1) {
        const day = (from + step) % 7;
        days.push(day);
        if (day === to) break;
      }
      return normalize(days);
    }
  }

  // Individual named days. Bare single letters are deliberately NOT matched here: "M" and "F"
  // are only unambiguous inside a range like "M-F", and a stray "f" in prose would otherwise
  // publish a Friday.
  const named = [...t.matchAll(new RegExp(String.raw`\b(${DAY_WORD})\b`, "gi"))]
    .map((match) => match[1]!.toLowerCase())
    .filter((word) => word.length > 1)
    .map((word) => DAY_INDEX.get(word))
    .filter((day): day is number => day !== undefined);

  return normalize(named);
}
