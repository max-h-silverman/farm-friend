import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { createDb, readStandProviderFacts, type Db, type Sql } from "@farm-friend/db";
import { retrieveSmsListings, standKeyOfFactId } from "./inquiry";
import { listPublicStands } from "./public-listing";

/*
  F-115 — THE DIFFERENTIAL. Does SMS retrieval date each seller the way the seam does?

  ## The open question this file closes

  Both audits of F-114 confirmed that `inquiry.ts` builds its OWN per-seller SQL rather than
  calling `readStandProviderFacts`, and both stopped there: neither checked whether the two
  produce the same per-seller freshness. If they diverge, a customer gets one answer by SMS and
  another on the map — the exact failure C.5 existed to end, moved one layer down.

  Duplication is not itself the finding. The work order's own STRONG list keeps two readers on
  purpose: they return different SHAPES (SMS wants one flat row per seller with its items
  inlined; the map wants a nested structure per stand) and they serve different length budgets.
  What must hold is that neither can state a fact the other contradicts.

  ## Why the C.5 parity test does not answer it

  `multi-seller-sms.integration.test.ts` compares the two channels on one stand where BOTH
  sellers published and both are recent enough to still be current. That is the case the two
  queries agree on by construction. The cases where two independently written queries actually
  come apart are the ragged ones, and this file is built entirely out of them:

    * a seller who published a revision with NO entries (a farmer who confirmed an empty stand)
    * a seller whose last publication is far past the staleness threshold
    * a seller with standing items and no revision at all
    * a seller with both registers at once
    * a VENUE stand, where no provider is the stand's own seller

  ## How it compares

  Provider by provider, not item by item. The SMS fact id encodes the provider it belongs to
  (`providerFactId`), so both readers can be reduced to the same shape — provider id → what it
  claims and when — and compared directly. An item-level comparison is what the C.5 test already
  does, and it cannot see a seller who contributes no items at all.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/** One seller's public claim at one stand, reduced to a form both readers can produce. */
interface SellerClaim {
  /** Whose claim this is. Absent from the seam's usual-items-only rows, which SMS groups apart. */
  sellerName?: string;
  publishedAt: string | null;
  confirmedItems: string[];
  usualItems: string[];
}

