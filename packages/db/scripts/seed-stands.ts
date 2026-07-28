// B-002 — seed VIGA's farm-stand export.
//
//   npm run db:seed -- <path-to-csv>            # apply
//   npm run db:seed -- <path-to-csv> --dry-run  # report only, write nothing
//
// This is the composition point for the seed path: it reads the export, strips contact
// details, extracts the labelled fields, parses availability, and hands typed values to
// `seedStands`. Every interpretation step lives in a tested module in `@farm-friend/core`;
// this script only wires them together and reports.
//
// OFFERINGS ARE NOT SEEDED HERE. What a stand usually carries comes from the
// `offering-extraction` model seam (F-036), which proposes tags a human approves before code
// commits them. That path is blocked until a real provider is attested (F-024), and a stand
// with no offerings is a correct intermediate state — B-013 makes it visible on the map with
// no recency claim. Nothing about this script fabricates one in the meantime.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import {
  extractStandFields,
  parseOpenHours,
  parseSeason,
  parseStandCsv,
  parseStocking,
  stripContactDetails,
  type ParsedSeason,
  type ParsedOpenHours,
} from "@farm-friend/core";
import {
  seedStands,
  type SeedStandFlag,
  type SeedStandInput,
  type SeededOpenHours,
  type SeededSeason,
} from "../src/seed";

/** Find the stand's street address. Never invented: an absent one refuses the stand. */
function findAddress(description: string): string | undefined {
  for (const line of description.split("\n")) {
    const trimmed = line.trim();
    // A street address begins with a house number, or is one of the corpus's descriptive
    // "Entrance is ..." directions.
    if (/^\d+\s+\S/.test(trimmed) || /^entrance\b/i.test(trimmed)) return trimmed;
  }
  return undefined;
}

function toSeededSeason(parsed: ParsedSeason): SeededSeason | null {
  switch (parsed.kind) {
    case "year_round":
      return { kind: "year_round" };
    case "date_range":
      return {
        kind: "date_range",
        startMonth: parsed.startMonth,
        startDay: parsed.startDay,
        endMonth: parsed.endMonth,
        endDay: parsed.endDay,
      };
    case "named_season":
      return { kind: "named_season", names: parsed.names };
    case "open_ended":
      return { kind: "open_ended", startMonth: parsed.startMonth, startDay: parsed.startDay };
    case "not_stated":
      return { kind: "not_stated" };
    // `unparsed` is a DEFECT, not a value: the text stated a season this code did not
    // understand. It seeds as "not stated" and raises a flag for a human, rather than
    // guessing a range that would show on the map as fact.
    case "unparsed":
      return null;
  }
}

function toSeededHours(parsed: ParsedOpenHours): SeededOpenHours | null {
  switch (parsed.kind) {
    case "clock_range":
      return {
        kind: "clock_range",
        fromMinutes: parsed.fromMinutes!,
        untilMinutes: parsed.untilMinutes!,
      };
    case "until_dusk":
      return { kind: "until_dusk", fromMinutes: parsed.fromMinutes! };
    case "not_stated":
      return { kind: "not_stated" };
    case "unparsed":
      return null;
    default:
      return { kind: parsed.kind };
  }
}

async function main(): Promise<void> {
  const [csvPath, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");

  if (!csvPath) {
    console.error("usage: npm run db:seed -- <path-to-csv> [--dry-run]");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !dryRun) {
    console.error("DATABASE_URL is required (or pass --dry-run)");
    process.exit(1);
  }

  const { stands: raw, rejected } = parseStandCsv(readFileSync(csvPath, "utf8"));
  const inputs: SeedStandInput[] = [];
  const refused: { name: string; reason: string }[] = [...rejected];

  for (const stand of raw) {
    // Contact details are stripped BEFORE anything else reads the text, so no later step
    // can copy an email or phone number into a column.
    const description = stripContactDetails(stand.description);
    const fields = extractStandFields(description);

    const address = findAddress(description);
    if (address === undefined) {
      // No address, and inventing one is out of the question (F-017). An operator resolves
      // it; the stand is reported, never silently dropped.
      refused.push({ name: stand.name, reason: "no street address in the export" });
      continue;
    }

    const flags: SeedStandFlag[] = [];
    const openText = fields.openText ?? "";

    const parsedSeason = parseSeason(openText);
    const parsedHours = parseOpenHours(openText);
    const parsedStocking = parseStocking(fields.stockingText ?? "");

    let season = toSeededSeason(parsedSeason);
    if (season === null) {
      flags.push({ reason: "season_unresolved", sourceText: openText });
      season = { kind: "not_stated" };
    }

    let openHours = toSeededHours(parsedHours);
    if (openHours === null) {
      flags.push({ reason: "unparsed_availability", sourceText: openText });
      openHours = { kind: "not_stated" };
    }

    // More than one `Open:` line means the stand states two different things. The seeder
    // never picks a winner — it seeds the first and hands the conflict to an operator.
    if (fields.openTexts.length > 1) {
      flags.push({
        reason: "contradictory_hours",
        sourceText: fields.openTexts.join(" | "),
      });
    }

    if (fields.closureNote !== undefined) {
      flags.push({ reason: "possibly_closed", sourceText: fields.closureNote });
    }

    inputs.push({
      name: stand.name,
      address,
      longitude: stand.longitude,
      latitude: stand.latitude,
      kind: /farmers\s*market/i.test(stand.name) ? "farmers_market" : "farm_stand",
      ...(fields.openText !== undefined ? { hoursText: fields.openText } : {}),
      season,
      openHours,
      stocking:
        parsedStocking.cadence === "unparsed"
          ? { cadence: "not_stated" }
          : {
              cadence: parsedStocking.cadence,
              ...(parsedStocking.days ? { days: parsedStocking.days } : {}),
            },
      flags,
    });
  }

  const flagged = inputs.filter((stand) => stand.flags.length > 0);
  console.log(`parsed ${inputs.length} stands, ${refused.length} refused`);
  for (const item of refused) console.log(`  REFUSED  ${item.name}: ${item.reason}`);
  for (const stand of flagged) {
    console.log(
      `  FLAGGED  ${stand.name}: ${stand.flags.map((f) => f.reason).join(", ")}`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written");
    return;
  }

  const sql = postgres(databaseUrl!, { max: 1 });
  try {
    const result = await seedStands(sql, inputs);
    console.log(
      `\nseeded ${result.seeded}, skipped ${result.skipped} (already present), ` +
        `flags raised ${result.flagsRaised}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
