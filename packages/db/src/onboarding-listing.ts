import { ISLAND_BOUNDS } from "@farm-friend/core";
import type { Db } from "./index";
import {
  coherentAvailability,
  NO_AVAILABILITY_STATED,
  type ListingAvailability,
} from "./listing-availability";
import { canonicalPaymentMethods } from "./payment-methods";
import type { Sql, Tx } from "./sql";

// F-067 — the first farmer-facing writer of PUBLIC LISTING FACTS.
//
// Until this, `sales_locations` had exactly one non-test writer: the seeder. Addresses, hours,
// payment methods and offerings were read everywhere and only ever loaded from VIGA's CSV, so
// a farmer whose listing was wrong could not correct it and a farm created by an invitation
// reached the public map with a name and nothing else.
//
// ## The branch that is the form's real structure
//
// `sales_locations_coherent_visitability` is all-or-nothing in BOTH directions: a `visitable`
// stand requires an address AND a complete coordinate pair; a `contact_only` stand requires
// all three to be ABSENT. That is F-038 and B-024 — inventing an address for a farm with no
// stand to visit puts a pin on the map that sends someone driving to a place with nothing to
// buy, and the database refuses it rather than trusting every writer to remember.
//
// So this writer cannot infer visitability, and neither can the form: it has to ASK.
//
// ## Why the checks are here AND in the database
//
// The constraint is the guarantee; these checks are how a farmer gets an answer instead of a
// 500. A constraint violation escaping to the browser tells them nothing about which field to
// fix. Neither layer is redundant — remove the constraint and a future writer reintroduces the
// defect, remove these and the farmer hits an opaque error.
//
// ## What this deliberately does NOT do
//
// It writes no inventory. What a farmer usually sells is F-066's STANDING state
// (`stand_items.usually_carried`), which carries no confirmation time and can never occupy the
// one-current-per-location slot. "I usually sell eggs" is not "eggs were on the table today",
// and collapsing the two would manufacture exactly the certainty an honor-system stand refuses
// to fake. This module is the farmer-facing writer F-066 said it lacked; SMS still writes only
// confirmations.

function driver(db: Db): Sql {
  return db.sql;
}

/** The whitespace `stand_items`' index and CHECK name explicitly. Must match exactly. */
const ITEM_WHITESPACE = " \t\r\n";

/**
 * Case and surrounding whitespace ONLY — never singular/plural, never synonyms.
 *
 * Exported so it can be asserted DIRECTLY. A sabotage proved that testing this through the
 * stored rows is not enough: a normalizer that mangles a word without colliding with another
 * ("tomatoes" → "tomatoe") corrupts the key while every row-count assertion stays green,
 * because the database index applies the correct rule independently. The key itself has to be
 * the thing under test.
 *
 * MUST agree exactly with `stand_items_one_per_location_name`, which is
 * `lower(btrim(display_name, E' \t\r\n'))`. If the two disagree they disagree about what
 * "same item" means, and the in-memory dedupe silently stops matching the index that arbitrates.
 */
export function standItemKey(name: string): string {
  return trimItem(name).toLowerCase();
}

function trimItem(name: string): string {
  let start = 0;
  let end = name.length;
  while (start < end && ITEM_WHITESPACE.includes(name[start]!)) start += 1;
  while (end > start && ITEM_WHITESPACE.includes(name[end - 1]!)) end -= 1;
  return name.slice(start, end);
}

/** What the farmer stated about their listing. */
export interface OnboardingListingInput {
  /** Whether there is a place to go. Decides whether an address and pin are required. */
  visitability: "visitable" | "contact_only";
  offeringType: "produce" | "services" | "by_order";
  publicAddress: string | null;
  /** From the farmer's pin drop on the drawn island — there is no geocoder (a non-goal). */
  latitude: number | null;
  longitude: number | null;
  /** The farmer's own words about when they are open, preserved verbatim (display only). */
  hoursText: string | null;
  /**
   * F-069 — the FILTERABLE season / hours / stocking facts, beside `hoursText` rather than
   * instead of it. Optional: a form that states none of it writes the same NULLs as before.
   */
  availability?: ListingAvailability;
  paymentMethods: string[];
  /** What they usually sell, in their own words and their own order. */
  items: string[];
}

