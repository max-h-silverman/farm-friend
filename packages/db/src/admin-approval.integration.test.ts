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
  type Db,
} from "./index";

// F-025a — the item's whole point, proven end to end.
//
// Publication refuses with `not_approved` unless a live `farm_approvals` row exists, and until
// this item NOTHING created one. Every existing test that publishes successfully does so
// because its FIXTURE inserts the approval row by hand — a green suite hiding a product that
// cannot work. So the rule for this file: no test inserts `farm_approvals` directly. Approval
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
      insert into sms_consents (recipient_hash, state, capture_source, captured_at,
        capture_evidence_ref, updated_at)
      values (${farmerHash}, 'active', 'farmer_onboarding', ${t0.toISOString()},
        'onboarding-form-1', ${t0.toISOString()})
    `;

    const farms = await sql()`
      insert into farms (name) values ('Unapproved Farm') returning id
    `;
    ids.farm = farms[0]?.id as string;

    await sql()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${ids.farm}, ${ids.farmerContact}, ${t0.toISOString()}, ${t0.toISOString()})
    `;

    const locations = await sql()`
      insert into sales_locations (owner_farm_id, kind, name, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible)
      values (${ids.farm}, 'farm_stand', 'Unapproved Stand', '9 Stand Way', 47.45, -122.46,
        false, false)
      returning id
    `;
    ids.location = locations[0]?.id as string;

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('approver@viga.example', ${t0.toISOString()})
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
    const approvals = await sql()`select id from farm_approvals`;
    expect(approvals, "no fixture may pre-insert an approval").toHaveLength(0);

    expect(await attemptPublication(at(1))).toBe("not_approved");
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
      select administrator_id, approved_at, revoked_at from farm_approvals
      where farm_id = ${ids.farm as string} and revoked_at is null
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
      select count(*)::int as n from farm_approvals where revoked_at is null
    `;
    const result = await approveFarm(handle(), {
      farmId: ids.farm as string,
      administratorId: ids.administrator as string,
      occurredAt: at(4),
    });
    expect(result.status).toBe("already_approved");
    const after = await sql()`
      select count(*)::int as n from farm_approvals where revoked_at is null
    `;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("refuses to approve on behalf of a revoked administrator", async () => {
    const revoked = await sql()`
      insert into administrators (email, authorized_at, revoked_at)
      values ('gone@viga.example', ${t0.toISOString()}, ${at(1).toISOString()})
      returning id
    `;
    const otherFarm = await sql()`
      insert into farms (name) values ('Other Farm') returning id
    `;
    const result = await approveFarm(handle(), {
      farmId: otherFarm[0]?.id as string,
      administratorId: revoked[0]?.id as string,
      occurredAt: at(5),
    });
    expect(result.status).toBe("not_an_administrator");

    const rows = await sql()`
      select id from farm_approvals where farm_id = ${otherFarm[0]?.id as string}
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
      select revoked_at from farm_approvals where farm_id = ${ids.farm as string}
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
      select id from farm_approvals where farm_id = ${ids.farm as string}
    `;
    // Two rows: the revoked original and the new grant. History is never overwritten.
    expect(rows).toHaveLength(2);
    expect(await attemptPublication(at(9))).toBe("published");
  });

  describe("session-backed role lookup", () => {
    it("resolves a live session to its administrator's server-side roles", async () => {
      const token = issueSessionToken();
      const issuedAt = at(10);
      await createAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        administratorId: ids.administrator as string,
        issuedAt,
      });

      const principal = await resolveAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        now: issuedAt,
      });
      expect(principal).not.toBeNull();
      expect(principal?.personId).toBe("approver@viga.example");
      expect(principal?.roles).toEqual(["admin"]);
    });

    it("NEVER grants farmer capability to an administrator (Golden Rule #1)", async () => {
      // The farmer owns published state. An operator role must not silently confer the
      // ability to act as a farm's owner — so the role lookup must be incapable of
      // returning anything but "admin", not merely uninclined to.
      //
      // GL-035: `Role` no longer HAS a "farmer" value, so the strongest available runtime
      // statement is exact equality — the roles are `["admin"]` and nothing else. Asserting
      // absence of a specific extra value would be weaker anyway: it passes for any other
      // widening. Exact equality fails for every one.
      const token = issueSessionToken();
      await createAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        administratorId: ids.administrator as string,
        issuedAt: at(10),
      });

      const principal = await resolveAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        now: at(10),
      });
      expect(principal?.roles).toEqual(["admin"]);

      // Even when the same person is ALSO an authorized farmer on a farm: the session is an
      // administrator session, and its roles come from the administrator record alone.
      await sql()`
        update administrators set contact_id = ${ids.farmerContact as string}
        where id = ${ids.administrator as string}
      `;
      const alsoFarmer = await resolveAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        now: at(10),
      });
      expect(alsoFarmer?.roles).toEqual(["admin"]);
      await sql()`
        update administrators set contact_id = null
        where id = ${ids.administrator as string}
      `;
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
      const admin = await sql()`
        insert into administrators (email, authorized_at)
        values ('temporary@viga.example', ${t0.toISOString()}) returning id
      `;
      const token = issueSessionToken();
      await createAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        administratorId: admin[0]?.id as string,
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
        where id = ${admin[0]?.id as string}
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
      const admin = await sql()`
        insert into administrators (email, authorized_at)
        values ('lapsed@viga.example', ${t0.toISOString()}) returning id
      `;
      const farm = await sql()`
        insert into farms (name) values ('Lapsed Approver Farm') returning id
      `;
      await sql()`
        update administrators set revoked_at = ${at(13).toISOString()}
        where id = ${admin[0]?.id as string}
      `;

      const result = await approveFarm(handle(), {
        farmId: farm[0]?.id as string,
        administratorId: admin[0]?.id as string,
        occurredAt: at(14),
      });
      expect(result.status).toBe("not_an_administrator");
    });
  });

  // GL-004 — a magic link may mint exactly one session, ever.
  //
  // The link was a stateless signed claim, so every callback inside its 15-minute window
  // minted a fresh session: a link forwarded, logged by a mail gateway, or read from a shared
  // inbox was a reusable credential for as long as it had not expired. The email had been
  // promising "can be used once" the whole time.
  //
  // What decides it is the UNIQUE INDEX on `admin_sessions.magic_nonce_hash`, reached through
  // the same insert that creates the session — so the consume and the session are one atomic
  // act with nothing between them to interleave. A read-then-write here would be two acts and
  // would let two callbacks both observe "unused."

  describe("one-use magic links", () => {
    const nonceFor = (seed: string) => seed.repeat(64).slice(0, 64);

    it("mints a session the first time a link is opened", async () => {
      const token = issueSessionToken();
      const result = await createAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        administratorId: ids.administrator as string,
        issuedAt: at(20),
        magicNonceHash: nonceFor("a"),
      });
      expect(result.status).toBe("created");

      // And it is a real session, not a bare row.
      const principal = await resolveAdminSession(handle(), {
        tokenHash: hashSessionToken(token),
        now: at(20),
      });
      expect(principal?.roles).toEqual(["admin"]);
    });

    it("refuses the SECOND use of one link, creating no session", async () => {
      const nonce = nonceFor("b");
      const first = issueSessionToken();
      expect(
        (
          await createAdminSession(handle(), {
            tokenHash: hashSessionToken(first),
            administratorId: ids.administrator as string,
            issuedAt: at(21),
            magicNonceHash: nonce,
          })
        ).status,
      ).toBe("created");

      // The replay: the same link, opened again, well inside its window. It mints new session
      // material — so only the spent nonce can refuse it.
      const replay = issueSessionToken();
      const second = await createAdminSession(handle(), {
        tokenHash: hashSessionToken(replay),
        administratorId: ids.administrator as string,
        issuedAt: at(21),
        magicNonceHash: nonce,
      });
      expect(second.status).toBe("link_already_used");

      // No session was created, and the replay's token authorizes nothing.
      expect(
        await resolveAdminSession(handle(), {
          tokenHash: hashSessionToken(replay),
          now: at(21),
        }),
      ).toBeNull();
      const rows = await sql()`
        select count(*)::int as n from admin_sessions where magic_nonce_hash = ${nonce}
      `;
      expect(rows[0]?.n).toBe(1);

      // The session the FIRST use minted is untouched — a refused replay must not log the
      // operator out, or an attacker with a copied link could deny them the admin surface.
      expect(
        await resolveAdminSession(handle(), {
          tokenHash: hashSessionToken(first),
          now: at(21),
        }),
      ).not.toBeNull();
    });

    it("survives EIGHT simultaneous uses of one link with exactly one session", async () => {
      // The race a read-then-write cannot survive: eight callbacks all observe an unused
      // nonce, then all eight insert.
      //
      // Making this test able to FAIL took two corrections, both of which the house rules
      // predict and the first draft got wrong anyway:
      //
      //  - `Promise.all` over one shared `Db` does NOT contend. That handle's pool holds
      //    three connections, so eight calls queue behind them and each transaction finishes
      //    before the next begins. A read-then-write sabotage passed this suite untouched.
      //    Each claimant therefore gets its OWN handle — its own connection — which is also
      //    what production looks like: eight separate serverless invocations.
      //  - They deliberately SHARE an administrator, because that is the real scenario: one
      //    operator's link opened eight times. `createAdminSession`'s authority read must
      //    therefore not be a `for update`, or that lock would serialize every claimant
      //    upstream of the index meant to decide, and this test would prove nothing about
      //    single use (the F-037 lesson).
      //
      // Even with distinct connections, eight short transactions may not interleave on every
      // run. The barrier below removes the luck: every claimant blocks until all eight have
      // started, so they reach the insert together.
      const nonce = nonceFor("c");
      const url = testDatabaseUrl(requiredDatabaseUrl(), testDatabaseName as string);
      const handles = Array.from({ length: 8 }, () => createDb(url));
      const claimants = Array.from({ length: 8 }, () => issueSessionToken());

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrived = 0;

      try {
        const results = await Promise.all(
          handles.map(async (claimantDb, index) => {
            arrived += 1;
            if (arrived === handles.length) release();
            await gate;
            return createAdminSession(claimantDb, {
              tokenHash: hashSessionToken(claimants[index] as string),
              administratorId: ids.administrator as string,
              issuedAt: at(22),
              magicNonceHash: nonce,
            });
          }),
        );

        const created = results.filter((r) => r.status === "created");
        const refused = results.filter((r) => r.status === "link_already_used");
        expect(created).toHaveLength(1);
        expect(refused).toHaveLength(7);
      } finally {
        await Promise.all(handles.map((claimantDb) => claimantDb.close()));
      }

      const rows = await sql()`
        select count(*)::int as n from admin_sessions where magic_nonce_hash = ${nonce}
      `;
      expect(rows[0]?.n).toBe(1);

      // And exactly one of the eight browsers can actually sign in.
      const authorizing = await Promise.all(
        claimants.map(async (token) =>
          (await resolveAdminSession(handle(), {
            tokenHash: hashSessionToken(token),
            now: at(22),
          })) !== null,
        ),
      );
      expect(authorizing.filter(Boolean)).toHaveLength(1);
    });

    it("consumes nothing when the administrator is not live", async () => {
      // Order matters: authority is checked before the link is spent, so a revoked operator's
      // link is not silently burned. If they are reinstated the link still works until it
      // expires — and, more importantly, a stranger cannot burn links by replaying them
      // against revoked administrators.
      const admin = await sql()`
        insert into administrators (email, authorized_at)
        values ('burned@viga.example', ${t0.toISOString()}) returning id
      `;
      const administratorId = admin[0]?.id as string;
      await sql()`
        update administrators set revoked_at = ${at(13).toISOString()}
        where id = ${administratorId}
      `;

      const nonce = nonceFor("d");
      const refused = await createAdminSession(handle(), {
        tokenHash: hashSessionToken(issueSessionToken()),
        administratorId,
        issuedAt: at(23),
        magicNonceHash: nonce,
      });
      expect(refused.status).toBe("not_an_administrator");

      const rows = await sql()`
        select count(*)::int as n from admin_sessions where magic_nonce_hash = ${nonce}
      `;
      expect(rows[0]?.n).toBe(0);
    });

    it("leaves link-less sessions unaffected by each other", async () => {
      // Bootstrap and test paths mint sessions with no link behind them. Many such sessions
      // must coexist: NULLs are distinct in a unique index, and if that ever stopped being
      // true the second direct session in a process would fail.
      const before = await sql()`
        select count(*)::int as n from admin_sessions where magic_nonce_hash is null
      `;
      for (let i = 0; i < 3; i += 1) {
        expect(
          (
            await createAdminSession(handle(), {
              tokenHash: hashSessionToken(issueSessionToken()),
              administratorId: ids.administrator as string,
              issuedAt: at(24),
            })
          ).status,
        ).toBe("created");
      }
      const after = await sql()`
        select count(*)::int as n from admin_sessions where magic_nonce_hash is null
      `;
      expect(after[0]?.n).toBe((before[0]?.n as number) + 3);
    });
  });
});
