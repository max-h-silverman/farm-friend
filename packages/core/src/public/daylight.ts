// F-043 — sunrise and sunset as arithmetic.
//
// Most Vashon stands state `dawn_to_dusk` or `daylight_hours` rather than clock times.
// Migration 0005 refuses to store those as fixed hours because doing so "would invent a
// precision the farmer never stated", and it is right to: dusk on Vashon moves from about
// 4:20pm in December to about 9:11pm in June. A hard-coded schedule would report stands open
// in the January dark and shut on a July evening — the map lying in both directions.
//
// So the sun is COMPUTED. This is the standard low-precision solar position model (NOAA's
// published formulation), accurate to about a minute at this latitude, which is far finer
// than the question needs. Nothing here is a service call: no provider, no key, no cost, no
// network, no runtime seam. A date and a coordinate go in, two numbers come out.
//
// Everything in this file is PURE, and deliberately takes its UTC offset as an argument
// rather than reading the host's clock settings. A function that consulted the machine's own
// time zone would answer differently on a Seattle laptop and a UTC container, which is
// exactly the class of bug that makes an "open now" filter untrustworthy.

/**
 * Vashon Island's reference coordinate, for stands whose own position is unknown.
 *
 * The island is small enough that the sun is effectively the same across it — end to end,
 * sunrise differs by well under a minute — so a stand missing coordinates (F-038's
 * contact-only sellers) can honestly use the island's centre rather than being excluded from a
 * daylight judgement for want of a pin.
 */
export const VASHON = { latitude: 47.4471, longitude: -122.4594 } as const;

/** Sunrise and sunset as minutes past LOCAL midnight, in the offset that was supplied. */
export interface SunTimes {
  sunriseMinutes: number;
  sunsetMinutes: number;
}