export type SaveOnboardingListingResult =
  | { status: "saved"; salesLocationId: string }
  | { status: "unknown_farm" }
  | { status: "invalid_name" }
  /** The visitability branch is contradicted: see `coherentVisitability`. */
  | { status: "incomplete_location" }
  | { status: "off_island" }
  /** The stated season / hours / stocking contradict themselves: see `coherentAvailability`. */
  | { status: "incoherent_availability" };

export type RenameFarmResult =
  | { status: "saved" }
  | { status: "unknown_farm" }
  | { status: "invalid_name" };

/**
 * Rename a farm.
 *
 * **The farm's name was previously immutable.** It was written when the invitation was
 * created and no path — farmer or administrator — could change it afterwards, yet it is
 * shown to customers on the map beside the stand. A name mistyped at invitation time was
 * therefore permanent and public. The farmer owns their published state, so the farmer is
 * who corrects it.
 *
 * Deliberately NOT part of `saveOnboardingListing`: the stand name and the farm name are
 * different facts about different records, and folding them into one writer is what made
 * them easy to confuse in the first place. The caller supplies a `farmId` it already
 * resolved from a credential — this function performs no authorization of its own, exactly
 * like its neighbours here.
 *
 * The `returning` clause is what distinguishes "renamed" from "matched no row": an update
 * against a missing id affects nothing and would otherwise report success.
 */
export async function renameFarm(
  db: Db,
  input: { farmId: string; name: string },
): Promise<RenameFarmResult> {
  const name = input.name.trim();
  if (name === "") return { status: "invalid_name" };

  const rows = await driver(db)`
    update farms set name = ${name} where id = ${input.farmId} returning id
  `;
  return rows.length === 0 ? { status: "unknown_farm" } : { status: "saved" };
}

/**
 * Write the listing an onboarding farmer typed, as their farm's stand.
 *
 * Publishes on submit (max, 2026-08-05): the listing is live when the form is sent rather than
 * waiting for the SIGNUP text, and "the admin can fix anything erroneous".
 *
 * **The farm's EXISTING stand is updated rather than joined by a second one.** A farmer invited
 * against a farm VIGA already seeded has a stand already, so a fresh insert would show that
 * farm twice on the map — once with the old CSV data and once with the farmer's own. The same
 * property makes a resubmitted form idempotent.
 */
export async function saveOnboardingListing(
  db: Db,
  input: {
    farmId: string;
    /** What the stand is called on the map. Defaults to the farm's name at the boundary. */
    standName: string;
    listing: OnboardingListingInput;
    occurredAt: Date;
  },
): Promise<SaveOnboardingListingResult> {
  const listing = input.listing;
  const standName = input.standName.trim();
  const address = listing.publicAddress?.trim() ?? null;
  const hoursText = listing.hoursText?.trim() ?? null;

  // Trimmed before every test below, so padding decides nothing — `"  "` is blank, and a
  // padded real name is stored clean rather than reaching the public map with its whitespace.
  if (standName === "") return { status: "invalid_name" };

  const hasAddress = address !== null && address !== "";
  const hasPin = listing.latitude !== null && listing.longitude !== null;

  // Both directions of `coherentVisitability`, refused here so the farmer learns which half of
  // their answer is missing rather than receiving a constraint violation.
  if (listing.visitability === "visitable") {
    if (!hasAddress || !hasPin) return { status: "incomplete_location" };
  } else if (hasAddress || listing.latitude !== null || listing.longitude !== null) {
    return { status: "incomplete_location" };
  }

  // A pin outside the drawn island cannot be rendered on it. `ISLAND_BOUNDS` is the authority
  // rather than a second envelope of this module's own: the file that owns the projection
  // warns that two independent statements about where the island is will drift, and a farm on
  // the wrong side of that drift is a pin in Puget Sound.
  if (hasPin) {
    const latitude = listing.latitude!;
    const longitude = listing.longitude!;
    if (
      latitude < ISLAND_BOUNDS.south ||
      latitude > ISLAND_BOUNDS.north ||
      longitude < ISLAND_BOUNDS.west ||
      longitude > ISLAND_BOUNDS.east
    ) {
      return { status: "off_island" };
    }
  }

  // F-069. Refused BEFORE the transaction opens, and named as its own status: the five F-035
  // CHECK constraints would refuse the write anyway, but as a violation the farmer cannot act
  // on. `coherentAvailability` is the same rule stated where an error message can reach them.
  const availability = listing.availability ?? NO_AVAILABILITY_STATED;
  if (!coherentAvailability(availability)) {
    return { status: "incoherent_availability" };
  }

  return driver(db).begin(async (tx) => {
    // Locked, so two submissions from one farmer — a double-tapped button, a reload — cannot
    // both observe "no stand" and insert one each.
    const farms = await tx`
      select id from farms where id = ${input.farmId} for update
    `;
    if (farms.length === 0) return { status: "unknown_farm" as const };

    const existing = await tx`
      select id from sales_locations
      where owner_farm_id = ${input.farmId}
      order by created_at asc
      limit 1
    `;
    const existingId = existing[0]?.id as string | undefined;

    const salesLocationId =
      existingId === undefined
        ? await insertStand(tx, { ...input, standName, address, hoursText, availability })
        : await updateStand(tx, {
            salesLocationId: existingId,
            ...input,
            standName,
            address,
            hoursText,
            availability,
          });

    await writePaymentMethods(tx, salesLocationId, listing.paymentMethods);
    await writeStandingItems(tx, salesLocationId, listing.items);

    return { status: "saved" as const, salesLocationId };
  }) as Promise<SaveOnboardingListingResult>;
}

