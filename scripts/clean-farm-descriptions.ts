/**
 * Apply F-061's description cleanup to the descriptions already stored.
 *
 * ## Why this script exists
 *
 * `buildStandDescription` owns the rule that prose never repeats a structured fact. This script
 * applies that rule to stored descriptions after either the rule or the structured facts change;
 * the public card otherwise keeps rendering the old stored prose verbatim.
 *
 * This is the narrow fix: run the shared rule over stored text, with each stand's structured usual
 * items supplied for comparison. It does NOT re-ingest, touch another column, or need source CSVs.
 *
 * ## What makes it safe to run
 *
 * - **Dry run is the default.** Writing requires `--apply`, and `--apply` additionally requires
 *   the operator to type the exact confirmation phrase. There is no single flag that writes.
 * - **The target is fingerprinted first.** A mistyped connection string fails rather than
 *   quietly rewriting the wrong database, and the expected database name is asserted.
 * - **Every row is diffed before anything is written**, and the diff is what the operator
 *   approves. A row whose cleaned text is identical is skipped entirely.
 * - **The original is preserved.** `--apply` writes a JSON backup of every prior value first,
 *   and refuses to proceed if it cannot. With no `farms.description` history table, that file
 *   IS the rollback.
 * - **Idempotent.** Running it twice changes nothing the second time, because the cleanup is a
 *   pure function and its output is a fixed point.
 *
 * ## Usage
 *
 *   npx tsx scripts/clean-farm-descriptions.ts                  # dry run, prints every diff
 *   npx tsx scripts/clean-farm-descriptions.ts --apply          # prompts for confirmation
 */

import { createInterface } from "node:readline/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { buildStandDescription } from "../packages/core/src/seed/stand-description";

/** The database this is allowed to touch. A different name aborts. */
const EXPECTED_DATABASE = "neondb";
const CONFIRMATION = "rewrite farm descriptions";

interface Change {
  id: string;
  name: string;
  before: string;
  after: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(url, { max: 1 });
  try {
    // FINGERPRINT FIRST — verify by effect what this is connected to, before reading a single
    // row and long before writing one. A connection string is easy to get wrong and the
    // consequence here is rewriting live public text.
    const [{ current_database: database }] = await sql<{ current_database: string }[]>`
      select current_database()
    `;
    const [{ count: migrations }] = await sql<{ count: number }[]>`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `;
    const [{ count: farms }] = await sql<{ count: number }[]>`
      select count(*)::int as count from farms
    `;
    console.log(`target: database=${database} migrations=${migrations} farms=${farms}`);
    if (database !== EXPECTED_DATABASE) {
      throw new Error(
        `refusing to run against "${database}" — expected "${EXPECTED_DATABASE}". ` +
          "Check DATABASE_URL.",
      );
    }

    const rows = await sql<{
      id: string;
      name: string;
      description: string;
      usuallySells: string[];
    }[]>`
      select
        farm.id,
        farm.name,
        farm.description,
        coalesce(
          array_agg(item.display_name order by item.sort_order, item.id)
            filter (where item.id is not null),
          array[]::text[]
        ) as "usuallySells"
      from farms as farm
      left join sales_locations as location
        on location.owner_farm_id = farm.id and location.retired_at is null
      left join stand_items as item
        on item.sales_location_id = location.id and item.usually_carried
      where farm.description is not null and btrim(farm.description) <> ''
      group by farm.id, farm.name, farm.description
      order by farm.name
    `;

    const changes: Change[] = [];
    let unchanged = 0;
    for (const row of rows) {
      // Supply the structured usual list that renders beside this prose. The cleanup remains a
      // pure shared rule; this script only gives it the facts needed to identify overlap.
      const after =
        buildStandDescription({
          mapDescription: row.description,
          usuallySells: row.usuallySells,
        }) ?? "";
      if (after.trim() === row.description.trim()) {
        unchanged += 1;
        continue;
      }
      changes.push({ id: row.id, name: row.name, before: row.description, after });
    }

    for (const change of changes) {
      console.log(`\n${"=".repeat(72)}\n${change.name}\n${"=".repeat(72)}`);
      console.log("--- BEFORE ---");
      console.log(change.before);
      console.log("--- AFTER ---");
      console.log(change.after === "" ? "(no description — every line was a restated fact)" : change.after);
    }

    const emptied = changes.filter((change) => change.after === "").length;
    console.log(`\n${"-".repeat(72)}`);
    console.log(
      `${rows.length} farms with a description: ${changes.length} would change, ` +
        `${unchanged} already clean, ${emptied} would be left with none.`,
    );

    if (!apply) {
      console.log("\nDRY RUN — nothing was written. Re-run with --apply to write.");
      return;
    }
    if (changes.length === 0) {
      console.log("\nNothing to write.");
      return;
    }

    // The backup IS the rollback: `farms.description` has no history table, so a written row
    // cannot otherwise be recovered. Written BEFORE the transaction opens, and a failure to
    // write it aborts the run.
    const backupPath = resolve(
      process.cwd(),
      `farm-descriptions-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(
      backupPath,
      JSON.stringify(
        changes.map((change) => ({ id: change.id, name: change.name, description: change.before })),
        null,
        2,
      ),
    );
    console.log(`\nPrior values backed up to ${backupPath}`);

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await readline.question(
      `\nType "${CONFIRMATION}" to write ${changes.length} rows to ${database}: `,
    );
    readline.close();
    if (answer.trim() !== CONFIRMATION) {
      console.log("Not confirmed — nothing was written.");
      return;
    }

    // One transaction: a partial rewrite would leave the map in a state neither version
    // describes, and there is no marker to tell which rows had been done.
    await sql.begin(async (tx) => {
      for (const change of changes) {
        await tx`
          update farms
          set description = ${change.after === "" ? null : change.after}
          where id = ${change.id}
        `;
      }
    });

    // VERIFY BY EFFECT, never from the absence of an error: read the rows back and compare
    // them to what was intended.
    const written = await sql<{ id: string; description: string | null }[]>`
      select id, description from farms where id = any(${changes.map((c) => c.id)})
    `;
    const byId = new Map(written.map((row) => [row.id, row.description]));
    const wrong = changes.filter((change) => {
      const stored = byId.get(change.id) ?? null;
      return (stored ?? "") !== change.after;
    });
    if (wrong.length > 0) {
      throw new Error(
        `VERIFICATION FAILED for ${wrong.length} rows: ${wrong.map((w) => w.name).join(", ")}`,
      );
    }
    console.log(`\nWrote and verified ${changes.length} rows. Backup: ${backupPath}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
