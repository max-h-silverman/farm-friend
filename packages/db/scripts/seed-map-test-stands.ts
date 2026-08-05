// Bulk filler stands for exercising the wide-screen map/list layout locally.
//
//   npx tsx packages/db/scripts/seed-map-test-stands.ts [--count 30] [--remove]
//
// WHY THIS EXISTS. The map-follow behavior (the map sliding down to sit beside the selected
// stand) only does anything when the directory is longer than the map is tall. A local database
// with six visible stands cannot show it, and cannot show the clamp at the bottom of the list
// at all. This makes a list long enough to see both.
//
// THIS IS A LOCAL DEVELOPMENT TOOL AND REFUSES TO RUN ANYWHERE ELSE. It writes obviously-fake
// farms, so pointing it at a real corpus would put fake stands on VIGA's map. Two guards: the
// connection must be a localhost one, and every row it creates carries the `Map Test — ` name
// prefix that `--remove` deletes by. Nothing without that prefix is ever touched.
//
// The rows go in through `seedStands`, the same path the real seeder uses, so they satisfy the
// same table constraints rather than being hand-built INSERTs that drift from the schema.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { seedOfferings, seedStands, type SeedStandInput } from "../src/seed";

/** Every row this script creates starts with this. `--remove` deletes by it, and only by it. */
const TEST_PREFIX = "Map Test — ";

/** Vashon's rough bounding box, so the pins land on the island rather than in the sound. */
const ISLAND = { minLat: 47.38, maxLat: 47.51, minLon: -122.51, maxLon: -122.43 };

const FARM_WORDS = [
  "Cedar", "Harbor", "Meadow", "Thistle", "Wren", "Quartermaster", "Burton", "Dockton",
  "Ellisport", "Paradise", "Maury", "Tramp", "Colvos", "Sylvan", "Fern", "Alder",
  "Salmonberry", "Nettle", "Chautauqua", "Gorsuch", "Beall", "Cove", "Bramble", "Sunrise",
  "Foxglove", "Madrona", "Heron", "Kestrel", "Juniper", "Sorrel",
];
const FARM_SUFFIX = ["Farm", "Gardens", "Stand", "Orchard", "Croft", "Acres"];

/**
 * Deterministic pseudo-random, so re-running produces the SAME farms rather than a new set
 * layered on top of the last run. Combined with `seedStands` skipping existing names, a second
 * run is a no-op instead of another 30 rows.
 */