/**
 * The three columns the schema refuses to default are all supplied deliberately.
 *
 * `timezone` has no default because "every new location must deliberately choose a reviewed
 * zone", and `America/Los_Angeles` is the only reviewed one — Farm Friend is one island.
 * `kind` is `farm_stand`: the other value is `farmers_market`, which is not a thing a farmer
 * creates for themselves during onboarding.
 */
async function insertStand(
  tx: Tx,
  input: {
    farmId: string;
    standName: string;
    address: string | null;
    hoursText: string | null;
    availability: ListingAvailability;
    listing: OnboardingListingInput;
    occurredAt: Date;
  },
): Promise<string> {
  const available = input.availability;
  const rows = await tx`
    insert into sales_locations (
      owner_farm_id, kind, name, timezone, visitability, offering_type,
      public_address, public_latitude, public_longitude, hours_text,
      season_kind, season_start_month, season_start_day,
      season_end_month, season_end_day, season_names,
      open_hours_kind, open_from_minutes, open_until_minutes, open_days,
      stocking_cadence, stocking_days,
      is_public, farm_bucks_accepted, farm_bucks_eligible,
      created_at, updated_at
    ) values (
      ${input.farmId}, 'farm_stand', ${input.standName}, 'America/Los_Angeles',
      ${input.listing.visitability}, ${input.listing.offeringType},
      ${input.address}, ${input.listing.latitude}, ${input.listing.longitude},
      ${input.hoursText},
      ${available.seasonKind}, ${available.seasonStartMonth}, ${available.seasonStartDay},
      ${available.seasonEndMonth}, ${available.seasonEndDay},
      ${available.seasonNames as string[] | null},
      ${available.openHoursKind}, ${available.openFromMinutes},
      ${available.openUntilMinutes}, ${available.openDays as number[] | null},
      ${available.stockingCadence}, ${available.stockingDays as number[] | null},
      true, false, false,
      ${input.occurredAt.toISOString()}, ${input.occurredAt.toISOString()}
    )
    returning id
  `;
  return rows[0]!.id as string;
}

/**
 * Update the farm's existing stand in place.
 *
 * **Farm Bucks is deliberately NOT touched.** It is a VIGA eligibility fact with its own admin
 * workflow and its own `acceptanceRequiresEligibility` constraint — a farmer cannot make
 * themselves eligible by filling in a form, and a re-submission must not silently revert what
 * an operator set.
 */
