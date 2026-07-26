import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hashSessionToken,
  issueMagicToken,
  issueSessionToken,
} from "@farm-friend/core";
import { createAdminSession } from "@farm-friend/db";
import { ADMIN_SESSION_COOKIE } from "./admin-auth";

// F-025a — the admin HTTP surface, against a real database.
//
// The acceptance criterion this file owns: EVERY admin route enforces the role server-side,
// and an unauthenticated or under-privileged caller is refused. That is asserted per route
// and per method, so adding a route without a guard shows up here rather than in production.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required; a skipped integration run is not green",
    );
  }
  return databaseUrl;
}

function testDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("admin routes (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let testDatabaseName: string | undefined;

  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const at = (hours: number) => new Date(anchor + hours * 60 * 60 * 1000);
  const magicSecret = "test-magic-secret";
  const ids: Record<string, string> = {};
  const sql = () => client as ReturnType<typeof postgres>;

  // Routes are imported AFTER the environment points at the throwaway database, because
  // `publicReadContext` caches its pool on first use.
  let farmsRoute: typeof import("../app/api/admin/farms/route");
  let flagsRoute: typeof import("../app/api/admin/flags/route");
  let callbackRoute: typeof import("../app/api/auth/callback/route");
  let logoutRoute: typeof import("../app/api/auth/logout/route");

  const request = (url: string, init?: RequestInit & { token?: string }) =>
    new Request(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(init?.token === undefined
          ? {}
          : { cookie: `${ADMIN_SESSION_COOKIE}=${init.token}` }),
      },
    });

  /** Mint a live session for an administrator and return its raw token. */
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

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_routes_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    process.env.DATABASE_URL = url;
    process.env.MAGIC_LINK_SECRET = magicSecret;

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('route-admin@viga.example', ${at(0).toISOString()})
      returning id
    `;
    ids.administrator = administrators[0]?.id as string;

    const farms = await sql()`
      insert into farms (name) values ('Route Farm') returning id
    `;
    ids.farm = farms[0]?.id as string;

    farmsRoute = await import("../app/api/admin/farms/route");
    flagsRoute = await import("../app/api/admin/flags/route");
    callbackRoute = await import("../app/api/auth/callback/route");
    logoutRoute = await import("../app/api/auth/logout/route");
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
    // The routes reach the database through `publicReadContext`, whose pool is cached for
    // the life of the process and has no other owner here. Closing it is what lets the
    // throwaway database be dropped; without it `dropdb` fails on the live connection.
    const { publicReadContext } = await import("./public-context");
    await publicReadContext().db.close();
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  describe("every admin route refuses an unauthorized caller", () => {
    it("refuses a caller with no session at all", async () => {
      const noCookie = () => request("https://ff.example/api/admin/farms");
      expect((await farmsRoute.GET(noCookie())).status).toBe(403);
      expect(
        (
          await farmsRoute.POST(
            request("https://ff.example/api/admin/farms", {
              method: "POST",
              body: JSON.stringify({ farmId: ids.farm, action: "approve" }),
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (await flagsRoute.GET(request("https://ff.example/api/admin/flags"))).status,
      ).toBe(403);
    });

    it("refuses a fabricated session token", async () => {
      // The token is opaque random material checked against the database, so inventing one
      // is not a matter of forging a signature — there is nothing to forge.
      const token = issueSessionToken();
      expect(
        (
          await farmsRoute.GET(
            request("https://ff.example/api/admin/farms", { token }),
          )
        ).status,
      ).toBe(403);
    });

    it("refuses a revoked session", async () => {
      const token = await sessionFor(ids.administrator as string);
      expect(
        (await farmsRoute.GET(request("https://ff.example/api/admin/farms", { token })))
          .status,
      ).toBe(200);

      await sql()`
        update admin_sessions set revoked_at = now()
        where token_hash = ${hashSessionToken(token)}
      `;
      expect(
        (await farmsRoute.GET(request("https://ff.example/api/admin/farms", { token })))
          .status,
      ).toBe(403);
    });

    it("refuses a live session whose administrator was revoked", async () => {
      const administrators = await sql()`
        insert into administrators (email, authorized_at)
        values ('revoked-route@viga.example', ${at(0).toISOString()})
        returning id
      `;
      const administratorId = administrators[0]?.id as string;
      const token = await sessionFor(administratorId);
      expect(
        (await farmsRoute.GET(request("https://ff.example/api/admin/farms", { token })))
          .status,
      ).toBe(200);

      await sql()`
        update administrators set revoked_at = now() where id = ${administratorId}
      `;
      // Immediately, not when the session would have expired.
      expect(
        (await farmsRoute.GET(request("https://ff.example/api/admin/farms", { token })))
          .status,
      ).toBe(403);
    });
  });

  describe("magic-link callback", () => {
    it("refuses a valid link for an email that is not an administrator", async () => {
      // Holding a valid link proves control of an address; it does not make you an operator.
      // This is what keeps the public callback URL from being first-user-wins.
      const token = issueMagicToken(
        "stranger@example.com",
        magicSecret,
        { now: () => new Date() },
        60_000,
      );
      const sessionsBefore = await sql()`select count(*)::int as n from admin_sessions`;

      const response = await callbackRoute.GET(
        request(`https://ff.example/api/auth/callback?token=${token}`),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();

      // Nothing was created on their behalf. Auto-provisioning here — "they proved the
      // email, so make them an operator" — would be first-user-wins on a public URL, which
      // is the specific hole the seed-script decision exists to close.
      const administrators = await sql()`
        select id from administrators where email = 'stranger@example.com'
      `;
      expect(administrators).toHaveLength(0);

      const sessionsAfter = await sql()`select count(*)::int as n from admin_sessions`;
      expect(sessionsAfter[0]?.n).toBe(sessionsBefore[0]?.n);
    });

    it("refuses a tampered or expired link", async () => {
      const valid = issueMagicToken(
        "route-admin@viga.example",
        magicSecret,
        { now: () => new Date() },
        60_000,
      );
      const tampered = `${valid.slice(0, -2)}xy`;
      expect(
        (
          await callbackRoute.GET(
            request(`https://ff.example/api/auth/callback?token=${tampered}`),
          )
        ).status,
      ).toBe(401);

      const expired = issueMagicToken(
        "route-admin@viga.example",
        magicSecret,
        { now: () => new Date(Date.now() - 120_000) },
        60_000,
      );
      expect(
        (
          await callbackRoute.GET(
            request(`https://ff.example/api/auth/callback?token=${expired}`),
          )
        ).status,
      ).toBe(401);
    });

    it("establishes a session for a provisioned administrator, in the cookie only", async () => {
      const token = issueMagicToken(
        "route-admin@viga.example",
        magicSecret,
        { now: () => new Date() },
        60_000,
      );
      const response = await callbackRoute.GET(
        request(`https://ff.example/api/auth/callback?token=${token}`),
      );
      expect(response.status).toBe(303);

      const cookie = response.headers.get("set-cookie");
      expect(cookie).toContain(`${ADMIN_SESSION_COOKIE}=`);
      expect(cookie).toMatch(/HttpOnly/i);

      // The credential must NOT be in the body — a JSON token is one copied curl away.
      expect(await response.text()).toBe("");

      // And the session it minted actually authorizes.
      const sessionToken = /ff_admin_session=([0-9a-f]{64})/.exec(cookie ?? "")?.[1];
      expect(sessionToken).toBeDefined();
      expect(
        (
          await farmsRoute.GET(
            request("https://ff.example/api/admin/farms", { token: sessionToken }),
          )
        ).status,
      ).toBe(200);
    });
  });

  describe("approval through the route", () => {
    it("approves and revokes, recording the SESSION's administrator not the body's", async () => {
      const token = await sessionFor(ids.administrator as string);
      const impostor = await sql()`
        insert into administrators (email, authorized_at)
        values ('impostor@viga.example', ${at(0).toISOString()})
        returning id
      `;

      const approve = await farmsRoute.POST(
        request("https://ff.example/api/admin/farms", {
          method: "POST",
          token,
          // A caller naming someone else must not be able to act as them.
          body: JSON.stringify({
            farmId: ids.farm,
            action: "approve",
            administratorId: impostor[0]?.id,
          }),
        }),
      );
      expect(approve.status).toBe(200);

      const rows = await sql()`
        select administrator_id from farm_approvals
        where farm_id = ${ids.farm as string} and revoked_at is null
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.administrator_id).toBe(ids.administrator);
      expect(rows[0]?.administrator_id).not.toBe(impostor[0]?.id);

      const revoke = await farmsRoute.POST(
        request("https://ff.example/api/admin/farms", {
          method: "POST",
          token,
          body: JSON.stringify({ farmId: ids.farm, action: "revoke" }),
        }),
      );
      expect(revoke.status).toBe(200);
      const after = await sql()`
        select id from farm_approvals
        where farm_id = ${ids.farm as string} and revoked_at is null
      `;
      expect(after).toHaveLength(0);
    });

    it("rejects a malformed or unknown request without touching approval state", async () => {
      const token = await sessionFor(ids.administrator as string);
      const before = await sql()`select count(*)::int as n from farm_approvals`;

      for (const body of [
        {},
        { farmId: ids.farm },
        { action: "approve" },
        { farmId: ids.farm, action: "delete" },
        { farmId: 42, action: "approve" },
      ]) {
        const response = await farmsRoute.POST(
          request("https://ff.example/api/admin/farms", {
            method: "POST",
            token,
            body: JSON.stringify(body),
          }),
        );
        expect(response.status, JSON.stringify(body)).toBe(400);
      }

      const unknownFarm = await farmsRoute.POST(
        request("https://ff.example/api/admin/farms", {
          method: "POST",
          token,
          body: JSON.stringify({ farmId: randomUUID(), action: "approve" }),
        }),
      );
      expect(unknownFarm.status).toBe(404);

      const after = await sql()`select count(*)::int as n from farm_approvals`;
      expect(after[0]?.n).toBe(before[0]?.n);
    });

    it("exposes no phone number in the approval queue (Golden Rule #5)", async () => {
      const token = await sessionFor(ids.administrator as string);
      const response = await farmsRoute.GET(
        request("https://ff.example/api/admin/farms", { token }),
      );
      const body = await response.text();

      // No raw E.164 and no phone hash: approving a farm needs neither.
      expect(body).not.toMatch(/\+1\d{10}/);
      expect(body).not.toMatch(/[0-9a-f]{64}/);
    });
  });

  describe("logout", () => {
    it("revokes the durable session, not just the browser cookie", async () => {
      const token = await sessionFor(ids.administrator as string);
      const response = await logoutRoute.POST(
        request("https://ff.example/api/auth/logout", { method: "POST", token }),
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);

      // The copied token is dead server-side — clearing the cookie alone would have left a
      // working credential behind for anyone who had it.
      expect(
        (await farmsRoute.GET(request("https://ff.example/api/admin/farms", { token })))
          .status,
      ).toBe(403);
    });
  });
});
