import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchStandName } from "@farm-friend/core";
import { seedWeeklyConfirmations } from "./seed";
import type { Sql } from "./sql";

// F-062 — VIGA's weekly stock form becomes dated confirmations on the map.
//
// This is F-063's payoff and its first real consumer. A weekly submission is a genuine, dated
// statement a farmer made — so it publishes as a confirmation the customer can see and the
// staleness machinery can age — but it arrived through a Google Form, not a handset, so it
// carries `source = 'viga'` and none of the three keys that assert an authorized phone sent a
// message. Before F-063 there was no way to write this row without inventing that chain.
//
// The two guarantees asserted here are the ones that would be invisible in a unit test:
//   1. Postgres accepts the row with no handset keys — the constraint permits exactly this shape.
//   2. A FARMER'S OWN SMS WINS. A weekly row must never overwrite something newer that a farmer
//      sent, because that is the migration path off the legacy form: the moment a farmer texts,
//      their own words take over and VIGA's spreadsheet stops speaking for them.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-062 weekly confirmations (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let farmId = "";
  let locationId = "";

  // Fixture instants are offsets from a clock-derived anchor, never calendar literals (B-003).
  const T0 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const daysAfter = (days: number) => new Date(T0.getTime() + days * 86_400_000);
  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_weekly_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 1 });

    const farms = await client()`
      insert into farms (name) values ('Weekly Farm') returning id
    `;
    farmId = farms[0]?.id as string;
    const locations = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', 'Weekly Quarry Stand', 'America/Los_Angeles',
        'visitable', 'produce', '1 Weekly Way', 47.4, -122.4, false, false
      )
      returning id
    `;
    locationId = locations[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  /** The current revision for the fixture stand, with its items. */
  async function currentRevision(): Promise<
    { source: string; published_at: Date; items: string[] } | undefined
  > {
    const rows = await client()`
      select r.source, r.published_at,
        coalesce(
          (
            select array_agg(e.item_name order by e.sort_order)
            from inventory_entries e where e.inventory_revision_id = r.id
          ),
          array[]::text[]
        ) as items
      from inventory_revisions r
      where r.sales_location_id = ${locationId} and r.is_current
    `;
    return rows[0] as { source: string; published_at: Date; items: string[] } | undefined;
  }

  it("publishes a weekly submission as a confirmation Postgres accepts", async () => {
    const result = await seedWeeklyConfirmations(client(), [
      {
        standName: "Weekly Quarry Stand",
        statedOn: daysAfter(1),
        items: ["Eggs", "Salad greens", "Rhubarb"],
      },
    ]);
    expect(result.published).toBe(1);

    // Read the row back rather than trusting the write. This is the shape that was
    // unrepresentable before F-063: a real, dated confirmation with NO handset chain.
    const revision = await currentRevision();
    expect(revision?.source).toBe("viga");
    expect(revision?.items).toEqual(["Eggs", "Salad greens", "Rhubarb"]);
    expect(revision?.published_at.getTime()).toBe(daysAfter(1).getTime());

    const keys = await client()`
      select proposal_id, published_by_authorization_id, farm_approval_id
      from inventory_revisions where sales_location_id = ${locationId} and is_current
    `;
    expect(keys[0]?.proposal_id).toBeNull();
    expect(keys[0]?.published_by_authorization_id).toBeNull();
    expect(keys[0]?.farm_approval_id).toBeNull();
  });

  it("supersedes its own older weekly row rather than piling up", async () => {
    // A farm submits weekly all season. Two current revisions for one stand is a state the
    // partial unique index forbids outright, so a second run must supersede rather than insert.
    await seedWeeklyConfirmations(client(), [
      { standName: "Weekly Quarry Stand", statedOn: daysAfter(5), items: ["Tomatoes", "Basil"] },
    ]);

    const revision = await currentRevision();
    expect(revision?.items).toEqual(["Tomatoes", "Basil"]);
    expect(revision?.published_at.getTime()).toBe(daysAfter(5).getTime());

    const all = await client()`
      select count(*)::int as n from inventory_revisions
      where sales_location_id = ${locationId}
    `;
    expect(all[0]?.n).toBe(2);
    const superseded = await client()`
      select count(*)::int as n from inventory_revisions
      where sales_location_id = ${locationId} and not is_current and superseded_at is not null
    `;
    expect(superseded[0]?.n).toBe(1);
  });

  it("REFUSES to overwrite a newer fact, whatever its source", async () => {
    // THE GUARANTEE THAT MATTERS. A farmer texts their own update; then VIGA's spreadsheet is
    // re-ingested carrying last week's row. Publishing it would revert the farmer's own words to
    // a stale sheet entry — silently, and on the public map. `statedOn` is a DATE, so a weekly
    // row is also routinely older than a same-day text.
    const before = await currentRevision();
    const result = await seedWeeklyConfirmations(client(), [
      { standName: "Weekly Quarry Stand", statedOn: daysAfter(2), items: ["Stale", "Old"] },
    ]);

    expect(result.published).toBe(0);
    expect(result.skippedAsOlder).toBe(1);
    const after = await currentRevision();
    expect(after?.items).toEqual(before?.items);
    expect(after?.published_at.getTime()).toBe(before?.published_at.getTime());
  });

  it("reports a stand it cannot find instead of inventing one", async () => {
    // The weekly form carries farm names that match no seeded stand. Silently dropping them
    // makes a farmer's submission disappear with no trace for anyone to act on.
    const result = await seedWeeklyConfirmations(client(), [
      { standName: "No Such Farm", statedOn: daysAfter(9), items: ["Kale"] },
    ]);
    expect(result.published).toBe(0);
    expect(result.unknownStands).toEqual(["No Such Farm"]);
  });

  describe("a farm naming itself differently in the weekly form (F-062)", () => {
    // Farmers do not retype their full listing name every week. Three of the 2026 weekly farms
    // reached NO stand under an exact key — each a real submission that reached nobody — and max
    // confirmed all three are the same farms under a different spelling.

    it("resolves a name that is a word-prefix of exactly one stand, and says so", async () => {
      // The real shape: "Venison Valley Farm" for "Venison Valley Farm & Creamery" — the farmer
      // dropped the trailing words. The fixture stand keys to "weekly quarry", so "Weekly" alone
      // is a strict word-prefix and cannot match by the exact key.
      const result = await seedWeeklyConfirmations(client(), [
        { standName: "Weekly", statedOn: daysAfter(20), items: ["Prefix matched"] },
      ]);

      expect(result.published).toBe(1);
      expect(result.unknownStands).toEqual([]);
      // Reported, never silent: a submission landing on the wrong farm's card is the failure
      // this matching design exists to prevent.
      expect(result.resolvedByOtherName).toEqual([
        { stated: "Weekly", resolvedTo: "Weekly Quarry Stand" },
      ]);
      expect((await currentRevision())?.items).toEqual(["Prefix matched"]);
    });

    it("resolves a stated former name, which no spelling rule could reach", async () => {
      // "Maggie's Farm" and "Green Ears" share not one character. The profile form states the
      // rename in the farmer's own words, so it is read from data rather than hard-coded.
      const result = await seedWeeklyConfirmations(
        client(),
        [{ standName: "Maggie's Farm", statedOn: daysAfter(25), items: ["Renamed"] }],
        {
          formerNames: new Map([
            [matchStandName("Maggie's Farm"), matchStandName("Weekly Quarry Stand")],
          ]),
        },
      );

      expect(result.published).toBe(1);
      expect(result.resolvedByOtherName).toEqual([
        { stated: "Maggie's Farm", resolvedTo: "Weekly Quarry Stand" },
      ]);
      expect((await currentRevision())?.items).toEqual(["Renamed"]);
    });

    it("still reports a genuinely unknown farm rather than forcing a match", async () => {
      const result = await seedWeeklyConfirmations(client(), [
        { standName: "Somewhere Else Entirely", statedOn: daysAfter(26), items: ["Kale"] },
      ]);
      expect(result.published).toBe(0);
      expect(result.unknownStands).toEqual(["Somewhere Else Entirely"]);
      expect(result.resolvedByOtherName).toEqual([]);
    });
  });

  it("writes nothing at all for an empty submission list", async () => {
    const before = await client()`
      select count(*)::int as n from inventory_revisions where sales_location_id = ${locationId}
    `;
    const result = await seedWeeklyConfirmations(client(), []);
    expect(result.published).toBe(0);
    const after = await client()`
      select count(*)::int as n from inventory_revisions where sales_location_id = ${locationId}
    `;
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
