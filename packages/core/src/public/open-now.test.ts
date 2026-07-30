import { describe, expect, it } from "vitest";
import {
  NAMED_SEASON_MONTHS,
  openNow,
  type StandAvailabilityFacts,
} from "./open-now";

// F-043 — "is this stand open right now", the one place this feature can lie to a customer.
//
// A wrong answer here sends someone driving across the island to a closed stand, or hides an
// open one. So this file covers EVERY `open_hours_kind` and EVERY `season_kind` the schema
// declares, including the dusk kinds and `by_appointment`, plus the combinations that
// production actually contains.
//
// THE THREE-STATE RESULT is the design decision under test (max, 2026-07-30). Production has
// 5 of 34 public stands stating no season and 12 stating no hours. A boolean would have to
// call those `false`, which asserts a farmer said "closed" when the farmer said nothing at
// all — the map claiming certainty it does not have. `"unknown"` is a real answer, and the UI
// shows those stands under the Open-now filter marked as unconfirmed rather than hiding them.
//
// Times are constructed as explicit UTC instants with an explicit offset, never from the
// host's own zone, so these assertions mean the same thing on a laptop in Seattle and in a
// UTC container.

const PDT = -7 * 60;
const PST = -8 * 60;

/** A local Pacific wall-clock time, as the instant it denotes. */
function pacific(isoLocal: string, offsetMinutes: number): Date {
  const sign = offsetMinutes <= 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return new Date(`${isoLocal}${sign}${hh}:${mm}`);
}

/** Vashon's coordinate, which every fixture below shares unless it is testing absence. */
const AT_VASHON = { latitude: 47.4471, longitude: -122.4594 };

function ask(
  availability: StandAvailabilityFacts,
  isoLocal: string,
  offsetMinutes = PDT,
) {
  return openNow({
    availability,
    at: pacific(isoLocal, offsetMinutes),
    utcOffsetMinutes: offsetMinutes,
    ...AT_VASHON,
  });
}

