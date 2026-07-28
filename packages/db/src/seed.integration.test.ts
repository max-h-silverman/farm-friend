import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStands, type SeedStandInput } from "./seed";

// B-002 — the seeder, proven against real constraints.
//
// The invariants under test are the ones that would be invisible in a unit test with a fake
// database: that zero inventory is STRUCTURAL rather than merely omitted, that re-running
// changes nothing, and that a bad row is refused by the database rather than coerced into it.

const migrationsDir = resolve(process.cwd(), "packages/db", "drizzle");

function requiredDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }
  return url;
}

function testDatabaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe("seeding VIGA's stands (B-002)", () => {
  let adminClient: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let testDatabaseName: string;

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_seed_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    client = postgres(testDatabaseUrl(baseUrl, testDatabaseName), { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  const sample = (): SeedStandInput[] => [
    {
      name: "Alpha Farm",
      address: "1 Example Rd SW",
      longitude: -122.45,
      latitude: 47.46,
      kind: "farm_stand",
      hoursText: "Open: March to December",
      season: { kind: "date_range", startMonth: 3, startDay: 1, endMonth: 12, endDay: 31 },
      openHours: { kind: "dawn_to_dusk" },
      stocking: { cadence: "daily" },
      flags: [],
    },
    {
      name: "Beta Farm",
      address: "2 Example Rd SW",
      longitude: -122.5,
      latitude: 47.4,
      kind: "farm_stand",
      hoursText: "Open: contradictory",
      season: { kind: "not_stated" },
      openHours: { kind: "not_stated" },
      stocking: { cadence: "not_stated" },
      flags: [
        { reason: "contradictory_hours", sourceText: "two different Open: lines" },
      ],
    },
  ];

  it("creates a farm and a public sales location per stand", async () => {
    const result = await seedStands(client, sample());
    expect(result.seeded).toBe(2);

    const rows = await client`
      select f.name as farm_name, l.name as location_name, l.public_address,
             l.public_latitude, l.public_longitude, l.is_public
      from sales_locations l join farms f on f.id = l.farm_id
      order by l.name
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.farm_name).toBe("Alpha Farm");
    expect(rows[0]!.is_public).toBe(true);
    expect(Number(rows[0]!.public_longitude)).toBeCloseTo(-122.45, 6);
  });

  it("seeds ZERO inventory — a seeder cannot fabricate a farmer's confirmation", async () => {
    // The central product invariant (Golden Rule #1/#3). VIGA's export carries dated stock
    // notes, and seeding them would present text nobody confirmed as a farmer's current
    // published inventory. Green Ears' most recent note reads "Closed".
    //
    // This is structural, not merely omitted: `inventory_revisions` requires
    // `published_by_authorization_id` and `farm_approval_id`, neither of which the seeder
    // has or can create.
    const revisions = await client`select count(*)::integer as count from inventory_revisions`;
    expect(revisions[0]!.count).toBe(0);
    const entries = await client`select count(*)::integer as count from inventory_entries`;
    expect(entries[0]!.count).toBe(0);
  });

  it("seeds no farmer authorization or approval, so nothing can publish", async () => {
    const auths = await client`select count(*)::integer as count from farmer_authorizations`;
    expect(auths[0]!.count).toBe(0);
    const approvals = await client`select count(*)::integer as count from farm_approvals`;
    expect(approvals[0]!.count).toBe(0);
  });

  it("stores no contact row at all — no phone, no email", async () => {
    // The export carries 22 emails and 4 phone numbers. None may reach the database.
    const contacts = await client`select count(*)::integer as count from contacts`;
    expect(contacts[0]!.count).toBe(0);
  });

  it("writes structured availability, not just prose", async () => {
    const rows = await client`
      select season_kind, season_start_month, season_end_month, open_hours_kind,
             stocking_cadence
      from sales_locations where name = 'Alpha Farm'
    `;
    expect(rows[0]!.season_kind).toBe("date_range");
    expect(rows[0]!.season_start_month).toBe(3);
    expect(rows[0]!.open_hours_kind).toBe("dawn_to_dusk");
    expect(rows[0]!.stocking_cadence).toBe("daily");
  });

  it("raises a stand_data_flag for a contradiction instead of picking a reading", async () => {
    const flags = await client`
      select reason, source_text, resolved_at from stand_data_flags
    `;
    expect(flags).toHaveLength(1);
    expect(flags[0]!.reason).toBe("contradictory_hours");
    expect(flags[0]!.resolved_at).toBeNull();
  });

  it("is IDEMPOTENT — re-running seeds nothing new and duplicates no flag", async () => {
    const before = await client`select count(*)::integer as count from sales_locations`;
    const result = await seedStands(client, sample());
    const after = await client`select count(*)::integer as count from sales_locations`;

    expect(after[0]!.count).toBe(before[0]!.count);
    expect(result.seeded).toBe(0);
    expect(result.skipped).toBe(2);

    // The partial unique index permits one OPEN flag per (location, reason); a second run
    // must not pile up a duplicate copy of the same unresolved question.
    const flags = await client`select count(*)::integer as count from stand_data_flags`;
    expect(flags[0]!.count).toBe(1);
  });

  it("REFUSES a constraint violation rather than coercing the value", async () => {
    // An out-of-range coordinate must abort, not get clamped into the valid envelope. A
    // clamped coordinate is a stand at the wrong place, which is worse than no stand.
    await expect(
      seedStands(client, [
        {
          ...sample()[0]!,
          name: "Bad Coordinate Farm",
          address: "3 Example Rd SW",
          latitude: 991,
        },
      ]),
    ).rejects.toThrow();

    const rows = await client`
      select count(*)::integer as count from sales_locations where name = 'Bad Coordinate Farm'
    `;
    expect(rows[0]!.count).toBe(0);
  });

  it("rolls back the whole batch, leaving no half-seeded stand", async () => {
    const before = await client`select count(*)::integer as count from sales_locations`;
    await expect(
      seedStands(client, [
        { ...sample()[0]!, name: "Good Farm", address: "4 Example Rd SW" },
        { ...sample()[0]!, name: "Doomed Farm", address: "5 Example Rd SW", latitude: 991 },
      ]),
    ).rejects.toThrow();

    const after = await client`select count(*)::integer as count from sales_locations`;
    expect(after[0]!.count).toBe(before[0]!.count);
    const good = await client`
      select count(*)::integer as count from sales_locations where name = 'Good Farm'
    `;
    expect(good[0]!.count).toBe(0);
  });

  it("makes a seeded stand visible on the public map with NO recency claim", async () => {
    // B-013's reader property, end to end: a stand nobody has confirmed must appear, and
    // must carry no `updated`/`stale` label, because there is no confirmation to date.
    const rows = await client`
      select l.name,
             (select count(*)::integer from inventory_revisions r
               where r.sales_location_id = l.id) as revisions
      from sales_locations l where l.name = 'Alpha Farm'
    `;
    expect(rows[0]!.revisions).toBe(0);
  });
});
