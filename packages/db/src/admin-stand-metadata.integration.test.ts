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

  VIGA may correct the complete onboarding listing. The writer validates structured availability
  as one statement and updates stand facts plus owning-seller facts in one transaction. Live
  inventory remains a dated publication and is deliberately outside this writer.
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
    // Published inventory is immutable by design. Each case gets fresh identities, and the
    // isolated database drop owns cleanup for all history at the end of the suite.
    const sellers = await client()`insert into sellers (name) values ('Hill Farm') returning id`;
    sellerId = sellers[0]?.id as string;
    const stands = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
        public_address, address_public, public_latitude, public_longitude, hours_text
      ) values (
        ${sellerId}, 'farm_stand', 'Hil Farm Stnd', 'America/Los_Angeles', 'visitable',
        'produce', true, '1 Wrong Road', true, 47.4473, -122.4590, 'Dawn to dusk'
      ) returning id
    `;
    standId = stands[0]?.id as string;
    await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      ) values (${standId}, ${sellerId}, 'active', now(), now(), 'viga', now())
      on conflict do nothing
    `;
  });

  async function readStand(): Promise<Record<string, unknown>> {
    const rows = await client()`
      select name, public_address, address_public, public_latitude, public_longitude,
             hours_text, is_public, visitability
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
      select action, actor_administrator_id, subject_type, subject_id
      from audit_events where subject_id = ${standId}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("stand_metadata_edited");
    expect(events[0]?.actor_administrator_id).toBe(administratorId);
    expect(events[0]?.subject_id).toBe(standId);
  });

  it("saves the complete onboarding listing without changing live inventory", async () => {
    await client()`insert into inventory_revisions (sales_location_id, seller_id, provider_id, source, published_at, is_current)
      select ${standId}, ${sellerId}, id, 'viga', now(), true from stand_providers where sales_location_id = ${standId}`;
    const revision = await client()`select id from inventory_revisions where sales_location_id = ${standId}`;
    await client()`insert into inventory_entries (inventory_revision_id, sales_location_id, item_name, sort_order) values (${revision[0]!.id as string}, ${standId}, 'Eggs today', 0)`;

    const result = await saveStandMetadata(handle(), {
      standId, administratorId, name: "Hill Farm Stand", publicAddress: "22 Right Road",
      addressPublic: false, latitude: 47.45, longitude: -122.46, hoursText: "Weekends",
      listing: {
        visitability: "visitable", offeringType: "produce", pricesPublic: true,
        availability: {
          seasonKind: "year_round", seasonStartMonth: null, seasonStartDay: null,
          seasonEndMonth: null, seasonEndDay: null, seasonNames: null,
          openHoursKind: "clock_range", openFromMinutes: 540, openUntilMinutes: 1020,
          openDays: [0, 6], stockingCadence: "specific_days", stockingDays: [5],
        },
        paymentMethods: ["Cash", "Venmo"], farmBucksAccepted: false,
        items: [{ name: "Eggs", price: { amount: "6", quantity: "12", unit: null, basis: "for" } }],
        description: "Honor system.",
      },
      occurredAt: T0,
    });
    expect(result.status).toBe("saved");
    const location = await client()`select visitability, offering_type, prices_public, season_kind, open_days, stocking_days from sales_locations where id = ${standId}`;
    expect(location[0]).toMatchObject({ visitability: "visitable", offering_type: "produce", prices_public: true, season_kind: "year_round", open_days: [0, 6], stocking_days: [5] });
    expect(await client()`select method from seller_payment_methods where seller_id = ${sellerId} order by method`).toEqual([{ method: "Cash" }, { method: "Venmo" }]);
    expect(await client()`select display_name, price_amount::text from stand_items where sales_location_id = ${standId} and usually_carried`).toEqual([{ display_name: "Eggs", price_amount: "6.00" }]);
    expect(await client()`select item_name from inventory_entries where sales_location_id = ${standId}`).toEqual([{ item_name: "Eggs today" }]);
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
    expect(await client()`select id from audit_events where subject_id = ${standId}`).toHaveLength(0);
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
    expect(await client()`select id from audit_events where subject_id = ${standId}`).toHaveLength(0);
  });

  it("a metadata-only caller does not reset omitted listing fields or map state", async () => {
    /*
      Backward-compatible metadata calls do not carry the full listing arm. They must not
      silently take the stand off the map or reset fields they omitted.

      Asserted as VALUES rather than as an absence of columns in the SQL: a writer that set
      them to whatever it was passed would still read as "not touching" in the source.
    */
    await client()`
      update sales_locations
      set is_public = true, visitability = 'visitable'
      where id = ${standId}
    `;
    // Set AGAINST the column default, so a writer that wrongly reset it would flip to true
    // and fail. Left at the default this would pass without proving anything.
    await client()`update sellers set farm_bucks_accepted = false where id = ${sellerId}`;

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
    expect(stand.visitability).toBe("visitable");
    // A metadata-only legacy call omits the complete listing arm, so it must not reset the
    // seller's Farm Bucks answer. Asserted as a value so a no-op cannot masquerade as coverage.
    const seller = await client()`
      select farm_bucks_accepted from sellers where id = ${sellerId}
    `;
    expect(seller[0]!.farm_bucks_accepted).toBe(false);
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
    expect(await client()`select id from audit_events where subject_id = ${standId}`).toHaveLength(0);
  });
});
