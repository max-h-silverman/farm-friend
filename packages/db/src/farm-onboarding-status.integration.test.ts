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
  listFarmsAwaitingOnboarding,
  openFarmerOnboardingRequest,
  type Db,
  type Sql,
} from "./index";

// F-071 — "ability to view onboarding link for farm that has not completed onboarded (in case
// they lose it)."
//
// The link itself CANNOT be viewed again, and that is not a limitation to work around: only
// `token_hash` is stored, and `createFarmerInvitation` returns the token exactly once. Showing
// the original would require keeping a live credential in readable form. So the affordance is
// a fresh link for a farm whose onboarding is unfinished — the same reason a site sends a
// password reset instead of the old password.
//
// This file owns the question "which farms are unfinished?", which is the part with real edge
// cases: an invitation expires after seven days, a farmer can be authorized without ever
// redeeming, and a farm can have several invitations over time. Each of those is a test.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("farms awaiting onboarding (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let administratorId = "";

  // Clock-derived, never a date literal (B-003 tripwire).
  const now = new Date(Date.now() - 60 * 60 * 1000);
  const later = (ms: number) => new Date(now.getTime() + ms);
  const sql = () => client as Sql;
  const database = () => db as Db;

  /** A farm nobody has invited yet. */
  async function farm(name: string): Promise<string> {
    const rows = await sql()`insert into farms (name) values (${name}) returning id`;
    return rows[0]?.id as string;
  }

  const names = (rows: Array<{ farmName: string }>) => rows.map((row) => row.farmName).sort();

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_onboarding_status_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  it("names a farm whose invitation is still open, with when it expires", async () => {
    const farmId = await farm("Waiting Farm");
    const created = await createFarmerInvitation(database(), {
      farmId,
      channel: "sms",
      administratorId,
      occurredAt: now,
    });
    expect(created.status).toBe("created");

    const [waiting] = await listFarmsAwaitingOnboarding(database(), now);
    expect(waiting).toMatchObject({
      farmId,
      farmName: "Waiting Farm",
      invitationState: "open",
    });
    // The operator needs to know the link dies in seven days — that is most of why they are
    // re-issuing one.
    expect(waiting?.invitationExpiresAt?.getTime()).toBe(
      created.status === "created" ? later(7 * 24 * 60 * 60 * 1000).getTime() : 0,
    );
  });

  it("carries no token, hash, or phone number for any farm", async () => {
    // Golden Rule #5, and the reason this query exists rather than a `select *`. The one
    // lookup key for a person's phone must never reach an operator page, and neither must a
    // live credential.
    const rows = await listFarmsAwaitingOnboarding(database(), now);
    expect(rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("+1206");
  });

  it("still names a farm whose invitation expired, marked as expired", async () => {
    // The whole point of the feature. A farmer who lost their link usually notices AFTER it
    // expired, so a query that hid expired invitations would hide exactly the farms an
    // operator is looking for.
    const farmId = await farm("Expired Farm");
    await createFarmerInvitation(database(), {
      farmId,
      channel: "sms",
      administratorId,
      occurredAt: now,
    });

    const eightDaysOn = later(8 * 24 * 60 * 60 * 1000);
    const expired = (await listFarmsAwaitingOnboarding(database(), eightDaysOn)).find(
      (row) => row.farmId === farmId,
    );
    expect(expired?.invitationState).toBe("expired");
  });

  it("names a farm nobody has invited at all", async () => {
    // A farm created by hand or by a seed has no invitation and no farmer. It is unfinished in
    // the only sense that matters — nobody can update its listing — so an operator who wants
    // to fix that should find it here rather than having to know it exists.
    const farmId = await farm("Uninvited Farm");
    const uninvited = (await listFarmsAwaitingOnboarding(database(), now)).find(
      (row) => row.farmId === farmId,
    );
    expect(uninvited).toMatchObject({
      farmName: "Uninvited Farm",
      invitationState: "none",
      invitationExpiresAt: null,
    });
  });

  it("drops a farm once a farmer is authorized for it, however that happened", async () => {
    // "Completed onboarding" is a LIVE AUTHORIZATION, not a redeemed invitation. Those come
    // apart: VIGA can authorize a farmer from the queue without any invitation existing, and
    // that farm is finished. Keying on redemption would strand it in this list forever.
    const farmId = await farm("Finished Farm");
    const created = await createFarmerInvitation(database(), {
      farmId,
      channel: "sms",
      administratorId,
      occurredAt: now,
    });
    if (created.status !== "created") throw new Error("expected an invitation");

    expect(names(await listFarmsAwaitingOnboarding(database(), now))).toContain("Finished Farm");

    const phone = "+12065550777";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    await sql()`insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})`;
    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      invitationToken: created.token,
      occurredAt: later(1_000),
    });
    if (opened.status !== "opened") throw new Error("expected an open request");
    const authorized = await authorizeFarmer(database(), {
      farmId,
      requestId: opened.requestId,
      administratorId,
      occurredAt: later(2_000),
    });
    expect(authorized.status).toBe("authorized");

    expect(names(await listFarmsAwaitingOnboarding(database(), now))).not.toContain(
      "Finished Farm",
    );
  });

  it("returns a farm to the list when its only farmer's access is revoked", async () => {
    // The mirror of the rule above, and the one that makes it honest: a revoked authorization
    // is not a live one, so the farm again has nobody who can update it. An operator needs to
    // see that, because the fix is the same — send them a link.
    const rows = await sql()`
      select auth.id from farmer_authorizations as auth
      join farms as farm on farm.id = auth.farm_id
      where farm.name = 'Finished Farm'
    `;
    await sql()`
      update farmer_authorizations set revoked_at = ${later(3_000)}
      where id = ${rows[0]?.id as string}
    `;

    expect(names(await listFarmsAwaitingOnboarding(database(), now))).toContain(
      "Finished Farm",
    );
  });

  it("reports one row per farm, reading only its newest invitation", async () => {
    // A farm re-invited three times is still ONE farm awaiting onboarding. Without this the
    // operator's list grows a duplicate every time they help someone, and the state shown
    // would be whichever invitation the join happened to reach first.
    const farmId = await farm("Re-invited Farm");
    for (const offset of [0, 60_000, 120_000]) {
      await createFarmerInvitation(database(), {
        farmId,
        channel: "sms",
        administratorId,
        occurredAt: later(offset),
      });
    }

    const matching = (await listFarmsAwaitingOnboarding(database(), now)).filter(
      (row) => row.farmId === farmId,
    );
    expect(matching).toHaveLength(1);
    // The NEWEST invitation's expiry, not the oldest: the operator is being told when the
    // link they most recently sent stops working.
    expect(matching[0]?.invitationExpiresAt?.getTime()).toBe(
      later(120_000 + 7 * 24 * 60 * 60 * 1000).getTime(),
    );
  });
});
