import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, VASHON_TIME_ZONE } from "@farm-friend/core";
import {
  confirmInventoryPublication,
  createDb,
  openOrReviseProposal,
  type Db,
  type Sql,
} from "./index";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const farmerHash = "e".repeat(64);
const adminHash = "f".repeat(64);
const nonOwnerHash = "d".repeat(64);
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function localDate(dayOffset = 0): string {
  const shifted = new Date(T0.getTime() + dayOffset * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VASHON_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const get = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

describe("farmer-confirmed closure lifecycle (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let databaseUrl = "";
  const ids = {} as {
    farm: string;
    location: string;
    authorization: string;
    approval: string;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `farm_friend_closure_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    const migrator = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrator), { migrationsFolder: migrationsDir });
    await migrator.end({ timeout: 5 });
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
      truncate table closure_revisions, inventory_entries, inventory_revisions,
        inventory_publication_proposals, outbox_work, farm_approvals,
        farmer_authorizations, sales_locations, administrators, farms, contacts
      restart identity cascade
    `;
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550701', ${farmerHash}), ('+12065550702', ${adminHash}),
        ('+12065550703', ${nonOwnerHash})
      returning id, phone_hash
    `;
    const farmerContact = contacts.find((row) => row.phone_hash === farmerHash)?.id as string;
    const adminContact = contacts.find((row) => row.phone_hash === adminHash)?.id as string;
    const administrators = await client()`
      insert into administrators (email, contact_id, authorized_at)
      values ('closure-admin@viga.example', ${adminContact}, ${T0}) returning id
    `;
    const farms = await client()`insert into farms (name) values ('Closure Farm') returning id`;
    ids.farm = farms[0]?.id as string;
    const locations = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${ids.farm}, 'farm_stand', 'Closure Stand', '1 Closure Way', 47.44, -122.46,
        false, false
      ) returning id
    `;
    ids.location = locations[0]?.id as string;
    const authorizations = await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${ids.farm}, ${farmerContact}, ${T0}, ${T0}) returning id
    `;
    ids.authorization = authorizations[0]?.id as string;
    const approvals = await client()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${ids.farm}, ${administrators[0]?.id as string}, ${T0}) returning id
    `;
    ids.approval = approvals[0]?.id as string;
  });

  async function activateAndConfirm(proposal: {
    proposalId: string;
    activate(input: { providerAcceptedAt: Date }): Promise<void>;
  }, event: string, minute: number) {
    await proposal.activate({ providerAcceptedAt: at(minute) });
    return confirmInventoryPublication(database(), {
      proposalId: proposal.proposalId,
      senderHash: farmerHash,
      token: "yes",
      occurredAt: at(minute + 1),
      providerEventId: event,
      clock: new FixedClock(at(minute + 1)),
    });
  }

  it("publishes temporary, seasonal, and reopen instructions without touching inventory", async () => {
    const inventory = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      entries: [{ entryId: "draft-eggs", itemName: "Eggs" }],
      now: T0,
    });
    expect((await activateAndConfirm(inventory, "closure-inventory", 1)).status).toBe("published");
    const before = await client()`
      select id, published_at, is_current from inventory_revisions where sales_location_id = ${ids.location}
    `;

    const temporary = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      closure: {
        result: "close",
        closureKind: "temporary",
        startsOn: localDate(),
        closedThrough: localDate(2),
      },
      now: at(3),
    });
    expect((await activateAndConfirm(temporary, "closure-temporary", 4)).status).toBe("published");

    const currentTemporary = await client()`
      select result, closure_kind, starts_on::text, closed_through::text, is_current
      from closure_revisions where sales_location_id = ${ids.location} and is_current
    `;
    expect(currentTemporary).toEqual([
      expect.objectContaining({
        result: "close",
        closure_kind: "temporary",
        starts_on: localDate(),
        closed_through: localDate(2),
        is_current: true,
      }),
    ]);

    const reopen = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      closure: { result: "reopen" },
      now: at(4),
    });
    expect((await activateAndConfirm(reopen, "closure-reopen", 6)).status).toBe("published");

    const history = await client()`
      select result, closure_kind, starts_on, closed_through, is_current, superseded_at
      from closure_revisions order by published_at
    `;
    expect(history).toHaveLength(2);
    expect(history[0]?.is_current).toBe(false);
    expect(history[0]?.superseded_at).not.toBeNull();
    expect(history[1]).toEqual(
      expect.objectContaining({
        result: "reopen",
        closure_kind: null,
        starts_on: null,
        closed_through: null,
        is_current: true,
      }),
    );

    const after = await client()`
      select id, published_at, is_current from inventory_revisions where sales_location_id = ${ids.location}
    `;
    expect(after).toEqual(before);

    const seasonal = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      closure: { result: "close", closureKind: "seasonal", startsOn: localDate() },
      now: at(5),
    });
    expect((await activateAndConfirm(seasonal, "closure-seasonal", 8)).status).toBe("published");
    expect(
      await client()`
        select result, closure_kind, closed_through from closure_revisions
        where sales_location_id = ${ids.location} and is_current
      `,
    ).toEqual([
      expect.objectContaining({ result: "close", closure_kind: "seasonal", closed_through: null }),
    ]);
  });

  it("publishes mixed inventory and closure together, or neither when approval is gone", async () => {
    const mixed = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      entries: [{ entryId: "draft-kale", itemName: "Kale" }],
      closure: { result: "close", closureKind: "temporary", startsOn: localDate() },
      now: T0,
    });
    await mixed.activate({ providerAcceptedAt: at(1) });
    await client()`update farm_approvals set revoked_at = ${at(1.5)} where id = ${ids.approval}`;

    const refused = await confirmInventoryPublication(database(), {
      proposalId: mixed.proposalId,
      senderHash: farmerHash,
      token: "yes",
      occurredAt: at(2),
      providerEventId: "mixed-refused",
      clock: new FixedClock(at(2)),
    });
    expect(refused.status).toBe("not_approved");
    expect(await client()`select id from inventory_revisions`).toHaveLength(0);
    expect(await client()`select id from closure_revisions`).toHaveLength(0);

    await client()`update farm_approvals set revoked_at = null where id = ${ids.approval}`;
    const published = await confirmInventoryPublication(database(), {
      proposalId: mixed.proposalId,
      senderHash: farmerHash,
      token: "yes",
      occurredAt: at(3),
      providerEventId: "mixed-published",
      clock: new FixedClock(at(3)),
    });
    expect(published.status).toBe("published");
    expect(await client()`select item_name from inventory_entries`).toEqual([{ item_name: "Kale" }]);
    expect(await client()`select result from closure_revisions`).toEqual([{ result: "close" }]);
  });

  it("enforces every closure CHECK against its decisive NULL case with a valid control", async () => {
    const proposal = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      closure: { result: "reopen" },
      now: T0,
    });
    const base = [ids.farm, ids.location, proposal.proposalId, ids.authorization, ids.approval] as const;
    const insert = (values: {
      result: "close" | "reopen";
      kind: "temporary" | "seasonal" | null;
      start: string | null;
      end: string | null;
      current?: boolean;
      superseded?: Date | null;
    }) => client()`
      insert into closure_revisions (
        owner_farm_id, sales_location_id, proposal_id, owner_authorization_id,
        owner_approval_id, result, closure_kind, starts_on, closed_through,
        published_at, is_current, superseded_at
      ) values (
        ${base[0]}, ${base[1]}, ${base[2]}, ${base[3]}, ${base[4]},
        ${values.result}, ${values.kind}, ${values.start}, ${values.end}, ${T0},
        ${values.current ?? true}, ${values.superseded ?? null}
      )
    `;

    await expect(insert({ result: "close", kind: null, start: localDate(), end: null })).rejects.toThrow();
    await expect(insert({ result: "close", kind: "temporary", start: null, end: null })).rejects.toThrow();
    await expect(insert({ result: "close", kind: "seasonal", start: localDate(), end: localDate(1) })).rejects.toThrow();
    await expect(insert({ result: "close", kind: "temporary", start: localDate(2), end: localDate(1) })).rejects.toThrow();
    await expect(insert({ result: "reopen", kind: null, start: null, end: null, current: false, superseded: null })).rejects.toThrow();

    await expect(
      insert({ result: "reopen", kind: null, start: null, end: null }),
    ).resolves.not.toThrow();

    const stored = await client()`select id from closure_revisions where proposal_id = ${proposal.proposalId}`;
    const revisionId = stored[0]?.id as string;
    await expect(
      client()`update closure_revisions set result = 'close' where id = ${revisionId}`,
    ).rejects.toThrow(/immutable/i);
    await expect(
      client()`delete from closure_revisions where id = ${revisionId}`,
    ).rejects.toThrow(/cannot be deleted/i);
    expect(await client()`select result, is_current from closure_revisions where id = ${revisionId}`).toEqual([
      { result: "reopen", is_current: true },
    ]);
  });

  it("enforces proposal-section CHECKs against decisive NULLs", async () => {
    const insert = (input: {
      hasInventory: boolean;
      hasClosure: boolean;
      inventoryFirst: boolean | null;
      closureFirst: boolean | null;
    }) => client()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version, proposal_version,
        yes_token, no_token, has_inventory, has_closure,
        base_is_first_publication, closure_base_is_first_instruction
      ) values (
        ${farmerHash}, ${ids.location}, ${client().json({ closure: { result: "reopen" } })},
        '2', 1, 'YES', 'NO', ${input.hasInventory}, ${input.hasClosure},
        ${input.inventoryFirst}, ${input.closureFirst}
      )
    `;

    await expect(
      insert({
        hasInventory: false,
        hasClosure: false,
        inventoryFirst: null,
        closureFirst: null,
      }),
    ).rejects.toThrow();
    await expect(
      insert({
        hasInventory: false,
        hasClosure: true,
        inventoryFirst: null,
        closureFirst: null,
      }),
    ).rejects.toThrow();
    await expect(
      insert({
        hasInventory: false,
        hasClosure: true,
        inventoryFirst: null,
        closureFirst: true,
      }),
    ).resolves.not.toThrow();
  });

  it("refuses a non-owner's whole mixed proposal before any durable fact exists", async () => {
    const otherFarms = await client()`insert into farms (name) values ('Other Farm') returning id`;
    const otherFarmId = otherFarms[0]?.id as string;
    const otherContacts = await client()`
      select id from contacts where phone_hash = ${nonOwnerHash}
    `;
    await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${otherFarmId}, ${otherContacts[0]?.id as string}, ${T0}, ${T0})
    `;

    await expect(
      openOrReviseProposal(database(), {
        senderHash: nonOwnerHash,
        salesLocationId: ids.location,
        entries: [{ entryId: "draft-guest-kale", itemName: "Kale" }],
        closure: { result: "close", closureKind: "temporary", startsOn: localDate() },
        now: T0,
      }),
    ).rejects.toThrow(/authorized/i);
    expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);
    expect(await client()`select id from inventory_revisions`).toHaveLength(0);
    expect(await client()`select id from closure_revisions`).toHaveLength(0);
  });

  it("binds closure location, authorization, and approval to the same owner farm", async () => {
    const otherFarms = await client()`insert into farms (name) values ('Binding Farm') returning id`;
    const otherFarmId = otherFarms[0]?.id as string;
    const otherLocations = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${otherFarmId}, 'farm_stand', 'Binding Stand', '2 Closure Way', 47.43, -122.45,
        false, false
      ) returning id
    `;
    const otherContacts = await client()`select id from contacts where phone_hash = ${nonOwnerHash}`;
    const otherAuthorizations = await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${otherFarmId}, ${otherContacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    const administrators = await client()`select id from administrators limit 1`;
    const otherApprovals = await client()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${otherFarmId}, ${administrators[0]?.id as string}, ${T0}) returning id
    `;
    const proposal = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      closure: { result: "reopen" },
      now: T0,
    });

    const insert = (locationId: string, authorizationId: string, approvalId: string) => client()`
      insert into closure_revisions (
        owner_farm_id, sales_location_id, proposal_id, owner_authorization_id,
        owner_approval_id, result, published_at
      ) values (
        ${ids.farm}, ${locationId}, ${proposal.proposalId}, ${authorizationId},
        ${approvalId}, 'reopen', ${T0}
      )
    `;

    await expect(
      insert(otherLocations[0]?.id as string, ids.authorization, ids.approval),
    ).rejects.toThrow();
    await expect(
      insert(ids.location, otherAuthorizations[0]?.id as string, ids.approval),
    ).rejects.toThrow();
    await expect(
      insert(ids.location, ids.authorization, otherApprovals[0]?.id as string),
    ).rejects.toThrow();
    expect(await client()`select id from closure_revisions`).toHaveLength(0);
  });

  it("serializes genuinely queued closure claimants and publishes exactly one base", async () => {
    const otherContacts = await client()`select id from contacts where phone_hash = ${nonOwnerHash}`;
    await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${ids.farm}, ${otherContacts[0]?.id as string}, ${T0}, ${T0})
    `;
    const first = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      closure: { result: "close", closureKind: "temporary", startsOn: localDate() },
      now: T0,
    });
    const second = await openOrReviseProposal(database(), {
      senderHash: nonOwnerHash,
      salesLocationId: ids.location,
      closure: { result: "close", closureKind: "seasonal", startsOn: localDate() },
      now: at(1),
    });
    await first.activate({ providerAcceptedAt: at(2) });
    await second.activate({ providerAcceptedAt: at(2) });

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
      await tx`select owner_farm_id from sales_locations where id = ${ids.location} for update`;
      markLocked();
      await releasePromise;
    });
    await locked;

    const claims = [
      confirmInventoryPublication(database(), {
        proposalId: first.proposalId,
        senderHash: farmerHash,
        token: "yes",
        occurredAt: at(3),
        providerEventId: "closure-contention-first",
        clock: new FixedClock(at(3)),
      }),
      confirmInventoryPublication(database(), {
        proposalId: second.proposalId,
        senderHash: nonOwnerHash,
        token: "yes",
        occurredAt: at(3),
        providerEventId: "closure-contention-second",
        clock: new FixedClock(at(3)),
      }),
    ];

    let queued = 0;
    try {
      for (let attempt = 0; attempt < 100 && queued < 2; attempt += 1) {
        const rows = await client()`
          select count(*)::integer as count
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%select owner_farm_id from sales_locations%'
        `;
        queued = rows[0]?.count as number;
        if (queued < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
    }

    await holding;
    await blocker.end({ timeout: 5 });
    const settled = await Promise.allSettled(claims);
    expect(queued, "both claimants must be observed waiting on the held location lock").toBe(2);
    const results = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(results.map((result) => result.status).sort()).toEqual([
      "base_conflict",
      "published",
    ]);
    expect(await client()`select id from closure_revisions where is_current`).toHaveLength(1);
    expect(await client()`select id from closure_revisions`).toHaveLength(1);
    expect(
      await client()`
        select state from inventory_publication_proposals
        where id in (${first.proposalId}, ${second.proposalId})
        order by state
      `,
    ).toEqual([{ state: "accepted" }, { state: "invalidated" }]);
  });
});
