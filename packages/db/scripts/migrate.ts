import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describeTarget } from "../src/connection-target";

// Apply every migration in `packages/db/drizzle/` to the database named by DATABASE_URL (B-006).
//
// This is an OPERATOR ACTION WITH A TARGET, deliberately not wired into the Vercel build. A build
// hook that migrated would run on every preview deploy and every rollback, pointing whatever
// `DATABASE_URL` that environment happens to carry at a schema change — including production, from
// a branch build. Migrations are not a build artifact.
//
// Idempotent: drizzle records applied migrations in its journal table, so re-running applies only
// what is new. Running it twice is safe and is the normal way to check state.
//
//   DATABASE_URL=… npx tsx packages/db/scripts/migrate.ts
//
// It prints the URL's HOST AND DATABASE NAME BUT NEVER ITS CREDENTIALS, because the operator's one
// real risk here is pointing it at the wrong database — and the connection string carries a
// password that must not reach a terminal log or a screen share.

const migrationsDir = resolve(
  fileURLToPath(new URL("../drizzle", import.meta.url)),
);

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    // Fails closed rather than defaulting to a local database: a migrate script with a fallback
    // target is one absent env var away from silently migrating the wrong thing.
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  let target: string;
  try {
    target = describeTarget(databaseUrl);
  } catch {
    console.error("DATABASE_URL is not a valid connection URL");
    process.exit(1);
  }

  console.log(`applying migrations to ${target}`);

  // `max: 1` — migrations are strictly sequential, and a pool would let drizzle interleave them.
  const client = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
    console.log("migrations applied");
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  // The message only; never the error object, which postgres-js populates with connection
  // parameters including the password.
  console.error(
    `migration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
