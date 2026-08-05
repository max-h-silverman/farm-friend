// F-062 — ingest VIGA's weekly stock form as dated confirmations.
//
//   npm run db:seed-weekly -- --weekly <weekly.csv> [--season 2026] [--dry-run]
//
// WHAT THIS IS FOR. VIGA's third CSV is a weekly Google Form a farmer has been filling in for
// years. Nothing has ever read it. If their submission produces nothing on the map, the system
// replacing their old one is strictly worse for them on day one and silently discards work they
// really did — so each farm's latest submission becomes a dated confirmation on its card.
//
// A customer wants both facts: the standing "usually sells" sets expectations, the dated one says
// how much to trust it today. Age needs no special handling — past 48 hours the card already
// shows its stale caution, which is exactly true.
//
// PROVENANCE. Every row carries `source = 'viga'` (F-063). A Google Form is not a handset, so
// none of the three keys asserting an authorized phone sent a message is written. And a farmer's
// own SMS always wins: `seedWeeklyConfirmations` refuses to overwrite anything newer, whatever
// its source, which is the migration path off the legacy form.
//
// REPORTS EVERYTHING IT DID NOT DO. Unknown farms, refused rows, and closures are printed rather
// than dropped — a farmer's submission vanishing with no trace is the failure this exists to end.
// Closures are reported for a person to act on rather than written: closing a stand is a
// published state with its own workflow, and this script does not own it.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { parseWeeklyStatus } from "@farm-friend/core";
import { seedWeeklyConfirmations, type WeeklyConfirmationInput } from "../src/seed";
import { describeTarget } from "../src/connection-target";
import {
  describeFingerprint,
  fingerprintDatabase,
  requireExpectedDatabase,
} from "../src/ingest-guard";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const weeklyPath = argValue("--weekly");
  const seasonArg = argValue("--season");
  const dryRun = process.argv.includes("--dry-run");

  if (!weeklyPath) {
    console.error(
      "usage: npm run db:seed-weekly -- --weekly <weekly.csv> [--season 2026] [--dry-run]",
    );
    process.exit(1);
  }

  const season = seasonArg === undefined ? undefined : Number(seasonArg);
  if (season !== undefined && !Number.isInteger(season)) {
    console.error(`--season must be a year, got ${seasonArg}`);
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !dryRun) {
    console.error("DATABASE_URL is required (or pass --dry-run)");
    process.exit(1);
  }

  const parsed = parseWeeklyStatus(readFileSync(weeklyPath, "utf8"), {
    ...(season !== undefined ? { season } : {}),
  });

  console.log(
    `weekly form: ${parsed.submissions.length} submissions (latest per farm), ` +
      `${parsed.closed.length} reporting closed, ${parsed.rejected.length} refused` +
      (season !== undefined ? `  [season ${season}]` : ""),
  );
  for (const item of parsed.rejected) console.log(`  REFUSED  ${item.name}: ${item.reason}`);
  for (const item of parsed.closed) {
    // Not written. Closing a stand is a published state with its own workflow and its own
    // authority; a spreadsheet row is a lead for an operator, not a command.
    console.log(
      `  CLOSED   ${item.farmName} (${item.statedOn.toISOString().slice(0, 10)}): ` +
        `"${item.statedAs}" — not written; use the closure workflow`,
    );
  }

  const inputs: WeeklyConfirmationInput[] = parsed.submissions.map((submission) => ({
    standName: submission.farmName,
    statedOn: submission.statedOn,
    items: submission.items,
  }));

  if (dryRun) {
    for (const input of inputs) {
      console.log(
        `  WOULD    ${input.standName} (${input.statedOn.toISOString().slice(0, 10)}): ` +
          input.items.join(", "),
      );
    }
    console.log("\n--dry-run: nothing written");
    return;
  }

  const sql = postgres(databaseUrl!, { max: 1 });
  try {
    // FINGERPRINT BEFORE WRITING (F-064). `--expect-database` is how an operator states which
    // database they believe they are hitting; without it the target is only reported, because
    // requiring it on every local run would train people to paste it without reading.
    const expectDatabase = argValue("--expect-database");
    const fingerprint =
      expectDatabase === undefined
        ? await fingerprintDatabase(sql)
        : await requireExpectedDatabase(sql, { databaseName: expectDatabase });
    console.log(`target: ${describeTarget(databaseUrl!)} — ${describeFingerprint(fingerprint)}`);

    const result = await seedWeeklyConfirmations(sql, inputs);
    console.log(
      `\npublished ${result.published}, ` +
        `skipped ${result.skippedAsOlder} (something newer is already published), ` +
        `${result.unknownStands.length} unknown stands`,
    );
    // The number that says whether the join actually worked. A farm in the form with no stand in
    // the database is a submission that reached nobody.
    for (const name of result.unknownStands) {
      console.log(`  UNKNOWN  ${name}: no seeded stand matches this farm name`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
