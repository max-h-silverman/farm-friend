import { describe, expect, it } from "vitest";
import {
  VASHON,
  dayLengthMinutes,
  sunTimes,
  type SunTimes,
} from "./daylight";

// F-043 — the sun, computed rather than invented.
//
// WHY THIS EXISTS AT ALL: most Vashon stands state `dawn_to_dusk` or `daylight_hours` rather
// than clock times, and migration 0005 refuses to store those as fixed hours because it
// "would invent a precision the farmer never stated". Dusk on Vashon moves roughly six hours
// across the year, so a hard-coded 6am–8pm would report stands open in the January dark and
// shut on a July evening. This computes the actual sun instead: pure arithmetic, no service,
// no key, no cost.
//
// HOW THESE EXPECTATIONS WERE OBTAINED: the reference values below are NOAA/US Naval
// Observatory published sunrise/sunset times for Vashon Island, transcribed as local Pacific
// clock times. They are an INDEPENDENT source, not this implementation's own output captured
// as a golden file — a self-generated fixture would pass against an algorithm that is wrong
// in exactly the same way, which is the failure mode this file has to rule out.
//
// TOLERANCE: the algorithm is the standard low-precision solar position model, accurate to
// about a minute at this latitude. Assertions allow ±3 minutes against published times, which
// is far tighter than the product needs (a customer deciding whether to drive somewhere does
// not care about 90 seconds) and far tighter than a broken implementation could survive —
// a sign error or a wrong obliquity misses by hours, not minutes.

/** Minutes past local midnight for a "HH:MM" local clock time. */
function at(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours! * 60 + minutes!;
}

/** Assert a computed minute-of-day is within tolerance of a published one. */
function expectNear(actual: number, expected: number, toleranceMinutes = 3): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(toleranceMinutes);
}

/**
 * Sun times for a local Pacific calendar date, as minutes past local midnight.
 *
 * Dates are constructed in UTC and the offset is passed explicitly, because the machine
 * running the tests is not necessarily on Pacific time — a `new Date("2026-06-21")` read
 * through a local getter would silently shift the answer by the runner's own offset. CI in
 * UTC and a laptop in Seattle must produce identical numbers.
 */
function pacific(isoDate: string, offsetHours: number): SunTimes {
  return sunTimes({
    date: new Date(`${isoDate}T12:00:00Z`),
    latitude: VASHON.latitude,
    longitude: VASHON.longitude,
    utcOffsetMinutes: offsetHours * 60,
  });
}

describe("sunTimes on Vashon", () => {
  // Published NOAA times for Vashon Island, Washington. PST (UTC-8) in winter, PDT (UTC-7)
  // in summer — the offset is an input rather than something this function guesses, so a
  // daylight-saving transition can never silently move every stand's closing time by an hour.
  const REFERENCE = [
    { date: "2026-01-15", offset: -8, sunrise: "07:53", sunset: "16:47", label: "deep winter" },
    { date: "2026-03-20", offset: -7, sunrise: "07:14", sunset: "19:23", label: "equinox" },
    { date: "2026-06-21", offset: -7, sunrise: "05:13", sunset: "21:11", label: "solstice" },
    { date: "2026-09-22", offset: -7, sunrise: "06:56", sunset: "19:07", label: "equinox" },
    { date: "2026-12-21", offset: -8, sunrise: "07:55", sunset: "16:20", label: "solstice" },
  ] as const;

  for (const { date, offset, sunrise, sunset, label } of REFERENCE) {
    it(`matches published sunrise and sunset on ${date} (${label})`, () => {
      const times = pacific(date, offset);

      expectNear(times.sunriseMinutes, at(sunrise));
      expectNear(times.sunsetMinutes, at(sunset));
    });
  }

  it("puts the solstices at the extremes of day length", () => {
    // A structural check the per-date assertions cannot make: whatever the absolute times,
    // the longest and shortest days of the year must be the solstices. An implementation with
    // an inverted declination passes nothing here.
    const june = dayLengthMinutes(pacific("2026-06-21", -7));
    const december = dayLengthMinutes(pacific("2026-12-21", -8));
    const march = dayLengthMinutes(pacific("2026-03-20", -7));

    expect(june).toBeGreaterThan(december);
    // ~16h versus ~8h20m at this latitude: the gap is enormous and is the whole reason a
    // fixed dawn/dusk schedule would be dishonest.
    expect(june - december).toBeGreaterThan(400);
    // An equinox is close to twelve hours everywhere on Earth.
    expectNear(march, 12 * 60, 15);
  });

  it("returns sunrise before sunset on every day of the year", () => {
    // Ordering is what the open-now predicate depends on. A single day where these invert
    // makes a stand report closed all day or open all night.
    for (let dayOfYear = 0; dayOfYear < 365; dayOfYear++) {
      const date = new Date(Date.UTC(2026, 0, 1 + dayOfYear, 12));
      const times = sunTimes({
        date,
        latitude: VASHON.latitude,
        longitude: VASHON.longitude,
        utcOffsetMinutes: -8 * 60,
      });

      expect(times.sunriseMinutes).toBeLessThan(times.sunsetMinutes);
      expect(Number.isFinite(times.sunriseMinutes)).toBe(true);
      expect(Number.isFinite(times.sunsetMinutes)).toBe(true);
    }
  });

  it("moves sunset later as the year turns toward midsummer", () => {
    // Monotonic through spring — catches an implementation that is right on the sampled dates
    // by luck but oscillates between them.
    const months = ["02-15", "03-15", "04-15", "05-15", "06-15"];
    const sunsets = months.map(
      (suffix) => pacific(`2026-${suffix}`, -8).sunsetMinutes,
    );

    for (let i = 1; i < sunsets.length; i++) {
      expect(sunsets[i]!).toBeGreaterThan(sunsets[i - 1]!);
    }
  });

  it("shifts with longitude — the sun does not rise at the same clock time everywhere", () => {
    // 15° of longitude is one hour of solar time. Passing a different longitude must move the
    // answer accordingly; an implementation that ignored longitude would return Vashon's
    // times for everywhere in the time zone.
    const vashon = pacific("2026-06-21", -7);
    const fifteenDegreesEast = sunTimes({
      date: new Date("2026-06-21T12:00:00Z"),
      latitude: VASHON.latitude,
      longitude: VASHON.longitude + 15,
      utcOffsetMinutes: -7 * 60,
    });

    // Further east, the sun rises earlier by roughly an hour of clock time.
    expectNear(fifteenDegreesEast.sunriseMinutes, vashon.sunriseMinutes - 60, 10);
  });

  it("respects the UTC offset it is given rather than the machine's own", () => {
    // The property that makes this safe to run anywhere. Same instant, offset one hour
    // further west: every local clock time must move back exactly 60 minutes.
    const pdt = pacific("2026-06-21", -7);
    const pst = pacific("2026-06-21", -8);

    // Not asserted as EXACTLY 60. Changing the offset also moves the instant of local noon
    // the declination is evaluated at, so the shift is 59.99 rather than a clean hour — real
    // behaviour of the model, not drift. Asserting `toBe(60)` fails on correct arithmetic,
    // which is a test defect rather than a discovery.
    expect(pdt.sunriseMinutes - pst.sunriseMinutes).toBeCloseTo(60, 1);
    expect(pdt.sunsetMinutes - pst.sunsetMinutes).toBeCloseTo(60, 1);
  });
});
