import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

// F-074 — migration 0023, verified BY EFFECT against a freshly migrated database (B-022).
//
// Never by the migration's exit status: a migration reports success and can still have created
// nothing. Every assertion below either reads a real row back or proves Postgres REFUSED a
// write.
//
// **The four CHECK constraints are the whole reason this file exists.** drizzle-kit omits CHECK
// constraints entirely when it generates SQL, so a constraint declared in `schema.ts` and left
// to the generator is enforced by NOTHING while `schema.ts` reads as though it were. The
// application suites cannot see the difference — they never write a violating row — so the only
// evidence is a refusal measured here.
//
// The coherence pairs are asserted in BOTH directions, because a CHECK *passes* on NULL: a
// one-directional test ("an actor is recorded") would admit a farm marked by nobody, and only
// its mirror image would admit an actor recorded against a real farm.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-074 test sellers migration (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let administratorId = "";
  let farmId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };
  const hash = (seed: string) => seed.repeat(64).slice(0, 64);
  const now = new Date();

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_testfarms_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 1 });

    const admins = await client()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${now}) returning id
    `;
    administratorId = admins[0]?.id as string;
    const sellers = await client()`
      insert into sellers (name) values ('Constraint Farm') returning id
    `;
    farmId = sellers[0]?.id as string;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("creates the two test-farm columns, nullable, with no default", async () => {
    const columns = await client()`
      select column_name, is_nullable, column_default
      from information_schema.columns
      where table_name = 'sellers'
        and column_name in ('test_seller_at', 'test_seller_by_administrator_id')
      order by column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      "test_seller_at",
      "test_seller_by_administrator_id",
    ]);
    // Nullable and defaultless, which is what makes the migration safe to apply AHEAD of the
    // image that reads it: every existing farm stays a real farm.
    for (const column of columns) {
      expect(column.is_nullable).toBe("YES");
      expect(column.column_default).toBeNull();
    }
  });

  it("REFUSES a farm marked as a test farm by nobody, and an actor on a real farm", async () => {
    // Direction one: a timestamp with no actor. This is the half a naive per-column CHECK
    // would pass, because it is satisfied on NULL.
    await expect(
      client()`
        update sellers set test_seller_at = ${now}, test_seller_by_administrator_id = null
        where id = ${farmId}
      `,
    ).rejects.toThrow(/farms_coherent_test_farm/);

    // Direction two: an actor with no timestamp — a farm "marked" by someone that is not
    // actually a test farm.
    await expect(
      client()`
        update sellers
        set test_seller_at = null, test_seller_by_administrator_id = ${administratorId}
        where id = ${farmId}
      `,
    ).rejects.toThrow(/farms_coherent_test_farm/);

    // And the legal shape really is legal — otherwise the two refusals above would pass
    // against a constraint that refuses everything.
    await client()`
      update sellers
      set test_seller_at = ${now}, test_seller_by_administrator_id = ${administratorId}
      where id = ${farmId}
    `;
    const marked = await client()`select test_seller_at from sellers where id = ${farmId}`;
    expect(marked[0]?.test_seller_at).not.toBeNull();

    await client()`
      update sellers set test_seller_at = null, test_seller_by_administrator_id = null
      where id = ${farmId}
    `;
  });

  it("REFUSES a phone row whose hash is not a 64-character hex digest", async () => {
    // The one failure this column exists to make impossible: a raw number stored where a hash
    // belongs. A short value is the tell.
    await expect(
      client()`
        insert into administrator_phones (
          phone_hash, phone_last_four, added_by_administrator_id, added_at
        ) values ('+12065550139', '0139', ${administratorId}, ${now})
      `,
    ).rejects.toThrow(/administrator_phones_phone_hash_shape/);
  });

  it("REFUSES anything but exactly four digits in the suffix", async () => {
    for (const bad of ["12065550139", "013", "abcd", ""]) {
      await expect(
        client()`
          insert into administrator_phones (
            phone_hash, phone_last_four, added_by_administrator_id, added_at
          ) values (${hash("a")}, ${bad}, ${administratorId}, ${now})
        `,
      ).rejects.toThrow(/administrator_phones_last_four_shape/);
    }
  });

  it("REFUSES a revocation recording no actor, and an actor with no revocation", async () => {
    const inserted = await client()`
      insert into administrator_phones (
        phone_hash, phone_last_four, added_by_administrator_id, added_at
      ) values (${hash("b")}, '0139', ${administratorId}, ${now})
      returning id
    `;
    const id = inserted[0]?.id as string;

    await expect(
      client()`
        update administrator_phones
        set revoked_at = ${now}, revoked_by_administrator_id = null where id = ${id}
      `,
    ).rejects.toThrow(/administrator_phones_coherent_revocation/);

    await expect(
      client()`
        update administrator_phones
        set revoked_at = null, revoked_by_administrator_id = ${administratorId}
        where id = ${id}
      `,
    ).rejects.toThrow(/administrator_phones_coherent_revocation/);
  });

  it("allows one LIVE listing per number while keeping revoked history", async () => {
    const phoneHash = hash("c");
    const first = await client()`
      insert into administrator_phones (
        phone_hash, phone_last_four, added_by_administrator_id, added_at
      ) values (${phoneHash}, '0139', ${administratorId}, ${now})
      returning id
    `;

    // A second LIVE row for the same number is refused by the partial unique index.
    await expect(
      client()`
        insert into administrator_phones (
          phone_hash, phone_last_four, added_by_administrator_id, added_at
        ) values (${phoneHash}, '0139', ${administratorId}, ${now})
      `,
    ).rejects.toThrow(/administrator_phones_one_live/);

    // Revoke it, and the same number may be listed again — the reason this is a PARTIAL index
    // rather than a plain UNIQUE. Re-listing must not resurrect the old row.
    await client()`
      update administrator_phones
      set revoked_at = ${now}, revoked_by_administrator_id = ${administratorId}
      where id = ${first[0]?.id as string}
    `;
    const second = await client()`
      insert into administrator_phones (
        phone_hash, phone_last_four, added_by_administrator_id, added_at
      ) values (${phoneHash}, '0139', ${administratorId}, ${now})
      returning id
    `;
    expect(second[0]?.id).not.toBe(first[0]?.id);

    // Both rows survive: the revoked one is history, not a deletion.
    const all = await client()`
      select id from administrator_phones where phone_hash = ${phoneHash}
    `;
    expect(all).toHaveLength(2);
  });

  it("stores NO raw phone number column at all", async () => {
    // `contacts` keeps raw E.164 because the outbound sender needs something to send TO.
    // Nothing on this path ever sends, so the raw column would be stored personal data with no
    // reader — the thing Golden Rule #5 exists to prevent. Asserted against the real schema
    // rather than left to the schema file's word.
    const columns = await client()`
      select column_name from information_schema.columns
      where table_name = 'administrator_phones'
    `;
    const names = columns.map((row) => row.column_name as string);
    expect(names).not.toContain("phone_e164");
    expect(names).toContain("phone_hash");
  });
});
