import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprintDatabase, requireExpectedDatabase } from "./ingest-guard";
import type { Sql } from "./sql";

// F-064 — the guard that stands between an operator and the wrong database.
//
// THE FAILURE THIS EXISTS FOR: a bulk write aimed at a staging database that lands in production,
// because `DATABASE_URL` was one shell away from what the operator believed. A database "assumed
// empty" has held real user data more than once. Naming the target is not enough — an operator
// reads `neondb` and sees what they expected to see — so the fingerprint reports what is ACTUALLY
// in there, and the caller states in advance what it expects to find.
//
// It fails CLOSED: anything unexpected aborts before a single row is written.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-064 ingest guard (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_ingest_guard_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 1 });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  it("reports what is actually in the database, not what was asked for", async () => {
    const fingerprint = await fingerprintDatabase(client());

    expect(fingerprint.databaseName).toBe(databaseName);
    expect(fingerprint.migrationsApplied).toBeGreaterThan(0);
    // A freshly migrated database is empty. These counts are the whole point: an operator who
    // believes they are seeding an empty database can see that it holds 35 farms.
    expect(fingerprint.farms).toBe(0);
    expect(fingerprint.salesLocations).toBe(0);
    expect(fingerprint.inventoryRevisions).toBe(0);
  });

  it("counts real rows once they exist", async () => {
    const farms = await client()`insert into farms (name) values ('Guard Farm') returning id`;
    await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farms[0]?.id as string}, 'farm_stand', 'Guard Stand', 'America/Los_Angeles',
        'visitable', 'produce', '1 Guard Way', 47.4, -122.4, false, false
      )
    `;

    const fingerprint = await fingerprintDatabase(client());
    expect(fingerprint.farms).toBe(1);
    expect(fingerprint.salesLocations).toBe(1);
  });

  describe("requireExpectedDatabase fails closed", () => {
    it("passes when the database is the one named", async () => {
      await expect(
        requireExpectedDatabase(client(), { databaseName }),
      ).resolves.toBeDefined();
    });

    it("REFUSES a database whose name is not the one expected", async () => {
      // The mistyped-connection-string case, stated as a test. This is the assertion that turns
      // a silent write-to-production into an abort.
      await expect(
        requireExpectedDatabase(client(), { databaseName: "some_other_database" }),
      ).rejects.toThrow(/some_other_database/);
    });

    it("REFUSES when the caller expected an empty database and it is not", async () => {
      // "Assumed empty" is the assumption that has cost real data. The caller states it, and the
      // guard checks it against the rows actually present.
      await expect(
        requireExpectedDatabase(client(), { databaseName, expectEmpty: true }),
      ).rejects.toThrow(/not empty/i);
    });

    it("names what it found, so the operator can tell which database they hit", async () => {
      // An error reading "wrong database" sends an operator hunting. One naming the database and
      // its row counts tells them immediately whether they are pointed at production.
      await expect(
        requireExpectedDatabase(client(), { databaseName: "expected_elsewhere" }),
      ).rejects.toThrow(new RegExp(databaseName));
    });
  });
});
