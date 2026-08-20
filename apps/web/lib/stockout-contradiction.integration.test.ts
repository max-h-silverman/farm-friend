import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { createDb, type Db, type Sql } from "@farm-friend/db";
import { recordStockOutReport } from "./stockout";

/*
  F-114 Phase C.3 — WHO HEARS A CUSTOMER'S STOCK-OUT REPORT.

  ## The rule, and why it is contradiction rather than recency

  §customer behavior: *a stock-out report goes to every provider whose current confirmed
  inventory CONTRADICTS it — no question is asked.* The customer is never made to name a seller:
  at an unattended stand with two coolers they usually did not notice whose goods were whose, so
  a guess routes a false alarm to the wrong farmer.

  Three outcomes, and each is a different fact about a provider:

    * **Contradicts** — this provider's current revision LISTS the item. Being listed is the
      claim "we have this out"; a customer saying otherwise contradicts that provider
      specifically, whether they confirmed five minutes or three weeks ago. Told.
    * **Agrees** — this provider has a current revision that does NOT list the item. They have
      already said they are out. Texting them "someone says you are out of eggs" when their own
      listing says exactly that is noise, and noise is what makes a farmer stop reading.
    * **Not a claimant** — this provider has no current revision at all, or carries the item only
      as a USUAL item. They have made no dated claim to contradict. Never notified, and the
      report is filed for VIGA.

  Recency is deliberately NOT the test. A rule that told "whoever confirmed most recently" would
  text a host about a hosted seller's cooler, and would fall silent on the seller who confirmed
  three weeks ago and is the only one still claiming the item.

  ## The transitional case that must not become a design

  18 of 37 stands publish no confirmed inventory at all (measured 2026-08-11), so their reports
  reach no farmer and land in VIGA's queue today. That is a farmer-migration artifact, and
  routing to non-claimants to "fix" it would bake a transitional condition into permanent
  behavior. The non-claimant cases below assert the silence on purpose.
*/