async function updateStand(
  tx: Tx,
  input: {
    salesLocationId: string;
    standName: string;
    address: string | null;
    hoursText: string | null;
    availability: ListingAvailability;
    listing: OnboardingListingInput;
    occurredAt: Date;
  },
): Promise<string> {
  // The availability columns are written as ONE STATEMENT, every column named — including the
  // NULLs. A farmer who moves from "March-November" to "year-round" must clear the old dates,
  // and a partial update that set `season_kind` while leaving them would violate
  // `coherentSeason` in the database. Twelve columns, always all twelve.
  const available = input.availability;
  await tx`
    update sales_locations
    set name = ${input.standName},
        visitability = ${input.listing.visitability},
        offering_type = ${input.listing.offeringType},
        public_address = ${input.address},
        public_latitude = ${input.listing.latitude},
        public_longitude = ${input.listing.longitude},
        hours_text = ${input.hoursText},
        season_kind = ${available.seasonKind},
        season_start_month = ${available.seasonStartMonth},
        season_start_day = ${available.seasonStartDay},
        season_end_month = ${available.seasonEndMonth},
        season_end_day = ${available.seasonEndDay},
        season_names = ${available.seasonNames as string[] | null},
        open_hours_kind = ${available.openHoursKind},
        open_from_minutes = ${available.openFromMinutes},
        open_until_minutes = ${available.openUntilMinutes},
        open_days = ${available.openDays as number[] | null},
        stocking_cadence = ${available.stockingCadence},
        stocking_days = ${available.stockingDays as number[] | null},
        is_public = true,
        updated_at = ${input.occurredAt.toISOString()}
    where id = ${input.salesLocationId}
  `;
  return input.salesLocationId;
}

/**
 * Replace the stand's payment methods with what the farmer stated.
 *
 * A full replace rather than an upsert, because removing a method is a thing the farmer must
 * be able to do: an upsert-only write would make "we stopped taking checks" unsayable.
 *
 * F-069 — canonicalized on the way in (`canonicalPaymentMethods`), so "venmo" and "VENMO" are
 * one filterable value rather than two the map cannot join. Unrecognized methods are kept as
 * the farmer's own words; the fold applies only to the known closed set.
 */
async function writePaymentMethods(
  tx: Tx,
  salesLocationId: string,
  methods: string[],
): Promise<void> {
  // Blanks are dropped rather than refused: a stray comma is a farmer typing, and the not-blank
  // CHECK would otherwise turn one stray space into a failed submission with nothing useful to
  // say about which field caused it.
  const stated = canonicalPaymentMethods(methods);

  await tx`
    delete from sales_location_payment_methods
    where sales_location_id = ${salesLocationId}
  `;
  for (const method of stated) {
    await tx`
      insert into sales_location_payment_methods (sales_location_id, method)
      values (${salesLocationId}, ${method})
      on conflict do nothing
    `;
  }
}

/**
 * Write what the stand usually sells as F-066's STANDING state.
 *
 * **The item outlives its states.** An item the farmer removed from the mix has
 * `usually_carried` cleared but keeps its row, so a past dated confirmation of it still
 * resolves to the same vocabulary entry — that is F-066's whole shape, and deleting the row
 * instead would orphan published history the entries table refuses to let anyone rewrite.
 *
 * **Normalization is case and surrounding whitespace ONLY.** "tomato", "tomatoes" and "love
 * apple" stay three items. Folding them is a produce taxonomy, which no business code may
 * hard-code — a test asserts this and must be deleted before anyone can loosen it.
 */
async function writeStandingItems(
  tx: Tx,
  salesLocationId: string,
  items: string[],
): Promise<void> {
  const stated: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const trimmed = trimItem(item);
    if (trimmed === "") continue;
    const key = standItemKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    stated.push(trimmed);
  }

  // Clear the standing claim across the whole stand FIRST, so an item the farmer dropped stops
  // being claimed. Scoped to this location's rows only.
  await tx`
    update stand_items set usually_carried = false
    where sales_location_id = ${salesLocationId}
  `;

  for (const [index, item] of stated.entries()) {
    // THE INDEX IS THE ARBITER, never a preceding read: `stand_items_one_per_location_name` is
    // what makes "eggs exists once here" structural, and `select … for update` cannot
    // serialize a row that does not exist yet. `do update` rather than `do nothing` is
    // load-bearing — an item that exists only because a revision confirmed it must BECOME a
    // standing claim when the farmer lists it, and a sabotage proved `do nothing` drops that
    // silently with no error anywhere.
    //
    // The display name is NOT overwritten on conflict: the farmer's first spelling is the
    // item's words, and F-066 has no rename operation by design.
    await tx`
      insert into stand_items (sales_location_id, display_name, usually_carried, sort_order)
      values (${salesLocationId}, ${item}, true, ${index})
      on conflict (sales_location_id, lower(btrim(display_name, E' \t\r\n')))
      do update set usually_carried = true, sort_order = ${index}
    `;
  }
}

