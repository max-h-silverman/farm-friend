import { describe, expect, it } from "vitest";
import { readAvailabilityFacts } from "./availability-columns";

/*
  F-114 Phase C.5 — reading F-035's availability columns, stated once.

  `stand_providers` mirrors every one of `sales_locations`' availability columns, so the public
  card now reads the same six columns off two different tables. The rule they are read by —
  **nothing is defaulted, and an unstated field stays unstated** — is the same rule for both,
  and a second copy of it would be a second place a `year_round` could be invented for a farmer
  who never said so.
*/

describe("readAvailabilityFacts", () => {
  it("returns nothing at all for a row that stated nothing", () => {
    // THE LOAD-BEARING CASE. Every column null must produce `{}`, not a default schedule —
    // "the farmer never said" is not "closed" and is not "year round".
    expect(readAvailabilityFacts({})).toEqual({});
  });

  it("reads a year-round season", () => {
    expect(readAvailabilityFacts({ season_kind: "year_round" })).toEqual({
      season: { kind: "year_round" },
    });
  });

  it("reads a dated season range", () => {
    expect(
      readAvailabilityFacts({
        season_kind: "date_range",
        season_start_month: 3,
        season_start_day: 1,
        season_end_month: 11,
        season_end_day: 30,
      }),
    ).toEqual({
      season: {
        kind: "date_range",
        startMonth: 3,
        startDay: 1,
        endMonth: 11,
        endDay: 30,
      },
    });
  });

  it("keeps a named season as NAMES, never resolved to months", () => {
    // F-035's rule: a named season resolves at query time against one documented constant, so
    // VIGA correcting what "summer" means changes that constant rather than every row.
    expect(
      readAvailabilityFacts({ season_kind: "named_season", season_names: ["summer"] }),
    ).toEqual({ season: { kind: "named_season", names: ["summer"] } });
  });

  it("gives a dusk-bound row no clock times", () => {
    // Storing dawn/dusk as fixed hours would invent a precision the farmer never stated — dusk
    // on Vashon moves ~6 hours across the year. The sun is arithmetic done at read time.
    expect(readAvailabilityFacts({ open_hours_kind: "dawn_to_dusk" })).toEqual({
      hours: { kind: "dawn_to_dusk" },
    });
  });

  it("reads a clock range's two operands", () => {
    expect(
      readAvailabilityFacts({
        open_hours_kind: "clock_range",
        open_from_minutes: 540,
        open_until_minutes: 780,
      }),
    ).toEqual({ hours: { kind: "clock_range", fromMinutes: 540, untilMinutes: 780 } });
  });

  it("reads until_dusk's single operand", () => {
    expect(
      readAvailabilityFacts({ open_hours_kind: "until_dusk", open_from_minutes: 600 }),
    ).toEqual({ hours: { kind: "until_dusk", fromMinutes: 600 } });
  });

  it("treats an empty day array as unstated rather than as open on no day", () => {
    // `array_length` of an empty array is NULL in Postgres, and an empty list here would read
    // downstream as "open on none of the seven days" — a closure no farmer stated.
    expect(readAvailabilityFacts({ open_days: [] })).toEqual({});
  });

  it("reads a stated day pattern", () => {
    expect(readAvailabilityFacts({ open_days: [0, 6] })).toEqual({ days: [0, 6] });
  });

  it("reads season and hours independently", () => {
    // 8 production stands state a season and no hours; 1 states hours and no season. Grouping
    // them would drop a real fact for a quarter of the island.
    expect(
      readAvailabilityFacts({ season_kind: "year_round", open_hours_kind: "all_day" }),
    ).toEqual({ season: { kind: "year_round" }, hours: { kind: "all_day" } });
  });

  it("ignores a season kind it does not recognize", () => {
    expect(readAvailabilityFacts({ season_kind: "someday" })).toEqual({});
  });
});