describe("F-114 C.3 stock-out routing by contradiction (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let standId = "";
  let hostSellerId = "";
  let hostProviderId = "";
  let hostSenderHash = "";
  let guestSellerId = "";
  let guestProviderId = "";
  let guestSenderHash = "";

  const now = new Date("2026-08-16T18:00:00.000Z");
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  /** The model's only job: pick an id out of the list code built. */
  const modelPicking = (itemName: string) => ({
    parseItem: async (input: {
      listedItems: readonly { entryId: string; itemName: string }[];
    }) => {
      const match = input.listedItems.find(
        (item) => item.itemName.toLowerCase() === itemName.toLowerCase(),
      );
      return match === undefined
        ? ({ kind: "unlisted", itemText: itemName } as const)
        : ({ kind: "listed", entryId: match.entryId } as const);
    },
  });

  const deps = (itemName: string) => ({
    db: database(),
    model: modelPicking(itemName) as never,
    clock: new FixedClock(now),
  });

  /** Publish one current revision for a provider, listing exactly these item names. */
  const publish = async (
    providerId: string,
    sellerId: string,
    items: string[],
    publishedAt: Date = now,
  ) => {
    await sql()`
      update inventory_revisions set is_current = false
      where provider_id = ${providerId} and is_current
    `;
    // `viga` because it is the one source whose coherence arm needs no proposal, authorization
    // or approval keys. How a revision got published is not what these cases are about — that
    // it is CURRENT and lists these items is.
    const revisions = await sql()`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, source, published_at, is_current
      ) values (
        ${sellerId}, ${standId}, ${providerId}, 'viga', ${publishedAt}, true
      ) returning id
    `;
    const revisionId = revisions[0]?.id as string;
    for (const [index, itemName] of items.entries()) {
      await sql()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        ) values (${revisionId}, ${standId}, ${itemName}, ${index})
      `;
    }
    return revisionId;
  };

  const alerts = async (): Promise<string[]> => {
    const rows = await sql()`
      select recipient_hash from outbox_work
      where message_category = 'stock_out_alert'
      order by recipient_hash
    `;
    return rows.map((row) => row.recipient_hash as string);
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_c3stockout_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: "packages/db/drizzle" });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const sellers = await sql()`
      insert into sellers (name) values ('Venison Valley'), ('Gracies Greens')
      returning id, name
    `;
    hostSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    guestSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;

    const stands = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Venison Valley Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, 'Venison Valley Road, Vashon WA', 47.4473,
        -122.4590
      ) returning id
    `;
    standId = stands[0]?.id as string;

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
        ${standId}, ${guestSellerId}, 'active', false, ${now}, ${now}, 'viga', ${now}
      ) returning id
    `;
    guestProviderId = guest[0]?.id as string;

    const mkAuthorized = async (phone: string, sellerId: string): Promise<string> => {
      const senderHash = `h${randomUUID().replaceAll("-", "")}`;
      const contacts = await sql()`
        insert into contacts (phone_e164, phone_hash)
        values (${phone}, ${senderHash}) returning id
      `;
      await sql()`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at
        ) values (${sellerId}, ${contacts[0]?.id as string}, ${now}, ${now})
      `;
      return senderHash;
    };
    hostSenderHash = await mkAuthorized("+12065551000", hostSellerId);
    guestSenderHash = await mkAuthorized("+12065551001", guestSellerId);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await sql()`truncate outbox_work, stock_out_reports restart identity cascade`;
    await sql()`delete from inventory_entries`;
    await sql()`update inventory_revisions set is_current = false`;
    await sql()`delete from inventory_revisions`;
    await sql()`delete from stand_items`;
  });

  it("tells BOTH providers when both currently claim the item", async () => {
    await publish(hostProviderId, hostSellerId, ["Eggs", "Kale"]);
    await publish(guestProviderId, guestSellerId, ["Eggs", "Bread"]);

    const outcome = await recordStockOutReport(deps("Eggs"), {
      salesLocationId: standId,
      taskText: "no eggs left",
    });

    expect(outcome.outcome).toBe("recorded");
    expect(await alerts()).toEqual([hostSenderHash, guestSenderHash].sort());
  });

  it("skips the provider who already says they are out, and tells the one who does not", async () => {
    // Gracie's current listing has no eggs — she AGREES with the report and hears nothing.
    // Kelsey's lists them, so she is contradicted and told. The one report separates them.
    await publish(hostProviderId, hostSellerId, ["Eggs"]);
    await publish(guestProviderId, guestSellerId, ["Bread"]);

    await recordStockOutReport(deps("Eggs"), {
      salesLocationId: standId,
      taskText: "eggs are gone",
    });

    expect(await alerts()).toEqual([hostSenderHash]);
  });

  it("is CONTRADICTION and not recency: the stale claimant is told, the fresh agreer is not", async () => {
    /*
      The case that separates the two rules, and the only shape where they give different
      answers. Kelsey confirmed three weeks ago and still lists eggs; Gracie confirmed a minute
      ago and does not. A recency rule tells Gracie — the one farmer whose own listing already
      says she is out — and leaves Kelsey's stale claim standing, which is the listing a
      customer just drove to and found empty.
    */
    // Stamped at insert, not updated afterwards: `guard_inventory_revision_history` permits
    // exactly one transition and refuses every other UPDATE (DEVELOPMENT.md §gotchas).
    await publish(
      hostProviderId,
      hostSellerId,
      ["Eggs"],
      new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000),
    );
    await publish(guestProviderId, guestSellerId, ["Bread"]);

    await recordStockOutReport(deps("Eggs"), {
      salesLocationId: standId,
      taskText: "eggs are gone",
    });

    expect(await alerts()).toEqual([hostSenderHash]);
  });

  it("never notifies a provider who has published nothing at all", async () => {
    // Gracie has no current revision — no dated claim exists to contradict. The report is still
    // recorded for VIGA, which is what a stand between farmers needs.
    await publish(hostProviderId, hostSellerId, ["Eggs"]);

    const outcome = await recordStockOutReport(deps("Eggs"), {
      salesLocationId: standId,
      taskText: "eggs are gone",
    });

    expect(outcome.outcome).toBe("recorded");
    expect(await alerts()).toEqual([hostSenderHash]);
  });

  it("never notifies a provider carrying the item only as a USUAL item", async () => {
    /*
      A usual item is "we normally have this", not a dated claim that it is out now. §customer
      behavior is explicit: a provider with no confirmed claim is not notified, usual-only
      included — and the item is still MATCHABLE, because B-057 put usual items in the
      candidate list so a customer can name something the stand has never published.

      So this case has a listed match and no recipient at all, which is exactly the pair that
      would break if a later reader conflated "matched an item" with "someone claimed it".
    */
    await sql()`
      insert into stand_items (sales_location_id, provider_id, display_name, sort_order)
      values (${standId}, ${guestProviderId}, 'Eggs', 0)
    `;

    const outcome = await recordStockOutReport(deps("Eggs"), {
      salesLocationId: standId,
      taskText: "eggs are gone",
    });

    expect(outcome.outcome).toBe("recorded");
    expect(await alerts()).toEqual([]);
    // Recorded against the usual item rather than as unlisted text, so VIGA's queue names it.
    expect(await sql()`
      select referenced_stand_item_id, unlisted_item_text from stock_out_reports
    `).toEqual([
      {
        referenced_stand_item_id: expect.any(String),
        unlisted_item_text: null,
      },
    ]);
  });

  it("files an UNLISTED report for VIGA and notifies nobody", async () => {
    // Nothing claimed it, so nothing contradicts it. The report still stands.
    await publish(hostProviderId, hostSellerId, ["Kale"]);

    const outcome = await recordStockOutReport(deps("Rhubarb"), {
      salesLocationId: standId,
      taskText: "no rhubarb",
    });

    expect(outcome.outcome).toBe("recorded");
    expect(await alerts()).toEqual([]);
  });

  it("matches the item ACROSS providers, so a hosted seller's goods are reportable", async () => {
    // The candidate list is the stand's, deduplicated — a customer names an item, never a
    // seller. Bread exists only on Gracie's listing, and reporting it must reach her.
    await publish(hostProviderId, hostSellerId, ["Eggs"]);
    await publish(guestProviderId, guestSellerId, ["Bread"]);

    await recordStockOutReport(deps("Bread"), {
      salesLocationId: standId,
      taskText: "the bread is all gone",
    });

    expect(await alerts()).toEqual([guestSenderHash]);
  });

  it("queues ONE alert per provider per report, even on redelivery", async () => {
    await publish(hostProviderId, hostSellerId, ["Eggs"]);
    await publish(guestProviderId, guestSellerId, ["Eggs"]);

    const first = await recordStockOutReport(deps("Eggs"), {
      salesLocationId: standId,
      taskText: "no eggs",
      reportKey: "inbound-event-1",
    });
    const second = await recordStockOutReport(deps("Eggs"), {
      salesLocationId: standId,
      taskText: "no eggs",
      reportKey: "inbound-event-1",
    });

    // Same report, and no second round of alerts. The redelivery deliberately reports no
    // recipients of its own — it queued nobody, and claiming it had would make "who was
    // prompted" mean two different things on the two paths. What must hold is the EFFECT:
    // two providers were contradicted, and each hears exactly once.
    expect(second.outcome).toBe("recorded");
    expect(first.outcome === "recorded" && second.outcome === "recorded"
      ? second.reportId === first.reportId
      : false).toBe(true);
    expect(first.outcome === "recorded" ? first.alertedRecipientHashes : undefined)
      .toEqual([hostSenderHash, guestSenderHash].sort());
    expect(await alerts()).toEqual([hostSenderHash, guestSenderHash].sort());
  });
});
