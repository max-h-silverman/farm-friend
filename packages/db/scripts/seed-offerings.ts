// F-024/F-036 — commit HUMAN-APPROVED offering tags.
//
//   npm run db:seed-offerings -- <approved-json> [--dry-run]
//
// The input is the reviewed proposals file from `npm run offerings:propose` (edited or
// approved as-is): an array of { standName, items } entries. Entries without an `items`
// array (extraction errors awaiting a human) are reported and skipped, never guessed.
// `seedOfferings` is idempotent and never rewrites an existing tag; unknown stand names —
// including the address-refused stands that exist in the CSV but not the database — are
// reported, never invented.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { parseApprovedOfferings } from "../src/approved-offerings";
import { planOfferings, seedOfferings } from "../src/seed";

async function main(): Promise<void> {
  const [jsonPath, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");

  if (!jsonPath) {
    console.error("usage: npm run db:seed-offerings -- <approved-json> [--dry-run]");
    process.exit(1);
  }

  // A dry run needs the DATABASE_URL too, and that is the point (F-041). The facts a reviewer
  // has to see before committing are the ones only the database knows: which approved name
  // resolves to which STORED name, which stands are unknown, and which tags are already there.
  // A dry run that merely echoed the file back is what hid five silently-unmatched stands —
  // it reported 31 approved entries while only 26 could ever land.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (a dry run resolves names against the database)");
    process.exit(1);
  }

  const { approved, skippedNoItems } = parseApprovedOfferings(
    JSON.parse(readFileSync(jsonPath, "utf8")) as unknown,
  );
  for (const name of skippedNoItems) {
    console.log(`  SKIPPED  ${name}: no items array (unresolved extraction error)`);
  }
  const totalTags = approved.reduce((sum, entry) => sum + entry.items.length, 0);
  console.log(`approved file: ${approved.length} stands, ${totalTags} tags`);

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    if (dryRun) {
      const plan = await planOfferings(sql, approved);
      for (const entry of plan.matched) {
        // Print the stored name whenever it differs from the approved file's — that difference
        // is exactly what an exact-string lookup used to swallow.
        const via =
          entry.locationName === entry.standName ? "" : ` -> "${entry.locationName}"`;
        const already =
          entry.existingItems.length > 0 ? ` (already: ${entry.existingItems.join(", ")})` : "";
        console.log(
          `  ${entry.standName}${via}: ${entry.newItems.join(", ") || "(nothing new)"}${already}`,
        );
      }
      for (const name of plan.unknownStands) {
        console.log(`  UNKNOWN STAND  ${name}: no sales location matches this name`);
      }
      for (const name of plan.refusedStands) {
        console.log(`  REFUSED  ${name}: farmer owns the listing`);
      }
      const wouldInsert = plan.matched.reduce((sum, e) => sum + e.newItems.length, 0);
      console.log(
        `\n--dry-run: nothing written. ${plan.matched.length} stands matched, ` +
          `${plan.unknownStands.length} unknown, ${plan.refusedStands.length} refused, ` +
          `${wouldInsert} tags would be inserted`,
      );
      return;
    }

    const result = await seedOfferings(sql, approved);
    console.log(
      `\ninserted ${result.inserted}, skipped ${result.skipped} (already present)`,
    );
    for (const name of result.unknownStands) {
      console.log(`  UNKNOWN STAND  ${name}: no sales location with this name`);
    }
    for (const name of result.refusedStands) {
      console.log(`  REFUSED  ${name}: farmer owns the listing`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
