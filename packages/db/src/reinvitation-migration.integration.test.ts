import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-115 Tranche D — `0051` against a POPULATED copy of the schema that precedes it.

  ## What it claims

  `stand_providers_one_per_seller_per_location` becomes PARTIAL on `ended_at is null`: at most
  one LIVE relationship per (stand, seller), any number of ended ones.

  It was full, so an ended row occupied the slot forever and `inviteSellerToStand` answered
  `already_selling_here` to a seller who had left. Ending closed the door instead of closing one
  arrangement, which §hosting and approval lifecycle never said (max, 2026-08-17).

  ## Why only real rows can test it

  `CREATE UNIQUE INDEX` builds against every row already present, so it either holds for the
  whole corpus or the migration fails in production having passed on every empty database in the
  repo. The claim under test is a claim about data: *every (stand, seller) pair today has at most
  one row, so narrowing the index to live rows removes no guarantee any existing row relies on.*
  That is reasoning until a populated run proves it.

  ## What this file populates

    1. The 38-stand case — a stand with a seller of its own, whose provider row the
       `create_own_seller_provider` trigger writes. Nothing about it may change.
    2. A LIVE hosted relationship. The pair the index still has to refuse a duplicate of.
    3. An ENDED hosted relationship at a second stand. The row the old index froze, and the one
       a re-invitation has to be able to write alongside.

  ## What is asserted

  Every row unchanged BY ID and by count; the index present BY NAME and actually PARTIAL
  (`pg_index.indpred`, which is the fact that differs — a full and a partial index have the same
  name, the same columns and the same `indisunique`, so every other probe passes either way); the
  new behaviour admitted where it was refused; and a duplicate LIVE row still refused, so this is
  a narrowing rather than a removal.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/* Ordered, never "everything that is not `0051`" — an exclusion filter is correct only while its
   own migration is the newest in the repo, and every future migration breaks it the same way
   (DEVELOPMENT.md §gotchas). Bounded at both ends for the same reason. */
