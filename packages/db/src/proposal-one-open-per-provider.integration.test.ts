import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase B — the pending-change defect, written before the fix.

  `inventory_publication_proposals_one_open_per_sender` was a unique index on `sender_hash`
  ALONE, where `state = 'open'`. The limit on pending SMS changes was therefore per PERSON, not
  per target: someone affiliated with sellers at two stands who texted an update for one was
  locked out of the other until they replied YES or NO. Multi-seller people are exactly the
  population this refactor serves.

  The index is now keyed `(sender_hash, sales_location_id, provider_id)` where `state = 'open'`.
  Three assertions, and each is load-bearing:

    1. Two open proposals for one sender at two DIFFERENT STANDS both persist. This is the
       defect. Against the old index the second insert raised 23505.
    2. Two open proposals for one sender at ONE STAND but two DIFFERENT PROVIDERS both persist.
       The stand dimension alone would not have caught this: a host and a hosted seller share a
       `sales_location_id`, and the confirmation the farmer replies YES to has to name which of
       them it publishes for.
    3. A second open proposal for the same sender AND the same provider is still REFUSED. The
       golden rule that one open inventory confirmation exists per sender is unchanged — it is
       now stated per provider-at-stand rather than globally, so a token can no longer be
       ambiguous about which listing it answers for.

  Closed proposals are outside the partial index by construction, so a fourth case proves the
  sender may open a new one once the first is answered.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-114 one open proposal per sender per provider (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let senderHash = "";
  let otherSenderHash = "";
  let farmId = "";
  let locationA = "";
  let locationB = "";
  /** Two providers at ONE stand: the native brand slot and a hosted seller. */
  let nativeProviderA = "";
  let hostedProviderA = "";
  let nativeProviderB = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  /** An open proposal carrying the minimum every CHECK on the table requires. */
  const openProposal = async (input: {
    sender: string;
    locationId: string;
    providerId: string;
  }): Promise<string> => {
    const db = client();
    const rows = await db`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        state, has_inventory, has_closure, base_is_first_publication
      ) values (
        ${input.sender}, ${input.locationId}, ${input.providerId}, ${db.json({})}, 1,
        'open', true, false, true
      )
      returning id
    `;
    return rows[0]?.id as string;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_propidx_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });

    const db = client();
    senderHash = `f114${randomUUID().replaceAll("-", "")}`;
    otherSenderHash = `f114${randomUUID().replaceAll("-", "")}`;
    for (const hash of [senderHash, otherSenderHash]) {
      await db`
        insert into contacts (phone_e164, phone_hash)
        values (${`+1206555${Math.floor(Math.random() * 9000 + 1000)}`}, ${hash})
      `;
    }

    const farms = await db`insert into farms (name) values ('Morgan Hill') returning id`;
    farmId = farms[0]?.id as string;

    const mkLocation = async (name: string): Promise<string> => {
      const rows = await db`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          ${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          ${`${name} Road, Vashon WA`}, 47.4473, -122.4590
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    locationA = await mkLocation("Morgan Hill Stand");
    locationB = await mkLocation("Cascade Stand");

    // The native brand slot is `seller_id is null` — the stand selling under its own name.
    const nativeProvider = async (locationId: string): Promise<string> => {
      const rows = await db`
        select id from stand_providers
        where sales_location_id = ${locationId} and seller_id is null
      `;
      return rows[0]?.id as string;
    };
    nativeProviderA = await nativeProvider(locationA);
    nativeProviderB = await nativeProvider(locationB);

    const sellers = await db`
      insert into sellers (name) values ('Fernhorn Bakery') returning id
    `;
    const sellerId = sellers[0]?.id as string;
    const hosted = await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
        approval_source, approved_at
      ) values (
        ${locationA}, ${sellerId}, 'active', now(), now(), 'viga', now()
      ) returning id
    `;
    hostedProviderA = hosted[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("every stand is migrated with exactly one native provider row", async () => {
    // The fixture above READS its native providers rather than inserting them. If the
    // migration did not create one per stand this test file cannot even build its corpus,
    // so assert the fact directly rather than letting a later case fail obscurely.
    expect(nativeProviderA).toBeTruthy();
    expect(nativeProviderB).toBeTruthy();
    expect(nativeProviderA).not.toEqual(nativeProviderB);
  });

  it("admits two open proposals for one sender at two different stands", async () => {
    const first = await openProposal({
      sender: senderHash,
      locationId: locationA,
      providerId: nativeProviderA,
    });
    const second = await openProposal({
      sender: senderHash,
      locationId: locationB,
      providerId: nativeProviderB,
    });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    const open = await client()`
      select id from inventory_publication_proposals
      where sender_hash = ${senderHash} and state = 'open'
    `;
    expect(open.map((row) => row.id as string).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it("admits two open proposals for one sender at two providers of ONE stand", async () => {
    const hosted = await openProposal({
      sender: otherSenderHash,
      locationId: locationA,
      providerId: hostedProviderA,
    });
    const native = await openProposal({
      sender: otherSenderHash,
      locationId: locationA,
      providerId: nativeProviderA,
    });

    const open = await client()`
      select provider_id from inventory_publication_proposals
      where sender_hash = ${otherSenderHash}
        and sales_location_id = ${locationA}
        and state = 'open'
    `;
    expect(open).toHaveLength(2);
    expect((open.map((row) => row.provider_id as string)).sort()).toEqual(
      [hostedProviderA, nativeProviderA].sort(),
    );
    expect(hosted).toBeTruthy();
    expect(native).toBeTruthy();
  });

  it("refuses a second open proposal for the same sender and the same provider", async () => {
    // The first two cases already left one open proposal for `senderHash` at
    // (locationA, nativeProviderA). A second must be refused by the INDEX, not by a caller.
    await expect(
      openProposal({
        sender: senderHash,
        locationId: locationA,
        providerId: nativeProviderA,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("admits a new open proposal once the previous one is closed", async () => {
    const db = client();
    const sender = `f114${randomUUID().replaceAll("-", "")}`;
    await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550101', ${sender})
    `;

    const first = await openProposal({
      sender,
      locationId: locationB,
      providerId: nativeProviderB,
    });
    // `expired` closes honestly: it consumes no token and publishes nothing, and
    // `inventory_publication_proposals_state_coherent` requires only `closed_at`.
    await db`
      update inventory_publication_proposals
      set state = 'expired', closed_at = now()
      where id = ${first}
    `;

    const second = await openProposal({
      sender,
      locationId: locationB,
      providerId: nativeProviderB,
    });
    expect(second).toBeTruthy();
    expect(second).not.toEqual(first);
  });
});
