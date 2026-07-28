import { describe, expect, it } from "vitest";
import { parseOpenHours, parseSeason, parseStocking, DAY } from "./availability";

// F-035 — turning VIGA's prose into filterable data.
//
// Every input string in this file is REAL, copied from the VIGA farm-stand export. That
// matters: a parser tested against strings its author invented is a parser tested against its
// own assumptions. The awkward cases here ("Everyday, but mostly on Tuesdays and Saturdays",
// "Spring and summer as flowers and eggs permit") are the ones that decide whether this
// design survives contact with the corpus.
//
// The parser's contract in one line: it NEVER guesses. Anything it cannot classify comes back
// as `unparsed`, which the seeder turns into a stand_data_flag for a human — because a wrong
// day set is worse than an absent one on a map whose whole premise is honesty about
// uncertainty.

describe("parseOpenHours", () => {
  it("reads the relative kinds as first-class values, not as missing times", () => {
    // The heart of max's 2026-07-28 decision. "Dawn to dusk" is not a degraded clock range to
    // be normalized into 06:00-20:00 — on Vashon that span moves ~6 hours across the season,
    // so a clock time here would be an invention. It is its own kind.
    expect(parseOpenHours("All year, dawn to dusk")).toMatchObject({
      kind: "dawn_to_dusk",
    });
    expect(parseOpenHours("Year-round Dawn to Dusk")).toMatchObject({
      kind: "dawn_to_dusk",
    });
    expect(
      parseOpenHours("June - October 7 days a week, daylight hours"),
    ).toMatchObject({ kind: "daylight_hours" });
    expect(parseOpenHours("June 1, 2026 - TBD daylight hours and 7 days a week"))
      .toMatchObject({ kind: "daylight_hours" });
  });

  it("reads every way the corpus writes 'always open'", () => {
    for (const text of ["Spring-fall 24/7", "Year round , 24/7", "Summer 24/7",
                        "July 1 to Oct 15 24 hours", "Year around Sunday - Saturday 24hrs"]) {
      expect(parseOpenHours(text), text).toMatchObject({ kind: "all_day" });
    }
  });

  it("reads explicit clock ranges into minutes past midnight", () => {
    expect(parseOpenHours("April- October 10:00am-7:00pm Daily")).toMatchObject({
      kind: "clock_range",
      fromMinutes: 10 * 60,
      untilMinutes: 19 * 60,
    });
    expect(parseOpenHours("Summer 11am-6pm")).toMatchObject({
      kind: "clock_range",
      fromMinutes: 11 * 60,
      untilMinutes: 18 * 60,
    });
    expect(parseOpenHours("Seasonally March through June Everyday 8 am to 6 pm"))
      .toMatchObject({ kind: "clock_range", fromMinutes: 8 * 60, untilMinutes: 18 * 60 });
    expect(parseOpenHours("Year round M-F 8am to 5pm")).toMatchObject({
      kind: "clock_range",
      fromMinutes: 8 * 60,
      untilMinutes: 17 * 60,
    });
    // 9am-8pm — the minute component must survive when present.
    expect(parseOpenHours("year round, everyday 9am-8pm")).toMatchObject({
      kind: "clock_range",
      fromMinutes: 9 * 60,
      untilMinutes: 20 * 60,
    });
  });

  it("reads a clock opening that runs until dusk", () => {
    // Green Ears: a real start, an end that is not a clock time. Neither `clock_range` nor
    // `dawn_to_dusk` fits, which is why `until_dusk` exists.
    expect(parseOpenHours("April - July Thursday - Sunday / 10AM - Dusk")).toMatchObject({
      kind: "until_dusk",
      fromMinutes: 10 * 60,
    });
    expect(parseOpenHours("Thursday - Sunday / 9am - Dusk")).toMatchObject({
      kind: "until_dusk",
      fromMinutes: 9 * 60,
    });
  });

  it("reads by-appointment as a kind rather than as absent hours", () => {
    expect(
      parseOpenHours("only by appointment – We have a place for learning about herbs"),
    ).toMatchObject({ kind: "by_appointment" });
  });

  it("distinguishes 'no hours stated' from 'hours I could not read'", () => {
    // The dry run over all 31 stands forced this distinction out. Alta Rosa's "May 1- Nov 1"
    // and Provo's "All year, All days" are not unreadable hours — they are stands that never
    // stated a time of day. Flagging them would bury the two genuine ambiguities under ten
    // stands that are perfectly fine.
    expect(parseOpenHours("May 1- Nov 1")).toMatchObject({ kind: "not_stated" });
    expect(parseOpenHours("March to December")).toMatchObject({ kind: "not_stated" });
    expect(parseOpenHours("Year Round")).toMatchObject({ kind: "not_stated" });
    expect(parseOpenHours("All year, All days")).toMatchObject({ kind: "not_stated" });
    expect(parseOpenHours("")).toMatchObject({ kind: "not_stated" });
  });

  it("returns unparsed when a time of day IS stated but not understood", () => {
    // The load-bearing negative. A parser that always produces an answer produces wrong ones,
    // and on this map a confident wrong answer is the failure mode that matters. These name a
    // time, so failing to read them is a defect a human must settle — not a silent default.
    expect(parseOpenHours("open till dusk-ish most days")).toMatchObject({
      kind: "unparsed",
    });
    expect(parseOpenHours("hours by the sunrise bell")).toMatchObject({ kind: "unparsed" });
  });
});