describe("openNow — time of day", () => {
  // Every fixture here states a year-round season, so the hours are the only variable.
  const yearRound = { season: { kind: "year_round" } } as const;

  describe("clock_range", () => {
    const nineToFive = {
      ...yearRound,
      hours: { kind: "clock_range", fromMinutes: 540, untilMinutes: 1020 },
    } as const;

    it("is open inside the stated range", () => {
      expect(ask(nineToFive, "2026-07-15T12:00:00").state).toBe("open");
    });

    it("is closed before it opens and after it shuts", () => {
      expect(ask(nineToFive, "2026-07-15T08:59:00").state).toBe("closed");
      expect(ask(nineToFive, "2026-07-15T17:01:00").state).toBe("closed");
    });

    it("includes both endpoints", () => {
      // A stand that says it opens at 9 is open at 9. Excluding the boundary would report it
      // shut to the customer standing there at opening time.
      expect(ask(nineToFive, "2026-07-15T09:00:00").state).toBe("open");
      expect(ask(nineToFive, "2026-07-15T17:00:00").state).toBe("open");
    });

    it("handles a range that crosses midnight", () => {
      // No production row does this today, but the schema permits from > until and a naive
      // `from <= now && now <= until` silently reports such a stand closed 24 hours a day.
      const overnight = {
        ...yearRound,
        hours: { kind: "clock_range", fromMinutes: 1320, untilMinutes: 300 },
      } as const;

      expect(ask(overnight, "2026-07-15T23:30:00").state).toBe("open");
      expect(ask(overnight, "2026-07-15T02:00:00").state).toBe("open");
      expect(ask(overnight, "2026-07-15T12:00:00").state).toBe("closed");
    });
  });

  describe("all_day", () => {
    const allDay = { ...yearRound, hours: { kind: "all_day" } } as const;

    it("is open at any hour, including the middle of the night", () => {
      expect(ask(allDay, "2026-07-15T03:00:00").state).toBe("open");
      expect(ask(allDay, "2026-07-15T12:00:00").state).toBe("open");
      expect(ask(allDay, "2026-12-15T23:59:00", PST).state).toBe("open");
    });
  });

  describe("dawn_to_dusk and daylight_hours — the computed sun", () => {
    const dawnToDusk = { ...yearRound, hours: { kind: "dawn_to_dusk" } } as const;
    const daylight = { ...yearRound, hours: { kind: "daylight_hours" } } as const;

    it("is open at midday and closed at midnight, in every season", () => {
      expect(ask(dawnToDusk, "2026-07-15T12:00:00").state).toBe("open");
      expect(ask(dawnToDusk, "2026-07-15T00:30:00").state).toBe("closed");
      expect(ask(dawnToDusk, "2026-01-15T12:00:00", PST).state).toBe("open");
      expect(ask(dawnToDusk, "2026-01-15T00:30:00", PST).state).toBe("closed");
    });

    it("treats daylight_hours exactly as dawn_to_dusk", () => {
      // Two phrasings VIGA's form uses for the same fact. If they ever diverge, one group of
      // farmers gets a different answer than the other for identical circumstances.
      for (const clock of ["06:00", "12:00", "20:00", "22:00"]) {
        expect(ask(daylight, `2026-07-15T${clock}:00`).state).toBe(
          ask(dawnToDusk, `2026-07-15T${clock}:00`).state,
        );
      }
    });

    it("MOVES WITH THE SEASON — 8pm is open in July and shut in December", () => {
      // The assertion this whole feature turns on, and the reason a fixed 6am-8pm schedule was
      // rejected. Sunset on Vashon is ~21:11 in late June and ~16:20 near the winter solstice,
      // so the same wall-clock hour is genuinely open in one season and dark in the other.
      // A hard-coded schedule passes one of these two lines and fails the other.
      expect(ask(dawnToDusk, "2026-07-15T20:00:00").state).toBe("open");
      expect(ask(dawnToDusk, "2026-12-15T20:00:00", PST).state).toBe("closed");

      // And the converse at the start of the day: 07:30 is daylight in July, dark in December.
      expect(ask(dawnToDusk, "2026-07-15T07:30:00").state).toBe("open");
      expect(ask(dawnToDusk, "2026-12-15T07:30:00", PST).state).toBe("closed");
    });

    it("reports how it decided, so the UI can say 'until sunset' honestly", () => {
      const answer = ask(dawnToDusk, "2026-07-15T12:00:00");
      expect(answer.state).toBe("open");
      // The sunset it computed is exposed rather than recomputed by the caller — one
      // arithmetic, one answer, no chance of the label disagreeing with the filter.
      expect(answer.sunsetMinutes).toBeGreaterThan(21 * 60);
      expect(answer.sunsetMinutes).toBeLessThan(22 * 60);
    });
  });

  describe("until_dusk — a stated start, a computed end", () => {
    const tenUntilDusk = {
      ...yearRound,
      hours: { kind: "until_dusk", fromMinutes: 600 },
    } as const;

    it("is shut before the stated opening even in full daylight", () => {
      // 7am in July is well after sunrise, but the farmer said ten o'clock. The stated fact
      // wins over the computed one; inventing an earlier opening would contradict the farmer.
      expect(ask(tenUntilDusk, "2026-07-15T07:00:00").state).toBe("closed");
      expect(ask(tenUntilDusk, "2026-07-15T10:00:00").state).toBe("open");
    });

    it("closes at the computed sunset, which moves with the season", () => {
      expect(ask(tenUntilDusk, "2026-07-15T20:30:00").state).toBe("open");
      // Same clock time in December is after sunset — and also after the stated 10am start,
      // so only the sun can be what closes it.
      expect(ask(tenUntilDusk, "2026-12-15T20:30:00", PST).state).toBe("closed");
    });
  });

  describe("by_appointment", () => {
    it("is never reported open, but is never reported closed either", () => {
      // A stand you must arrange a visit to has no "right now" answer. Reporting `open` sends
      // someone to a locked gate; reporting `closed` hides a farm that would happily sell to
      // them today. The honest answer is that this filter does not apply.
      const byAppointment = {
        ...yearRound,
        hours: { kind: "by_appointment" },
      } as const;

      expect(ask(byAppointment, "2026-07-15T12:00:00").state).toBe("by_appointment");
      expect(ask(byAppointment, "2026-07-15T03:00:00").state).toBe("by_appointment");
    });
  });

  it("returns 'unknown' when hours were never stated, NEVER 'closed'", () => {
    // 12 of 34 public stands are in exactly this state. Calling them closed would assert
    // something no farmer said and would empty the most useful filter of a third of the map.
    const seasonOnly = { season: { kind: "year_round" } } as const;

    expect(ask(seasonOnly, "2026-07-15T12:00:00").state).toBe("unknown");
    expect(ask(seasonOnly, "2026-07-15T03:00:00").state).toBe("unknown");
  });
});

