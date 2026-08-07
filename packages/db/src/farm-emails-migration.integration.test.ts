import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

// F-078 — migration 0024, verified BY EFFECT against a freshly migrated database (B-022).
//
// Never by the migration's exit status: a migration reports success and can still have created
// nothing. Every assertion below either reads a real row back or proves Postgres REFUSED a
// write.
//
// **The CHECK constraints are the whole reason this file exists.** drizzle-kit omits CHECK
// constraints entirely when it generates SQL, so a constraint declared in `schema.ts` and left
// to the generator is enforced by NOTHING while `schema.ts` reads as though it were. The
// application suites cannot see the difference — they never write a violating row — so the only
// evidence is a refusal measured here.
//
// ## What this table is, and the privacy rule it exists under
//
// `farm_emails` is the roster VIGA already holds, so a farmer can prove they control an address
// on file for their farm without a volunteer vouching for them. It is Golden Rule #5 applied to
// a second kind of personal data: the addresses are largely PERSONAL (`dhusch@hotmail.com`), so
// they carry the same weight as phone numbers.
//
// The shape mirrors `contacts` deliberately rather than inventing a second pattern: the raw
// address lives in EXACTLY ONE column read only by the send path, and the HASH is the only
// lookup and log key.
//
// **Verifying is not publishing** (max, 2026-08-06). Six farms answered "No" to putting contact
// email on the printed map and two left it blank; their addresses are still stored and still
// authenticate. Nothing here is a display column, and no public read path selects from this
// table — asserted in `farm-email-privacy.test.ts`, not here.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-078 farm emails migration (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let farmId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };
  /**
   * A 64-character lowercase hex digest, the shape every hash column in this schema uses.
   *
   * Built from a real hash rather than a repeated letter: the constraint requires `[0-9a-f]`,
   * so `"h".repeat(64)` is not a digest at all — and using one here would make every insert
   * below fail for a reason unrelated to what it is testing.
   */
  const digest = (seed: string) =>
    createHash("sha256").update(seed).digest("hex");
  const now = new Date();

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_farmemails_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 1 });

    const farms = await client()`
      insert into farms (name) values (${`Email Farm ${randomUUID()}`}) returning id
    `;
    farmId = farms[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  /** Insert one address, returning the row so the test reads back what was actually stored. */
  async function addEmail(input: {
    farm?: string;
    email: string;
    hash?: string;
  }): Promise<Record<string, unknown>> {
    const rows = await client()`
      insert into farm_emails (farm_id, email, email_hash, added_at)
      values (
        ${input.farm ?? farmId}, ${input.email},
        ${input.hash ?? digest(input.email.length.toString(16))}, ${now}
      )
      returning *
    `;
    return rows[0] as Record<string, unknown>;
  }

  it("stores an address against its farm, and reads it back", async () => {
    // By effect. A migration that created nothing would fail here rather than at exit status.
    const row = await addEmail({ email: "dhusch@hotmail.com", hash: digest("a") });

    expect(row.farm_id).toBe(farmId);
    expect(row.email).toBe("dhusch@hotmail.com");
    expect(row.email_hash).toBe(digest("a"));
    expect(row.id).toBeDefined();
  });

  it("holds SEVERAL addresses for one farm — five real farms have more than one", async () => {
    // Lavender Hill has three, from two different columns of VIGA's form. A one-address-per-farm
    // shape would silently drop two of them and lock that farmer out of two of their own
    // addresses.
    const farms = await client()`
      insert into farms (name) values (${`Multi ${randomUUID()}`}) returning id
    `;
    const multi = farms[0]?.id as string;

    for (const [index, email] of [
      "cathy@lavenderhillvashon.com",
      "info@lavenderhillvashon.com",
      "shop@lavenderhillvashon.com",
    ].entries()) {
      await addEmail({ farm: multi, email, hash: digest(String(index)) });
    }

    const rows = await client()`
      select email from farm_emails where farm_id = ${multi} order by email
    `;
    expect(rows.map((r) => r.email)).toEqual([
      "cathy@lavenderhillvashon.com",
      "info@lavenderhillvashon.com",
      "shop@lavenderhillvashon.com",
    ]);
  });

  it("REFUSES the same address twice for one farm, case- and space-insensitively", async () => {
    // Re-running the ingest must not double the roster. The uniqueness is on the NORMALIZED
    // address, because "Info@Lavender..." and "info@lavender..." are one address and a farmer
    // verifying against either must hit the same row.
    const farms = await client()`
      insert into farms (name) values (${`Dup ${randomUUID()}`}) returning id
    `;
    const dup = farms[0]?.id as string;
    await addEmail({ farm: dup, email: "info@example.org", hash: digest("b") });

    await expect(
      addEmail({ farm: dup, email: "  INFO@example.org  ", hash: digest("c") }),
    ).rejects.toThrow();
  });

  it("ALLOWS one address on two different farms, though the real corpus has none", async () => {
    // Measured, not assumed: zero addresses are shared between farms in VIGA's 32 rows, so
    // email → farm is unambiguous today. The database still permits it, deliberately — a
    // couple who farm two plots from one inbox is a real thing, and refusing it would be this
    // schema inventing a rule the product never decided. What must never happen is one
    // address verifying the WRONG farm, and that is a query-scope property, not a constraint.
    const farms = await client()`
      insert into farms (name) values (${`Shared ${randomUUID()}`}) returning id
    `;
    const other = farms[0]?.id as string;
    await addEmail({ email: "shared@example.org", hash: digest("d") });

    const row = await addEmail({ farm: other, email: "shared@example.org", hash: digest("d") });
    expect(row.farm_id).toBe(other);
  });

  it("REFUSES a blank address — including tab- and newline-only", async () => {
    // Migration 0020's lesson, applied. `btrim(text)` strips SPACES ONLY, so a naive not-blank
    // CHECK admits "\t" and "\n" — a value that is blank to every human and to every reader,
    // stored as though it were an address. The constraint names the whitespace class
    // explicitly for exactly this reason.
    for (const blank of ["", "   ", "\t", "\n", " \t\r\n "]) {
      await expect(
        addEmail({ email: blank, hash: digest("e") }),
        JSON.stringify(blank),
      ).rejects.toThrow();
    }
  });

  it("REFUSES a hash that is not a 64-character hex digest", async () => {
    // The hash is the lookup key, so a malformed one is a row that can never be found. Both
    // directions: too short, too long, and non-hex characters.
    for (const bad of [
      "",
      "abc",
      digest("f") + "0", // 65 chars
      digest("f").slice(0, 63), // 63 chars
      "z".repeat(64), // right length, not hex
      digest("f").toUpperCase(), // right digest, wrong case — one spelling only
    ]) {
      await expect(
        addEmail({ email: `bad-${bad.length}-${bad.slice(0, 3)}@example.org`, hash: bad }),
        bad.slice(0, 8),
      ).rejects.toThrow();
    }
  });

  it("REFUSES an address for a farm that does not exist", async () => {
    await expect(
      addEmail({ farm: randomUUID(), email: "orphan@example.org", hash: digest("g") }),
    ).rejects.toThrow();
  });

  it("keeps the roster when a farm is renamed, and blocks deleting a farm that has one", async () => {
    // `on delete restrict`, matching every other reference to `farms` in this schema. A farm
    // silently losing its roster is a farmer who can no longer prove who they are.
    const farms = await client()`
      insert into farms (name) values (${`Rename ${randomUUID()}`}) returning id
    `;
    const target = farms[0]?.id as string;
    await addEmail({ farm: target, email: "keep@example.org", hash: digest("h") });

    await client()`update farms set name = 'Renamed Farm' where id = ${target}`;
    const kept = await client()`select email from farm_emails where farm_id = ${target}`;
    expect(kept).toHaveLength(1);

    await expect(client()`delete from farms where id = ${target}`).rejects.toThrow();
  });
});
