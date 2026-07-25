import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export type Db = ReturnType<typeof createDb>;

/** Create the raw Drizzle client used by repository adapters. */
export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 5 });
  return drizzle(client, { schema });
}
