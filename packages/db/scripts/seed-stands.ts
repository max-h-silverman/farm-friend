// B-002 / F-038 — seed VIGA's farm-stand corpus from BOTH exports.
//
//   npm run db:seed -- --form <form.csv> --map <map.csv> \
//     --offerings <reviewed.json> [--dry-run]
//
// THREE REVIEWED INPUTS, because none can restore a complete public listing alone:
//
//   form responses  →  2026-current details (hours, season, stocking, website, social), and
//                      NO COORDINATES AT ALL
//   map export      →  coordinates, and the sellers that did not submit a 2026 form
//   offerings JSON  →  human-reviewed structured facts about what each stand usually carries
//
// This is the composition point: it reads both, joins them by name (`match-stands.ts`), parses
// availability, classifies what each farm sells, and hands typed values to the atomic corpus
// writer. Every interpretation step lives in a tested module in `@farm-friend/core`; this script
// wires them together and REPORTS — including the match rate, which is the number that says
// whether the join actually worked. A silent "seeded 28" tells you nothing about the four it dropped.
//
// B-044 — the reviewed offerings artifact is REQUIRED here and commits in the same transaction
// as the stands. The model proposal and human review still happen separately; once approved,
// omitting that half from a rebuild makes every public card claim it usually has nothing.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import {
  buildStandDescription,
  classifyOfferingType,
  joinStandSources,
  matchStandName,
  parseFarmLinks,
  parseFormResponses,
  parseHostedParticipants,
  parseFarmBucksPolicy,
  parseOpenHours,
  parsePaymentMethods,
  parseSeason,
  parseStandCsv,
  parseOpenDays,
  parseStocking,
  refusesPublicAddress,
  stripContactDetails,
  type JoinedStand,
  type ParsedSeason,
  type ParsedOpenHours,
} from "@farm-friend/core";
import {
  findUnknownOfferingStands,
  parseApprovedOfferings,
} from "../src/approved-offerings";
import {
  seedReviewedCorpus,
  type SeedStandFlag,
  type SeedStandInput,
  type SeededOpenHours,
  type SeededSeason,
} from "../src/seed";
import { describeTarget } from "../src/connection-target";
import {
  describeFingerprint,
  fingerprintDatabase,
  requireExpectedDatabase,
} from "../src/ingest-guard";

/**
 * Coordinates for sellers that submitted a 2026 form but appear in NO map row.
 *
 * Three such sellers: they state real street addresses, so they are genuinely visitable, but the
 * legacy map export predates them and has no point. A seed-time lookup is explicitly permitted
 * (B-002 — the prohibition is on a RUNTIME geocoder, and F-017's tripwire still forbids one);
 * these were resolved once against OpenStreetMap and verified by max.
 *
 * They live here as data rather than in the join, because they are an input to the corpus, not
 * a rule about it. A farm that later appears in a refreshed map export simply stops needing its
 * entry — the join prefers the export.
 *
 * The last two came from max directly (2026-07-29) after the seeder refused them: neither address
 * resolves to a point automatically — "SW 238th St" is absent from OpenStreetMap on Vashon, and
 * "Bank Road, East of Town" names a road with no number. That is the refusal working as designed:
 * it surfaced two real stands for a human to place, rather than guessing a point or dropping them.
 */
const SUPPLEMENTAL_COORDINATES: Record<string, { latitude: number; longitude: number }> = {
  Farmstad: { latitude: 47.4727554, longitude: -122.489797 },
  "Handpicked Homestead": { latitude: 47.4271197, longitude: -122.4710309 },
  "Lavender Hill Farm": { latitude: 47.390774975247844, longitude: -122.4686159601207 },
  "Sweet Alyssum Farm": { latitude: 47.44714371286876, longitude: -122.45352178222176 },
};

/**
 * The one address max supplied by hand, for a farm in neither file's usable form.
 *
 * Vashon Island Farmers Market is in the map export with coordinates but states no street
 * address in its description, and a market does not submit a member farm-stand form.
 */
