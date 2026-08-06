import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NO_AVAILABILITY_STATED } from "./listing-availability";
import { saveOnboardingListing } from "./onboarding-listing";
import type { Db, Sql } from "./index";

// F-067 — the first farmer-facing writer of PUBLIC LISTING FACTS.
//
// Before this, `sales_locations` had exactly one non-test writer: the seeder. Addresses,
// hours, payment methods, and offerings were read everywhere and only ever loaded from VIGA's
// CSV export, so a farmer whose listing was wrong had no way to correct it and a brand-new
// farm reached the public map with a name and nothing else.
//
// What only real Postgres can prove, and what this suite is therefore for:
//
//   1. THE VISITABILITY BRANCH IS STRUCTURAL. `coherentVisitability` is all-or-nothing in
//      BOTH directions — a visitable stand needs an address AND a complete coordinate pair, a
//      contact-only stand must have none of the three. This is what forbids inventing an
//      address (F-038, B-024), and it is the reason the form must ASK whether there is a
//      stand to visit before it can know what to require.
//   2. The three deliberately defaulted-nothing columns — timezone, visitability,
//      offering_type — are supplied on every write, because the schema refuses to guess.
//   3. Payment methods and standing items are written as the farmer's own words, and the
//      standing item state gets the farmer-facing writer F-066 says it lacks.
//   4. Re-submitting is idempotent against the stand-item index rather than duplicating.
//
// The listing is written against the INVITATION's farm. max chose (2026-08-05) that it
// publishes on submit rather than waiting for the SIGNUP text.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-067 onboarding listing (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let farmId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  /** The writer takes the same `Db` shape production passes it. */
  const database = (): Db => ({ sql: client() }) as Db;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_listing_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    // A fresh farm per test, so one test's location cannot satisfy another's assertion.
    const farms = await client()`
      insert into farms (name) values (${`Listing Farm ${randomUUID()}`}) returning id
    `;
    farmId = farms[0]?.id as string;
  });

  /** The listing a farmer with a real roadside stand would submit. */
  const visitableListing = {
    visitability: "visitable" as const,
    offeringType: "produce" as const,
    publicAddress: "12345 Vashon Highway SW",
    latitude: 47.4471,
    longitude: -122.4594,
    hoursText: "Daylight hours, most days",
    paymentMethods: ["cash", "Venmo"],
    items: ["Eggs", "plant starts"],
  };

  it("creates the stand a new farm reaches the map with", async () => {
    const result = await saveOnboardingListing(database(), {
      farmId,
      standName: "Listing Stand",
      listing: visitableListing,
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    expect(result.status).toBe("saved");

    const rows = await client()`
      select name, timezone, visitability, offering_type, public_address,
             public_latitude, public_longitude, hours_text, is_public
      from sales_locations where owner_farm_id = ${farmId}
    `;
    expect(rows).toHaveLength(1);
    const stand = rows[0]!;
    expect(stand.name).toBe("Listing Stand");
    expect(stand.visitability).toBe("visitable");
    expect(stand.offering_type).toBe("produce");
    expect(stand.public_address).toBe("12345 Vashon Highway SW");
    expect(Number(stand.public_latitude)).toBeCloseTo(47.4471, 6);
    expect(Number(stand.public_longitude)).toBeCloseTo(-122.4594, 6);
    expect(stand.hours_text).toBe("Daylight hours, most days");
    // max chose publish-on-submit (2026-08-05): the listing is live when the form is sent,
    // not held until the SIGNUP text arrives.
    expect(stand.is_public).toBe(true);
    // The reviewed-zone column the schema refuses to default.
    expect(stand.timezone).toBe("America/Los_Angeles");
  });

  it("records a stand with NO PLACE TO VISIT and invents no address", async () => {
    // B-024 / F-038 — the direction that actually protects customers. Open Gate Lamb has no
    // stand to visit; publishing a made-up address would send someone driving to a place
    // with nothing to buy. The farmer says so on the form and the database holds the line.
    const result = await saveOnboardingListing(database(), {
      farmId,
      standName: "Delivery Only Farm",
      listing: {
        visitability: "contact_only",
        offeringType: "by_order",
        publicAddress: null,
        latitude: null,
        longitude: null,
        hoursText: "By arrangement",
        paymentMethods: ["cash"],
        items: ["lamb"],
      },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    expect(result.status).toBe("saved");

    const rows = await client()`
      select visitability, public_address, public_latitude, public_longitude
      from sales_locations where owner_farm_id = ${farmId}
    `;
    const stand = rows[0]!;
    expect(stand.visitability).toBe("contact_only");
    expect(stand.public_address).toBeNull();
    expect(stand.public_latitude).toBeNull();
    expect(stand.public_longitude).toBeNull();
  });

  it("REFUSES a visitable stand with no pin rather than publishing an unplaceable one", async () => {
    // The form asks the farmer to drop a pin precisely because this is refused. A visitable
    // stand without coordinates cannot be placed on the map, so "visitable" would be a
    // promise the system cannot keep. Refused in the WRITER, so the farmer gets an answer
    // instead of a constraint violation escaping as a 500.
    const result = await saveOnboardingListing(database(), {
      farmId,
      standName: "Unplaceable Stand",
      listing: { ...visitableListing, latitude: null, longitude: null },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    expect(result.status).toBe("incomplete_location");

    const rows = await client()`
      select id from sales_locations where owner_farm_id = ${farmId}
    `;
    expect(rows).toHaveLength(0);
  });

  it("REFUSES a visitable stand with no address", async () => {
    const result = await saveOnboardingListing(database(), {
      farmId,
      standName: "Addressless Stand",
      listing: { ...visitableListing, publicAddress: null },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    expect(result.status).toBe("incomplete_location");
    const rows = await client()`
      select id from sales_locations where owner_farm_id = ${farmId}
    `;
    expect(rows).toHaveLength(0);
  });

  it("REFUSES an address or pin on a stand with nowhere to visit", async () => {
    // The other direction of the same constraint. A farmer who ticks "no stand to visit"
    // but whose address field still carries text must not publish a pin — that is exactly
    // the map error B-024 exists to prevent.
    const result = await saveOnboardingListing(database(), {
      farmId,
      standName: "Contradictory Stand",
      listing: {
        visitability: "contact_only",
        offeringType: "produce",
        publicAddress: "12345 Vashon Highway SW",
        latitude: 47.4471,
        longitude: -122.4594,
        hoursText: null,
        paymentMethods: [],
        items: [],
      },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    expect(result.status).toBe("incomplete_location");
    const rows = await client()`
      select id from sales_locations where owner_farm_id = ${farmId}
    `;
    expect(rows).toHaveLength(0);
  });

  it("writes what the farmer usually sells as F-066 STANDING state", async () => {
    // This is the writer F-066's last acceptance criterion waits on. Before it, the seeder
    // was the only thing that had ever written `usually_carried`.
    await saveOnboardingListing(database(), {
      farmId,
      standName: "Item Stand",
      listing: visitableListing,
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    const items = await client()`
      select item.display_name, item.usually_carried, item.sort_order
      from stand_items item
      join sales_locations l on l.id = item.sales_location_id
      where l.owner_farm_id = ${farmId}
      order by item.sort_order asc
    `;
    expect(items.map((row) => row.display_name)).toEqual(["Eggs", "plant starts"]);
    // Standing state, not a dated confirmation — the farmer said what they usually sell,
    // which is a different claim from "this was on the table today".
    expect(items.every((row) => row.usually_carried === true)).toBe(true);
    expect(items.map((row) => row.sort_order)).toEqual([0, 1]);

    // A standing claim carries NO confirmation, so the stand still has no current revision.
    // That separation is the whole answer to max's original question and must survive here.
    const revisions = await client()`
      select r.id from inventory_revisions r
      join sales_locations l on l.id = r.sales_location_id
      where l.owner_farm_id = ${farmId}
    `;
    expect(revisions).toHaveLength(0);
  });

  it("keeps the farmer's OWN WORDS — no singular/plural or synonym folding", async () => {
    // The line most likely to be argued past later, so it is asserted rather than trusted.
    // "tomato", "tomatoes" and "love apple" are three things a farmer might genuinely stock
    // separately, and deciding they are one is a produce taxonomy — which CLAUDE.md forbids
    // in behavioral branches. Normalization is case and surrounding whitespace ONLY.
    //
    // THIS TEST MUST BE DELETED BEFORE ANYONE CAN LOOSEN THAT. That is its job.
    await saveOnboardingListing(database(), {
      farmId,
      standName: "Vocabulary Stand",
      listing: {
        ...visitableListing,
        items: ["tomato", "tomatoes", "love apple"],
      },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    const items = await client()`
      select item.display_name from stand_items item
      join sales_locations l on l.id = item.sales_location_id
      where l.owner_farm_id = ${farmId}
      order by item.sort_order asc
    `;
    expect(items.map((row) => row.display_name)).toEqual([
      "tomato",
      "tomatoes",
      "love apple",
    ]);
  });

  it("folds only CASE and SURROUNDING WHITESPACE into one item", async () => {
    // The complement of the test above, so "keeps them apart" is not passing by the writer
    // simply never merging anything. `Eggs`, `eggs` and `  EGGS ` are one item.
    await saveOnboardingListing(database(), {
      farmId,
      standName: "Folding Stand",
      listing: { ...visitableListing, items: ["Eggs", "eggs", "  EGGS "] },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    const items = await client()`
      select item.display_name from stand_items item
      join sales_locations l on l.id = item.sales_location_id
      where l.owner_farm_id = ${farmId}
    `;
    expect(items).toHaveLength(1);
    // The farmer's first spelling is kept for display.
    expect(items[0]!.display_name).toBe("Eggs");
  });

  it("writes payment methods CANONICALIZED, so a filter can join them", async () => {
    // F-068 changed this from "as stated": the farmer typed "cash" and the stored value is
    // "Cash". Payments are a closed VIGA-known set, so one spelling per method is what makes
    // them filterable — the unfilterable free text is exactly what Farm Friend replaces.
    await saveOnboardingListing(database(), {
      farmId,
      standName: "Payment Stand",
      listing: visitableListing,
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    const methods = await client()`
      select m.method from sales_location_payment_methods m
      join sales_locations l on l.id = m.sales_location_id
      where l.owner_farm_id = ${farmId}
    `;
    // Compared as a SET: the table's primary key is (location, method) and carries no order,
    // so asserting a sequence would be asserting the collation rather than the behaviour.
    expect(methods.map((row) => row.method).sort()).toEqual(["Cash", "Venmo"].sort());
  });

  it("keeps an UNRECOGNIZED payment method as the farmer's own words", async () => {
    // The closed set must not silently swallow a real fact. A farmer who barters says so.
    await saveOnboardingListing(database(), {
      farmId,
      standName: "Barter Stand",
      listing: {
        ...visitableListing,
        paymentMethods: ["venmo", "trade for eggs"],
      },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    const methods = await client()`
      select m.method from sales_location_payment_methods m
      join sales_locations l on l.id = m.sales_location_id
      where l.owner_farm_id = ${farmId}
    `;
    expect(methods.map((row) => row.method).sort()).toEqual(
      ["Venmo", "trade for eggs"].sort(),
    );
  });

  it("stores ONE row when a farmer states the same method two ways", async () => {
    // "cash" and "Cash" in the same submission. Without canonicalization these are two
    // distinct primary keys and both land, giving the map a stand that takes cash twice.
    await saveOnboardingListing(database(), {
      farmId,
      standName: "Double Cash Stand",
      listing: { ...visitableListing, paymentMethods: ["cash", "Cash", "CASH"] },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    const methods = await client()`
      select m.method from sales_location_payment_methods m
      join sales_locations l on l.id = m.sales_location_id
      where l.owner_farm_id = ${farmId}
    `;
    expect(methods.map((row) => row.method)).toEqual(["Cash"]);
  });

  it("drops blank items and blank payment methods rather than refusing the form", async () => {
    // An empty row in a repeating field is a farmer leaving a spare box alone, not an error
    // worth blocking their listing over. The database's not-blank CHECKs would otherwise
    // turn one stray space into a failed submission with nothing useful to say.
    const result = await saveOnboardingListing(database(), {
      farmId,
      standName: "Sparse Stand",
      listing: {
        ...visitableListing,
        paymentMethods: ["cash", "   ", ""],
        items: ["Eggs", "  ", ""],
      },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    expect(result.status).toBe("saved");
    const items = await client()`
      select item.display_name from stand_items item
      join sales_locations l on l.id = item.sales_location_id
      where l.owner_farm_id = ${farmId}
    `;
    expect(items.map((row) => row.display_name)).toEqual(["Eggs"]);
    const methods = await client()`
      select m.method from sales_location_payment_methods m
      join sales_locations l on l.id = m.sales_location_id
      where l.owner_farm_id = ${farmId}
    `;
    expect(methods.map((row) => row.method)).toEqual(["Cash"]);
  });

  it("stores a padded name and address trimmed, not as the farmer typed the padding", async () => {
    await saveOnboardingListing(database(), {
      farmId,
      standName: "  Padded Stand  ",
      listing: { ...visitableListing, publicAddress: "  9 Padded Way  " },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    const rows = await client()`
      select name, public_address from sales_locations where owner_farm_id = ${farmId}
    `;
    expect(rows[0]!.name).toBe("Padded Stand");
    expect(rows[0]!.public_address).toBe("9 Padded Way");
  });

  it("refuses a blank stand name instead of writing one the map cannot show", async () => {
    const result = await saveOnboardingListing(database(), {
      farmId,
      standName: "   ",
      listing: visitableListing,
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    expect(result.status).toBe("invalid_name");
    const rows = await client()`
      select id from sales_locations where owner_farm_id = ${farmId}
    `;
    expect(rows).toHaveLength(0);
  });

  it("refuses a pin that is not on Vashon", async () => {
    // The projection clamps a stray tap, but the writer is reachable by anything that can
    // POST. A coordinate in Seattle would put a pin outside the drawn island entirely, where
    // the artwork cannot show it — the seeder refuses out-of-range coordinates for the same
    // reason and this is the farmer-facing equivalent.
    const result = await saveOnboardingListing(database(), {
      farmId,
      standName: "Off Island Stand",
      listing: { ...visitableListing, latitude: 47.6062, longitude: -122.3321 },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    expect(result.status).toBe("off_island");
    const rows = await client()`
      select id from sales_locations where owner_farm_id = ${farmId}
    `;
    expect(rows).toHaveLength(0);
  });

  it("is idempotent — a resubmitted form updates one stand rather than making a second", async () => {
    // A farmer who reloads and submits again, or double-taps the button, must not end up
    // with two stands on the public map. The second submission is the farmer correcting
    // themselves, so it WINS rather than being discarded.
    const first = await saveOnboardingListing(database(), {
      farmId,
      standName: "Repeat Stand",
      listing: visitableListing,
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });
    const second = await saveOnboardingListing(database(), {
      farmId,
      standName: "Repeat Stand",
      listing: {
        ...visitableListing,
        hoursText: "Weekends only",
        items: ["Eggs", "rhubarb"],
        paymentMethods: ["cash"],
      },
      occurredAt: new Date("2026-08-05T18:00:00Z"),
    });

    expect(first.status).toBe("saved");
    expect(second.status).toBe("saved");

    const rows = await client()`
      select id, hours_text from sales_locations where owner_farm_id = ${farmId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hours_text).toBe("Weekends only");

    // The corrected mix replaces the old one: an item the farmer removed must stop being a
    // standing claim, or the form cannot be used to take something off the list.
    const items = await client()`
      select item.display_name, item.usually_carried from stand_items item
      join sales_locations l on l.id = item.sales_location_id
      where l.owner_farm_id = ${farmId}
      order by item.sort_order asc
    `;
    const carried = items.filter((row) => row.usually_carried === true);
    expect(carried.map((row) => row.display_name)).toEqual(["Eggs", "rhubarb"]);
    // "plant starts" survives as VOCABULARY but is no longer claimed — F-066's item
    // outlives its states, so a past confirmation of it keeps resolving.
    const droppedRows = items.filter((row) => row.display_name === "plant starts");
    expect(droppedRows).toHaveLength(1);
    expect(droppedRows[0]!.usually_carried).toBe(false);

    const methods = await client()`
      select m.method from sales_location_payment_methods m
      join sales_locations l on l.id = m.sales_location_id
      where l.owner_farm_id = ${farmId}
    `;
    expect(methods.map((row) => row.method)).toEqual(["Cash"]);
  });

  it("refuses an unknown farm rather than creating an orphan stand", async () => {
    const result = await saveOnboardingListing(database(), {
      farmId: randomUUID(),
      standName: "Ghost Stand",
      listing: visitableListing,
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    expect(result.status).toBe("unknown_farm");
  });

  it("leaves an EXISTING seeded stand alone rather than adding a second one", async () => {
    // A farmer invited against a farm VIGA already seeded has a stand already. The form is
    // then an EDIT of that listing, not a new stand beside it — otherwise the map shows the
    // same farm twice, once with the old CSV data and once with the farmer's own.
    const seeded = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farmId}, 'farm_stand', 'Seeded Stand', 'America/Los_Angeles',
        'visitable', 'produce', '1 Old Way', 47.40, -122.40, false, false
      ) returning id
    `;
    const seededId = seeded[0]?.id as string;

    await saveOnboardingListing(database(), {
      farmId,
      standName: "Seeded Stand",
      listing: { ...visitableListing, hoursText: "Corrected by the farmer" },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    const rows = await client()`
      select id, hours_text, public_address
      from sales_locations where owner_farm_id = ${farmId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(seededId);
    expect(rows[0]!.hours_text).toBe("Corrected by the farmer");
    expect(rows[0]!.public_address).toBe("12345 Vashon Highway SW");
  });

  it("keeps a farm's own stand separate from another farm's", async () => {
    // Two farmers onboarding at once must not write onto each other's listing. The scope is
    // the invitation's farm and nothing wider.
    const others = await client()`
      insert into farms (name) values (${`Other Farm ${randomUUID()}`}) returning id
    `;
    const otherFarmId = others[0]?.id as string;

    await saveOnboardingListing(database(), {
      farmId,
      standName: "Mine",
      listing: visitableListing,
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });
    await saveOnboardingListing(database(), {
      farmId: otherFarmId,
      standName: "Theirs",
      listing: { ...visitableListing, hoursText: "Different hours" },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });

    const mine = await client()`
      select name, hours_text from sales_locations where owner_farm_id = ${farmId}
    `;
    const theirs = await client()`
      select name, hours_text from sales_locations where owner_farm_id = ${otherFarmId}
    `;
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]!.name).toBe("Mine");
    expect(mine[0]!.hours_text).toBe("Daylight hours, most days");
    expect(theirs[0]!.name).toBe("Theirs");
    expect(theirs[0]!.hours_text).toBe("Different hours");
  });

  // ── F-068: the FILTERABLE availability columns ────────────────────────────────────────
  //
  // F-035 added season / hours / stocking columns and five CHECK constraints; until F-068 the
  // seeder was their only writer, so an onboarding farmer's listing was prose in `hours_text`
  // and NULL in every column a filter can use. These tests are here rather than only in
  // `listing-availability.test.ts` because ONLY REAL POSTGRES applies the constraints — the
  // in-memory mirror and the database can disagree, and that disagreement is the defect.

  describe("F-068 structured availability", () => {
    it("writes season, hours, days and stocking as FILTERABLE columns", async () => {
      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Filterable Stand",
        listing: {
          ...visitableListing,
          availability: {
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
          },
        },
        occurredAt: new Date("2026-08-05T17:00:00Z"),
      });
      expect(result.status).toBe("saved");

      const rows = await client()`
        select season_kind, season_start_month, season_start_day, season_end_month,
               season_end_day, open_hours_kind, open_days, stocking_cadence, stocking_days,
               hours_text
        from sales_locations where owner_farm_id = ${farmId}
      `;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // Asserted as VALUES, not merely as non-null: a writer that put the season in the hours
      // column would satisfy a null-check and be wrong.
      expect(row.season_kind).toBe("date_range");
      expect(row.season_start_month).toBe(3);
      expect(row.season_start_day).toBe(1);
      expect(row.season_end_month).toBe(11);
      expect(row.season_end_day).toBe(30);
      expect(row.open_hours_kind).toBe("dawn_to_dusk");
      expect(row.open_days).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(row.stocking_cadence).toBe("specific_days");
      expect(row.stocking_days).toEqual([3, 6]);
      // `hours_text` SURVIVES beside the structured columns. It is display-only and never
      // filtered on, because a caveat like "when available" fits in no day set.
      expect(row.hours_text).toBe("Daylight hours, most days");
    });

    it("writes clock times when the farmer states them, midnight included", async () => {
      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Clock Stand",
        listing: {
          ...visitableListing,
          availability: {
            ...NO_AVAILABILITY_STATED,
            openHoursKind: "clock_range",
            // Midnight to noon. 0 must survive as a stated time rather than being read as
            // absent — a truthiness check anywhere on this path turns it into NULL and the
            // `clock_range` constraint then refuses the row.
            openFromMinutes: 0,
            openUntilMinutes: 720,
          },
        },
        occurredAt: new Date("2026-08-05T17:00:00Z"),
      });
      expect(result.status).toBe("saved");

      const rows = await client()`
        select open_hours_kind, open_from_minutes, open_until_minutes
        from sales_locations where owner_farm_id = ${farmId}
      `;
      expect(rows[0]!.open_hours_kind).toBe("clock_range");
      expect(rows[0]!.open_from_minutes).toBe(0);
      expect(rows[0]!.open_until_minutes).toBe(720);
    });

    it("writes a named season as the farmer's own season words", async () => {
      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Named Season Stand",
        listing: {
          ...visitableListing,
          availability: {
            ...NO_AVAILABILITY_STATED,
            seasonKind: "named_season",
            seasonNames: ["berry season", "pumpkin season"],
          },
        },
        occurredAt: new Date("2026-08-05T17:00:00Z"),
      });
      expect(result.status).toBe("saved");

      const rows = await client()`
        select season_kind, season_names from sales_locations where owner_farm_id = ${farmId}
      `;
      expect(rows[0]!.season_kind).toBe("named_season");
      expect(rows[0]!.season_names).toEqual(["berry season", "pumpkin season"]);
    });

    it("leaves every availability column NULL when the farmer states nothing", async () => {
      // "Not stated" must stay distinguishable from `year_round` and from an empty day set.
      // A writer that defaulted anything here would invent a fact the farmer never gave.
      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Silent Stand",
        listing: visitableListing,
        occurredAt: new Date("2026-08-05T17:00:00Z"),
      });
      expect(result.status).toBe("saved");

      const rows = await client()`
        select season_kind, season_start_month, season_names, open_hours_kind,
               open_from_minutes, open_days, stocking_cadence, stocking_days
        from sales_locations where owner_farm_id = ${farmId}
      `;
      const row = rows[0]!;
      expect(row.season_kind).toBeNull();
      expect(row.season_start_month).toBeNull();
      expect(row.season_names).toBeNull();
      expect(row.open_hours_kind).toBeNull();
      expect(row.open_from_minutes).toBeNull();
      expect(row.open_days).toBeNull();
      expect(row.stocking_cadence).toBeNull();
      expect(row.stocking_days).toBeNull();
    });

    it("year_round is stored as a STATED fact, distinct from nothing stated", async () => {
      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Year Round Stand",
        listing: {
          ...visitableListing,
          availability: { ...NO_AVAILABILITY_STATED, seasonKind: "year_round" },
        },
        occurredAt: new Date("2026-08-05T17:00:00Z"),
      });
      expect(result.status).toBe("saved");

      const rows = await client()`
        select season_kind, season_start_month from sales_locations
        where owner_farm_id = ${farmId}
      `;
      expect(rows[0]!.season_kind).toBe("year_round");
      expect(rows[0]!.season_start_month).toBeNull();
    });

    it("REFUSES an incoherent availability instead of hitting a CHECK violation", async () => {
      // `clock_range` with no closing time. The constraint would refuse this write; the point
      // of the named status is that the farmer learns which answer to fix. If this ever throws
      // instead of returning, the in-memory mirror has drifted from the constraint.
      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Contradictory Stand",
        listing: {
          ...visitableListing,
          availability: {
            ...NO_AVAILABILITY_STATED,
            openHoursKind: "clock_range",
            openFromMinutes: 480,
          },
        },
        occurredAt: new Date("2026-08-05T17:00:00Z"),
      });

      expect(result.status).toBe("incoherent_availability");
      // Nothing was written — the refusal happens before the transaction opens.
      const rows = await client()`
        select id from sales_locations where owner_farm_id = ${farmId}
      `;
      expect(rows).toHaveLength(0);
    });

    it("REFUSES specific_days with no days, and an empty day set", async () => {
      const noDays = await saveOnboardingListing(database(), {
        farmId,
        standName: "Cadence Stand",
        listing: {
          ...visitableListing,
          availability: { ...NO_AVAILABILITY_STATED, stockingCadence: "specific_days" },
        },
        occurredAt: new Date("2026-08-05T17:00:00Z"),
      });
      expect(noDays.status).toBe("incoherent_availability");

      const emptyDays = await saveOnboardingListing(database(), {
        farmId,
        standName: "Empty Days Stand",
        listing: {
          ...visitableListing,
          availability: { ...NO_AVAILABILITY_STATED, openDays: [] },
        },
        occurredAt: new Date("2026-08-05T17:00:00Z"),
      });
      expect(emptyDays.status).toBe("incoherent_availability");
    });

    it("CLEARS availability a farmer retracts rather than leaving the old dates", async () => {
      // The resubmission case that a partial update would break: moving from "March-November"
      // to "year-round" must clear the four date columns, or the row violates
      // `coherentSeason` in the database and the farmer's correction is refused.
      await saveOnboardingListing(database(), {
        farmId,
        standName: "Changing Stand",
        listing: {
          ...visitableListing,
          availability: {
            ...NO_AVAILABILITY_STATED,
            seasonKind: "date_range",
            seasonStartMonth: 3,
            seasonStartDay: 1,
            seasonEndMonth: 11,
            seasonEndDay: 30,
            stockingCadence: "specific_days",
            stockingDays: [3],
          },
        },
        occurredAt: new Date("2026-08-05T17:00:00Z"),
      });

      const second = await saveOnboardingListing(database(), {
        farmId,
        standName: "Changing Stand",
        listing: {
          ...visitableListing,
          availability: { ...NO_AVAILABILITY_STATED, seasonKind: "year_round" },
        },
        occurredAt: new Date("2026-08-05T18:00:00Z"),
      });
      expect(second.status).toBe("saved");

      const rows = await client()`
        select season_kind, season_start_month, season_start_day, season_end_month,
               season_end_day, stocking_cadence, stocking_days
        from sales_locations where owner_farm_id = ${farmId}
      `;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.season_kind).toBe("year_round");
      expect(row.season_start_month).toBeNull();
      expect(row.season_start_day).toBeNull();
      expect(row.season_end_month).toBeNull();
      expect(row.season_end_day).toBeNull();
      // The retracted stocking cadence clears too, days included.
      expect(row.stocking_cadence).toBeNull();
      expect(row.stocking_days).toBeNull();
    });
  });
});
