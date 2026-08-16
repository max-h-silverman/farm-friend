import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCatalogMatcher,
  createInventoryInterpreter,
  type LLMProvider,
  type ModelSafeContext,
} from "@farm-friend/ai";
import { FixedClock, VASHON_TIME_ZONE } from "@farm-friend/core";
import {
  confirmInventoryPublication,
  createDb,
  openOrReviseProposal,
  type Db,
  type Sql,
} from "@farm-friend/db";
import { answerInquiry } from "./inquiry";
import { applyInterpretedInventory } from "./interpretation";
import { applyStandFilters, buildMapView } from "./map-view";
import { listPublicStands, serializePublicStand } from "./public-listing";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const farmerHash = "a1".repeat(32);
const customerHash = "c3".repeat(32);
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function localDate(dayOffset = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VASHON_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(T0.getTime() + dayOffset * 86_400_000));
  const get = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

class ScriptedProvider implements LLMProvider {
  readonly name = "closure-script";
  calls = 0;
  constructor(private readonly payloads: string[]) {}
  async generateJson(_context: ModelSafeContext): Promise<string> {
    const payload = this.payloads[this.calls++];
    if (!payload) throw new Error("unexpected model call");
    return payload;
  }
}

describe("one closure projection across public discovery and customer SMS (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let closureMinute = 3;
  const ids = {} as { location: string; provider: string };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `farm_friend_closure_public_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
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
    closureMinute = 3;
    await client()`
      truncate table closure_revisions, pending_result_lists, inventory_entries,
        inventory_revisions, inventory_publication_proposals, outbox_work,
        seller_approvals, farmer_authorizations, sales_locations, administrators,
        sellers, contacts restart identity cascade
    `;
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash) values
        ('+12065550601', ${farmerHash}), ('+12065550603', ${customerHash})
        returning id, phone_hash
    `;
    const contact = (hash: string) => contacts.find((row) => row.phone_hash === hash)?.id as string;
    const admins = await client()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${T0}) returning id
    `;
    const sellers = await client()`insert into sellers (name) values ('Reader Farm') returning id`;
    const farmId = sellers[0]?.id as string;
    await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contact(farmerHash)}, ${T0}, ${T0})
    `;
    await client()`
      insert into seller_approvals (seller_id, administrator_id, approved_at)
      values (${farmId}, ${admins[0]?.id as string}, ${T0})
    `;
    const locations = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible, season_kind, open_hours_kind
      ) values (
        ${farmId}, 'farm_stand', 'Reader Stand', 'America/Los_Angeles', 'visitable', 'produce', '10 Reader Road', 47.44, -122.46,
        false, false, 'year_round', 'all_day'
      ) returning id
    `;
    ids.location = locations[0]?.id as string;
    // The stand's own listing (F-114 C.3) — this suite is one farmer at one stand of her own.
    const ownProviders = await client()`
      select provider.id from stand_providers as provider
      join sales_locations as location on location.id = provider.sales_location_id
      where provider.sales_location_id = ${ids.location}
        and provider.seller_id = location.own_seller_id
    `;
    ids.provider = ownProviders[0]?.id as string;
    await client()`
      insert into stand_items (sales_location_id, provider_id, display_name, usually_carried, sort_order)
      values (${ids.location}, (select id from stand_providers where sales_location_id = ${ids.location} and seller_id = (select own_seller_id from sales_locations where id = ${ids.location})), 'Honey', true, 0)
    `;
    const inventory = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      entries: [{ entryId: "draft-eggs", itemName: "Eggs" }],
      now: T0,
    });
    await inventory.activate({ providerAcceptedAt: at(1) });
    expect(
      (
        await confirmInventoryPublication(database(), {
          proposalId: inventory.proposalId,
          senderHash: farmerHash,
          token: "yes",
          occurredAt: at(2),
          providerEventId: `reader-inventory-${randomUUID()}`,
          clock: new FixedClock(at(2)),
        })
      ).status,
    ).toBe("published");
  });

  async function publishClosure(
    closure:
      | { result: "reopen" }
      | {
          result: "close";
          closureKind: "temporary" | "seasonal";
          startsOn: string;
          closedThrough?: string;
        },
  ) {
    const minute = closureMinute;
    closureMinute += 3;
    const proposal = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: ids.location,
      closure,
      now: at(minute),
    });
    await proposal.activate({ providerAcceptedAt: at(minute + 1) });
    return confirmInventoryPublication(database(), {
      proposalId: proposal.proposalId,
      senderHash: farmerHash,
      token: "yes",
      occurredAt: at(minute + 2),
      providerEventId: `reader-closure-${randomUUID()}`,
      clock: new FixedClock(at(minute + 2)),
    });
  }

  it("shows an active closure on map/detail, forces Open now false, and removes actions", async () => {
    await publishClosure({
      result: "close",
      closureKind: "temporary",
      startsOn: localDate(-1),
      closedThrough: localDate(1),
    });

    const stand = (await listPublicStands({ db: database(), clock: new FixedClock(T0) }))[0]!;
    const payload = serializePublicStand(stand);
    expect(payload.closure).toEqual(
      expect.objectContaining({ state: "active", label: expect.stringMatching(/Closed through/) }),
    );
    expect(payload.items.map((item) => item.itemName)).toEqual(["Eggs"]);
    expect(payload.usuallySells!.map((o) => o.itemName)).toEqual(["Honey"]);
    expect(payload.updated).toBeDefined();

    expect(
      applyStandFilters([payload], { openNow: true }, { at: T0, utcOffsetMinutes: -7 * 60 }),
    ).toHaveLength(0);
    expect(buildMapView([payload], null).stands[0]?.routingLink).toBeNull();
  });

  it("shows a future closure without overriding availability, and expiry resumes it at read time", async () => {
    await publishClosure({
      result: "close",
      closureKind: "temporary",
      startsOn: localDate(1),
      closedThrough: localDate(2),
    });
    const upcomingStand = (
      await listPublicStands({ db: database(), clock: new FixedClock(T0) })
    )[0]!;
    const upcoming = serializePublicStand(upcomingStand);
    expect(upcoming.closure?.state).toBe("upcoming");
    expect(
      applyStandFilters([upcoming], { openNow: true }, { at: T0, utcOffsetMinutes: -7 * 60 }),
    ).toHaveLength(1);

    const afterEnd = at(5 * 24 * 60);
    const expiredStand = (
      await listPublicStands({ db: database(), clock: new FixedClock(afterEnd) })
    )[0]!;
    const expired = serializePublicStand(expiredStand);
    expect(expired.closure).toBeUndefined();
    expect(expired.items.map((item) => item.itemName)).toEqual(["Eggs"]);
    expect(expired.usuallySells!.map((o) => o.itemName)).toEqual(["Honey"]);
    expect(expiredStand.asOf).toEqual(upcomingStand.asOf);
    expect(expired.updated).toMatch(/4 days ago/);
    expect(expired.stale).toBe(true);
  });

  it("asks before a future closure could silently replace an active one", async () => {
    await publishClosure({ result: "close", closureKind: "temporary", startsOn: localDate(-1) });
    const provider = new ScriptedProvider([
      JSON.stringify({
        kind: "closure",
        closure: {
          result: "close",
          closureKind: "temporary",
          startsOn: localDate(2),
          closedThrough: localDate(3),
        },
      }),
    ]);

    const result = await applyInterpretedInventory(
      {
        db: database(),
        interpreter: createInventoryInterpreter(provider),
        clock: new FixedClock(T0),
      },
      {
        taskText: "closed again later",
        senderHash: farmerHash,
        salesLocationId: ids.location,
        providerId: ids.provider,
      },
    );

    expect(result.outcome).toBe("clarification");
    expect(await client()`select id from inventory_publication_proposals where state = 'open'`).toHaveLength(0);
  });

  it("customer SMS never presents an active closure as actionable, but can use an upcoming one", async () => {
    await publishClosure({ result: "close", closureKind: "temporary", startsOn: localDate(-1) });
    const closedProvider = new ScriptedProvider([
      JSON.stringify({
        matches: [],
      }),
    ]);
    const closedAnswer = await answerInquiry(
      { db: database(), matcher: createCatalogMatcher(closedProvider), clock: new FixedClock(T0) },
      { mode: "search_stands", request: { operation: "inventory" }, taskText: "eggs?", senderHash: customerHash, occurredAt: T0, scope: { includeTestFarms: false } },
    );
    expect(closedAnswer.outcome).toBe("answered");
    if (closedAnswer.outcome === "answered") expect(closedAnswer.body).toMatch(/no stand has a current listing/i);
    expect(closedProvider.calls).toBe(1);

    await publishClosure({ result: "reopen" });
    await publishClosure({ result: "close", closureKind: "temporary", startsOn: localDate(1) });
    const upcomingProvider = new ScriptedProvider([
      JSON.stringify({
        matches: ["eggs"],
      }),
    ]);
    const upcomingAnswer = await answerInquiry(
      { db: database(), matcher: createCatalogMatcher(upcomingProvider), clock: new FixedClock(T0) },
      { mode: "search_stands", request: { operation: "inventory" }, taskText: "eggs?", senderHash: customerHash, occurredAt: T0, scope: { includeTestFarms: false } },
    );
    expect(upcomingAnswer.outcome).toBe("answered");
    if (upcomingAnswer.outcome === "answered") expect(upcomingAnswer.body).toContain("Reader Stand");
    expect(upcomingProvider.calls).toBe(1);
  });
});
