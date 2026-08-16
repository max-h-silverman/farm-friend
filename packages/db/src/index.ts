import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import type { Sql } from "./sql";

export * from "./schema";
export { schema };

export * from "./current-inventory";
export * from "./provider-invalidation";
export * from "./provider-write-authority";
export * from "./transactions";
export * from "./admin";
export * from "./farmer";
export * from "./hosting";
export * from "./farm-emails";
export * from "./farm-verification";
export * from "./onboarding-listing";
export * from "./listing-availability";
export * from "./payment-methods";
export * from "./farmer-targeting";
export * from "./pending-result-list";
export * from "./pending-stock-out-report";
export * from "./participants";
export * from "./review";
export * from "./scheduled-prompts";
export * from "./test-farms";
export type { Sql } from "./sql";

export interface Db {
  /** Drizzle query builder over the launch schema. */
  readonly orm: ReturnType<typeof drizzle<typeof schema>>;
  /** The underlying driver, used for row locks and transactional workflow SQL. */
  readonly sql: Sql;
  close(): Promise<void>;
}

/**
 * Total connections per process, unchanged from the single-pool original. The split
 * below divides this budget rather than adding to it.
 */
const TOTAL_POOL_SIZE = 5;
/** The authoritative transactions are raw SQL and hold row locks, so they get more. */
const SQL_POOL_SIZE = 3;
const ORM_POOL_SIZE = TOTAL_POOL_SIZE - SQL_POOL_SIZE;

/**
 * Create the database handle used by repository adapters and authoritative workflows.
 *
 * The Drizzle query builder and the raw transactional client are deliberately backed by
 * SEPARATE clients. `drizzle()` overwrites the date/time serializers on whatever
 * postgres.js client it is constructed over (drizzle-orm/postgres-js/driver.js), after
 * which raw SQL on that same client can no longer bind a `Date` — and the resulting
 * error names the calling query rather than the cause. The authoritative workflows are
 * raw transactional SQL, so they get a client Drizzle has never touched.
 *
 * The split is structural rather than conventional: nothing downstream has to remember
 * to convert timestamps by hand.
 */
export function createDb(databaseUrl: string): Db {
  const ormClient = postgres(databaseUrl, { max: ORM_POOL_SIZE });
  const sqlClient = postgres(databaseUrl, { max: SQL_POOL_SIZE });
  return {
    orm: drizzle(ormClient, { schema }),
    sql: sqlClient,
    close: async () => {
      await Promise.all([
        ormClient.end({ timeout: 5 }),
        sqlClient.end({ timeout: 5 }),
      ]);
    },
  };
}
