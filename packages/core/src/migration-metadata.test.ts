import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GL-006 — the migration GENERATOR's metadata must describe the current schema.
//
// Every migration has two artifacts: the `.sql` file, which is what actually runs against a
// database, and a snapshot, which is a JSON picture of the whole schema at that point and is
// never executed. Only the second one is checked here.
//
// The defect this exists to prevent is silent and one-directional. **Applying** migrations
// stays correct no matter how stale the snapshots are — the integration suite builds a
// database from empty on every run and proves it. **Generating** the next migration is what
// breaks: drizzle-kit diffs the schema against the LAST snapshot on disk, so when that
// snapshot predates five migrations it sees tables and columns it has no record of and cannot
// tell whether they were created or renamed. It then asks interactively:
//
//     Is message_category column in outbox_work table created or renamed from another column?
//
// A wrong answer there — or an impatient one — writes a migration that re-creates existing
// tables or renames a column out from under production data. The danger is not that the tool
// errors out; it is that it produces a plausible-looking file that does damage.
//
// So the property asserted is: **the newest snapshot corresponds to the newest migration.**
// That is what makes a no-op generation trial come back "No schema changes, nothing to
// migrate" instead of a rename interrogation.
//
// Deliberately NOT asserted: that every journaled migration has its own snapshot. drizzle-kit
// reads `snapshots[snapshots.length - 1]` and diffs against that one alone
// (`preparePrevSnapshot` in drizzle-kit 0.22.8), so intermediate snapshots are historical
// convenience, not correctness. Demanding all seven would be asserting a stricter rule than
// the tool has, and inventing five point-in-time pictures nobody can verify against a database
// would be fabricating evidence rather than repairing it.
//
// This is the same family as `cron-schedule.test.ts` and `workspace-manifests.test.ts`: a
// property that belongs to a TOOL or a PLATFORM rather than to the code, asserted against the
// real artifact, because no amount of green application tests can see it.

const repoRoot = resolve(__dirname, "../../..");
const migrationsDir = resolve(repoRoot, "packages/db/drizzle");
const metaDir = resolve(migrationsDir, "meta");

interface Journal {
  entries: { idx: number; tag: string }[];
}

function journal(): Journal {
  return JSON.parse(
    readFileSync(resolve(metaDir, "_journal.json"), "utf8"),
  ) as Journal;
}

/** Snapshot files as drizzle-kit itself enumerates them: the meta dir, sorted, minus `_journal`. */
function snapshotFiles(): string[] {
  return readdirSync(metaDir)
    .filter((name) => !name.startsWith("_"))
    .sort();
}

function snapshotIndex(fileName: string): number {
  return Number.parseInt(fileName.slice(0, 4), 10);
}

