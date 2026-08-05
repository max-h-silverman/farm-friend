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
const currentMigrationCount = (
  JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8")) as { entries: unknown[] }
).entries.length;
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const NOW = T0.toISOString();
const farmerHash = "9".repeat(64);
const adminHash = "8".repeat(64);

describe("F-049 forward migration from populated pre-change schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let preChangeMigrations = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

    databaseName = `farm_friend_closure_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    preChangeMigrations = mkdtempSync(resolve(tmpdir(), "farm-friend-pre-f049-"));
    mkdirSync(resolve(preChangeMigrations, "meta"));

    const journal = JSON.parse(
      readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { version: string; dialect: string; entries: unknown[] };
    writeFileSync(
      resolve(preChangeMigrations, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 10) }),
    );
    for (let index = 0; index < 10; index += 1) {
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

  it("preserves existing inventory facts while adding empty closure history", async () => {
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash) values
        ('+12065550901', ${farmerHash}), ('+12065550902', ${adminHash})
      returning id, phone_hash
    `;
    const contact = (hash: string) =>
      contacts.find((row) => row.phone_hash === hash)?.id as string;
    const administrators = await client()`
      insert into administrators (email, contact_id, authorized_at)
      values ('board@vigavashon.org', ${contact(adminHash)}, ${NOW}) returning id
    `;
    const farms = await client()`insert into farms (name) values ('Pre-F049 Farm') returning id`;
    const farmId = farms[0]?.id as string;
    const locations = await client()`
      insert into sales_locations (
        farm_id, kind, name, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farmId}, 'farm_stand', 'Existing Stand', '49 Migration Lane', 47.44, -122.46,
        false, false
      ) returning id
    `;
    const locationId = locations[0]?.id as string;
    const authorizations = await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contact(farmerHash)}, ${NOW}, ${NOW}) returning id
    `;
    const approvals = await client()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${farmId}, ${administrators[0]?.id as string}, ${NOW}) returning id
    `;
    const proposals = await client()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version, proposal_version,
        yes_token, no_token, base_is_first_publication
      ) values (
        ${farmerHash}, ${locationId}, ${client().json({ items: [{ itemName: "Eggs" }] })},
        '1', 1, 'YES', 'NO', true
      ) returning id
    `;
    const proposalId = proposals[0]?.id as string;
    const revisions = await client()`
      insert into inventory_revisions (
        farm_id, sales_location_id, proposal_id, published_by_authorization_id,
        farm_approval_id, published_at
      ) values (
        ${farmId}, ${locationId}, ${proposalId}, ${authorizations[0]?.id as string},
        ${approvals[0]?.id as string}, ${NOW}
      ) returning id
    `;
    await client()`
      insert into inventory_entries (inventory_revision_id, sales_location_id, item_name, sort_order)
      values (${revisions[0]?.id as string}, ${locationId}, 'Eggs', 0)
    `;

    const before = await client()`
      select p.id, p.payload, p.proposal_version,
             r.id as revision_id, r.published_at, e.item_name
      from inventory_publication_proposals p
      join inventory_revisions r on r.proposal_id = p.id
      join inventory_entries e on e.inventory_revision_id = r.id
      where p.id = ${proposalId}
    `;

    await migrate(drizzle(client()), { migrationsFolder: migrationsDir });

    const after = await client()`
      select p.id, p.payload, p.proposal_version,
             p.has_inventory, p.has_closure, p.base_is_first_publication,
             p.closure_base_revision_id, p.closure_base_is_first_instruction,
             r.id as revision_id, r.published_at, e.item_name
      from inventory_publication_proposals p
      join inventory_revisions r on r.proposal_id = p.id
      join inventory_entries e on e.inventory_revision_id = r.id
      where p.id = ${proposalId}
    `;
    expect(after).toEqual([
      expect.objectContaining({
        ...before[0],
        has_inventory: true,
        has_closure: false,
        base_is_first_publication: true,
        closure_base_revision_id: null,
        closure_base_is_first_instruction: null,
      }),
    ]);
    expect(await client()`select id from closure_revisions`).toHaveLength(0);

    // F-063 — the pre-existing revision, inserted before `source` existed, is backfilled to
    // 'sms' rather than tripping the new NOT NULL. This is the ONLY test that exercises the
    // backfill against a genuinely populated table: everywhere else the column exists from
    // the first insert, so a broken backfill would be invisible. Asserted as a VALUE, because
    // `is not null` would also pass on a column that defaulted to the wrong provenance.
    expect(await client()`
      select source from inventory_revisions where id = ${before[0]?.revision_id as string}
    `).toEqual([{ source: "sms" }]);
    expect(await client()`
      select name, owner_farm_id, timezone, visitability, offering_type
      from sales_locations where id = ${locationId}
    `).toEqual([{
      name: "Existing Stand",
      owner_farm_id: farmId,
      timezone: "America/Los_Angeles",
      visitability: "visitable",
      offering_type: "produce",
    }]);
    expect(await client()`
      select table_name, column_name, column_default
      from information_schema.columns
      where (table_name = 'sales_locations'
             and column_name in ('visitability', 'offering_type'))
         or (table_name = 'inventory_publication_proposals'
             and column_name in ('has_inventory', 'has_closure'))
      order by table_name, column_name
    `).toEqual([
      { table_name: "inventory_publication_proposals", column_name: "has_closure", column_default: null },
      { table_name: "inventory_publication_proposals", column_name: "has_inventory", column_default: null },
      { table_name: "sales_locations", column_name: "offering_type", column_default: null },
      { table_name: "sales_locations", column_name: "visitability", column_default: null },
    ]);
    expect(await client()`
      select column_name from information_schema.columns
      where table_name = 'inventory_publication_proposals'
        and column_name in ('schema_version', 'yes_token', 'no_token')
    `).toHaveLength(0);
    expect(
      await client()`select count(*)::integer as count from drizzle.__drizzle_migrations`,
    ).toEqual([{ count: currentMigrationCount }]);
  });
});
