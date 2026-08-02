import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hashFarmerLinkToken,
  hashSessionToken,
  issueSessionToken,
} from "@farm-friend/core";
import { createAdminSession, type Sql } from "@farm-friend/db";
import { ADMIN_SESSION_COOKIE } from "./admin-auth";

// F-025a — the admin HTTP surface, against a real database.
//
// The acceptance criterion this file owns: EVERY admin route resolves administrator authority server-side,
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
  let logoutRoute: typeof import("../app/api/auth/logout/route");

  const request = (url: string, init?: RequestInit & { token?: string }) =>
    new Request(url, {
      ...init,
      headers: {
        ...(init?.method === undefined || ["GET", "HEAD", "OPTIONS"].includes(init.method)
          ? {}
          : { origin: new URL(url).origin }),
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

  /** The surviving flag-thread GET is the browser-consumed read route and auth probe. */
  async function probeAdministrator(token: string): Promise<number> {
    const flagId = randomUUID();
    return (
      await threadRoute.GET(
        request(`https://ff.example/api/admin/flags/${flagId}/thread`, { token }),
        { params: { flagId } },
      )
    ).status;
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
    // F-040: the farmer route builds a standing link against the CONFIGURED origin.
    process.env.PUBLIC_BASE_URL = "https://ff.example";
    process.env.PUBLIC_MAP_URL = "https://www.vigavashon.org/farm-stand-map";

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${at(0).toISOString()})
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
      // Every live method, so a new handler that forgets its
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
          await reportsRoute.POST(
            request("https://ff.example/api/admin/stock-out-reports", {
              method: "POST",
              body: JSON.stringify({ reportId: randomUUID(), action: "review" }),
            }),
          )
        ).status,
      ).toBe(403);

      // F-040's mutation grants publication authority and
      // revokes standing links, so an unguarded handler here is authority over every farm's
      // published state.
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

      // F-037's mutation, same rule: a handler that forgets its guard fails here.
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
      expect(await probeAdministrator(token)).toBe(403);
    });

    it("refuses a cross-site write even when the browser carries a live session", async () => {
      const token = await sessionFor(ids.administrator as string);
      const before = await sql()`select count(*)::int as n from farm_approvals`;

      const response = await farmsRoute.POST(
        request("https://ff.example/api/admin/farms", {
          method: "POST",
          token,
          headers: { origin: "https://attacker.example" },
          body: JSON.stringify({ farmId: ids.farm, action: "approve" }),
        }),
      );

      expect(response.status).toBe(403);
      const after = await sql()`select count(*)::int as n from farm_approvals`;
      expect(after[0]?.n).toBe(before[0]?.n);
    });

    it("refuses a revoked session", async () => {
      const token = await sessionFor(ids.administrator as string);
      expect(await probeAdministrator(token)).toBe(404);

      await sql()`
        update admin_sessions set revoked_at = now()
        where token_hash = ${hashSessionToken(token)}
      `;
      expect(await probeAdministrator(token)).toBe(403);
    });

    it("refuses a live session whose administrator was revoked", async () => {
      const administratorId = ids.administrator as string;
      const token = await sessionFor(administratorId);
      expect(await probeAdministrator(token)).toBe(404);

      await sql()`
        update administrators set revoked_at = now() where id = ${administratorId}
      `;
      // Immediately, not when the session would have expired.
      expect(await probeAdministrator(token)).toBe(403);

      // Restore the one fixed authority for the remaining independent route cases. The old
      // session still names the revoked row and therefore remains dead.
      const replacement = await sql()`
        insert into administrators (email, authorized_at)
        values ('board@vigavashon.org', ${at(1).toISOString()}) returning id
      `;
      ids.administrator = replacement[0]?.id as string;
    });
  });

  describe("approval through the route", () => {
    it("approves and revokes, recording the SESSION's administrator not the body's", async () => {
      const token = await sessionFor(ids.administrator as string);
      const impostorId = randomUUID();

      const approve = await farmsRoute.POST(
        request("https://ff.example/api/admin/farms", {
          method: "POST",
          token,
          // A caller naming someone else must not be able to act as them.
          body: JSON.stringify({
            farmId: ids.farm,
            action: "approve",
            administratorId: impostorId,
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
      expect(rows[0]?.administrator_id).not.toBe(impostorId);

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

    it("resolves an open flag, recording the SESSION's administrator", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { flagId } = await flaggedMessage("something is wrong here");

      const impostorId = randomUUID();
      const resolved = await flagsRoute.POST(
        request("https://ff.example/api/admin/flags", {
          method: "POST",
          token,
          // Naming someone else must not make them the actor.
          body: JSON.stringify({
            flagId,
            action: "resolve",
            dispositionCode: "spoke_with_sender",
            administratorId: impostorId,
          }),
        }),
      );
      expect(resolved.status).toBe(200);

      const rows = await sql()`
        select status, disposed_by_administrator_id from flags where id = ${flagId}
      `;
      expect(rows[0]?.status).toBe("resolved");
      expect(rows[0]?.disposed_by_administrator_id).toBe(ids.administrator);
      expect(rows[0]?.disposed_by_administrator_id).not.toBe(impostorId);
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

    it("triages a stock-out report", async () => {
      const token = await sessionFor(ids.administrator as string);
      const locations = await sql()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${ids.farm as string}, 'farm_stand', 'Route Stand', 'America/Los_Angeles', 'visitable', 'produce', '1 Vashon Hwy',
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
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${farms[0]?.id as string}, 'farm_stand', ${`Data Stand ${randomUUID()}`}, 'America/Los_Angeles',
          'visitable', 'produce', '9 Vashon Hwy', 47.42, -122.44, false, false
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

    it("resolves an open stand-data flag, recording the SESSION's administrator", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { flagId } = await standDataFlag();

      const impostorId = randomUUID();
      const resolved = await standDataRoute.POST(
        request("https://ff.example/api/admin/stand-data-flags", {
          method: "POST",
          token,
          // Naming someone else must not make them the actor.
          body: JSON.stringify({
            flagId,
            note: "confirmed with the farmer",
            administratorId: impostorId,
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

    async function openRequestFor(contactHash: string): Promise<string> {
      const rows = await sql()`
        insert into farmer_onboarding_requests (contact_hash, requested_at)
        values (${contactHash}, ${at(1).toISOString()})
        returning id
      `;
      return rows[0]?.id as string;
    }

    it("creates an onboarding link for the selected farm", async () => {
      const token = await sessionFor(ids.administrator as string);
      const response = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({
            action: "create_invite",
            farmId: ids.farm,
            channel: "email",
          }),
        }),
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.status).toBe("created");
      expect(payload.channel).toBe("email");
      expect(payload.farmName).toBe("Route Farm");
      expect(payload.link).toMatch(/^https:\/\/ff\.example\/farmer\/onboarding\/[0-9a-f]{64}$/);

      const invitation = await sql()`
        select farm_id, channel, redeemed_at from farmer_invitations
        where farm_id = ${ids.farm as string}
      `;
      expect(invitation).toEqual([
        { farm_id: ids.farm as string, channel: "email", redeemed_at: null },
      ]);
    });

    it("authorizes a farmer, recording the SESSION's administrator not the body's", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { contactHash, farmId } = await farmerAndFarm();
      const requestId = await openRequestFor(contactHash);
      const impostorId = randomUUID();

      const response = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          // Naming someone else must not make them the actor.
          body: JSON.stringify({
            action: "authorize",
            farmId,
            requestId,
            administratorId: impostorId,
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
      expect(audit[0]?.actor_administrator_id).not.toBe(impostorId);
    });

    it("returns a fresh link once and stores only its hash", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { contactHash, farmId } = await farmerAndFarm();
      const requestId = await openRequestFor(contactHash);
      const authorized = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({ action: "authorize", farmId, requestId }),
        }),
      );
      expect(authorized.status).toBe(200);

      const rows = await sql()`
        select a.id from farmer_authorizations a
        join contacts c on c.id = a.contact_id
        where c.phone_hash = ${contactHash} and a.revoked_at is null
      `;
      const authorizationId = rows[0]?.id as string;

      const locations = await sql()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address,
          public_latitude, public_longitude, farm_bucks_accepted, farm_bucks_eligible
        ) values
          (${farmId}, 'farm_stand', 'North Stand', 'America/Los_Angeles', 'visitable', 'produce', '1 North Rd',
            47.4, -122.4, false, false),
          (${farmId}, 'farm_stand', 'South Stand', 'America/Los_Angeles', 'visitable', 'produce', '2 South Rd',
            47.41, -122.41, false, false)
        returning id, name
      `;
      const southStandId = locations.find((row) => row.name === "South Stand")?.id as string;

      const untargeted = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({ action: "issue_link", authorizationId }),
        }),
      );
      expect(untargeted.status).toBe(400);

      const issued = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({
            action: "issue_link",
            authorizationId,
            salesLocationId: southStandId,
          }),
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

      const links = await sql()`
        select owner_farm_id, sales_location_id
        from farmer_links where token_hash = ${hashFarmerLinkToken(issuedToken as string)}
      `;
      expect(links).toEqual([{ owner_farm_id: farmId, sales_location_id: southStandId }]);
    });

    it("revokes a farmer's access through the route", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { contactHash, farmId } = await farmerAndFarm();
      const requestId = await openRequestFor(contactHash);
      await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({ action: "authorize", farmId, requestId }),
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

    it("refuses a raw contact hash as an enrollment input", async () => {
      const token = await sessionFor(ids.administrator as string);
      const { contactHash, farmId } = await farmerAndFarm();
      const before = await sql()`select count(*)::int as n from farmer_authorizations`;

      const response = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({ action: "authorize", farmId, contactHash }),
        }),
      );
      expect(response.status).toBe(400);

      const after = await sql()`select count(*)::int as n from farmer_authorizations`;
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
      expect(await probeAdministrator(token)).toBe(403);
    });

    it("does not revoke a session from a cross-site request", async () => {
      const token = await sessionFor(ids.administrator as string);
      const response = await logoutRoute.POST(
        request("https://ff.example/api/auth/logout", {
          method: "POST",
          token,
          headers: { origin: "https://attacker.example" },
        }),
      );

      expect(response.status).toBe(403);
      expect(await probeAdministrator(token)).toBe(404);
    });
  });
});
