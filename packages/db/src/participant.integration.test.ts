import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  listActiveSalesLocationParticipants,
  saveSalesLocationParticipants,
  type Db,
  type Sql,
} from "./index";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const T1 = new Date(T0.getTime() + 60_000);
const ownerHash = "a".repeat(64);
const otherHash = "b".repeat(64);

describe("sales-location participant history constraints (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let databaseUrl = "";
  const ids = {} as {
    ownerFarm: string;
    otherFarm: string;
    location: string;
    ownerAuthorization: string;
    otherAuthorization: string;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

    databaseName = `farm_friend_participants_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 4 });
    db = createDb(url.toString());
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  function database(): Db {
    if (!db) throw new Error("database not initialized");
    return db;
  }

  beforeEach(async () => {
    await client()`
      truncate table
        sales_location_participants, farmer_authorizations, sender_states,
        sales_locations, sellers, contacts
      restart identity cascade
    `;
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash) values
        ('+12065550911', ${ownerHash}), ('+12065550912', ${otherHash})
      returning id, phone_hash
    `;
    const contact = (hash: string) =>
      contacts.find((row) => row.phone_hash === hash)?.id as string;
    const sellers = await client()`
      insert into sellers (name) values ('Owner Farm'), ('Other Farm') returning id, name
    `;
    ids.ownerFarm = sellers.find((row) => row.name === "Owner Farm")?.id as string;
    ids.otherFarm = sellers.find((row) => row.name === "Other Farm")?.id as string;
    const authorizations = await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values
        (${ids.ownerFarm}, ${contact(ownerHash)}, ${T0}, ${T0}),
        (${ids.otherFarm}, ${contact(otherHash)}, ${T0}, ${T0})
      returning id, seller_id
    `;
    ids.ownerAuthorization = authorizations.find(
      (row) => row.seller_id === ids.ownerFarm,
    )?.id as string;
    ids.otherAuthorization = authorizations.find(
      (row) => row.seller_id === ids.otherFarm,
    )?.id as string;
    const locations = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude
      ) values (
        ${ids.ownerFarm}, 'farm_stand', 'Shared Stand', 'America/Los_Angeles',
        'visitable', 'produce', '50 Participant Way', 47.44, -122.46
      ) returning id
    `;
    ids.location = locations[0]?.id as string;
  });

  async function insertParticipant(displayName = "Guest Growers"): Promise<string> {
    const rows = await client()`
      insert into sales_location_participants (
        owner_seller_id, sales_location_id, display_name,
        source, confirmed_by_authorization_id, confirmed_at
      ) values (
        ${ids.ownerFarm}, ${ids.location}, ${displayName},
        'sms', ${ids.ownerAuthorization}, ${T0}
      ) returning id
    `;
    return rows[0]?.id as string;
  }

  it("does not make the owner a participant unless an owner explicitly adds that name", async () => {
    expect(await client()`select id from sales_location_participants`).toHaveLength(0);
  });

  it("binds the location and confirming authorization to the same owner", async () => {
    await expect(
      client()`
        insert into sales_location_participants (
          owner_seller_id, sales_location_id, display_name,
          source, confirmed_by_authorization_id, confirmed_at
        ) values (
          ${ids.ownerFarm}, ${ids.location}, 'Wrong Authority',
          'sms', ${ids.otherAuthorization}, ${T0}
        )
      `,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects blank names and normalized duplicate active names", async () => {
    await expect(insertParticipant("   ")).rejects.toMatchObject({ code: "23514" });
    await insertParticipant("Guest   Growers");
    await expect(insertParticipant("  guest growers  ")).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects every decisive NULL and ordering failure in retirement state", async () => {
    const participantId = await insertParticipant();

    await expect(
      client()`
        update sales_location_participants set retired_at = ${T1}
        where id = ${participantId}
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client()`
        update sales_location_participants
        set retired_by_authorization_id = ${ids.ownerAuthorization}
        where id = ${participantId}
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client()`
        update sales_location_participants
        set retired_at = ${new Date(T0.getTime() - 1)},
            retired_by_authorization_id = ${ids.ownerAuthorization}
        where id = ${participantId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await client()`
      update sales_location_participants
      set retired_at = ${T1}, retired_by_authorization_id = ${ids.ownerAuthorization}
      where id = ${participantId}
    `;
    expect(await client()`
      select retired_at, retired_by_authorization_id
      from sales_location_participants where id = ${participantId}
    `).toEqual([{ retired_at: T1, retired_by_authorization_id: ids.ownerAuthorization }]);
  });

  it("preserves retired history and permits a later active row for the same normalized name", async () => {
    const retiredId = await insertParticipant("Guest Growers");
    await client()`
      update sales_location_participants
      set retired_at = ${T1}, retired_by_authorization_id = ${ids.ownerAuthorization}
      where id = ${retiredId}
    `;

    const activeId = await insertParticipant(" guest   growers ");
    expect(activeId).not.toBe(retiredId);
    expect(await client()`
      select id, retired_at from sales_location_participants
      where sales_location_id = ${ids.location} order by confirmed_at, id
    `).toEqual(
      expect.arrayContaining([
        { id: retiredId, retired_at: T1 },
        { id: activeId, retired_at: null },
      ]),
    );
  });

  it("refuses deletion or mutation of participant history", async () => {
    const participantId = await insertParticipant();

    await expect(
      client()`delete from sales_location_participants where id = ${participantId}`,
    ).rejects.toThrow(/participant history/i);
    await expect(
      client()`
        update sales_location_participants set display_name = 'Rewritten Name'
        where id = ${participantId}
      `,
    ).rejects.toThrow(/participant history/i);
  });

  it("adds no seller provenance to inventory entries", async () => {
    const columns = await client()`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'inventory_entries'
        and column_name ~ '(seller|participant|source)'
    `;
    expect(columns).toEqual([]);
  });

  it("saves a complete active list with durable rows and one owner audit event", async () => {
    const result = await saveSalesLocationParticipants(database(), {
      senderHash: ownerHash,
      salesLocationId: ids.location,
      activeDisplayNames: ["Island Apiary", "Guest Growers"],
      occurredAt: T1,
    });

    expect(result).toMatchObject({
      status: "saved",
      activeDisplayNames: ["Guest Growers", "Island Apiary"],
      addedDisplayNames: ["Guest Growers", "Island Apiary"],
      retiredDisplayNames: [],
    });
    expect(await client()`
      select owner_seller_id, sales_location_id, display_name,
             confirmed_by_authorization_id, confirmed_at, retired_at
      from sales_location_participants order by display_name
    `).toEqual([
      {
        owner_seller_id: ids.ownerFarm,
        sales_location_id: ids.location,
        display_name: "Guest Growers",
        confirmed_by_authorization_id: ids.ownerAuthorization,
        confirmed_at: T1,
        retired_at: null,
      },
      {
        owner_seller_id: ids.ownerFarm,
        sales_location_id: ids.location,
        display_name: "Island Apiary",
        confirmed_by_authorization_id: ids.ownerAuthorization,
        confirmed_at: T1,
        retired_at: null,
      },
    ]);
    expect(await client()`
      select action, actor_contact_hash, subject_type, subject_id, occurred_at
      from audit_events
    `).toEqual([
      {
        action: "sales_location_participants_saved",
        actor_contact_hash: ownerHash,
        subject_type: "sales_location",
        subject_id: ids.location,
        occurred_at: T1,
      },
    ]);
  });

  it("retires omitted names without deleting history and reads only active names", async () => {
    await saveSalesLocationParticipants(database(), {
      senderHash: ownerHash,
      salesLocationId: ids.location,
      activeDisplayNames: ["Guest Growers", "Island Apiary"],
      occurredAt: T0,
    });
    const result = await saveSalesLocationParticipants(database(), {
      senderHash: ownerHash,
      salesLocationId: ids.location,
      activeDisplayNames: ["Island Apiary"],
      occurredAt: T1,
    });

    expect(result).toMatchObject({
      status: "saved",
      activeDisplayNames: ["Island Apiary"],
      addedDisplayNames: [],
      retiredDisplayNames: ["Guest Growers"],
    });
    expect(await client()`
      select display_name, retired_by_authorization_id, retired_at
      from sales_location_participants order by display_name
    `).toEqual([
      {
        display_name: "Guest Growers",
        retired_by_authorization_id: ids.ownerAuthorization,
        retired_at: T1,
      },
      {
        display_name: "Island Apiary",
        retired_by_authorization_id: null,
        retired_at: null,
      },
    ]);
    expect(await listActiveSalesLocationParticipants(database(), ids.location)).toEqual([
      "Island Apiary",
    ]);
  });

  it("refuses unsafe, blank, and duplicate names before any participant or audit row", async () => {
    expect(
      await saveSalesLocationParticipants(database(), {
        senderHash: ownerHash,
        salesLocationId: ids.location,
        activeDisplayNames: ["Call Guest Growers at 206-555-0199"],
        occurredAt: T1,
      }),
    ).toEqual({ status: "unsafe_public_text", prohibited: ["phone_number"] });
    expect(
      await saveSalesLocationParticipants(database(), {
        senderHash: ownerHash,
        salesLocationId: ids.location,
        activeDisplayNames: ["   "],
        occurredAt: T1,
      }),
    ).toEqual({ status: "invalid_names" });
    expect(
      await saveSalesLocationParticipants(database(), {
        senderHash: ownerHash,
        salesLocationId: ids.location,
        activeDisplayNames: ["Guest Growers", " guest   growers "],
        occurredAt: T1,
      }),
    ).toEqual({ status: "invalid_names" });
    expect(await client()`select id from sales_location_participants`).toHaveLength(0);
    expect(await client()`select id from audit_events`).toHaveLength(0);
  });

  it("refuses a non-owner before any participant or audit row", async () => {
    expect(
      await saveSalesLocationParticipants(database(), {
        senderHash: otherHash,
        salesLocationId: ids.location,
        activeDisplayNames: ["Other Farm"],
        occurredAt: T1,
      }),
    ).toEqual({ status: "not_authorized" });
    expect(await client()`select id from sales_location_participants`).toHaveLength(0);
    expect(await client()`select id from audit_events`).toHaveLength(0);
  });

  it("keeps a matching farm name as unlinked display text", async () => {
    await client()`insert into sellers (name) values ('Guest Growers')`;
    await saveSalesLocationParticipants(database(), {
      senderHash: ownerHash,
      salesLocationId: ids.location,
      activeDisplayNames: ["Guest Growers"],
      occurredAt: T1,
    });

    expect(await listActiveSalesLocationParticipants(database(), ids.location)).toEqual([
      "Guest Growers",
    ]);
    const columns = await client()`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'sales_location_participants'
        and column_name ~ '(seller_id|profile)'
      order by column_name
    `;
    expect(columns).toEqual([{ column_name: "owner_seller_id" }]);
  });

  it("uses the active-name unique index to arbitrate a genuinely contended first insert", async () => {
    const secondContact = await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550913', ${"c".repeat(64)}) returning id
    `;
    const secondAuthorization = await client()`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (
        ${ids.ownerFarm}, ${secondContact[0]?.id as string}, ${T0}, ${T0}
      ) returning id
    `;
    const winner = postgres(databaseUrl, { max: 1 });
    const claimant = postgres(databaseUrl, { max: 1 });
    let releaseWinner = () => {};
    let markInserted = () => {};
    const releasePromise = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      markInserted = resolve;
    });
    const winningTransaction = winner.begin(async (tx) => {
      await tx`
        insert into sales_location_participants (
          owner_seller_id, sales_location_id, display_name,
          source, confirmed_by_authorization_id, confirmed_at
        ) values (
          ${ids.ownerFarm}, ${ids.location}, 'Guest Growers',
          'sms', ${ids.ownerAuthorization}, ${T0}
        )
      `;
      markInserted();
      await releasePromise;
    });
    await inserted;

    const losingInsert = (async () =>
      claimant`
        insert into sales_location_participants (
          owner_seller_id, sales_location_id, display_name,
          source, confirmed_by_authorization_id, confirmed_at
        ) values (
          ${ids.ownerFarm}, ${ids.location}, ' guest   growers ',
          'sms', ${secondAuthorization[0]?.id as string}, ${T1}
        )
      `)();
    let queued = 0;
    try {
      for (let attempt = 0; attempt < 100 && queued < 1; attempt += 1) {
        const rows = await client()`
          select count(*)::integer as count from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%insert into sales_location_participants%'
        `;
        queued = rows[0]?.count as number;
        if (queued < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseWinner();
    }

    await winningTransaction;
    await expect(losingInsert).rejects.toMatchObject({ code: "23505" });
    await winner.end({ timeout: 5 });
    await claimant.end({ timeout: 5 });
    expect(queued, "claimant must queue behind the uncommitted unique-index entry").toBe(1);
    expect(await client()`
      select display_name from sales_location_participants where retired_at is null
    `).toEqual([{ display_name: "Guest Growers" }]);
  });

  it("rechecks owner authorization after genuinely queuing behind its row lock", async () => {
    const blocker = postgres(databaseUrl, { max: 1 });
    let release = () => {};
    let markLocked = () => {};
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holding = blocker.begin(async (tx) => {
      await tx`
        select id from farmer_authorizations
        where id = ${ids.ownerAuthorization} for update
      `;
      markLocked();
      await releasePromise;
      await tx`
        update farmer_authorizations set revoked_at = ${T1}
        where id = ${ids.ownerAuthorization}
      `;
    });
    await locked;

    const saving = saveSalesLocationParticipants(database(), {
      senderHash: ownerHash,
      salesLocationId: ids.location,
      activeDisplayNames: ["Guest Growers"],
      occurredAt: T1,
    });
    let queued = 0;
    try {
      for (let attempt = 0; attempt < 100 && queued < 1; attempt += 1) {
        const rows = await client()`
          select count(*)::integer as count from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%select farmer.id from farmer_authorizations%'
        `;
        queued = rows[0]?.count as number;
        if (queued < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
    }

    await holding;
    await blocker.end({ timeout: 5 });
    expect(queued, "save must be observed waiting on the held authorization lock").toBe(1);
    expect(await saving).toEqual({ status: "not_authorized" });
    expect(await client()`select id from sales_location_participants`).toHaveLength(0);
  });
});
