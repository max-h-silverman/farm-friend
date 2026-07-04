import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export type Db = ReturnType<typeof createDb>;

/** Create a tenant-agnostic Drizzle client. Tenant scoping is applied per-query in
 *  packages/core, not here — this is the raw connection. */
export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 5 });
  return drizzle(client, { schema });
}
