import { describe, expect, it } from "vitest";
import { parseOpenDays } from "./open-days";

// B-039 — which WEEKDAYS a stand is open, as distinct from its time of day.
//
// The bug this closes: 13 of 35 stands rendered "Hours not listed" while stating their hours,
// because the answers are day patterns — "All days", "Weekends", "Thursday afternoon through
// Sunday" — and `open_hours_kind` models times of day, so it genuinely cannot hold them.
// `sales_locations.open_days` can, and nothing ever wrote it.
//
// TWO AXES, ONE ANSWER. VIGA's form asks "Open Hours & Days" as a single question, so a real
// answer often carries both: "10-6, Wednesday & Saturday" is a clock range AND a day set. This
// parser reads only the days and composes with `parseOpenHours`, which reads only the times.
// Neither replaces the other.
//
// IT REFUSES RATHER THAN GUESSES. A wrong open-day sends a customer to a stand that is shut,
// which is the same class of harm as a wrong pin. Anything this cannot read confidently stays
// null, and the card falls back to saying nothing about days.
//
// Every fixture is a REAL 2026 answer, measured against the profile export on 2026-08-08.

const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;
const ALL = [SUN, MON, TUE, WED, THU, FRI, SAT];

describe("parseOpenDays", () => {
  describe("every day, however the farmer says it", () => {
    it.each([
      ["All days", "Provo Farms"],
      ["Daily", "Olive Farm"],
      ["24/7", "Bart's Cart"],
      ["24/7 self service stand", "Bananas Barn"],
      ["24 hours", "Peach Tree Hill"],
      ["Open daylight hours and 7 days a week", "Morgan Hill"],
      ["7 days a week, daylight hours", "Northbourne Farm"],
      ["7 days a week, dawn to dusk", "Pacific Crest Farm"],
      ["10:00am-7:00pm Daily", "Fruits des Vignes"],
      ["Everyday 8 am to 6 pm", "Peak Moon Nursery"],
      ["everyday 9am-8pm", "Plum Forest Farm"],
      ["Monday - Sunday", "Alta Rosa Farm"],
      ["Sunday - Saturday 24hrs", "Ostara Farm & Flowers"],
    ])("reads %j as the whole week (%s)", (text) => {
      expect(parseOpenDays(text)).toEqual(ALL);
    });
  });

  describe("a named range", () => {
    it("reads a weekday range that wraps nothing", () => {
      // Sorted, not stated-order: this is a SET of days, and the column's CHECK wants
      // distinct values. Sunday sorts first because the week is indexed from Sunday = 0.
      expect(parseOpenDays("Thursday - Sunday / 10AM - Dusk")).toEqual([SUN, THU, FRI, SAT]);
    });

    it("reads a range stated with 'through'", () => {
      expect(parseOpenDays("Thursday afternoon through Sunday")).toEqual([SUN, THU, FRI, SAT]);
    });

    it("reads the abbreviated business week", () => {
      expect(parseOpenDays("M-F 8am to 5pm")).toEqual([MON, TUE, WED, THU, FRI]);
    });

    it("wraps a range that crosses the end of the week", () => {
      // Not in the 2026 corpus, but the arithmetic must be right or a Friday–Monday stand
      // publishes Tuesday through Thursday — the days it is SHUT.
      expect(parseOpenDays("Friday - Monday")).toEqual([SUN, MON, FRI, SAT]);
    });
  });

  describe("a list of individual days", () => {
    it("reads days joined by an ampersand, alongside a clock range", () => {
      expect(parseOpenDays("10-6, Wednesday & Saturday")).toEqual([WED, SAT]);
    });

    it("reads days joined by 'and'", () => {
      expect(parseOpenDays("Saturday and Sunday when available")).toEqual([SUN, SAT]);
    });
  });

  it("reads 'weekends' as Saturday and Sunday", () => {
    expect(parseOpenDays("Weekends")).toEqual([SUN, SAT]);
  });

  describe("what it REFUSES, because a wrong day sends someone to a shut stand", () => {
    it("returns nothing for an answer that names no schedule", () => {
      expect(parseOpenDays("See below")).toBeUndefined();
      expect(parseOpenDays("")).toBeUndefined();
      expect(parseOpenDays("   ")).toBeUndefined();
    });

    it("returns nothing for a time-only answer", () => {
      // "11am-6pm" and "Dawn to Dusk" state WHEN, never WHICH DAYS. Reading them as every day
      // would publish a seven-day stand from an answer that never said so.
      expect(parseOpenDays("11am-6pm")).toBeUndefined();
      expect(parseOpenDays("Dawn to Dusk")).toBeUndefined();
      expect(parseOpenDays("9 am - dusk. Monday - Sunday")).toEqual(ALL);
    });

    it("refuses a SEASONALLY SPLIT answer rather than picking one season", () => {
      // Sweet Alyssum's real row: "Open when sign is out! Spring: Fri- Sun, Summer: everyday".
      // One day set cannot express two seasons, and choosing either publishes the wrong days
      // for half the year. The stand keeps its data flag and says nothing about days.
      expect(
        parseOpenDays("Open when sign is out! Spring: Fri- Sun, Summer: everyday"),
      ).toBeUndefined();
    });

    it("refuses an appointment-only answer, which is not a schedule", () => {
      expect(parseOpenDays("By appointment only")).toBeUndefined();
    });
  });

  it("returns days sorted and deduplicated, so the CHECK constraint holds", () => {
    // `sales_locations_valid_open_days` requires 1–7 values drawn from 0..6. A farmer naming a
    // day twice must not produce a duplicate the database then refuses.
    expect(parseOpenDays("Saturday, Sat & Saturday")).toEqual([SAT]);
    const all = parseOpenDays("Monday - Sunday")!;
    expect(all).toEqual([...all].sort((a, b) => a - b));
    expect(new Set(all).size).toBe(all.length);
  });
});
