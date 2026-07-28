import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// F-025a — the durable constraints under administrator identity and sessions.
//
// The defect this closes: `administrators` identified an operator only by phone contact while
// the login path identifies people by email, so an authenticated operator could never be
// resolved to an administrator row. Identity is now email, and the DATABASE enforces the
// properties the login path depends on — not the application layer, which can be bypassed.

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

describe("administrator identity and sessions (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let testDatabaseName: string | undefined;

  // Clock-derived, never a date literal (B-003 tripwire).
  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const offset = (hours: number) =>
    new Date(anchor + hours * 60 * 60 * 1000).toISOString();
  const t0 = offset(0);
  const t1 = offset(1);
  const t2 = offset(2);

  const db = () => client as ReturnType<typeof postgres>;
  const hash = (seed: string) => seed.repeat(64).slice(0, 64);

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_admin_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    client = postgres(testDatabaseUrl(baseUrl, testDatabaseName), { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("identifies an administrator by email, with no phone contact required", async () => {
    // The core of the fix: an operator who has never texted Farm Friend is still an operator.
    const rows = await db()`
      insert into administrators (email, authorized_at)
      values ('operator@viga.example', ${t0})
      returning id, email, contact_id
    `;
    expect(rows[0]?.contact_id).toBeNull();
    expect(rows[0]?.email).toBe("operator@viga.example");
  });

  it("requires an email on every administrator", async () => {
    // Without this, a row could exist that no login could ever resolve — authorization
    // that is invisible to the only path that reads it.
    await expect(
      db()`insert into administrators (authorized_at) values (${t0})`,
    ).rejects.toThrow(/email/i);
  });

  it("rejects a non-lowercase or structurally invalid email", async () => {
    // The login path lowercases before lookup, so a mixed-case row would be a grant that can
    // never be found. The database refuses to hold one rather than trusting every writer.
    await expect(
      db()`
        insert into administrators (email, authorized_at)
        values ('Mixed@VIGA.example', ${t0})
      `,
    ).rejects.toThrow(/administrators_email_normalized/);

    await expect(
      db()`
        insert into administrators (email, authorized_at)
        values ('not-an-email', ${t0})
      `,
    ).rejects.toThrow(/administrators_email_normalized/);
  });

  it("permits at most one LIVE administrator per email, while keeping revoked history", async () => {
    const email = "duplicate@viga.example";
    await db()`
      insert into administrators (email, authorized_at) values (${email}, ${t0})
    `;

    // A second live grant on the same address would make the login lookup ambiguous.
    await expect(
      db()`
        insert into administrators (email, authorized_at) values (${email}, ${t1})
      `,
    ).rejects.toThrow(/administrators_one_active_per_email/);

    // Revoking frees the address, and the revoked row REMAINS for the audit trail.
    await db()`
      update administrators set revoked_at = ${t1} where email = ${email}
    `;
    await db()`
      insert into administrators (email, authorized_at) values (${email}, ${t2})
    `;

    const all = await db()`
      select revoked_at from administrators where email = ${email} order by authorized_at
    `;
    expect(all).toHaveLength(2);
    expect(all[0]?.revoked_at).not.toBeNull();
    expect(all[1]?.revoked_at).toBeNull();
  });

  it("stores only a hashed session token, never the token itself", async () => {
    const admin = await db()`
      insert into administrators (email, authorized_at)
      values ('session@viga.example', ${t0}) returning id
    `;
    const administratorId = admin[0]?.id as string;

    await db()`
      insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
      values (${hash("a")}, ${administratorId}, ${t0}, ${t1})
    `;

    // A truncated or plaintext value is refused: the shape check is what makes "we store the
    // hash" a database guarantee rather than a comment.
    await expect(
      db()`
        insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
        values ('short', ${administratorId}, ${t0}, ${t1})
      `,
    ).rejects.toThrow(/admin_sessions_token_hash_shape/);

    await expect(
      db()`
        insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
        values (${"NOTHEX".repeat(11).slice(0, 64)}, ${administratorId}, ${t0}, ${t1})
      `,
    ).rejects.toThrow(/admin_sessions_token_hash_shape/);
  });

  it("refuses a duplicate session token hash", async () => {
    const admin = await db()`
      insert into administrators (email, authorized_at)
      values ('dupe-session@viga.example', ${t0}) returning id
    `;
    const administratorId = admin[0]?.id as string;
    await db()`
      insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
      values (${hash("b")}, ${administratorId}, ${t0}, ${t1})
    `;
    await expect(
      db()`
        insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
        values (${hash("b")}, ${administratorId}, ${t0}, ${t1})
      `,
    ).rejects.toThrow(/admin_sessions_token_hash_unique/);
  });

  it("refuses an unbounded or backwards session lifetime", async () => {
    const admin = await db()`
      insert into administrators (email, authorized_at)
      values ('lifetime@viga.example', ${t0}) returning id
    `;
    const administratorId = admin[0]?.id as string;

    // A session that expires when it was issued, or before, is not a session.
    await expect(
      db()`
        insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
        values (${hash("c")}, ${administratorId}, ${t1}, ${t1})
      `,
    ).rejects.toThrow(/admin_sessions_bounded_lifetime/);

    await expect(
      db()`
        insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
        values (${hash("d")}, ${administratorId}, ${t2}, ${t1})
      `,
    ).rejects.toThrow(/admin_sessions_bounded_lifetime/);
  });

  it("refuses a session belonging to no administrator", async () => {
    // A dangling session is a credential with no authority behind it; the role lookup would
    // have nothing to check against.
    await expect(
      db()`
        insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
        values (${hash("e")}, ${randomUUID()}, ${t0}, ${t1})
      `,
    ).rejects.toThrow(/admin_sessions_administrator/);
  });

  it("keeps sessions out of the raw-phone surface", async () => {
    // Golden Rule #5: the raw E.164 lives in exactly one column. Adding an admin identity
    // must not have introduced a second personal identifier column outside contacts.
    const rawPhoneColumns = await db()`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name <> 'contacts'
        and column_name in ('phone', 'phone_number', 'phone_e164', 'raw_phone')
    `;
    expect(rawPhoneColumns).toHaveLength(0);

    // And the session table holds no personal data at all beyond the administrator link.
    const sessionColumns = await db()`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'admin_sessions'
      order by column_name
    `;
    expect(sessionColumns.map((row) => row.column_name)).toEqual([
      "administrator_id",
      "expires_at",
      "id",
      "issued_at",
      "magic_nonce_hash",
      "revoked_at",
      "token_hash",
    ]);
  });

  // GL-004 — the magic link is a ONE-USE credential.
  //
  // The consume record is a column on `admin_sessions` under a unique index, because a link
  // being used and a session existing are the SAME event: the session row IS the record that
  // the link was spent. The database owns the exclusion; nothing above it decides.

  describe("one-use magic links", () => {
    it("permits at most one session per magic-link nonce", async () => {
      const admin = await db()`
        insert into administrators (email, authorized_at)
        values ('nonce-unique@viga.example', ${t0}) returning id
      `;
      const administratorId = admin[0]?.id as string;

      await db()`
        insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at,
          magic_nonce_hash)
        values (${hash("1")}, ${administratorId}, ${t0}, ${t1}, ${hash("9")})
      `;

      // A DIFFERENT session token — this is exactly the replay: the same link opened twice
      // mints fresh session material each time, so nothing but the nonce can refuse it.
      await expect(
        db()`
          insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at,
            magic_nonce_hash)
          values (${hash("2")}, ${administratorId}, ${t0}, ${t1}, ${hash("9")})
        `,
      ).rejects.toThrow(/admin_sessions_one_per_magic_nonce/);
    });

    it("stores only a hashed nonce, never the nonce itself", async () => {
      const admin = await db()`
        insert into administrators (email, authorized_at)
        values ('nonce-shape@viga.example', ${t0}) returning id
      `;
      const administratorId = admin[0]?.id as string;

      // Same bar as the session token hash: a short or non-hex value means the raw nonce was
      // stored, or truncated to something enumerable.
      await expect(
        db()`
          insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at,
            magic_nonce_hash)
          values (${hash("3")}, ${administratorId}, ${t0}, ${t1}, 'short')
        `,
      ).rejects.toThrow(/admin_sessions_magic_nonce_hash_shape/);

      await expect(
        db()`
          insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at,
            magic_nonce_hash)
          values (${hash("4")}, ${administratorId}, ${t0}, ${t1},
            ${"NOTHEX".repeat(11).slice(0, 64)})
        `,
      ).rejects.toThrow(/admin_sessions_magic_nonce_hash_shape/);
    });

    it("still permits sessions that came from no link at all", async () => {
      // The bootstrap and test paths mint sessions directly. A NULL nonce must stay legal,
      // and — because Postgres treats NULLs as distinct in a unique index — many of them
      // must coexist without colliding with each other.
      const admin = await db()`
        insert into administrators (email, authorized_at)
        values ('no-link@viga.example', ${t0}) returning id
      `;
      const administratorId = admin[0]?.id as string;

      for (const seed of ["5", "6", "7"]) {
        await db()`
          insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
          values (${hash(seed)}, ${administratorId}, ${t0}, ${t1})
        `;
      }
      const rows = await db()`
        select count(*)::int as n from admin_sessions
        where administrator_id = ${administratorId} and magic_nonce_hash is null
      `;
      expect(rows[0]?.n).toBe(3);
    });
  });
});
