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
import { seedOfferings, type SeedOfferingInput } from "../src/seed";

function parseApprovedFile(path: string): {
  approved: SeedOfferingInput[];
  skippedNoItems: string[];
} {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("approved file must be a JSON array of { standName, items } entries");
  }

  const approved: SeedOfferingInput[] = [];
  const skippedNoItems: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("approved file entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.standName !== "string" || record.standName.trim() === "") {
      throw new Error("an approved entry is missing its standName");
    }
    if (record.items === undefined) {
      skippedNoItems.push(record.standName);
      continue;
    }
    if (
      !Array.isArray(record.items) ||
      !record.items.every((item) => typeof item === "string" && item.trim() !== "")
    ) {
      // A malformed hand-edit must fail loudly, not seed a blank tag.
      throw new Error(`"${record.standName}" has a malformed items array`);
    }
    approved.push({ standName: record.standName, items: record.items });
  }
  return { approved, skippedNoItems };
}

async function main(): Promise<void> {
  const [jsonPath, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");

  if (!jsonPath) {
    console.error("usage: npm run db:seed-offerings -- <approved-json> [--dry-run]");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !dryRun) {
    console.error("DATABASE_URL is required (or pass --dry-run)");
    process.exit(1);
  }

  const { approved, skippedNoItems } = parseApprovedFile(jsonPath);
  for (const name of skippedNoItems) {
    console.log(`  SKIPPED  ${name}: no items array (unresolved extraction error)`);
  }
  const totalTags = approved.reduce((sum, entry) => sum + entry.items.length, 0);
  console.log(`approved file: ${approved.length} stands, ${totalTags} tags`);

  if (dryRun) {
    for (const entry of approved) {
      console.log(`  ${entry.standName}: ${entry.items.join(", ") || "(none)"}`);
    }
    console.log("\n--dry-run: nothing written");
    return;
  }

  const sql = postgres(databaseUrl!, { max: 1 });
  try {
    const result = await seedOfferings(sql, approved);
    console.log(
      `\ninserted ${result.inserted}, skipped ${result.skipped} (already present)`,
    );
    for (const name of result.unknownStands) {
      console.log(`  UNKNOWN STAND  ${name}: no sales location with this name`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
