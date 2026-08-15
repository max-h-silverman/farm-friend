import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

// F-066 — the 0020 backfill, against a POPULATED pre-change schema.
//
// Applying a migration to an empty database proves the DDL parses. It proves nothing about the
// backfill, which is the half that touches real rows — and the half that broke in F-063, where
// a backfill `UPDATE` aborted on a history-guard trigger and would have failed against
// production. So this test migrates to 0019, writes the rows a real database holds, and only
// then applies 0020.
//
// What the backfill must get right:
//   1. Every existing standing claim becomes an item that is usually carried.
//   2. Every item any published revision named exists too, WITHOUT the standing state — a past
//      confirmation is not a standing claim. Missing this loses vocabulary.
//   3. Rows that were legally distinct before and collide under the new key ("Eggs"/"eggs")
//      become ONE item rather than aborting the migration.
//   4. Published history is not touched. The entries table refuses every update, so a backfill
//      that tried would abort exactly as F-063's did.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const journalPath = resolve(migrationsDir, "meta/_journal.json");

/**
 * A migrations folder holding every migration BEFORE `stopBefore`, run by Drizzle's own
 * migrator.
 *
 * Splitting the SQL by hand and replaying it was the first attempt and it was wrong: the
 * baseline migration contains `DO $$ ... $$` blocks whose bodies carry their own semicolons,
 * so a naive split produced statements that ran out of order and failed on a foreign key to a
 * column that did not exist yet. Copying the folder and truncating the JOURNAL keeps Drizzle
 * as the only thing that parses migrations — the same code path production uses.
 */
function migrationsFolderStoppingBefore(stopBefore: string): string {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const cut = ordered.findIndex((entry) => entry.tag === stopBefore);
  if (cut <= 0) throw new Error(`${stopBefore} must be in the journal, after other entries`);

  const folder = mkdtempSync(resolve(tmpdir(), "ff-migrations-"));
  cpSync(migrationsDir, folder, { recursive: true });
  writeFileSync(
    resolve(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: ordered.slice(0, cut) }, null, 2),
  );
  return folder;
}

