import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-117 — `0052` ADDS `stand_provider_approval_source = 'seller'`, AGAINST A POPULATED SCHEMA.

  ## Why this file exists for a one-line migration

  `ALTER TYPE … ADD VALUE` is the migration most likely to be waved through, and two of its
  properties are worth proving rather than assuming:

  1. **It must not disturb the rows already carrying the two existing values.** An enum rewrite
     that reordered or renumbered would silently change what `viga` and `host` rows say — and
     every liveness predicate and admin view reads them.
  2. **The value must actually be USABLE afterwards.** Postgres refuses a newly added enum value
     in the same transaction that added it. Drizzle's migrator runs migrations in a transaction,
     so a migration that appears to apply can leave a value nothing may insert — which would fail
     only later, in production, at the first self-selecting seller.

  The second is the real hazard and is asserted by INSERTING a row that uses the value, in a
  separate statement after the migration has been applied. That is verification by effect: the
  migration reporting success proves nothing about whether the value can be written.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/* Ordered BEFORE `0052`, never "everything that is not `0052`". */
const beforeThisWork = migrationFiles.filter((name) => name < "0052_");
const thisWork = migrationFiles.filter((name) => name.startsWith("0052_"));

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-117 the self-selected approval source migrates onto live data (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let hostSellerId = "";
  let guestSellerId = "";
  let standLocationId = "";
  let vigaProviderId = "";
  /* A seller with no arrangement of its own yet — the stand's own seller already has one, and
     `stand_providers_one_per_seller_per_location` is what says so. */
  let thirdSellerId = "";

  const T0 = new Date("2026-06-01T17:00:00.000Z");

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    if (thisWork.length !== 1) {
      throw new Error(`expected exactly one 0052 migration, found ${thisWork.length}`);
    }
    databaseName = `ff_selfselectmig_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 5 });

    // The schema as production has it: everything BEFORE this work, and nothing of it.
    for (const file of beforeThisWork) await applyFile(client(), file);

    // Live data of the kind `stand_providers` actually holds — one row per existing source.
    const hosts = await client()`insert into sellers (name) values ('Kelseys Farm') returning id`;
    hostSellerId = hosts[0]?.id as string;
    const guests = await client()`insert into sellers (name) values ('Gracies Greens') returning id`;
    guestSellerId = guests[0]?.id as string;
    const thirds = await client()`insert into sellers (name) values ('Fernhorn Bakery') returning id`;
    thirdSellerId = thirds[0]?.id as string;
    const stands = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Kelseys Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        '1 Kelsey Road', 47.4473, -122.4590
      ) returning id
    `;
    standLocationId = stands[0]?.id as string;

    const viga = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standLocationId}, ${guestSellerId}, 'active',
        ${T0}, ${T0}, 'viga', ${T0}
      ) returning id
    `;
    vigaProviderId = viga[0]?.id as string;

    // The migration under test.
    for (const file of thisWork) await applyFile(client(), file);
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  it("leaves the rows that were already there saying exactly what they said", async () => {
    const rows = await client()`
      select approval_source, lifecycle_state from stand_providers where id = ${vigaProviderId}
    `;
    expect(rows[0]?.approval_source).toBe("viga");
    expect(rows[0]?.lifecycle_state).toBe("active");
  });

  it("admits a row carrying the new value — proved by writing one, not by the migration's exit", async () => {
    /*
      THE ONE THAT MATTERS. Postgres refuses a newly added enum value inside the transaction that
      added it, so a migration can apply cleanly and still leave a value nothing may insert. A
      test that only ran the migration would be green against exactly that failure.

      Written in its own statement after the migration, which is the shape production has.
    */
    const inserted = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standLocationId}, ${thirdSellerId}, 'active',
        ${T0}, ${T0}, 'seller', ${T0}
      ) returning id, approval_source
    `;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.approval_source).toBe("seller");
  });

  it("keeps `approval_source_coherent` refusing a vouching actor the new value never has", async () => {
    /*
      The constraint predates this value and is stated as a biconditional on `host`. A `seller`
      row naming a vouching authorization would claim a host vouched for a seller nobody
      vouched for — asserted here because adding an enum value silently widens what every
      constraint mentioning that column admits.
    */
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550199', ${`h${randomUUID().replaceAll("-", "")}`}, ${T0}) returning id
    `;
    const authorizations = await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${hostSellerId}, ${contacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    const otherStand = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Second Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        '2 Kelsey Road', 47.4474, -122.4591
      ) returning id
    `;

    await expect(
      client()`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state,
          invited_at, accepted_at, approval_source, approved_at,
          approved_by_authorization_id
        ) values (
          ${otherStand[0]?.id as string}, ${guestSellerId}, 'active',
          ${T0}, ${T0}, 'seller', ${T0}, ${authorizations[0]?.id as string}
        )
      `,
    ).rejects.toThrow(/approval_source_coherent/);
  });
});
