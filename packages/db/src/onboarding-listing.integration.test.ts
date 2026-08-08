import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NO_AVAILABILITY_STATED } from "./listing-availability";
import {
  readStandListing,
  renameFarm,
  saveOnboardingListing,
} from "./onboarding-listing";
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
// publishes on submit rather than waiting for the JOIN text.

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
    addressPublic: true,
    latitude: 47.4471,
    longitude: -122.4594,
    hoursText: "Daylight hours, most days",
    paymentMethods: ["cash", "Venmo"],
    items: [{ name: "Eggs", priceText: null }, { name: "plant starts", priceText: null }],
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
    // not held until the JOIN text arrives.
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
        addressPublic: true,
        latitude: null,
        longitude: null,
        hoursText: "By arrangement",
        paymentMethods: ["cash"],
        items: [{ name: "lamb", priceText: null }],
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
        addressPublic: true,
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

  it("stores an OPTIONAL price beside a standing item, in the farmer's own words", async () => {
    // F-090 — prices on the usual mix. Free text, exactly like `inventory_entries.price_text`:
    // a farmer writes what their sign says ("$6", "$4/dozen", "2 for $5"), and nothing here
    // parses it into a number. A currency type would force a shape the sign does not have and
    // would invite arithmetic across items, which is the commercial read max explicitly did
    // not want.
    //
    // Optional per item, never per stand: a farmer who prices eggs and not flowers is stating
    // exactly that, and a missing price is "not stated" rather than "free".
    await saveOnboardingListing(database(), {
      farmId,
      standName: "Priced Stand",
      listing: {
        ...visitableListing,
        items: [
          { name: "Eggs", priceText: "$6/dozen" },
          { name: "plant starts", priceText: null },
        ],
      },
      occurredAt: new Date("2026-08-08T17:00:00Z"),
    });

    const items = await client()`
      select item.display_name, item.price_text
      from stand_items item
      join sales_locations l on l.id = item.sales_location_id
      where l.owner_farm_id = ${farmId}
      order by item.sort_order asc
    `;
    expect(items.map((row) => row.display_name)).toEqual(["Eggs", "plant starts"]);
    // The VALUE, not merely that a column exists — verbatim, with its slash and its units.
    expect(items[0]!.price_text).toBe("$6/dozen");
    // Not stated is NULL, never "" — the two would read identically on a card and only one
    // of them is a fact the farmer asserted.
    expect(items[1]!.price_text).toBeNull();
  });

  it("CLEARS a price the farmer removed, rather than leaving the old one standing", async () => {
    // The whole-listing writer's rule applied to the newest column. `writeStandingItems`
    // upserts on the name index, so an item that already exists takes `do update` — and a
    // price omitted from that update would keep the stored one forever. A farmer who dropped
    // their price would keep publishing it with nothing on screen saying so.
    await saveOnboardingListing(database(), {
      farmId,
      standName: "Repricing Stand",
      listing: {
        ...visitableListing,
        items: [{ name: "Eggs", priceText: "$6/dozen" }],
      },
      occurredAt: new Date("2026-08-08T17:00:00Z"),
    });

    await saveOnboardingListing(database(), {
      farmId,
      standName: "Repricing Stand",
      listing: {
        ...visitableListing,
        items: [{ name: "Eggs", priceText: null }],
      },
      occurredAt: new Date("2026-08-08T18:00:00Z"),
    });

    const items = await client()`
      select item.price_text from stand_items item
      join sales_locations l on l.id = item.sales_location_id
      where l.owner_farm_id = ${farmId}
    `;
    expect(items).toHaveLength(1);
    expect(items[0]!.price_text).toBeNull();
  });

  it("round-trips a price through readStandListing, so an edit cannot erase it", async () => {
    // B-037's shape, one column newer. The edit form prefills from this reader and the writer
    // replaces every column on every save — so a price the reader cannot see is a price the
    // next otherwise-untouched save deletes, silently, with the writer doing exactly what it
    // says it does. That failure has now happened twice in this file's history; this is the
    // assertion that catches the third.
    await saveOnboardingListing(database(), {
      farmId,
      standName: "Round Trip Stand",
      listing: {
        ...visitableListing,
        items: [
          { name: "Eggs", priceText: "$6/dozen" },
          { name: "plant starts", priceText: null },
        ],
      },
      occurredAt: new Date("2026-08-08T17:00:00Z"),
    });

    const locations = await client()`
      select id from sales_locations where owner_farm_id = ${farmId}
    `;
    const salesLocationId = locations[0]!.id as string;

    const before = await readStandListing(database(), { salesLocationId });
    expect(before!.items).toEqual([
      { name: "Eggs", priceText: "$6/dozen" },
      { name: "plant starts", priceText: null },
    ]);

    // Save it straight back, untouched — the exact move a farmer makes when they open the form
    // to change their hours and submit.
    await saveOnboardingListing(database(), {
      farmId,
      standName: before!.standName,
      listing: { ...visitableListing, items: before!.items },
      occurredAt: new Date("2026-08-08T18:00:00Z"),
    });

    const after = await readStandListing(database(), { salesLocationId });
    expect(after!.items).toEqual(before!.items);
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
        items: [{ name: "tomato", priceText: null }, { name: "tomatoes", priceText: null }, { name: "love apple", priceText: null }],
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
      listing: { ...visitableListing, items: [{ name: "Eggs", priceText: null }, { name: "eggs", priceText: null }, { name: "  EGGS ", priceText: null }] },
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
    // F-069 changed this from "as stated": the farmer typed "cash" and the stored value is
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
        items: [{ name: "Eggs", priceText: null }, { name: "  ", priceText: null }, { name: "", priceText: null }],
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
        items: [{ name: "Eggs", priceText: null }, { name: "rhubarb", priceText: null }],
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

  it("B-037 — an edit that changes only hoursText preserves season, open days and restocking", async () => {
    // THE data-loss property, proved at the DB layer independently of React.
    //
    // `updateStand` names all twelve availability columns in one statement — correct, and what
    // lets a farmer move from "March-November" to "year-round" without leaving orphan dates.
    // The same property makes any caller that omits them a silent eraser. So the round trip a
    // farmer's edit actually performs is asserted here directly: READ the listing, change one
    // unrelated field, WRITE it back, and read again.
    //
    // A form that dropped availability would still produce `status: "saved"` and a correct
    // `hours_text`. Only comparing the availability across the round trip catches it.
    const stated = {
      seasonKind: "date_range" as const,
      seasonStartMonth: 3,
      seasonStartDay: 1,
      seasonEndMonth: 11,
      seasonEndDay: 30,
      seasonNames: null,
      openHoursKind: "clock_range" as const,
      // Midnight, deliberately: 0 is a real stated time, and a `|| null` anywhere on the read
      // path would turn it into "not stated" and drop it on the next save.
      openFromMinutes: 0,
      openUntilMinutes: 1080,
      openDays: [0, 6],
      stockingCadence: "specific_days" as const,
      stockingDays: [2, 5],
    };

    const created = await saveOnboardingListing(database(), {
      farmId,
      standName: "Seasonal Stand",
      listing: { ...visitableListing, availability: stated },
      occurredAt: new Date("2026-08-05T17:00:00Z"),
    });
    expect(created.status).toBe("saved");
    const salesLocationId = (created as { salesLocationId: string }).salesLocationId;

    // What the edit form is prefilled from.
    const before = await readStandListing(database(), { salesLocationId });
    expect(before?.availability).toEqual(stated);

    // The edit: the farmer changes their hours text, writing back for everything else exactly
    // what the read gave them — except ONE restocking day, deliberately.
    //
    // Without that one change this test passes for the wrong reason. Omitting `stocking_days`
    // from `updateStand`'s SET clause leaves the column holding what the INSERT already put
    // there, so "the update preserved it" and "the update never wrote it" are the same
    // observation. Moving a day makes them different: a write that skips the column now leaves
    // the OLD set behind, and this fails. Confirmed by sabotage.
    const editedAvailability = { ...before!.availability, stockingDays: [2, 4] };
    const edited = await saveOnboardingListing(database(), {
      farmId,
      standName: before!.standName,
      listing: {
        visitability: before!.visitability,
        offeringType: before!.offeringType,
        publicAddress: before!.publicAddress,
        addressPublic: true,
        latitude: before!.latitude,
        longitude: before!.longitude,
        hoursText: "Weekends when available",
        availability: editedAvailability,
        paymentMethods: before!.paymentMethods,
        items: before!.items,
      },
      occurredAt: new Date("2026-08-05T18:00:00Z"),
    });
    expect(edited.status).toBe("saved");

    // Read from the COLUMNS, not from the reader, so a reader that lied in both directions
    // could not make this pass.
    const rows = await client()`
      select hours_text, season_kind, season_start_month, season_start_day,
             season_end_month, season_end_day, season_names,
             open_hours_kind, open_from_minutes, open_until_minutes, open_days,
             stocking_cadence, stocking_days
      from sales_locations where id = ${salesLocationId}
    `;
    const stand = rows[0]!;
    expect(stand.hours_text).toBe("Weekends when available");
    expect(stand.season_kind).toBe("date_range");
    expect(stand.season_start_month).toBe(3);
    expect(stand.season_start_day).toBe(1);
    expect(stand.season_end_month).toBe(11);
    expect(stand.season_end_day).toBe(30);
    expect(stand.open_hours_kind).toBe("clock_range");
    expect(stand.open_from_minutes).toBe(0);
    expect(stand.open_until_minutes).toBe(1080);
    expect(stand.open_days).toEqual([0, 6]);
    expect(stand.stocking_cadence).toBe("specific_days");
    // The one field the edit CHANGED — see the note above on why it has to change.
    expect(stand.stocking_days).toEqual([2, 4]);
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

  // ── F-069: the FILTERABLE availability columns ────────────────────────────────────────
  //
  // F-035 added season / hours / stocking columns and five CHECK constraints; until F-069 the
  // seeder was their only writer, so an onboarding farmer's listing was prose in `hours_text`
  // and NULL in every column a filter can use. These tests are here rather than only in
  // `listing-availability.test.ts` because ONLY REAL POSTGRES applies the constraints — the
  // in-memory mirror and the database can disagree, and that disagreement is the defect.

  describe("F-069 structured availability", () => {
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

  // A farm's name is public on the map beside its stand, and until now nothing could change
  // it — not the farmer, not an administrator. It was written once when the invitation was
  // created and was permanent, so a typo made at invitation time was a typo the island saw
  // forever. The farmer owns their published state (Golden Rule #1), so the farmer is who
  // gets to correct it.
  describe("renaming a farm", () => {
    it("renames the farm a stand belongs to", async () => {
      const result = await renameFarm(database(), {
        farmId,
        name: "Misty Hollow Farm",
      });

      expect(result.status).toBe("saved");
      const rows = await client()`select name from farms where id = ${farmId}`;
      expect(rows[0]?.name).toBe("Misty Hollow Farm");
    });

    it("trims a padded name rather than publishing the whitespace", async () => {
      await renameFarm(database(), { farmId, name: "  Padded Farm  " });

      const rows = await client()`select name from farms where id = ${farmId}`;
      expect(rows[0]?.name).toBe("Padded Farm");
    });

    it("refuses a blank name instead of erasing the farm's identity on the map", async () => {
      const before = await client()`select name from farms where id = ${farmId}`;

      const result = await renameFarm(database(), { farmId, name: "   " });

      expect(result.status).toBe("invalid_name");
      // Refusal means UNCHANGED, not "changed to something else".
      const after = await client()`select name from farms where id = ${farmId}`;
      expect(after[0]?.name).toBe(before[0]?.name);
    });

    it("reads the farm's own name back, distinctly from the stand's", async () => {
      // The two are separate records and the editor must prefill each from its own source.
      // Reading the stand name into a "farm name" box is how the conflation started.
      await renameFarm(database(), { farmId, name: "Two Sisters Farm" });
      await saveOnboardingListing(database(), {
        farmId,
        standName: "The Red Shed",
        listing: visitableListing,
        occurredAt: new Date("2026-08-06T17:00:00Z"),
      });

      const locations = await client()`
        select id from sales_locations where owner_farm_id = ${farmId}
      `;
      const listing = await readStandListing(database(), {
        salesLocationId: locations[0]?.id as string,
      });

      expect(listing?.standName).toBe("The Red Shed");
      expect(listing?.farmName).toBe("Two Sisters Farm");
    });

    it("reports an unknown farm rather than silently writing nothing", async () => {
      const result = await renameFarm(database(), {
        farmId: randomUUID(),
        name: "Ghost Farm",
      });

      // A rename that matched no row must not read as success — the caller would tell a
      // farmer their farm was renamed when nothing happened.
      expect(result.status).toBe("unknown_farm");
    });
  });

  // F-081 — the default reminder schedule.
  //
  // F-052 built the scheduled-prompt machinery and it is correct. It reached NOBODY:
  // `inventory_prompt_preferences` had exactly one writer, `setInventoryPromptPreference`,
  // and the only paths to it are the farmer settings surfaces. No onboarding door wrote a
  // row, so `runScheduledPromptPass` selected against an empty table for every farmer who
  // never went looking for a setting they had no reason to know existed — the stale-map
  // failure this product exists to solve, one layer down.
  //
  // The seed lives HERE rather than in the authorization doors, and the schema is what
  // decided that: a preference carries composite foreign keys to BOTH `sales_locations` and
  // `farmer_authorizations`, so the row is structurally impossible before a stand exists.
  // `authorizeFarmer` and the invited redemption both run before any stand does. Every
  // listing door already converges on `saveOnboardingListing`, so one write site covers the
  // invited, grandfathered, edit, and F-079 migration paths — and a fifth door added later
  // inherits the default rather than having to remember it.
  //
  // max chose WEEKLY (2026-08-07): it matches the rhythm VIGA's farmers already know, since
  // the Google form this replaces was a weekly status form.
  describe("F-081 default reminder schedule", () => {
    let authorizationId = "";

    beforeEach(async () => {
      // A live farmer for the fresh farm — the preference's designated recipient, and what
      // the composite foreign key requires be a farmer OF THIS FARM.
      // A distinct number per test, so one test's contact cannot satisfy another's lookup.
      const suffix = String(Math.floor(Math.random() * 9000) + 1000);
      const contacts = await client()`
        insert into contacts (phone_e164, phone_hash)
        values (
          ${`+1206555${suffix}`},
          ${randomUUID().replaceAll("-", "").repeat(2).slice(0, 64)}
        )
        returning id
      `;
      const authorizations = await client()`
        insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
        values (
          ${farmId}, ${contacts[0]?.id as string},
          ${new Date("2026-08-07T12:00:00Z")}, ${new Date("2026-08-07T12:00:00Z")}
        )
        returning id
      `;
      authorizationId = authorizations[0]?.id as string;
    });

    it("puts a publishing farmer on a WEEKLY schedule without them visiting settings", async () => {
      // Published at 15:30 PDT — deliberately NOT 10:00 local. A sabotage proved why: with a
      // 10:00-local publication time, "seven days later at the same clock time" and "10:00
      // local on the seventh day" are the SAME INSTANT, so a hand-computed date passed this
      // assertion and the schedule rule was never actually under test. Off-slot publication
      // is what makes the two disagree.
      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Weekly Stand",
        listing: visitableListing,
        authorizationId,
        occurredAt: new Date("2026-08-07T22:30:00Z"),
      });
      expect(result.status).toBe("saved");

      const rows = await client()`
        select preference.cadence, preference.version, preference.next_due_at,
               preference.last_due_slot_at, preference.designated_authorization_id,
               preference.owner_farm_id
        from inventory_prompt_preferences as preference
        join sales_locations as location on location.id = preference.sales_location_id
        where location.owner_farm_id = ${farmId}
      `;

      expect(rows).toHaveLength(1);
      const preference = rows[0]!;
      expect(preference.cadence).toBe("weekly");
      expect(preference.version).toBe(1);
      expect(preference.designated_authorization_id).toBe(authorizationId);
      expect(preference.owner_farm_id).toBe(farmId);
      // Nothing has been prompted yet, so there is no previous slot to have ordered against.
      expect(preference.last_due_slot_at).toBeNull();

      // The due slot is a VALUE, not merely "not null" — 10:00 LOCAL on the seventh day
      // after publication, which is `nextPromptDueSlot`'s rule. 2026-08-14 10:00 PDT is
      // 17:00Z. Since publication was at 22:30Z, a hand-rolled "+7 days" would land at
      // 22:30Z and fail here — which is the whole point of asserting the instant rather
      // than that the column is populated.
      expect((preference.next_due_at as Date).toISOString()).toBe("2026-08-14T17:00:00.000Z");
    });

    it("never overwrites a cadence the farmer already chose", async () => {
      // The farmer publishes, then deliberately PAUSES — the one choice a default must never
      // undo. Editing their listing afterwards is the ordinary case, and it must not put them
      // back on weekly texts they explicitly turned off.
      await saveOnboardingListing(database(), {
        farmId,
        standName: "Paused Stand",
        listing: visitableListing,
        authorizationId,
        occurredAt: new Date("2026-08-07T17:00:00Z"),
      });

      const locations = await client()`
        select id from sales_locations where owner_farm_id = ${farmId}
      `;
      const salesLocationId = locations[0]?.id as string;
      await client()`
        update inventory_prompt_preferences
        set cadence = 'paused', next_due_at = null, version = version + 1
        where sales_location_id = ${salesLocationId}
      `;

      await saveOnboardingListing(database(), {
        farmId,
        standName: "Paused Stand Edited",
        listing: { ...visitableListing, hoursText: "Weekends only" },
        authorizationId,
        occurredAt: new Date("2026-08-09T17:00:00Z"),
      });

      const rows = await client()`
        select cadence, next_due_at from inventory_prompt_preferences
        where sales_location_id = ${salesLocationId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cadence).toBe("paused");
      expect(rows[0]?.next_due_at).toBeNull();
    });

    it("seeds nothing for a REVOKED authorization", async () => {
      // A revoked farmer must not be scheduled for texts. Found by sabotage: deleting the
      // validity check left every assertion green, because nothing exercised an
      // authorization that was not live.
      await client()`
        update farmer_authorizations
        set revoked_at = ${new Date("2026-08-07T13:00:00Z")}
        where id = ${authorizationId}
      `;

      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Revoked Stand",
        listing: visitableListing,
        authorizationId,
        occurredAt: new Date("2026-08-07T22:30:00Z"),
      });

      // The listing still publishes — revocation stops the schedule, not the stand.
      expect(result.status).toBe("saved");
      const rows = await client()`
        select preference.id from inventory_prompt_preferences as preference
        join sales_locations as location on location.id = preference.sales_location_id
        where location.owner_farm_id = ${farmId}
      `;
      expect(rows).toHaveLength(0);
    });

    it("seeds nothing for an authorization belonging to ANOTHER farm", async () => {
      // The cross-farm write vector: a door passing a caller-supplied authorization must not
      // make a farmer of farm A the prompt recipient for farm B's stand.
      const otherFarms = await client()`
        insert into farms (name) values (${`Other Farm ${randomUUID()}`}) returning id
      `;
      const otherContacts = await client()`
        insert into contacts (phone_e164, phone_hash)
        values (
          ${`+1206555${String(Math.floor(Math.random() * 9000) + 1000)}`},
          ${randomUUID().replaceAll("-", "").repeat(2).slice(0, 64)}
        )
        returning id
      `;
      const foreign = await client()`
        insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
        values (
          ${otherFarms[0]?.id as string}, ${otherContacts[0]?.id as string},
          ${new Date("2026-08-07T12:00:00Z")}, ${new Date("2026-08-07T12:00:00Z")}
        )
        returning id
      `;

      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Cross Farm Stand",
        listing: visitableListing,
        authorizationId: foreign[0]?.id as string,
        occurredAt: new Date("2026-08-07T22:30:00Z"),
      });

      expect(result.status).toBe("saved");
      const rows = await client()`
        select preference.id from inventory_prompt_preferences as preference
        join sales_locations as location on location.id = preference.sales_location_id
        where location.owner_farm_id = ${farmId}
      `;
      expect(rows).toHaveLength(0);
    });

    it("seeds nothing when no authorization is known, rather than guessing one", async () => {
      // The grandfathered door publishes a listing for a farm that has no farmer yet. A
      // preference needs a designated recipient, and inventing one would text a farmer who
      // was never set up. Publishing must still succeed — the listing is the point.
      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Unclaimed Stand",
        listing: visitableListing,
        authorizationId: null,
        occurredAt: new Date("2026-08-07T17:00:00Z"),
      });

      expect(result.status).toBe("saved");
      const rows = await client()`
        select preference.id from inventory_prompt_preferences as preference
        join sales_locations as location on location.id = preference.sales_location_id
        where location.owner_farm_id = ${farmId}
      `;
      expect(rows).toHaveLength(0);
    });
  });

  describe("the farm's own prose", () => {
    // `farms.description` renders on the public stand card under "Additional information", is
    // seeded from VIGA's forms, and — until now — had NO farmer-facing writer at all. The
    // consequence measured on production: a farmer publishes a clean listing through this form
    // and VIGA's older prose stays welded to their card underneath it, sometimes contradicting
    // what they just typed, with no surface anywhere that can change it.
    //
    // It is the FARM's record, not the stand's, which is why it sits beside `renameFarm` in
    // shape: a farm may have more than one stand, and the prose describes the farm.

    it("writes the description the farmer typed", async () => {
      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Prose Stand",
        listing: {
          ...visitableListing,
          description: "We place a sign at the bottom of the driveway when the stand is open.",
        },
        occurredAt: new Date("2026-08-07T17:00:00Z"),
      });
      expect(result.status).toBe("saved");

      const rows = await client()`select description from farms where id = ${farmId}`;
      expect(rows[0]?.description).toBe(
        "We place a sign at the bottom of the driveway when the stand is open.",
      );
    });

    it("CLEARS the description when the farmer empties the box", async () => {
      // The farmer owns published state (Golden Rule #1). Someone who deletes VIGA's stale
      // paragraph and publishes must end up with no paragraph — an empty box that silently
      // kept the old text would make the form lie about what it publishes.
      await client()`
        update farms set description = ${"Stale VIGA prose about this farm."} where id = ${farmId}
      `;

      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Prose Stand",
        listing: { ...visitableListing, description: "   " },
        occurredAt: new Date("2026-08-07T17:00:00Z"),
      });
      expect(result.status).toBe("saved");

      const rows = await client()`select description from farms where id = ${farmId}`;
      expect(rows[0]?.description).toBeNull();
    });

    it("LEAVES an existing description alone when the door states none", async () => {
      // The distinction the whole write turns on: `undefined` means "this door has nothing to
      // say about the prose", `""` means "the farmer cleared it". A door that omits the field
      // must not erase a farm's paragraph as a side effect of saving its hours — that is
      // B-037's exact failure shape, one column over.
      await client()`
        update farms set description = ${"A land acknowledgement and a note about the goats."}
        where id = ${farmId}
      `;

      const result = await saveOnboardingListing(database(), {
        farmId,
        standName: "Prose Stand",
        listing: visitableListing,
        occurredAt: new Date("2026-08-07T17:00:00Z"),
      });
      expect(result.status).toBe("saved");

      const rows = await client()`select description from farms where id = ${farmId}`;
      expect(rows[0]?.description).toBe("A land acknowledgement and a note about the goats.");
    });

    it("round-trips through readStandListing unchanged", async () => {
      // The property that makes the edit form safe to prefill. `saveOnboardingListing` replaces
      // the whole listing, so the read and the write must be the same shape — a description the
      // reader could not see would be erased by the next save of an untouched form.
      const saved = await saveOnboardingListing(database(), {
        farmId,
        standName: "Prose Stand",
        listing: { ...visitableListing, description: "Certified organic. Goats on site." },
        occurredAt: new Date("2026-08-07T17:00:00Z"),
      });
      expect(saved.status).toBe("saved");
      const salesLocationId = (saved as { salesLocationId: string }).salesLocationId;

      const listing = await readStandListing(database(), { salesLocationId });
      expect(listing?.description).toBe("Certified organic. Goats on site.");

      // Save it straight back, field for field, and nothing may change.
      const again = await saveOnboardingListing(database(), {
        farmId,
        standName: listing!.standName,
        listing: {
          visitability: listing!.visitability,
          offeringType: listing!.offeringType,
          publicAddress: listing!.publicAddress,
          addressPublic: true,
          latitude: listing!.latitude,
          longitude: listing!.longitude,
          hoursText: listing!.hoursText,
          availability: listing!.availability,
          paymentMethods: listing!.paymentMethods,
          items: listing!.items,
          description: listing!.description,
        },
        occurredAt: new Date("2026-08-07T18:00:00Z"),
      });
      expect(again.status).toBe("saved");

      const rows = await client()`select description from farms where id = ${farmId}`;
      expect(rows[0]?.description).toBe("Certified organic. Goats on site.");
    });
  });
});
