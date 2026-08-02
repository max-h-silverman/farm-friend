import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPhone } from "@farm-friend/core";
import {
  authorizeFarmer,
  createDb,
  createFarmerInvitation,
  listOpenFarmerOnboardingRequests,
  loadFarmerInvitation,
  openFarmerOnboardingRequest,
  type Db,
  type Sql,
} from "./index";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("administrator farmer invitations (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let administratorId = "";
  let farmId = "";
  let otherFarmId = "";

  const now = new Date(Date.now() - 60 * 60 * 1000);
  const sql = () => client as Sql;
  const database = () => db as Db;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_farmer_invites_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 3 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${now}) returning id
    `;
    administratorId = administrators[0]?.id as string;
    const farms = await sql()`
      insert into farms (name) values ('Invited Farm'), ('Other Farm') returning id, name
    `;
    farmId = farms.find((farm) => farm.name === "Invited Farm")?.id as string;
    otherFarmId = farms.find((farm) => farm.name === "Other Farm")?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  it("creates a one-use farm-bound invitation and carries it into the admin queue", async () => {
    const created = await createFarmerInvitation(database(), {
      farmId,
      channel: "email",
      administratorId,
      occurredAt: now,
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;

    const active = await loadFarmerInvitation(database(), created.token, now);
    expect(active).toMatchObject({ status: "active", farmId, farmName: "Invited Farm", channel: "email" });

    const phone = "+12065550123";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    await sql()`insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})`;

    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      invitationToken: created.token,
      occurredAt: new Date(now.getTime() + 1_000),
    });
    expect(opened.status).toBe("opened");

    const queue = await listOpenFarmerOnboardingRequests(database());
    expect(queue).toEqual([
      expect.objectContaining({
        farmId,
        farmName: "Invited Farm",
      }),
    ]);
    expect(await loadFarmerInvitation(database(), created.token, new Date(now.getTime() + 2_000)))
      .toEqual({ status: "invalid" });
  });

  it("refuses authorizing an invited request for a different farm", async () => {
    const created = await createFarmerInvitation(database(), {
      farmId,
      channel: "sms",
      administratorId,
      occurredAt: new Date(now.getTime() + 10_000),
    });
    if (created.status !== "created") throw new Error("invitation fixture was not created");

    const phone = "+12065550124";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    await sql()`insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})`;
    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      invitationToken: created.token,
      occurredAt: new Date(now.getTime() + 11_000),
    });
    if (opened.status !== "opened") throw new Error("request fixture was not opened");

    expect(await authorizeFarmer(database(), {
      farmId: otherFarmId,
      requestId: opened.requestId,
      administratorId,
      occurredAt: new Date(now.getTime() + 12_000),
    })).toEqual({ status: "farm_mismatch" });
  });

  it("creates an unbound invitation for a new farm and leaves the queue farm blank", async () => {
    const created = await createFarmerInvitation(database(), {
      channel: "sms",
      administratorId,
      occurredAt: new Date(now.getTime() + 20_000),
    });
    expect(created).toMatchObject({
      status: "created",
      farmName: null,
      channel: "sms",
    });
    if (created.status !== "created") return;

    expect(await loadFarmerInvitation(database(), created.token, new Date(now.getTime() + 21_000)))
      .toMatchObject({
        status: "active",
        farmId: null,
        farmName: null,
        channel: "sms",
      });

    const phoneHash = hashPhone("+12065550125", "test-phone-salt");
    await sql()`insert into contacts (phone_e164, phone_hash) values ('+12065550125', ${phoneHash})`;
    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      invitationToken: created.token,
      occurredAt: new Date(now.getTime() + 22_000),
    });
    expect(opened.status).toBe("opened");

    expect(await listOpenFarmerOnboardingRequests(database())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ farmId: null, farmName: null }),
      ]),
    );
  });
});
