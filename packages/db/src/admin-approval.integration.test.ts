import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_TTL_MS,
  hashSessionToken,
  issueSessionToken,
} from "@farm-friend/core";
import {
  approveFarm,
  createAdminSession,
  openOrReviseProposal,
  confirmInventoryPublication,
  resolveAdminSession,
  revokeAdminSession,
  revokeFarmApproval,
  createDb,
  listStandsForAdministration,
  listUsersForAdministration,
  type Db,
} from "./index";

// F-025a — the item's whole point, proven end to end.
//
// Publication refuses with `not_approved` unless a live `seller_approvals` row exists, and until
// this item NOTHING created one. Every existing test that publishes successfully does so
// because its FIXTURE inserts the approval row by hand — a green suite hiding a product that
// cannot work. So the rule for this file: no test inserts `seller_approvals` directly. Approval
// comes from `approveFarm` or it does not exist.

const dbPackage = resolve(process.cwd(), "packages/db");
const migrationsDir = resolve(dbPackage, "drizzle");
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

describe("farm approval and admin sessions (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;

  const farmerHash = "e".repeat(64);
  // Clock-derived, never a date literal (B-003 tripwire).
  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const at = (hours: number) => new Date(anchor + hours * 60 * 60 * 1000);
  const t0 = at(0);
  const clockAt = (time: Date) => ({ now: () => time });

  const ids: Record<string, string> = {};
  const sql = () => client as Sql;
  const handle = () => db as Db;

  /**
   * Drive a full farmer publication attempt through the real transaction surface, exactly
   * as the SMS path does: open a proposal, activate its prompt, then confirm with YES.
   */
  async function attemptPublication(when: Date): Promise<string> {
    const proposal = await openOrReviseProposal(handle(), {
      senderHash: farmerHash,
      salesLocationId: ids.location as string,
      entries: [{ entryId: "draft_admin_eggs", itemName: "eggs" }],
      now: when,
    });
    await proposal.activate({
      providerAcceptedAt: when,
    });

    const confirmedAt = new Date(when.getTime() + 60_000);
    const result = await confirmInventoryPublication(handle(), {
      proposalId: proposal.proposalId,
      senderHash: farmerHash,
      token: "yes",
      occurredAt: confirmedAt,
      providerEventId: `confirm-${randomUUID()}`,
      clock: clockAt(confirmedAt),
    });
    return result.status;
  }

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_approval_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);

    // `createDb` rather than a hand-built handle, and deliberately not `createAppContext`:
    // `sharedDb` caches on first call and ignores the URL thereafter, so a second context
    // cannot target this database, and close() on it would tear down the pool other suites
    // share. `createDb` also carries the structural reason the raw client and the Drizzle
    // client must be SEPARATE — drizzle() overwrites the date serializers on whatever
    // postgres.js client it is constructed over, after which raw SQL there cannot bind a
    // Date (see the comment on createDb). A hand-built handle that shares one client fails
    // exactly that way.
    db = createDb(url);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    // The fixture builds everything a farmer needs to publish EXCEPT approval: a contact,
    // a farm, a verified farmer authorization, a sales location. Approval is the one thing
    // this suite refuses to fake.
    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550302', ${farmerHash})
      returning id
    `;
    ids.farmerContact = contacts[0]?.id as string;

    await sql()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550303', ${"f".repeat(64)})
    `;

    await sql()`
      insert into sms_consents (recipient_hash, state, capture_source, captured_at,
        capture_evidence_ref, updated_at)
      values (${farmerHash}, 'active', 'farmer_onboarding', ${t0.toISOString()},
        'onboarding-form-1', ${t0.toISOString()})
    `;

    const sellers = await sql()`
      insert into sellers (name) values ('Unapproved Farm') returning id
    `;
    ids.farm = sellers[0]?.id as string;

    await sql()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${ids.farm}, ${ids.farmerContact}, ${t0.toISOString()}, ${t0.toISOString()})
    `;

    const locations = await sql()`
      insert into sales_locations (own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible)
      values (${ids.farm}, 'farm_stand', 'Unapproved Stand', 'America/Los_Angeles', 'visitable', 'produce', '9 Stand Way', 47.45, -122.46,
        false, false)
      returning id
    `;
    ids.location = locations[0]?.id as string;

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${t0.toISOString()})
      returning id
    `;
    ids.administrator = administrators[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("refuses publication for a farm nothing has approved", async () => {
    // The defect, stated as a test. Every prerequisite is present — consent, farmer
    // authority, a sales location, a valid activated proposal — and publication STILL
    // refuses, because approval is a separate act nobody has performed.
    const approvals = await sql()`select id from seller_approvals`;
    expect(approvals, "no fixture may pre-insert an approval").toHaveLength(0);

    expect(await attemptPublication(at(1))).toBe("not_approved");
  });

  it("lists stand metadata and masks a filterable farmer directory", async () => {
    const [stand] = await listStandsForAdministration(handle());
    expect(stand).toMatchObject({
      standId: ids.location,
      name: "Unapproved Stand",
      farmName: "Unapproved Farm",
      approved: false,
      isPublic: true,
      publicAddress: "9 Stand Way",
      currentItems: [],
    });

    const users = await listUsersForAdministration(handle());
    expect(users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: ids.farmerContact,
          senderMask: "(•••) •••-0302",
          isFarmer: true,
          sellers: ["Unapproved Farm"],
        }),
        expect.objectContaining({
          senderMask: "(•••) •••-0303",
          isFarmer: false,
          sellers: [],
        }),
      ]),
    );
    expect(JSON.stringify(users)).not.toContain("+12065550302");
    expect(JSON.stringify(users)).not.toContain(farmerHash);
  });

  it("publishes once an administrator approves, and records who acted and when", async () => {
    const approvedAt = at(2);
    const result = await approveFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: approvedAt,
    });
    expect(result.status).toBe("approved");

    const rows = await sql()`
      select administrator_id, approved_at, revoked_at from seller_approvals
      where seller_id = ${ids.farm as string} and revoked_at is null
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.administrator_id).toBe(ids.administrator);
    expect(new Date(rows[0]?.approved_at as string).getTime()).toBe(
      approvedAt.getTime(),
    );

    // The end-to-end claim: the same publication attempt that just refused now succeeds.
    expect(await attemptPublication(at(3))).toBe("published");
  });

  it("records approval in the audit trail against the acting administrator", async () => {
    const audit = await sql()`
      select action, actor_administrator_id, subject_type, subject_id
      from audit_events where action = 'farm_approved'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_administrator_id).toBe(ids.administrator);
    expect(audit[0]?.subject_type).toBe("farm");
    expect(audit[0]?.subject_id).toBe(ids.farm);
  });

  it("is idempotent: approving an already-approved farm does not double-grant", async () => {
    const before = await sql()`
      select count(*)::int as n from seller_approvals where revoked_at is null
    `;
    const result = await approveFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(4),
    });
    expect(result.status).toBe("already_approved");
    const after = await sql()`
      select count(*)::int as n from seller_approvals where revoked_at is null
    `;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("refuses to approve on behalf of a revoked administrator", async () => {
    const revoked = await sql()`
      insert into administrators (email, authorized_at, revoked_at)
      values ('board@vigavashon.org', ${t0.toISOString()}, ${at(1).toISOString()})
      returning id
    `;
    const otherFarm = await sql()`
      insert into sellers (name) values ('Other Farm') returning id
    `;
    const result = await approveFarm(handle(), {
      farmId: otherFarm[0]?.id as string,
      administratorId: revoked[0]?.id as string,
      occurredAt: at(5),
    });
    expect(result.status).toBe("not_an_administrator");

    const rows = await sql()`
      select id from seller_approvals where seller_id = ${otherFarm[0]?.id as string}
    `;
    expect(rows).toHaveLength(0);
  });

  it("blocks subsequent publication once approval is revoked", async () => {
    const revokedAt = at(6);
    const result = await revokeFarmApproval(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: revokedAt,
    });
    expect(result.status).toBe("revoked");

    // Revocation is recorded, not deleted: the audit trail keeps the whole history.
    const rows = await sql()`
      select revoked_at from seller_approvals where seller_id = ${ids.farm as string}
    `;
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]?.revoked_at as string).getTime()).toBe(
      revokedAt.getTime(),
    );

    expect(await attemptPublication(at(7))).toBe("not_approved");
  });

  it("lets a revoked farm be approved again, as a new grant", async () => {
    const result = await approveFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(8),
    });
    expect(result.status).toBe("approved");

    const rows = await sql()`
      select id from seller_approvals where seller_id = ${ids.farm as string}
    `;
    // Two rows: the revoked original and the new grant. History is never overwritten.
    expect(rows).toHaveLength(2);
    expect(await attemptPublication(at(9))).toBe("published");
  });

  describe("session-backed administrator identity", () => {
    it("resolves a live session directly to its administrator", async () => {
      const token = issueSessionToken();
      const issuedAt = at(10);
      await createAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        administratorId: ids.administrator as string,
        issuedAt,
      });

      const administrator = await resolveAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        now: issuedAt,
      });
      expect(administrator).toEqual({
        administratorId: ids.administrator,
        email: "board@vigavashon.org",
      });
      expect(Object.keys(administrator ?? {}).sort()).toEqual([
        "administratorId",
        "email",
      ]);
    });

    it("refuses an unknown, expired, or revoked session", async () => {
      const issuedAt = at(11);

      // Unknown token.
      expect(
        await resolveAdminSession(handle(), {
          tokenHash: hashSessionToken(issueSessionToken()),
          now: issuedAt,
        }),
      ).toBeNull();

      // Expired: live inside the window, dead at and past the boundary.
      const expiring = issueSessionToken();
      await createAdminSession(handle(), {
        tokenHash: hashSessionToken(expiring),
        administratorId: ids.administrator as string,
        issuedAt,
      });
      const expiresAt = new Date(issuedAt.getTime() + ADMIN_SESSION_TTL_MS);
      expect(
        await resolveAdminSession(handle(), {
          tokenHash: hashSessionToken(expiring),
          now: new Date(expiresAt.getTime() - 1000),
        }),
      ).not.toBeNull();
      expect(
        await resolveAdminSession(handle(), {
          tokenHash: hashSessionToken(expiring),
          now: expiresAt,
        }),
      ).toBeNull();

      // Revoked: dead immediately, well inside the window.
      const revoked = issueSessionToken();
      await createAdminSession(handle(), {
        tokenHash: hashSessionToken(revoked),
        administratorId: ids.administrator as string,
        issuedAt,
      });
      await revokeAdminSession(handle(), {
        tokenHash: hashSessionToken(revoked),
        occurredAt: new Date(issuedAt.getTime() + 60_000),
      });
      expect(
        await resolveAdminSession(handle(), {
          tokenHash: hashSessionToken(revoked),
          now: new Date(issuedAt.getTime() + 120_000),
        }),
      ).toBeNull();
    });

    it("refuses a session whose administrator was revoked after it was issued", async () => {
      // The reason a session is a database record rather than a signed claim: withdrawing
      // an operator's authority must take effect NOW, not when their token expires.
      const token = issueSessionToken();
      await createAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        administratorId: ids.administrator as string,
        issuedAt: at(12),
      });
      expect(
        await resolveAdminSession(handle(), {
          tokenHash: hashSessionToken(token),
          now: at(12),
        }),
      ).not.toBeNull();

      await sql()`
        update administrators set revoked_at = ${at(13).toISOString()}
        where id = ${ids.administrator as string}
      `;

      expect(
        await resolveAdminSession(handle(), {
          tokenHash: hashSessionToken(token),
          now: at(14),
        }),
      ).toBeNull();
    });

    it("refuses to approve a farm through a revoked administrator's still-live session", async () => {
      // The two guards are separate: resolving the session and re-checking authority at the
      // moment of the write. Approval re-reads the administrator rather than trusting a
      // principal resolved earlier in the request.
      const farm = await sql()`
        insert into sellers (name) values ('Lapsed Approver Farm') returning id
      `;

      const result = await approveFarm(handle(), {
        farmId: farm[0]?.id as string,
        administratorId: ids.administrator as string,
        occurredAt: at(14),
      });
      expect(result.status).toBe("not_an_administrator");
    });
  });

});
