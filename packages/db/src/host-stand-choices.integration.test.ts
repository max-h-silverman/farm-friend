import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listHostStandChoices } from "./index";
import type { Db } from "./index";
import type { Sql } from "./sql";

/*
  F-117 — THE STANDS A SELF-SELECTING SELLER MAY PICK FROM.

  max settled that the host stand comes from an autocomplete of EXISTING stands, never free
  text: a typed name would be ambiguous about which stand was meant and would make the host we
  then text a guess. Picking a real stand makes the host unambiguous.

  ## What this reader is, and why it is not `listPublicStands`

  That one builds the whole map — inventory, closures, availability, payment methods, per-
  provider facts. A picker needs a name and an id, and running the map's reader to fill a
  dropdown would put every one of those joins behind a keystroke.

  ## Who may be seen

  This list is shown to a stranger mid-onboarding, so it carries the SAME visibility predicate
  the map does — `visibleFarms`, reused rather than restated. A retired stand, an unlisted one
  or a test farm appearing here would be a disclosure through a form nobody has to authenticate
  to reach, and a seller could then attach herself to a stand the public cannot see.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-117 host stand choices (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  /* `sellers_coherent_test_seller` and `sellers_coherent_retirement` each require the ACTOR
     beside the timestamp — a CHECK passes on NULL, so both are written as full disjunctions
     and a fixture setting only the date is refused. */
  let administratorId = "";

  const handle = (): Db => {
    if (!sql) throw new Error("database not initialized");
    return { sql, orm: undefined as never, close: async () => {} };
  };
  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_hostchoices_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 5 });
    const administrators = await client()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', now()) returning id
    `;
    administratorId = administrators[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await client()`truncate sellers, sales_locations restart identity cascade`;
  });

  /** The actor both take-down marks require, so a fixture states a complete fact. */
  async function markSeller(
    sellerId: string,
    column: "retired_at" | "test_seller_at",
    actorColumn: "retired_by_administrator_id" | "test_seller_by_administrator_id",
  ): Promise<void> {
    await client().unsafe(
      `update sellers set ${column} = $1, ${actorColumn} = $2 where id = $3`,
      [new Date("2026-02-01T00:00:00.000Z"), administratorId, sellerId],
    );
  }

  async function mkStand(
    name: string,
    options: { isPublic?: boolean; retired?: boolean; testFarm?: boolean } = {},
  ): Promise<{ standId: string; sellerId: string }> {
    const sellers = await client()`
      insert into sellers (name) values (${name}) returning id
    `;
    const sellerId = sellers[0]?.id as string;
    if (options.testFarm === true) {
      await markSeller(sellerId, "test_seller_at", "test_seller_by_administrator_id");
    }
    const stands = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, is_public, retired_at,
        retired_by_administrator_id, public_address, public_latitude, public_longitude
      ) values (
        ${sellerId}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable', 'produce',
        ${options.isPublic ?? true},
        ${options.retired === true ? new Date("2026-01-01T00:00:00.000Z") : null},
        ${options.retired === true ? administratorId : null}, '1 Road', 47.4473, -122.4590
      ) returning id
    `;
    return { standId: stands[0]?.id as string, sellerId };
  }

  it("returns each visible stand once, by name and id, in name order", async () => {
    await mkStand("Zephyr Stand");
    await mkStand("Anvil Stand");
    const middle = await mkStand("Mosswood Stand");

    const choices = await listHostStandChoices(handle());
    expect(choices.map((choice) => choice.name)).toEqual([
      "Anvil Stand",
      "Mosswood Stand",
      "Zephyr Stand",
    ]);
    // The id is what the seller's submission carries — a name would be ambiguous, which is the
    // whole reason this is a picker rather than a text field.
    expect(choices.find((choice) => choice.name === "Mosswood Stand")?.standId)
      .toBe(middle.standId);
  });

  it("hides a retired stand, an unlisted one, and a test farm", async () => {
    /*
      Asserted as three separate absences beside a present control, because this list is shown
      to a stranger through a form nobody authenticates to reach. Each hidden case is a
      different predicate, and a reader that dropped one would still pass a test that only
      counted rows.
    */
    await mkStand("Visible Stand");
    await mkStand("Retired Stand", { retired: true });
    await mkStand("Unlisted Stand", { isPublic: false });
    await mkStand("Test Stand", { testFarm: true });
    // A stand whose FARM was taken down. Deliberately a separate case: a farm take-down never
    // writes the stand's own `retired_at`, so a reader checking only the stand would show it.
    const downFarm = await mkStand("Down Farm Stand");
    await markSeller(downFarm.sellerId, "retired_at", "retired_by_administrator_id");

    const names = (await listHostStandChoices(handle())).map((choice) => choice.name);
    expect(names).toEqual(["Visible Stand"]);
  });

  it("includes a VENUE, which has no seller of its own", async () => {
    /*
      Morgan Hill is a stand with `own_seller_id` NULL — a place that hosts sellers and sells
      nothing itself. It is the STRONGEST case for this whole flow, and an inner join to
      `sellers` would have dropped it silently while every other test stayed green.
    */
    const stands = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
        public_address, public_latitude, public_longitude
      ) values (
        null, 'farmers_market', 'Morgan Hill', 'America/Los_Angeles', 'visitable',
        'produce', true, '9 Market Way', 47.4475, -122.4592
      ) returning id
    `;

    const choices = await listHostStandChoices(handle());
    expect(choices.map((choice) => choice.name)).toContain("Morgan Hill");
    expect(choices.find((choice) => choice.name === "Morgan Hill")?.standId)
      .toBe(stands[0]?.id as string);
  });

  it("carries no address, no contact detail and no inventory", async () => {
    // A picker needs a name. Anything else on the wire is a disclosure this surface was never
    // asked to make — and the map's own reader is where the rest belongs.
    await mkStand("Anvil Stand");
    const choices = await listHostStandChoices(handle());
    expect(Object.keys(choices[0] ?? {}).sort()).toEqual(["name", "standId"]);
    expect(JSON.stringify(choices)).not.toContain("1 Road");
    expect(JSON.stringify(choices)).not.toContain("47.4473");
  });
});