describe("parseSeason", () => {
  it("reads every spelling of year-round as the same value", () => {
    // Nine stands, seven spellings. `year_round` must be distinct from "unknown" so a filter
    // can tell "always open" from "we never asked".
    for (const text of ["All year, dawn to dusk", "Year round , 24/7", "Year-round Dawn to Dusk",
                        "Year Round", "Year around Sunday - Saturday 24hrs", "All year, All days",
                        "Open all year dawn to dusk", "year round, everyday 9am-8pm"]) {
      expect(parseSeason(text), text).toMatchObject({ kind: "year_round" });
    }
  });

  it("reads explicit date ranges", () => {
    expect(parseSeason("May 1- Nov 1")).toMatchObject({
      kind: "date_range",
      startMonth: 5,
      startDay: 1,
      endMonth: 11,
      endDay: 1,
    });
    expect(parseSeason("July 1 to Oct 15 24 hours")).toMatchObject({
      kind: "date_range",
      startMonth: 7,
      startDay: 1,
      endMonth: 10,
      endDay: 15,
    });
  });

  it("reads bare month ranges as whole months", () => {
    // "March to December" states months, not days. Start on the 1st and end on the last day
    // of the end month — the only reading that does not narrow what the farmer said.
    expect(parseSeason("March to December")).toMatchObject({
      kind: "date_range",
      startMonth: 3,
      startDay: 1,
      endMonth: 12,
      endDay: 31,
    });
    expect(parseSeason("April- October 10:00am-7:00pm Daily")).toMatchObject({
      kind: "date_range",
      startMonth: 4,
      startDay: 1,
      endMonth: 10,
      endDay: 31,
    });
    expect(parseSeason("March-November. 7 days a week, dawn to dusk.")).toMatchObject({
      kind: "date_range",
      startMonth: 3,
      startDay: 1,
      endMonth: 11,
      endDay: 30,
    });
  });

  it("reads named seasons WITHOUT resolving them to months", () => {
    // Resolution happens at query time from one shared constant, so a correction to what
    // "summer" means on Vashon changes a constant instead of requiring a re-seed.
    expect(parseSeason("Spring-fall 24/7")).toMatchObject({
      kind: "named_season",
      names: ["spring", "fall"],
    });
    expect(parseSeason("Summer 11am-6pm")).toMatchObject({
      kind: "named_season",
      names: ["summer"],
    });
    expect(parseSeason("Spring, Summer, Fall Thursday afternoon through Sunday"))
      .toMatchObject({ kind: "named_season", names: ["spring", "summer", "fall"] });
  });

  it("reads a stated start with no stated end as open_ended", () => {
    // Morgan Hill. "TBD" is the farmer telling us they do not know; inventing an end date
    // would be worse than recording the honest open end.
    expect(parseSeason("June 1, 2026 - TBD daylight hours and 7 days a week"))
      .toMatchObject({ kind: "open_ended", startMonth: 6, startDay: 1 });
  });

  it("returns unparsed when a season IS named but not understood", () => {
    // Holmestead's "Mid April Weekends" names a month this parser cannot combine into a
    // range. That is a real ambiguity for a human, not a stand without a season.
    expect(parseSeason("Mid April Weekends")).toMatchObject({ kind: "unparsed" });
    expect(parseSeason("Mid-May thru October Daily")).toMatchObject({ kind: "date_range" });
  });

  it("reports no season stated as a fact, not a defect", () => {
    expect(parseSeason("")).toMatchObject({ kind: "not_stated" });
    expect(parseSeason("Thursday - Sunday / 9am - Dusk")).toMatchObject({
      kind: "not_stated",
    });
  });
});

describe("parseStocking", () => {
  it("reads plain daily cadences", () => {
    for (const text of ["Daily", "Daily restock", "generally daily", "Stocking daily"]) {
      expect(parseStocking(text), text).toMatchObject({ cadence: "daily" });
    }
  });

  it("reads specific weekdays", () => {
    expect(parseStocking("Mondays and Fridays")).toMatchObject({
      cadence: "specific_days",
      days: [DAY.monday, DAY.friday],
    });
    expect(parseStocking("Tuesday and Friday")).toMatchObject({
      cadence: "specific_days",
      days: [DAY.tuesday, DAY.friday],
    });
    expect(parseStocking("Saturday and Sunday")).toMatchObject({
      cadence: "specific_days",
      days: [DAY.sunday, DAY.saturday],
    });
    expect(parseStocking("Friday")).toMatchObject({
      cadence: "specific_days",
      days: [DAY.friday],
    });
  });

  it("treats unpredictable restocking as a real answer, not missing data", () => {
    // max's rule, applied: "we restock as stock runs low" is honest, not absent. As NULL it
    // would be indistinguishable from a stand nobody asked.
    expect(parseStocking("variable")).toMatchObject({ cadence: "variable" });
    expect(parseStocking("Intermittent")).toMatchObject({ cadence: "intermittent" });
    expect(parseStocking("As needed")).toMatchObject({ cadence: "as_needed" });
    expect(parseStocking("Every few days as stock runs low")).toMatchObject({
      cadence: "as_needed",
    });
  });

  it("keeps the farmer's caveat when a daily cadence is qualified", () => {
    // Aeggy's: "Everyday, but mostly on Tuesdays and Saturdays". The cadence is genuinely
    // daily; the nuance is real and belongs in the display-only note rather than being
    // flattened away or promoted into a day set that overstates it.
    const parsed = parseStocking("Everyday, but mostly on Tuesdays and Saturdays");
    expect(parsed.cadence).toBe("daily");
    expect(parsed.note).toMatch(/mostly on Tuesdays and Saturdays/i);
  });

  it("separates an absent cadence from an unreadable one", () => {
    expect(parseStocking("")).toMatchObject({ cadence: "not_stated" });
    expect(parseStocking("when the moon is right")).toMatchObject({ cadence: "unparsed" });
  });
});
