import { SystemClock, type Clock } from "@farm-friend/core";
import { createDb, type Db } from "@farm-friend/db";

// The PUBLIC READ dependency set — database and clock, and deliberately nothing else.
//
// WHY THIS IS A SEPARATE MODULE. The public map and `GET /api/public/stands` are model-free
// (F-019). That was true behaviourally — `handleStandsRequest` takes `db` and `clock` and
// there is no seam to hand it a model — but those surfaces imported `lib/composition.ts` to
// get the shared database, and that module CONSTRUCTS `inquiry`, `stockOut`, and
// `interpreter`. So the public read path's module graph reached the model package, and a
// later edit could have written `context.inquiry` into the public map to make it "smarter"
// in a one-word diff with nothing structural in the way.
//
// Splitting the shared infrastructure out means the public read path imports what it needs
// and cannot NAME a seam it was never handed. `lib/composition.ts` builds the full context
// on top of this same singleton, so there is still exactly one database pool per process and
// one clock — one mechanism, two consumers, no duplicated connection state.
//
// `apps/web/lib/public-surface-model-free.test.ts` walks the transitive import graph of the
// public entry points and fails if a model package or seam name appears anywhere in it.

let cachedDb: Db | undefined;
let cachedClock: Clock | undefined;

/** The process-wide database pool. Shared with the full composition root. */
export function sharedDb(databaseUrl: string): Db {
  cachedDb ??= createDb(databaseUrl);
  return cachedDb;
}

/** The process-wide clock. Shared with the full composition root. */
export function sharedClock(): Clock {
  cachedClock ??= new SystemClock();
  return cachedClock;
}

export interface PublicReadContext {
  db: Db;
  clock: Clock;
}

/**
 * The public read surface's entire dependency set.
 *
 * Reads `DATABASE_URL` directly rather than going through `resolveConfig`, which also
 * validates SMS and model configuration — the public map should serve a listing even when
 * an unrelated provider credential is missing, and pulling that validation in would drag the
 * model package back into this graph.
 */
export function publicReadContext(
  env: Record<string, string | undefined> = process.env,
): PublicReadContext {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required");
  }
  return { db: sharedDb(databaseUrl), clock: sharedClock() };
}
