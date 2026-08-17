import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, listPublicSellers, type Db, type Sql } from "./index";

/*
  F-114 Phase C.5 — THE SELLER LIST.

  ## Why this exists at all

  §customer behavior: *"The seller list survived an over-engineering cut and is **not** optional.
  A hosted-only seller — one who sells exclusively at other people's stands, like a bakery with
  no stand of its own — has no pin and no stand card of its own. The seller list is that
  seller's ONLY discovery path, so it carries search and shows where each seller is currently
  selling. Without it, naming hosted sellers in public output credits them without making them
  findable."*

  That is the case every assertion here is aimed at: a seller with no `sales_locations` row of
  their own must appear, with the stands they actually sell at named beneath them.

  ## The two groupings are one reader

  Stand detail groups by ITEM with sellers nested; seller detail groups by STAND with that
  seller's items nested. This is the second grouping, and it reads the same provider rows —
  which is what makes "the same facts, two views" true rather than promised.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("public seller list (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let hostSellerId = "";
  let hostStandId = "";
  /** The case this list exists for: sells only at other people's stands. */
  let bakerySellerId = "";
  /** A second stand, so the bakery is at two and the ordering is testable. */
  let secondStandId = "";
  let secondSellerId = "";
  let administratorId = "";

  const T0 = new Date("2026-08-16T12:00:00Z");
  const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60 * 1000);
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  const createSeller = async (name: string): Promise<string> => {
    const rows = await sql()`insert into sellers (name) values (${name}) returning id`;
    const sellerId = rows[0]?.id as string;
    await sql()`
      insert into seller_approvals (seller_id, approved_at) values (${sellerId}, ${at(0)})
    `;
    return sellerId;
  };

  const createStand = async (input: {
    ownSellerId: string;
    name: string;
  }): Promise<string> => {
    const rows = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, prices_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${input.ownSellerId}, 'farm_stand', ${input.name}, 'America/Los_Angeles',
        'visitable', 'produce', true, true, false, false,
        'Vashon Hwy, Vashon WA', 47.4473, -122.4590
      ) returning id
    `;
    return rows[0]?.id as string;
  };

  const addProvider = async (input: {
    locationId: string;
    sellerId: string;
    lifecycleState?: "pending" | "active" | "paused";
    endedAt?: Date | null;
  }): Promise<string> => {
    const state = input.lifecycleState ?? "active";
    const rows = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at, ended_at
      ) values (
        ${input.locationId}, ${input.sellerId}, ${state}, false,
        ${at(0)},
        ${state === "pending" ? null : at(0)},
        ${state === "pending" ? null : "viga"},
        ${state === "pending" ? null : at(0)},
        ${input.endedAt ?? null}
      ) returning id
    `;
    return rows[0]?.id as string;
  };

  const addUsualItem = async (input: {
    providerId: string;
    locationId: string;
    displayName: string;
  }): Promise<void> => {
    await sql()`
      insert into stand_items (
        sales_location_id, provider_id, display_name, usually_carried, sort_order
      ) values (${input.locationId}, ${input.providerId}, ${input.displayName}, true, 0)
    `;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_pubsellers_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${at(0)}) returning id
    `;
    administratorId = administrators[0]?.id as string;

    hostSellerId = await createSeller("Venison Valley");
    hostStandId = await createStand({
      ownSellerId: hostSellerId,
      name: "Venison Valley Stand",
    });
    secondSellerId = await createSeller("Aardvark Acres");
    secondStandId = await createStand({
      ownSellerId: secondSellerId,
      name: "Aardvark Stand",
    });

    // THE CASE. Fernhorn has no stand of its own; it sells at both of the others.
    bakerySellerId = await createSeller("Fernhorn Bakery");
    const atHost = await addProvider({
      locationId: hostStandId,
      sellerId: bakerySellerId,
    });
    const atSecond = await addProvider({
      locationId: secondStandId,
      sellerId: bakerySellerId,
    });
    await addUsualItem({
      providerId: atHost,
      locationId: hostStandId,
      displayName: "sourdough",
    });
    await addUsualItem({
      providerId: atSecond,
      locationId: secondStandId,
      displayName: "cinnamon rolls",
    });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("lists a hosted-only seller, which has no stand and no pin of its own", async () => {
    // THE HEADLINE CASE. Fernhorn owns no `sales_locations` row, so it appears on no map and
    // has no card. Absent from this list it would be credited on other people's cards and
    // findable nowhere — the exact failure the over-engineering cut was reversed to prevent.
    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    const bakery = sellers.find((seller) => seller.sellerId === bakerySellerId);

    expect(bakery).toBeDefined();
    expect(bakery?.sellerName).toBe("Fernhorn Bakery");
    expect(bakery?.ownsAStand).toBe(false);
  });

  it("names every stand a seller is currently selling at", async () => {
    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    const bakery = sellers.find((seller) => seller.sellerId === bakerySellerId);

    expect(bakery?.sellingAt.map((stand) => stand.locationName)).toEqual([
      "Aardvark Stand",
      "Venison Valley Stand",
    ]);
    // The stand IDs travel too, so the list can link to the pin on the map.
    expect(bakery?.sellingAt.map((stand) => stand.salesLocationId).sort()).toEqual(
      [hostStandId, secondStandId].sort(),
    );
  });

  it("marks a seller that runs its own stand, and names that stand", async () => {
    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    const host = sellers.find((seller) => seller.sellerId === hostSellerId);

    expect(host?.ownsAStand).toBe(true);
    expect(host?.sellingAt.map((stand) => stand.locationName)).toEqual([
      "Venison Valley Stand",
    ]);
    // The self-pointer travels per STAND, not per seller: a seller can own one stand and be a
    // guest at another, and the list has to say which is which.
    expect(host?.sellingAt.map((stand) => stand.describesOwnStand)).toEqual([true]);
  });

  it("carries each seller's items at each stand, for the search haystack", async () => {
    // §customer behavior — the list "carries search". A customer looking for sourdough must
    // find Fernhorn, and the vocabulary that makes that possible is the items themselves.
    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    const bakery = sellers.find((seller) => seller.sellerId === bakerySellerId);

    const byStand = new Map(
      (bakery?.sellingAt ?? []).map((stand) => [stand.locationName, stand]),
    );
    expect(byStand.get("Venison Valley Stand")?.usualItems.map((i) => i.itemName)).toEqual([
      "sourdough",
    ]);
    expect(byStand.get("Aardvark Stand")?.usualItems.map((i) => i.itemName)).toEqual([
      "cinnamon rolls",
    ]);
    // The two stands' items must NOT be pooled: a customer told Fernhorn has sourdough at
    // Aardvark would drive to the wrong stand.
    expect(byStand.get("Aardvark Stand")?.usualItems.map((i) => i.itemName)).not.toContain(
      "sourdough",
    );
  });

  it("says no seller at a VENUE owns the stand", async () => {
    /*
      THE VENUE. `own_seller_id` is NULL, so no provider here is the stand.

      MEASURED, NOT ASSUMED: swapping `is not distinct from` for a plain `=` does NOT fail this
      case on its own, because Postgres returns NULL and the reader's `=== true` normalizes it.
      The two are belt and braces over the same hazard, and this case catches the PAIR — with
      the coercion also relaxed to `?? true`, it fails. That is the real defect shape: a NULL
      travelling as "this is the stand's own", which suppresses a hosted seller's credit on the
      public card. The SQL form is kept because it makes the column a genuine boolean, so no
      later reader can be handed a NULL to interpret in the first place.
    */
    const venueId = (
      await sql()`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          is_public, prices_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          null, 'farm_stand', 'Morgan Hill Community Stand', 'America/Los_Angeles',
          'visitable', 'produce', true, true, false, false,
          'Vashon Hwy, Vashon WA', 47.4473, -122.4590
        ) returning id
      `
    )[0]?.id as string;
    const providerId = await addProvider({
      locationId: venueId,
      sellerId: bakerySellerId,
    });

    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    const venueStand = sellers
      .find((seller) => seller.sellerId === bakerySellerId)
      ?.sellingAt.find((stand) => stand.salesLocationId === venueId);

    expect(venueStand).toBeDefined();
    // A strict boolean false, not a null or an undefined: the card's suppression rule reads
    // this, and a nullish value there would suppress the credit for a hosted seller.
    expect(venueStand?.describesOwnStand).toBe(false);

    await sql()`delete from stand_providers where id = ${providerId}`;
    await sql()`delete from sales_locations where id = ${venueId}`;
  });

  it("leaves out an item the seller does not usually carry", async () => {
    // F-066 — a `stand_items` row exists for every name a past revision used. Without the
    // predicate the list would tell a customer a seller "usually" has something nobody said
    // that about. Two items on ONE provider, identical but for the flag, so the predicate is
    // the only thing that could refuse.
    const providerId = (
      await sql()`
        select p.id from stand_providers p
        where p.sales_location_id = ${hostStandId} and p.seller_id = ${bakerySellerId}
      `
    )[0]?.id as string;
    await sql()`
      insert into stand_items (
        sales_location_id, provider_id, display_name, usually_carried, sort_order
      ) values (${hostStandId}, ${providerId}, 'one-off scones', false, 9)
    `;

    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    const atHost = sellers
      .find((seller) => seller.sellerId === bakerySellerId)
      ?.sellingAt.find((stand) => stand.salesLocationId === hostStandId);

    expect(atHost?.usualItems.map((item) => item.itemName)).toEqual(["sourdough"]);
    expect(atHost?.usualItems.map((item) => item.itemName)).not.toContain("one-off scones");

    await sql()`
      delete from stand_items
      where provider_id = ${providerId} and display_name = 'one-off scones'
    `;
  });

  it("orders sellers by name", async () => {
    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    const names = sellers.map((seller) => seller.sellerName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain("Fernhorn Bakery");
  });

  it("omits a seller whose only relationship is pending", async () => {
    // An invitation nobody has accepted lists nobody — the same rule every public reader obeys.
    // Its own stand is the ONLY thing that could otherwise put it in this list, so the seller
    // is built with none.
    const invitedSellerId = await createSeller("Never Answered");
    const providerId = await addProvider({
      locationId: hostStandId,
      sellerId: invitedSellerId,
      lifecycleState: "pending",
    });

    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    expect(sellers.map((seller) => seller.sellerId)).not.toContain(invitedSellerId);

    await sql()`delete from stand_providers where id = ${providerId}`;
  });

  it("omits a seller whose relationships have all ended", async () => {
    const departedSellerId = await createSeller("Moved Away");
    const providerId = await addProvider({
      locationId: hostStandId,
      sellerId: departedSellerId,
      endedAt: at(500),
    });

    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    expect(sellers.map((seller) => seller.sellerId)).not.toContain(departedSellerId);

    await sql()`delete from stand_providers where id = ${providerId}`;
  });

  it("drops only the ended stand from a seller who still sells elsewhere", async () => {
    /*
      The case that makes the rule above falsifiable in the right direction. A reader that
      excluded a SELLER because one of their relationships ended would erase Fernhorn from the
      island the first time one host stopped carrying them.
    */
    const thirdSellerId = await createSeller("Third Stand Farm");
    const thirdStandId = await createStand({
      ownSellerId: thirdSellerId,
      name: "Third Stand",
    });
    const endedProviderId = await addProvider({
      locationId: thirdStandId,
      sellerId: bakerySellerId,
      endedAt: at(500),
    });

    const sellers = await listPublicSellers(database(), { includeTestSellers: false });
    const bakery = sellers.find((seller) => seller.sellerId === bakerySellerId);

    expect(bakery).toBeDefined();
    expect(bakery?.sellingAt.map((stand) => stand.locationName)).not.toContain("Third Stand");
    expect(bakery?.sellingAt.map((stand) => stand.locationName)).toEqual([
      "Aardvark Stand",
      "Venison Valley Stand",
    ]);

    await sql()`delete from stand_providers where id = ${endedProviderId}`;
  });

  it("hides a test seller unless the viewer asked for one", async () => {
    const testSellerId = await createSeller("Test Bakery");
    await sql()`
      update sellers
      set test_seller_at = ${at(0)}, test_seller_by_administrator_id = ${administratorId}
      where id = ${testSellerId}
    `;
    const providerId = await addProvider({
      locationId: hostStandId,
      sellerId: testSellerId,
    });

    const ordinary = await listPublicSellers(database(), { includeTestSellers: false });
    expect(ordinary.map((seller) => seller.sellerId)).not.toContain(testSellerId);

    const deliberate = await listPublicSellers(database(), { includeTestSellers: true });
    expect(deliberate.map((seller) => seller.sellerId)).toContain(testSellerId);

    await sql()`delete from stand_providers where id = ${providerId}`;
  });

  it("hides a seller VIGA retired, from every viewer", async () => {
    const retiredSellerId = await createSeller("Retired Bakery");
    const providerId = await addProvider({
      locationId: hostStandId,
      sellerId: retiredSellerId,
    });

    const before = await listPublicSellers(database(), { includeTestSellers: false });
    expect(before.map((seller) => seller.sellerId)).toContain(retiredSellerId);

    await sql()`
      update sellers
      set retired_at = ${at(0)}, retired_by_administrator_id = ${administratorId}
      where id = ${retiredSellerId}
    `;

    const after = await listPublicSellers(database(), { includeTestSellers: false });
    expect(after.map((seller) => seller.sellerId)).not.toContain(retiredSellerId);
    // `?hidden=true` is authority over FAKE sellers, never over a real farm VIGA took down.
    const deliberate = await listPublicSellers(database(), { includeTestSellers: true });
    expect(deliberate.map((seller) => seller.sellerId)).not.toContain(retiredSellerId);

    await sql()`delete from stand_providers where id = ${providerId}`;
  });

  it("omits a stand VIGA retired from a seller who still sells at it", async () => {
    // The stand-level twin of the rule above. A retired stand leaves the map, so listing it
    // here would send a customer to a place the map cannot show them.
    const quietSellerId = await createSeller("Quiet Corner Farm");
    const quietStandId = await createStand({
      ownSellerId: quietSellerId,
      name: "Quiet Corner Stand",
    });
    const providerId = await addProvider({
      locationId: quietStandId,
      sellerId: bakerySellerId,
    });

    const before = await listPublicSellers(database(), { includeTestSellers: false });
    expect(
      before
        .find((seller) => seller.sellerId === bakerySellerId)
        ?.sellingAt.map((stand) => stand.locationName),
    ).toContain("Quiet Corner Stand");

    await sql()`update sales_locations
      set retired_at = ${at(0)}, retired_by_administrator_id = ${administratorId}
      where id = ${quietStandId}`;

    const after = await listPublicSellers(database(), { includeTestSellers: false });
    expect(
      after
        .find((seller) => seller.sellerId === bakerySellerId)
        ?.sellingAt.map((stand) => stand.locationName),
    ).not.toContain("Quiet Corner Stand");

    await sql()`delete from stand_providers where id = ${providerId}`;
    await sql()`delete from sales_locations where id = ${quietStandId}`;
  });

  it("omits a stand the farmer has taken off the public map", async () => {
    // `is_public` is the farmer's own switch, and it is a different fact from VIGA's
    // `retired_at`. Both must bite, and each needs its own case: a reader filtering only one
    // passes the other's test.
    const privateSellerId = await createSeller("Private Farm");
    const privateStandId = await createStand({
      ownSellerId: privateSellerId,
      name: "Private Stand",
    });
    const providerId = await addProvider({
      locationId: privateStandId,
      sellerId: bakerySellerId,
    });

    const before = await listPublicSellers(database(), { includeTestSellers: false });
    expect(
      before
        .find((seller) => seller.sellerId === bakerySellerId)
        ?.sellingAt.map((stand) => stand.locationName),
    ).toContain("Private Stand");

    await sql()`update sales_locations set is_public = false where id = ${privateStandId}`;

    const after = await listPublicSellers(database(), { includeTestSellers: false });
    expect(
      after
        .find((seller) => seller.sellerId === bakerySellerId)
        ?.sellingAt.map((stand) => stand.locationName),
    ).not.toContain("Private Stand");

    await sql()`delete from stand_providers where id = ${providerId}`;
    await sql()`delete from sales_locations where id = ${privateStandId}`;
  });
});
