import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, readStandProviderFacts, type Db, type Sql } from "./index";

/*
  F-114 Phase C.5 — THE PUBLIC READER, PER PROVIDER.

  ## What this seam is for

  The public map, SMS retrieval and the seller list all have to answer the same question after
  Phase B: *at this stand, what does each seller currently claim, and how fresh is each claim?*
  Before C.5 all three read `is_current` keyed on `sales_location_id` alone — the Phase A shape,
  correct while every stand had exactly one seller and silently wrong the moment one has two:
  the entries of several providers' revisions arrive interleaved under one stand-wide
  `published_at`, so one seller's goods are dated by another seller's update and nothing errors.

  ## Why the negatives carry the weight here

  A test that shows two sellers' items coming back would pass against exactly that broken
  reader — the items ARE all there, they are simply misattributed. So every case below asserts
  WHICH provider each item and each timestamp belongs to, and the two-seller cases use
  DIFFERENT publication times on purpose: a reader that collapsed them would have to pick one,
  and picking either fails.

  ## The registers stay apart

  §customer behavior: unknown, usual and current are never collapsed. A hosted seller is public
  on approval on standing claims alone, so `usualItems` must come back for a provider that has
  confirmed nothing at all — and that provider must NOT acquire a `publishedAt` from anywhere.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("stand provider facts (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  /** Venison Valley: a stand with its own seller AND a hosted one. The main case. */
  let standId = "";
  let hostSellerId = "";
  let hostProviderId = "";
  let guestSellerId = "";
  let guestProviderId = "";

  /** Morgan Hill: a VENUE — `own_seller_id` is null, so no provider is the stand. */
  let venueId = "";
  let venueGuestProviderId = "";
  let venueGuestSellerId = "";

  /**
   * VIGA's one fixed operator identity.
   *
   * `sellers_coherent_test_seller` and `sellers_coherent_retirement` are both full
   * disjunctions — the marker and the administrator who set it move together or not at all —
   * so the two visibility cases cannot mark a seller without a real operator row to name.
   */
  let administratorId = "";

  const T0 = new Date("2026-08-16T12:00:00Z");
  const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60 * 1000);
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  /**
   * Publish one provider's current revision directly.
   *
   * The two-step proposal path is exercised by `per-provider-publication`; what this file tests
   * is the READER, so the rows are written directly and the assertions are about how they come
   * back out. Writing them through the writer would make a reader defect look like a writer
   * defect.
   */
  const publish = async (input: {
    providerId: string;
    sellerId: string;
    locationId: string;
    publishedAt: Date;
    items: { itemName: string; priceText?: string; quantity?: number }[];
  }): Promise<string> => {
    // `source = 'viga'` is the one arm of `inventory_revisions_source_keys_coherent` that needs
    // no proposal, authorization or approval — and none of those is what this file tests. A
    // handset-sourced fixture would carry three extra rows per revision whose only purpose is
    // satisfying a constraint about provenance the READER does not read.
    const revisions = await sql()`
      insert into inventory_revisions (
        sales_location_id, provider_id, seller_id, published_at, is_current, source
      ) values (
        ${input.locationId}, ${input.providerId}, ${input.sellerId},
        ${input.publishedAt}, true, 'viga'
      ) returning id
    `;
    const revisionId = revisions[0]?.id as string;
    let sortOrder = 0;
    for (const item of input.items) {
      await sql()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, price_text, quantity, sort_order
        ) values (
          ${revisionId}, ${input.locationId}, ${item.itemName},
          ${item.priceText ?? null}, ${item.quantity ?? null}, ${sortOrder}
        )
      `;
      sortOrder += 1;
    }
    return revisionId;
  };

  const addUsualItem = async (input: {
    providerId: string;
    locationId: string;
    displayName: string;
    priceAmount?: string;
    priceQuantity?: string;
    priceUnit?: string;
    priceBasis?: "per" | "for";
    sortOrder?: number;
  }): Promise<void> => {
    await sql()`
      insert into stand_items (
        sales_location_id, provider_id, display_name, usually_carried,
        price_amount, price_quantity, price_unit, price_basis, sort_order
      ) values (
        ${input.locationId}, ${input.providerId}, ${input.displayName}, true,
        ${input.priceAmount ?? null}, ${input.priceQuantity ?? null},
        ${input.priceUnit ?? null}, ${input.priceBasis ?? null}, ${input.sortOrder ?? 0}
      )
    `;
  };

  const createSeller = async (name: string): Promise<string> => {
    const rows = await sql()`insert into sellers (name) values (${name}) returning id`;
    const sellerId = rows[0]?.id as string;
    await sql()`
      insert into seller_approvals (seller_id, approved_at) values (${sellerId}, ${at(0)})
    `;
    return sellerId;
  };

  const createStand = async (input: {
    ownSellerId: string | null;
    name: string;
  }): Promise<string> => {
    const rows = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${input.ownSellerId}, 'farm_stand', ${input.name}, 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        'Vashon Hwy, Vashon WA', 47.4473, -122.4590
      ) returning id
    `;
    const locationId = rows[0]?.id as string;
    // `prices_public` is NOT NULL DEFAULT **false** — a farmer opts in to showing prices. The
    // fixture opts in explicitly so the price cases test the renderer rather than the default,
    // and the one case that turns it off does so visibly.
    await sql()`update sales_locations set prices_public = true where id = ${locationId}`;
    return locationId;
  };

  /**
   * Remove a provider that has published NOTHING, so later cases see the fixture they expect.
   *
   * **A provider that has published cannot be removed at all, and must not be.**
   * `guard_inventory_revision_history` and its entry twin refuse every delete: published
   * inventory is immutable, which is a Golden Rule #1 protection rather than an inconvenience.
   * So a case that publishes builds its OWN stand and simply leaves it standing — the shared
   * fixture is never touched, and nothing has to be walked back.
   */
  const removeUnpublishedProvider = async (providerId: string): Promise<void> => {
    await sql()`delete from stand_items where provider_id = ${providerId}`;
    await sql()`delete from stand_providers where id = ${providerId}`;
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

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_provfacts_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
    guestSellerId = await createSeller("Gracies Greens");
    standId = await createStand({ ownSellerId: hostSellerId, name: "Venison Valley Stand" });
    const own = await sql()`
      select id from stand_providers
      where sales_location_id = ${standId} and seller_id = ${hostSellerId}
    `;
    hostProviderId = own[0]?.id as string;
    guestProviderId = await addProvider({ locationId: standId, sellerId: guestSellerId });

    // A VENUE. `own_seller_id` is null, so NO provider here is the stand — every line is
    // credited. Morgan Hill is the real case this shape exists for.
    venueGuestSellerId = await createSeller("Tian Tian");
    venueId = await createStand({ ownSellerId: null, name: "Morgan Hill Community Stand" });
    venueGuestProviderId = await addProvider({
      locationId: venueId,
      sellerId: venueGuestSellerId,
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

  it("returns each provider's own confirmed items under its own publication time", async () => {
    await publish({
      providerId: hostProviderId,
      sellerId: hostSellerId,
      locationId: standId,
      publishedAt: at(10),
      items: [{ itemName: "venison", priceText: "$14" }],
    });
    await publish({
      providerId: guestProviderId,
      sellerId: guestSellerId,
      locationId: standId,
      publishedAt: at(600),
      items: [{ itemName: "salad greens", priceText: "$5" }],
    });

    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const providers = byStand.get(standId) ?? [];
    expect(providers).toHaveLength(2);

    const host = providers.find((p) => p.providerId === hostProviderId);
    const guest = providers.find((p) => p.providerId === guestProviderId);

    /*
      THE ASSERTION THAT ONLY A PER-PROVIDER READER CAN PASS.

      Both providers' items exist either way. What distinguishes a correct reader is that each
      carries its OWN publication time, and the two are 590 minutes apart on purpose: a
      stand-wide `published_at` has to pick one, and either choice dates one seller's goods by
      the other's update.
    */
    expect(host?.publishedAt?.toISOString()).toBe(at(10).toISOString());
    expect(guest?.publishedAt?.toISOString()).toBe(at(600).toISOString());
    expect(host?.confirmedItems.map((i) => i.itemName)).toEqual(["venison"]);
    expect(guest?.confirmedItems.map((i) => i.itemName)).toEqual(["salad greens"]);
    // Each item's price rides with its own provider, never pooled across the stand.
    expect(host?.confirmedItems[0]?.priceText).toBe("$14");
    expect(guest?.confirmedItems[0]?.priceText).toBe("$5");
  });

  it("marks the stand's own seller by the self-pointer and credits the rest", async () => {
    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const providers = byStand.get(standId) ?? [];

    const host = providers.find((p) => p.providerId === hostProviderId);
    const guest = providers.find((p) => p.providerId === guestProviderId);

    expect(host?.describesOwnStand).toBe(true);
    expect(guest?.describesOwnStand).toBe(false);
    // The NAMES are carried too, and they are what a name-matching reader would have used.
    // Asserted so a reader that resolved the pointer correctly but dropped the name is caught.
    expect(host?.sellerName).toBe("Venison Valley");
    expect(guest?.sellerName).toBe("Gracies Greens");
  });

  it("puts the stand's own seller first, then hosted sellers by name", async () => {
    // The card's reading order: the stand's own goods lead, hosted sellers follow. Decided in
    // the reader so the map, SMS and the seller list cannot order the same facts differently.
    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    expect((byStand.get(standId) ?? []).map((p) => p.sellerName)).toEqual([
      "Venison Valley",
      "Gracies Greens",
    ]);
  });

  it("credits every provider at a venue, because none of them is the stand", async () => {
    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [venueId],
      includeTestFarms: false,
    });
    const providers = byStand.get(venueId) ?? [];

    expect(providers).toHaveLength(1);
    // `own_seller_id` is NULL here. A reader comparing `provider.seller_id = own_seller_id`
    // with plain `=` gets NULL — neither true nor false — and a careless coalesce would make
    // this true, rendering Tian Tian's goods as the venue's own. `is not distinct from` is
    // what makes it false.
    expect(providers[0]?.describesOwnStand).toBe(false);
    expect(providers[0]?.sellerName).toBe("Tian Tian");
  });

  it("returns a hosted seller's usual items with no publication time at all", async () => {
    // §customer behavior — a hosted seller's usual items are public on APPROVAL, on standing
    // claims alone. This is the first thing a customer ever sees about such a seller, and it
    // must arrive with nothing that could be rendered as a date.
    const bakerySellerId = await createSeller("Fernhorn Bakery");
    const bakeryProviderId = await addProvider({
      locationId: standId,
      sellerId: bakerySellerId,
    });
    await addUsualItem({
      providerId: bakeryProviderId,
      locationId: standId,
      displayName: "sourdough",
      priceAmount: "8.00",
      priceQuantity: "1",
      priceUnit: "loaf",
      priceBasis: "per",
    });

    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const bakery = (byStand.get(standId) ?? []).find(
      (p) => p.providerId === bakeryProviderId,
    );

    expect(bakery).toBeDefined();
    expect(bakery?.usualItems.map((i) => i.itemName)).toEqual(["sourdough"]);
    expect(bakery?.usualItems[0]?.priceText).toBe("$8 / loaf");
    // The two halves of the rule, both asserted: nothing confirmed, and nothing to date it by.
    expect(bakery?.confirmedItems).toEqual([]);
    expect(bakery?.publishedAt).toBeNull();

    await removeUnpublishedProvider(bakeryProviderId);
  });

  it("keeps a provider's usual items separate from its confirmed ones", async () => {
    await addUsualItem({
      providerId: hostProviderId,
      locationId: standId,
      displayName: "eggs",
      // PRICED, and that matters for the hidden-price case below: an unpriced item reads as
      // "no price" whether or not the gate exists, so it could never catch a missing gate.
      priceAmount: "6.00",
      priceQuantity: "1",
      priceUnit: "dozen",
      priceBasis: "per",
      sortOrder: 1,
    });

    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const host = (byStand.get(standId) ?? []).find((p) => p.providerId === hostProviderId);

    expect(host?.confirmedItems.map((i) => i.itemName)).toEqual(["venison"]);
    expect(host?.usualItems.map((i) => i.itemName)).toEqual(["eggs"]);
    expect(host?.usualItems[0]?.priceText).toBe("$6 / dozen");
  });

  it("withholds a usual item's price when the stand hides prices", async () => {
    /*
      F-092 — hidden means hidden, gated in SQL so the value never leaves the database. The
      ITEM still travels; only what it costs is the farmer's to withhold.

      THE CASE IS BUILT SO THE GATE IS THE ONLY THING THAT COULD REFUSE. The item carries a
      complete, renderable price, and the case above asserts that exact price coming back when
      prices are public. Without both halves this passes against a reader with no gate at all —
      an unpriced item reads as "no price" either way.
    */
    await sql()`update sales_locations set prices_public = false where id = ${standId}`;
    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const host = (byStand.get(standId) ?? []).find((p) => p.providerId === hostProviderId);
    expect(host?.usualItems.map((i) => i.itemName)).toEqual(["eggs"]);
    expect(host?.usualItems[0]?.priceText).toBeUndefined();
    await sql()`update sales_locations set prices_public = true where id = ${standId}`;
  });

  it("leaves out an item the seller does not usually carry", async () => {
    /*
      F-066 — `usually_carried` is what makes an item a STANDING CLAIM. A row exists for every
      name a past revision ever used, so without this predicate the card would tell a customer
      a seller "usually sells" something nobody ever said that about — vocabulary rendered as a
      claim.

      The case constructs the only situation where the predicate is the sole refuser: two items
      on ONE provider, identical but for the flag. A reader missing the predicate returns both,
      and the equality below is what sees it.
    */
    await sql()`
      insert into stand_items (
        sales_location_id, provider_id, display_name, usually_carried, sort_order
      ) values (${standId}, ${hostProviderId}, 'one-off rhubarb', false, 9)
    `;

    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const host = (byStand.get(standId) ?? []).find((p) => p.providerId === hostProviderId);

    expect(host?.usualItems.map((i) => i.itemName)).toEqual(["eggs"]);
    expect(host?.usualItems.map((i) => i.itemName)).not.toContain("one-off rhubarb");

    await sql()`
      delete from stand_items
      where provider_id = ${hostProviderId} and display_name = 'one-off rhubarb'
    `;
  });

  it("excludes a pending provider entirely", async () => {
    // `pending` is an invitation nobody has accepted. It is invisible to every public reader,
    // and this is the reader those invisibility claims are made about.
    const pendingSellerId = await createSeller("Not Yet Accepted");
    const pendingProviderId = await addProvider({
      locationId: standId,
      sellerId: pendingSellerId,
      lifecycleState: "pending",
    });
    await addUsualItem({
      providerId: pendingProviderId,
      locationId: standId,
      displayName: "should never be public",
    });

    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const providers = byStand.get(standId) ?? [];

    expect(providers.map((p) => p.providerId)).not.toContain(pendingProviderId);
    // Asserted on the ITEM as well as the provider: a reader that dropped the provider row but
    // still surfaced its usual item would publish a name nobody agreed to.
    expect(
      providers.flatMap((p) => p.usualItems.map((i) => i.itemName)),
    ).not.toContain("should never be public");

    await removeUnpublishedProvider(pendingProviderId);
  });

  it("excludes an ended relationship", async () => {
    const goneSellerId = await createSeller("Moved On Farm");
    const goneProviderId = await addProvider({
      locationId: standId,
      sellerId: goneSellerId,
      endedAt: at(700),
    });
    await addUsualItem({
      providerId: goneProviderId,
      locationId: standId,
      displayName: "gone",
    });

    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const providers = byStand.get(standId) ?? [];
    expect(providers.map((p) => p.providerId)).not.toContain(goneProviderId);
    expect(providers.flatMap((p) => p.usualItems.map((i) => i.itemName))).not.toContain("gone");

    await removeUnpublishedProvider(goneProviderId);
  });

  it("keeps a paused provider's last published claim visible", async () => {
    // A paused seller stopped being prompted; they did not withdraw what they published. What
    // a customer already saw stays visible, exactly as `readCurrentInventoryByProvider` treats
    // it, so the two readers cannot disagree about what a pause means.
    await sql()`
      update stand_providers set lifecycle_state = 'paused' where id = ${guestProviderId}
    `;
    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const guest = (byStand.get(standId) ?? []).find((p) => p.providerId === guestProviderId);
    expect(guest?.confirmedItems.map((i) => i.itemName)).toEqual(["salad greens"]);
    await sql()`
      update stand_providers set lifecycle_state = 'active' where id = ${guestProviderId}
    `;
  });

  it("reads several stands in one call without leaking rows between them", async () => {
    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId, venueId],
      includeTestFarms: false,
    });

    // The VENUE's list is asserted exactly, because the leak this case is aimed at would put
    // Venison Valley's sellers into it. The host stand's is asserted on membership rather than
    // equality — earlier cases add and remove sellers there, and pinning the whole set would
    // make this case fail for a reason that has nothing to do with leaking.
    expect(byStand.get(standId)?.map((p) => p.sellerName)).toContain("Venison Valley");
    expect(byStand.get(standId)?.map((p) => p.sellerName)).toContain("Gracies Greens");
    expect(byStand.get(venueId)?.map((p) => p.sellerName)).toEqual(["Tian Tian"]);
    expect(byStand.get(venueId)?.map((p) => p.salesLocationId)).toEqual([venueId]);
  });

  it("returns an empty map for no stands rather than reading every stand", async () => {
    // An empty id list must mean "nothing asked for", never "everything". This asserts the
    // BEHAVIOR rather than a branch: the reader has no length check, because the id set travels
    // as an array parameter and `= any('{}')` matches nothing. A length check written the wrong
    // way round is what turns a scoped read into a full-corpus one, so the case survives any
    // future rewrite of how the ids are passed.
    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [],
      includeTestFarms: false,
    });
    expect(byStand.size).toBe(0);
  });

  it("hides a test seller's provider unless the viewer asked for one", async () => {
    const testSellerId = await createSeller("Test Farm");
    await sql()`
      update sellers
      set test_seller_at = ${at(0)}, test_seller_by_administrator_id = ${administratorId}
      where id = ${testSellerId}
    `;
    const testProviderId = await addProvider({
      locationId: standId,
      sellerId: testSellerId,
    });
    await addUsualItem({
      providerId: testProviderId,
      locationId: standId,
      displayName: "test rhubarb",
    });

    const ordinary = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    expect((ordinary.get(standId) ?? []).map((p) => p.providerId)).not.toContain(
      testProviderId,
    );

    const deliberate = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: true,
    });
    expect((deliberate.get(standId) ?? []).map((p) => p.providerId)).toContain(testProviderId);

    await removeUnpublishedProvider(testProviderId);
  });

  it("hides a provider whose seller VIGA retired", async () => {
    // The farm take-down rule (B-066), which `visibleFarms` states once. A hosted seller VIGA
    // removes leaves every stand they sold at, not only their own.
    const retiredSellerId = await createSeller("Retired Farm");
    const retiredProviderId = await addProvider({
      locationId: standId,
      sellerId: retiredSellerId,
    });
    await addUsualItem({
      providerId: retiredProviderId,
      locationId: standId,
      displayName: "retired plums",
    });

    const before = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    expect((before.get(standId) ?? []).map((p) => p.providerId)).toContain(retiredProviderId);

    await sql()`
      update sellers
      set retired_at = ${at(0)}, retired_by_administrator_id = ${administratorId}
      where id = ${retiredSellerId}
    `;

    const after = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    expect((after.get(standId) ?? []).map((p) => p.providerId)).not.toContain(
      retiredProviderId,
    );
    // A retired seller is hidden from the DELIBERATE viewer too — `?hidden=true` is authority
    // over fake sellers, never over a real farm VIGA took down.
    const deliberate = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: true,
    });
    expect((deliberate.get(standId) ?? []).map((p) => p.providerId)).not.toContain(
      retiredProviderId,
    );

    await removeUnpublishedProvider(retiredProviderId);
  });

  it("returns a provider whose current revision published no entries at all", async () => {
    // "The farmer confirmed this stand is empty" is a real claim with a real date, and it is
    // NOT the same as never having published. The provider comes back present, with a
    // publication time and no items.
    // Its OWN stand: published inventory is immutable, so nothing here can be cleaned up and
    // the shared fixture must not be touched.
    const emptySellerId = await createSeller("Empty Today Farm");
    const emptyStandId = await createStand({
      ownSellerId: emptySellerId,
      name: "Empty Today Stand",
    });
    const emptyProviders = await sql()`
      select id from stand_providers
      where sales_location_id = ${emptyStandId} and seller_id = ${emptySellerId}
    `;
    const emptyProviderId = emptyProviders[0]?.id as string;
    await publish({
      providerId: emptyProviderId,
      sellerId: emptySellerId,
      locationId: emptyStandId,
      publishedAt: at(800),
      items: [],
    });

    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [emptyStandId],
      includeTestFarms: false,
    });
    const empty = (byStand.get(emptyStandId) ?? []).find(
      (p) => p.providerId === emptyProviderId,
    );

    // Present, dated, and holding nothing — three facts, and the middle one is what separates
    // "confirmed empty" from "never published". A reader that dropped a provider with no
    // entries would erase a real claim with a real date.
    expect(empty).toBeDefined();
    expect(empty?.publishedAt?.toISOString()).toBe(at(800).toISOString());
    expect(empty?.confirmedItems).toEqual([]);
  });

  it("ignores a superseded revision", async () => {
    const supersededSellerId = await createSeller("Superseded Farm");
    const supersededStandId = await createStand({
      ownSellerId: supersededSellerId,
      name: "Superseded Stand",
    });
    const supersededProviders = await sql()`
      select id from stand_providers
      where sales_location_id = ${supersededStandId} and seller_id = ${supersededSellerId}
    `;
    const supersededProviderId = supersededProviders[0]?.id as string;
    const oldRevision = await publish({
      providerId: supersededProviderId,
      sellerId: supersededSellerId,
      locationId: supersededStandId,
      publishedAt: at(900),
      items: [{ itemName: "yesterdays kale" }],
    });
    await sql()`
      update inventory_revisions set is_current = false, superseded_at = ${at(910)}
      where id = ${oldRevision}
    `;
    await publish({
      providerId: supersededProviderId,
      sellerId: supersededSellerId,
      locationId: supersededStandId,
      publishedAt: at(910),
      items: [{ itemName: "todays kale" }],
    });

    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [supersededStandId],
      includeTestFarms: false,
    });
    const provider = (byStand.get(supersededStandId) ?? []).find(
      (p) => p.providerId === supersededProviderId,
    );
    // The superseded revision's item must be ABSENT, not merely outnumbered — a reader that
    // dropped `is_current` returns both and this equality is the only thing that catches it.
    expect(provider?.confirmedItems.map((i) => i.itemName)).toEqual(["todays kale"]);
    expect(provider?.publishedAt?.toISOString()).toBe(at(910).toISOString());
  });

  it("carries each provider's own stated availability", async () => {
    // The provider's OWN schedule, unclamped. Intersecting it with the stand's is
    // `intersectAvailability`'s job at the rendering seam, and it needs both answers to do it —
    // so the reader's contract is to report what the provider stated, never to resolve it.
    await sql()`
      update stand_providers
      set open_hours_kind = 'clock_range', open_from_minutes = 540, open_until_minutes = 780
      where id = ${guestProviderId}
    `;
    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [standId],
      includeTestFarms: false,
    });
    const guest = (byStand.get(standId) ?? []).find((p) => p.providerId === guestProviderId);
    expect(guest?.availability.hours).toEqual({
      kind: "clock_range",
      fromMinutes: 540,
      untilMinutes: 780,
    });

    const host = (byStand.get(standId) ?? []).find((p) => p.providerId === hostProviderId);
    // The host stated nothing, and nothing is what comes back — never a default schedule.
    expect(host?.availability).toEqual({});

    await sql()`
      update stand_providers
      set open_hours_kind = null, open_from_minutes = null, open_until_minutes = null
      where id = ${guestProviderId}
    `;
  });
});