const SUPPLEMENTAL_ADDRESSES: Record<string, string> = {
  "Vashon Island Farmers Market": "17519 Vashon Hwy SW",
};

/**
 * Farms the map export gives coordinates for that are NOT visitable (F-038, max 2026-07-29).
 *
 * Breathing Meadows submitted no 2026 form, and its map description says "Open only by
 * appointment" — a customer specifically cannot turn up, which is the definition of a farm you
 * contact first. Its coordinates are deliberately not seeded: a pin you cannot visit is what
 * sends someone driving to a farm that is not expecting them.
 *
 * This is a stated product decision about a farm with no form, not an inference. A farm that
 * submits a 2026 form classifies itself from its own Address answer, in `form-responses.ts`.
 */
const CONTACT_ONLY_BY_DECISION = ["Breathing Meadows Farm"];

// Re-key each table by match key at module load. Building them here rather than writing
// normalized keys by hand keeps the tables readable as the farm names a person recognizes, and
// means a typo'd key throws at startup rather than silently failing to match.
const supplementalCoordinates = new Map(
  Object.entries(SUPPLEMENTAL_COORDINATES).map(([name, point]) => [
    matchStandName(name),
    point,
  ]),
);
const supplementalAddresses = new Map(
  Object.entries(SUPPLEMENTAL_ADDRESSES).map(([name, address]) => [
    matchStandName(name),
    address,
  ]),
);
const contactOnlyByDecision = new Set(CONTACT_ONLY_BY_DECISION.map(matchStandName));

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

/**
 * Turn one joined farm into a seedable row.
 *
 * The FORM is authoritative for availability when it submitted one — those are separate,
 * structured columns rather than prose the availability parser has to pick apart. A map-only
 * farm falls back to its description's `Open:` lines, which is what the original loader did for
 * the whole corpus.
 */
