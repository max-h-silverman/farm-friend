/**
 * Split a `stand_items.display_name` that holds a comma-joined LIST into one row per item.
 *
 * ## Why this script exists
 *
 * Found on a handset 2026-08-13: asking for "eggs" returned Morgan Hill Community Farm Stand with
 * `May have: salad mix, pickling cucumbers, squash, variety of herbs, green beans, duck eggs,
 * chicken eggs, flowers, swiss chard` — the stand's ENTIRE offerings list rendered as one item.
 * The renderer was faithful; the row was wrong. One `stand_items` row held all nine names as a
 * single string, so retrieval matched "eggs" inside it and the answer printed the whole thing.
 *
 * **Measured before writing anything** (production, 2026-08-13): exactly **one** row in the whole
 * corpus has this shape. No other `stand_items` row contains a comma, and no row over 40
 * characters lacks one. So this is a data repair with a guard, not a parser — the same call the
 * four hand-edited farm descriptions got on 2026-08-12. If a future ingest reintroduces the shape,
 * this script finds it; it is deliberately general in DETECTION and narrow in effect.
 *
 * ## What it does NOT do
 *
 * It does not reconcile a stand's two offering lists. Morgan Hill also holds ten *uncarried* rows
 * naming a partly different set (snap peas, zucchini, basil, salad greens, rainbow chard). Max's
 * call, 2026-08-13: **the list being split is what customers see**, and rows outside it stay as
 * they are.
 *
 * The one exception follows from that same call: where a split part ALREADY exists on the stand
 * but is not carried, it is **promoted** rather than duplicated. Morgan Hill's "duck eggs" and
 * "flowers" are in the split list and were sitting uncarried, so leaving them would show the stand
 * 7 of the 9 items its own form states. No row outside the split list is touched.
 *
 * ## What makes it safe to run
 *
 * - **Dry run is the default.** Writing requires `--apply`, which additionally requires the
 *   operator to type an exact confirmation phrase. No single flag writes.
 * - **The target is fingerprinted first**, so a mistyped connection string fails rather than
 *   quietly rewriting the wrong database.
 * - **Every change is printed before anything is written**, and that output is what is approved.
 * - **The original is preserved.** `--apply` writes a JSON backup of every prior row first and
 *   refuses to proceed if it cannot. That file IS the rollback.
 * - **Idempotent.** Split rows contain no comma, so a second run finds nothing.
 * - **A name already present on the stand is never duplicated** — it is promoted in place if it
 *   was not carried, left alone if it was, and the merged row is removed either way.
 *
 * ## Usage
 *
 *   npx tsx scripts/split-merged-stand-items.ts            # dry run, prints every change
 *   npx tsx scripts/split-merged-stand-items.ts --apply    # prompts for confirmation
 */

import { createInterface } from "node:readline/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { splitMergedItemName } from "../packages/core/src/seed/merged-item-name";

/** The database this is allowed to touch. A different name aborts. */
const EXPECTED_DATABASE = "neondb";
const CONFIRMATION = "split merged stand items";

