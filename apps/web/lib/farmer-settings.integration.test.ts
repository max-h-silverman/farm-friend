import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, issueFarmerLinkToken } from "@farm-friend/core";
import { issueFarmerLink, type Db, type Sql } from "@farm-friend/db";
import {
  handleFarmerSettingsPost,
  loadFarmerSettings,
  saveFarmerDefaultStand,
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
    await client()`truncate contacts, farms restart identity cascade`;
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
    const farms = await client()`insert into farms (name) values ('Settings Farm') returning id`;
    const farmId = farms[0]?.id as string;
    const authorizations = await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    const locationIds: string[] = [];
    for (const name of names) {
      const rows = await client()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
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
      salesLocationId: locationIds[0] as string,
      occurredAt: T0,
    });
    if (issued.status !== "issued") throw new Error("fixture link was not issued");
    return {
      authorizationId: authorizations[0]?.id as string,
      farmId,
      locationIds,
      token: issued.token,
    };
  }

  it("loads only the standing link authorization's owned locations and no contact identity", async () => {
    const own = await farmer("a".repeat(64), ["North Stand", "South Stand"]);
    const other = await farmer("b".repeat(64), ["Private Other Stand"]);

    const settings = await loadFarmerSettings(database(), own.token);

    expect(settings).toEqual({
      status: "active",
      locations: [
        { salesLocationId: own.locationIds[0], locationName: "North Stand", selected: false, cadence: null },
        { salesLocationId: own.locationIds[1], locationName: "South Stand", selected: false, cadence: null },
      ],
    });
    const serialized = JSON.stringify(settings);
    expect(serialized).not.toContain(other.locationIds[0] as string);
    expect(serialized).not.toContain("Private Other Stand");
    expect(serialized).not.toContain("a".repeat(64));
    expect(serialized).not.toMatch(/\+1\d{10}/);
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

    const saved = await saveFarmerDefaultStand(
      { db: database(), clock: new FixedClock(new Date(T0.getTime() + 1_000)) },
      { token: own.token, salesLocationId: own.locationIds[1] as string },
    );

    expect(saved).toEqual({
      status: "saved",
      salesLocationId: own.locationIds[1],
      locationName: "South Stand",
    });
    expect(await loadFarmerSettings(database(), own.token)).toMatchObject({
      status: "active",
      locations: [
        { salesLocationId: own.locationIds[0], selected: false },
        { salesLocationId: own.locationIds[1], selected: true },
      ],
    });
    expect(await client()`select state from sms_consents where recipient_hash = ${senderHash}`)
      .toEqual([{ state: "stopped" }]);
  });

  it("refuses a location outside the link authorization and a revoked or fabricated token", async () => {
    const own = await farmer("d".repeat(64), ["Own Stand"]);
    const other = await farmer("e".repeat(64), ["Other Stand"]);

    await expect(saveFarmerDefaultStand(
      { db: database(), clock: new FixedClock(T0) },
      { token: own.token, salesLocationId: other.locationIds[0] as string },
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

  it("accepts only a structured token and stand id at the settings API boundary", async () => {
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
          salesLocationId: own.locationIds[1],
        }),
      }),
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({
      status: "saved",
      salesLocationId: own.locationIds[1],
      locationName: "South Stand",
    });
  });

  it("saves one explicit cadence for the chosen stand without changing STOP consent", async () => {
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
          salesLocationId: own.locationIds[0]!,
          cadence: "weekly",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await client()`
      select designated_authorization_id, cadence, version, next_due_at
      from inventory_prompt_preferences where sales_location_id = ${own.locationIds[0]!}
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
