import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveFarm,
  createDb,
  listFarmsForApproval,
  listStandsForAdministration,
  restoreFarm,
  retireFarm,
  saveFarmDetails,
  type Db,
} from "./index";

// Taking a whole farm down, proven by the effects that define it.
//
// max asked for "edit details / delete a farm" and chose the same meaning he chose for stands
// in F-071: take it down, keep the records. That is a deliberate design, not a compromise:
// `sellers` is referenced `on delete restrict` by `sales_locations`, `farmer_authorizations`,
// `seller_approvals` and more, so a hard DELETE fails at the constraint for any farm that has
// ever been used; and erasing it would erase what its stands published and when, which is the
// one thing the audit trail exists to keep (Golden Rule #1).
//
// Retiring a FARM is not the same act as retiring each of its stands, so the tests below
// insist on the properties that make it its own concept:
//
//   1. every stand under the farm leaves the operator's public view, without any stand's own
//      `retired_at` being written — a farm take-down must not masquerade as per-stand ones,
//      because restoring the farm would then have to guess which stands were already down;
//   2. a stand retired on its own BEFORE the farm goes down stays retired after the farm is
//      restored — the two decisions are independent and neither may silently undo the other;
//   3. the record survives, and restoring puts the farm back exactly as it was.
//
// The suite refuses to write `retired_at` by hand: retirement comes from `retireFarm` or it
// does not exist. A fixture that set the column itself would prove the column works and leave
// the writer untested.

const dbPackage = resolve(process.cwd(), "packages/db");
const migrationsDir = resolve(dbPackage, "drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }
  return databaseUrl;
}

function testDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("farm retirement (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;

  // Clock-derived, never a date literal (B-003 tripwire).
  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const at = (hours: number) => new Date(anchor + hours * 60 * 60 * 1000);
  const t0 = at(0);

  const ids: Record<string, string> = {};
  const sql = () => client as Sql;
  const handle = () => db as Db;

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_farm_retire_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);

    db = createDb(url);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    const sellers = await sql()`
      insert into sellers (name, description) values ('Retiring Farm', 'Berries and eggs')
      returning id
    `;
    ids.farm = sellers[0]?.id as string;

    // A SECOND farm that must be untouched by everything below. Without it, "the farm is gone
    // from the operator's list" would also pass for a writer that retired every farm.
    const bystanders = await sql()`
      insert into sellers (name) values ('Bystander Farm') returning id
    `;
    ids.bystanderFarm = bystanders[0]?.id as string;

    for (const [key, name, farmKey] of [
      ["standA", "Roadside Stand", "farm"],
      ["standB", "Orchard Stand", "farm"],
      ["bystanderStand", "Bystander Stand", "bystanderFarm"],
    ] as const) {
      const rows = await sql()`
        insert into sales_locations (own_seller_id, kind, name, timezone, visitability, offering_type,
          public_address, public_latitude, public_longitude, is_public)
        values (${ids[farmKey] as string}, 'farm_stand', ${name}, 'America/Los_Angeles',
          'visitable', 'produce', '11 Retire Row', 47.44, -122.45, true)
        returning id
      `;
      ids[key] = rows[0]?.id as string;
    }

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${t0.toISOString()})
      returning id
    `;
    ids.administrator = administrators[0]?.id as string;

    await approveFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: t0,
    });
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("starts live: the farm is not retired and both its stands are visible", async () => {
    // Anchors every later assertion. Without this, "the stands are gone after retirement"
    // would also pass for stands that were never visible in the first place.
    const rows = await sql()`select retired_at from sellers where id = ${ids.farm as string}`;
    expect(rows[0]?.retired_at, "no fixture may pre-retire the farm").toBeNull();

    const stands = await listStandsForAdministration(handle());
    const mine = stands.filter((stand) => stand.standId === ids.standA || stand.standId === ids.standB);
    expect(mine).toHaveLength(2);
    expect(mine.every((stand) => !stand.retired)).toBe(true);
  });

  it("edits a farm's details, recording the change without touching its stands", async () => {
    const result = await saveFarmDetails(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      name: "Renamed Farm",
      description: "Berries, eggs, and honey",
      occurredAt: at(1),
    });
    expect(result.status).toBe("saved");

    const rows = await sql()`
      select name, description from sellers where id = ${ids.farm as string}
    `;
    expect(rows[0]?.name).toBe("Renamed Farm");
    expect(rows[0]?.description).toBe("Berries, eggs, and honey");

    const audit = await sql()`
      select action from audit_events
      where subject_id = ${ids.farm as string} and action = 'farm_details_saved'
    `;
    expect(audit, "the edit must be attributable to the administrator who made it").toHaveLength(1);
  });

  it("refuses a blank farm name rather than writing one", async () => {
    // `sellers_name_not_blank` would refuse this at the constraint, but a constraint violation
    // surfaces as a thrown error rather than an answer the route can turn into a message.
    const result = await saveFarmDetails(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      name: "   ",
      description: null,
      occurredAt: at(2),
    });
    expect(result.status).toBe("invalid_name");

    const rows = await sql()`select name from sellers where id = ${ids.farm as string}`;
    expect(rows[0]?.name, "a refused edit must not have written anything").toBe("Renamed Farm");
  });

  it("retires one stand on its own first, so the farm take-down cannot be credited for it", async () => {
    // Sets up the independence claim below. `standB` goes down as its own decision, BEFORE
    // the farm does.
    const { retireStand } = await import("./index");
    const result = await retireStand(handle(), {
      salesLocationId: ids.standB as string,
      administratorId: ids.administrator as string,
      occurredAt: at(3),
    });
    expect(result.status).toBe("retired");
  });

  it("retires the farm, recording the acting administrator and the moment", async () => {
    const retiredAt = at(4);
    const result = await retireFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: retiredAt,
    });
    expect(result.status).toBe("retired");

    const rows = await sql()`
      select retired_at, retired_by_administrator_id from sellers
      where id = ${ids.farm as string}
    `;
    expect(new Date(rows[0]?.retired_at as string).getTime()).toBe(retiredAt.getTime());
    expect(rows[0]?.retired_by_administrator_id).toBe(ids.administrator);

    const audit = await sql()`
      select action from audit_events
      where subject_id = ${ids.farm as string} and action = 'farm_retired'
    `;
    expect(audit).toHaveLength(1);
  });

  it("takes every stand under the farm down WITHOUT writing any stand's own retirement", async () => {
    // The load-bearing claim, and the reason a farm take-down is its own concept. The stands
    // must stop being served, but `standA` must NOT gain a `retired_at` of its own — otherwise
    // restoring the farm could not tell which stands were already down before it.
    const stands = await listStandsForAdministration(handle());
    const standA = stands.find((stand) => stand.standId === ids.standA);
    expect(standA?.retired, "a stand under a retired farm reads as off the map").toBe(true);

    const rows = await sql()`
      select retired_at from sales_locations where id = ${ids.standA as string}
    `;
    expect(
      rows[0]?.retired_at,
      "the farm take-down must not write the stand's own retirement",
    ).toBeNull();
  });

  it("leaves the bystander farm and its stand completely untouched", async () => {
    const rows = await sql()`
      select retired_at from sellers where id = ${ids.bystanderFarm as string}
    `;
    expect(rows[0]?.retired_at).toBeNull();

    const stands = await listStandsForAdministration(handle());
    const bystander = stands.find((stand) => stand.standId === ids.bystanderStand);
    expect(bystander?.retired).toBe(false);
  });

  it("is idempotent, keeping the first retirement's moment", async () => {
    // Moving the timestamp would falsify when the farm actually came down, which is the one
    // fact the record is for.
    const result = await retireFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(9),
    });
    expect(result.status).toBe("already_retired");

    const rows = await sql()`select retired_at from sellers where id = ${ids.farm as string}`;
    expect(new Date(rows[0]?.retired_at as string).getTime()).toBe(at(4).getTime());
  });

  it("refuses to act for a revoked administrator", async () => {
    // `administrators_fixed_identity` permits exactly one account, so authority is revoked
    // and reinstated around the assertion rather than inventing a second administrator.
    // That is the more honest test anyway: it proves the writer re-reads authority from the
    // row at write time, rather than trusting a principal resolved earlier in the request.
    await sql()`
      update administrators set revoked_at = ${at(10).toISOString()}
      where id = ${ids.administrator as string}
    `;
    try {
      const result = await retireFarm(handle(), {
        farmId: ids.bystanderFarm as string,
        administratorId: ids.administrator as string,
        occurredAt: at(10),
      });
      expect(result.status).toBe("not_an_administrator");

      const rows = await sql()`
        select retired_at from sellers where id = ${ids.bystanderFarm as string}
      `;
      expect(rows[0]?.retired_at, "a refused take-down must write nothing").toBeNull();
    } finally {
      await sql()`
        update administrators set revoked_at = null
        where id = ${ids.administrator as string}
      `;
    }
  });

  it("restores the farm, and the stand that was already down STAYS down", async () => {
    // The independence claim, proven in the direction that actually bites. `standA` comes
    // back because only the farm was holding it down; `standB` stays down because it carries
    // its own retirement, which restoring the farm has no business clearing.
    const result = await restoreFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(11),
    });
    expect(result.status).toBe("restored");

    const rows = await sql()`
      select retired_at, retired_by_administrator_id from sellers
      where id = ${ids.farm as string}
    `;
    expect(rows[0]?.retired_at).toBeNull();
    expect(
      rows[0]?.retired_by_administrator_id,
      "sellers_coherent_retirement requires the actor to clear with the timestamp",
    ).toBeNull();

    const stands = await listStandsForAdministration(handle());
    expect(stands.find((stand) => stand.standId === ids.standA)?.retired).toBe(false);
    expect(
      stands.find((stand) => stand.standId === ids.standB)?.retired,
      "a stand retired on its own must survive the farm coming back",
    ).toBe(true);
  });

  it("keeps the farm's approval and identity across the whole cycle", async () => {
    // Retirement takes a farm off the public surfaces; it does not revoke approval or
    // rewrite the record. The farm that comes back is the same farm that went down.
    const sellers = await listFarmsForApproval(handle());
    const mine = sellers.find((farm) => farm.farmId === ids.farm);
    expect(mine?.approved).toBe(true);
    expect(mine?.name).toBe("Renamed Farm");
  });
});