describe("migration generator metadata (GL-006)", () => {
  it("journals at least one migration and keeps its .sql file", () => {
    const entries = journal().entries;
    expect(entries.length).toBeGreaterThan(0);

    // A journal entry naming a file that does not exist would break application, not just
    // generation — worth catching here rather than at deploy time.
    for (const entry of entries) {
      expect(
        existsSync(resolve(migrationsDir, `${entry.tag}.sql`)),
        `journaled migration ${entry.tag} has no .sql file`,
      ).toBe(true);
    }
  });

  it("has a snapshot for the NEWEST migration, which is the one generation diffs against", () => {
    const entries = journal().entries;
    const newest = entries[entries.length - 1];
    expect(newest).toBeDefined();

    const files = snapshotFiles();
    expect(files.length, "no snapshots at all").toBeGreaterThan(0);

    const newestSnapshot = files[files.length - 1] as string;

    // The index must match the newest journal entry. If a migration lands without one, the
    // generator's picture of the world is out of date by exactly the thing just added, and
    // the next `drizzle-kit generate` starts asking rename questions.
    expect(
      snapshotIndex(newestSnapshot),
      `newest migration is ${newest?.tag} (idx ${newest?.idx}) but the newest snapshot is ` +
        `${newestSnapshot} — generation would diff against a stale schema and prompt for ` +
        `create-or-rename decisions. See GL-006.`,
    ).toBe(newest?.idx);
  });

  it("chains snapshots by prevId without a collision", () => {
    const files = snapshotFiles();
    const seenPrevIds = new Map<string, string>();

    for (const file of files) {
      const snapshot = JSON.parse(
        readFileSync(resolve(metaDir, file), "utf8"),
      ) as { id?: string; prevId?: string };

      expect(snapshot.id, `${file} has no id`).toBeTruthy();
      expect(snapshot.prevId, `${file} has no prevId`).toBeTruthy();

      // drizzle-kit aborts on two snapshots claiming the same parent, so a duplicate here
      // breaks generation outright rather than merely making it inaccurate.
      const prevId = snapshot.prevId as string;
      const collidesWith = seenPrevIds.get(prevId);
      expect(
        collidesWith,
        `${file} and ${collidesWith} both point at parent ${prevId}`,
      ).toBeUndefined();
      seenPrevIds.set(prevId, file);
    }
  });

  it("describes the current schema: every table in schema.ts appears in the newest snapshot", () => {
    const files = snapshotFiles();
    const newestSnapshot = JSON.parse(
      readFileSync(resolve(metaDir, files[files.length - 1] as string), "utf8"),
    ) as { tables?: Record<string, unknown> };

    const snapshotTables = new Set(
      Object.keys(newestSnapshot.tables ?? {}).map(
        (key) => key.split(".").pop() as string,
      ),
    );

    // Read the table names out of the schema module rather than hardcoding a list, so this
    // keeps working as the schema grows. `pgTable("name"` is the one declaration form used.
    const schemaSource = readFileSync(
      resolve(repoRoot, "packages/db/src/schema.ts"),
      "utf8",
    );
    const declared = [...schemaSource.matchAll(/pgTable\(\s*"([a-z_]+)"/g)].map(
      (match) => match[1] as string,
    );

    expect(declared.length, "found no pgTable declarations to check").toBeGreaterThan(0);

    const missing = declared.filter((table) => !snapshotTables.has(table));
    expect(
      missing,
      `tables in schema.ts with no entry in ${files[files.length - 1]}: ${missing.join(", ")}. ` +
        `The generator would treat each as brand new. See GL-006.`,
    ).toEqual([]);
  });

  it("creates every CHECK constraint schema.ts declares in some migration (F-046)", () => {
    // THE FAILURE THIS CATCHES: a constraint that exists in `schema.ts` and in nobody's
    // database. Every suite stays green — fixtures satisfy the rule anyway — while production
    // enforces nothing, and the code believes it is guarded.
    //
    // Observed 2026-07-31, which is why this exists. Asked to generate a snapshot for
    // migration 0009, drizzle-kit also wrote its own migration for the same table whose SQL
    // silently OMITTED all three CHECK constraints: the generator translates only the parts
    // of a table declaration it understands, and drops the rest without a warning. Had that
    // file been the one kept, `pending_result_lists` would have accepted an empty list and an
    // out-of-range offset in production, both of which render as "no results" to a customer.
    //
    // Deliberately checked against the MIGRATION SQL rather than the snapshot: SQL is what
    // actually runs against a database. A snapshot agreeing with the schema proves the
    // generator's bookkeeping, not that any constraint was ever created.
    const schemaSource = readFileSync(
      resolve(repoRoot, "packages/db/src/schema.ts"),
      "utf8",
    );
    // `check("name", sql`…`)` is the one declaration form used. The name is what a migration
    // must also create.
    const declared = [
      ...schemaSource.matchAll(/\bcheck\(\s*"([a-z0-9_]+)"/g),
    ].map((match) => match[1] as string);

    expect(
      declared.length,
      "found no check() declarations to verify — the pattern above has drifted",
    ).toBeGreaterThan(0);

    // Read the migrations the JOURNAL lists, not the directory: an orphaned .sql file nobody
    // applies must not satisfy this, or a constraint could look created while the migration
    // carrying it never runs.
    const migrationSql = journal().entries
      .map((entry) => readFileSync(resolve(migrationsDir, `${entry.tag}.sql`), "utf8"))
      .join("\n");

    const missing = declared.filter(
      (name) => !new RegExp(`CONSTRAINT\\s+"${name}"`, "i").test(migrationSql),
    );

    expect(
      missing,
      `CHECK constraints declared in schema.ts that NO migration creates: ${missing.join(", ")}. ` +
        "The database does not enforce them, whatever the schema says. Add them to a " +
        "migration by hand — drizzle-kit omits CHECK constraints when it generates SQL.",
    ).toEqual([]);
  });
});