describe("per-seller freshness differential: SMS retrieval vs readStandProviderFacts", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let standId = "";
  let venueId = "";
  const providerIds = new Map<string, string>();
  const sellerIds = new Map<string, string>();

  const NOW = new Date("2026-08-16T18:00:00Z");
  const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;
  /** A fixture id by key. Throws rather than interpolating `undefined` into a query. */
  const providerOf = (key: string): string => {
    const id = providerIds.get(key);
    if (id === undefined) throw new Error(`no provider fixture named ${key}`);
    return id;
  };
  const sellerOf = (key: string): string => {
    const id = sellerIds.get(key);
    if (id === undefined) throw new Error(`no seller fixture named ${key}`);
    return id;
  };

  /**
   * The SEAM's answer, reduced.
   *
   * `publishedAt` is the seam's own per-provider date, taken verbatim — no rendering, because
   * the rendered sentence is a different question and would hide a small divergence inside a
   * coarse phrase like "2 days ago".
   */
  const seamClaims = async (salesLocationId: string): Promise<Map<string, SellerClaim>> => {
    const byStand = await readStandProviderFacts(database(), {
      salesLocationIds: [salesLocationId],
      includeTestFarms: false,
    });
    const claims = new Map<string, SellerClaim>();
    for (const facts of byStand.get(salesLocationId) ?? []) {
      claims.set(facts.providerId, {
        sellerName: facts.sellerName,
        publishedAt: facts.publishedAt?.toISOString() ?? null,
        confirmedItems: facts.confirmedItems.map((item) => item.itemName).sort(),
        usualItems: facts.usualItems.map((item) => item.itemName).sort(),
      });
    }
    return claims;
  };

  /**
   * SMS RETRIEVAL's answer, reduced to the same shape.
   *
   * The confirmed half is keyed on the provider the fact id carries. The offerings half is
   * keyed on the STAND — that is retrieval's own shape, one standing row per stand rather than
   * per seller — so it is attributed here by looking up which provider owns each usual item.
   * That lookup is the only thing this helper knows that retrieval does not, and it is exactly
   * what the last assertion in this file is about.
   */
  const smsClaims = async (salesLocationId: string): Promise<Map<string, SellerClaim>> => {
    const rows = await retrieveSmsListings(database(), NOW, { includeTestFarms: false });
    const claims = new Map<string, SellerClaim>();

    for (const row of rows) {
      if (standKeyOfFactId(row.factId) !== salesLocationId) continue;
      if (row.basis !== "confirmed") continue;
      const providerId = row.factId.split("@")[1] as string;
      claims.set(providerId, {
        sellerName: row.farmName,
        publishedAt: row.asOf.toISOString(),
        confirmedItems: row.items.map((item) => item.itemName).sort(),
        usualItems: [],
      });
    }

    const offeringItems = rows
      .filter(
        (row) => row.basis === "offering" && standKeyOfFactId(row.factId) === salesLocationId,
      )
      .flatMap((row) => row.items.map((item) => item.itemName));
    if (offeringItems.length > 0) {
      const owners = await sql()`
        select provider_id, display_name from stand_items
        where sales_location_id = ${salesLocationId} and display_name = any(${offeringItems})
      `;
      for (const owner of owners) {
        const providerId = owner.provider_id as string;
        const existing = claims.get(providerId);
        if (existing) existing.usualItems = [...existing.usualItems, owner.display_name].sort();
        else
          claims.set(providerId, {
            publishedAt: null,
            confirmedItems: [],
            usualItems: [owner.display_name as string],
          });
      }
    }
    return claims;
  };

  const addSeller = async (input: {
    key: string;
    name: string;
    salesLocationId: string;
    /** Omitted means this seller never published. */
    publishedAt?: Date;
    confirmedItems?: string[];
    usualItems?: string[];
  }): Promise<void> => {
    const sellers = await sql()`insert into sellers (name) values (${input.name}) returning id`;
    const sellerId = sellers[0]?.id as string;
    sellerIds.set(input.key, sellerId);
    await sql()`
      insert into seller_approvals (seller_id, approved_at) values (${sellerId}, ${hoursAgo(500)})
    `;
    const providers = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${input.salesLocationId}, ${sellerId}, 'active', false,
        ${hoursAgo(500)}, ${hoursAgo(499)}, 'viga', ${hoursAgo(499)}
      ) returning id
    `;
    const providerId = providers[0]?.id as string;
    providerIds.set(input.key, providerId);

    if (input.publishedAt !== undefined) {
      const revisions = await sql()`
        insert into inventory_revisions (
          sales_location_id, provider_id, seller_id, published_at, is_current, source
        ) values (
          ${input.salesLocationId}, ${providerId}, ${sellerId},
          ${input.publishedAt}, true, 'viga'
        ) returning id
      `;
      const revisionId = revisions[0]?.id as string;
      let sortOrder = 0;
      for (const itemName of input.confirmedItems ?? []) {
        await sql()`
          insert into inventory_entries (
            inventory_revision_id, sales_location_id, item_name, sort_order
          ) values (${revisionId}, ${input.salesLocationId}, ${itemName}, ${sortOrder})
        `;
        sortOrder += 1;
      }
    }

    let itemOrder = 0;
    for (const itemName of input.usualItems ?? []) {
      await sql()`
        insert into stand_items (
          sales_location_id, provider_id, display_name, usually_carried, sort_order
        ) values (${input.salesLocationId}, ${providerId}, ${itemName}, true, ${itemOrder})
      `;
      itemOrder += 1;
    }
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_psfd_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    // THE HOSTED STAND. Its own seller plus three guests, each in one of the ragged states.
    const hostSellers = await sql()`insert into sellers (name) values ('Host Farm') returning id`;
    const hostSellerId = hostSellers[0]?.id as string;
    sellerIds.set("host", hostSellerId);
    await sql()`
      insert into seller_approvals (seller_id, approved_at)
      values (${hostSellerId}, ${hoursAgo(500)})
    `;
    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, prices_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, address_public, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Host Farm Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, true, false, false,
        'Vashon Hwy, Vashon WA', true, 47.4473, -122.4590
      ) returning id
    `;
    standId = locations[0]?.id as string;
    const own = await sql()`
      select id from stand_providers
      where sales_location_id = ${standId} and seller_id = ${hostSellerId}
    `;
    providerIds.set("host", own[0]?.id as string);

    // The host: fresh, ordinary, both registers. The control the ragged cases are read against.
    const hostRevisions = await sql()`
      insert into inventory_revisions (
        sales_location_id, provider_id, seller_id, published_at, is_current, source
      ) values (
        ${standId}, ${providerOf("host")}, ${hostSellerId}, ${hoursAgo(3)}, true, 'viga'
      ) returning id
    `;
    await sql()`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, sort_order
      ) values (${hostRevisions[0]?.id as string}, ${standId}, 'host tomatoes', 0)
    `;
    await sql()`
      insert into stand_items (
        sales_location_id, provider_id, display_name, usually_carried, sort_order
      ) values (${standId}, ${providerOf("host")}, 'host eggs', true, 0)
    `;

    // CONFIRMED AN EMPTY STAND. A revision exists and is current; it names nothing. The farmer
    // said "I have nothing right now", which is a fact with a date on it.
    await addSeller({
      key: "empty",
      name: "Empty Handed Farm",
      salesLocationId: standId,
      publishedAt: hoursAgo(5),
      confirmedItems: [],
    });

    // FAR PAST STALE. 40 days. Nothing in either reader's SQL thresholds on age, so if one of
    // them quietly does, this is the seller that shows it.
    await addSeller({
      key: "ancient",
      name: "Ancient Orchard",
      salesLocationId: standId,
      publishedAt: hoursAgo(24 * 40),
      confirmedItems: ["ancient apples"],
    });

    // STANDING CLAIM ONLY, no revision at all — §customer behavior's "public on approval".
    await addSeller({
      key: "standing",
      name: "Standing Bakery",
      salesLocationId: standId,
      usualItems: ["standing sourdough"],
    });

    // BOTH REGISTERS, so the confirmed/usual split is measured on a seller that has each.
    await addSeller({
      key: "both",
      name: "Both Ways Farm",
      salesLocationId: standId,
      publishedAt: hoursAgo(9),
      confirmedItems: ["both plums"],
      usualItems: ["both honey"],
    });

    // THE VENUE. `own_seller_id` is NULL, so no provider is the stand's own — the shape where
    // a reader that derives anything from the stand's seller has nothing to derive from.
    const venues = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, prices_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, address_public, public_latitude, public_longitude
      ) values (
        null, 'farm_stand', 'Morgan Hill Pavilion', 'America/Los_Angeles',
        'visitable', 'produce', true, true, false, false,
        'Morgan Hill Rd, Vashon WA', true, 47.4100, -122.4700
      ) returning id
    `;
    venueId = venues[0]?.id as string;
    await addSeller({
      key: "venueFresh",
      name: "Pavilion Greens",
      salesLocationId: venueId,
      publishedAt: hoursAgo(2),
      confirmedItems: ["pavilion kale"],
    });
    await addSeller({
      key: "venueStale",
      name: "Pavilion Roots",
      salesLocationId: venueId,
      publishedAt: hoursAgo(24 * 9),
      confirmedItems: ["pavilion carrots"],
      usualItems: ["pavilion parsnips"],
    });
    // STANDING CLAIMS ONLY, at the venue. The offerings half is a SECOND query with its own
    // copy of the owner join, so a venue seller who has never published is the only fixture
    // that reaches it — without this, that query's fix is unproved.
    await addSeller({
      key: "venueStanding",
      name: "Pavilion Bakery",
      salesLocationId: venueId,
      usualItems: ["pavilion baguettes"],
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

  it("agrees on which sellers are public at a hosted stand", async () => {
    /*
      THE SET FIRST, because a divergence here makes every date comparison below vacuous for the
      seller that went missing. Compared as a set of provider ids rather than of names: two
      sellers may share a name, and the id is what every downstream surface keys on.

      ONE SELLER IS EXCLUDED, DELIBERATELY, and this is the difference the differential found
      that is NOT a defect. A seller who published a revision naming nothing — "I confirmed I
      have nothing today" — is a real dated fact, and the seam returns them with that date and
      an empty item list, because a stand card must be able to show "confirmed empty". SMS
      retrieval excludes them by design, stated at its own join: *"a seller with no confirmed
      revision reaches a customer through the offerings half below, never as an empty confirmed
      listing."* An SMS answer is a list of places to go for a thing; a seller with nothing is
      not one of them.

      So the two readers differ in ROW SET by exactly this rule, and the test states the rule
      rather than asserting an equality that would force one of the two surfaces to be wrong.
    */
    const seam = await seamClaims(standId);
    const sms = await smsClaims(standId);
    const emptyHanded = providerOf("empty");

    expect([...sms.keys()].sort()).toEqual(
      [...seam.keys()].filter((id) => id !== emptyHanded).sort(),
    );
    expect(seam.size).toBe(5);
    // The excluded seller IS in the seam, dated, with nothing — so the exclusion above is a
    // real difference being permitted, not a seller who is simply absent from both.
    expect(seam.get(emptyHanded)).toEqual({
      sellerName: "Empty Handed Farm",
      publishedAt: hoursAgo(5).toISOString(),
      confirmedItems: [],
      usualItems: [],
    });
  });

  it("dates every seller identically, however stale", async () => {
    const seam = await seamClaims(standId);
    const sms = await smsClaims(standId);

    for (const [providerId, seamClaim] of seam) {
      // The confirmed-empty seller is absent from SMS by the rule stated above.
      if (providerId === providerOf("empty")) continue;
      expect(sms.get(providerId)?.publishedAt).toBe(seamClaim.publishedAt);
    }
    // And the dates are the ones the fixture published, so an agreement on two nulls, or on
    // one shared stand-wide timestamp, cannot satisfy the loop above.
    expect(seam.get(providerOf("host"))?.publishedAt).toBe(
      hoursAgo(3).toISOString(),
    );
    expect(seam.get(providerOf("ancient"))?.publishedAt).toBe(
      hoursAgo(24 * 40).toISOString(),
    );
    expect(seam.get(providerOf("standing"))?.publishedAt).toBeNull();
  });

  it("attributes every item to the same seller", async () => {
    const seam = await seamClaims(standId);
    const sms = await smsClaims(standId);

    for (const [providerId, seamClaim] of seam) {
      if (providerId === providerOf("empty")) continue;
      const smsClaim = sms.get(providerId);
      expect(smsClaim?.confirmedItems).toEqual(seamClaim.confirmedItems);
      expect(smsClaim?.usualItems).toEqual(seamClaim.usualItems);
    }

    /*
      AND THE NAME ON THE ROW IS THE SELLER'S OWN.

      A confirmed SMS row IS one seller's claim, so the farm name it carries has to be that
      seller's. It was read off the STAND's own_seller_id, which gave every hosted seller's row
      the HOST's name — Standing Bakery's sourdough labelled "Host Farm". Nothing rendered it
      today, which is why no existing test saw it; it reaches the answer path as
      `RetrievedFact.farmName`, one renderer away from a customer being told the wrong farm has
      the thing they asked for.
    */
    const guest = sms.get(providerOf("both"));
    expect(guest?.sellerName).toBe("Both Ways Farm");
    expect(sms.get(providerOf("ancient"))?.sellerName).toBe("Ancient Orchard");
    // The host still gets its own name, so a fix that simply broke the label fails here.
    expect(sms.get(providerOf("host"))?.sellerName).toBe("Host Farm");
    // The control, so an agreement on five empty sellers cannot pass the loop.
    expect(seam.get(providerOf("both"))).toMatchObject({
      confirmedItems: ["both plums"],
      usualItems: ["both honey"],
    });
  });

  it("puts a VENUE on the public map at all", async () => {
    /*
      THE WIDER HALF OF THE SAME LINE. `join sellers f on f.id = l.own_seller_id` is written
      identically in `public-listing.ts`, so the venue was missing from the MAP for the same
      reason it was missing from SMS. Fixing only the answer path would have left the two
      channels disagreeing about whether Morgan Hill exists — which is the failure the
      differential is for.
    */
    const stands = await listPublicStands({ db: database(), clock: new FixedClock(NOW) });
    const venue = stands.find((stand) => stand.factId === venueId);

    expect(venue).toBeDefined();
    expect(venue?.locationName).toBe("Morgan Hill Pavilion");
    // And its sellers came with it, so a stand present but empty cannot satisfy this.
    expect(venue?.sellers?.map((seller) => seller.sellerName).sort()).toEqual([
      "Pavilion Bakery",
      "Pavilion Greens",
      "Pavilion Roots",
    ]);
  });

  it("agrees at a VENUE, where no seller is the stand's own", async () => {
    const seam = await seamClaims(venueId);
    const sms = await smsClaims(venueId);

    expect([...sms.keys()].sort()).toEqual([...seam.keys()].sort());
    for (const [providerId, seamClaim] of seam) {
      expect(sms.get(providerId)?.publishedAt).toBe(seamClaim.publishedAt);
      expect(sms.get(providerId)?.confirmedItems).toEqual(seamClaim.confirmedItems);
    }
    expect(seam.get(providerOf("venueFresh"))?.publishedAt).toBe(
      hoursAgo(2).toISOString(),
    );
    expect(seam.get(providerOf("venueStale"))?.publishedAt).toBe(
      hoursAgo(24 * 9).toISOString(),
    );

    /*
      THE OFFERINGS HALF, which is a SEPARATE QUERY carrying its own copy of the owner join.
      A venue seller who has never published reaches customers only through it, so this is the
      only assertion that touches that second query at a venue — and without it the fix there
      is a change nothing measures.
    */
    expect(sms.get(providerOf("venueStanding"))?.usualItems).toEqual([
      "pavilion baguettes",
    ]);
  });

  it("still takes a stand down when VIGA retires the farm that owns it", async () => {
    /*
      THE OTHER DIRECTION OF THE SAME JOIN, and the reason it stayed in the query rather than
      being deleted outright. Making it LEFT is only correct if the stand-owner visibility rule
      it exists to carry still bites: a farm VIGA retires must take its OWN stands down with
      it, on both channels. `visibleFarms` reads `retired_at is null`, and against a venue's
      absent owner row that is NULL — which is TRUE, so the venue passes and the retired host
      does not. This case is what makes that reasoning a measurement.

      Restored at the end, because every other case in this file reads the same stand.
    */
    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${hoursAgo(500)}) returning id
    `;
    await sql()`
      update sellers
      set retired_at = ${hoursAgo(1)},
          retired_by_administrator_id = ${administrators[0]?.id as string}
      where id = ${sellerOf("host")}
    `;

    const smsAfter = await retrieveSmsListings(database(), NOW, { includeTestFarms: false });
    const standsAfter = await listPublicStands({ db: database(), clock: new FixedClock(NOW) });

    expect(smsAfter.filter((row) => standKeyOfFactId(row.factId) === standId)).toEqual([]);
    expect(standsAfter.find((stand) => stand.factId === standId)).toBeUndefined();
    // The VENUE is untouched — it has no owning farm to retire, which is the whole point.
    expect(standsAfter.find((stand) => stand.factId === venueId)).toBeDefined();

    await sql()`
      update sellers set retired_at = null, retired_by_administrator_id = null
      where id = ${sellerOf("host")}
    `;
    expect(
      (await listPublicStands({ db: database(), clock: new FixedClock(NOW) })).find(
        (stand) => stand.factId === standId,
      ),
    ).toBeDefined();
  });

  it("keeps agreeing when one seller republishes and the other does not", async () => {
    /*
      THE MOVING CASE. Every assertion above reads a fixture built once, which cannot tell a
      reader that computes freshness from one that reads a stored constant. Republishing ONE
      seller must move exactly that seller's date in BOTH readers — the superseded revision
      leaves, the new one arrives, and the other four sellers are untouched.
    */
    const before = await seamClaims(standId);
    const ancientProvider = providerOf("ancient");

    await sql()`
      update inventory_revisions
      set is_current = false, superseded_at = ${hoursAgo(1)}
      where provider_id = ${ancientProvider} and is_current
    `;
    const revisions = await sql()`
      insert into inventory_revisions (
        sales_location_id, provider_id, seller_id, published_at, is_current, source
      ) values (
        ${standId}, ${ancientProvider}, ${sellerOf("ancient")}, ${hoursAgo(1)}, true, 'viga'
      ) returning id
    `;
    await sql()`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, sort_order
      ) values (${revisions[0]?.id as string}, ${standId}, 'fresh apples', 0)
    `;

    const seam = await seamClaims(standId);
    const sms = await smsClaims(standId);

    expect(seam.get(ancientProvider)?.publishedAt).toBe(hoursAgo(1).toISOString());
    expect(seam.get(ancientProvider)?.confirmedItems).toEqual(["fresh apples"]);
    expect(sms.get(ancientProvider)?.publishedAt).toBe(seam.get(ancientProvider)?.publishedAt);
    expect(sms.get(ancientProvider)?.confirmedItems).toEqual(["fresh apples"]);

    for (const [providerId, claim] of seam) {
      if (providerId === ancientProvider) continue;
      // The seam must not have moved anyone else, INCLUDING the confirmed-empty seller — a
      // republication that disturbed a bystander's date is exactly what this case is for.
      expect(claim.publishedAt).toBe(before.get(providerId)?.publishedAt);
      if (providerId === providerOf("empty")) continue;
      expect(sms.get(providerId)?.publishedAt).toBe(claim.publishedAt);
    }
  });
});
