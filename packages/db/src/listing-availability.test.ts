import { describe, expect, it } from "vitest";
import { coherentAvailability, type ListingAvailability } from "./listing-availability";

// F-068 — the availability shape a farmer may state, asserted DIRECTLY.
//
// F-035 gave `sales_locations` structured season / hours / stocking columns and five CHECK
// constraints that arbitrate them. Until F-068 the only writer was the seeder, so the
// onboarding form wrote `hours_text` prose and left every filterable column NULL.
//
// This module is the in-memory mirror of those constraints. It exists so a farmer gets an
// answer naming the field they must fix rather than an opaque 500, and it is tested directly
// rather than only through stored rows because the two layers can silently disagree: the
// database applies its rule independently, so a row-shape assertion stays green while the
// in-memory check that produces the farmer's error message has stopped matching it.
//
// EVERY CASE HERE IS A CONSTRAINT IN 0005_structured_stand_availability.sql. If one is
// loosened here it must be loosened there, or the writer promises what the database refuses.

/** Nothing stated at all — every column NULL. A stand nobody asked, which is legal. */
const nothingStated: ListingAvailability = {
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

describe("coherentAvailability — season", () => {
  it("accepts nothing stated, which is not the same fact as year-round", () => {
    // `year_round` and NULL are deliberately distinct: "open all year" and "we don't know this
    // stand's season" are different facts a filter must tell apart (schema.ts:104).
    expect(coherentAvailability(nothingStated)).toBe(true);
  });

  it("accepts year_round carrying no dates and no names", () => {
    expect(
      coherentAvailability({ ...nothingStated, seasonKind: "year_round" }),
    ).toBe(true);
  });

  it("REFUSES year_round that also carries dates", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        seasonKind: "year_round",
        seasonStartMonth: 3,
        seasonStartDay: 1,
      }),
    ).toBe(false);
  });

  it("accepts date_range with all four endpoints", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        seasonKind: "date_range",
        seasonStartMonth: 3,
        seasonStartDay: 1,
        seasonEndMonth: 11,
        seasonEndDay: 30,
      }),
    ).toBe(true);
  });

  it("REFUSES date_range missing any endpoint", () => {
    const complete = {
      ...nothingStated,
      seasonKind: "date_range" as const,
      seasonStartMonth: 3,
      seasonStartDay: 1,
      seasonEndMonth: 11,
      seasonEndDay: 30,
    };
    // Each endpoint dropped on its own, so a single missing field cannot hide behind another.
    expect(coherentAvailability({ ...complete, seasonStartMonth: null })).toBe(false);
    expect(coherentAvailability({ ...complete, seasonStartDay: null })).toBe(false);
    expect(coherentAvailability({ ...complete, seasonEndMonth: null })).toBe(false);
    expect(coherentAvailability({ ...complete, seasonEndDay: null })).toBe(false);
  });

  it("REFUSES a month or day outside the calendar", () => {
    const base = {
      ...nothingStated,
      seasonKind: "date_range" as const,
      seasonStartMonth: 3,
      seasonStartDay: 1,
      seasonEndMonth: 11,
      seasonEndDay: 30,
    };
    expect(coherentAvailability({ ...base, seasonStartMonth: 0 })).toBe(false);
    expect(coherentAvailability({ ...base, seasonStartMonth: 13 })).toBe(false);
    expect(coherentAvailability({ ...base, seasonEndDay: 32 })).toBe(false);
    expect(coherentAvailability({ ...base, seasonEndDay: 0 })).toBe(false);
  });

  it("accepts a season that wraps the new year, which is a real Vashon season", () => {
    // November to February. No constraint orders the endpoints and none should — a wrapping
    // season is ordinary, and refusing it would force a farmer to lie about their season.
    expect(
      coherentAvailability({
        ...nothingStated,
        seasonKind: "date_range",
        seasonStartMonth: 11,
        seasonStartDay: 1,
        seasonEndMonth: 2,
        seasonEndDay: 28,
      }),
    ).toBe(true);
  });

  it("accepts named_season with at least one name", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        seasonKind: "named_season",
        seasonNames: ["summer"],
      }),
    ).toBe(true);
  });

  it("REFUSES named_season with an EMPTY name list", () => {
    // The constraint uses `coalesce(array_length(...), 0) > 0` because `array_length` of an
    // empty array is NULL, not 0, and a CHECK PASSES on NULL. The same trap applies here:
    // an empty list must be refused, not read as "some names".
    expect(
      coherentAvailability({
        ...nothingStated,
        seasonKind: "named_season",
        seasonNames: [],
      }),
    ).toBe(false);
  });

  it("REFUSES named_season with no name list at all", () => {
    expect(
      coherentAvailability({ ...nothingStated, seasonKind: "named_season" }),
    ).toBe(false);
  });

  it("accepts open_ended with a start and no end", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        seasonKind: "open_ended",
        seasonStartMonth: 6,
        seasonStartDay: 1,
      }),
    ).toBe(true);
  });

  it("REFUSES open_ended that carries an end date", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        seasonKind: "open_ended",
        seasonStartMonth: 6,
        seasonStartDay: 1,
        seasonEndMonth: 9,
        seasonEndDay: 1,
      }),
    ).toBe(false);
  });

  it("REFUSES season dates with no season kind to explain them", () => {
    expect(
      coherentAvailability({ ...nothingStated, seasonStartMonth: 3, seasonStartDay: 1 }),
    ).toBe(false);
    expect(coherentAvailability({ ...nothingStated, seasonNames: ["summer"] })).toBe(false);
  });
});

