import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// F-079 / migration 0025 — every constraint proven to genuinely REFUSE.
//
// `drizzle-kit generate` silently drops CHECK constraints and partial unique indexes, recorded
// first-hand in 0024's header. So `schema.ts` declaring a rule is not evidence that the
// database enforces it, and neither is a migration file that was never applied. Each test below
// attempts a write that must fail and asserts it did.
//
// **The control matters as much as the refusals.** A schema that refused EVERYTHING would pass
// every rejection test here, so a valid row is also inserted and asserted to be accepted.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const NOW = new Date("2026-08-06T12:00:00Z");
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

describe("migration 0025 seller_email_verifications (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let databaseName = "";
  let farmId = "";
  let otherSellerId = "";

  const sql = () => {
    if (!client) throw new Error("no database client");
    return client;
  };

  const insert = async (overrides: Record<string, unknown> = {}) => {
    const row = {
      seller_id: farmId,
      email_hash: DIGEST,
      code_hash: OTHER_DIGEST,
      issued_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 1_800_000).toISOString(),
      consumed_at: null as string | null,
      attempt_count: 0,
      grant_hash: null as string | null,
      grant_expires_at: null as string | null,
      ...overrides,
    };
    return sql()`
      insert into seller_email_verifications
        (seller_id, email_hash, code_hash, issued_at, expires_at, consumed_at, attempt_count,
         grant_hash, grant_expires_at)
      values (${row.seller_id as string}, ${row.email_hash as string},
              ${row.code_hash as string}, ${row.issued_at as string},
              ${row.expires_at as string}, ${row.consumed_at},
              ${row.attempt_count as number},
              ${row.grant_hash}, ${row.grant_expires_at})
      returning id
    `;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_verif_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 2 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });

    const sellers = await sql()`
      insert into sellers (name, created_at)
      values ('Constraint Farm', ${NOW.toISOString()}), ('Other Farm', ${NOW.toISOString()})
      returning id, name
    `;
    farmId = (sellers.find((f) => f.name === "Constraint Farm")?.id ?? "") as string;
    otherSellerId = (sellers.find((f) => f.name === "Other Farm")?.id ?? "") as string;
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (adminClient) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end();
    }
  });

  it("ACCEPTS a valid row — the control that stops 'refuses everything' reading as success", async () => {
    const rows = await insert();
    expect(rows).toHaveLength(1);
    await sql()`delete from seller_email_verifications`;
  });

  it("REFUSES an email hash that is not a 64-character lowercase hex digest", async () => {
    for (const bad of ["", "short", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      await expect(insert({ email_hash: bad }), bad).rejects.toThrow(
        /seller_email_verifications_email_hash_is_digest/,
      );
    }
  });

  it("REFUSES a code hash that is not a 64-character lowercase hex digest", async () => {
    for (const bad of ["", "short", "A".repeat(64), "z".repeat(64)]) {
      await expect(insert({ code_hash: bad }), bad).rejects.toThrow(
        /seller_email_verifications_code_hash_is_digest/,
      );
    }
  });

  it("REFUSES a code that expires before or exactly when it was issued", async () => {
    // Exactly-at-issue is dead on arrival: the farmer would be refused a code the records show
    // as valid. A backwards clock produces precisely this row.
    await expect(insert({ expires_at: NOW.toISOString() })).rejects.toThrow(
      /seller_email_verifications_expires_after_issue/,
    );
    await expect(
      insert({ expires_at: new Date(NOW.getTime() - 1000).toISOString() }),
    ).rejects.toThrow(/seller_email_verifications_expires_after_issue/);
  });

  it("REFUSES a code consumed before it was issued", async () => {
    await expect(
      insert({ consumed_at: new Date(NOW.getTime() - 1000).toISOString() }),
    ).rejects.toThrow(/seller_email_verifications_consumed_after_issue/);
  });

  it("ACCEPTS a NULL consumed_at, because 'not yet consumed' must be legal", async () => {
    // The direction that needs stating: a CHECK returns NULL — which Postgres treats as
    // PASSING — for an unconsumed row. That is correct HERE, and it is the same semantics that
    // silently inverts a guard when the intent is the opposite.
    const rows = await insert({ consumed_at: null });
    expect(rows).toHaveLength(1);
    await sql()`delete from seller_email_verifications`;
  });

  it("REFUSES a negative attempt count", async () => {
    await expect(insert({ attempt_count: -1 })).rejects.toThrow(
      /seller_email_verifications_attempts_not_negative/,
    );
  });

  it("REFUSES a second LIVE code for the same farm", async () => {
    await insert();
    await expect(insert({ code_hash: "c".repeat(64) })).rejects.toThrow(
      /seller_email_verifications_one_live_per_farm/,
    );
    await sql()`delete from seller_email_verifications`;
  });

  it("PERMITS a new code once the previous one is consumed — the index is PARTIAL", async () => {
    // If the index were not partial, a farm could never verify twice, which would break
    // re-verification entirely rather than merely limiting concurrency.
    await insert({ consumed_at: NOW.toISOString() });
    const rows = await insert({ code_hash: "c".repeat(64) });
    expect(rows).toHaveLength(1);
    await sql()`delete from seller_email_verifications`;
  });

  it("PERMITS two different sellers to hold live codes simultaneously", async () => {
    await insert();
    const rows = await insert({ seller_id: otherSellerId });
    expect(rows).toHaveLength(1);
    await sql()`delete from seller_email_verifications`;
  });

  it("REFUSES a row naming a farm that does not exist", async () => {
    await expect(insert({ seller_id: randomUUID() })).rejects.toThrow(/seller_id/);
  });

  it("REFUSES a grant hash that is not a digest", async () => {
    await expect(
      insert({ grant_hash: "nope", grant_expires_at: new Date(NOW.getTime() + 1000).toISOString() }),
    ).rejects.toThrow(/seller_email_verifications_grant_hash_is_digest/);
  });

  it("REFUSES a grant with no expiry, and an expiry with no grant — BOTH directions", async () => {
    // A coherence PAIR. The one-directional form passes on NULL and would enforce nothing,
    // which is 0023's lesson: a grant that never ages out is a standing key to the listing.
    await expect(insert({ grant_hash: "c".repeat(64), grant_expires_at: null })).rejects.toThrow(
      /seller_email_verifications_grant_coherent/,
    );
    await expect(
      insert({
        grant_hash: null,
        grant_expires_at: new Date(NOW.getTime() + 1000).toISOString(),
      }),
    ).rejects.toThrow(/seller_email_verifications_grant_coherent/);
  });

  it("ACCEPTS a row with neither a grant nor an expiry — an unredeemed code", async () => {
    const rows = await insert({ grant_hash: null, grant_expires_at: null });
    expect(rows).toHaveLength(1);
    await sql()`delete from seller_email_verifications`;
  });

  it("holds NO raw email column at all, read from the real schema", async () => {
    // Golden Rule #5 — the raw address lives in exactly one column (`seller_emails.email`).
    // Read from `information_schema` rather than from the schema file's word.
    const columns = await sql()`
      select column_name from information_schema.columns
      where table_name = 'seller_email_verifications'
    `;
    const names = columns.map((c) => c.column_name as string);
    expect(names).toContain("email_hash");
    expect(names).not.toContain("email");
  });
});
