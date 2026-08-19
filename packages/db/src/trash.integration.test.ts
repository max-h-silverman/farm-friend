import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  listFarmsForApproval,
  listStandsForAdministration,
  restoreFarm,
  restoreFromTrash,
  restoreStand,
  retireStand,
  trashFarm,
  trashStand,
  type Db,
} from "./index";

// The trash, proven by the effects that define it (F-122).
//
// max chose trash over destruction (2026-08-19, revising "off the map, plus a real delete" the
// same day): a trashed stand or seller leaves the console's list entirely and VIGA can put it
// back. **Nothing here destroys anything** — emptying the trash is deliberately not built,
// because the referencing closure it must answer is its own piece of work.
//
// Trash is therefore a THIRD state, not a rename of retirement, and these tests insist on the
// properties that make it its own concept:
//
//   1. trashing retires too, so a trashed record is invisible to customers through the SAME
//      `retired_at` rule every public read already applies — the `trashed_implies_retired`
//      CHECK is what makes that one-rule reading safe;
//   2. a trashed record leaves the operator's ordinary list and appears in the trash list, so
//      the two listings partition the roster rather than overlapping;
//   3. restoring from trash puts the record back in the list AND back on the map — the
//      retirement trashing caused is undone with it, or a restore would strand the record
//      listed-but-invisible;
//   4. a record retired on its own BEFORE being trashed stays retired after restore, because
//      the two decisions are independent and neither may silently undo the other;
//   5. the record and its history survive trashing intact.
//
// The suite refuses to write `trashed_at` by hand: trash comes from `trashFarm`/`trashStand` or
// it does not exist. A fixture setting the column itself would prove the column works and leave
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

