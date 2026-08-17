import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, issueFarmerLinkToken } from "@farm-friend/core";
import { issueFarmerLink, readNativeProviderId, type Db, type Sql } from "@farm-friend/db";
import {
  handleFarmerSettingsPost,
  loadFarmerSettings,
  saveFarmerDefaultListing,
} from "./farmer-settings";

const T0 = new Date(Date.now() - 60_000);

describe("F-051 farmer default stand settings (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_farmer_settings_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: "packages/db/drizzle" });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await client()`truncate contacts, sellers restart identity cascade`;
  });

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  function database(): Db {
    return { sql: client(), orm: {}, close: async () => {} } as unknown as Db;
  }

  async function farmer(senderHash: string, names: string[]) {
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550177', ${senderHash}, ${T0}) returning id
    `;
    const sellers = await client()`insert into sellers (name) values ('Settings Farm') returning id`;
    const farmId = sellers[0]?.id as string;
    const authorizations = await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    const locationIds: string[] = [];
    for (const name of names) {
      const rows = await client()`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        ) values (
          ${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable', 'produce',
          '1 Stand Way', 47.44, -122.46, false, false
        )
        returning id
      `;
      locationIds.push(rows[0]?.id as string);
    }
    const issued = await issueFarmerLink(database(), {
      authorizationId: authorizations[0]?.id as string,
      providerId: await readNativeProviderId(database(), {
        salesLocationId: locationIds[0] as string,
      }),
      occurredAt: T0,
    });
    if (issued.status !== "issued") throw new Error("fixture link was not issued");
    // The stand's own listing at each stand, by SELF-POINTER. The screen speaks in listings
    // now (C.4), so the cases need their ids alongside the stands'.
    const providerIds: string[] = [];
    for (const locationId of locationIds) {
      const rows = await client()`
        select id from stand_providers
        where sales_location_id = ${locationId} and seller_id = ${farmId}
      `;
      providerIds.push(rows[0]?.id as string);
    }
    return {
      authorizationId: authorizations[0]?.id as string,
      farmId,
      locationIds,
      providerIds,
      token: issued.token,
    };
  }

  it("loads only the standing link authorization's owned locations and no contact identity", async () => {
    const own = await farmer("a".repeat(64), ["North Stand", "South Stand"]);
    const other = await farmer("b".repeat(64), ["Private Other Stand"]);

    const settings = await loadFarmerSettings(database(), own.token);

    expect(settings).toEqual({
      status: "active",
      listings: [
        {
          providerId: own.providerIds[0],
          salesLocationId: own.locationIds[0],
          locationName: "North Stand",
          sellerName: "Settings Farm",
          describesOwnStand: true,
          selected: false,
          cadence: null,
        },
        {
          providerId: own.providerIds[1],
          salesLocationId: own.locationIds[1],
          locationName: "South Stand",
          sellerName: "Settings Farm",
          describesOwnStand: true,
          selected: false,
          cadence: null,
        },
      ],
    });
    const serialized = JSON.stringify(settings);
    expect(serialized).not.toContain(other.locationIds[0] as string);
    expect(serialized).not.toContain("Private Other Stand");
    expect(serialized).not.toContain("a".repeat(64));
    expect(serialized).not.toMatch(/\+1\d{10}/);
  });

  it("shows a hosted listing as its OWN row, credited to its seller", async () => {
    /*
      F-114 C.4, inverting C.3's deliberate placeholder.

      C.3 kept the stand's own listing and DROPPED the hosted one, because this screen showed
      stands and a stand rendered twice under one name is two radios that read identically and
      save different things. The row is a LISTING now, so both belong — and the seller name is
      what tells them apart.

      Credited by SELF-POINTER, never a name match: the row carries `describesOwnStand`, the
      pointer itself, and `creditSeller` decides from it on every surface (F-115 Tranche C).
      The reader states the fact; nothing downstream re-derives it from a name or a null.
    */
    const own = await farmer("e".repeat(64), ["North Stand"]);
    const guests = await client()`
      insert into sellers (name) values ('Fernhorn Bakery') returning id
    `;
    const hosted = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${own.locationIds[0] as string}, ${guests[0]?.id as string}, 'active', true,
        ${T0}, ${T0}, 'viga', ${T0}
      ) returning id
    `;

    const settings = await loadFarmerSettings(database(), own.token);
    expect(settings).toEqual({
      status: "active",
      listings: expect.arrayContaining([
        {
          providerId: own.providerIds[0],
          salesLocationId: own.locationIds[0],
          locationName: "North Stand",
          sellerName: "Settings Farm",
          describesOwnStand: true,
          selected: false,
          cadence: null,
        },
        {
          providerId: hosted[0]?.id as string,
          salesLocationId: own.locationIds[0],
          locationName: "North Stand",
          sellerName: "Fernhorn Bakery",
          describesOwnStand: false,
          selected: false,
          cadence: null,
        },
      ]),
    });
    if (settings.status !== "active") throw new Error("expected active settings");
    expect(settings.listings).toHaveLength(2);
    // Asserted as an absence too: a reader that credited EVERY seller would satisfy the
    // positive assertion above while labelling the farmer's own stand with her own name, which
    // is the `Provo Farms — Provo Farms` §suppression follows a pointer forbids.
    expect(
      settings.listings.filter((listing) => listing.describesOwnStand),
    ).toHaveLength(1);
  });

  it("refuses a farmer whose only listing is at somebody else's stand", async () => {
    // A hosted-only seller like Zoe has no stand of her own, and before C.4 this screen
    // refused her outright — her only listing was filtered away and the empty result read as
    // "not authorized". She holds a real link to a real listing now.
    const host = await farmer("g".repeat(64), ["Host Stand"]);
    const guests = await client()`
      insert into sellers (name) values ('Gracies Greens') returning id
    `;
    const guestSellerId = guests[0]?.id as string;
    const hosted = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${host.locationIds[0] as string}, ${guestSellerId}, 'active', false,
        ${T0}, ${T0}, 'viga', ${T0}
      ) returning id
    `;
    const guestHash = "h".repeat(64);
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash) values ('+12065559099', ${guestHash})
      returning id
    `;
    const guestAuth = await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${guestSellerId}, ${contacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    const issued = await issueFarmerLink(database(), {
      authorizationId: guestAuth[0]?.id as string,
      providerId: hosted[0]?.id as string,
      occurredAt: T0,
    });
    if (issued.status !== "issued") throw new Error("guest link was not issued");

    const settings = await loadFarmerSettings(database(), issued.token);
    expect(settings).toEqual({
      status: "active",
      listings: [
        {
          providerId: hosted[0]?.id as string,
          salesLocationId: host.locationIds[0],
          locationName: "Host Stand",
          sellerName: "Gracies Greens",
          describesOwnStand: false,
          selected: false,
          cadence: null,
        },
      ],
    });
  });

  it("saves and returns one revalidated exact default without changing STOP consent", async () => {
    const senderHash = "c".repeat(64);
    const own = await farmer(senderHash, ["North Stand", "South Stand"]);
    await client()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      )
      values (${senderHash}, 'stopped', 'start', ${T0}, 'settings-consent', ${T0})
    `;

    const saved = await saveFarmerDefaultListing(
      { db: database(), clock: new FixedClock(new Date(T0.getTime() + 1_000)) },
      { token: own.token, providerId: own.providerIds[1] as string },
    );

    expect(saved).toEqual({
      status: "saved",
      providerId: own.providerIds[1],
      salesLocationId: own.locationIds[1],
      locationName: "South Stand",
    });
    expect(await loadFarmerSettings(database(), own.token)).toMatchObject({
      status: "active",
      listings: [
        { providerId: own.providerIds[0], selected: false },
        { providerId: own.providerIds[1], selected: true },
      ],
    });
    expect(await client()`select state from sms_consents where recipient_hash = ${senderHash}`)
      .toEqual([{ state: "stopped" }]);
  });

  it("refuses a listing outside the link authorization and a revoked or fabricated token", async () => {
    const own = await farmer("d".repeat(64), ["Own Stand"]);
    const other = await farmer("e".repeat(64), ["Other Stand"]);

    await expect(saveFarmerDefaultListing(
      { db: database(), clock: new FixedClock(T0) },
      { token: own.token, providerId: other.providerIds[0] as string },
    )).resolves.toEqual({ status: "not_authorized" });
    expect(await client()`select * from farmer_target_contexts`).toHaveLength(0);

    await client()`
      update farmer_links set revoked_at = ${new Date(T0.getTime() + 1_000)}
      where authorization_id = ${own.authorizationId}
    `;
    await expect(loadFarmerSettings(database(), own.token)).resolves.toEqual({
      status: "not_authorized",
    });
    await expect(loadFarmerSettings(database(), issueFarmerLinkToken())).resolves.toEqual({
      status: "not_authorized",
    });
  });

  it("accepts only a structured token and LISTING id at the settings API boundary", async () => {
    const own = await farmer("f".repeat(64), ["North Stand", "South Stand"]);
    const deps = { db: database(), clock: new FixedClock(T0) };

    const malformed = await handleFarmerSettingsPost(
      deps,
      new Request("https://farmfriend.example/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: own.token }),
      }),
    );
    expect(malformed.status).toBe(400);

    const saved = await handleFarmerSettingsPost(
      deps,
      new Request("https://farmfriend.example/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: own.token,
          providerId: own.providerIds[1],
        }),
      }),
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({
      status: "saved",
      providerId: own.providerIds[1],
      salesLocationId: own.locationIds[1],
      locationName: "South Stand",
    });

    // A STAND id is now a malformed body, not a quieter way to say the same thing. Asserted
    // because the two are both UUIDs: without this the route would happily take either and the
    // seam would refuse the stand id for an unrelated reason one layer down.
    const standShaped = await handleFarmerSettingsPost(
      deps,
      new Request("https://farmfriend.example/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: own.token,
          salesLocationId: own.locationIds[1],
        }),
      }),
    );
    expect(standShaped.status).toBe(400);
  });

  it("saves one explicit cadence for the chosen LISTING without changing STOP consent", async () => {
    const senderHash = "1".repeat(64);
    const own = await farmer(senderHash, ["Cadence Stand"]);
    await client()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      ) values (${senderHash}, 'stopped', 'start', ${T0}, 'cadence-stopped', ${T0})
    `;
    const response = await handleFarmerSettingsPost(
      { db: database(), clock: new FixedClock(T0) },
      new Request("https://farmfriend.example/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: own.token,
          providerId: own.providerIds[0]!,
          cadence: "weekly",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await client()`
      select designated_authorization_id, cadence, version, next_due_at
      from inventory_prompt_preferences where provider_id = ${own.providerIds[0]!}
    `).toEqual([expect.objectContaining({
      designated_authorization_id: own.authorizationId,
      cadence: "weekly",
      version: 1,
      next_due_at: expect.any(Date),
    })]);
    expect(await client()`select state from sms_consents where recipient_hash = ${senderHash}`)
      .toEqual([{ state: "stopped" }]);
  });
});