function toSeedInput(stand: JoinedStand, usuallySells: readonly string[]): {
  input?: SeedStandInput;
  refusal?: { name: string; reason: string };
} {
  const flags: SeedStandFlag[] = [];

  // Availability text: the form's own columns first, the map description's prose second.
  const seasonText = stand.form?.openSeasonText ?? "";
  const hoursText = stand.form?.openHoursText ?? "";
  const stockingText = stand.form?.stockingText ?? "";

  const mapDescription =
    stand.map === undefined ? "" : stripContactDetails(stand.map.description);

  // F-061 — the description is REBUILT from the form's own columns, not taken from the map.
  //
  // The line this replaces was `mapDescription || [ ...form fields... ].join("\n")`, which for
  // the 27 stands carrying a map row stored the transcription's prose and discarded the form's
  // clean columns for display while still parsing them for the structured fields. That is the
  // whole cause of both on-screen contradictions: "Hours not listed" beside prose stating the
  // hours, and "Nothing confirmed recently" above a farmer-dated update.
  const publicDescription = buildStandDescription({
    ...(stand.form?.generalInformation !== undefined
      ? { generalInformation: stand.form.generalInformation }
      : {}),
    ...(stand.form?.extraNotes !== undefined ? { extraNotes: stand.form.extraNotes } : {}),
    ...(stand.form?.openSeasonText !== undefined
      ? { openSeasonText: stand.form.openSeasonText }
      : {}),
    ...(stand.form?.openHoursText !== undefined
      ? { openHoursText: stand.form.openHoursText }
      : {}),
    ...(stand.form?.stockingText !== undefined ? { stockingText: stand.form.stockingText } : {}),
    ...(stand.form?.website !== undefined ? { website: stand.form.website } : {}),
    ...(stand.form?.socialMedia !== undefined ? { socialMedia: stand.form.socialMedia } : {}),
    ...(usuallySells.length > 0 ? { usuallySells } : {}),
    ...(mapDescription !== "" ? { mapDescription } : {}),
  });

  // The map's description lines, used as the link fallback for a farm with no form row and as
  // the ONLY source of payment methods — the profile form has no payment question at all
  // (measured against the real header, 2026-08-04).
  const mapLines = mapDescription
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const links = parseFarmLinks({
    ...(stand.form?.website !== undefined ? { website: stand.form.website } : {}),
    ...(stand.form?.socialMedia !== undefined ? { socialMedia: stand.form.socialMedia } : {}),
    mapLinkLines: mapLines,
  });
  const paymentMethods = [...new Set(mapLines.flatMap((line) => parsePaymentMethods(line)))];

  // F-064 — host sellers, from the map's `Hosting:` prose. The profile form has no hosting
  // question (measured against the real header, 2026-08-07), so the map is the only source
  // here. The weekly form asks it as its own column and is a separate, later feed.
  //
  // Only lines that ANNOUNCE hosting are offered to the parser. It reads a bare list too,
  // because the weekly form's column has no label — so handing it every description line would
  // read a farm's address or its produce sentence as a roster of sellers.
  const participants = [
    ...new Set(
      mapLines
        .filter((line) => /^\s*hosting\b/i.test(line))
        .flatMap((line) => parseHostedParticipants(line)),
    ),
  ];

  const parsedSeason = parseSeason(seasonText || mapDescription);
  const parsedHours = parseOpenHours(hoursText || mapDescription);
  const parsedStocking = parseStocking(stockingText || mapDescription);

  // B-039 — which WEEKDAYS, read from the SAME answer the hours come from. VIGA's form asks
  // "Open Hours & Days" as one question, so "10-6, Wednesday & Saturday" carries both axes;
  // `parseOpenHours` takes the times and this takes the days. Neither is a fallback for the
  // other, and a stand may state one without the other.
  const parsedOpenDays = parseOpenDays(hoursText || mapDescription);
  const farmBucksPolicy = parseFarmBucksPolicy(
    [
      stand.name,
      stand.form?.name,
      mapDescription,
      stand.form?.generalInformation,
      stand.form?.extraNotes,
    ]
      .filter((text): text is string => text !== undefined && text.trim() !== "")
      .join("\n"),
  );

  let season = toSeededSeason(parsedSeason);
  if (season === null) {
    flags.push({ reason: "season_unresolved", sourceText: seasonText || mapDescription });
    season = { kind: "not_stated" };
  }

  let openHours = toSeededHours(parsedHours);
  if (openHours === null) {
    flags.push({ reason: "unparsed_availability", sourceText: hoursText || mapDescription });
    openHours = { kind: "not_stated" };
  }

  // An address the farmer stated but no geocoder can resolve ("Bank Road, East of Town") is a
  // question for an operator, not a reason to drop the stand.
  if (stand.form?.addressNeedsReview === true) {
    flags.push({
      reason: "address_unresolved",
      sourceText: `address needs review: ${stand.publicAddress ?? "(none)"}`,
    });
  }

  const offeringType = classifyOfferingType({
    ...(stand.form?.generalInformation !== undefined
      ? { generalInformation: stand.form.generalInformation }
      : {}),
    ...(stand.form?.extraNotes !== undefined ? { extraNotes: stand.form.extraNotes } : {}),
    ...(stockingText !== "" ? { stockingText } : {}),
  });

  const base = {
    name: stand.name,
    ...(publicDescription !== undefined ? { description: publicDescription } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(paymentMethods.length > 0 ? { paymentMethods } : {}),
    ...(participants.length > 0 ? { participants } : {}),
    kind: /farmers\s*market/i.test(stand.name)
      ? ("farmers_market" as const)
      : ("farm_stand" as const),
    offeringType,
    ...(hoursText !== "" ? { hoursText } : {}),
    season,
    openHours,
    ...(parsedOpenDays !== undefined ? { openDays: parsedOpenDays } : {}),
    stocking:
      parsedStocking.cadence === "unparsed"
        ? { cadence: "not_stated" as const }
        : {
            cadence: parsedStocking.cadence,
            ...(parsedStocking.days ? { days: parsedStocking.days } : {}),
          },
    flags,
    ...(farmBucksPolicy !== undefined
      ? {
          farmBucksAccepted: farmBucksPolicy.accepted,
          farmBucksEligible: farmBucksPolicy.eligible,
        }
      : {}),
  };

  // B-024 — a farmer who asked us not to publish her address gets no address and no pin.
  //
  // Production currently publishes Handpicked Homestead's HOME as a visitable farm stand with a
  // correct map pin, against her form's plain words: "I don't have my own farmstand - please add
  // me under Plum Forest's location, do not add my address." That is F-038's misdirecting pin
  // made worse — the coordinate is right, it is someone's house, and she asked us not to.
  //
  // Read from the farmer's own text as a GENERAL rule, so no farm is named here and a farmer who
  // writes the same next season is covered by the same mechanism. She stays listed and findable;
  // only the address and the point are withheld.
  const refusesAddress = refusesPublicAddress(
    [stand.form?.generalInformation, stand.form?.extraNotes, stand.form?.accessNote]
      .filter((text): text is string => text !== undefined && text.trim() !== "")
      .join("\n"),
  );

  if (
    stand.visitability === "contact_only" ||
    refusesAddress ||
    contactOnlyByDecision.has(matchStandName(stand.name))
  ) {
    // No address, no point — and none taken from the map export even when it has one.
    return { input: { ...base, visitability: "contact_only" } };
  }

  // Supplements are looked up through the SAME normalization the join matches on, never by raw
  // name. Two of these sellers carry VIGA's inline annotation ("Lavender Hill Farm *does not accept
  // VIGA Bucks*"), so a raw-string lookup misses them silently — the entry is present, the farm
  // is still refused, and nothing reports the mismatch. That happened on the first attempt here.
  const key = matchStandName(stand.name);
  const address = stand.publicAddress ?? supplementalAddresses.get(key);
  const point =
    stand.latitude !== undefined && stand.longitude !== undefined
      ? { latitude: stand.latitude, longitude: stand.longitude }
      : supplementalCoordinates.get(key);

  if (address === undefined) {
    return {
      refusal: { name: stand.name, reason: "visitable stand states no street address" },
    };
  }
  if (point === undefined) {
    return {
      refusal: {
        name: stand.name,
        reason: "visitable stand has no coordinate, and a point is never invented",
      },
    };
  }

  return {
    input: {
      ...base,
      visitability: "visitable",
      place: { address, latitude: point.latitude, longitude: point.longitude },
    },
  };
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const formPath = argValue("--form");
  const mapPath = argValue("--map");
  const offeringsPath = argValue("--offerings");
  const dryRun = process.argv.includes("--dry-run");

  if (!formPath || !mapPath || !offeringsPath) {
    console.error(
      "usage: npm run db:seed -- --form <form.csv> --map <map.csv> " +
        "--offerings <reviewed.json> [--dry-run]\n" +
        "  all files are required: the exports hold stands and the reviewed artifact holds " +
        "what they usually carry",
    );
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !dryRun) {
    console.error("DATABASE_URL is required (or pass --dry-run)");
    process.exit(1);
  }

  const form = parseFormResponses(readFileSync(formPath, "utf8"));
  const map = parseStandCsv(readFileSync(mapPath, "utf8"));
  const { approved: offerings, skippedNoItems } = parseApprovedOfferings(
    JSON.parse(readFileSync(offeringsPath, "utf8")) as unknown,
  );

  const { joined, refused: joinRefused } = joinStandSources({
    form: form.stands,
    formRejected: form.rejected,
    map: map.stands,
  });

  const inputs: SeedStandInput[] = [];
  const refused = [...map.rejected, ...joinRefused];
  const offeringsByStand = new Map(
    offerings.map((offering) => [matchStandName(offering.standName), offering.items] as const),
  );

  for (const stand of joined) {
    const { input, refusal } = toSeedInput(
      stand,
      offeringsByStand.get(matchStandName(stand.name)) ?? [],
    );
    if (refusal) refused.push(refusal);
    else if (input) inputs.push(input);
  }

  // THE MATCH RATE. The join is the fiddly part of this seeder and the one most likely to be
  // silently wrong, so it is reported rather than assumed: a farm matched to the wrong row gets
  // a real address that is not its own. `form_and_map` is the count that actually exercised the
  // name matcher.
  const bySource = (source: JoinedStand["source"]) =>
    joined.filter((stand) => stand.source === source).length;

  console.log(
    `form export: ${form.stands.length} stands, ${form.rejected.length} unreadable\n` +
      `map export:  ${map.stands.length} stands, ${map.rejected.length} unreadable\n` +
      `joined:      ${joined.length} (${bySource("form_and_map")} matched across both files, ` +
      `${bySource("form")} form only, ${bySource("map_only")} map only)`,
  );

  const contactOnly = inputs.filter((stand) => stand.visitability === "contact_only");
  const nonProduce = inputs.filter((stand) => stand.offeringType !== "produce");
  console.log(
    `seedable:    ${inputs.length} (${contactOnly.length} contact-only, ` +
      `${nonProduce.length} not a produce stand), ${refused.length} refused`,
  );

  const unknownOfferingStands = findUnknownOfferingStands(inputs, offerings);
  const offeringCount = offerings.reduce((sum, entry) => sum + entry.items.length, 0);
  console.log(
    `offerings:   ${offerings.length} reviewed stands, ${offeringCount} usual items, ` +
      `${unknownOfferingStands.length} unknown, ${skippedNoItems.length} unresolved`,
  );

  for (const item of refused) console.log(`  REFUSED  ${item.name}: ${item.reason}`);
  for (const stand of nonProduce) {
    console.log(`  TYPE     ${stand.name}: ${stand.offeringType}`);
  }
  for (const stand of contactOnly) console.log(`  CONTACT  ${stand.name}: no pin`);
  for (const stand of inputs.filter((s) => s.flags.length > 0)) {
    console.log(`  FLAGGED  ${stand.name}: ${stand.flags.map((f) => f.reason).join(", ")}`);
  }
  for (const name of unknownOfferingStands) {
    console.log(`  UNKNOWN OFFERING STAND  ${name}: absent from the stand restore`);
  }
  for (const name of skippedNoItems) {
    console.log(`  UNRESOLVED OFFERINGS  ${name}: no reviewed items array`);
  }

  if (unknownOfferingStands.length > 0 || skippedNoItems.length > 0) {
    throw new Error("reviewed offering artifact is incomplete for this stand restore");
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written");
    return;
  }

  const sql = postgres(databaseUrl!, { max: 1 });
  try {
    // FINGERPRINT BEFORE WRITING (F-064). Naming the target is not enough — an operator reads
    // `neondb` and sees what they expected. This reports what is actually in there, and
    // `--expect-database` turns a mistyped connection string into an abort rather than a write.
    const expectDatabase = argValue("--expect-database");
    const fingerprint =
      expectDatabase === undefined
        ? await fingerprintDatabase(sql)
        : await requireExpectedDatabase(sql, { databaseName: expectDatabase });
    console.log(`\ntarget: ${describeTarget(databaseUrl!)} — ${describeFingerprint(fingerprint)}`);

    const result = await seedReviewedCorpus(sql, inputs, offerings);
    console.log(
      `\nseeded ${result.stands.seeded}, skipped ${result.stands.skipped} (already present), ` +
        `backfilled ${result.stands.backfilled} (links/payments/hosts added to an existing stand), ` +
        `refused ${result.stands.backfillRefused} (farmer owns the listing), ` +
        `flags raised ${result.stands.flagsRaised}; ` +
        `usual items inserted ${result.offerings.inserted}, ` +
        `already present ${result.offerings.skipped}, ` +
        `refused ${result.offerings.refusedStands.length} (farmer owns the listing)`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
