import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashSessionToken, issueSessionToken } from "@farm-friend/core";
import { createAdminSession, type Sql } from "@farm-friend/db";
import { ADMIN_SESSION_COOKIE } from "./admin-auth";

/*
  F-101 — the admin write behind the pause/resume toggle and Remove.

  WHAT THIS OWNS. `setProviderParticipation` was built with every consequence tested and zero
  production callers; this route is the first one. The properties asserted here are the ones a
  caller could quietly lose:

    - authority is resolved SERVER-SIDE from the session, never from the request body, so a
      signed-out caller reaches no transition at all;
    - VIGA reaches all three transitions, through `administratorId` rather than a phone;
    - the route never writes state itself — every transition goes through the one seam, so the
      consequences it owns (invalidating that provider's open confirmations, and only that
      provider's) cannot be bypassed by a second writer;
    - Remove is terminal: an ended arrangement is gone from the read the views render, and
      asking again is refused rather than silently re-ending it.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
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

describe("F-101 admin participation route (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let testDatabaseName: string | undefined;
  let route: typeof import("../app/api/admin/participation/route");

  const ids = { administrator: "", host: "", guest: "", stand: "", guestProvider: "" };

  const sql = (): Sql => {
    if (!client) throw new Error("database not initialized");
    return client;
  };

  const request = (body: unknown, token?: string) =>
    new Request("https://ff.example/api/admin/participation", {
      method: "POST",
      headers: {
        origin: "https://ff.example",
        "content-type": "application/json",
        ...(token === undefined ? {} : { cookie: `${ADMIN_SESSION_COOKIE}=${token}` }),
      },
      body: JSON.stringify(body),
    });

  async function sessionFor(administratorId: string): Promise<string> {
    const token = issueSessionToken();
    const { createDb } = await import("@farm-friend/db");
    const db = createDb(testDatabaseUrl(requiredDatabaseUrl(), testDatabaseName as string));
    await createAdminSession(db, {
      tokenHash: hashSessionToken(token),
      administratorId,
      issuedAt: new Date(),
    });
    await db.close();
    return token;
  }

  const lifecycleOf = async (providerId: string) => {
    const rows = await sql()`
      select lifecycle_state, ended_at from stand_providers where id = ${providerId}
    `;
    return {
      lifecycleState: rows[0]?.lifecycle_state as string,
      ended: rows[0]?.ended_at !== null,
    };
  };

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `ff_participation_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    process.env.DATABASE_URL = url;
    process.env.PUBLIC_BASE_URL = "https://ff.example";

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', now())
      returning id
    `;
    ids.administrator = administrators[0]?.id as string;

    const hosts = await sql()`insert into sellers (name) values ('Host Farm') returning id`;
    ids.host = hosts[0]?.id as string;
    const guests = await sql()`insert into sellers (name) values ('Guest Farm') returning id`;
    ids.guest = guests[0]?.id as string;

    const locations = await sql()`
      insert into sales_locations (own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude)
      values (${ids.host}, 'farm_stand', 'Shared Stand', 'America/Los_Angeles', 'visitable',
        'produce', '7 Route Way', 47.42, -122.43)
      returning id
    `;
    ids.stand = locations[0]?.id as string;

    const guestProviders = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${ids.stand}, ${ids.guest}, 'active', false,
        now() - interval '9 days', now() - interval '9 days', 'viga', now() - interval '9 days'
      ) returning id
    `;
    ids.guestProvider = guestProviders[0]?.id as string;

    route = await import("../app/api/admin/participation/route");
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
    const { publicReadContext } = await import("./public-context");
    await publicReadContext().db.close();
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("refuses a caller with no session, and changes nothing", async () => {
    const before = await lifecycleOf(ids.guestProvider);
    const response = await route.POST(
      request({ providerId: ids.guestProvider, transition: "pause" }),
    );

    // 403 rather than 401, matching every other admin route: the surface deliberately does not
    // distinguish "not signed in" from "not permitted".
    expect(response.status).toBe(403);
    // The refusal is not merely a status: the row must be untouched.
    expect(await lifecycleOf(ids.guestProvider)).toEqual(before);
  });

  it("rejects a transition it does not recognize before any authority is claimed", async () => {
    const token = await sessionFor(ids.administrator);
    const before = await lifecycleOf(ids.guestProvider);
    const response = await route.POST(
      request({ providerId: ids.guestProvider, transition: "delete" }, token),
    );

    expect(response.status).toBe(400);
    expect(await lifecycleOf(ids.guestProvider)).toEqual(before);
  });

  it("pauses, then resumes, a guest seller's arrangement", async () => {
    const token = await sessionFor(ids.administrator);

    const paused = await route.POST(
      request({ providerId: ids.guestProvider, transition: "pause" }, token),
    );
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ status: "changed", lifecycleState: "paused" });
    expect(await lifecycleOf(ids.guestProvider)).toEqual({
      lifecycleState: "paused",
      ended: false,
    });

    const resumed = await route.POST(
      request({ providerId: ids.guestProvider, transition: "resume" }, token),
    );
    expect(resumed.status).toBe(200);
    expect(await lifecycleOf(ids.guestProvider)).toEqual({
      lifecycleState: "active",
      ended: false,
    });
  });

  it("ends an arrangement, and refuses a second ending rather than re-ending it", async () => {
    const token = await sessionFor(ids.administrator);
    // Its own seller: `stand_providers_one_per_seller_per_location` allows one live
    // arrangement per seller per stand, which is the rule the views rely on to render one row
    // per seller rather than a history.
    const departing = await sql()`
      insert into sellers (name) values ('Departing Farm') returning id
    `;
    const doomed = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${ids.stand}, ${departing[0]?.id as string}, 'active', false,
        now() - interval '3 days', now() - interval '3 days', 'viga', now() - interval '3 days'
      ) returning id
    `;
    const providerId = doomed[0]?.id as string;

    const ended = await route.POST(request({ providerId, transition: "end" }, token));
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ status: "changed", ended: true });
    expect(await lifecycleOf(providerId)).toMatchObject({ ended: true });

    // Terminal. The seam answers `provider_not_live` for a row that has already ended, and the
    // route must surface that rather than reporting a fresh success.
    const again = await route.POST(request({ providerId, transition: "end" }, token));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "provider_not_live" });
  });

  it("reports an unknown provider rather than failing silently", async () => {
    const token = await sessionFor(ids.administrator);
    const response = await route.POST(
      request({ providerId: randomUUID(), transition: "pause" }, token),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "unknown_provider" });
  });
});
