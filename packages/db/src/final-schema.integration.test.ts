import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("B-032 final proposal and location schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let farmId = "";
  let contactHash = "";
  const closureOmissionHash = "4".repeat(64);
  const exactFlagsHash = "5".repeat(64);
  let locationId = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

    databaseName = `farm_friend_final_schema_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: migrationsDir });

    const sellers = await sql`insert into sellers (name) values ('B-032 Farm') returning id`;
    farmId = sellers[0]?.id as string;
    contactHash = "3".repeat(64);
    await sql`
      insert into contacts (phone_e164, phone_hash)
      values
        ('+12065550320', ${contactHash}),
        ('+12065550321', ${closureOmissionHash}),
        ('+12065550322', ${exactFlagsHash})
    `;
    const locations = await sql`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farmId}, 'farm_stand', 'B-032 Contact Stand', 'America/Los_Angeles',
        'contact_only', 'by_order', false, false
      ) returning id
    `;
    locationId = locations[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  function db(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  async function insertWithoutInventoryFlag(): Promise<unknown> {
    return db()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_closure, base_is_first_publication, closure_base_is_first_instruction
      ) values (
        ${contactHash}, ${locationId},
          (select id from stand_providers
            where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})), ${db().json({ closure: { result: "reopen" } })},
        1, true, true, true
      )
    `;
  }

  async function insertWithoutClosureFlag(): Promise<unknown> {
    return db()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, base_is_first_publication
      ) values (
        ${closureOmissionHash}, ${locationId},
          (select id from stand_providers
            where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})), ${db().json({ entries: [] })},
        1, true, true
      )
    `;
  }

  async function insertExactSectionFlags(): Promise<readonly unknown[]> {
    return db()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure, base_is_first_publication
      ) values (
        ${exactFlagsHash}, ${locationId},
          (select id from stand_providers
            where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})), ${db().json({ entries: [] })},
        1, true, false, true
      ) returning has_inventory, has_closure
    `;
  }

  it("requires every new sales location to state visitability", async () => {
    await expect(
      db()`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, offering_type,
          public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        ) values (
          ${farmId}, 'farm_stand', 'Missing Visitability', 'America/Los_Angeles', 'produce',
          '1 Explicit Way', 47.4, -122.4, false, false
        )
      `,
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("requires every new sales location to state offering type", async () => {
    await expect(
      db()`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability,
          public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        ) values (
          ${farmId}, 'farm_stand', 'Missing Offering Type', 'America/Los_Angeles', 'visitable',
          '2 Explicit Way', 47.4, -122.4, false, false
        )
      `,
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("requires every new proposal to state inventory section presence", async () => {
    await expect(insertWithoutInventoryFlag()).rejects.toMatchObject({ code: "23502" });
  });

  it("requires every new proposal to state closure section presence", async () => {
    await expect(insertWithoutClosureFlag()).rejects.toMatchObject({ code: "23502" });
  });

  it("stores exact section flags and rejects their decisive NULL cases", async () => {
    const rows = await insertExactSectionFlags();
    expect(rows).toEqual([{ has_inventory: true, has_closure: false }]);

    await expect(
      db()`
        update inventory_publication_proposals
        set has_inventory = null
        where sender_hash = ${exactFlagsHash}
      `,
    ).rejects.toMatchObject({ code: "23502" });
    await expect(
      db()`
        update inventory_publication_proposals
        set has_closure = null
        where sender_hash = ${exactFlagsHash}
      `,
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("removes proposal schema_version but preserves model-run schema telemetry", async () => {
    const rows = await db()`
      select table_name
      from information_schema.columns
      where column_name = 'schema_version'
        and table_name in ('inventory_publication_proposals', 'model_runs')
      order by table_name
    `;
    expect(rows).toEqual([{ table_name: "model_runs" }]);
  });

  it("removes proposal yes_token", async () => {
    const rows = await db()`
      select column_name from information_schema.columns
      where table_name = 'inventory_publication_proposals' and column_name = 'yes_token'
    `;
    expect(rows).toHaveLength(0);
  });

  it("removes proposal no_token and the obsolete distinct-token constraint", async () => {
    const rows = await db()`
      select column_name from information_schema.columns
      where table_name = 'inventory_publication_proposals' and column_name = 'no_token'
    `;
    expect(rows).toHaveLength(0);

    const constraints = await db()`
      select conname from pg_constraint
      where conrelid = 'inventory_publication_proposals'::regclass
        and conname = 'inventory_publication_proposals_distinct_tokens'
    `;
    expect(constraints).toHaveLength(0);
  });
});