const beforeThisWork = migrationFiles.filter((name) => name < "0051_");
const thisWork = migrationFiles.filter((name) => name >= "0051_" && name < "0052_");

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-115 `0051` re-invitation, against a populated schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let ownSellerId = "";
  let liveGuestId = "";
  let departedGuestId = "";
  let standLocationId = "";
  let secondLocationId = "";
  let ownProviderId = "";
  let liveProviderId = "";
  let endedProviderId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f115reinvite_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 4 });
    const db = client();

    // ---- 1. the schema as it stands BEFORE this migration -----------------------------------
    expect(thisWork).toEqual(["0051_reinvitation_after_ending.sql"]);
    expect(beforeThisWork.length).toBeGreaterThan(50);
    for (const file of beforeThisWork) await applyFile(db, file);

    // ---- 2. populate it ---------------------------------------------------------------------
    const sellers = await db`
      insert into sellers (name)
      values ('Venison Valley'), ('Gracies Greens'), ('Cascade Bakery')
      returning id, name
    `;
    ownSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    liveGuestId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;
    departedGuestId = sellers.find((row) => row.name === "Cascade Bakery")?.id as string;

    const mkStand = async (name: string, owner: string | null): Promise<string> => {
      const rows = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          ${owner}, 'farm_stand', ${name}, 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          ${`${name} Road, Vashon WA`}, 47.4473, -122.4590
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    standLocationId = await mkStand("Venison Valley Stand", ownSellerId);
    secondLocationId = await mkStand("Morgan Hill Community Stand", null);

    const own = await db`
      select id from stand_providers
      where sales_location_id = ${standLocationId} and seller_id = ${ownSellerId}
    `;
    ownProviderId = own[0]?.id as string;

    const live = await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standLocationId}, ${liveGuestId}, 'active', false, now(), now(), 'viga', now()
      ) returning id
    `;
    liveProviderId = live[0]?.id as string;

    // The row the old index froze. It is written BEFORE the migration, which is the whole point:
    // a corpus where nobody had ever ended anything would prove nothing about the build.
    const ended = await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at, ended_at
      ) values (
        ${secondLocationId}, ${departedGuestId}, 'active', false,
        now(), now(), 'viga', now(), now()
      ) returning id
    `;
    endedProviderId = ended[0]?.id as string;

    // Proves the OLD index was really in the way, so the cases below measure the migration
    // rather than a restriction that was never there.
    await expect(db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at
      ) values (${secondLocationId}, ${departedGuestId}, 'pending', now())
    `).rejects.toThrow(/stand_providers_one_per_seller_per_location/);

    // ---- 3. apply the migration under test --------------------------------------------------
    for (const file of thisWork) await applyFile(db, file);
  }, 120_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  it("leaves every existing provider row exactly as it was", async () => {
    // By ID and by count. A rebuild that dropped a row, or a backfill nobody asked for, is what
    // this catches — and the count is what catches an addition the by-id checks would miss.
    expect(await client()`select count(*)::int as count from stand_providers`)
      .toEqual([{ count: 3 }]);
    for (const [id, ended] of [
      [ownProviderId, false],
      [liveProviderId, false],
      [endedProviderId, true],
    ] as const) {
      const rows = await client()`
        select lifecycle_state, ended_at is not null as ended
        from stand_providers where id = ${id}
      `;
      expect(rows).toEqual([{ lifecycle_state: "active", ended }]);
    }
  });

  it("keeps the index BY NAME, unique, and makes it PARTIAL", async () => {
    /*
      `indpred` is the fact that actually differs. A full and a partial unique index share the
      same name, the same columns and the same `indisunique`, so `pg_indexes` by name,
      `indisunique`, and a column-list probe all pass either way — the same shape as the
      `NOT VALID` trap in DEVELOPMENT.md §gotchas.
    */
    expect(await client()`
      select i.indisunique, i.indpred is not null as partial
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname = 'stand_providers_one_per_seller_per_location'
    `).toEqual([{ indisunique: true, partial: true }]);
  });

  it("admits a NEW relationship for a seller whose previous one ended", async () => {
    // The behaviour the migration exists for, at the stand where the ended row lives.
    const rows = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at
      ) values (${secondLocationId}, ${departedGuestId}, 'pending', now())
      returning id
    `;
    expect(rows).toHaveLength(1);
    // The ended row is still there beside it. History is not overwritten by the return.
    expect(await client()`
      select count(*)::int as count from stand_providers
      where sales_location_id = ${secondLocationId} and seller_id = ${departedGuestId}
    `).toEqual([{ count: 2 }]);
    await client()`delete from stand_providers where id = ${rows[0]?.id as string}`;
  });

  it("still REFUSES a second LIVE relationship for the same seller at one stand", async () => {
    // The narrowing has to still be a constraint. Two live rows for one seller at one stand
    // would be two listings under one name — the ambiguity the index exists to prevent.
    await expect(client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at
      ) values (${standLocationId}, ${liveGuestId}, 'pending', now())
    `).rejects.toThrow(/stand_providers_one_per_seller_per_location/);
  });

  it("still REFUSES a second live row against the stand's OWN seller", async () => {
    // `create_own_seller_provider` writes one; a second would give the stand two listings of its
    // own goods, and every self-pointer reader would then pick one arbitrarily.
    await expect(client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at
      ) values (${standLocationId}, ${ownSellerId}, 'pending', now())
    `).rejects.toThrow(/stand_providers_one_per_seller_per_location/);
  });

  it("admits SEVERAL ended relationships for one pair", async () => {
    // Two episodes are two rows. Nothing collapses them, and nothing has to: `ended_at` is what
    // records that each one happened.
    const second = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
        approval_source, approved_at, ended_at
      ) values (
        ${secondLocationId}, ${departedGuestId}, 'active', now(), now(), 'viga', now(), now()
      ) returning id
    `;
    expect(second).toHaveLength(1);
    expect(await client()`
      select count(*)::int as count from stand_providers
      where sales_location_id = ${secondLocationId} and seller_id = ${departedGuestId}
        and ended_at is not null
    `).toEqual([{ count: 2 }]);
    await client()`delete from stand_providers where id = ${second[0]?.id as string}`;
  });

  it("is idempotent — the integration suite applies every file twice", async () => {
    for (const file of thisWork) await applyFile(client(), file);
    expect(await client()`
      select i.indisunique, i.indpred is not null as partial
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname = 'stand_providers_one_per_seller_per_location'
    `).toEqual([{ indisunique: true, partial: true }]);
  });
});
