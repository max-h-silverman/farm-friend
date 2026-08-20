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
  let farmsRoute: typeof import("../app/api/admin/sellers/route");
  let flagsRoute: typeof import("../app/api/admin/flags/route");
  let threadRoute: typeof import("../app/api/admin/flags/[flagId]/thread/route");
  let farmersRoute: typeof import("../app/api/admin/farmers/route");
  let standsRoute: typeof import("../app/api/admin/stands/route");
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
    process.env.PUBLIC_MAP_URL = "https://www.vigavashon.org/farm-stand-map#map";

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${at(0).toISOString()})
      returning id
    `;
    ids.administrator = administrators[0]?.id as string;

    const sellers = await sql()`
      insert into sellers (name) values ('Route Farm') returning id
    `;
    ids.farm = sellers[0]?.id as string;

    const locations = await sql()`
      insert into sales_locations (own_seller_id, kind, name, timezone, visitability,
        offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible)
      values (${ids.farm}, 'farm_stand', 'Route Stand', 'America/Los_Angeles', 'visitable',
        'produce', '7 Route Way', 47.42, -122.43, false, false)
      returning id
    `;
    ids.stand = locations[0]?.id as string;

    farmsRoute = await import("../app/api/admin/sellers/route");
    flagsRoute = await import("../app/api/admin/flags/route");
    threadRoute = await import("../app/api/admin/flags/[flagId]/thread/route");
    farmersRoute = await import("../app/api/admin/farmers/route");
    standsRoute = await import("../app/api/admin/stands/route");
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
            request("https://ff.example/api/admin/sellers", {
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

      // F-071 — the stands route was missing from this sweep entirely, which is exactly the
      // gap this test exists to close. It now also carries retirement, so an unguarded
      // handler here is the power to take any stand off the public map.
      expect(
        (
          await standsRoute.POST(
            request("https://ff.example/api/admin/stands", {
              method: "POST",
              body: JSON.stringify({ standId: ids.stand, action: "retire" }),
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
      const before = await sql()`select count(*)::int as n from seller_approvals`;

      const response = await farmsRoute.POST(
        request("https://ff.example/api/admin/sellers", {
          method: "POST",
          token,
          headers: { origin: "https://attacker.example" },
          body: JSON.stringify({ farmId: ids.farm, action: "approve" }),
        }),
      );

      expect(response.status).toBe(403);
      const after = await sql()`select count(*)::int as n from seller_approvals`;
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

  describe("decisions about a farm through the route", () => {
    it("no longer offers approval or test-farm marking (F-124)", async () => {
      /*
        The controls were removed from the console (max, 2026-08-19), and this asserts the
        SERVER stopped offering them rather than the button merely disappearing — a route that
        still honoured `approve` would leave the capability reachable by anyone who could form
        a request, which is not what "removed" means.

        Both writers still exist and are still called: `approveFarm` by onboarding redemption,
        `setTestFarm` by scripts. Only this door is shut.
      */
      const token = await sessionFor(ids.administrator as string);
      const before = await sql()`
        select
          (select count(*)::int from seller_approvals) as approvals,
          (select count(*)::int from sellers where test_seller_at is not null) as test_farms
      `;

      for (const action of ["approve", "revoke", "mark_test", "unmark_test"]) {
        const response = await farmsRoute.POST(
          request("https://ff.example/api/admin/sellers", {
            method: "POST",
            token,
            body: JSON.stringify({ farmId: ids.farm, action }),
          }),
        );
        expect(response.status, action).toBe(400);
      }

      const after = await sql()`
        select
          (select count(*)::int from seller_approvals) as approvals,
          (select count(*)::int from sellers where test_seller_at is not null) as test_farms
      `;
      expect(after[0]?.approvals, "a removed action must not still approve").toBe(
        before[0]?.approvals,
      );
      expect(after[0]?.test_farms, "a removed action must not still mark a test farm").toBe(
        before[0]?.test_farms,
      );
    });

    it("rejects a malformed or unknown request without touching the farm", async () => {
      const token = await sessionFor(ids.administrator as string);
      const before = await sql()`
        select name, retired_at, trashed_at from sellers where id = ${ids.farm as string}
      `;

      for (const body of [
        {},
        { farmId: ids.farm },
        { action: "retire" },
        { farmId: ids.farm, action: "delete" },
        { farmId: 42, action: "retire" },
        // `save_details` is the one action carrying a payload, and a missing one is the
        // caller's bug rather than a state conflict.
        { farmId: ids.farm, action: "save_details" },
      ]) {
        const response = await farmsRoute.POST(
          request("https://ff.example/api/admin/sellers", {
            method: "POST",
            token,
            body: JSON.stringify(body),
          }),
        );
        expect(response.status, JSON.stringify(body)).toBe(400);
      }

      const unknownFarm = await farmsRoute.POST(
        request("https://ff.example/api/admin/sellers", {
          method: "POST",
          token,
          body: JSON.stringify({ farmId: randomUUID(), action: "retire" }),
        }),
      );
      expect(unknownFarm.status).toBe(404);

      const after = await sql()`
        select name, retired_at, trashed_at from sellers where id = ${ids.farm as string}
      `;
      expect(after[0]).toEqual(before[0]);
    });
  });

  describe("stand retirement through the route (F-071)", () => {
    it("retires and restores, recording the SESSION's administrator not the body's", async () => {
      const token = await sessionFor(ids.administrator as string);
      const impostorId = randomUUID();

      const retire = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          // A caller naming someone else must not be able to act as them.
          body: JSON.stringify({
            standId: ids.stand,
            action: "retire",
            administratorId: impostorId,
          }),
        }),
      );
      expect(retire.status).toBe(200);

      const rows = await sql()`
        select retired_at, retired_by_administrator_id from sales_locations
        where id = ${ids.stand as string}
      `;
      expect(rows[0]?.retired_at).not.toBeNull();
      expect(rows[0]?.retired_by_administrator_id).toBe(ids.administrator);
      expect(rows[0]?.retired_by_administrator_id).not.toBe(impostorId);

      const restore = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          body: JSON.stringify({ standId: ids.stand, action: "restore" }),
        }),
      );
      expect(restore.status).toBe(200);
      const after = await sql()`
        select retired_at from sales_locations where id = ${ids.stand as string}
      `;
      expect(after[0]?.retired_at).toBeNull();
    });

    it("trashes and restores a stand through the same guarded route (F-124)", async () => {
      const token = await sessionFor(ids.administrator as string);
      const impostorId = randomUUID();

      // Start from a stand that is ON the map, whatever the tests before this one left behind.
      // `retired_by_trash` is the fact under test, and it only means anything when trashing is
      // what caused the retirement — so the starting state has to be stated, not inherited.
      await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          body: JSON.stringify({ standId: ids.stand, action: "restore" }),
        }),
      );

      const trash = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          // Same rule as retirement: the acting administrator is the SESSION's.
          body: JSON.stringify({
            standId: ids.stand,
            action: "trash",
            administratorId: impostorId,
          }),
        }),
      );
      expect(trash.status).toBe(200);

      const trashed = await sql()`
        select trashed_at, trashed_by_administrator_id, retired_at, retired_by_trash
        from sales_locations where id = ${ids.stand as string}
      `;
      expect(trashed[0]?.trashed_at).not.toBeNull();
      expect(trashed[0]?.trashed_by_administrator_id).toBe(ids.administrator);
      expect(trashed[0]?.trashed_by_administrator_id).not.toBe(impostorId);
      // Trashing retires in the same transaction, and records that it caused the retirement.
      expect(trashed[0]?.retired_at).not.toBeNull();
      expect(trashed[0]?.retired_by_trash).toBe(true);

      // A second trash is a conflict the screen can report, never a silent no-op.
      const again = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          body: JSON.stringify({ standId: ids.stand, action: "trash" }),
        }),
      );
      expect(again.status).toBe(409);

      const restore = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          body: JSON.stringify({ standId: ids.stand, action: "restore_from_trash" }),
        }),
      );
      expect(restore.status).toBe(200);

      const after = await sql()`
        select trashed_at, retired_at, retired_by_trash
        from sales_locations where id = ${ids.stand as string}
      `;
      expect(after[0]?.trashed_at).toBeNull();
      // The restore undoes the retirement it created, so the stand is back on the map.
      expect(after[0]?.retired_at).toBeNull();
      expect(after[0]?.retired_by_trash).toBe(false);
    });

    it("trashes and restores a farm through the same guarded route (F-124)", async () => {
      const token = await sessionFor(ids.administrator as string);

      const trash = await farmsRoute.POST(
        request("https://ff.example/api/admin/sellers", {
          method: "POST",
          token,
          body: JSON.stringify({ farmId: ids.farm, action: "trash" }),
        }),
      );
      expect(trash.status).toBe(200);
      expect(
        (await sql()`select trashed_at from sellers where id = ${ids.farm as string}`)[0]
          ?.trashed_at,
      ).not.toBeNull();

      const restore = await farmsRoute.POST(
        request("https://ff.example/api/admin/sellers", {
          method: "POST",
          token,
          body: JSON.stringify({ farmId: ids.farm, action: "restore_from_trash" }),
        }),
      );
      expect(restore.status).toBe(200);
      expect(
        (await sql()`select trashed_at from sellers where id = ${ids.farm as string}`)[0]
          ?.trashed_at,
      ).toBeNull();
    });

    it("refuses an unauthenticated trash on either route (F-124)", async () => {
      // Trashing takes a record out of VIGA's roster, so an unguarded handler here is the
      // power to empty the console. Named explicitly rather than trusted to the sweep above.
      for (const [route, url, body] of [
        [standsRoute, "https://ff.example/api/admin/stands", { standId: ids.stand, action: "trash" }],
        [farmsRoute, "https://ff.example/api/admin/sellers", { farmId: ids.farm, action: "trash" }],
      ] as const) {
        const response = await route.POST(
          request(url, { method: "POST", body: JSON.stringify(body) }),
        );
        expect(response.status, url).toBe(403);
      }

      const trashed = await sql()`
        select
          (select count(*)::int from sales_locations where trashed_at is not null) as stands,
          (select count(*)::int from sellers where trashed_at is not null) as farms
      `;
      expect(trashed[0]?.stands, "no unauthenticated request may trash a stand").toBe(0);
      expect(trashed[0]?.farms, "no unauthenticated request may trash a farm").toBe(0);
    });

    // The two tests above each restore what they trashed, so nothing here leaves a record in
    // the trash for a later test to count. This asserts that rather than trusting it: the
    // malformed-request tests below count rows, and a leaked trashing would fail them for a
    // reason that has nothing to do with what they test.
    it("leaves nothing in the trash for the tests that follow", async () => {
      const left = await sql()`
        select
          (select count(*)::int from sales_locations where trashed_at is not null) as stands,
          (select count(*)::int from sellers where trashed_at is not null) as farms
      `;
      expect(left[0]?.stands).toBe(0);
      expect(left[0]?.farms).toBe(0);
    });

    it("rejects a malformed or unknown request without retiring anything", async () => {
      const token = await sessionFor(ids.administrator as string);

      for (const body of [
        {},
        { standId: ids.stand },
        { action: "retire" },
        { standId: ids.stand, action: "obliterate" },
        { standId: 42, action: "retire" },
      ]) {
        const response = await standsRoute.POST(
          request("https://ff.example/api/admin/stands", {
            method: "POST",
            token,
            body: JSON.stringify(body),
          }),
        );
        expect(response.status, JSON.stringify(body)).toBe(400);
      }

      const unknownStand = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          body: JSON.stringify({ standId: randomUUID(), action: "retire" }),
        }),
      );
      expect(unknownStand.status).toBe(404);

      const live = await sql()`
        select count(*)::int as n from sales_locations where retired_at is not null
      `;
      expect(live[0]?.n, "no malformed request may retire a stand").toBe(0);
    });

    it("still saves a Farm Bucks decision through the same route", async () => {
      // The route carries two different admin acts now. This is the regression guard: adding
      // retirement must not have broken the decision the route already owned.
      const token = await sessionFor(ids.administrator as string);
      const response = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          body: JSON.stringify({ standId: ids.stand, farmBucksStatus: "accepts" }),
        }),
      );
      expect(response.status).toBe(200);
      const rows = await sql()`
        select farm_bucks_accepted from sales_locations where id = ${ids.stand as string}
      `;
      expect(rows[0]?.farm_bucks_accepted).toBe(true);
    });
  });

  describe("hosted-seller invitation through the route (F-114 Phase C.1)", () => {
    it("invites a seller and returns a link ONCE, storing only its hash", async () => {
      // VIGA's door — the one that resolves the 11 retained hosted names into real sellers. The
      // coordinator gets a link to pass on; Farm Friend texts the invited seller nothing, because
      // no consent row exists for a number nobody gave us.
      const token = await sessionFor(ids.administrator as string);
      const response = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          body: JSON.stringify({
            standId: ids.stand,
            action: "invite_seller",
            newSellerName: "Gracies Greens",
            // A caller naming someone else must not be able to act as them.
            administratorId: randomUUID(),
          }),
        }),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        status: string;
        token?: string;
        link?: string;
        sellerName?: string;
      };
      expect(payload.status).toBe("invited");
      // A complete URL, matching `create_invite` and the stand owner's own door: a coordinator
      // forwarding a link must not be asked to assemble one from a bare token.
      expect(payload.link).toMatch(
        /^https?:\/\/[^/]+\/farmer\/onboarding\/[0-9a-f]{64}$/,
      );
      // And the bare token is NOT echoed beside it. One readable copy, in the form that is
      // actually sent — a second spelling of the same credential is a second thing to leak.
      expect(payload.token).toBeUndefined();
      expect(payload.sellerName).toBe("Gracies Greens");

      // The relationship is PENDING and therefore invisible: nobody is shown as selling
      // somewhere before they have agreed to be there.
      const providers = await sql()`
        select p.lifecycle_state, p.host_may_update_stock
        from stand_providers p
        join sellers s on s.id = p.seller_id
        where p.sales_location_id = ${ids.stand as string} and s.name = 'Gracies Greens'
      `;
      expect(providers[0]).toMatchObject({
        lifecycle_state: "pending",
        host_may_update_stock: false,
      });

      // The raw token is never stored, and the invitation records VIGA as the approver —
      // max, 2026-08-15: VIGA is the approver on record whenever VIGA issues the link.
      const invitations = await sql()`
        select token_hash, created_by_administrator_id, invited_by_authorization_id
        from farmer_invitations where stand_provider_id is not null
      `;
      expect(invitations).toHaveLength(1);
      expect(invitations[0]?.token_hash).not.toBe((payload.link ?? "").split("/").at(-1));
      expect(invitations[0]?.created_by_administrator_id).toBe(ids.administrator);
      expect(invitations[0]?.invited_by_authorization_id).toBeNull();
    });

    it("rejects a malformed request without creating a seller or a relationship", async () => {
      const token = await sessionFor(ids.administrator as string);
      const before = await sql()`select count(*)::int as n from sellers`;

      for (const body of [
        { standId: ids.stand, action: "invite_seller" },
        { standId: ids.stand, action: "invite_seller", newSellerName: "   " },
        { standId: ids.stand, action: "invite_seller", newSellerName: 42 },
        {
          standId: ids.stand,
          action: "invite_seller",
          newSellerName: "Both Named",
          sellerId: randomUUID(),
        },
      ]) {
        const response = await standsRoute.POST(
          request("https://ff.example/api/admin/stands", {
            method: "POST",
            token,
            body: JSON.stringify(body),
          }),
        );
        expect(response.status, JSON.stringify(body)).toBe(400);
      }

      const after = await sql()`select count(*)::int as n from sellers`;
      expect(after[0]?.n, "no malformed request may create a seller").toBe(before[0]?.n);
    });

    it("refuses a name that would put contact details on the public map", async () => {
      // A hosted seller is CREDITED on the stand's public card, so a name typed here reaches the
      // island's guide. Answered with the SAME code-owned copy the farmer's own door shows: one
      // rule, one wording, two doors.
      const token = await sessionFor(ids.administrator as string);
      const before = await sql()`select count(*)::int as n from sellers`;
      const response = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          body: JSON.stringify({
            standId: ids.stand,
            action: "invite_seller",
            newSellerName: "Gracies Greens 206-555-0199",
          }),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        status: "unsafe_public_text",
        message: expect.stringContaining("phone number"),
      });
      expect((await sql()`select count(*)::int as n from sellers`)[0]?.n).toBe(before[0]?.n);
    });

    it("answers 404 for an unknown stand", async () => {
      const token = await sessionFor(ids.administrator as string);
      const response = await standsRoute.POST(
        request("https://ff.example/api/admin/stands", {
          method: "POST",
          token,
          body: JSON.stringify({
            standId: randomUUID(),
            action: "invite_seller",
            newSellerName: "Nowhere Farm",
          }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it("answers 409 for a seller already selling there, minting no second link", async () => {
      // The uniqueness the index enforces, surfaced honestly rather than as a 500. A second
      // link for one relationship would let two handsets each accept it.
      const token = await sessionFor(ids.administrator as string);
      const send = async (): Promise<Response> =>
        standsRoute.POST(
          request("https://ff.example/api/admin/stands", {
            method: "POST",
            token,
            body: JSON.stringify({
              standId: ids.stand,
              action: "invite_seller",
              sellerId: ids.farm,
            }),
          }),
        );
      // `ids.farm` is the stand's OWN seller, which already sells there by the self-pointer.
      expect((await send()).status).toBe(409);
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
      const sellers = await sql()`
        insert into sellers (name) values (${`Farmer Farm ${randomUUID()}`}) returning id
      `;
      return { contactHash, farmId: sellers[0]?.id as string };
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
        select seller_id, channel, redeemed_at from farmer_invitations
        where seller_id = ${ids.farm as string}
      `;
      expect(invitation).toEqual([
        { seller_id: ids.farm as string, channel: "email", redeemed_at: null },
      ]);
    });

    it("creates an onboarding link without a farm for a new farm", async () => {
      const token = await sessionFor(ids.administrator as string);
      const response = await farmersRoute.POST(
        request("https://ff.example/api/admin/farmers", {
          method: "POST",
          token,
          body: JSON.stringify({
            action: "create_invite",
            channel: "sms",
          }),
        }),
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.status).toBe("created");
      expect(payload.channel).toBe("sms");
      expect(payload.farmName).toBeNull();
      expect(payload.link).toMatch(/^https:\/\/ff\.example\/farmer\/onboarding\/[0-9a-f]{64}$/);

      const invitation = await sql()`
        select seller_id, channel, redeemed_at from farmer_invitations
        where channel = 'sms' and seller_id is null
      `;
      expect(invitation).toEqual([
        { seller_id: null, channel: "sms", redeemed_at: null },
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
          own_seller_id, kind, name, timezone, visitability, offering_type, public_address,
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
      expect(payload.link).toMatch(/^https:\/\/[^/]+\/stand\/[A-Za-z0-9_-]{22,64}$/);
      const issuedToken = /\/stand\/([A-Za-z0-9_-]{22,64})$/.exec(payload.link ?? "")?.[1];
      expect(issuedToken).toBeDefined();

      const links = await sql()`
        select owner_seller_id, sales_location_id
        from farmer_links where token_hash = ${hashFarmerLinkToken(issuedToken as string)}
      `;
      expect(links).toEqual([{ owner_seller_id: farmId, sales_location_id: southStandId }]);
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