describe("coherentAvailability — open hours", () => {
  it("accepts each clockless kind, which is the honest shape for an unattended stand", () => {
    // `dawn_to_dusk` is a VALUE, not missing clock times: dusk on Vashon moves ~6 hours across
    // the season, so no fixed pair of hours is equivalent (0005 migration, schema.ts:85).
    for (const kind of ["dawn_to_dusk", "daylight_hours", "all_day", "by_appointment"] as const) {
      expect(coherentAvailability({ ...nothingStated, openHoursKind: kind })).toBe(true);
    }
  });

  it("REFUSES a clockless kind that also carries clock times", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        openHoursKind: "dawn_to_dusk",
        openFromMinutes: 480,
      }),
    ).toBe(false);
  });

  it("accepts clock_range with both ends", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        openHoursKind: "clock_range",
        openFromMinutes: 480,
        openUntilMinutes: 1080,
      }),
    ).toBe(true);
  });

  it("REFUSES clock_range missing either end", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        openHoursKind: "clock_range",
        openFromMinutes: 480,
      }),
    ).toBe(false);
    expect(
      coherentAvailability({
        ...nothingStated,
        openHoursKind: "clock_range",
        openUntilMinutes: 1080,
      }),
    ).toBe(false);
  });

  it("accepts midnight as a real opening time rather than reading 0 as absent", () => {
    // 0 is a legitimate minute-of-day. A truthiness check would treat it as missing and refuse
    // a stand open from midnight — the same class of defect as `Number(null)` being 0.
    expect(
      coherentAvailability({
        ...nothingStated,
        openHoursKind: "clock_range",
        openFromMinutes: 0,
        openUntilMinutes: 720,
      }),
    ).toBe(true);
  });

  it("accepts until_dusk with a start and no end, and refuses one with an end", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        openHoursKind: "until_dusk",
        openFromMinutes: 540,
      }),
    ).toBe(true);
    expect(
      coherentAvailability({
        ...nothingStated,
        openHoursKind: "until_dusk",
        openFromMinutes: 540,
        openUntilMinutes: 1200,
      }),
    ).toBe(false);
  });

  it("REFUSES until_dusk with no start", () => {
    expect(
      coherentAvailability({ ...nothingStated, openHoursKind: "until_dusk" }),
    ).toBe(false);
  });

  it("REFUSES a minute outside the day", () => {
    const base = {
      ...nothingStated,
      openHoursKind: "clock_range" as const,
      openFromMinutes: 480,
      openUntilMinutes: 1080,
    };
    expect(coherentAvailability({ ...base, openFromMinutes: -1 })).toBe(false);
    expect(coherentAvailability({ ...base, openUntilMinutes: 1440 })).toBe(false);
  });

  it("REFUSES clock times with no hours kind to explain them", () => {
    expect(
      coherentAvailability({ ...nothingStated, openFromMinutes: 480, openUntilMinutes: 1080 }),
    ).toBe(false);
  });
});

