import type {
  StandAvailabilityFacts,
  StandHoursFacts,
  StandSeasonFacts,
} from "./open-now";

// F-035's availability columns, read into facts — ONE statement of the rule (F-114 C.5).
//
// `stand_providers` mirrors every availability column `sales_locations` carries, because a
// hosted seller keeps their own hours and season and those are clamped to the stand's at read
// time. That makes the same six columns readable off two different tables, and the rule they
// are read by is identical. It lived privately inside the public map's reader until C.5 needed
// it for the provider row too; a second copy would be a second place a `year_round` could be
// invented for a farmer who never stated one.

/**
 * Read F-035's availability columns off a raw row.
 *
 * THE RULE: every field is spread conditionally and **NOTHING is defaulted**. A row that stated
 * no season must not acquire `year_round`; a `dawn_to_dusk` row must not acquire clock times.
 * The first would be a claim no farmer made and the second is precisely the invented precision
 * migration 0005 refuses.
 *
 * The database's CHECK constraints already guarantee a kind and its operands agree, so this
 * reads the kind and takes only the operands that kind defines. An unrecognized kind yields
 * nothing rather than a partial fact — a half-read schedule is worse than an unread one.
 *
 * Takes a bare row rather than a typed object because both callers hand it raw query output,
 * and a mapping layer in between would be a third place the column names are written down.
 */
export function readAvailabilityFacts(
  row: Record<string, unknown>,
): StandAvailabilityFacts {
  const seasonKind = row.season_kind as string | null | undefined;
  const hoursKind = row.open_hours_kind as string | null | undefined;
  const days = row.open_days as number[] | null | undefined;

  let season: StandSeasonFacts | undefined;
  switch (seasonKind) {
    case "year_round":
      season = { kind: "year_round" };
      break;
    case "date_range":
      season = {
        kind: "date_range",
        startMonth: Number(row.season_start_month),
        startDay: Number(row.season_start_day),
        endMonth: Number(row.season_end_month),
        endDay: Number(row.season_end_day),
      };
      break;
    case "named_season":
      // The NAMES, not months. Resolution happens against one documented constant at the moment
      // the question is asked, so VIGA correcting what "summer" means changes that constant
      // rather than requiring a re-seed.
      season = {
        kind: "named_season",
        names: (row.season_names as string[] | null) ?? [],
      };
      break;
    case "open_ended":
      season = {
        kind: "open_ended",
        startMonth: Number(row.season_start_month),
        startDay: Number(row.season_start_day),
      };
      break;
    default:
      season = undefined;
  }

  let hours: StandHoursFacts | undefined;
  switch (hoursKind) {
    case "dawn_to_dusk":
    case "daylight_hours":
    case "all_day":
    case "by_appointment":
      // No clock times, by CHECK constraint and by product rule. The sun is computed at read
      // time; a stored 6am–8pm would be a schedule the farmer never gave.
      hours = { kind: hoursKind };
      break;
    case "clock_range":
      hours = {
        kind: "clock_range",
        fromMinutes: Number(row.open_from_minutes),
        untilMinutes: Number(row.open_until_minutes),
      };
      break;
    case "until_dusk":
      hours = { kind: "until_dusk", fromMinutes: Number(row.open_from_minutes) };
      break;
    default:
      hours = undefined;
  }

  return {
    ...(season ? { season } : {}),
    ...(hours ? { hours } : {}),
    // Empty is treated as unstated rather than as "open on no day". The CHECK constraint
    // already forbids an empty array; this is belt-and-braces against a future writer.
    ...(days && days.length > 0 ? { days } : {}),
  };
}
