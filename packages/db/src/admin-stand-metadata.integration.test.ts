import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveStandMetadata } from "./admin";
import type { Db } from "./index";
import type { Sql } from "./sql";

/*
  F-101 — VIGA CORRECTS A STAND'S OWN FACTS.

  ## What this is, and what it deliberately is not

  A stand's location facts — its name, where it is, when it is open — were writable by the
  FARMER alone (F-073, `/stand/[token]/listing`) and by nobody else. VIGA could retire a stand
  and record Farm Bucks, and could not fix a misspelt stand name a customer was reading on the
  map. max settled (2026-08-17) that VIGA edits stand metadata too.

  **It is not `saveOnboardingListing` with an administrator arm.** That writer replaces the
  whole listing — payment methods, what the stand usually sells, the farmer's own description,
  and her item list. Handing an operator a form that rewrote all of that to correct an address
  would put VIGA's hand on the farmer's published words, which Golden Rule #1 forbids: the
  farmer owns published state. This writer touches the LOCATION's own facts and nothing that
  belongs to the farmer's listing.

  **The columns are named, and the ones left out are left out on purpose.** `is_public`,
  `farm_bucks_*`, `visitability`, `offering_type` and the twelve structured availability
  columns each have their own writer or their own VIGA control already; a second writer over
  any of them would be two ways to do one thing.

  ## Season and hours coherence

  `hours_text` is the farmer's own words and is free text, so it carries no constraint. The
  structured availability columns DO — `coherentSeason` refuses a half-stated season — which is
  exactly why they are not in this writer's reach.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-101 VIGA edits stand metadata (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let administratorId = "";
  let revokedAdministratorId = "";
  let standId = "";
  let sellerId = "";

  const T0 = new Date("2026-05-01T18:00:00.000Z");

  const handle = (): Db => {
    if (!sql) throw new Error("database not initialized");
    return { sql, orm: undefined as never, close: async () => {} };
  };

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_standmeta_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 5 });

    // ONE fixed identity: `administrators_fixed_identity` pins the email, and the unique
    // index applies only to live rows — so the revoked administrator this suite needs can sit
    // beside the live one under the same address.
    const administrators = await client()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', now()) returning id
    `;
    administratorId = administrators[0]?.id as string;
    const revoked = await client()`
      insert into administrators (email, authorized_at, revoked_at)
      values ('board@vigavashon.org', now(), now()) returning id
    `;
    revokedAdministratorId = revoked[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await client()`delete from audit_events`;
    await client()`delete from sales_locations`;
    await client()`delete from sellers`;
    const sellers = await client()`insert into sellers (name) values ('Hill Farm') returning id`;
    sellerId = sellers[0]?.id as string;
    const stands = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, address_public, public_latitude, public_longitude, hours_text
      ) values (
        ${sellerId}, 'farm_stand', 'Hil Farm Stnd', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        '1 Wrong Road', true, 47.4473, -122.4590, 'Dawn to dusk'
      ) returning id
    `;
    standId = stands[0]?.id as string;
  });

  async function readStand(): Promise<Record<string, unknown>> {
    const rows = await client()`
      select name, public_address, address_public, public_latitude, public_longitude,
             hours_text, is_public, visitability, farm_bucks_accepted
      from sales_locations where id = ${standId}
    `;
    return rows[0] as Record<string, unknown>;
  }

  it("saves the corrected facts and records who changed them", async () => {
    const result = await saveStandMetadata(handle(), {
      standId,
      administratorId,
      name: "Hill Farm Stand",
      publicAddress: "22 Right Road",
      addressPublic: true,
      latitude: 47.45,
      longitude: -122.46,
      hoursText: "9 to 5, most days",
      occurredAt: T0,
    });
    expect(result.status).toBe("saved");

    const stand = await readStand();
    expect(stand.name).toBe("Hill Farm Stand");
    expect(stand.public_address).toBe("22 Right Road");
    expect(stand.hours_text).toBe("9 to 5, most days");
    expect(Number(stand.public_latitude)).toBeCloseTo(47.45, 5);

    // The audit event commits with the edit or not at all — the trail is the point.
    const events = await client()`
      select action, actor_administrator_id, subject_type, subject_id from audit_events
    `;
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("stand_metadata_edited");
    expect(events[0]?.actor_administrator_id).toBe(administratorId);
    expect(events[0]?.subject_id).toBe(standId);
  });

  it("refuses a revoked administrator and changes nothing", async () => {
    const result = await saveStandMetadata(handle(), {
      standId,
      administratorId: revokedAdministratorId,
      name: "Renamed By A Ghost",
      publicAddress: "22 Right Road",
      addressPublic: true,
      latitude: null,
      longitude: null,
      hoursText: null,
      occurredAt: T0,
    });
    expect(result.status).toBe("not_an_administrator");

    const stand = await readStand();
    expect(stand.name).toBe("Hil Farm Stnd");
    expect(await client()`select id from audit_events`).toHaveLength(0);
  });

  it("refuses an unknown stand, and a blank name, without writing", async () => {
    const unknown = await saveStandMetadata(handle(), {
      standId: randomUUID(),
      administratorId,
      name: "Somewhere Else",
      publicAddress: null,
      addressPublic: false,
      latitude: null,
      longitude: null,
      hoursText: null,
      occurredAt: T0,
    });
    expect(unknown.status).toBe("unknown_stand");

    // A stand with no name is unreachable on the map and unnameable in a reply. The database
    // would take an empty string, so the refusal has to live here.
    const blank = await saveStandMetadata(handle(), {
      standId,
      administratorId,
      name: "   ",
      publicAddress: null,
      addressPublic: false,
      latitude: null,
      longitude: null,
      hoursText: null,
      occurredAt: T0,
    });
    expect(blank.status).toBe("invalid_name");

    expect((await readStand()).name).toBe("Hil Farm Stnd");
    expect(await client()`select id from audit_events`).toHaveLength(0);
  });

  it("never touches what the FARMER owns, or what another VIGA control owns", async () => {
    /*
      GOLDEN RULE #1 at the seam. An operator correcting an address must not silently take the
      stand off the map, flip its Farm Bucks decision, or change whether it can be visited —
      each of those is either the farmer's fact or another control's, and each was reachable
      by a writer that named every column.

      Asserted as VALUES rather than as an absence of columns in the SQL: a writer that set
      them to whatever it was passed would still read as "not touching" in the source.
    */
    await client()`
      update sales_locations
      set is_public = true, farm_bucks_accepted = true, visitability = 'visitable'
      where id = ${standId}
    `;

    const result = await saveStandMetadata(handle(), {
      standId,
      administratorId,
      name: "Hill Farm Stand",
      publicAddress: "22 Right Road",
      addressPublic: false,
      // The PIN is kept: `coherent_visitability` requires one on a visitable stand, and this
      // case is about what the writer leaves alone, not about that refusal.
      latitude: 47.45,
      longitude: -122.46,
      hoursText: null,
      occurredAt: T0,
    });
    expect(result.status).toBe("saved");

    const stand = await readStand();
    expect(stand.is_public).toBe(true);
    expect(stand.farm_bucks_accepted).toBe(true);
    expect(stand.visitability).toBe("visitable");
    // The fields it DOES own still moved, so the assertion above is not passing because the
    // writer did nothing at all.
    expect(stand.address_public).toBe(false);
    expect(stand.public_address).toBe("22 Right Road");
    expect(stand.hours_text).toBeNull();
  });

  it("refuses to strip a visitable stand's address or pin, rather than crashing", async () => {
    /*
      `sales_locations_coherent_visitability` requires an address AND a coordinate pair on a
      visitable stand. An operator who clears one is asking for a row the database will refuse,
      and the honest answer is a named refusal — not a constraint violation surfacing as a 500
      with nothing the operator can act on.

      Both halves, because they are two ways to reach the same broken row: no address, and no
      pin. Each asserted to leave the stand exactly as it was.
    */
    const noAddress = await saveStandMetadata(handle(), {
      standId,
      administratorId,
      name: "Hill Farm Stand",
      publicAddress: null,
      addressPublic: true,
      latitude: 47.45,
      longitude: -122.46,
      hoursText: null,
      occurredAt: T0,
    });
    expect(noAddress.status).toBe("incomplete_location");

    const noPin = await saveStandMetadata(handle(), {
      standId,
      administratorId,
      name: "Hill Farm Stand",
      publicAddress: "22 Right Road",
      addressPublic: true,
      latitude: null,
      longitude: null,
      hoursText: null,
      occurredAt: T0,
    });
    expect(noPin.status).toBe("incomplete_location");

    const stand = await readStand();
    expect(stand.name).toBe("Hil Farm Stnd");
    expect(stand.public_address).toBe("1 Wrong Road");
    expect(await client()`select id from audit_events`).toHaveLength(0);
  });
});
