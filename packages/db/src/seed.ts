import type postgres from "postgres";

// B-002 — loading VIGA's reference stand data.
//
// WHAT THIS DELIBERATELY CANNOT DO: publish inventory. `inventory_revisions` requires a
// `published_by_authorization_id` and a `farm_approval_id`, and the seeder creates neither, so
// it is STRUCTURALLY incapable of fabricating a farmer's confirmation. That is the point.
// VIGA's export carries dated stock notes ("7/9/2026 Update: Closed"), and seeding those as
// current availability would put words in a farmer's mouth on a map whose entire premise is
// honesty about when someone last confirmed. Specialties — what a stand USUALLY carries — are
// a different fact and live in `sales_location_offerings`.
//
// IDEMPOTENT BY NATURAL KEY. Re-running is routine (a corrected row, a new stand), so the
// loader keys on the stand's name and skips what already exists rather than duplicating it.
// It deliberately does NOT update existing rows: once Farm Friend is live a farmer may have
// corrected their own listing, and a re-run must never silently revert that to the CSV.
//
// REFUSES RATHER THAN COERCES. Every write goes through the real constraints inside one
// transaction. An out-of-range coordinate aborts the batch; nothing is clamped, defaulted, or
// rounded into validity. A partially seeded corpus is recoverable; a stand at a plausible
// wrong address sends a customer to a stranger's driveway.

type Sql = ReturnType<typeof postgres>;

export type SeededSeason =
  | { kind: "year_round" }
  | { kind: "date_range"; startMonth: number; startDay: number; endMonth: number; endDay: number }
  | { kind: "named_season"; names: string[] }
  | { kind: "open_ended"; startMonth: number; startDay: number }
  | { kind: "not_stated" };

export type SeededOpenHours =
  | { kind: "dawn_to_dusk" | "daylight_hours" | "all_day" | "by_appointment" }
  | { kind: "clock_range"; fromMinutes: number; untilMinutes: number }
  | { kind: "until_dusk"; fromMinutes: number }
  | { kind: "not_stated" };

export interface SeededStocking {
  cadence: "daily" | "specific_days" | "variable" | "as_needed" | "intermittent" | "not_stated";
  days?: number[];
}

export interface SeedStandFlag {
  reason:
    | "contradictory_hours"
    | "season_unresolved"
    | "unparsed_availability"
    | "possibly_closed";
  sourceText: string;
}

export interface SeedStandInput {
  name: string;
  address: string;
  longitude: number;
  latitude: number;
  kind: "farm_stand" | "farmers_market";
  /** The farmer's own words, kept for display and never filtered on. */
  hoursText?: string;
  season: SeededSeason;
  openHours: SeededOpenHours;
  stocking: SeededStocking;
  flags: SeedStandFlag[];
  farmBucksAccepted?: boolean;
  farmBucksEligible?: boolean;
}

export interface SeedResult {
  seeded: number;
  skipped: number;
  flagsRaised: number;
}

/** Season columns, or nulls. Shaped to satisfy `sales_locations_coherent_season`. */
function seasonColumns(season: SeededSeason) {
  switch (season.kind) {
    case "year_round":
      return { kind: "year_round", startMonth: null, startDay: null, endMonth: null, endDay: null, names: null };
    case "date_range":
      return {
        kind: "date_range",
        startMonth: season.startMonth,
        startDay: season.startDay,
        endMonth: season.endMonth,
        endDay: season.endDay,
        names: null,
      };
    case "named_season":
      return { kind: "named_season", startMonth: null, startDay: null, endMonth: null, endDay: null, names: season.names };
    case "open_ended":
      return {
        kind: "open_ended",
        startMonth: season.startMonth,
        startDay: season.startDay,
        endMonth: null,
        endDay: null,
        names: null,
      };
    // `not_stated` is a FACT, not a defect: VIGA never recorded a season. It is stored as
    // NULL columns, which the coherence constraint's first branch permits.
    case "not_stated":
      return { kind: null, startMonth: null, startDay: null, endMonth: null, endDay: null, names: null };
  }
}

/** Open-hours columns, shaped to satisfy `sales_locations_coherent_open_hours`. */
function openHoursColumns(hours: SeededOpenHours) {
  switch (hours.kind) {
    case "clock_range":
      return { kind: "clock_range", from: hours.fromMinutes, until: hours.untilMinutes };
    case "until_dusk":
      return { kind: "until_dusk", from: hours.fromMinutes, until: null };
    case "not_stated":
      return { kind: null, from: null, until: null };
    default:
      return { kind: hours.kind, from: null, until: null };
  }
}

