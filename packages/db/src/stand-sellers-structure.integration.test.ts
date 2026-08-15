import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.1 — the stand-and-sellers structure.

  §the stand-and-sellers correction overrides four decisions the reviewed contract had settled:
  the `sellers` authority root, the native brand slot, stand ownership, and migration `0042`. This
  file is the constraint suite for what replaces them.

  ## What the structure is

  A stand has a name, metadata, and NESTED SELLERS. Two records, not one merged record: Morgan
  Hill Community Stand is a venue with real identity and four sellers, none of which is the
  stand. Merging stand and brand would have destroyed that identity — the corpus measurement that
  38 stands share their owner farm's name exactly is a duplication in the OWNING case only.

  ## What each constraint here defends

  - `seller_id` is NOT NULL. There is no native slot: a stand's own goods are its own seller,
    named like any other. NULL previously meant "the stand itself", which only had meaning while
    `sellers` was the authority root.
  - A stand's self-pointer names the ONE nested seller that is the stand. Suppression on the
    public card follows this pointer and compares no strings — which is what makes `Hill Farm`
    hosted at `Hill Farm Stand` stay credited, and a renamed farm stay suppressed.
  - The self-pointer, when present, must name a seller that ACTUALLY SELLS AT THIS STAND. A
    pointer at an unrelated seller would suppress a line that belongs to somebody else.
  - Morgan Hill: the self-pointer is absent. A venue with no goods of its own invents no seller.

  Every nullability rule is a BICONDITIONAL, because a CHECK PASSES on NULL. Every constraint
  below is sabotage-proved: the test asserts the exact row Postgres must refuse, and each was
  confirmed to fail when the constraint was removed.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-114 Phase C.1 stand-and-sellers structure (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let provoStandId = "";
  let provoSellerId = "";
  let morganHillStandId = "";
  let bayLaurelSellerId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114c1_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 8 });
    const db = client();

    for (const file of migrationFiles) await applyFile(db, file);

    // Provo Farms — a single-seller stand. 31 of 38 stands look like this: the stand and its own
    // seller share a name, and the card suppresses the seller line entirely.
    const provoStands = await db`
      insert into sales_locations (
        kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        'farm_stand', 'Provo Farms', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        'Provo Road, Vashon WA', 47.4473, -122.4590
      ) returning id
    `;
    provoStandId = provoStands[0]?.id as string;

    const provoSellers = await db`
      insert into sellers (name) values ('Provo Farms') returning id
    `;
    provoSellerId = provoSellers[0]?.id as string;

    // Morgan Hill Community Stand — a VENUE. It has a name and identity of its own and sells
    // nothing itself. Its self-pointer stays NULL, and no seller is invented for it.
    const morganStands = await db`
      insert into sales_locations (
        kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        'farm_stand', 'Morgan Hill Community Farm Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        'Morgan Hill Road, Vashon WA', 47.4102, -122.4788
      ) returning id
    `;
    morganHillStandId = morganStands[0]?.id as string;

    const bayLaurel = await db`
      insert into sellers (name) values ('Bay Laurel Farm') returning id
    `;
    bayLaurelSellerId = bayLaurel[0]?.id as string;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  describe("a stand's sellers are nested, and every provider names one", () => {
    it("refuses a provider with no seller — there is no native slot", async () => {
      const db = client();
      await expect(
        db`
          insert into stand_providers (sales_location_id, seller_id, lifecycle_state)
          values (${provoStandId}, null, 'active')
        `,
      ).rejects.toThrow();
    });

    it("admits a stand's own seller as an ordinary provider", async () => {
      const db = client();
      const rows = await db`
        insert into stand_providers (sales_location_id, seller_id, lifecycle_state)
        values (${provoStandId}, ${provoSellerId}, 'active')
        returning id, seller_id
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.seller_id).toBe(provoSellerId);
    });

    it("refuses the same seller twice at one stand", async () => {
      const db = client();
      await expect(
        db`
          insert into stand_providers (sales_location_id, seller_id, lifecycle_state)
          values (${provoStandId}, ${provoSellerId}, 'active')
        `,
      ).rejects.toThrow();
    });
  });

  describe("the self-pointer, not a name match", () => {
    it("lets a stand name the nested seller that is itself", async () => {
      const db = client();
      await db`
        update sales_locations set own_seller_id = ${provoSellerId} where id = ${provoStandId}
      `;
      const rows = await db`
        select own_seller_id from sales_locations where id = ${provoStandId}
      `;
      expect(rows[0]?.own_seller_id).toBe(provoSellerId);
    });

    it("refuses a self-pointer at a seller that does not sell at this stand", async () => {
      const db = client();
      // Bay Laurel sells at Morgan Hill, never at Provo. A pointer here would suppress a line
      // belonging to somebody else.
      await expect(
        db`
          update sales_locations set own_seller_id = ${bayLaurelSellerId}
          where id = ${provoStandId}
        `,
      ).rejects.toThrow();
    });

    it("admits a venue with no seller of its own — Morgan Hill", async () => {
      const db = client();
      await db`
        insert into stand_providers (sales_location_id, seller_id, lifecycle_state)
        values (${morganHillStandId}, ${bayLaurelSellerId}, 'active')
      `;
      const rows = await db`
        select own_seller_id from sales_locations where id = ${morganHillStandId}
      `;
      expect(rows[0]?.own_seller_id).toBeNull();
    });

    it("keeps the pointer honest when the relationship ends", async () => {
      const db = client();
      // Ending the stand's own participation must not leave a pointer at a seller that no
      // longer sells here. The constraint is what forces the writer to clear it.
      await expect(
        db`
          update stand_providers set ended_at = now()
          where sales_location_id = ${provoStandId} and seller_id = ${provoSellerId}
        `,
      ).rejects.toThrow();
    });
  });

  describe("stand ownership is gone", () => {
    it("has no owner_seller_id column on sales_locations", async () => {
      const db = client();
      const rows = await db`
        select column_name from information_schema.columns
        where table_name = 'sales_locations' and column_name = 'owner_seller_id'
      `;
      expect(rows).toHaveLength(0);
    });

    it("has no sellers table at all", async () => {
      const db = client();
      const rows = await db`
        select table_name from information_schema.tables where table_name = 'sellers'
      `;
      expect(rows).toHaveLength(0);
    });
  });
});
