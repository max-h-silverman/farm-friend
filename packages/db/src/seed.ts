import { matchStandName, resolveStandKey } from "@farm-friend/core";
import { readNativeProviderId } from "./current-inventory";
import type { Sql, Tx } from "./sql";

// B-002 — loading VIGA's reference stand data.
//
// WHAT `seedStands` DELIBERATELY DOES NOT DO: publish inventory. A stand it creates renders the
// honest "no current listing" until something confirms it. Specialties — what a stand USUALLY
// carries — are a different fact and live in `stand_items.usually_carried`.
//
// Inventory has its own writer, `seedWeeklyConfirmations` (F-062), and it is not a loophole: it
// writes ONLY from a farmer's own dated weekly-form submission, stamps `source = 'viga'`, and
// carries none of the three keys asserting a handset sent it (F-063). A database CHECK enforces
// that split, so neither writer can fabricate a farmer's SMS confirmation — which is what the
// original "structurally incapable" comment here was protecting, by a mechanism that has since
// been made explicit rather than incidental.
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
    | "possibly_closed"
    | "address_unresolved";
  sourceText: string;
}

export interface SeedStandInput {
  name: string;
  /** Sanitized public source description; direct contact details must be removed before seeding. */
  description?: string;
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
  /**
   * Which weekdays the stand states it is open, 0 = Sunday (B-039).
   *
   * Separate from `openHours`, which carries the TIME of day. VIGA's form asks both as one
   * question and farmers answer both — "10-6, Wednesday & Saturday" is a clock range and a day
   * set — so a stand may state either, both, or neither. Absent means the farm said nothing
   * about days, never that it is closed.
   */
  openDays?: number[];
  stocking: SeededStocking;
  flags: SeedStandFlag[];
  /** F-125 — the SELLER's answer. Written to her farm row, not to this stand. */
  farmBucksAccepted?: boolean;
  /**
   * The farm's website and social links (F-061), already normalized to absolute URLs.
   *
   * `seller_links_absolute_http_url` refuses anything else, and a refusal aborts the whole seed
   * transaction rather than skipping one row — so `parseFarmLinks` does the normalizing and
   * this type carries only what Postgres will accept.
   */
  links?: { label: string; url: string }[];
  /**
   * Payment methods the stand states, canonically spelled (F-061).
   *
   * VIGA Bucks is deliberately NOT among these: `farmBucksAccepted` owns that fact, and
   * recording it twice would let the two disagree.
   */
  paymentMethods?: string[];

  /**
   * Other sellers the stand states it hosts, as display strings (F-064).
   *
   * Written with `source = 'viga'` and no confirming authorization: VIGA's map and weekly form
   * are not a farmer's confirmation, and a database CHECK enforces that split. A farmer takes
   * ownership by editing the list through their own settings page, which writes `'sms'`.
   *
   * Display text only. Deliberately NOT matched against seeded sellers — F-050 has no confirmed
   * linking flow, so resolving a name to an account would fabricate a relationship.
   */
  participants?: string[];
}