export interface SeedOfferingInput {
  /** The stand's name — the same natural key the stand seeder uses. */
  standName: string;
  /** Human-approved tags, in review order. */
  items: string[];
}

export interface SeedOfferingsResult {
  inserted: number;
  /** Tags that already existed and were left alone. */
  skipped: number;
  /** Approved-file names with no matching sales location. Reported, never invented. */
  unknownStands: string[];
}

/**
 * Commit HUMAN-APPROVED offering tags (F-024/F-036).
 *
 * The model only ever PROPOSED these; this is the "code commits what was approved" half of
 * the offering seam's contract. It writes `sales_location_offerings` — specialties, what a
 * stand usually carries — and is structurally incapable of touching inventory, which needs
 * an authorization and approval this path does not have.
 *
 * Idempotent on the (location, item) key, and it never rewrites an existing tag: once live,
 * a farmer or operator may have edited their tags, and a re-run must not revert that. An
 * unknown stand name is reported rather than silently dropped — the address-refused stands
 * legitimately exist in the CSV but not the database.
 */
export async function seedOfferings(
  sql: Sql,
  offerings: SeedOfferingInput[],
): Promise<SeedOfferingsResult> {
  let inserted = 0;
  let skipped = 0;
  const unknownStands: string[] = [];

  await sql.begin(async (tx) => {
    for (const offering of offerings) {
      const location = await tx`
        select id from sales_locations where name = ${offering.standName} limit 1
      `;
      if (location.length === 0) {
        unknownStands.push(offering.standName);
        continue;
      }
      const locationId = location[0]!.id as string;

      for (const [index, item] of offering.items.entries()) {
        const result = await tx`
          insert into sales_location_offerings (sales_location_id, item, sort_order)
          values (${locationId}, ${item}, ${index})
          on conflict do nothing
          returning item
        `;
        if (result.length > 0) inserted++;
        else skipped++;
      }
    }
  });

  return { inserted, skipped, unknownStands };
}

/**
 * Seed stands into the database.
 *
 * One transaction for the whole batch: a partially applied corpus with no record of where it
 * stopped is the state hardest to recover from.
 */
export async function seedStands(sql: Sql, stands: SeedStandInput[]): Promise<SeedResult> {
  let seeded = 0;
  let skipped = 0;
  let flagsRaised = 0;

  await sql.begin(async (tx) => {
    for (const stand of stands) {
      // Idempotency by natural key. Existing rows are left ALONE rather than updated: a
      // farmer may have corrected their listing since the export, and a re-run must not
      // revert their change to VIGA's older text.
      const existing = await tx`
        select id from sales_locations where name = ${stand.name} limit 1
      `;
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const farmRows = await tx`
        insert into farms (name) values (${stand.name}) returning id
      `;
      const farmId = farmRows[0]!.id as string;

      const season = seasonColumns(stand.season);
      const hours = openHoursColumns(stand.openHours);
      const stocking = stand.stocking;

      const locationRows = await tx`
        insert into sales_locations (
          farm_id, kind, name, public_address, public_latitude, public_longitude,
          hours_text, is_public, farm_bucks_accepted, farm_bucks_eligible,
          season_kind, season_start_month, season_start_day, season_end_month,
          season_end_day, season_names,
          open_hours_kind, open_from_minutes, open_until_minutes,
          stocking_cadence, stocking_days
        ) values (
          ${farmId}, ${stand.kind}, ${stand.name}, ${stand.address},
          ${stand.latitude}, ${stand.longitude},
          ${stand.hoursText ?? null}, true,
          ${stand.farmBucksAccepted ?? false}, ${stand.farmBucksEligible ?? false},
          ${season.kind}, ${season.startMonth}, ${season.startDay},
          ${season.endMonth}, ${season.endDay},
          ${season.names as unknown as string[] | null},
          ${hours.kind}, ${hours.from}, ${hours.until},
          ${stocking.cadence === "not_stated" ? null : stocking.cadence},
          ${stocking.days ?? null}
        ) returning id
      `;
      const locationId = locationRows[0]!.id as string;

      for (const flag of stand.flags) {
        // `on conflict do nothing` against the partial unique index on
        // (sales_location_id, reason) where resolved_at is null: re-running must not pile
        // up duplicate copies of the same unresolved question for an operator.
        const inserted = await tx`
          insert into stand_data_flags (sales_location_id, reason, source_text)
          values (${locationId}, ${flag.reason}, ${flag.sourceText})
          on conflict do nothing
          returning id
        `;
        if (inserted.length > 0) flagsRaised++;
      }

      seeded++;
    }
  });

  return { seeded, skipped, flagsRaised };
}
