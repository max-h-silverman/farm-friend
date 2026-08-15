import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

// Migration 0028 — the phone an invited farmer states on the onboarding form, verified BY EFFECT
// against a freshly migrated database (B-022).
//
// Never by the migration's exit status: a migration reports success and can still have created
// nothing. Every assertion below either reads a real row back or proves Postgres REFUSED a write.
//
// **The CHECK constraints are the whole reason this file exists.** drizzle-kit omits CHECK
// constraints entirely when it generates SQL, so a constraint declared in `schema.ts` and left to
// the generator is enforced by NOTHING while `schema.ts` reads as though it were. The application
// suites cannot see the difference — they never write a violating row — so the only evidence is a
// refusal measured here.
//
// ## What these columns are for
//
// max removed `JOIN <token>` (2026-08-07): the farm identity travelled in the message body, and a
// farmer hand-copying a 64-character token into a text message fails silently on any typo. The
// identity moves to a phone the farmer states on the form, and the message becomes the one word
// the carrier itself defines — `START`.
//
// The INVITATION is still the credential. The phone says which handset to expect, never who may be
// set up: a mistyped number matches nothing, grants nothing, and leaves the invitation unredeemed
// and retryable.
//
// ## Golden Rule #5
//
// The same two-column shape as `contacts` and `seller_emails`: the raw E.164 in exactly one column
// read only by the send path, and the hash as the only lookup key. That the match query reads the
// hash and never the raw column is a query property proven in the application suites, not here.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("migration 0028 invitation pending phone (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let administratorId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  /**
   * A 64-character lowercase hex digest, the shape every hash column in this schema uses.
   *
   * Built from a real hash rather than a repeated letter: the constraint requires `[0-9a-f]`, so
   * `"h".repeat(64)` is not a digest at all — using one would make inserts fail for a reason
   * unrelated to what is being tested.
   */
  const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
  const now = new Date();
  const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_pendingphone_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 1 });

    // The fixed launch identity — a CHECK constraint refuses every other address.
    const admins = await client()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${now})
      returning id
    `;
    administratorId = admins[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  /** Mint one invitation, returning the row so a test reads back what was actually stored. */
  async function invite(input: {
    phone?: string | null;
    hash?: string | null;
    token?: string;
    redeemed?: boolean;
  }): Promise<Record<string, unknown>> {
    const rows = await client()`
      insert into farmer_invitations (
        seller_id, token_hash, channel, created_by_administrator_id, created_at, expires_at,
        redeemed_at, pending_phone_e164, pending_phone_hash
      )
      values (
        null, ${input.token ?? digest(randomUUID())}, 'sms', ${administratorId}, ${now},
        ${later}, ${input.redeemed === true ? now : null},
        ${input.phone ?? null}, ${input.hash ?? null}
      )
      returning *
    `;
    return rows[0] as Record<string, unknown>;
  }

  it("stores a stated phone and its hash, and reads both back", async () => {
    // BY EFFECT. A migration that added no columns would fail here, not at exit status.
    const hash = digest("+12065550143");
    const row = await invite({ phone: "+12065550143", hash });

    expect(row.pending_phone_e164).toBe("+12065550143");
    expect(row.pending_phone_hash).toBe(hash);
  });

  it("ALLOWS an invitation with no phone at all — the normal starting state", async () => {
    // An administrator mints the invitation before the farmer has seen any form, so both
    // columns must be legal as NULL. A NOT NULL here would make minting impossible.
    const row = await invite({});

    expect(row.pending_phone_e164).toBeNull();
    expect(row.pending_phone_hash).toBeNull();
  });

  it("REFUSES a phone that is not E.164 as normalizePhone produces it", async () => {
    // This column feeds the outbound send path. A malformed number there is a message that
    // cannot be delivered, with nothing reporting why — so the shape is enforced rather than
    // trusted from the caller.
    const hash = digest("bad");

    // Local form, no country code.
    await expect(invite({ phone: "2065550143", hash })).rejects.toThrow();
    // Punctuation as a farmer would type it. Normalization is the boundary's job, not the
    // column's — but the column must refuse what reaches it unnormalized.
    await expect(invite({ phone: "(206) 555-0143", hash })).rejects.toThrow();
    // Too many digits.
    await expect(invite({ phone: "+120655501430", hash })).rejects.toThrow();
    // Not +1.
    await expect(invite({ phone: "+442065550143", hash })).rejects.toThrow();
  });

  it("REFUSES a hash that is not a 64-character lowercase hex digest", async () => {
    // A malformed hash is a row that can never be matched, so the farmer's START would miss and
    // nothing would report an error. Lowercase is enforced rather than folded so one digest has
    // exactly one spelling.
    const phone = "+12065550144";

    await expect(invite({ phone, hash: "abc" })).rejects.toThrow();
    await expect(invite({ phone, hash: digest("x").toUpperCase() })).rejects.toThrow();
    // 64 characters, but not hex — the case a `length = 64` check would wave through.
    await expect(invite({ phone, hash: "z".repeat(64) })).rejects.toThrow();
  });

  it("REFUSES a raw number without its hash, and a hash without its number", async () => {
    // The COHERENCE PAIR, asserted in BOTH directions — which is the whole point of writing it
    // as `(a is null) = (b is null)`. The one-directional form passes whenever the left side is
    // NULL and would enforce nothing in that case (0023's lesson, and 0025's).
    //
    // A raw number with no hash can never be matched; a hash with no raw number matches an
    // invitation we then cannot text.
    await expect(invite({ phone: "+12065550145", hash: null })).rejects.toThrow();
    await expect(invite({ phone: null, hash: digest("orphan") })).rejects.toThrow();
  });

  it("ALLOWS two unredeemed invitations stating the SAME phone", async () => {
    // Deliberately not unique. Two farmers sharing a household phone may each hold an
    // invitation, and a unique index would refuse the second — a real household turned into a
    // failed insert. Which invitation a START completes is decided by the match query's
    // ordering, not by refusing to store the row.
    const shared = digest("+12065550146");
    await invite({ phone: "+12065550146", hash: shared });

    const second = await invite({ phone: "+12065550146", hash: shared });
    expect(second.pending_phone_hash).toBe(shared);
  });

  it("indexes the match path over UNREDEEMED invitations only", async () => {
    // The index is partial on `redeemed_at is null`, because a redeemed invitation is history
    // and must never be matched again. Asserted against the catalog rather than by timing: a
    // full index would satisfy any query-speed check while still making spent invitations
    // reachable by the matcher.
    const rows = await client()`
      select indexdef from pg_indexes
      where tablename = 'farmer_invitations'
        and indexname = 'farmer_invitations_pending_phone_hash_idx'
    `;

    expect(rows).toHaveLength(1);
    const definition = String(rows[0]?.indexdef ?? "");
    expect(definition).toMatch(/pending_phone_hash/);
    // The WHERE clause is the property. Without it the matcher could reach spent invitations.
    expect(definition).toMatch(/where \(redeemed_at is null\)/i);
  });
});
