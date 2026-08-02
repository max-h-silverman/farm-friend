import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAdminSession,
  createDb,
  clearAdminLoginFailures,
  reserveAdminLoginAttempt,
  type Db,
  type Sql,
} from "./index";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;
const FIXED_EMAIL = "board@vigavashon.org";
const NOW = new Date(Date.now() - 60_000);

function requiredDatabaseUrl(): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  return databaseUrl;
}

describe("administrator password schema and durable throttle (integration)", () => {
  let adminClient: Sql;
  let sql: Sql;
  let db: Db;
  let databaseName: string;
  let testUrl: string;

  beforeAll(async () => {
    databaseName = `farm_friend_admin_password_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(requiredDatabaseUrl(), { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${databaseName}`;
    testUrl = url.toString();
    const migrationClient = postgres(testUrl, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(testUrl, { max: 12 });
    db = createDb(testUrl);
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (sql) await sql.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await sql`truncate admin_login_failures, admin_sessions, administrators restart identity cascade`;
  });

  it("admits only the one fixed administrator identity and rejects NULL", async () => {
    await sql`insert into administrators (email, authorized_at) values (${FIXED_EMAIL}, ${NOW})`;
    await expect(
      sql`insert into administrators (email, authorized_at) values (${FIXED_EMAIL}, ${NOW})`,
    ).rejects.toThrow(/administrators_one_active_per_email/);
    await expect(
      sql`insert into administrators (email, authorized_at) values ('other@example.org', ${NOW})`,
    ).rejects.toThrow(/administrators_fixed_identity/);
    await expect(
      sql`insert into administrators (email, authorized_at) values (${null}, ${NOW})`,
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("creates a session with no magic-link provenance column", async () => {
    const rows = await sql`
      insert into administrators (email, authorized_at) values (${FIXED_EMAIL}, ${NOW}) returning id
    `;
    const result = await createAdminSession(db, {
      tokenHash: "a".repeat(64),
      administratorId: rows[0]!.id as string,
      issuedAt: NOW,
    });
    expect(result).toEqual({ status: "created" });
    const columns = await sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'admin_sessions'
      order by column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      "administrator_id", "expires_at", "id", "issued_at", "revoked_at", "token_hash",
    ]);

    await expect(sql`
      insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
      values ('short', ${rows[0]!.id}, ${NOW}, ${new Date(NOW.getTime() + 1_000)})
    `).rejects.toThrow(/admin_sessions_token_hash_shape/);
    await expect(sql`
      insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
      values (${"b".repeat(64)}, ${rows[0]!.id}, ${NOW}, ${NOW})
    `).rejects.toThrow(/admin_sessions_bounded_lifetime/);
    await expect(sql`
      insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
      values (${"c".repeat(64)}, ${randomUUID()}, ${NOW}, ${new Date(NOW.getTime() + 1_000)})
    `).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects every malformed or NULL durable failure projection", async () => {
    const future = new Date(NOW.getTime() + 60_000);
    const validHash = "f".repeat(64);
    await expect(sql`
      insert into admin_login_failures
        (bucket_hash, failure_count, window_expires_at, updated_at)
      values ('short', 1, ${future}, ${NOW})
    `).rejects.toThrow(/admin_login_failures_bucket_hash_shape/);
    await expect(sql`
      insert into admin_login_failures
        (bucket_hash, failure_count, window_expires_at, updated_at)
      values (${validHash}, 0, ${future}, ${NOW})
    `).rejects.toThrow(/admin_login_failures_positive_count/);
    await expect(sql`
      insert into admin_login_failures
        (bucket_hash, failure_count, window_expires_at, updated_at)
      values (${validHash}, 1, ${NOW}, ${NOW})
    `).rejects.toThrow(/admin_login_failures_future_window/);

    for (const values of [
      [null, 1, future, NOW],
      [validHash, null, future, NOW],
      [validHash, 1, null, NOW],
      [validHash, 1, future, null],
    ] as const) {
      await expect(sql`
        insert into admin_login_failures
          (bucket_hash, failure_count, window_expires_at, updated_at)
        values (${values[0]}, ${values[1]}, ${values[2]}, ${values[3]})
      `).rejects.toMatchObject({ code: "23502" });
    }
  });

  it("arbitrates the exact failure limit under genuine queued contention", async () => {
    const accountBucketHash = "a".repeat(64);
    const clientBucketHash = "b".repeat(64);
    const gate = postgres(testUrl, { max: 1 });
    const claimantDbs = Array.from({ length: 6 }, () => createDb(testUrl));
    let claimants: Array<Promise<Awaited<ReturnType<typeof reserveAdminLoginAttempt>>>> = [];
    await gate.begin(async (tx) => {
      await tx`
        insert into admin_login_failures (bucket_hash, failure_count, window_expires_at, updated_at)
        values (${accountBucketHash}, 1, ${new Date(NOW.getTime() + 60_000)}, ${NOW})
      `;
      await tx`
        select bucket_hash from admin_login_failures
        where bucket_hash = ${accountBucketHash} for update
      `;
      claimants = claimantDbs.map((claimantDb) =>
        reserveAdminLoginAttempt(claimantDb, {
          accountBucketHash,
          clientBucketHash,
          now: NOW,
          clientLimit: 5,
          accountLimit: 20,
          windowMs: 60_000,
        }),
      );
      let waitingCount = 0;
      for (let tries = 0; tries < 20 && waitingCount < 6; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const waiting = await sql`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
        `;
        waitingCount = waiting[0]!.count as number;
      }
      expect(waitingCount).toBeGreaterThanOrEqual(6);
    });
    const results = await Promise.all(claimants);
    expect(results.filter((row) => row.allowed)).toHaveLength(5);
    expect(results.filter((row) => !row.allowed)).toHaveLength(1);
    await Promise.all(claimantDbs.map((claimantDb) => claimantDb.close()));
    await gate.end();
  });

  it("releases exactly one successful reservation and retains concurrent failures", async () => {
    const accountBucketHash = "c".repeat(64);
    const clientBucketHash = "d".repeat(64);
    const otherClientBucketHash = "e".repeat(64);
    const first = await reserveAdminLoginAttempt(db, {
      accountBucketHash, clientBucketHash, now: NOW, clientLimit: 5,
      accountLimit: 20, windowMs: 60_000,
    });
    await reserveAdminLoginAttempt(db, {
      accountBucketHash, clientBucketHash: otherClientBucketHash, now: NOW,
      clientLimit: 5, accountLimit: 20, windowMs: 60_000,
    });
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("fixture reservation failed");
    await clearAdminLoginFailures(db, { accountBucketHash, clientBucketHash });
    const rows = await sql`select bucket_hash from admin_login_failures order by bucket_hash`;
    expect(rows.map((row) => row.bucket_hash)).toEqual([otherClientBucketHash]);
  });

  it("enforces the account-wide aggregate across clients and resets exactly at expiry", async () => {
    const accountBucketHash = "1".repeat(64);
    for (let index = 0; index < 20; index += 1) {
      const result = await reserveAdminLoginAttempt(db, {
        accountBucketHash,
        clientBucketHash: index.toString(16).padStart(64, "0"),
        now: NOW,
        clientLimit: 5,
        accountLimit: 20,
        windowMs: 60_000,
      });
      expect(result.allowed).toBe(true);
    }
    const blockedClient = "2".repeat(64);
    expect(await reserveAdminLoginAttempt(db, {
      accountBucketHash,
      clientBucketHash: blockedClient,
      now: NOW,
      clientLimit: 5,
      accountLimit: 20,
      windowMs: 60_000,
    })).toEqual({ allowed: false });
    expect(await sql`
      select failure_count from admin_login_failures where bucket_hash = ${accountBucketHash}
    `).toEqual([{ failure_count: 20 }]);
    expect(await sql`
      select bucket_hash from admin_login_failures where bucket_hash = ${blockedClient}
    `).toHaveLength(0);

    const expiry = new Date(NOW.getTime() + 60_000);
    const recovered = await reserveAdminLoginAttempt(db, {
      accountBucketHash,
      clientBucketHash: blockedClient,
      now: expiry,
      clientLimit: 5,
      accountLimit: 20,
      windowMs: 60_000,
    });
    expect(recovered).toEqual({
      allowed: true,
      windowExpiresAt: new Date(expiry.getTime() + 60_000),
    });
    expect(await sql`
      select failure_count, window_expires_at from admin_login_failures
      where bucket_hash in (${accountBucketHash}, ${blockedClient})
      order by bucket_hash
    `).toEqual([
      { failure_count: 1, window_expires_at: new Date(expiry.getTime() + 60_000) },
      { failure_count: 1, window_expires_at: new Date(expiry.getTime() + 60_000) },
    ]);
  });
});