describe("F-066 stand items backfill (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let farmId = "";
  let locationId = "";
  let otherLocationId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_items_backfill_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 1 });

    // Apply every migration UP TO BUT NOT INCLUDING 0020 — the pre-change schema.
    const priorFolder = migrationsFolderStoppingBefore("0020_stand_items");
    try {
      const priorClient = postgres(url.toString(), { max: 1 });
      await migrate(drizzle(priorClient), { migrationsFolder: priorFolder });
      await priorClient.end({ timeout: 5 });
    } finally {
      rmSync(priorFolder, { recursive: true, force: true });
    }

    // Prove we are genuinely on the pre-change schema: no items table yet, but 0019's
    // `source` column present. Otherwise this test could be silently running against a fully
    // migrated database and asserting nothing about the backfill.
    const before = await client()`
      select to_regclass('stand_items') as items,
             to_regclass('sales_location_offerings') as offerings
    `;
    expect(before[0]?.items, "stand_items must NOT exist before 0020").toBeNull();
    expect(before[0]?.offerings).not.toBeNull();

    const sellers = await client()`insert into sellers (name) values ('Backfill Farm') returning id`;
    farmId = sellers[0]?.id as string;
    const locations = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', 'Backfill Stand', 'America/Los_Angeles',
        'visitable', 'produce', '1 Backfill Way', 47.4, -122.4, false, false
      )
      returning id
    `;
    locationId = locations[0]?.id as string;
    const others = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', 'Second Backfill Stand', 'America/Los_Angeles',
        'visitable', 'produce', '2 Backfill Way', 47.5, -122.5, false, false
      )
      returning id
    `;
    otherLocationId = others[0]?.id as string;

    // The standing claims a real database holds, seeded from VIGA's profile form.
    await client()`
      insert into sales_location_offerings (sales_location_id, item, sort_order)
      values
        (${locationId}, 'eggs', 0),
        (${locationId}, 'plant starts', 1),
        (${locationId}, 'Gailan', 2),
        (${otherLocationId}, 'eggs', 0)
    `;

    // Two rows that are LEGAL under the old primary key and COLLIDE under the new index.
    // This is the case that would abort the migration if the backfill did not dedupe.
    await client()`
      insert into sales_location_offerings (sales_location_id, item, sort_order)
      values (${locationId}, 'Eggs', 5)
    `;

    // A published confirmation — the weekly form's capitalization, plus an item that appears
    // ONLY in a confirmation and in no standing claim anywhere.
    const revision = await client()`
      insert into inventory_revisions (
        seller_id, sales_location_id, source, published_at, is_current
      )
      values (
${farmId}, ${locationId}, 'viga', now() - interval '3 days', true)
      returning id
    `;
    const revisionId = revision[0]?.id as string;
    await client()`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, sort_order
      )
      values
        (${revisionId}, ${locationId}, 'Eggs', 0),
        (${revisionId}, ${locationId}, 'Rhubarb', 1),
        (${revisionId}, ${locationId}, '  Salad Greens  ', 2)
    `;

    // NOW apply 0020, against populated tables.
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  /** Every item at the fixture stand, by normalized key. */
  async function itemsAt(location: string) {
    return (await client()`
      select display_name, usually_carried, sort_order
      from stand_items where sales_location_id = ${location}
      order by lower(btrim(display_name, E' \t\r\n'))
    `) as unknown as {
      display_name: string;
      usually_carried: boolean;
      sort_order: number;
    }[];
  }

  it("gives every standing claim an item that is usually carried", async () => {
    const items = await itemsAt(locationId);
    const usual = items.filter((item) => item.usually_carried);
    expect(usual.map((item) => item.display_name.trim()).sort()).toEqual([
      "Gailan",
      "eggs",
      "plant starts",
    ]);
  });

  it("collapses names that differ only by case into ONE item", async () => {
    // 'eggs' (sort 0) and 'Eggs' (sort 5) were two legal rows before. One item now, and the
    // lowest sort_order won, so display order survives the collapse.
    const eggs = (await itemsAt(locationId)).filter(
      (item) => item.display_name.trim().toLowerCase() === "eggs",
    );
    expect(eggs).toHaveLength(1);
    expect(eggs[0]?.display_name).toBe("eggs");
    expect(eggs[0]?.sort_order).toBe(0);
    expect(eggs[0]?.usually_carried).toBe(true);
  });

  it("creates items for confirmed-only names WITHOUT the standing state", async () => {
    // Rhubarb was confirmed and never listed as usual. It must exist as vocabulary — losing it
    // is how the readers would end up case-folding two lists again — but it is NOT a standing
    // claim, which is the distinction the whole feature preserves.
    const items = await itemsAt(locationId);
    const rhubarb = items.find(
      (item) => item.display_name.trim().toLowerCase() === "rhubarb",
    );
    expect(rhubarb, "a confirmed-only item must still exist").toBeDefined();
    expect(rhubarb?.usually_carried).toBe(false);
  });

  it("trims a padded confirmed name into the item's display name", async () => {
    // '  Salad Greens  ' is a legal entry name (its own CHECK uses a default btrim). Carried
    // in verbatim it would print with its padding, and a tab-only name would violate the
    // stricter not-blank CHECK and abort the migration.
    const items = await itemsAt(locationId);
    const salad = items.find(
      (item) => item.display_name.toLowerCase().includes("salad"),
    );
    expect(salad?.display_name).toBe("Salad Greens");
    expect(salad?.usually_carried).toBe(false);
  });

  it("keeps each stand's vocabulary separate through the backfill", async () => {
    const mine = await itemsAt(locationId);
    const theirs = await itemsAt(otherLocationId);
    expect(theirs.map((item) => item.display_name)).toEqual(["eggs"]);
    // Both stands have eggs; they are different records.
    expect(mine.some((item) => item.display_name === "eggs")).toBe(true);
  });

  it("leaves published history exactly as it was", async () => {
    // The entries the migration read are untouched — including the padded one, which was
    // trimmed for the ITEM's display name and not in the published row.
    const entries = (await client()`
      select item_name from inventory_entries
      where sales_location_id = ${locationId}
      order by sort_order
    `) as unknown as { item_name: string }[];
    expect(entries.map((entry) => entry.item_name)).toEqual([
      "Eggs",
      "Rhubarb",
      "  Salad Greens  ",
    ]);
  });

  it("leaves the pre-change offerings rows in place for the readers to be moved off", async () => {
    // The backfill READS this table; it must not delete from it. Dropping it belongs to a
    // later change, after every reader has moved.
    const [count] = (await client()`
      select count(*)::int as n from sales_location_offerings
    `) as unknown as { n: number }[];
    expect(count?.n).toBe(5);
  });

  it("resolves every published entry to exactly one item", async () => {
    // The end state the whole design rests on: the join key works over the real backfilled
    // corpus, for every entry, with no orphans and no duplicates.
    const rows = (await client()`
      select entry.item_name, count(item.id)::int as matches
      from inventory_entries entry
      left join stand_items item
        on item.sales_location_id = entry.sales_location_id
       and lower(btrim(item.display_name, E' \t\r\n'))
         = lower(btrim(entry.item_name, E' \t\r\n'))
      group by entry.item_name
    `) as unknown as { item_name: string; matches: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.matches, `${JSON.stringify(row.item_name)} must resolve to one item`).toBe(1);
    }
  });
});