export interface SunTimesInput {
  /** Any instant during the local calendar day in question. */
  date: Date;
  latitude: number;
  longitude: number;
  /**
   * Minutes to add to UTC for local clock time — `-480` for PST, `-420` for PDT.
   *
   * An explicit argument, never inferred here. Daylight saving is a political fact about a
   * place, not something to re-derive from a coordinate, and getting it wrong shifts every
   * stand's closing time by an hour.
   */
  utcOffsetMinutes: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/**
 * The sun's geometric zenith angle at apparent sunrise/sunset.
 *
 * 90.833°, not 90°: the extra 0.833° accounts for atmospheric refraction lifting the sun's
 * image above the true horizon plus the semi-diameter of the disc, since "sunset" means the
 * upper limb disappearing rather than the centre crossing. Using a flat 90° puts both events
 * several minutes off in the wrong direction.
 */
const SUNRISE_ZENITH_DEGREES = 90.833;

const MINUTES_PER_DAY = 1440;

/** Days since the J2000.0 epoch for a UTC instant. */
function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

/**
 * Sunrise and sunset for one local calendar day.
 *
 * Returns minutes past local midnight. At Vashon's latitude the sun rises and sets every day
 * of the year, so there is no polar edge case to model here — but the result is still checked
 * for finiteness by the caller's own guard rather than assumed, because a caller passing an
 * arctic latitude should get a refusal from the predicate, not `NaN` rendered as a time.
 */
export function sunTimes(input: SunTimesInput): SunTimes {
  const { date, latitude, longitude, utcOffsetMinutes } = input;

  // Work from local NOON, not local midnight. The solar declination changes through the day,
  // and evaluating it at the middle of the daylight period keeps sunrise and sunset
  // symmetric about the same solar day; anchoring at midnight biases both by up to a minute
  // and, near the solstices, can attribute them to adjacent days.
  const localNoonUtc = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      12,
      0,
      0,
    ).valueOf() -
      utcOffsetMinutes * 60_000,
  );

  const centuries = (julianDay(localNoonUtc) - 2_451_545) / 36_525;

  // Geometric mean longitude and anomaly of the sun, degrees.
  const meanLongitude =
    (280.46646 + centuries * (36_000.76983 + centuries * 0.0003032)) % 360;
  const meanAnomaly =
    357.52911 + centuries * (35_999.05029 - 0.0001537 * centuries);

  // Equation of the centre — the correction from the mean sun to the true sun, which is why
  // solar noon drifts against clock noon through the year.
  const centre =
    Math.sin(toRadians(meanAnomaly)) *
      (1.914602 - centuries * (0.004817 + 0.000014 * centuries)) +
    Math.sin(toRadians(2 * meanAnomaly)) * (0.019993 - 0.000101 * centuries) +
    Math.sin(toRadians(3 * meanAnomaly)) * 0.000289;

  const trueLongitude = meanLongitude + centre;
  const apparentLongitude =
    trueLongitude -
    0.00569 -
    0.00478 * Math.sin(toRadians(125.04 - 1934.136 * centuries));

  // Obliquity of the ecliptic — the axial tilt that creates seasons at all. A wrong sign here
  // inverts summer and winter, which the solstice test catches.
  const meanObliquity =
    23 +
    (26 +
      (21.448 -
        centuries *
          (46.815 + centuries * (0.00059 - centuries * 0.001813))) /
        60) /
      60;
  const obliquity =
    meanObliquity +
    0.00256 * Math.cos(toRadians(125.04 - 1934.136 * centuries));

  const declination = Math.asin(
    Math.sin(toRadians(obliquity)) * Math.sin(toRadians(apparentLongitude)),
  );

  // Equation of time, in minutes — the difference between apparent and mean solar time.
  const varY =
    Math.tan(toRadians(obliquity / 2)) * Math.tan(toRadians(obliquity / 2));
  const equationOfTime =
    4 *
    toDegrees(
      varY * Math.sin(2 * toRadians(meanLongitude)) -
        2 * 0.016708634 * Math.sin(toRadians(meanAnomaly)) +
        4 *
          0.016708634 *
          varY *
          Math.sin(toRadians(meanAnomaly)) *
          Math.cos(2 * toRadians(meanLongitude)) -
        0.5 * varY * varY * Math.sin(4 * toRadians(meanLongitude)) -
        1.25 *
          0.016708634 *
          0.016708634 *
          Math.sin(2 * toRadians(meanAnomaly)),
    );

  // The hour angle at which the sun sits at the sunrise zenith — half the length of the day,
  // expressed as an angle.
  const latitudeRadians = toRadians(latitude);
  const cosHourAngle =
    Math.cos(toRadians(SUNRISE_ZENITH_DEGREES)) /
      (Math.cos(latitudeRadians) * Math.cos(declination)) -
    Math.tan(latitudeRadians) * Math.tan(declination);

  // Above the arctic circle this leaves [-1, 1] and the sun neither rises nor sets. Vashon is
  // nowhere near that, but clamping keeps the result finite rather than NaN for a caller who
  // passes an arctic coordinate — the predicate above treats a degenerate day explicitly.
  const hourAngle = Math.acos(Math.min(1, Math.max(-1, cosHourAngle)));

  // Solar noon in local clock minutes, then sunrise/sunset symmetric about it.
  const solarNoon =
    720 - 4 * longitude - equationOfTime + utcOffsetMinutes;
  const halfDayMinutes = 4 * toDegrees(hourAngle);

  return {
    sunriseMinutes: solarNoon - halfDayMinutes,
    sunsetMinutes: solarNoon + halfDayMinutes,
  };
}

/** How long the sun is up, in minutes. */
export function dayLengthMinutes(times: SunTimes): number {
  return times.sunsetMinutes - times.sunriseMinutes;
}

/** True when the sun is up at `minutesPastMidnight` on the day these times describe. */
export function isDaylight(times: SunTimes, minutesPastMidnight: number): boolean {
  return (
    minutesPastMidnight >= times.sunriseMinutes &&
    minutesPastMidnight <= times.sunsetMinutes
  );
}

/** Minutes past local midnight, in the supplied offset, for an instant. */
export function localMinutesOfDay(date: Date, utcOffsetMinutes: number): number {
  const shifted = date.getTime() + utcOffsetMinutes * 60_000;
  const dayMinutes = Math.floor(shifted / 60_000) % MINUTES_PER_DAY;
  // JS `%` keeps the sign of the dividend, so a pre-epoch instant would go negative.
  return (dayMinutes + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}