describe("openNow — season", () => {
  // Every fixture states all-day hours, so the season is the only variable.
  const allDay = { hours: { kind: "all_day" } } as const;

  it("year_round is in season on any date", () => {
    const stand = { ...allDay, season: { kind: "year_round" } } as const;

    expect(ask(stand, "2026-01-15T12:00:00", PST).state).toBe("open");
    expect(ask(stand, "2026-07-15T12:00:00").state).toBe("open");
  });

  describe("date_range", () => {
    const mayToOctober = {
      ...allDay,
      season: {
        kind: "date_range",
        startMonth: 5,
        startDay: 1,
        endMonth: 10,
        endDay: 31,
      },
    } as const;

    it("is open inside the range and out of season outside it", () => {
      expect(ask(mayToOctober, "2026-07-15T12:00:00").state).toBe("open");
      expect(ask(mayToOctober, "2026-03-15T12:00:00", PST).state).toBe("out_of_season");
      expect(ask(mayToOctober, "2026-12-15T12:00:00", PST).state).toBe("out_of_season");
    });

    it("includes both endpoint days", () => {
      // A season stated as "May 1 - Oct 31" includes both of those days. Excluding them
      // reports the stand shut on its own opening day.
      expect(ask(mayToOctober, "2026-05-01T12:00:00").state).toBe("open");
      expect(ask(mayToOctober, "2026-10-31T12:00:00").state).toBe("open");
      expect(ask(mayToOctober, "2026-04-30T12:00:00").state).toBe("out_of_season");
      expect(ask(mayToOctober, "2026-11-01T12:00:00").state).toBe("out_of_season");
    });

    it("handles a range that wraps the new year", () => {
      // "November to February" is a real way to state a winter season, and a naive
      // start <= today <= end comparison reports it out of season every single day.
      const novToFeb = {
        ...allDay,
        season: {
          kind: "date_range",
          startMonth: 11,
          startDay: 1,
          endMonth: 2,
          endDay: 28,
        },
      } as const;

      expect(ask(novToFeb, "2026-12-15T12:00:00", PST).state).toBe("open");
      expect(ask(novToFeb, "2026-01-15T12:00:00", PST).state).toBe("open");
      expect(ask(novToFeb, "2026-07-15T12:00:00").state).toBe("out_of_season");
    });
  });

  describe("named_season", () => {
    it("resolves names against the documented constant, not per-row months", () => {
      // F-035's rule. The constant is the single place "summer" is defined; a VIGA correction
      // changes it once rather than requiring every row to be re-seeded.
      const summer = {
        ...allDay,
        season: { kind: "named_season", names: ["summer"] },
      } as const;

      expect(ask(summer, "2026-07-15T12:00:00").state).toBe("open");
      expect(ask(summer, "2026-01-15T12:00:00", PST).state).toBe("out_of_season");
      // Anchored to the constant itself, so this test moves with a deliberate correction
      // rather than pinning July by coincidence.
      expect(NAMED_SEASON_MONTHS.summer).toContain(7);
    });

    it("is in season when ANY of several names covers today", () => {
      const springAndFall = {
        ...allDay,
        season: { kind: "named_season", names: ["spring", "fall"] },
      } as const;

      expect(ask(springAndFall, "2026-04-15T12:00:00").state).toBe("open");
      expect(ask(springAndFall, "2026-10-15T12:00:00").state).toBe("open");
      // July belongs to neither.
      expect(ask(springAndFall, "2026-07-15T12:00:00").state).toBe("out_of_season");
    });

    it("covers winter's year-wrapping months", () => {
      // Winter is the one named season whose months are not contiguous in a calendar year.
      const winter = {
        ...allDay,
        season: { kind: "named_season", names: ["winter"] },
      } as const;

      expect(ask(winter, "2026-01-15T12:00:00", PST).state).toBe("open");
      expect(ask(winter, "2026-12-15T12:00:00", PST).state).toBe("open");
      expect(ask(winter, "2026-07-15T12:00:00").state).toBe("out_of_season");
    });

    it("treats an unrecognized season name as unknown rather than out of season", () => {
      // The column is `text[]`, so a future value the constant does not know is possible.
      // Guessing "not in season" would silently hide a stand; `unknown` shows it, marked.
      const odd = {
        ...allDay,
        season: { kind: "named_season", names: ["monsoon"] },
      } as const;

      expect(ask(odd, "2026-07-15T12:00:00").state).toBe("unknown");
    });
  });

  describe("open_ended", () => {
    const fromJune = {
      ...allDay,
      season: { kind: "open_ended", startMonth: 6, startDay: 1 },
    } as const;

    it("is open on and after its start date", () => {
      expect(ask(fromJune, "2026-06-01T12:00:00").state).toBe("open");
      expect(ask(fromJune, "2026-07-15T12:00:00").state).toBe("open");
    });

    it("stays open indefinitely — the end was explicitly unknown, not zero", () => {
      // Morgan Hill's "June 1, 2026 - TBD". The farmer said they do not know when it ends,
      // which is not the same as ending immediately.
      expect(ask(fromJune, "2026-11-15T12:00:00", PST).state).toBe("open");
    });

    it("is out of season before its start date", () => {
      expect(ask(fromJune, "2026-03-15T12:00:00", PST).state).toBe("out_of_season");
    });
  });

  it("returns 'unknown' when the season was never stated, NEVER 'out_of_season'", () => {
    // 5 of 34 public stands. Same rule as unstated hours: absence is not a closure.
    const hoursOnly = { hours: { kind: "all_day" } } as const;

    expect(ask(hoursOnly, "2026-01-15T12:00:00", PST).state).toBe("unknown");
  });
});

