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

describe("F-052 forward migration from populated pre-prompt schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let preChangeMigrations = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

    databaseName = `farm_friend_prompt_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    preChangeMigrations = mkdtempSync(resolve(tmpdir(), "farm-friend-pre-f052-"));
    mkdirSync(resolve(preChangeMigrations, "meta"));

    const journal = JSON.parse(
      readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { version: string; dialect: string; entries: unknown[] };
    writeFileSync(
      resolve(preChangeMigrations, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 14) }),
    );
    for (let index = 0; index < 14; index += 1) {
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

  it("assigns the reviewed island timezone to existing locations and invents no preferences", async () => {
    const farms = await client()`insert into farms (name) values ('Existing Farm') returning id`;
    const farmId = farms[0]?.id as string;
    const locations = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values
        (${farmId}, 'farm_stand', 'Existing Stand', 'visitable', 'produce', '1 Existing Way', 47.44, -122.46, false, false),
        (${farmId}, 'farmers_market', 'Existing Market', 'visitable', 'produce', '2 Existing Way', 47.45, -122.47, false, true)
      returning id, name
    `;

    await migrate(drizzle(client()), { migrationsFolder: migrationsDir });

    expect(await client()`
      select id, name, timezone from sales_locations order by name
    `).toEqual([
      { id: locations[1]?.id as string, name: "Existing Market", timezone: "America/Los_Angeles" },
      { id: locations[0]?.id as string, name: "Existing Stand", timezone: "America/Los_Angeles" },
    ]);
    expect(await client()`select id from inventory_prompt_preferences`).toHaveLength(0);
    expect(await client()`select proposal_id from scheduled_inventory_prompt_subjects`).toHaveLength(0);
    await expect(client()`
      insert into sales_locations (
        owner_farm_id, kind, name, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (${farmId}, 'farm_stand', 'Unreviewed Zone', 'visitable', 'produce', '3 Existing Way', 47.46, -122.48, false, false)
    `).rejects.toThrow(/timezone|null value/i);
    expect(
      await client()`select count(*)::integer as count from drizzle.__drizzle_migrations`,
    ).toEqual([{ count: 16 }]);
  });
});