function seededRandom(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

/**
 * ONE DENSE STAND, modelled on the worst real listing on VIGA's map.
 *
 * The generated filler above is uniformly thin — one description line, a couple of tags — so a
 * directory made only of it cannot show what the expanded detail does under real data: a dozen
 * specialty tags beside a long free-text description carrying hours, socials, and payment. That
 * combination is what the layout has to stay balanced under, so it needs to exist locally.
 *
 * It carries the `Map Test — ` prefix like everything else here, so `--remove` takes it too.
 */
function denseStand(): SeedStandInput {
  return {
    name: `${TEST_PREFIX}Dense Listing Farm`,
    description: [
      "Website: https://example.invalid/dense-listing-farm",
      "Jen Example",
      "23720 Example Rd SW, Vashon, WA 98070",
      "",
      "Facebook: facebook.com/ExampleDenseFarm",
      "Instagram: https://www.instagram.com/exampledensefarm/",
      "",
      "Open: March-November. 7 days a week, dawn to dusk.",
      "",
      "Stocking Days: Stocking daily. Harvest days are Tuesday and Friday. Best selection on " +
        "those days by late afternoon.",
      "",
      "Generally Offers: Plant Starts, Vegetables, Fruits, Flowers and Baked Goods",
      "",
      "5/26/2026 Update: Salad, spinach, kale, radish, microgreens, pea shoots, herbs, plant " +
        "starts and flowers",
      "",
      "Hosting: Example Bakery, Example Island Honey Co.",
      "",
      "Accepts Cash, Check, Zelle, Venmo, VIGA Farm Bucks",
    ].join("\n"),
    place: { address: "23720 Example Rd SW", latitude: 47.4012, longitude: -122.4655 },
    visitability: "visitable",
    offeringType: "produce",
    kind: "farm_stand",
    hoursText: "Dawn to dusk, honor system",
    season: { kind: "date_range", startMonth: 3, startDay: 1, endMonth: 11, endDay: 30 },
    openHours: { kind: "daylight_hours" },
    stocking: { cadence: "variable" },
    flags: [],
    farmBucksAccepted: true,
    farmBucksEligible: true,
  };
}

/** The dense stand's specialty tags, which live in their own table rather than on the stand row. */
const DENSE_OFFERINGS = [
  "plant starts", "vegetables", "fruits", "flowers", "baked goods", "salad",
  "spinach", "kale", "radish", "microgreens", "pea shoots", "herbs",
];

function buildStands(count: number): SeedStandInput[] {
  const random = seededRandom(20260803);
  const stands: SeedStandInput[] = [denseStand()];

  for (let index = 0; index < count; index++) {
    const word = FARM_WORDS[index % FARM_WORDS.length]!;
    const suffix = FARM_SUFFIX[index % FARM_SUFFIX.length]!;
    // The number keeps names unique past the word list, and makes the ordering legible on screen.
    const name = `${TEST_PREFIX}${word} ${suffix} ${index + 1}`;

    const latitude = Number(
      (ISLAND.minLat + random() * (ISLAND.maxLat - ISLAND.minLat)).toFixed(5),
    );
    const longitude = Number(
      (ISLAND.minLon + random() * (ISLAND.maxLon - ISLAND.minLon)).toFixed(5),
    );

    stands.push({
      name,
      description: "Filler stand for local layout testing. Not a real farm.",
      place: { address: `${100 + index} Test Road SW`, latitude, longitude },
      visitability: "visitable",
      offeringType: "produce",
      kind: "farm_stand",
      hoursText: "Daylight hours, honor system",
      season: { kind: "year_round" },
      openHours: { kind: "daylight_hours" },
      stocking: { cadence: "variable" },
      flags: [],
      // Alternated so the poster dots and the VIGA Bucks filter both have something to show.
      farmBucksAccepted: index % 3 !== 0,
      farmBucksEligible: true,
    });
  }

  return stands;
}

function localUrl(): string {
  const raw = readFileSync(
    new URL("../../../apps/web/.env.local", import.meta.url),
    "utf8",
  );
  const match = raw.match(/^DATABASE_URL=(.+)$/m);
  if (match === null) throw new Error("No DATABASE_URL in apps/web/.env.local");

  const url = match[1]!.trim().replace(/^["']|["']$/g, "");
  const { hostname } = new URL(url);

  // THE GUARD. A fake-farm writer must not be able to reach a hosted database, whatever the
  // env file happens to say at the time. Anything but a loopback host stops the script.
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      `Refusing to run against non-local host "${hostname}". This script writes fake farms ` +
        `and is for local development only.`,
    );
  }
  return url;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const remove = args.includes("--remove");
  const countArg = args.indexOf("--count");
  const count = countArg === -1 ? 30 : Number(args[countArg + 1]);

  if (!Number.isInteger(count) || count < 1 || count > 200) {
    throw new Error(`--count must be a whole number between 1 and 200, got "${count}"`);
  }

  const sql = postgres(localUrl());

  try {
    if (remove) {
      // Deletes by the prefix only. Seeded farms and locations share the same name, and the
      // location row is removed first because it references the farm.
      const locations = await sql`
        delete from sales_locations where name like ${TEST_PREFIX + "%"} returning id
      `;
      const farms = await sql`
        delete from farms where name like ${TEST_PREFIX + "%"} returning id
      `;
      console.log(`Removed ${locations.length} test locations and ${farms.length} test farms.`);
      return;
    }

    const result = await seedStands(sql, buildStands(count));
    // The dense stand's specialty tags go in through the approved-offerings path, the same one
    // real tags use, so they land under the same constraints rather than a bespoke insert.
    const tags = await seedOfferings(sql, [
      { standName: `${TEST_PREFIX}Dense Listing Farm`, items: DENSE_OFFERINGS },
    ]);
    console.log(
      `Seeded ${result.seeded} test stands (${result.skipped} already present), ` +
        `${tags.inserted} specialty tags on the dense stand.\n` +
        `Remove them with: npx tsx packages/db/scripts/seed-map-test-stands.ts --remove`,
    );

    const total = await sql<{ n: number }[]>`
      select count(*)::int as n from sales_locations
      where is_public = true and public_latitude is not null
    `;
    console.log(`The map now shows ${total[0]!.n} stands.`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