describe("coherentAvailability — open days", () => {
  it("accepts a weekday set, and a single day", () => {
    expect(coherentAvailability({ ...nothingStated, openDays: [0, 6] })).toBe(true);
    expect(coherentAvailability({ ...nothingStated, openDays: [3] })).toBe(true);
  });

  it("REFUSES an EMPTY day set, which asserts open on no day", () => {
    // NULL already says "not stated". An empty array would assert something no stand means,
    // and the constraint's `coalesce` exists because the first draft admitted exactly this.
    expect(coherentAvailability({ ...nothingStated, openDays: [] })).toBe(false);
  });

  it("REFUSES a day outside 0-6", () => {
    expect(coherentAvailability({ ...nothingStated, openDays: [7] })).toBe(false);
    expect(coherentAvailability({ ...nothingStated, openDays: [-1] })).toBe(false);
  });

  it("REFUSES a duplicated day WITHOUT relying on the length ceiling", () => {
    // Anchored to the dedupe itself. An earlier version of this test used
    // `[0,1,2,3,4,5,6,0]` — eight entries, so the SIZE ceiling refused it and the dedupe was
    // never exercised: deleting the dedupe left this test green. A sabotage caught that.
    // Two entries can never trip the ceiling, so only the dedupe can refuse this.
    expect(coherentAvailability({ ...nothingStated, openDays: [3, 3] })).toBe(false);
    expect(
      coherentAvailability({
        ...nothingStated,
        stockingCadence: "specific_days",
        stockingDays: [5, 5],
      }),
    ).toBe(false);
  });

  it("accepts all seven days", () => {
    expect(
      coherentAvailability({ ...nothingStated, openDays: [0, 1, 2, 3, 4, 5, 6] }),
    ).toBe(true);
  });
});

describe("coherentAvailability — stocking", () => {
  it("accepts every cadence that carries no day list", () => {
    for (const cadence of ["daily", "variable", "as_needed", "intermittent"] as const) {
      expect(
        coherentAvailability({ ...nothingStated, stockingCadence: cadence }),
      ).toBe(true);
    }
  });

  it("accepts specific_days WITH its days", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        stockingCadence: "specific_days",
        stockingDays: [2, 5],
      }),
    ).toBe(true);
  });

  it("REFUSES specific_days without the days it promises", () => {
    // The one incoherent cadence: it names a set the reader then cannot find.
    expect(
      coherentAvailability({ ...nothingStated, stockingCadence: "specific_days" }),
    ).toBe(false);
  });

  it("REFUSES stocking days on a cadence that is not specific_days", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        stockingCadence: "daily",
        stockingDays: [2, 5],
      }),
    ).toBe(false);
  });

  it("REFUSES stocking days with no cadence to explain them", () => {
    expect(coherentAvailability({ ...nothingStated, stockingDays: [2] })).toBe(false);
  });

  it("REFUSES an empty or out-of-range stocking day set", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        stockingCadence: "specific_days",
        stockingDays: [],
      }),
    ).toBe(false);
    expect(
      coherentAvailability({
        ...nothingStated,
        stockingCadence: "specific_days",
        stockingDays: [7],
      }),
    ).toBe(false);
  });
});

describe("coherentAvailability — the three groups are independent", () => {
  it("accepts a fully stated listing", () => {
    // What a real Vashon stand looks like: "Open March-November, 7 days, dawn to dusk,
    // restocked Wednesdays and Saturdays."
    expect(
      coherentAvailability({
        seasonKind: "date_range",
        seasonStartMonth: 3,
        seasonStartDay: 1,
        seasonEndMonth: 11,
        seasonEndDay: 30,
        seasonNames: null,
        openHoursKind: "dawn_to_dusk",
        openFromMinutes: null,
        openUntilMinutes: null,
        openDays: [0, 1, 2, 3, 4, 5, 6],
        stockingCadence: "specific_days",
        stockingDays: [3, 6],
      }),
    ).toBe(true);
  });

  it("lets a farmer state hours without a season, and a season without hours", () => {
    // Partial answers are the common case — the form must not demand all three groups to
    // accept any one of them.
    expect(
      coherentAvailability({ ...nothingStated, openHoursKind: "dawn_to_dusk" }),
    ).toBe(true);
    expect(
      coherentAvailability({ ...nothingStated, seasonKind: "year_round" }),
    ).toBe(true);
  });

  it("REFUSES the whole listing when any one group is incoherent", () => {
    expect(
      coherentAvailability({
        ...nothingStated,
        seasonKind: "year_round",
        openHoursKind: "clock_range",
        openFromMinutes: 480,
        // The missing end makes the hours group incoherent even though the season is fine.
      }),
    ).toBe(false);
  });
});
