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

describe("B-031 final targeting migration from populated pre-change schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let preChangeMigrations = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `farm_friend_targeting_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    preChangeMigrations = mkdtempSync(resolve(tmpdir(), "farm-friend-pre-f051-"));
    mkdirSync(resolve(preChangeMigrations, "meta"));

    const journal = JSON.parse(
      readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { version: string; dialect: string; entries: unknown[] };
    writeFileSync(
      resolve(preChangeMigrations, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 12) }),
    );
    for (let index = 0; index < 12; index += 1) {
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
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: preChangeMigrations });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 1 });
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

  it("preserves populated authority data and permits only exact new links", async () => {
    const now = new Date(Date.now() - 60_000);
    await client()`
      insert into administrators (email, authorized_at)
      values ('populated-admin@viga.example', ${now})
    `;
    const farms = await client()`insert into farms (name) values ('Populated Farm') returning id`;
    const farmId = farms[0]?.id as string;
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550188', ${"c".repeat(64)}, ${now}) returning id
    `;
    const authorizations = await client()`
      insert into farmer_authorizations (
        farm_id, contact_id, phone_verified_at, authorized_at
      ) values (${farmId}, ${contacts[0]?.id as string}, ${now}, ${now}) returning id
    `;
    const authorizationId = authorizations[0]?.id as string;
    const locations = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farmId}, 'farm_stand', 'Populated Stand', 'visitable', 'produce', '1 Existing Way', 47.44, -122.46,
        false, false
      ) returning id
    `;
    const locationId = locations[0]?.id as string;
    const participants = await client()`
      insert into sales_location_participants (
        owner_farm_id, sales_location_id, display_name,
        confirmed_by_authorization_id, confirmed_at
      ) values (${farmId}, ${locationId}, 'Existing Seller', ${authorizationId}, ${now})
      returning id
    `;
    // Apply through the existing raw connection's database with a separate Drizzle client;
    // constructing the URL from test state is clearer and avoids mutating raw serializers.
    const base = process.env.DATABASE_URL!;
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const fullMigrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(fullMigrationClient), { migrationsFolder: migrationsDir });
    await fullMigrationClient.end({ timeout: 5 });

    expect(await client()`
      select id, owner_farm_id, name from sales_locations where id = ${locationId}
    `).toEqual([{ id: locationId, owner_farm_id: farmId, name: "Populated Stand" }]);
    expect(await client()`
      select id, farm_id, contact_id, revoked_at
      from farmer_authorizations where id = ${authorizationId}
    `).toEqual([
      {
        id: authorizationId,
        farm_id: farmId,
        contact_id: contacts[0]?.id as string,
        revoked_at: null,
      },
    ]);
    expect(await client()`select id from sales_location_participants`).toEqual([
      { id: participants[0]?.id as string },
    ]);
    expect(await client()`select id from farmer_links`).toHaveLength(0);

    const links = await client()`
      insert into farmer_links (
        token_hash, authorization_id, owner_farm_id, sales_location_id, issued_at
      ) values (
        ${"d".repeat(64)}, ${authorizationId}, ${farmId}, ${locationId}, ${now}
      ) returning id, owner_farm_id, sales_location_id
    `;
    expect(links).toEqual([{
      id: links[0]?.id as string,
      owner_farm_id: farmId,
      sales_location_id: locationId,
    }]);

    for (const target of [
      { ownerFarmId: null, salesLocationId: null },
      { ownerFarmId: farmId, salesLocationId: null },
      { ownerFarmId: null, salesLocationId: locationId },
    ]) {
      await expect(client()`
        insert into farmer_links (
          token_hash, authorization_id, owner_farm_id, sales_location_id, issued_at
        ) values (
          ${randomUUID().replaceAll("-", "").repeat(2)}, ${authorizationId},
          ${target.ownerFarmId}, ${target.salesLocationId}, ${now}
        )
      `).rejects.toMatchObject({ code: "23502" });
    }
    expect(await client()`select * from farmer_target_contexts`).toHaveLength(0);
    expect(await client()`select * from farmer_target_menu_options`).toHaveLength(0);
    expect(await client()`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'administrators'
        and column_name = 'contact_id'
    `).toHaveLength(0);
    expect(await client()`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'admin_sessions'
        and column_name = 'magic_nonce_hash'
    `).toEqual([{ is_nullable: "NO" }]);
    expect(await client()`
      select indexname from pg_indexes
      where schemaname = 'public'
        and indexname = 'administrators_one_active_per_contact'
    `).toHaveLength(0);
    expect(
      await client()`select count(*)::integer as count from drizzle.__drizzle_migrations`,
    ).toEqual([{ count: 15 }]);
  });
});