describe("openNow — how season, hours and days compose", () => {
  it("is out of season even during stated open hours", () => {
    // "Open now also means in season" (max, 2026-07-30). A stand closed for the year is not
    // open at noon, and one control means one plain-language thing.
    const summerNineToFive = {
      season: {
        kind: "date_range",
        startMonth: 6,
        startDay: 1,
        endMonth: 8,
        endDay: 31,
      },
      hours: { kind: "clock_range", fromMinutes: 540, untilMinutes: 1020 },
    } as const;

    expect(ask(summerNineToFive, "2026-07-15T12:00:00").state).toBe("open");
    expect(ask(summerNineToFive, "2026-12-15T12:00:00", PST).state).toBe("out_of_season");
  });

  it("season is decided BEFORE hours, so a closed-for-the-year stand says so", () => {
    // Ordering matters for the message the customer reads. Out of season is the more useful
    // and more durable fact: "closed for the season" tells someone not to come back tomorrow,
    // where "closed right now" invites them to try this evening.
    const winterOnlyMorning = {
      season: {
        kind: "date_range",
        startMonth: 11,
        startDay: 1,
        endMonth: 12,
        endDay: 31,
      },
      hours: { kind: "clock_range", fromMinutes: 540, untilMinutes: 1020 },
    } as const;

    // July, and also outside the stated hours: both would be "not open", but the reason
    // reported must be the season.
    expect(ask(winterOnlyMorning, "2026-07-15T20:00:00").state).toBe("out_of_season");
  });

  it("respects open_days when stated", () => {
    // No production row carries a day set today, but the schema permits it and the predicate
    // must honour one the moment a loader writes it.
    const weekendsOnly = {
      season: { kind: "year_round" },
      hours: { kind: "all_day" },
      days: [0, 6],
    } as const;

    // 2026-07-18 is a Saturday; 2026-07-15 is a Wednesday.
    expect(ask(weekendsOnly, "2026-07-18T12:00:00").state).toBe("open");
    expect(ask(weekendsOnly, "2026-07-15T12:00:00").state).toBe("closed_today");
  });

  it("uses the LOCAL weekday, not UTC's", () => {
    // 2026-07-18T23:00 Pacific is already Sunday in UTC. A stand open only on Saturday must
    // still read as open — reading the weekday off the UTC date silently shifts every day
    // boundary by seven hours for the evening customers who most need the answer.
    const saturdayOnly = {
      season: { kind: "year_round" },
      hours: { kind: "all_day" },
      days: [6],
    } as const;

    expect(ask(saturdayOnly, "2026-07-18T23:00:00").state).toBe("open");
  });

  it("returns 'unknown' when NOTHING is stated", () => {
    // 4 of 34 public stands state neither. The map shows them, marked unconfirmed.
    expect(ask({}, "2026-07-15T12:00:00").state).toBe("unknown");
  });

  it("is 'unknown' when the season is stated but the hours are not", () => {
    // Production's most common partial shape — 8 stands. In season is genuinely known; the
    // time of day is genuinely not, so the composed answer cannot be better than unknown.
    const seasonOnly = {
      season: {
        kind: "date_range",
        startMonth: 5,
        startDay: 1,
        endMonth: 10,
        endDay: 31,
      },
    } as const;

    expect(ask(seasonOnly, "2026-07-15T12:00:00").state).toBe("unknown");
  });

  it("is 'out_of_season' when the season is stated and excludes today, even with no hours", () => {
    // The one case where a partially stated stand still gets a definite answer: the season
    // alone settles it. Being conservative here would hide a fact the farmer did state.
    const seasonOnly = {
      season: {
        kind: "date_range",
        startMonth: 5,
        startDay: 1,
        endMonth: 10,
        endDay: 31,
      },
    } as const;

    expect(ask(seasonOnly, "2026-12-15T12:00:00", PST).state).toBe("out_of_season");
  });

  it("never returns a state that would hide a stand without the farmer having said so", () => {
    // A sweep over every kind combination the schema allows, asserting the safety property
    // rather than a specific answer: a stand is only ever reported definitively shut
    // (`closed`, `closed_today`, `out_of_season`) when the fact that closes it WAS STATED.
    const hourKinds = [
      undefined,
      { kind: "dawn_to_dusk" },
      { kind: "daylight_hours" },
      { kind: "all_day" },
      { kind: "by_appointment" },
      { kind: "clock_range", fromMinutes: 540, untilMinutes: 1020 },
      { kind: "until_dusk", fromMinutes: 600 },
    ] as const;
    const seasonKinds = [
      undefined,
      { kind: "year_round" },
      { kind: "date_range", startMonth: 5, startDay: 1, endMonth: 10, endDay: 31 },
      { kind: "named_season", names: ["summer"] },
      { kind: "open_ended", startMonth: 6, startDay: 1 },
    ] as const;

    for (const hours of hourKinds) {
      for (const season of seasonKinds) {
        const availability = {
          ...(hours ? { hours } : {}),
          ...(season ? { season } : {}),
        } as StandAvailabilityFacts;
        const answer = ask(availability, "2026-07-15T12:00:00");

        if (answer.state === "closed" || answer.state === "closed_today") {
          expect(availability.hours).toBeDefined();
        }
        if (answer.state === "out_of_season") {
          expect(availability.season).toBeDefined();
        }
      }
    }
  });
});

describe("openNow — coordinates", () => {
  it("falls back to the island for a stand with no coordinate of its own", () => {
    // F-038's contact-only farms have no pin. Vashon is small enough that the sun is the same
    // across it, so a missing coordinate must not cost a stand its daylight judgement.
    const dawnToDusk = {
      season: { kind: "year_round" },
      hours: { kind: "dawn_to_dusk" },
    } as const;

    const withoutCoordinates = openNow({
      availability: dawnToDusk,
      at: pacific("2026-07-15T12:00:00", PDT),
      utcOffsetMinutes: PDT,
    });

    expect(withoutCoordinates.state).toBe("open");
  });
});
