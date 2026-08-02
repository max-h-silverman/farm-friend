import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-050 forward migration from populated pre-change schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let preChangeMigrations = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

    databaseName = `farm_friend_participant_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    preChangeMigrations = mkdtempSync(resolve(tmpdir(), "farm-friend-pre-f050-"));
    mkdirSync(resolve(preChangeMigrations, "meta"));

    const journal = JSON.parse(
      readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { version: string; dialect: string; entries: unknown[] };
    writeFileSync(
      resolve(preChangeMigrations, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 11) }),
    );
    for (let index = 0; index < 11; index += 1) {
      const prefix = index.toString().padStart(4, "0");
      const file = readdirSync(migrationsDir).find(
        (candidate) => candidate.startsWith(`${prefix}_`) && candidate.endsWith(".sql"),
      );
      if (!file) throw new Error(`missing pre-change migration ${prefix}`);
      copyFileSync(resolve(migrationsDir, file), resolve(preChangeMigrations, file));
    }

    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: preChangeMigrations });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
    if (preChangeMigrations) rmSync(preChangeMigrations, { recursive: true, force: true });
  }, 30_000);

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  it("preserves reviewed ownership, visibility, and open flags without inventing participants", async () => {
    const farms = await client()`insert into farms (name) values ('Reviewed Owner') returning id`;
    const farmId = farms[0]?.id as string;
    const locations = await client()`
      insert into sales_locations (
        farm_id, kind, name, public_address, public_latitude, public_longitude,
        is_public, farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farmId}, 'farm_stand', 'Flagged Hidden Stand', '50 Migration Lane',
        47.44, -122.46, false, false, false
      ) returning id, farm_id, is_public
    `;
    const locationId = locations[0]?.id as string;
    const flags = await client()`
      insert into stand_data_flags (sales_location_id, reason, source_text)
      values (${locationId}, 'season_unresolved', 'review required')
      returning id
    `;

    await migrate(drizzle(client()), { migrationsFolder: migrationsDir });

    expect(await client()`
      select id, owner_farm_id, is_public from sales_locations where id = ${locationId}
    `).toEqual([{ id: locationId, owner_farm_id: farmId, is_public: false }]);
    expect(await client()`
      select id, sales_location_id, reason, resolved_at
      from stand_data_flags where id = ${flags[0]?.id as string}
    `).toEqual([
      {
        id: flags[0]?.id as string,
        sales_location_id: locationId,
        reason: "season_unresolved",
        resolved_at: null,
      },
    ]);
    expect(await client()`select id from sales_location_participants`).toHaveLength(0);

    const ownershipColumns = await client()`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'sales_locations'
        and column_name in ('farm_id', 'owner_farm_id')
      order by column_name
    `;
    expect(ownershipColumns).toEqual([{ column_name: "owner_farm_id" }]);
    expect(
      await client()`select count(*)::integer as count from drizzle.__drizzle_migrations`,
    ).toEqual([{ count: 15 }]);
  });
});