interface Split {
  id: string;
  stand: string;
  salesLocationId: string;
  before: string;
  usuallyCarried: boolean;
  sortOrder: number;
  /** Names to insert — the split parts this stand does not already have. */
  insert: string[];
  /**
   * Split parts already present on the stand under some other row, so not inserted again.
   *
   * Where such a row is NOT carried, it is promoted rather than duplicated (max, 2026-08-13):
   * the list being split is what customers should see, and leaving these behind would show a
   * stand 7 of the 9 items its own form states.
   */
  promote: { id: string; name: string }[];
  /** Split parts already present AND already carried — nothing to do for these. */
  alreadyCarried: string[];
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(url, { max: 1 });
  try {
    // FINGERPRINT FIRST — verify by effect what this is connected to, before reading a row and
    // long before writing one. The consequence here is rewriting what customers are told a real
    // farm stand carries.
    const [{ current_database: database }] = await sql<{ current_database: string }[]>`
      select current_database()
    `;
    const [{ count: migrations }] = await sql<{ count: number }[]>`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `;
    const [{ count: items }] = await sql<{ count: number }[]>`
      select count(*)::int as count from stand_items
    `;
    console.log(`target: database=${database} migrations=${migrations} stand_items=${items}`);
    if (database !== EXPECTED_DATABASE) {
      throw new Error(
        `refusing to run against "${database}" — expected "${EXPECTED_DATABASE}". ` +
          "Check DATABASE_URL.",
      );
    }

    const rows = await sql<{
      id: string;
      stand: string;
      salesLocationId: string;
      displayName: string;
      usuallyCarried: boolean;
      sortOrder: number;
    }[]>`
      select item.id,
             location.name as stand,
             item.sales_location_id as "salesLocationId",
             item.display_name as "displayName",
             item.usually_carried as "usuallyCarried",
             item.sort_order as "sortOrder"
      from stand_items as item
      join sales_locations as location on location.id = item.sales_location_id
      order by location.name, item.sort_order
    `;

    /** Every name a stand already holds, so a split part is never duplicated. */
    const rowsByLocation = new Map<string, Map<string, { id: string; carried: boolean }>>();
    for (const row of rows) {
      const map = rowsByLocation.get(row.salesLocationId) ?? new Map();
      map.set(row.displayName.trim().toLowerCase(), {
        id: row.id,
        carried: row.usuallyCarried,
      });
      rowsByLocation.set(row.salesLocationId, map);
    }

    const splits: Split[] = [];
    for (const row of rows) {
      const parts = splitMergedItemName(row.displayName);
      if (parts === null) continue;

      // Rows held by OTHERS on this stand — the merged row itself is excluded, since it is the
      // row being replaced.
      const others = new Map(rowsByLocation.get(row.salesLocationId));
      others.delete(row.displayName.trim().toLowerCase());

      const insert: string[] = [];
      const promote: { id: string; name: string }[] = [];
      const alreadyCarried: string[] = [];
      for (const part of parts) {
        const existing = others.get(part.toLowerCase());
        if (existing === undefined) {
          insert.push(part);
          // Guard against a list repeating a name within itself.
          others.set(part.toLowerCase(), { id: "", carried: row.usuallyCarried });
        } else if (existing.carried === row.usuallyCarried) {
          alreadyCarried.push(part);
        } else {
          promote.push({ id: existing.id, name: part });
        }
      }
      splits.push({
        id: row.id,
        stand: row.stand,
        salesLocationId: row.salesLocationId,
        before: row.displayName,
        usuallyCarried: row.usuallyCarried,
        sortOrder: row.sortOrder,
        insert,
        promote,
        alreadyCarried,
      });
    }

    for (const split of splits) {
      console.log(`\n${"=".repeat(72)}\n${split.stand}\n${"=".repeat(72)}`);
      console.log(`--- ONE ROW HOLDING A LIST (usually_carried=${split.usuallyCarried}) ---`);
      console.log(`  ${split.before}`);
      console.log(`--- BECOMES ${split.insert.length} ROWS ---`);
      for (const name of split.insert) console.log(`  ${name}`);
      if (split.promote.length > 0) {
        console.log(`--- already on this stand, PROMOTED to usually_carried=${split.usuallyCarried} ---`);
        for (const row of split.promote) console.log(`  ${row.name}`);
      }
      if (split.alreadyCarried.length > 0) {
        console.log("--- already on this stand and already carried, untouched ---");
        for (const name of split.alreadyCarried) console.log(`  ${name}`);
      }
    }

    console.log(`\n${"-".repeat(72)}`);
    console.log(
      `${rows.length} stand_items scanned: ${splits.length} hold a list, becoming ` +
        `${splits.reduce((total, split) => total + split.insert.length, 0)} new row(s) plus ` +
        `${splits.reduce((total, split) => total + split.promote.length, 0)} promoted.`,
    );

    if (!apply) {
      console.log("\nDRY RUN — nothing was written. Re-run with --apply to write.");
      return;
    }
    if (splits.length === 0) {
      console.log("\nNothing to write.");
      return;
    }

    // The backup IS the rollback: a deleted `stand_items` row has no history table.
    const backupPath = resolve(
      process.cwd(),
      `stand-items-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(backupPath, JSON.stringify(splits, null, 2));
    console.log(`\nPrior rows backed up to ${backupPath}`);

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await readline.question(
      `\nType "${CONFIRMATION}" to rewrite ${splits.length} row(s) in ${database}: `,
    );
    readline.close();
    if (answer.trim() !== CONFIRMATION) {
      console.log("Not confirmed — nothing was written.");
      return;
    }

    // One transaction per stand: a partial split would leave the stand advertising some items
    // twice and others not at all, with no marker saying which had been done.
    await sql.begin(async (tx) => {
      for (const split of splits) {
        // Insert AFTER every existing row so the split parts keep a stable relative order and
        // cannot collide with a sort_order already in use.
        const [{ max: highest }] = await tx<{ max: number | null }[]>`
          select max(sort_order) as max from stand_items
          where sales_location_id = ${split.salesLocationId}
        `;
        let next = (highest ?? -1) + 1;
        for (const name of split.insert) {
          await tx`
            insert into stand_items (sales_location_id, display_name, usually_carried, sort_order)
            values (${split.salesLocationId}, ${name}, ${split.usuallyCarried}, ${next})
          `;
          next += 1;
        }
        // An overlapping row is promoted rather than duplicated — the list being split is what
        // customers should see, so a part of it must not stay hidden.
        for (const row of split.promote) {
          await tx`
            update stand_items set usually_carried = ${split.usuallyCarried}
            where id = ${row.id}
          `;
        }
        await tx`delete from stand_items where id = ${split.id}`;
      }
    });

    // VERIFY BY EFFECT, never from the absence of an error. Two claims are checked: the merged
    // row is gone, and every intended name is present and carried as intended.
    for (const split of splits) {
      const survivors = await sql`select id from stand_items where id = ${split.id}`;
      if (survivors.length > 0) {
        throw new Error(`VERIFICATION FAILED: the merged row still exists for ${split.stand}`);
      }
      const present = await sql<{ display_name: string; usually_carried: boolean }[]>`
        select display_name, usually_carried from stand_items
        where sales_location_id = ${split.salesLocationId}
      `;
      const carried = new Set(
        present
          .filter((row) => row.usually_carried === split.usuallyCarried)
          .map((row) => row.display_name.toLowerCase()),
      );
      const missing = [...split.insert, ...split.promote.map((row) => row.name)].filter(
        (name) => !carried.has(name.toLowerCase()),
      );
      if (missing.length > 0) {
        throw new Error(
          `VERIFICATION FAILED for ${split.stand}: missing ${missing.join(", ")}`,
        );
      }
    }
    console.log(`\nWrote and verified ${splits.length} split(s). Backup: ${backupPath}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
