import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import {
  confirmInventoryPublication,
  createDb,
  openOrReviseProposal,
  readCurrentInventory,
  type Db,
  type Sql,
} from "./index";

/*
  F-114 Phase C.2 — TWO SELLERS AT ONE STAND PUBLISH INDEPENDENTLY.

  ## The case, in VIGA's words

  *"Venison Valley carries Gracie's Greens. We want Zoe to be able to give her inventory without
  telling Kelsey. But we also don't want her inventory update to override Kelsey's."*

  Two requirements, and this file is where they stop being record shape and start being behavior:

  - **"Without overriding Kelsey's"** — one-current-per-PROVIDER. Zoe's publication supersedes
    Zoe's incumbent and leaves Kelsey's standing. The records made that possible in Phase B; the
    writers only start honoring it here, because until now every one of them resolved the stand's
    OWN provider and wrote there regardless of who was texting.
  - **"Without telling Kelsey"** — Zoe is authorized in her own right. Nothing routes through the
    host, and the host is not notified.

  ## What is asserted, and why the negatives carry the weight

  A test that only shows Zoe publishing would pass against a writer that published to Kelsey's
  provider under Zoe's name — the row would exist, the entries would be right, and the map would
  be wrong. So every case here asserts the ABSENCE of the wrong write beside the presence of the
  right one: Kelsey's incumbent is still current, still carries its own entries, and its
  `provider_id` is not the one Zoe just wrote.

  ## Attribution is recorded, never rendered

  §public output never attributes an observation to its observer. When Kelsey states Zoe's stock
  under the host right, the revision records that it was published under Kelsey's authorization
  — for audit and for Zoe's own view — while `seller_id` stays Zoe's, because they are Zoe's
  goods. What renders publicly is the item and its timestamp, identical either way.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("per-provider publication (integration)", () => {
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
  /** Gracies Greens' OWN stand. In the fixture because two cases need it and neither owns it. */
  let guestOwnStandId = "";
  let guestOwnProviderId = "";

  const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60 * 1000);
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  /**
   * A draft entry as code issues one. `entryId` is the handle a LATER pending edit names, so
   * every entry carries one whether it is published yet or not.
   */
  const draftEntry = (entry: {
    itemName: string;
    priceText?: string;
  }): { entryId: string; itemName: string; priceText?: string } => ({
    entryId: randomUUID(),
    ...entry,
  });

  /** Publish one complete snapshot for one provider, through the real two-step path. */
  const publish = async (input: {
    senderHash: string;
    providerId: string;
    entries: { itemName: string; priceText?: string }[];
    at: Date;
  }): Promise<{ status: string; revisionId?: string }> => {
    const opened = await openOrReviseProposal(database(), {
      senderHash: input.senderHash,
      salesLocationId: standId,
      providerId: input.providerId,
      entries: input.entries.map(draftEntry),
      now: input.at,
    });
    await opened.activate({ providerAcceptedAt: input.at });
    const result = await confirmInventoryPublication(database(), {
      proposalId: opened.proposalId,
      senderHash: input.senderHash,
      token: "yes",
      providerEventId: randomUUID(),
      occurredAt: new Date(input.at.getTime() + 60_000),
      clock: new FixedClock(new Date(input.at.getTime() + 60_000)),
    });
    return result as { status: string; revisionId?: string };
  };

  const currentRevisions = async (): Promise<Record<string, unknown>[]> =>
    (await sql()`
      select id, provider_id, seller_id, published_by_authorization_id, is_current
      from inventory_revisions
      where sales_location_id = ${standId} and is_current
      order by provider_id
    `) as unknown as Record<string, unknown>[];

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_perprov_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
        insert into seller_approvals (seller_id, approved_at) values (${sellerId}, ${at(0)})
      `;
    }

    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Venison Valley Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
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
        ${at(0)}, ${at(0)}, 'viga', ${at(0)}
      ) returning id
    `;
    guestProviderId = guest[0]?.id as string;

    const mkFarmer = async (
      phone: string,
      sellerId: string,
    ): Promise<string> => {
      const senderHash = `h${randomUUID().replaceAll("-", "")}`;
      const contacts = await sql()`
        insert into contacts (phone_e164, phone_hash)
        values (${phone}, ${senderHash}) returning id
      `;
      await sql()`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at
        ) values (${sellerId}, ${contacts[0]?.id as string}, ${at(0)}, ${at(0)})
      `;
      await sql()`
        insert into sms_consents (
          recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
        )
        values (
          ${senderHash}, 'active', 'farmer_onboarding', ${at(0)},
          ${`onboarding-${phone}`}, ${at(0)}
        )
      `;
      return senderHash;
    };
    const guestOwn = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${guestSellerId}, 'farm_stand', 'Gracies Greens Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        'Cove Road, Vashon WA', 47.4573, -122.4690
      ) returning id
    `;
    guestOwnStandId = guestOwn[0]?.id as string;
    const guestOwnProviders = await sql()`
      select id from stand_providers
      where sales_location_id = ${guestOwnStandId} and seller_id = ${guestSellerId}
    `;
    guestOwnProviderId = guestOwnProviders[0]?.id as string;

    hostSenderHash = await mkFarmer("+12065551000", hostSellerId);
    guestSenderHash = await mkFarmer("+12065551001", guestSellerId);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("the host publishes to the host's own provider", async () => {
    const result = await publish({
      senderHash: hostSenderHash,
      providerId: hostProviderId,
      entries: [draftEntry({ itemName: "venison", priceText: "$14" })],
      at: at(10),
    });
    expect(result.status).toBe("published");

    const current = await readCurrentInventory(database(), {
      salesLocationId: standId,
      providerId: hostProviderId,
    });
    expect(current?.entries.map((entry) => entry.itemName)).toEqual(["venison"]);
  });

  it("the hosted seller publishes without overriding the host's", async () => {
    // VIGA's requirement, stated as an assertion. Zoe's publication creates HER current
    // revision and leaves Kelsey's standing — the negative is the whole point, because a
    // writer that resolved the stand's own provider would have superseded Kelsey's here and
    // every positive assertion below would still have passed.
    const before = await readCurrentInventory(database(), {
      salesLocationId: standId,
      providerId: hostProviderId,
    });

    const result = await publish({
      senderHash: guestSenderHash,
      providerId: guestProviderId,
      entries: [draftEntry({ itemName: "salad greens", priceText: "$5" })],
      at: at(20),
    });
    expect(result.status).toBe("published");

    const guestCurrent = await readCurrentInventory(database(), {
      salesLocationId: standId,
      providerId: guestProviderId,
    });
    expect(guestCurrent?.entries.map((entry) => entry.itemName)).toEqual(["salad greens"]);

    const hostCurrent = await readCurrentInventory(database(), {
      salesLocationId: standId,
      providerId: hostProviderId,
    });
    expect(hostCurrent?.revisionId).toBe(before?.revisionId);
    expect(hostCurrent?.entries.map((entry) => entry.itemName)).toEqual(["venison"]);

    // Both current at once — one-current-per-PROVIDER, not per stand. A stand-wide index
    // would have made this impossible rather than merely wrong.
    const rows = await currentRevisions();
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((row) => row.provider_id))).toEqual(
      new Set([hostProviderId, guestProviderId]),
    );
  });

  it("files the hosted seller's revision under the hosted seller, not the stand's owner", async () => {
    // Whose goods these are is a fact on the row. A revision carrying the host's seller id
    // would credit Kelsey for Zoe's greens on every surface that reads it.
    const rows = await sql()`
      select seller_id, provider_id from inventory_revisions
      where sales_location_id = ${standId} and provider_id = ${guestProviderId}
        and is_current
    `;
    expect(rows[0]?.seller_id).toBe(guestSellerId);
    expect(rows[0]?.seller_id).not.toBe(hostSellerId);
  });

  it("refuses the host writing the hosted seller's stock without the opt-in", async () => {
    // §not a default. Zoe's arrangement specifically: Kelsey may not state Zoe's stock.
    await expect(
      openOrReviseProposal(database(), {
        senderHash: hostSenderHash,
        salesLocationId: standId,
        providerId: guestProviderId,
        entries: [draftEntry({ itemName: "salad greens", priceText: "$99" })],
        now: at(30),
      }),
    ).rejects.toThrow(/not authorized/i);

    // The absence of the wrong effect, not merely the presence of the throw: Zoe's listing is
    // untouched and still says what Zoe said.
    const guestCurrent = await readCurrentInventory(database(), {
      salesLocationId: standId,
      providerId: guestProviderId,
    });
    expect(guestCurrent?.entries.map((entry) => entry.priceText)).toEqual(["$5"]);
  });

  it("lets the host state the hosted seller's stock once the seller grants the right", async () => {
    // The baker who drops off at dawn. Same writer, same path — only the relationship's own
    // column changed, which is what makes this a property of the arrangement rather than a
    // second permission system.
    await sql()`
      update stand_providers set host_may_update_stock = true
      where id = ${guestProviderId}
    `;
    const result = await publish({
      senderHash: hostSenderHash,
      providerId: guestProviderId,
      entries: [{ itemName: "salad greens", priceText: "$5" }, { itemName: "radishes" }],
      at: at(40),
    });
    expect(result.status).toBe("published");

    const guestCurrent = await readCurrentInventory(database(), {
      salesLocationId: standId,
      providerId: guestProviderId,
    });
    expect(guestCurrent?.entries.map((entry) => entry.itemName)).toEqual([
      "salad greens",
      "radishes",
    ]);
  });

  it("records the observer on the revision while the goods stay the seller's", async () => {
    // §public output never attributes an observation to its observer — recorded for audit and
    // for Zoe's own view, never rendered. So the revision says Kelsey's authorization published
    // it AND that they are Gracies Greens' goods, which are two different facts.
    const rows = await sql()`
      select revision.seller_id, revision.published_by_authorization_id,
        auth.seller_id as authorization_seller_id
      from inventory_revisions as revision
      join farmer_authorizations as auth
        on auth.id = revision.published_by_authorization_id
      where revision.sales_location_id = ${standId}
        and revision.provider_id = ${guestProviderId}
        and revision.is_current
    `;
    expect(rows[0]?.seller_id).toBe(guestSellerId);
    expect(rows[0]?.authorization_seller_id).toBe(hostSellerId);
  });

  it("does not let the host's right at this stand reach the hosted seller elsewhere", async () => {
    // §not transitive, proved at the writer rather than only at the authority seam. Gracies
    // Greens sells at its own stand too; Kelsey's grant here says nothing there.
    await expect(
      openOrReviseProposal(database(), {
        senderHash: hostSenderHash,
        salesLocationId: guestOwnStandId,
        providerId: guestOwnProviderId,
        entries: [draftEntry({ itemName: "radishes" })],
        now: at(50),
      }),
    ).rejects.toThrow(/not authorized/i);
  });

  it("defaults to the stand's own provider when the caller names none", async () => {
    // Every caller that has not yet learned about providers keeps working, and keeps writing
    // exactly where it wrote before. This is what makes the change strictly additive for the
    // 31 stands with one seller.
    const result = await publish({
      senderHash: hostSenderHash,
      providerId: hostProviderId,
      entries: [draftEntry({ itemName: "venison", priceText: "$15" })],
      at: at(60),
    });
    expect(result.status).toBe("published");

    const opened = await openOrReviseProposal(database(), {
      senderHash: hostSenderHash,
      salesLocationId: standId,
      entries: [draftEntry({ itemName: "venison", priceText: "$16" })],
      now: at(70),
    });
    const rows = await sql()`
      select provider_id from inventory_publication_proposals where id = ${opened.proposalId}
    `;
    expect(rows[0]?.provider_id).toBe(hostProviderId);
  });

  it("moves the provider when a revision retargets, never only the stand", async () => {
    /*
      A revision rewrites the sender's ONE open proposal in place. It already moved
      `sales_location_id`, so it must move `provider_id` with it: a proposal whose location
      says one listing and whose provider says another would be confirmed against the second
      while the farmer read the first — the exact context-bound-token failure the confirmation
      contract exists to prevent, arriving through the back door of an unrewritten column.

      Asserted on a phone that can legitimately reach both providers, so the retarget is
      genuinely permitted and only the rewrite is under test.
    */
    await sql()`
      update stand_providers set host_may_update_stock = true
      where id = ${guestProviderId}
    `;
    await sql()`
      update inventory_publication_proposals
      set state = 'invalidated', closed_at = ${at(83)}, updated_at = ${at(83)}
      where sender_hash = ${hostSenderHash} and state = 'open'
    `;

    const first = await openOrReviseProposal(database(), {
      senderHash: hostSenderHash,
      salesLocationId: standId,
      providerId: hostProviderId,
      entries: [draftEntry({ itemName: "venison" })],
      now: at(84),
    });
    const revised = await openOrReviseProposal(database(), {
      senderHash: hostSenderHash,
      salesLocationId: standId,
      providerId: guestProviderId,
      entries: [draftEntry({ itemName: "salad greens" })],
      now: at(85),
    });
    expect(revised.proposalId).toBe(first.proposalId);

    const rows = await sql()`
      select provider_id from inventory_publication_proposals where id = ${revised.proposalId}
    `;
    expect(rows[0]?.provider_id).toBe(guestProviderId);
    // The absence of the stale value, stated as its own assertion: the column must not still
    // hold the provider the first version named.
    expect(rows[0]?.provider_id).not.toBe(hostProviderId);

    await sql()`
      update inventory_publication_proposals
      set state = 'invalidated', closed_at = ${at(86)}, updated_at = ${at(86)}
      where id = ${revised.proposalId}
    `;
    await sql()`
      update stand_providers set host_may_update_stock = false
      where id = ${guestProviderId}
    `;
  });

  it("refuses a hosted seller closing the stand", async () => {
    /*
      Closure is a STAND fact and it is owner-only: it overrides every provider and renders
      nothing itemized, so a hosted seller who could set it would silence their host's goods
      as well as their own. §facts and authority — a host may never change a hosted seller's
      participation, and the converse is at least as true.

      Asserted here rather than deferred with the rest of closure, because C.2 is what made a
      hosted seller a writer at all: without this case, widening the write path would have
      handed Zoe the stand's shutter as a side effect nobody chose.
    */
    await expect(
      openOrReviseProposal(database(), {
        senderHash: guestSenderHash,
        salesLocationId: standId,
        providerId: guestProviderId,
        closure: { result: "close", closureKind: "temporary", startsOn: "2026-08-20" },
        now: at(90),
      }),
    ).rejects.toThrow(/not authorized/i);

    // The absence of the effect, not only the refusal: no closure revision exists for this
    // stand at all, so nothing was written and left uncurrent.
    const rows = await sql()`
      select count(*)::int as total from closure_revisions
      where sales_location_id = ${standId}
    `;
    expect(rows[0]?.total).toBe(0);
  });

  it("lets the stand's own seller close the stand", async () => {
    // The positive beside the negative, so the refusal above is proved to be about WHO rather
    // than about closure being unreachable from this path.
    const opened = await openOrReviseProposal(database(), {
      senderHash: hostSenderHash,
      salesLocationId: standId,
      providerId: hostProviderId,
      closure: { result: "close", closureKind: "temporary", startsOn: "2026-08-20" },
      now: at(100),
    });
    await opened.activate({ providerAcceptedAt: at(100) });
    const result = await confirmInventoryPublication(database(), {
      proposalId: opened.proposalId,
      senderHash: hostSenderHash,
      token: "yes",
      providerEventId: randomUUID(),
      occurredAt: at(101),
      clock: new FixedClock(at(101)),
    });
    expect(result.status).toBe("published");

    const rows = await sql()`
      select owner_seller_id from closure_revisions
      where sales_location_id = ${standId} and is_current
    `;
    expect(rows[0]?.owner_seller_id).toBe(hostSellerId);
  });

  it("refuses a provider that belongs to another stand", async () => {
    /*
      The stand and the provider must agree, or a proposal names one stand's listing under
      another's roof and the farmer confirms a snapshot they never read.

      The actor here is deliberately the HOSTED seller, not the host. A phone with no authority
      at the other stand is refused by the authority check first, so a test using one would pass
      whether this guard existed or not — the unfalsifiable shape C.1 already deleted a guard
      for. Gracie's Greens sells at both stands, so she is genuinely authorized for the provider
      she names AND for the stand she names, and only their disagreement is left to refuse.
    */
    await expect(
      openOrReviseProposal(database(), {
        senderHash: guestSenderHash,
        salesLocationId: standId,
        providerId: guestOwnProviderId,
        entries: [draftEntry({ itemName: "radishes" })],
        now: at(110),
      }),
    ).rejects.toThrow(/does not belong/i);

    // The absence of the wrong write: nothing was opened against either stand.
    const rows = await sql()`
      select count(*)::int as total from inventory_publication_proposals
      where sender_hash = ${guestSenderHash} and state = 'open'
    `;
    expect(rows[0]?.total).toBe(0);
  });
});