describe("the trash (integration)", () => {
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
    testDatabaseName = `farm_friend_trash_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);

    db = createDb(url);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    for (const [key, name] of [
      ["farm", "Trashable Farm"],
      // A BYSTANDER that must be untouched by everything below. Without it, "the farm left the
      // list" would also pass for a writer that trashed every farm.
      ["bystanderFarm", "Bystander Farm"],
    ] as const) {
      const rows = await sql()`
        insert into sellers (name, description)
        values (${name}, 'Berries and eggs') returning id
      `;
      ids[key] = rows[0]?.id as string;
    }

    for (const [key, name, farmKey] of [
      ["standA", "Roadside Stand", "farm"],
      ["standB", "Orchard Stand", "farm"],
      ["bystanderStand", "Bystander Stand", "bystanderFarm"],
    ] as const) {
      const rows = await sql()`
        insert into sales_locations (own_seller_id, kind, name, timezone, visitability,
          offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible, is_public)
        values (${ids[farmKey] as string}, 'farm_stand', ${name}, 'America/Los_Angeles',
          'visitable', 'produce', '12 Trash Row', 47.44, -122.45, false, false, true)
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
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("starts live: nothing is trashed and every record is listed", async () => {
    // Anchors every later assertion. Without this, "the stand is gone after trashing" would
    // also pass for a stand that was never listed in the first place.
    const rows = await sql()`
      select trashed_at from sellers where id = ${ids.farm as string}
    `;
    expect(rows[0]?.trashed_at, "no fixture may pre-trash the farm").toBeNull();

    const stands = await listStandsForAdministration(handle());
    const mine = stands.filter(
      (stand) => stand.standId === ids.standA || stand.standId === ids.standB,
    );
    expect(mine).toHaveLength(2);
    expect(mine.every((stand) => !stand.retired)).toBe(true);
  });

  it("trashing a stand retires it in the same act", async () => {
    // The property the `sales_locations_trashed_implies_retired` CHECK exists to guarantee:
    // public invisibility is read off `retired_at` by every public surface, so a trash that
    // did not retire would leave a trashed stand on the island's map.
    const result = await trashStand(handle(), {
      salesLocationId: ids.standA as string,
      administratorId: ids.administrator as string,
      occurredAt: at(1),
    });
    expect(result.status).toBe("trashed");

    const rows = await sql()`
      select trashed_at, trashed_by_administrator_id, retired_at, retired_by_administrator_id
      from sales_locations where id = ${ids.standA as string}
    `;
    expect(rows[0]?.trashed_at, "trashing must record when").not.toBeNull();
    expect(
      rows[0]?.trashed_by_administrator_id,
      "trashing must record who — a record trashed by nobody is what the CHECK forbids",
    ).toBe(ids.administrator);
    expect(
      rows[0]?.retired_at,
      "a trashed stand must be retired, or it stays on the public map",
    ).not.toBeNull();
  });

  it("a trashed stand leaves the ordinary list and appears in the trash", async () => {
    const stands = await listStandsForAdministration(handle());
    expect(
      stands.some((stand) => stand.standId === ids.standA),
      "a trashed stand must not still be in the roster the operator works",
    ).toBe(false);
    expect(
      stands.some((stand) => stand.standId === ids.standB),
      "trashing one stand must not remove its sibling",
    ).toBe(true);
    expect(
      stands.some((stand) => stand.standId === ids.bystanderStand),
      "trashing one stand must not remove an unrelated stand",
    ).toBe(true);

    const trashed = await listStandsForAdministration(handle(), { trashed: true });
    expect(
      trashed.map((stand) => stand.standId),
      "the trash lists exactly what left the roster",
    ).toEqual([ids.standA]);
  });

  it("restoring a stand from the trash puts it back on the map, not merely back in the list", async () => {
    // A restore that cleared only `trashed_at` would return the stand to the roster still
    // retired — listed but invisible, with no control naming the retirement it did not make.
    const result = await restoreFromTrash(handle(), {
      subject: "stand",
      id: ids.standA as string,
      administratorId: ids.administrator as string,
      occurredAt: at(2),
    });
    expect(result.status).toBe("restored");

    const rows = await sql()`
      select trashed_at, retired_at from sales_locations where id = ${ids.standA as string}
    `;
    expect(rows[0]?.trashed_at).toBeNull();
    expect(
      rows[0]?.retired_at,
      "restoring from the trash must undo the retirement the trashing caused",
    ).toBeNull();

    const stands = await listStandsForAdministration(handle());
    expect(stands.some((stand) => stand.standId === ids.standA)).toBe(true);
  });

  it("a stand retired on its own before trashing stays retired after restore", async () => {
    // The independence claim. Trashing must not be creditable for a retirement it did not
    // make, or restoring would silently put back a stand VIGA had separately taken down.
    const retired = await retireStand(handle(), {
      salesLocationId: ids.standB as string,
      administratorId: ids.administrator as string,
      occurredAt: at(3),
    });
    expect(retired.status).toBe("retired");

    const trashed = await trashStand(handle(), {
      salesLocationId: ids.standB as string,
      administratorId: ids.administrator as string,
      occurredAt: at(4),
    });
    expect(trashed.status).toBe("trashed");

    const restored = await restoreFromTrash(handle(), {
      subject: "stand",
      id: ids.standB as string,
      administratorId: ids.administrator as string,
      occurredAt: at(5),
    });
    expect(restored.status).toBe("restored");

    const rows = await sql()`
      select trashed_at, retired_at from sales_locations where id = ${ids.standB as string}
    `;
    expect(rows[0]?.trashed_at).toBeNull();
    expect(
      rows[0]?.retired_at,
      "a stand retired on its own must still be retired after leaving the trash",
    ).not.toBeNull();

    // Put it back for the tests below.
    await restoreStand(handle(), {
      salesLocationId: ids.standB as string,
      administratorId: ids.administrator as string,
      occurredAt: at(6),
    });
  });

  it("trashing a farm retires it and takes it out of the operator's list", async () => {
    const result = await trashFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(7),
    });
    expect(result.status).toBe("trashed");

    const rows = await sql()`
      select trashed_at, trashed_by_administrator_id, retired_at
      from sellers where id = ${ids.farm as string}
    `;
    expect(rows[0]?.trashed_at).not.toBeNull();
    expect(rows[0]?.trashed_by_administrator_id).toBe(ids.administrator);
    expect(
      rows[0]?.retired_at,
      "a trashed farm must be retired, or its stands stay on the public map",
    ).not.toBeNull();

    const farms = await listFarmsForApproval(handle());
    expect(farms.some((farm) => farm.farmId === ids.farm)).toBe(false);
    expect(
      farms.some((farm) => farm.farmId === ids.bystanderFarm),
      "trashing one farm must not remove an unrelated farm",
    ).toBe(true);

    const trashedFarms = await listFarmsForApproval(handle(), { trashed: true });
    expect(trashedFarms.map((farm) => farm.farmId)).toEqual([ids.farm]);
  });

  it("keeps everything the trashed farm owns — trash destroys nothing", async () => {
    // The whole point of trash rather than delete. If any of this were gone, restore would put
    // back an approximation of the farm rather than the farm.
    const rows = await sql()`
      select name, description from sellers where id = ${ids.farm as string}
    `;
    expect(rows[0]?.name).toBe("Trashable Farm");
    expect(rows[0]?.description).toBe("Berries and eggs");

    const stands = await sql()`
      select id from sales_locations where own_seller_id = ${ids.farm as string}
    `;
    expect(stands, "a trashed farm keeps its stands").toHaveLength(2);
  });

  it("restoring a farm from the trash puts it back in the list and on the map", async () => {
    const result = await restoreFromTrash(handle(), {
      subject: "farm",
      id: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(8),
    });
    expect(result.status).toBe("restored");

    const rows = await sql()`
      select trashed_at, retired_at from sellers where id = ${ids.farm as string}
    `;
    expect(rows[0]?.trashed_at).toBeNull();
    expect(rows[0]?.retired_at).toBeNull();

    const farms = await listFarmsForApproval(handle());
    expect(farms.some((farm) => farm.farmId === ids.farm)).toBe(true);
  });

  it("a farm retired on its own before trashing stays retired after restore", async () => {
    const { retireFarm } = await import("./index");
    await retireFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(9),
    });
    await trashFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(10),
    });
    await restoreFromTrash(handle(), {
      subject: "farm",
      id: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(11),
    });

    const rows = await sql()`
      select trashed_at, retired_at from sellers where id = ${ids.farm as string}
    `;
    expect(rows[0]?.trashed_at).toBeNull();
    expect(
      rows[0]?.retired_at,
      "a farm retired on its own must still be retired after leaving the trash",
    ).not.toBeNull();

    await restoreFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(12),
    });
  });

  it("refuses to trash the same record twice, keeping the first timestamp", async () => {
    // Idempotence would falsify WHEN the record was trashed, which is the one fact the column
    // is for. A second trash is a conflict the operator's screen can report, not a silent no-op.
    await trashFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(13),
    });
    const first = await sql()`
      select trashed_at from sellers where id = ${ids.farm as string}
    `;

    const again = await trashFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(14),
    });
    expect(again.status).toBe("already_trashed");

    const second = await sql()`
      select trashed_at from sellers where id = ${ids.farm as string}
    `;
    expect(
      (second[0]?.trashed_at as Date).getTime(),
      "a refused second trash must not move the first one's timestamp",
    ).toBe((first[0]?.trashed_at as Date).getTime());
  });

  it("refuses a caller who is not a live administrator", async () => {
    // Authority is re-read inside the transaction: a principal resolved at the start of a
    // request proves they were an administrator then, and a revocation that committed in
    // between must win.
    // `administrators_fixed_identity` pins the table to ONE email, so a second administrator
    // cannot be invented for this test. Revoking the real one and putting it back is what the
    // constraint leaves available, and it exercises the same read the writer performs.
    await sql()`
      update administrators set revoked_at = ${at(15).toISOString()}
      where id = ${ids.administrator as string}
    `;
    const result = await trashStand(handle(), {
      salesLocationId: ids.bystanderStand as string,
      administratorId: ids.administrator as string,
      occurredAt: at(15),
    });
    expect(result.status).toBe("not_an_administrator");

    const rows = await sql()`
      select trashed_at from sales_locations where id = ${ids.bystanderStand as string}
    `;
    expect(rows[0]?.trashed_at, "a refused trash must not have written anything").toBeNull();

    await sql()`
      update administrators set revoked_at = null where id = ${ids.administrator as string}
    `;
  });

  it("records who trashed and who restored, as separate audit events", async () => {
    const events = await sql()`
      select action from audit_events
      where subject_id = ${ids.standA as string}
        and action in ('stand_trashed', 'stand_restored_from_trash')
      order by occurred_at
    `;
    expect(
      events.map((row) => row.action),
      "trash and restore are each attributable to the administrator who did it",
    ).toEqual(["stand_trashed", "stand_restored_from_trash"]);
  });
});