export interface SeedResult {
  seeded: number;
  skipped: number;
  flagsRaised: number;
  /**
   * Existing stands that gained a link, payment method or host they were missing (GL-015).
   *
   * Counted separately from `seeded` because nothing was created: the stand was already there
   * and only its empty side tables were filled.
   */
  backfilled: number;
  /** Existing stands left untouched because their farmer holds a live authorization. */
  backfillRefused: number;
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
  /** Existing listings left untouched because their farmer owns the published state. */
  refusedStands: string[];
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
  /** Existing listings a real run would leave untouched because their farmer owns them. */
  refusedStands: string[];
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
  farmerOwned: boolean;
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
  const rows = await sql<{ id: string; name: string; farmer_owned: boolean }[]>`
    select location.id, location.name, exists (
      select 1
      from farmer_authorizations auth
      where auth.seller_id = location.own_seller_id
        and auth.revoked_at is null
    ) as farmer_owned
    from sales_locations location
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
    byKey.set(key, { id: row.id, name: row.name, farmerOwned: row.farmer_owned });
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
 * absorbing unrelated sellers.
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
  const refusedStands: string[] = [];

  for (const offering of offerings) {
    const location = resolveStand(byKey, offering.standName);
    if (location === undefined) {
      unknownStands.push(offering.standName);
      continue;
    }
    if (location.farmerOwned) {
      refusedStands.push(offering.standName);
      continue;
    }

    // F-066 — "already a standing claim here" is asked in the SAME normalized terms the unique
    // index uses. An exact-string comparison would report "Eggs" as new against a stored
    // "eggs", so the dry run would promise a write the commit then skips.
    const present = await sql<{ key: string }[]>`
      select lower(btrim(display_name, E' \t\r\n')) as key
      from stand_items
      where sales_location_id = ${location.id} and usually_carried
    `;
    const existing = new Set(present.map((row) => row.key));
    const key = (item: string) => item.trim().toLowerCase();

    matched.push({
      standName: offering.standName,
      locationName: location.name,
      newItems: offering.items.filter((item) => !existing.has(key(item))),
      existingItems: offering.items.filter((item) => existing.has(key(item))),
    });
  }

  return { matched, unknownStands, refusedStands };
}

/**
 * Commit HUMAN-APPROVED offering tags (F-024/F-036).
 *
 * The model only ever PROPOSED these; this is the "code commits what was approved" half of
 * the offering seam's contract. It writes `stand_items.usually_carried` — specialties, what a
 * stand usually carries — and is structurally incapable of touching inventory, which needs
 * an authorization and approval this path does not have.
 *
 * Idempotent on the normalized (location, display name) key, and it never rewrites an existing
 * tag. A farm with a live authorization is refused entirely: once live, its farmer owns the
 * listing and a re-run must not add back an item they removed. An unknown stand name is reported
 * rather than silently dropped.
 *
 * Stand names are matched through the seed join's own key, never an exact string; see
 * `indexLocationsByMatchKey` for why, and for why an ambiguous name aborts the batch.
 */
export async function seedOfferings(
  sql: Sql,
  offerings: SeedOfferingInput[],
): Promise<SeedOfferingsResult> {
  return sql.begin((tx) => seedOfferingsInTransaction(tx, offerings));
}

async function seedOfferingsInTransaction(
  tx: Tx,
  offerings: SeedOfferingInput[],
): Promise<SeedOfferingsResult> {
  let inserted = 0;
  let skipped = 0;
  const unknownStands: string[] = [];
  const refusedStands: string[] = [];

  // Built inside the transaction so the index cannot go stale mid-batch, and so an ambiguity
  // aborts before any tag lands rather than after some of them have.
  const byKey = await indexLocationsByMatchKey(tx);

  for (const offering of offerings) {
    const location = resolveStand(byKey, offering.standName);
    if (location === undefined) {
      unknownStands.push(offering.standName);
      continue;
    }
    if (location.farmerOwned) {
      refusedStands.push(offering.standName);
      continue;
    }

    // F-114 Phase B — seeded usual items are the stand's own, so the native slot.
    const seedItemProviderId = await readNativeProviderId(tx, {
      salesLocationId: location.id,
    });
    for (const [index, item] of offering.items.entries()) {
      // F-066 — the unique index is the arbiter, not a prior read: two writers naming the
      // same new item share no parent row to lock, and a row that does not exist yet cannot
      // be locked at all. An empty `returning` means the item is already there.
      //
      // The conflict case RAISES the standing state and nothing else. An item can already
      // exist without being a standing claim — the backfill creates one for every name a
      // past revision confirmed — and a plain `do nothing` would leave that item
      // `usually_carried = false` forever, silently dropping approved tags. So the update
      // sets the flag, and is guarded by `where not usually_carried` so a row that is
      // already a standing claim is genuinely untouched rather than rewritten to the same
      // value. Display name and sort order are left alone: a re-run must never revert an
      // edit a farmer or operator made, which is the rule this seeder has always held.
      const result = await tx`
        insert into stand_items (
          sales_location_id, provider_id, display_name, usually_carried, sort_order
        )
        values (${location.id}, ${seedItemProviderId}, ${item}, true, ${index})
        on conflict (provider_id, (lower(btrim(display_name, E' \t\r\n'))))
        do update set usually_carried = true
        where not stand_items.usually_carried
        returning id
      `;
      if (result.length > 0) inserted++;
      else skipped++;
    }
  }

  return { inserted, skipped, unknownStands, refusedStands };
}

/**
 * Seed stands into the database.
 *
 * One transaction for the whole batch: a partially applied corpus with no record of where it
 * stopped is the state hardest to recover from.
 */
export async function seedStands(sql: Sql, stands: SeedStandInput[]): Promise<SeedResult> {
  return sql.begin((tx) => seedStandsInTransaction(tx, stands));
}

async function seedStandsInTransaction(
  tx: Tx,
  stands: SeedStandInput[],
): Promise<SeedResult> {
  let seeded = 0;
  let skipped = 0;
  let flagsRaised = 0;
  let backfilled = 0;
  let backfillRefused = 0;

  for (const stand of stands) {
    // Idempotency by natural key. The stand's OWN listing fields are left alone rather than
    // updated: a farmer may have corrected their listing since the export, and a re-run must
    // not revert their change to VIGA's older text.
    const existing = await tx`
      select l.id, l.own_seller_id from sales_locations l
      where l.name = ${stand.name} limit 1
    `;
    if (existing.length > 0) {
      skipped++;

      // GL-015 — but its EMPTY side tables are still fillable.
      //
      // Insert-only meant "create the stand or do nothing", and running F-064's ingest against
      // production proved how sharp that edge is: all 35 stands already existed, so the batch
      // wrote nothing and links, hosts and most payment methods stayed empty with no way to
      // supply them. The rehearsal missed it by running from an empty schema, where every
      // stand is an insert.
      //
      // These three tables are ADDITIVE and carry no farmer-authored state of their own: every
      // write below is `on conflict do nothing`, so this fills gaps and never overwrites,
      // reorders, or removes. The listing itself — address, season, hours, stocking,
      // description — is still never touched here.
      const locationId = existing[0]?.id as string;
      const ownerSellerId = existing[0]?.own_seller_id as string;

      // Once a farmer holds a live authorization they own the listing (golden rule #1), and
      // VIGA's older spreadsheet must not add to it behind their back — a payment method or a
      // host they deliberately removed would silently come back on the next run.
      const authorized = await tx`
        select 1 from farmer_authorizations
        where seller_id = ${ownerSellerId} and revoked_at is null
        limit 1
      `;
      if (authorized.length > 0) {
        backfillRefused++;
        continue;
      }

      const added = await writeSideFacts(tx, stand, ownerSellerId, locationId);
      if (added) backfilled++;
      continue;
    }

    const farmRows = await tx`
      insert into sellers (name, description) values (${stand.name}, ${stand.description ?? null}) returning id
    `;
    const farmId = farmRows[0]!.id as string;

    const season = seasonColumns(stand.season);
    const hours = openHoursColumns(stand.openHours);
    const stocking = stand.stocking;

    const locationRows = await tx`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, public_address, public_latitude, public_longitude,
        visitability, offering_type,
        hours_text, is_public,
        season_kind, season_start_month, season_start_day, season_end_month,
        season_end_day, season_names,
        open_hours_kind, open_from_minutes, open_until_minutes, open_days,
        stocking_cadence, stocking_days
      ) values (
        ${farmId}, ${stand.kind}, ${stand.name}, 'America/Los_Angeles', ${stand.place?.address ?? null},
        ${stand.place?.latitude ?? null}, ${stand.place?.longitude ?? null},
        ${stand.visitability}, ${stand.offeringType},
        ${stand.hoursText ?? null}, true,
        ${season.kind}, ${season.startMonth}, ${season.startDay},
        ${season.endMonth}, ${season.endDay},
        ${season.names as unknown as string[] | null},
        ${hours.kind}, ${hours.from}, ${hours.until},
        ${(stand.openDays ?? null) as unknown as number[] | null},
        ${stocking.cadence === "not_stated" ? null : stocking.cadence},
        ${stocking.days ?? null}
      ) returning id
    `;
    const locationId = locationRows[0]!.id as string;

    // The stand's own seller becomes an ordinary provider at it (F-114 Phase C.0). Phase B did
    // this with a trigger on `sales_locations`, which C.0 removed: a stand may legitimately have
    // NO seller of its own — a venue like Morgan Hill Community Stand — and a trigger would have
    // to invent one to satisfy itself. So every writer that creates a stand with an own-seller
    // creates its provider too, and this is one of the two that do.
    //
    // `viga` approval with the stand's own timestamps, because a seller selling at its own stand
    // was not invited by anybody: the lifecycle CHECK requires an invitation and an approval for
    // every row, and VIGA creating the stand IS the approval.
    await tx`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      )
      select ${locationId}, ${farmId}, 'active', now(), now(), 'viga', now()
      on conflict do nothing
    `;

    await writeSideFacts(tx, stand, farmId, locationId);

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

  return { seeded, skipped, flagsRaised, backfilled, backfillRefused };
}

export interface SeedReviewedCorpusResult {
  stands: SeedResult;
  offerings: SeedOfferingsResult;
}

/**
 * Restore the VIGA stand corpus and its HUMAN-REVIEWED usual offerings atomically (B-044).
 *
 * The model proposal and Max's review remain separate from this operation. Once that review is
 * recorded in the approved artifact, however, stands and their standing item facts are one
 * restore unit: committing only the first half makes every public card claim it usually has
 * nothing. An unmatched approved name aborts the whole transaction; a partial corpus must never
 * look like a completed restore.
 */
export async function seedReviewedCorpus(
  sql: Sql,
  stands: SeedStandInput[],
  offerings: SeedOfferingInput[],
): Promise<SeedReviewedCorpusResult> {
  return sql.begin(async (tx) => {
    const standResult = await seedStandsInTransaction(tx, stands);
    const offeringResult = await seedOfferingsInTransaction(tx, offerings);
    if (offeringResult.unknownStands.length > 0) {
      throw new Error(
        `reviewed offerings name unknown stands: ${offeringResult.unknownStands.join(", ")}`,
      );
    }
    return { stands: standResult, offerings: offeringResult };
  });
}

/**
 * VIGA's side facts for one stand: links, payment methods, hosted participants.
 *
 * ONE writer for both paths — a freshly inserted stand and an existing one being backfilled
 * (GL-015). Two copies would drift, and the copy that drifted would be the rarely-exercised
 * backfill, which is exactly the one that runs against production with real data.
 *
 * Every statement is `on conflict do nothing`, which is what makes it safe to re-run over a
 * populated stand: it fills gaps and never overwrites, reorders, or removes. Nothing here
 * touches the listing itself.
 *
 * Returns whether anything was actually added, so the caller can report backfilled stands
 * rather than counting every skipped stand as one.
 */
async function writeSideFacts(
  tx: Tx,
  stand: SeedStandInput,
  farmId: string,
  locationId: string,
): Promise<boolean> {
  let added = false;

  // F-061 — links and payment methods, two tables that had a schema and no writer. Keyed
  // differently on purpose: links belong to the FARM (one website, however many stands),
  // payment methods to the LOCATION (what this stand takes at this table).
  for (const [index, link] of (stand.links ?? []).entries()) {
    const rows = await tx`
      insert into seller_links (seller_id, label, url, sort_order)
      values (${farmId}, ${link.label}, ${link.url}, ${index})
      on conflict do nothing
      returning id
    `;
    if (rows.length > 0) added = true;
  }
  // F-125 — payment belongs to the FARM. A seed row still states it per stand (that is how
  // VIGA's export is shaped), but it lands on the seller, so two stands of one farm converge
  // on one answer instead of writing two that can disagree.
  for (const method of stand.paymentMethods ?? []) {
    const rows = await tx`
      insert into seller_payment_methods (seller_id, method)
      values (${farmId}, ${method})
      on conflict do nothing
      returning seller_id
    `;
    if (rows.length > 0) added = true;
  }
  if (stand.farmBucksAccepted !== undefined) {
    await tx`
      update sellers set farm_bucks_accepted = ${stand.farmBucksAccepted}
      where id = ${farmId}
    `;
  }

  // F-064 — host sellers, written as VIGA's statement rather than the farmer's.
  //
  // `on conflict do nothing` against the partial unique index on the normalized name where
  // `retired_at is null`, so a re-run adds no duplicate. That index is also why this never
  // resurrects a host a farmer retired: the retired row does not occupy the index, but the
  // farmer-authorization check upstream refuses the whole backfill for that farm anyway.
  for (const participant of stand.participants ?? []) {
    const rows = await tx`
      insert into sales_location_participants (
        owner_seller_id, sales_location_id, display_name, source, confirmed_at
      )
      values (${farmId}, ${locationId}, ${participant}, 'viga', now())
      on conflict do nothing
      returning id
    `;
    if (rows.length > 0) added = true;
  }

  return added;
}

/** One farm's weekly statement, already parsed and joined by name (F-062). */
export interface WeeklyConfirmationInput {
  /** The farm name as the weekly form states it; resolved through the seed join's own key. */
  standName: string;
  /** The day the farmer submitted. The form records a date, not an instant. */
  statedOn: Date;
  /** The items named, in stated order. */
  items: string[];
}

export interface WeeklyConfirmationResult {
  published: number;
  /** Rows refused because something NEWER is already published for that stand. */
  skippedAsOlder: number;
  /** Farm names in the form that match no seeded stand. Reported, never silently dropped. */
  unknownStands: string[];
  /**
   * Names that reached a stand under a DIFFERENT name, and which one.
   *
   * Reported rather than resolved silently: a farmer's submission landing on the wrong farm's
   * card is the failure this whole matching design exists to prevent, so every non-exact
   * resolution stays visible to the operator running the ingest.
   */
  resolvedByOtherName: { stated: string; resolvedTo: string }[];
}

export interface WeeklyConfirmationOptions {
  /**
   * Farm names a farmer stated are FORMER names of their listing (`readFormerNames`).
   *
   * The weekly form still carries submissions under an old name — Green Ears' row reads
   * "Formerly Maggie's Farm" — and the two names share no characters, so no spelling rule can
   * reach it. Supplied by the caller because it is read from the profile form, which this
   * function does not have.
   */
  formerNames?: ReadonlyMap<string, string>;
}

/**
 * Publish weekly-form submissions as dated confirmations (F-062).
 *
 * WHY THESE ARE CONFIRMATIONS AT ALL. A farmer has filled in VIGA's weekly form for years and
 * has not heard of Farm Friend. If their submission produced nothing, the system replacing their
 * old one would be strictly worse for them on day one. And a customer wants both facts: the
 * standing "usually sells" sets expectations, this dated one says how much to trust it today.
 *
 * WHY `source = 'viga'`. A Google Form is not a handset. Before F-063 this row was
 * unrepresentable without inventing a proposal, an authorization, and an approval — a false
 * statement about an identifiable person. Now it is simply a different, honestly labelled kind
 * of confirmation, and the staleness machinery ages it correctly with no special handling.
 *
 * THE NEWER FACT ALWAYS WINS, whatever its source. A farmer who texts an update must never have
 * it reverted by a re-ingest carrying last week's sheet row — that is the migration path off the
 * legacy form: the moment a farmer texts, their own words take over. The comparison is on
 * `published_at`, so this holds for an older weekly row against a newer weekly row too.
 */
export async function seedWeeklyConfirmations(
  sql: Sql,
  submissions: WeeklyConfirmationInput[],
  options: WeeklyConfirmationOptions = {},
): Promise<WeeklyConfirmationResult> {
  let published = 0;
  let skippedAsOlder = 0;
  const unknownStands: string[] = [];
  const resolvedByOtherName: { stated: string; resolvedTo: string }[] = [];

  await sql.begin(async (tx) => {
    // Built inside the transaction so the index cannot go stale mid-batch, and so an ambiguous
    // name aborts before any confirmation lands rather than after some of them have.
    const byKey = await indexLocationsByMatchKey(tx);
    const seededNames = [...byKey.values()].map((location) => location.name);

    for (const submission of submissions) {
      // Exact first, then a stated rename, then an unambiguous word-prefix. Farmers do not
      // retype their full listing name every week — three of the 2026 weekly sellers reached no
      // stand at all under an exact key, and each was a real submission that reached nobody.
      const resolvedKey = resolveStandKey(submission.standName, seededNames, {
        ...(options.formerNames !== undefined ? { formerNames: options.formerNames } : {}),
      });
      const location = resolvedKey === undefined ? undefined : byKey.get(resolvedKey);
      if (location === undefined) {
        unknownStands.push(submission.standName);
        continue;
      }
      if (resolvedKey !== matchStandName(submission.standName)) {
        resolvedByOtherName.push({
          stated: submission.standName,
          resolvedTo: location.name,
        });
      }

      // `for update` so two concurrent ingests cannot both read "no current revision" and then
      // both insert, which the partial unique index would reject as a lost race rather than a
      // clean skip.
      const current = await tx`
        select id, published_at from inventory_revisions
        where sales_location_id = ${location.id} and is_current
        for update
      `;
      const currentPublishedAt = current[0]?.published_at as Date | undefined;
      if (
        currentPublishedAt !== undefined &&
        currentPublishedAt.getTime() >= submission.statedOn.getTime()
      ) {
        skippedAsOlder++;
        continue;
      }

      if (current.length > 0) {
        await tx`
          update inventory_revisions
          set is_current = false, superseded_at = ${submission.statedOn}
          where id = ${current[0]?.id as string}
        `;
      }

      // F-114 Phase B — a seeded revision is the stand's own statement, so the native slot.
      const seedRevisionProviderId = await readNativeProviderId(tx, {
        salesLocationId: location.id,
      });
      const revision = await tx`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, source, published_at
        )
        select own_seller_id, id, ${seedRevisionProviderId}, 'viga', ${submission.statedOn}
        from sales_locations where id = ${location.id}
        returning id
      `;
      const revisionId = revision[0]?.id as string;

      for (const [index, item] of submission.items.entries()) {
        await tx`
          insert into inventory_entries (
            inventory_revision_id, sales_location_id, item_name, sort_order
          )
          values (${revisionId}, ${location.id}, ${item}, ${index})
        `;
      }
      published++;
    }
  });

  return { published, skippedAsOlder, unknownStands, resolvedByOtherName };
}
