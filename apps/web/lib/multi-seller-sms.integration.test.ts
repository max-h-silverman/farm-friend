import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { createDb, type Db, type Sql } from "@farm-friend/db";
import { listPublicStands, serializePublicStand } from "./public-listing";
import { retrieveSmsListings } from "./inquiry";

/*
  F-114 Phase C.5 — SMS AND THE MAP READ THE SAME PROVIDER FACTS.

  ## The criterion

  *"Stand, seller, and item inquiries use the same provider facts and deduplicate item search
  by stand."* The first half is what this file proves; the second half is already structural —
  `groupSelectableStands` collapses every evidence voice for one stand into a single result and
  de-duplicates the matched items across them, which is what stops two sellers' eggs producing
  two results for one stand.

  ## Why SMS needs its own file

  DEVELOPMENT.md §before you ship: *"The public map or feed: it reads the SAME published records
  as SMS — web and SMS answers must agree."* They run SEPARATE QUERIES, so the map's suite
  proves nothing about SMS. Before C.5, SMS retrieval read `is_current` on the stand alone and
  built one row per stand whose `asOf` came from whichever revision the loop saw first, with
  both sellers' items piled under it. The map was fixed; SMS would have kept answering with one
  seller's date over another's goods, and every existing test would have stayed green because
  every existing fixture has one seller per stand.

  ## What "agree" means, precisely

  NOT that the two channels say the same words — they have different registers and different
  length budgets. It means neither can state a FACT the other contradicts: the same items, at
  the same stand, dated by the same seller's update.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("multi-seller SMS parity (integration)", () => {
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

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_mssms_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
        insert into seller_approvals (seller_id, approved_at)
        values (${sellerId}, ${hoursAgo(100)})
      `;
    }

    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, prices_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, address_public, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Venison Valley Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, true, false, false,
        'Vashon Hwy, Vashon WA', true, 47.4473, -122.4590
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

    // Kelsey: 3 hours ago. Zoe: 48 hours ago. The gap is the whole test — one stand-wide date
    // has to pick one, and either choice misdates the other seller's goods.
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
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("retrieves one confirmed row per SELLER, not one per stand", async () => {
    /*
      THE STRUCTURAL CHANGE. A stand-wide reader returns ONE confirmed row here; a per-provider
      one returns two. Asserting the count is what tells them apart — asserting that venison and
      salad greens are both present passes against either, because the broken reader piles both
      into the one row it built.
    */
    const rows = await retrieveSmsListings(database(), NOW, { includeTestFarms: false });
    const confirmed = rows.filter((row) => row.basis === "confirmed");

    expect(confirmed).toHaveLength(2);
    expect(confirmed.flatMap((row) => row.items.map((item) => item.itemName)).sort()).toEqual([
      "salad greens",
      "venison",
    ]);
  });

  it("dates each seller's items by that seller's own update", async () => {
    const rows = await retrieveSmsListings(database(), NOW, { includeTestFarms: false });
    const confirmed = rows.filter((row) => row.basis === "confirmed");

    const venison = confirmed.find((row) =>
      row.items.some((item) => item.itemName === "venison"),
    );
    const greens = confirmed.find((row) =>
      row.items.some((item) => item.itemName === "salad greens"),
    );

    expect(venison?.asOf.toISOString()).toBe(hoursAgo(3).toISOString());
    expect(greens?.asOf.toISOString()).toBe(hoursAgo(48).toISOString());
    // And neither carries the other's goods, which is what a collapsing reader produces.
    expect(venison?.items.map((item) => item.itemName)).toEqual(["venison"]);
    expect(greens?.items.map((item) => item.itemName)).toEqual(["salad greens"]);
  });

  it("keeps every seller's row pointing at the same stand", async () => {
    // The rows are per SELLER, but they all describe one place — which is what lets
    // `groupSelectableStands` collapse them back into one answer per stand.
    const rows = await retrieveSmsListings(database(), NOW, { includeTestFarms: false });
    const confirmed = rows.filter((row) => row.basis === "confirmed");

    expect(new Set(confirmed.map((row) => row.locationName))).toEqual(
      new Set(["Venison Valley Stand"]),
    );
    expect(new Set(confirmed.map((row) => row.publicAddress))).toEqual(
      new Set(["Vashon Hwy, Vashon WA"]),
    );
  });

  it("gives each seller's row a distinct fact id so paging cannot merge them", async () => {
    // Identity is what the pending result list stores and `MORE` replays. Two sellers sharing
    // one id would make one of them unreachable on the second page — and, worse, silently
    // replace the other's items when the list was dereferenced.
    const rows = await retrieveSmsListings(database(), NOW, { includeTestFarms: false });
    const confirmed = rows.filter((row) => row.basis === "confirmed");
    const ids = confirmed.map((row) => row.factId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("a hosted seller's standing offerings obey the same liveness rules", () => {
    /*
      THE HALF THAT WAS LEAKING. `stand_items` gained a provider in Phase B, and SMS retrieval
      still joined it on the STAND alone — so a hosted seller's usual items reached customers
      from a relationship that had ended, from an invitation nobody accepted, and from a seller
      VIGA had retired. The map closed all three when it moved to the shared reader; SMS runs
      its own SQL, and no map test says anything about it.

      Each case below builds ONE hosted seller whose only reason to be excluded is the state
      under test, so the join is the only thing that could refuse.
    */
    const usualItemsInAnswers = async (): Promise<string[]> => {
      const rows = await retrieveSmsListings(database(), NOW, { includeTestFarms: false });
      return rows
        .filter((row) => row.basis === "offering")
        .flatMap((row) => row.items.map((item) => item.itemName));
    };

    const addHostedUsualItem = async (input: {
      sellerName: string;
      itemName: string;
      lifecycleState?: "pending" | "active" | "paused";
      endedAt?: Date | null;
    }): Promise<{ sellerId: string; providerId: string }> => {
      const sellers = await sql()`
        insert into sellers (name) values (${input.sellerName}) returning id
      `;
      const sellerId = sellers[0]?.id as string;
      await sql()`
        insert into seller_approvals (seller_id, approved_at)
        values (${sellerId}, ${hoursAgo(100)})
      `;
      const state = input.lifecycleState ?? "active";
      const providers = await sql()`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
          invited_at, accepted_at, approval_source, approved_at, ended_at
        ) values (
          ${standId}, ${sellerId}, ${state}, false,
          ${hoursAgo(100)},
          ${state === "pending" ? null : hoursAgo(99)},
          ${state === "pending" ? null : "viga"},
          ${state === "pending" ? null : hoursAgo(99)},
          ${input.endedAt ?? null}
        ) returning id
      `;
      const providerId = providers[0]?.id as string;
      await sql()`
        insert into stand_items (
          sales_location_id, provider_id, display_name, usually_carried, sort_order
        ) values (${standId}, ${providerId}, ${input.itemName}, true, 0)
      `;
      return { sellerId, providerId };
    };

    const removeHosted = async (providerId: string): Promise<void> => {
      await sql()`delete from stand_items where provider_id = ${providerId}`;
      await sql()`delete from stand_providers where id = ${providerId}`;
    };

    it("answers with a live hosted seller's usual items", async () => {
      // The POSITIVE direction, and what makes the three refusals below falsifiable — without
      // it a join that returned nothing at all would pass every one of them.
      const { providerId } = await addHostedUsualItem({
        sellerName: "Live Bakery",
        itemName: "live sourdough",
      });
      expect(await usualItemsInAnswers()).toContain("live sourdough");
      await removeHosted(providerId);
    });

    it("never answers with an item from a relationship that ended", async () => {
      const { providerId } = await addHostedUsualItem({
        sellerName: "Departed Bakery",
        itemName: "departed sourdough",
        endedAt: hoursAgo(1),
      });
      expect(await usualItemsInAnswers()).not.toContain("departed sourdough");
      await removeHosted(providerId);
    });

    it("never answers with an item from an invitation nobody accepted", async () => {
      const { providerId } = await addHostedUsualItem({
        sellerName: "Unaccepted Bakery",
        itemName: "unaccepted sourdough",
        lifecycleState: "pending",
      });
      expect(await usualItemsInAnswers()).not.toContain("unaccepted sourdough");
      await removeHosted(providerId);
    });

    it("never answers with an item from a seller VIGA retired", async () => {
      const administrators = await sql()`
        insert into administrators (email, authorized_at)
        values ('board@vigavashon.org', ${hoursAgo(100)}) returning id
      `;
      const { sellerId, providerId } = await addHostedUsualItem({
        sellerName: "Retired Bakery",
        itemName: "retired sourdough",
      });
      await sql()`
        update sellers
        set retired_at = ${hoursAgo(1)},
            retired_by_administrator_id = ${administrators[0]?.id as string}
        where id = ${sellerId}
      `;
      expect(await usualItemsInAnswers()).not.toContain("retired sourdough");
      // The administrator row STAYS: the retired seller references it, and the seller stays
      // too because `sellers` is referenced by rows this fixture must not disturb. Deleting the
      // provider is enough — the item goes with it, which is what the assertion above measures.
      await removeHosted(providerId);
    });

    it("drops a PAUSED seller's standing claim, exactly as the map does", async () => {
      /*
        F-115 Tranche E (max, 2026-08-17). §hosting and approval lifecycle: *"Ending or pausing
        hides current public facts without deleting history."*

        This case asserted the opposite until F-115, on the reasoning that a pause only stops
        the prompting — the SECOND copy of that claim, the other being the stand card's. Both
        agreed, and neither was chosen: `paused` was unreachable until Tranche D built the
        writer, so nothing had ever measured what a pause does to a customer.

        The parity that matters is still the point of the case: SMS and the map must say the
        same thing about a pause, and now they say the contract's thing rather than the same
        accident twice. `provider-liveness.ts` is what makes that structural.
      */
      const { providerId } = await addHostedUsualItem({
        sellerName: "Paused Bakery",
        itemName: "paused sourdough",
        lifecycleState: "paused",
      });
      expect(await usualItemsInAnswers()).not.toContain("paused sourdough");
      await removeHosted(providerId);
    });

    it("brings that same claim BACK when the seller resumes", async () => {
      /*
        The half that keeps the case above from being satisfied by a reader that drops
        everything. Nothing is republished to get it back — the row is untouched, which is the
        *"without deleting history"* half of the same sentence.
      */
      const { providerId } = await addHostedUsualItem({
        sellerName: "Resuming Bakery",
        itemName: "resumed sourdough",
        lifecycleState: "paused",
      });
      expect(await usualItemsInAnswers()).not.toContain("resumed sourdough");
      await sql()`
        update stand_providers set lifecycle_state = 'active' where id = ${providerId}
      `;
      expect(await usualItemsInAnswers()).toContain("resumed sourdough");
      await removeHosted(providerId);
    });
  });

  it("states the same items and the same dates as the public map", async () => {
    /*
      THE PARITY ASSERTION ITSELF. Two SEPARATE queries, compared on their output.

      Not "the same words" — the two channels have different registers. What must hold is that
      neither can state a fact the other contradicts: the same items at this stand, each dated
      by the same seller's update.
    */
    const smsRows = (
      await retrieveSmsListings(database(), NOW, { includeTestFarms: false })
    ).filter((row) => row.basis === "confirmed");

    const stand = (await listPublicStands({ db: database(), clock: new FixedClock(NOW) })).find(
      (candidate) => candidate.factId === standId,
    )!;
    const payload = serializePublicStand(stand);

    const smsItems = new Set(
      smsRows.flatMap((row) => row.items.map((item) => item.itemName)),
    );
    const mapItems = new Set(payload.items.map((item) => item.itemName));
    expect(smsItems).toEqual(mapItems);

    // The DATES, per item, are the half that a stand-wide reader gets wrong while the item
    // lists still agree — so this is the assertion that actually separates the two readers.
    const smsDateByItem = new Map<string, string>();
    for (const row of smsRows) {
      for (const item of row.items) smsDateByItem.set(item.itemName, row.asOf.toISOString());
    }
    const mapDateByItem = new Map<string, string>();
    for (const seller of payload.sellers ?? []) {
      for (const item of seller.confirmedItems) {
        // The map carries a rendered sentence rather than a raw date, so the comparison is
        // against the reader's own per-seller grouping: both must attribute "venison" to the
        // fresh seller and "salad greens" to the stale one.
        mapDateByItem.set(item.itemName, seller.cardRecency ?? "");
      }
    }

    expect(smsDateByItem.get("venison")).toBe(hoursAgo(3).toISOString());
    expect(smsDateByItem.get("salad greens")).toBe(hoursAgo(48).toISOString());
    expect(mapDateByItem.get("venison")).toBe("Last updated 3 hours ago");
    expect(mapDateByItem.get("salad greens")).toBe("Last updated 2 days ago");
  });
});
