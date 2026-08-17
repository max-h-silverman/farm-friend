import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listStandsForAdministration } from "./admin";
import type { Db } from "./index";
import type { Sql } from "./sql";

/*
  B-074 — the VIGA admin roster actually returns a stand's current inventory.

  THE GAP THIS CLOSES. `listStandsForAdministration` is the ONE read behind both admin refresh
  surfaces — the sellers page and `/api/admin/stands`. Its `currentItems` column had exactly one
  assertion in the whole suite, and that assertion was `currentItems: []` on a stand that had
  never published. It would have stayed green if the column returned an empty array for every
  stand in the corpus, which is precisely the regression B-074's edit to this query could cause:
  the statement moved from a tagged template to `.unsafe()` so it could compose the shared join,
  and in a tagged template that interpolation would have become a bind parameter.

  A populated assertion is the only thing that can tell those two outcomes apart.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("B-074 admin roster current inventory (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let standId = "";
  let unpublishedStandId = "";
  /** A stand with TWO publishing sellers (F-114 C.5). */
  let sharedStandId = "";

  const handle = (): Db => {
    if (!sql) throw new Error("database not initialized");
    return { sql, orm: undefined as never, close: async () => {} };
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_roster_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 5 });

    const db = sql;
    const sellers = await db`insert into sellers (name) values ('Roster Farm') returning id`;
    const farmId = sellers[0]?.id as string;

    const mkStand = async (name: string): Promise<string> => {
      const rows = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          ${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          ${`${name} Road`}, 47.4473, -122.4590
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    standId = await mkStand("Published Stand");
    unpublishedStandId = await mkStand("Silent Stand");

    // A superseded revision whose items must NOT reach the operator's roster, and a current one
    // whose items must.
    const old = await db`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, source, published_at, is_current, superseded_at
      ) values (
        ${farmId}, ${standId},
        (select id from stand_providers
          where sales_location_id = ${standId} and seller_id = (select own_seller_id from sales_locations where id = ${standId})), 'viga', now() - interval '9 days', false, now() - interval '1 day'
      ) returning id
    `;
    await db`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, sort_order
      ) values (${old[0]?.id as string}, ${standId}, 'WITHDRAWN CHARD', 0)
    `;

    const current = await db`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, source, published_at, is_current
      ) values (
        ${farmId}, ${standId},
        (select id from stand_providers
          where sales_location_id = ${standId} and seller_id = (select own_seller_id from sales_locations where id = ${standId})), 'viga', now() - interval '3 hours', true
      ) returning id
    `;
    await db`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, quantity, unit,
        price_text, approximation, sort_order
      ) values
        (${current[0]?.id as string}, ${standId}, 'Rhubarb', 4, 'bunch', '$5', 'some', 0),
        (${current[0]?.id as string}, ${standId}, 'Plums', null, null, null, null, 1)
    `;
    // A stand with TWO publishing sellers — the shape the roster's stand-keyed join fans out.
    const guestSellers = await db`
      insert into sellers (name) values ('Roster Guest') returning id
    `;
    const guestSellerId = guestSellers[0]?.id as string;
    sharedStandId = await mkStand("Shared Stand");
    const hostProviders = await db`
      select id from stand_providers
      where sales_location_id = ${sharedStandId} and seller_id = ${farmId}
    `;
    const guestProviders = await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${sharedStandId}, ${guestSellerId}, 'active', false,
        now() - interval '9 days', now() - interval '9 days', 'viga', now() - interval '9 days'
      ) returning id
    `;
    for (const [providerId, sellerId, itemName] of [
      [hostProviders[0]?.id as string, farmId, "Host Venison"],
      [guestProviders[0]?.id as string, guestSellerId, "Guest Greens"],
    ] as const) {
      const revision = await db`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, source, published_at, is_current
        ) values (
          ${sellerId}, ${sharedStandId}, ${providerId}, 'viga', now() - interval '2 hours', true
        ) returning id
      `;
      await db`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        ) values (${revision[0]?.id as string}, ${sharedStandId}, ${itemName}, 0)
      `;
    }
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("returns the published stand's current items with every column populated", async () => {
    const rows = await listStandsForAdministration(handle());
    const stand = rows.find((row) => row.standId === standId);
    expect(stand).toBeDefined();
    // VALUES, not shape. An assertion that only counted items would survive the column
    // returning the wrong revision's rows.
    expect(stand?.currentItems).toEqual([
      {
        itemName: "Rhubarb",
        quantity: 4,
        unit: "bunch",
        priceText: "$5",
        approximation: "some",
      },
      {
        itemName: "Plums",
        quantity: null,
        unit: null,
        priceText: null,
        approximation: null,
      },
    ]);
  });

  it("never shows the operator a superseded revision's items", async () => {
    const rows = await listStandsForAdministration(handle());
    const stand = rows.find((row) => row.standId === standId);
    expect(stand?.currentItems.map((item) => item.itemName)).not.toContain(
      "WITHDRAWN CHARD",
    );
  });

  it("lists a stand with two publishing sellers ONCE, with both sellers' items", async () => {
    /*
      F-114 C.5 — the operator's roster is one row per STAND, not per seller.

      The roster left-joins the current revision on the stand, which after Phase B matches one
      row per SELLER: a two-seller stand appeared TWICE, each row carrying only that seller's
      items. Measured against a real database before this was written — two rows, split items.
      VIGA reads this screen to decide what to fix, and a stand listed twice with half its
      inventory each time is a screen that invents work.

      Both halves are asserted: ONE row (a reader that still fans out fails the length), and the
      UNION of what both sellers published (a reader that de-duplicated by picking one revision
      fails the items).
    */
    const rows = await listStandsForAdministration(handle());
    const shared = rows.filter((row) => row.standId === sharedStandId);

    expect(shared).toHaveLength(1);
    expect(shared[0]?.currentItems.map((item) => item.itemName).sort()).toEqual([
      "Guest Greens",
      "Host Venison",
    ]);
  });

  it("keeps a never-published stand in the roster with no items", async () => {
    // The LEFT join is what makes this true, and it is the half of the change that a query
    // silently returning nothing would also satisfy — so it is asserted alongside the populated
    // case above, never alone.
    const rows = await listStandsForAdministration(handle());
    const silent = rows.find((row) => row.standId === unpublishedStandId);
    expect(silent).toBeDefined();
    expect(silent?.currentItems).toEqual([]);
    expect(rows).toHaveLength(3);
  });
});
