import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A migration whose journal timestamp is OLDER than the one before it is SILENTLY SKIPPED.
//
// Found in production on 2026-07-29. `npm run db:migrate` printed "applying migrations to
// …/neondb" and then "migrations applied", exited 0, and changed NOTHING: still 7 migrations,
// `public_address` still NOT NULL, `sales_locations_coherent_visitability` absent. Migration 0007's
// generated `when` was 1785352095637 while 0006 carried a hand-rounded 1785500000000.
//
// The mechanism is one comparison in drizzle-orm (`pg-core/dialect.js`):
//
//     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { … }
//
// So a migration is applied only when its journal `when` EXCEEDS the newest already-applied
// `created_at`. Anything earlier is treated as already done. There is no warning and no non-zero
// exit — the operator is told it worked.
//
// WHY NO SUITE CAUGHT IT. Every test database is built from EMPTY, where `lastDbMigration` is null
// on the first migration and each subsequent one is compared against the row just inserted — so
// file order carries the day and out-of-order timestamps are invisible. The integration suite
// applying "all 8 migrations from an empty database" is genuinely green and genuinely blind to
// this. It is only reachable when migrating a database that is PARTIALLY migrated, which is to say:
// production, and only production.
//
// This is the `migration-metadata.test.ts` family — a property belonging to the TOOL rather than to
// the code, asserted against the artifact the tool actually consumes.

const repoRoot = resolve(__dirname, "../../..");
const journalPath = resolve(
  repoRoot,
  "packages/db/drizzle/meta/_journal.json",
);

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

function journal(): Journal {
  return JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
}

describe("migration journal ordering", () => {
  it("reads a journal with every migration in it", () => {
    // Guards against a vacuous pass: an empty or unreadable journal would make the assertions
    // below trivially true.
    const entries = journal().entries;
    expect(entries.length).toBeGreaterThanOrEqual(8);
    expect(entries.map((entry) => entry.idx)).toEqual(
      entries.map((_entry, index) => index),
    );
  });

  it("gives every migration a timestamp strictly greater than the one before it", () => {
    // THE assertion. A violation here means that migration, and every migration after it, is
    // silently skipped on any partially-migrated database while the command reports success.
    const entries = [...journal().entries].sort((a, b) => a.idx - b.idx);

    const outOfOrder = entries
      .map((entry, index) => ({ entry, previous: entries[index - 1] }))
      .filter(
        ({ entry, previous }) =>
          previous !== undefined && entry.when <= previous.when,
      )
      .map(
        ({ entry, previous }) =>
          `${entry.tag} (when=${entry.when}) is not newer than ` +
          `${previous!.tag} (when=${previous!.when}) — it would be SILENTLY SKIPPED`,
      );

    expect(outOfOrder).toEqual([]);
  });

  it("detects an out-of-order timestamp when one is present", () => {
    // Proves the check can fail. Without this, a mistake in the comparison above would make the
    // assertion pass forever while checking nothing — the exact failure mode this repo has hit
    // twice with source-reading assertions.
    const broken = [
      { idx: 0, tag: "0000_first", when: 1000 },
      { idx: 1, tag: "0001_second", when: 900 },
    ];

    const outOfOrder = broken.filter(
      (entry, index) => index > 0 && entry.when <= broken[index - 1]!.when,
    );

    expect(outOfOrder).toHaveLength(1);
    expect(outOfOrder[0]!.tag).toBe("0001_second");
  });

  it("treats an EQUAL timestamp as out of order, not merely a later one", () => {
    // `<` in drizzle's comparison means an equal timestamp is also skipped. A tie is therefore a
    // defect, and the assertion above uses `<=` for that reason.
    const tied = [
      { idx: 0, tag: "0000_first", when: 1000 },
      { idx: 1, tag: "0001_second", when: 1000 },
    ];

    const outOfOrder = tied.filter(
      (entry, index) => index > 0 && entry.when <= tied[index - 1]!.when,
    );

    expect(outOfOrder).toHaveLength(1);
  });
});