/**
 * A stand's current listing, in the exact shape the form writes back (F-073).
 *
 * **This exists so an edit form can prefill.** `saveOnboardingListing` writes the WHOLE listing
 * every time — that is what makes it idempotent and what lets a farmer drop a payment method or
 * an item by leaving it out. The same property makes a blank edit form destructive: a farmer who
 * opened it to change their hours would erase their address, payments, and items by omission.
 * So the read and the write are deliberately the same shape, and a round trip changes nothing.
 *
 * Returns `null` for a stand that does not exist.
 */
export interface StandListing {
  standName: string;
  /**
   * The FARM's name, which is a different record from the stand's and is shown to customers
   * beside it. Both are returned because the editor prefills each from its own source —
   * passing the stand's name into a farm-name field is exactly the conflation that left the
   * farm name looking editable when nothing could change it.
   */
  farmName: string;
  visitability: "visitable" | "contact_only";
  offeringType: "produce" | "services" | "by_order";
  publicAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  hoursText: string | null;
  availability: ListingAvailability;
  paymentMethods: string[];
  items: string[];
}

export async function readStandListing(
  db: Db,
  input: { salesLocationId: string },
): Promise<StandListing | null> {
  const rows = await driver(db)`
    select
      location.name, location.visitability, location.offering_type,
      location.public_address, location.public_latitude, location.public_longitude,
      location.hours_text,
      location.season_kind, location.season_start_month, location.season_start_day,
      location.season_end_month, location.season_end_day, location.season_names,
      location.open_hours_kind, location.open_from_minutes, location.open_until_minutes,
      location.open_days, location.stocking_cadence, location.stocking_days,
      coalesce(
        (
          select array_agg(payment.method order by payment.method)
          from sales_location_payment_methods as payment
          where payment.sales_location_id = location.id
        ),
        '{}'
      ) as payment_methods,
      coalesce(
        (
          select array_agg(item.display_name order by item.sort_order, item.display_name)
          from stand_items as item
          where item.sales_location_id = location.id and item.usually_carried
        ),
        '{}'
      ) as items
      , farm.name as farm_name
    from sales_locations as location
    join farms as farm on farm.id = location.owner_farm_id
    where location.id = ${input.salesLocationId}
  `;

  const row = rows[0];
  if (row === undefined) return null;
  return {
    standName: row.name as string,
    farmName: row.farm_name as string,
    visitability: row.visitability as "visitable" | "contact_only",
    offeringType: row.offering_type as "produce" | "services" | "by_order",
    publicAddress: (row.public_address as string | null) ?? null,
    latitude: (row.public_latitude as number | null) ?? null,
    longitude: (row.public_longitude as number | null) ?? null,
    hoursText: (row.hours_text as string | null) ?? null,
    availability: {
      seasonKind: row.season_kind as ListingAvailability["seasonKind"],
      seasonStartMonth: (row.season_start_month as number | null) ?? null,
      seasonStartDay: (row.season_start_day as number | null) ?? null,
      seasonEndMonth: (row.season_end_month as number | null) ?? null,
      seasonEndDay: (row.season_end_day as number | null) ?? null,
      seasonNames: (row.season_names as string[] | null) ?? null,
      openHoursKind: row.open_hours_kind as ListingAvailability["openHoursKind"],
      openFromMinutes: (row.open_from_minutes as number | null) ?? null,
      openUntilMinutes: (row.open_until_minutes as number | null) ?? null,
      openDays: (row.open_days as number[] | null) ?? null,
      stockingCadence: row.stocking_cadence as ListingAvailability["stockingCadence"],
      stockingDays: (row.stocking_days as number[] | null) ?? null,
    },
    paymentMethods: row.payment_methods as string[],
    items: row.items as string[],
  };
}
