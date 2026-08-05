import type { Sql } from "./sql";

// F-064 — the guard between an operator and the wrong database.
//
// THE FAILURE THIS EXISTS FOR. A bulk write aimed at one database that lands in another, because
// `DATABASE_URL` was one shell away from what the operator believed. A database "assumed empty"
// has held real user data more than once, and the launch ingest is insert-only with no clean
// rollback short of restoring a snapshot.
//
// Naming the target is not enough. `describeTarget` prints `host/neondb` and an operator reads
// exactly what they expected to read — it confirms the string they typed, not the database it
// reaches. So this reports what is ACTUALLY in there, and the caller states in advance what it
// expects to find. Anything unexpected aborts before a single row is written.

/** What is actually in the database on the other end of this connection. */
export interface DatabaseFingerprint {
  databaseName: string;
  /** Applied migrations. Zero means the schema was never migrated — never "it's fine, it's new". */
  migrationsApplied: number;
  farms: number;
  salesLocations: number;
  inventoryRevisions: number;
}

export interface ExpectedDatabase {
  /** The database the operator believes they are writing to. Compared exactly. */
  databaseName: string;
  /**
   * Assert the corpus tables hold no rows.
   *
   * Stated by the caller rather than inferred, because "I thought it was empty" is precisely the
   * belief that goes wrong. A caller that does not care omits it.
   */
  expectEmpty?: boolean;
}

/** Read what is really in this database. Counts, not assumptions. */
export async function fingerprintDatabase(sql: Sql): Promise<DatabaseFingerprint> {
  const rows = await sql<
    {
      database_name: string;
      migrations_applied: number;
      farms: number;
      sales_locations: number;
      inventory_revisions: number;
    }[]
  >`
    select
      current_database() as database_name,
      (select count(*)::int from drizzle.__drizzle_migrations) as migrations_applied,
      (select count(*)::int from farms) as farms,
      (select count(*)::int from sales_locations) as sales_locations,
      (select count(*)::int from inventory_revisions) as inventory_revisions
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("could not fingerprint the database");

  return {
    databaseName: row.database_name,
    migrationsApplied: row.migrations_applied,
    farms: row.farms,
    salesLocations: row.sales_locations,
    inventoryRevisions: row.inventory_revisions,
  };
}

/** One line describing what is really there, for an operator's eyes and for an error message. */
export function describeFingerprint(fingerprint: DatabaseFingerprint): string {
  return (
    `database "${fingerprint.databaseName}" ` +
    `(${fingerprint.migrationsApplied} migrations, ${fingerprint.farms} farms, ` +
    `${fingerprint.salesLocations} sales locations, ` +
    `${fingerprint.inventoryRevisions} inventory revisions)`
  );
}

/**
 * Refuse to proceed unless the database is the one the caller expects.
 *
 * Fails CLOSED and throws rather than returning a flag: a caller that forgets to check a boolean
 * writes to production, and this is the one guard whose failure mode is unrecoverable. The error
 * names what was actually found, so an operator can tell at a glance which database they hit
 * instead of hunting for it.
 */
export async function requireExpectedDatabase(
  sql: Sql,
  expected: ExpectedDatabase,
): Promise<DatabaseFingerprint> {
  const fingerprint = await fingerprintDatabase(sql);

  if (fingerprint.databaseName !== expected.databaseName) {
    throw new Error(
      `refusing to write: expected database "${expected.databaseName}" but connected to ` +
        `${describeFingerprint(fingerprint)}`,
    );
  }

  if (fingerprint.migrationsApplied === 0) {
    throw new Error(
      `refusing to write: ${describeFingerprint(fingerprint)} has no migrations applied`,
    );
  }

  if (
    expected.expectEmpty === true &&
    (fingerprint.farms > 0 ||
      fingerprint.salesLocations > 0 ||
      fingerprint.inventoryRevisions > 0)
  ) {
    throw new Error(
      `refusing to write: expected an empty corpus but ${describeFingerprint(fingerprint)} ` +
        `is not empty`,
    );
  }

  return fingerprint;
}
