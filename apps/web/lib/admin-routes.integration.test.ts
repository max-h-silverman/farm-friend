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
import { createAdminSession, type Sql } from "@farm-friend/db";
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
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let testDatabaseName: string | undefined;

  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const at = (hours: number) => new Date(anchor + hours * 60 * 60 * 1000);
  const magicSecret = "test-magic-secret";
  const ids: Record<string, string> = {};
  let farmerCounter = 0;
  const sql = () => client as Sql;

  // Routes are imported AFTER the environment points at the throwaway database, because
  // `publicReadContext` caches its pool on first use.
  let farmsRoute: typeof import("../app/api/admin/farms/route");
  let flagsRoute: typeof import("../app/api/admin/flags/route");
  let threadRoute: typeof import("../app/api/admin/flags/[flagId]/thread/route");
  let reportsRoute: typeof import("../app/api/admin/stock-out-reports/route");
  let standDataRoute: typeof import("../app/api/admin/stand-data-flags/route");
  let farmersRoute: typeof import("../app/api/admin/farmers/route");
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
    // F-040: the farmer route builds a standing link against the CONFIGURED origin.
    process.env.PUBLIC_BASE_URL = "https://ff.example";

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
    threadRoute = await import("../app/api/admin/flags/[flagId]/thread/route");
    reportsRoute = await import("../app/api/admin/stock-out-reports/route");
    standDataRoute = await import("../app/api/admin/stand-data-flags/route");
    farmersRoute = await import("../app/api/admin/farmers/route");
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

      // F-030's routes. Every method on every one of them, so a new handler that forgets its
      // guard fails here rather than in production.
      expect(
        (
          await flagsRoute.POST(
            request("https://ff.example/api/admin/flags", {
              method: "POST",
              body: JSON.stringify({
                flagId: randomUUID(),
                action: "resolve",
                dispositionCode: "handled",
              }),
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await threadRoute.GET(
            request(`https://ff.example/api/admin/flags/${randomUUID()}/thread`),
            { params: { flagId: randomUUID() } },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await reportsRoute.GET(
            request("https://ff.example/api/admin/stock-out-reports"),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await reportsRoute.POST(
            request("https://ff.example/api/admin/stock-out-reports", {
              method: "POST",
              body: JSON.stringify({ reportId: randomUUID(), action: "review" }),
            }),
          )
        ).status,
      ).toBe(403);

      // F-040's route, both methods. The farmer surface grants publication authority and
      // revokes standing links, so an unguarded handler here is authority over every farm's
      // published state.
      expect(
        (await farmersRoute.GET(request("https://ff.example/api/admin/farmers"))).status,
      ).toBe(403);
      expect(
        (
          await farmersRoute.POST(
            request("https://ff.example/api/admin/farmers", {
              method: "POST",
              body: JSON.stringify({
                action: "authorize",
                farmId: ids.farm,
                contactHash: "a".repeat(64),
              }),
            }),
          )
        ).status,
      ).toBe(403);

      // F-037's route, both methods, same rule: a handler that forgets its guard fails here.
      expect(
        (
          await standDataRoute.GET(
            request("https://ff.example/api/admin/stand-data-flags"),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await standDataRoute.POST(
            request("https://ff.example/api/admin/stand-data-flags", {
              method: "POST",
              body: JSON.stringify({ flagId: randomUUID(), note: "decided" }),
            }),
          )
        ).status,
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

    // GL-004 — one link, one session. The email has always said "can be used once"; until
    // this item nothing enforced it, so a link that was forwarded, logged by a mail gateway,
    // or left in a shared inbox stayed a working credential for its whole 15 minutes.

    it("refuses a link that has already been used, with no second session", async () => {
      const link = issueMagicToken(
        "route-admin@viga.example",
        magicSecret,
        { now: () => new Date() },
        60_000,
      );
      const url = `https://ff.example/api/auth/callback?token=${link}`;

      const first = await callbackRoute.GET(request(url));
      expect(first.status).toBe(303);
      const firstCookie = first.headers.get("set-cookie") ?? "";
      const firstSession = /ff_admin_session=([0-9a-f]{64})/.exec(firstCookie)?.[1];
      expect(firstSession).toBeDefined();

      const before = await sql()`select count(*)::int as n from admin_sessions`;

      // Same link, still well inside its window, replayed.
      const replay = await callbackRoute.GET(request(url));

      // Indistinguishable from any other refusal — a distinct status would tell whoever holds
      // a copied link that it was genuine and merely spent, which is the same disclosure the
      // stranger case refuses to make.
      expect(replay.status).toBe(401);
      expect(replay.headers.get("set-cookie")).toBeNull();

      const after = await sql()`select count(*)::int as n from admin_sessions`;
      expect(after[0]?.n).toBe(before[0]?.n);

      // The operator's real session survives the replay: a burnt link must not log them out.
      expect(
        (
          await farmsRoute.GET(
            request("https://ff.example/api/admin/farms", { token: firstSession }),
          )
        ).status,
      ).toBe(200);
    });

    it("mints one session when a link is opened EIGHT times at once", async () => {
      // The real shape of a replay is often concurrent — a mail scanner and the operator
      // opening the same link within milliseconds. A check-then-write would let several
      // through.
      const link = issueMagicToken(
        "route-admin@viga.example",
        magicSecret,
        { now: () => new Date() },
        60_000,
      );
      const url = `https://ff.example/api/auth/callback?token=${link}`;
      const before = await sql()`select count(*)::int as n from admin_sessions`;

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => callbackRoute.GET(request(url))),
      );

      expect(responses.filter((r) => r.status === 303)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 401)).toHaveLength(7);

      const after = await sql()`select count(*)::int as n from admin_sessions`;
      expect(after[0]?.n).toBe((before[0]?.n as number) + 1);
    });

    it("gives two separate links two separate sessions", async () => {
      // Single use is per LINK, not per administrator: an operator who requests a second link
      // because the first was slow must still be able to sign in with it.
      const clock = { now: () => new Date() };
      const a = issueMagicToken("route-admin@viga.example", magicSecret, clock, 60_000);
      const b = issueMagicToken("route-admin@viga.example", magicSecret, clock, 60_000);

      const first = await callbackRoute.GET(
        request(`https://ff.example/api/auth/callback?token=${a}`),
      );
      const second = await callbackRoute.GET(
        request(`https://ff.example/api/auth/callback?token=${b}`),
      );
      expect(first.status).toBe(303);
      expect(second.status).toBe(303);
      expect(second.headers.get("set-cookie")).not.toBe(first.headers.get("set-cookie"));
    });

    it("refuses an expired link that was never used", async () => {
      // Expiry did not become the weaker check. An unspent link past its window is still dead,
      // and consuming nothing.
      const expired = issueMagicToken(
        "route-admin@viga.example",
        magicSecret,
        { now: () => new Date(Date.now() - 120_000) },
        60_000,
      );
      const before = await sql()`select count(*)::int as n from admin_sessions`;
      const response = await callbackRoute.GET(
        request(`https://ff.example/api/auth/callback?token=${expired}`),
      );
      expect(response.status).toBe(401);
      const after = await sql()`select count(*)::int as n from admin_sessions`;
      expect(after[0]?.n).toBe(before[0]?.n);
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

  describe("the review queues through their routes (F-030)", () => {
    /** A flagged inbound message on a real contact, the way routing writes one. */
    async function flaggedMessage(body: string): Promise<{ flagId: string }> {
      const senderHash = "d".repeat(64);
      const existing = await sql()`
        select phone_hash from contacts where phone_hash = ${senderHash}
      `;
      if (existing.length === 0) {
        await sql()`
          insert into contacts (phone_e164, phone_hash)
          values ('+12065550801', ${senderHash})
        `;
      }
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const messages = await sql()`
        insert into sms_messages (
          provider_message_id, sender_hash, body, body_expires_at, received_at
        )
        values (
          ${`msg-${randomUUID()}`}, ${senderHash}, ${body},
          ${expiresAt.toISOString()}, ${at(1).toISOString()}
        )
        returning id
      `;
      const events = await sql()`
        insert into provider_inbox_events (
          provider_event_id, event_type, message_id, sender_hash, occurred_at,
          state, finalized_at
        )
        values (
          ${`evt-${randomUUID()}`}, 'message_received', ${messages[0]?.id as string},
          ${senderHash}, ${at(1).toISOString()}, 'processed', ${at(1).toISOString()}
        )
        returning id
      `;
      const flags = await sql()`
        insert into flags (contact_hash, inbox_event_id, reason_code, status, created_at)
        values (
          ${senderHash}, ${events[0]?.id as string}, 'sender_flagged', 'open',
          ${at(1).toISOString()}
        )
        returning id
      `;
      return { flagId: flags[0]?.id as string };
    }

    it("lists open flags and resolves one, recording the SESSION's administrator", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { flagId } = await flaggedMessage("something is wrong here");

      const listed = await flagsRoute.GET(
        request("https://ff.example/api/admin/flags", { token }),
      );
      expect(listed.status).toBe(200);
      const payload = (await listed.json()) as { flags: { flagId: string }[] };
      expect(payload.flags.map((flag) => flag.flagId)).toContain(flagId);

      const impostor = await sql()`
        insert into administrators (email, authorized_at)
        values (${`flag-impostor-${randomUUID()}@viga.example`}, ${at(0).toISOString()})
        returning id
      `;
      const resolved = await flagsRoute.POST(
        request("https://ff.example/api/admin/flags", {
          method: "POST",
          token,
          // Naming someone else must not make them the actor.
          body: JSON.stringify({
            flagId,
            action: "resolve",
            dispositionCode: "spoke_with_sender",
            administratorId: impostor[0]?.id,
          }),
        }),
      );
      expect(resolved.status).toBe(200);

      const rows = await sql()`
        select status, disposed_by_administrator_id from flags where id = ${flagId}
      `;
      expect(rows[0]?.status).toBe("resolved");
      expect(rows[0]?.disposed_by_administrator_id).toBe(ids.administrator);
      expect(rows[0]?.disposed_by_administrator_id).not.toBe(impostor[0]?.id);
    });

    it("shows the flagged thread with the sender masked and no phone material", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { flagId } = await flaggedMessage("please have someone call me");

      const response = await threadRoute.GET(
        request(`https://ff.example/api/admin/flags/${flagId}/thread`, { token }),
        { params: { flagId } },
      );
      expect(response.status).toBe(200);
      const body = await response.text();

      // The masked form is present and the raw material is not — asserted on the whole
      // serialized response, so a future field carrying either fails here.
      expect(body).toContain("0801");
      expect(body).not.toMatch(/\+1\d{10}/);
      expect(body).not.toMatch(/[0-9a-f]{64}/);
      expect(body).toContain("please have someone call me");
    });

    it("refuses a malformed flag decision without disposing anything", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { flagId } = await flaggedMessage("leave me open");

      for (const payload of [
        {},
        { flagId },
        { action: "resolve" },
        { flagId, action: "delete", dispositionCode: "x" },
        { flagId: 42, action: "resolve", dispositionCode: "x" },
        { flagId, action: "resolve", dispositionCode: "" },
      ]) {
        const response = await flagsRoute.POST(
          request("https://ff.example/api/admin/flags", {
            method: "POST",
            token,
            body: JSON.stringify(payload),
          }),
        );
        expect(response.status, JSON.stringify(payload)).toBe(400);
      }

      const rows = await sql()`select status from flags where id = ${flagId}`;
      expect(rows[0]?.status).toBe("open");
    });

    it("lists stock-out reports and triages one", async () => {
      const token = await sessionFor(ids.administrator as string);
      const locations = await sql()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${ids.farm as string}, 'farm_stand', 'Route Stand', 'America/Los_Angeles', '1 Vashon Hwy',
          47.4, -122.4, false, false
        )
        returning id
      `;
      const reports = await sql()`
        insert into stock_out_reports (
          sales_location_id, unlisted_item_text, status, reported_at
        )
        values (${locations[0]?.id as string}, 'green beans', 'open', ${at(1).toISOString()})
        returning id
      `;
      const reportId = reports[0]?.id as string;

      const listed = await reportsRoute.GET(
        request("https://ff.example/api/admin/stock-out-reports", { token }),
      );
      expect(listed.status).toBe(200);
      const listedBody = await listed.text();
      expect(listedBody).toContain("green beans");
      // A report has no reporter; the queue must not acquire one.
      expect(listedBody).not.toMatch(/\+1\d{10}/);
      expect(listedBody).not.toMatch(/[0-9a-f]{64}/);

      const triaged = await reportsRoute.POST(
        request("https://ff.example/api/admin/stock-out-reports", {
          method: "POST",
          token,
          body: JSON.stringify({ reportId, action: "review" }),
        }),
      );
      expect(triaged.status).toBe(200);

      const rows = await sql()`
        select status, reviewed_by_administrator_id from stock_out_reports
        where id = ${reportId}
      `;
      expect(rows[0]?.status).toBe("reviewed");
      expect(rows[0]?.reviewed_by_administrator_id).toBe(ids.administrator);
    });

    it("refuses a malformed triage without touching the report", async () => {
      const token = await sessionFor(ids.administrator as string);
      const before = await sql()`
        select count(*)::int as n from stock_out_reports where status <> 'open'
      `;

      for (const payload of [
        {},
        { reportId: randomUUID() },
        { action: "review" },
        { reportId: randomUUID(), action: "delete" },
        { reportId: 42, action: "review" },
      ]) {
        const response = await reportsRoute.POST(
          request("https://ff.example/api/admin/stock-out-reports", {
            method: "POST",
            token,
            body: JSON.stringify(payload),
          }),
        );
        expect(response.status, JSON.stringify(payload)).toBe(400);
      }

      const after = await sql()`
        select count(*)::int as n from stock_out_reports where status <> 'open'
      `;
      expect(after[0]?.n).toBe(before[0]?.n);
    });

    it("returns 404 for a thread whose flag does not exist", async () => {
      const token = await sessionFor(ids.administrator as string);
      const flagId = randomUUID();
      const response = await threadRoute.GET(
        request(`https://ff.example/api/admin/flags/${flagId}/thread`, { token }),
        { params: { flagId } },
      );
      expect(response.status).toBe(404);
    });
  });

  describe("the stand-data flag queue through its route (F-037)", () => {
    /** A seeded stand with one open data flag, the way the loader writes them. */
    async function standDataFlag(): Promise<{ flagId: string }> {
      const farms = await sql()`
        insert into farms (name) values (${`Data Farm ${randomUUID()}`}) returning id
      `;
      const locations = await sql()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${farms[0]?.id as string}, 'farm_stand', ${`Data Stand ${randomUUID()}`}, 'America/Los_Angeles',
          '9 Vashon Hwy', 47.42, -122.44, false, false
        )
        returning id
      `;
      const flags = await sql()`
        insert into stand_data_flags (sales_location_id, reason, source_text)
        values (
          ${locations[0]?.id as string}, 'contradictory_hours',
          'Open: 9-5 | Open: dawn to dusk'
        )
        returning id
      `;
      return { flagId: flags[0]?.id as string };
    }

    it("lists open flags and resolves one, recording the SESSION's administrator", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { flagId } = await standDataFlag();

      const listed = await standDataRoute.GET(
        request("https://ff.example/api/admin/stand-data-flags", { token }),
      );
      expect(listed.status).toBe(200);
      const payload = (await listed.json()) as { flags: { flagId: string }[] };
      expect(payload.flags.map((flag) => flag.flagId)).toContain(flagId);

      const impostor = await sql()`
        insert into administrators (email, authorized_at)
        values (${`stand-impostor-${randomUUID()}@viga.example`}, ${at(0).toISOString()})
        returning id
      `;
      const resolved = await standDataRoute.POST(
        request("https://ff.example/api/admin/stand-data-flags", {
          method: "POST",
          token,
          // Naming someone else must not make them the actor.
          body: JSON.stringify({
            flagId,
            note: "confirmed with the farmer",
            administratorId: impostor[0]?.id,
          }),
        }),
      );
      expect(resolved.status).toBe(200);

      const rows = await sql()`
        select resolution_note, resolved_by_administrator_id
        from stand_data_flags where id = ${flagId}
      `;
      expect(rows[0]?.resolution_note).toBe("confirmed with the farmer");
      expect(rows[0]?.resolved_by_administrator_id).toBe(ids.administrator);

      // A second operator's decision is refused, not overwritten.
      const again = await standDataRoute.POST(
        request("https://ff.example/api/admin/stand-data-flags", {
          method: "POST",
          token,
          body: JSON.stringify({ flagId, note: "a different decision" }),
        }),
      );
      expect(again.status).toBe(409);
    });

    it("refuses a resolution without a note, without resolving anything", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { flagId } = await standDataFlag();

      for (const body of [
        { flagId },
        { flagId, note: "" },
        { flagId, note: "   " },
        { note: "decided but no flag" },
      ]) {
        const response = await standDataRoute.POST(
          request("https://ff.example/api/admin/stand-data-flags", {
            method: "POST",
            token,
            body: JSON.stringify(body),
          }),
        );
        expect(response.status).toBe(400);
      }

      const rows = await sql()`
        select resolved_at from stand_data_flags where id = ${flagId}
      `;
      expect(rows[0]?.resolved_at).toBeNull();
    });
  });


  describe("the farmer authorization surface through its route (F-040)", () => {
    /** A contact and a farm, the shape VIGA acts on. */
    async function farmerAndFarm(): Promise<{
      contactHash: string;
      farmId: string;
    }> {
      const suffix = String(2000 + farmerCounter);
      farmerCounter += 1;
      const contactHash = `f${farmerCounter.toString(16)}`.padStart(64, "0");
      await sql()`
        insert into contacts (phone_e164, phone_hash)
        values (${`+1206555${suffix}`}, ${contactHash})
        on conflict (phone_hash) do nothing
      `;
      const farms = await sql()`
        insert into farms (name) values (${`Farmer Farm ${randomUUID()}`}) returning id
      `;
      return { contactHash, farmId: farms[0]?.id as string };
    }

    it("authorizes a farmer, recording the SESSION's administrator not the body's", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { contactHash, farmId } = await farmerAndFarm();
      const impostor = await sql()`
        insert into administrators (email, authorized_at)
        values (${`farmer-impostor-${randomUUID()}@viga.example`}, ${at(0).toISOString()})
        returning id
      `;

      const response = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          // Naming someone else must not make them the actor.
          body: JSON.stringify({
            action: "authorize",
            farmId,
            contactHash,
            administratorId: impostor[0]?.id,
          }),
        }),
      );
      expect(response.status).toBe(200);

      const audit = await sql()`
        select actor_administrator_id from audit_events
        where action = 'farmer_authorized'
        order by occurred_at desc limit 1
      `;
      expect(audit[0]?.actor_administrator_id).toBe(ids.administrator);
      expect(audit[0]?.actor_administrator_id).not.toBe(impostor[0]?.id);
    });

    it("lists the queue without exposing a phone number or a hash", async () => {
      // Golden Rule #5, asserted on the whole serialized response so a future field
      // carrying either fails here.
      //
      // BOTH arrays must be populated for this to prove anything. Sabotage caught exactly
      // that gap: adding a `contactHash` to the pending-REQUEST projection survived the
      // whole suite, because the only fixture here had an authorization and no open
      // request, so the requests array was empty and had nothing to leak.
      const token = await sessionFor(ids.administrator as string);
      const { contactHash, farmId } = await farmerAndFarm();
      await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({ action: "authorize", farmId, contactHash }),
        }),
      );

      // An OPEN request too — a farmer who texted SIGNUP and is still waiting.
      const waiting = await farmerAndFarm();
      await sql()`
        insert into farmer_onboarding_requests (contact_hash, requested_at)
        values (${waiting.contactHash}, ${at(1).toISOString()})
      `;

      const listed = await farmersRoute.GET(
        request("https://ff.example/api/admin/farmers", { token }),
      );
      expect(listed.status).toBe(200);
      const body = await listed.text();
      const payload = (await new Response(body).json()) as {
        requests: unknown[];
        authorizations: unknown[];
      };

      // Neither array is empty, so neither assertion below is vacuous.
      expect(payload.requests.length).toBeGreaterThan(0);
      expect(payload.authorizations.length).toBeGreaterThan(0);

      expect(body).not.toMatch(/\+1\d{10}/);
      expect(body).not.toMatch(/[0-9a-f]{64}/);
      // The masked form IS present, so this is not passing because the queue is empty.
      expect(body).toContain("•••");
    });

    it("returns a fresh link ONCE and never again from the queue", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { contactHash, farmId } = await farmerAndFarm();
      const authorized = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({ action: "authorize", farmId, contactHash }),
        }),
      );
      expect(authorized.status).toBe(200);

      const rows = await sql()`
        select a.id from farmer_authorizations a
        join contacts c on c.id = a.contact_id
        where c.phone_hash = ${contactHash} and a.revoked_at is null
      `;
      const authorizationId = rows[0]?.id as string;

      const issued = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({ action: "issue_link", authorizationId }),
        }),
      );
      expect(issued.status).toBe(200);
      // A finished URL against the CONFIGURED origin, not a bare token: an operator
      // hand-assembling a URL is one typo from a dead link and one wrong host from handing
      // the credential somewhere else.
      const payload = (await issued.json()) as { link?: string };
      expect(payload.link).toMatch(/^https:\/\/[^/]+\/stand\/[0-9a-f]{64}$/);
      const issuedToken = /\/stand\/([0-9a-f]{64})$/.exec(payload.link ?? "")?.[1];
      expect(issuedToken).toBeDefined();

      // The queue reports that a link EXISTS and never what it is. An operator who navigates
      // away must issue a new one — correct for a credential with no password behind it.
      const listed = await farmersRoute.GET(
        request("https://ff.example/api/admin/farmers", { token }),
      );
      const listedBody = await listed.text();
      expect(listedBody).not.toContain(issuedToken as string);
      expect(listedBody).toContain('"hasLiveLink":true');
    });

    it("revokes a farmer's access through the route", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { contactHash, farmId } = await farmerAndFarm();
      await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({ action: "authorize", farmId, contactHash }),
        }),
      );
      const rows = await sql()`
        select a.id from farmer_authorizations a
        join contacts c on c.id = a.contact_id
        where c.phone_hash = ${contactHash} and a.revoked_at is null
      `;
      const authorizationId = rows[0]?.id as string;

      const revoked = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({ action: "revoke", authorizationId }),
        }),
      );
      expect(revoked.status).toBe(200);

      const after = await sql()`
        select revoked_at from farmer_authorizations where id = ${authorizationId}
      `;
      expect(after[0]?.revoked_at).not.toBeNull();
    });

    it("refuses a malformed request without granting anything", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { contactHash, farmId } = await farmerAndFarm();
      const before = await sql()`
        select count(*)::int as n from farmer_authorizations
      `;

      for (const payload of [
        {},
        { action: "authorize" },
        { action: "authorize", farmId },
        { action: "authorize", contactHash },
        { action: "delete", authorizationId: randomUUID() },
        { action: "revoke" },
        { action: "issue_link" },
        { action: "authorize", farmId: 42, contactHash },
      ]) {
        const response = await farmersRoute.POST(
          request("https://ff.example/api/admin/farmers", {
            method: "POST",
            token,
            body: JSON.stringify(payload),
          }),
        );
        expect(response.status, JSON.stringify(payload)).toBe(400);
      }

      const after = await sql()`
        select count(*)::int as n from farmer_authorizations
      `;
      expect(after[0]?.n).toBe(before[0]?.n);
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
