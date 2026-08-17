import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { createDb, type Db, type Sql } from "@farm-friend/db";
import { listPublicStands, serializePublicStand } from "./public-listing";
import { standCardSections } from "./stand-card";
import { standListingLines } from "./map-view";

/*
  F-114 Phase C.5 — WHAT A CUSTOMER SEES WHEN TWO SELLERS SHARE A STAND.

  This is the surface test. `stand-provider-facts.integration.test.ts` proves the reader; this
  proves that the public map's payload actually carries what the reader returns, and that the
  card built from it says the right thing.

  ## Why a surface test and not only a reader test

  DEVELOPMENT.md §gotchas: *"A test that asserts through the ADMIN reader proves nothing about
  what customers see."* The same applies one level down — a correct reader wired into nothing,
  or wired in beside the old stand-wide query, leaves the map exactly as wrong as before with
  the reader's own suite fully green. So every assertion here goes through `listPublicStands`
  and `serializePublicStand`, which is what the page and `GET /api/public/stands` both call.

  ## The fixture

  Venison Valley Stand: Kelsey's own listing (venison, confirmed recently) and Gracie's Greens
  hosted beside it (salad greens, confirmed three weeks ago, and one usual item nobody has
  confirmed). Two sellers, two prices, two freshnesses — the shape every collapsing bug shows
  up in.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("multi-seller public surface (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let standId = "";
  let hostSellerId = "";
  let hostProviderId = "";
  let guestSellerId = "";
  let guestProviderId = "";

  const NOW = new Date("2026-08-16T18:00:00Z");
  const hoursAgo = (hours: number): Date =>
    new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;
  const deps = () => ({ db: database(), clock: new FixedClock(NOW) });

  const publish = async (input: {
    providerId: string;
    sellerId: string;
    publishedAt: Date;
    items: { itemName: string; priceText?: string }[];
  }): Promise<void> => {
    const revisions = await sql()`
      insert into inventory_revisions (
        sales_location_id, provider_id, seller_id, published_at, is_current, source
      ) values (
        ${standId}, ${input.providerId}, ${input.sellerId},
        ${input.publishedAt}, true, 'viga'
      ) returning id
    `;
    const revisionId = revisions[0]?.id as string;
    let sortOrder = 0;
    for (const item of input.items) {
      await sql()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, price_text, sort_order
        ) values (
          ${revisionId}, ${standId}, ${item.itemName}, ${item.priceText ?? null}, ${sortOrder}
        )
      `;
      sortOrder += 1;
    }
  };

  const findStand = async () => {
    const stands = await listPublicStands(deps());
    const stand = stands.find((candidate) => candidate.factId === standId);
    expect(stand).toBeDefined();
    return serializePublicStand(stand!);
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_multiseller_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const sellers = await sql()`
      insert into sellers (name) values ('Venison Valley'), ('Gracies Greens')
      returning id, name
    `;
    hostSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    guestSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;
    for (const sellerId of [hostSellerId, guestSellerId]) {
      await sql()`
        insert into seller_approvals (seller_id, approved_at) values (${sellerId}, ${hoursAgo(100)})
      `;
    }

    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, prices_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Venison Valley Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, true, false, false,
        'Vashon Hwy, Vashon WA', 47.4473, -122.4590
      ) returning id
    `;
    standId = locations[0]?.id as string;

    const own = await sql()`
      select id from stand_providers
      where sales_location_id = ${standId} and seller_id = ${hostSellerId}
    `;
    hostProviderId = own[0]?.id as string;

    const guest = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standId}, ${guestSellerId}, 'active', false,
        ${hoursAgo(100)}, ${hoursAgo(99)}, 'viga', ${hoursAgo(99)}
      ) returning id
    `;
    guestProviderId = guest[0]?.id as string;

    // Kelsey confirmed venison three hours ago; Zoe confirmed salad greens two days ago. The
    // gap is the point: a stand-wide timestamp has to pick one and dates the other wrongly.
    await publish({
      providerId: hostProviderId,
      sellerId: hostSellerId,
      publishedAt: hoursAgo(3),
      items: [{ itemName: "venison", priceText: "$14/lb" }],
    });
    await publish({
      providerId: guestProviderId,
      sellerId: guestSellerId,
      publishedAt: hoursAgo(48),
      items: [{ itemName: "salad greens", priceText: "$5" }],
    });

    // A standing claim nobody has confirmed — the hosted seller's public-on-approval case.
    await sql()`
      insert into stand_items (
        sales_location_id, provider_id, display_name, usually_carried,
        price_amount, price_quantity, price_unit, price_basis, sort_order
      ) values (
        ${standId}, ${guestProviderId}, 'rhubarb', true, '4.00', '1', 'bunch', 'per', 0
      )
    `;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("carries every seller onto the served payload", async () => {
    const payload = await findStand();
    expect(payload.sellers?.map((s) => s.sellerName)).toEqual([
      "Venison Valley",
      "Gracies Greens",
    ]);
  });

  it("dates each seller's goods by that seller's own update", async () => {
    /*
      THE CASE THE WHOLE PHASE EXISTS FOR.

      Kelsey confirmed 3 hours ago; Zoe confirmed 2 days ago. A payload built from the
      stand-wide `is_current` join carries ONE recency for both, and whichever it picks makes
      the other seller's goods look fresher or staler than they are. Asserting the two
      DIFFERENT strings is what a collapsing reader cannot satisfy.
    */
    const payload = await findStand();
    const host = payload.sellers?.find((s) => s.sellerName === "Venison Valley");
    const guest = payload.sellers?.find((s) => s.sellerName === "Gracies Greens");

    expect(host?.cardRecency).toBe("Last updated 3 hours ago");
    expect(guest?.cardRecency).toBe("Last updated 2 days ago");
    expect(host?.cardRecency).not.toBe(guest?.cardRecency);
  });

  it("keeps each seller's items and prices with that seller", async () => {
    const payload = await findStand();
    const host = payload.sellers?.find((s) => s.sellerName === "Venison Valley");
    const guest = payload.sellers?.find((s) => s.sellerName === "Gracies Greens");

    expect(host?.confirmedItems.map((i) => i.itemName)).toEqual(["venison"]);
    expect(host?.confirmedItems[0]?.priceText).toBe("$14/lb");
    expect(guest?.confirmedItems.map((i) => i.itemName)).toEqual(["salad greens"]);
    expect(guest?.confirmedItems[0]?.priceText).toBe("$5");
    // And the ABSENCE of the other seller's goods, which is what a leak would show.
    expect(host?.confirmedItems.map((i) => i.itemName)).not.toContain("salad greens");
    expect(guest?.confirmedItems.map((i) => i.itemName)).not.toContain("venison");
  });

  it("marks only the stand's own seller by the self-pointer", async () => {
    const payload = await findStand();
    expect(
      payload.sellers?.map((s) => [s.sellerName, s.describesOwnStand]),
    ).toEqual([
      ["Venison Valley", true],
      ["Gracies Greens", false],
    ]);
  });

  it("publishes a hosted seller's usual item with a price and no date", async () => {
    const payload = await findStand();
    const guest = payload.sellers?.find((s) => s.sellerName === "Gracies Greens");
    expect(guest?.usualItems).toEqual([{ itemName: "rhubarb", priceText: "$4 / bunch" }]);
    // The type gives a usual item nowhere to carry a date. Asserted as an exact object so a
    // future field that could read as one fails here rather than reaching a customer.
  });

  it("builds an item-first card from the served payload", async () => {
    const sections = standCardSections(await findStand());
    const confirmed = sections.find((s) => s.register === "confirmed");

    expect(confirmed?.items.map((i) => i.itemName)).toEqual(["venison", "salad greens"]);
    // Each item once, each with exactly the sellers that support it.
    expect(confirmed?.items[0]?.providers.map((p) => p.credit)).toEqual([undefined]);
    expect(confirmed?.items[1]?.providers.map((p) => p.credit)).toEqual(["Gracies Greens"]);

    const usual = sections.find((s) => s.register === "usual");
    expect(usual?.items.map((i) => i.itemName)).toEqual(["rhubarb"]);
    expect(usual?.items[0]?.providers[0]?.recency).toBeUndefined();
  });

  it("nests both sellers under one item when they carry the same thing", async () => {
    // The three-duplicate-Tomatoes case, on the real surface. Written as its own provider so
    // it does not perturb the fixture the other cases assert against.
    // Supersede FIRST: `inventory_revisions_one_current_per_provider` is a unique index, so a
    // second current revision for one provider is refused rather than accepted and reconciled.
    await sql()`
      update inventory_revisions set is_current = false, superseded_at = ${hoursAgo(2)}
      where provider_id = ${hostProviderId} and is_current
    `;
    await publish({
      providerId: hostProviderId,
      sellerId: hostSellerId,
      publishedAt: hoursAgo(2),
      items: [{ itemName: "eggs", priceText: "$8" }],
    });
    await sql()`
      update inventory_revisions set is_current = false, superseded_at = ${hoursAgo(1)}
      where provider_id = ${guestProviderId} and is_current
    `;
    await publish({
      providerId: guestProviderId,
      sellerId: guestSellerId,
      publishedAt: hoursAgo(1),
      items: [{ itemName: "eggs", priceText: "$7" }],
    });

    const sections = standCardSections(await findStand());
    const confirmed = sections.find((s) => s.register === "confirmed");

    expect(confirmed?.items).toHaveLength(1);
    expect(confirmed?.items[0]?.itemName).toBe("eggs");
    expect(confirmed?.items[0]?.providers.map((p) => p.priceText)).toEqual(["$8", "$7"]);
    expect(confirmed?.items[0]?.providers.map((p) => p.credit)).toEqual([
      undefined,
      "Gracies Greens",
    ]);
    // Two sellers, two freshnesses, one row.
    expect(confirmed?.items[0]?.providers.map((p) => p.recency)).toEqual([
      "Last updated 2 hours ago",
      "Last updated 1 hour ago",
    ]);
  });

  it("keeps the stand-wide item list agreeing with the per-seller one", async () => {
    /*
      WEB AND SMS MUST AGREE (DEVELOPMENT.md §before you ship). `items` is what the compact card
      and every SMS-parity surface read; `sellers` is what the detail card reads. They are two
      shapes of one fact, and this is the assertion that keeps them from becoming two facts.
    */
    const payload = await findStand();
    // The VOCABULARY must agree, not the multiplicity: two sellers carrying eggs is one entry
    // stand-wide and two nested lines, which is the whole point of the split. What must never
    // happen is an item in one shape and absent from the other.
    const fromSellers = new Set(
      (payload.sellers ?? []).flatMap((seller) =>
        seller.confirmedItems.map((item) => item.itemName),
      ),
    );
    expect(new Set(payload.items.map((item) => item.itemName))).toEqual(fromSellers);
    // And the stand-wide list prints each name ONCE, however many sellers carry it — a
    // duplicate here is the "three Tomatoes rows" defect wearing the compact card's clothes.
    expect(payload.items.map((item) => item.itemName)).toEqual([...fromSellers]);

    // The sentence-shaped lines the SMS surfaces share render the same vocabulary.
    const confirmedLine = standListingLines(payload).find(
      (line) => line.kind === "confirmed",
    );
    expect(new Set(confirmedLine?.items ?? [])).toEqual(fromSellers);
  });
});
