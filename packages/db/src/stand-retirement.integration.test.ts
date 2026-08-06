import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveFarm,
  openOrReviseProposal,
  confirmInventoryPublication,
  createDb,
  listStandsForAdministration,
  restoreStand,
  retireStand,
  type Db,
} from "./index";

// F-071 — retiring a stand, proven by the effects that define it.
//
// max asked to "delete" a farm/stand and chose "take it off the map, keep records". That is a
// deliberate design, not a compromise: `sales_locations` is referenced `on delete restrict` by
// published inventory revisions and by the audit trail, so a hard delete FAILS at the constraint
// for any stand with history. Retirement is also what Golden Rule #1 asks for — what a farmer
// published stays published in the record, it simply stops being served.
//
// So retirement is only real if three things hold, and each is a test below rather than a claim:
//
//   1. the stand leaves EVERY public surface — the map and both SMS retrieval queries;
//   2. the farmer can no longer publish to it, enforced where publication already re-reads
//      authority under lock, not in the caller;
//   3. the record survives — the revision that was published before retirement is still there.
//
// The suite refuses to write `retired_at` by hand: retirement comes from `retireStand` or it
// does not exist. A fixture that sets the column itself would prove the column works and leave
// the writer untested, which is the exact shape of the F-025a defect this file is modelled on.

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

