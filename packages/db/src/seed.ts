import { matchStandName } from "@farm-friend/core";
import type { Sql, Tx } from "./sql";

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
  /**
   * Address and coordinates are present together or absent together — the shape
   * `sales_locations_coherent_visitability` enforces (F-038).
   *
   * A `contact_only` farm has none of the three: Open Gate Lamb delivers only, and the legacy
   * map export's coordinates for it must not be seeded. Optional here rather than three
   * separate optionals so the type mirrors the constraint.
   */
  place?: { address: string; longitude: number; latitude: number };
  visitability: "visitable" | "contact_only";
  offeringType: "produce" | "services" | "by_order";
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

/** What one approved entry resolves to, for a dry run to report before anything is written. */
export interface OfferingPlanEntry {
  /** The name as the approved artifact states it. */
  standName: string;
  /** The name the database holds, which may differ — that is the whole point of the key. */
  locationName: string;
  /** Tags a real run would insert. */
  newItems: string[];
  /** Tags already present, which a real run leaves alone. */
  existingItems: string[];
}

export interface OfferingPlan {
  matched: OfferingPlanEntry[];
  /** Approved-file names with no matching sales location. */
  unknownStands: string[];
}

/**
 * One row of the name index: which sales location an approved stand name refers to.
 *
 * The name is carried alongside the id because it is what a dry run must show — an artifact
 * saying "Provo Farm" resolving to the stored "Provo Farms" is exactly the fact a reviewer needs
 * to see before a real run.
 */
interface LocationMatch {
  id: string;
  name: string;
}

/**
 * Index every seeded sales location by the SEED JOIN's match key.
 *
 * WHY NOT AN EXACT NAME. The approved artifact records the name from VIGA's MAP export, while the
 * seed join stores the name from the FORM export, and the two disagree for five of the corpus's
 * 31 stands — "Aeggy's"/"Aeggy's Farm", "Provo Farm"/"Provo Farms", "Olive Farm Stand"/"Olive
 * Farm", "Flora Hill Farm"/"Flora Hill", and "Fruits Des Vignes Farm"/"Fruits des Vignes Farm",
 * which differs by capitalization alone. An exact lookup reported all five as unknown stands and
 * gave them no tags: a silent 26-of-31 that reads as success.
 *
 * `matchStandName` is the normalization the join itself matches on, reused rather than
 * reimplemented — one general mechanism with two consumers, so a future naming difference is
 * handled in one place instead of drifting between them.
 *
 * AMBIGUITY THROWS. Two locations reducing to one key make the choice arbitrary and
 * order-dependent, and either answer files one farm's tags under another farm's listing while
 * every count still looks right. The corpus is what settled this: a similarity-scored matcher
 * ranked Lavender Hill Farm against Flora Hill Farm, and the exact key exists because a wrongly
 * joined pair is silently wrong where a missed one is a reported refusal a human resolves.
 */
async function indexLocationsByMatchKey(sql: Sql | Tx): Promise<Map<string, LocationMatch>> {
  const rows = await sql<{ id: string; name: string }[]>`
    select id, name from sales_locations
  `;

  const byKey = new Map<string, LocationMatch>();
  const collisions = new Map<string, string[]>();
  for (const row of rows) {
    const key = matchStandName(row.name);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      collisions.set(key, [...(collisions.get(key) ?? [existing.name]), row.name]);
      continue;
    }
    byKey.set(key, { id: row.id, name: row.name });
  }

  if (collisions.size > 0) {
    const detail = [...collisions.values()]
      .map((names) => names.map((name) => JSON.stringify(name)).join(" and "))
      .join("; ");
    throw new Error(
      `ambiguous stand names in the database: ${detail} reduce to one match key, ` +
        `so an approved tag list cannot be attributed to one of them`,
    );
  }

  return byKey;
}

/**
 * Resolve one approved stand name against the index, or report it unknown.
 *
 * A name whose key is entirely generic words throws from `matchStandName` rather than becoming an
 * empty key, which would otherwise match every other empty key — one silent equivalence class
 * absorbing unrelated farms.
 */
function resolveStand(
  byKey: Map<string, LocationMatch>,
  standName: string,
): LocationMatch | undefined {
  return byKey.get(matchStandName(standName));
}

/**
 * Report what committing an approved file WOULD do, writing nothing (F-041).
 *
 * The dry run has to resolve names against the real database, because the facts a reviewer needs
 * are exactly the ones only the database knows: which artifact name maps to which stored name,
 * which stands are unknown, and which tags are already present. A dry run that only echoes the
 * file back cannot show any of them — and the five renamed stands were invisible for that reason.
 */
export async function planOfferings(
  sql: Sql,
  offerings: SeedOfferingInput[],
): Promise<OfferingPlan> {
  const byKey = await indexLocationsByMatchKey(sql);
  const matched: OfferingPlanEntry[] = [];
  const unknownStands: string[] = [];

  for (const offering of offerings) {
    const location = resolveStand(byKey, offering.standName);
    if (location === undefined) {
      unknownStands.push(offering.standName);
      continue;
    }

    const present = await sql<{ item: string }[]>`
      select item from sales_location_offerings where sales_location_id = ${location.id}
    `;
    const existing = new Set(present.map((row) => row.item));

    matched.push({
      standName: offering.standName,
      locationName: location.name,
      newItems: offering.items.filter((item) => !existing.has(item)),
      existingItems: offering.items.filter((item) => existing.has(item)),
    });
  }

  return { matched, unknownStands };
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
 *
 * Stand names are matched through the seed join's own key, never an exact string; see
 * `indexLocationsByMatchKey` for why, and for why an ambiguous name aborts the batch.
 */
export async function seedOfferings(
  sql: Sql,
  offerings: SeedOfferingInput[],
): Promise<SeedOfferingsResult> {
  let inserted = 0;
  let skipped = 0;
  const unknownStands: string[] = [];

  await sql.begin(async (tx) => {
    // Built inside the transaction so the index cannot go stale mid-batch, and so an ambiguity
    // aborts before any tag lands rather than after some of them have.
    const byKey = await indexLocationsByMatchKey(tx);

    for (const offering of offerings) {
      const location = resolveStand(byKey, offering.standName);
      if (location === undefined) {
        unknownStands.push(offering.standName);
        continue;
      }

      for (const [index, item] of offering.items.entries()) {
        const result = await tx`
          insert into sales_location_offerings (sales_location_id, item, sort_order)
          values (${location.id}, ${item}, ${index})
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
          owner_farm_id, kind, name, timezone, public_address, public_latitude, public_longitude,
          visitability, offering_type,
          hours_text, is_public, farm_bucks_accepted, farm_bucks_eligible,
          season_kind, season_start_month, season_start_day, season_end_month,
          season_end_day, season_names,
          open_hours_kind, open_from_minutes, open_until_minutes,
          stocking_cadence, stocking_days
        ) values (
          ${farmId}, ${stand.kind}, ${stand.name}, 'America/Los_Angeles', ${stand.place?.address ?? null},
          ${stand.place?.latitude ?? null}, ${stand.place?.longitude ?? null},
          ${stand.visitability}, ${stand.offeringType},
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