describe("stand retirement (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;

  const farmerHash = "a".repeat(64);
  // Clock-derived, never a date literal (B-003 tripwire).
  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const at = (hours: number) => new Date(anchor + hours * 60 * 60 * 1000);
  const t0 = at(0);
  const clockAt = (time: Date) => ({ now: () => time });

  const ids: Record<string, string> = {};
  const sql = () => client as Sql;
  const handle = () => db as Db;

  /** A full farmer publication through the real transaction surface, as the SMS path does. */
  async function attemptPublication(when: Date, item: string): Promise<string> {
    const proposal = await openOrReviseProposal(handle(), {
      senderHash: farmerHash,
      salesLocationId: ids.location as string,
      entries: [{ entryId: `draft_${item}`, itemName: item }],
      now: when,
    });
    await proposal.activate({ providerAcceptedAt: when });

    const confirmedAt = new Date(when.getTime() + 60_000);
    const result = await confirmInventoryPublication(handle(), {
      proposalId: proposal.proposalId,
      senderHash: farmerHash,
      token: "yes",
      occurredAt: confirmedAt,
      providerEventId: `confirm-${randomUUID()}`,
      clock: clockAt(confirmedAt),
    });
    return result.status;
  }

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_retire_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);

    db = createDb(url);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550401', ${farmerHash})
      returning id
    `;
    ids.farmerContact = contacts[0]?.id as string;

    await sql()`
      insert into sms_consents (recipient_hash, state, capture_source, captured_at,
        capture_evidence_ref, updated_at)
      values (${farmerHash}, 'active', 'farmer_onboarding', ${t0.toISOString()},
        'onboarding-form-1', ${t0.toISOString()})
    `;

    const farms = await sql()`insert into farms (name) values ('Retiring Farm') returning id`;
    ids.farm = farms[0]?.id as string;

    await sql()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${ids.farm}, ${ids.farmerContact}, ${t0.toISOString()}, ${t0.toISOString()})
    `;

    const locations = await sql()`
      insert into sales_locations (owner_farm_id, kind, name, timezone, visitability,
        offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible)
      values (${ids.farm}, 'farm_stand', 'Retiring Stand', 'America/Los_Angeles', 'visitable',
        'produce', '11 Retire Row', 47.44, -122.45, false, false)
      returning id
    `;
    ids.location = locations[0]?.id as string;

    // A SECOND stand on the same farm. Retirement is per-stand, and the only way to prove that
    // is to have a sibling that must survive it untouched.
    const siblings = await sql()`
      insert into sales_locations (owner_farm_id, kind, name, timezone, visitability,
        offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible)
      values (${ids.farm}, 'farm_stand', 'Surviving Stand', 'America/Los_Angeles', 'visitable',
        'produce', '12 Retire Row', 47.43, -122.44, false, false)
      returning id
    `;
    ids.sibling = siblings[0]?.id as string;

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

  it("starts live: the farmer can publish, and the stand is not retired", async () => {
    // Anchors every later assertion. Without this, "publication refuses after retirement"
    // would also pass for a stand that could never publish in the first place.
    const retired = await sql()`
      select retired_at from sales_locations where id = ${ids.location as string}
    `;
    expect(retired[0]?.retired_at, "no fixture may pre-retire the stand").toBeNull();

    expect(await attemptPublication(at(1), "eggs")).toBe("published");
  });

  it("retires the stand, recording the acting administrator and the moment", async () => {
    const retiredAt = at(2);
    const result = await retireStand(handle(), {
      salesLocationId: ids.location as string,
      administratorId: ids.administrator as string,
      occurredAt: retiredAt,
    });
    expect(result.status).toBe("retired");

    const rows = await sql()`
      select retired_at, retired_by_administrator_id from sales_locations
      where id = ${ids.location as string}
    `;
    expect(new Date(rows[0]?.retired_at as string).getTime()).toBe(retiredAt.getTime());
    expect(rows[0]?.retired_by_administrator_id).toBe(ids.administrator);
  });

  it("refuses publication to a retired stand, at the same seam that re-reads authority", async () => {
    // The load-bearing claim. The farmer's authorization and the farm's approval are both
    // still live and untouched — retirement alone must stop the publication, and it must stop
    // it inside `confirmInventoryPublication` rather than anywhere a caller could skip.
    const authority = await sql()`
      select count(*)::int as n from farmer_authorizations
      where farm_id = ${ids.farm as string} and revoked_at is null
    `;
    expect(authority[0]?.n, "the farmer must still be authorized").toBe(1);
    const approval = await sql()`
      select count(*)::int as n from farm_approvals
      where farm_id = ${ids.farm as string} and revoked_at is null
    `;
    expect(approval[0]?.n, "the farm must still be approved").toBe(1);

    expect(await attemptPublication(at(3), "carrots")).toBe("stand_retired");
  });

  it("keeps what the farmer already published, rather than erasing it", async () => {
    // Golden Rule #1, stated as an effect. The revision published at at(1) is still the
    // current one and still says "eggs": retirement takes the stand off the map, it does not
    // rewrite or delete what the farmer said.
    const entries = await sql()`
      select entry.item_name from inventory_entries as entry
      join inventory_revisions as revision on revision.id = entry.inventory_revision_id
      where revision.sales_location_id = ${ids.location as string} and revision.is_current
    `;
    expect(entries.map((row) => row.item_name)).toEqual(["eggs"]);
  });

  it("leaves a sibling stand on the same farm untouched", async () => {
    const sibling = await sql()`
      select retired_at from sales_locations where id = ${ids.sibling as string}
    `;
    expect(sibling[0]?.retired_at).toBeNull();
  });

  it("records the retirement in the audit trail against the acting administrator", async () => {
    const audit = await sql()`
      select actor_administrator_id, subject_type, subject_id from audit_events
      where action = 'stand_retired'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_administrator_id).toBe(ids.administrator);
    expect(audit[0]?.subject_type).toBe("sales_location");
    expect(audit[0]?.subject_id).toBe(ids.location);
  });

  it("is idempotent: retiring an already-retired stand does not move the timestamp", async () => {
    const before = await sql()`
      select retired_at from sales_locations where id = ${ids.location as string}
    `;
    const result = await retireStand(handle(), {
      salesLocationId: ids.location as string,
      administratorId: ids.administrator as string,
      occurredAt: at(4),
    });
    expect(result.status).toBe("already_retired");

    const after = await sql()`
      select retired_at from sales_locations where id = ${ids.location as string}
    `;
    expect(new Date(after[0]?.retired_at as string).getTime()).toBe(
      new Date(before[0]?.retired_at as string).getTime(),
    );
    // A second audit row would claim a decision that was never made.
    const audit = await sql()`
      select count(*)::int as n from audit_events where action = 'stand_retired'
    `;
    expect(audit[0]?.n).toBe(1);
  });

  it("refuses a retirement whose caller is no longer an administrator", async () => {
    // Authority is re-read INSIDE the transaction: resolving a principal at the start of a
    // request proves they were an administrator then, not that they are one now.
    //
    // The board account is revoked and reinstated around the attempt rather than a second
    // administrator being inserted — `administrators_fixed_identity` permits exactly one
    // email, so there is no other administrator to be.
    await sql()`
      update administrators set revoked_at = ${at(1).toISOString()}
      where id = ${ids.administrator as string}
    `;
    try {
      const result = await retireStand(handle(), {
        salesLocationId: ids.sibling as string,
        administratorId: ids.administrator as string,
        occurredAt: at(5),
      });
      expect(result.status).toBe("not_an_administrator");

      const sibling = await sql()`
        select retired_at from sales_locations where id = ${ids.sibling as string}
      `;
      expect(sibling[0]?.retired_at, "a refused retirement must write nothing").toBeNull();
    } finally {
      await sql()`
        update administrators set revoked_at = null
        where id = ${ids.administrator as string}
      `;
    }
  });

  it("answers unknown_stand for a stand that does not exist", async () => {
    const result = await retireStand(handle(), {
      salesLocationId: randomUUID(),
      administratorId: ids.administrator as string,
      occurredAt: at(5),
    });
    expect(result.status).toBe("unknown_stand");
  });

  it("shows the retired state in the administrator's stand list", async () => {
    const stands = await listStandsForAdministration(handle());
    const retired = stands.find((stand) => stand.standId === ids.location);
    const surviving = stands.find((stand) => stand.standId === ids.sibling);
    expect(retired?.retired).toBe(true);
    expect(surviving?.retired).toBe(false);
  });

  it("restores a retired stand, and the farmer can publish again", async () => {
    // Reversible, as max chose. The restore is what makes retirement safe to use: an operator
    // who retires the wrong stand is not asking anyone for a database repair.
    const result = await restoreStand(handle(), {
      salesLocationId: ids.location as string,
      administratorId: ids.administrator as string,
      occurredAt: at(6),
    });
    expect(result.status).toBe("restored");

    const rows = await sql()`
      select retired_at, retired_by_administrator_id from sales_locations
      where id = ${ids.location as string}
    `;
    expect(rows[0]?.retired_at).toBeNull();
    expect(
      rows[0]?.retired_by_administrator_id,
      "restoring clears the actor with the timestamp; a stand that is not retired was retired by nobody",
    ).toBeNull();

    expect(await attemptPublication(at(7), "beans")).toBe("published");

    const audit = await sql()`
      select actor_administrator_id, subject_id from audit_events
      where action = 'stand_restored'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_administrator_id).toBe(ids.administrator);
    expect(audit[0]?.subject_id).toBe(ids.location);
  });

  it("is idempotent: restoring a live stand reports not_retired and writes nothing", async () => {
    const result = await restoreStand(handle(), {
      salesLocationId: ids.location as string,
      administratorId: ids.administrator as string,
      occurredAt: at(8),
    });
    expect(result.status).toBe("not_retired");

    const audit = await sql()`
      select count(*)::int as n from audit_events where action = 'stand_restored'
    `;
    expect(audit[0]?.n).toBe(1);
  });
});
