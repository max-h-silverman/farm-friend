import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, type InventoryInterpreter } from "@farm-friend/core";
import type { InquiryModel } from "@farm-friend/ai";
import { resolveFarmerLink, type Db, type Sql } from "@farm-friend/db";
import { handleFreeText } from "./free-text";
import { handleFarmerTarget, handleStandSelection } from "./farmer-targeting";

const T0 = new Date(Date.now() - 60_000);

describe("F-051 deterministic farmer targeting handler (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_target_handler_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: "packages/db/drizzle" });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await client()`truncate contacts, farms restart identity cascade`;
  });

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  function database(): Db {
    return { sql: client(), orm: {}, close: async () => {} } as unknown as Db;
  }

  function forbiddenInquiry(): InquiryModel {
    return {
      async interpret() { throw new Error("customer inquiry model reached for a farmer"); },
      async select() { throw new Error("customer selection model reached for a farmer"); },
    };
  }

  async function authorize(senderHash: string, names: string[]) {
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550155', ${senderHash}, ${T0}) returning id
    `;
    const farms = await client()`insert into farms (name) values ('Target Farm') returning id`;
    const farmId = farms[0]?.id as string;
    const authorizations = await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    const locations: string[] = [];
    for (const name of names) {
      const inserted = await client()`
        insert into sales_locations (
          owner_farm_id, kind, name, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        ) values (${farmId}, 'farm_stand', ${name}, '1 Stand Way', 47.44, -122.46, false, false)
        returning id
      `;
      locations.push(inserted[0]?.id as string);
    }
    return { authorizationId: authorizations[0]?.id as string, locations };
  }

  it("continues a multi-stand LINK action after the stored numbered choice", async () => {
    const senderHash = "a".repeat(64);
    const owned = await authorize(senderHash, ["North Stand", "South Stand"]);
    const menu = await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "LINK", occurredAt: T0, providerEventId: "link-1" },
    );

    expect(menu.status).toBe("menu");
    expect(menu.replies[0]?.body).toContain("1. North Stand");
    expect(menu.replies[0]?.body).toContain("2. South Stand");
    expect(await client()`select id from farmer_links`).toHaveLength(0);

    const selected = await handleStandSelection(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, optionNumber: 2, occurredAt: new Date(T0.getTime() + 1_000), providerEventId: "choice-1" },
    );
    expect(selected.status).toBe("issued");
    expect(selected.replies[0]?.body).toContain("South Stand");
    expect(selected.replies[0]?.body).toContain("https://configured.example/stand/");
    const rows = await client()`select token_hash from farmer_links where revoked_at is null`;
    await expect(resolveFarmerLink(database(), {
      tokenHash: rows[0]?.token_hash as string,
    })).resolves.toMatchObject({ salesLocationId: owned.locations[1] });
  });

  it("uses the same non-disclosing response for unauthorized STAND and SETTINGS", async () => {
    const senderHash = "b".repeat(64);
    await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550156', ${senderHash}, ${T0})
    `;
    const stand = await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "STAND", occurredAt: T0, providerEventId: "stand-1" },
    );
    const settings = await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "SETTINGS", occurredAt: T0, providerEventId: "settings-1" },
    );

    expect(stand.status).toBe("not_authorized");
    expect(settings.status).toBe("not_authorized");
    expect(stand.replies[0]?.body).toBe(settings.replies[0]?.body);
    expect(stand.replies[0]?.body).not.toMatch(/https?:\/\//);
  });

  it("issues one exact settings link for the only valid stand", async () => {
    const senderHash = "c".repeat(64);
    await authorize(senderHash, ["Harbor Stand"]);
    const result = await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "SETTINGS", occurredAt: T0, providerEventId: "settings-2" },
    );

    expect(result.status).toBe("issued");
    expect(result.replies[0]?.body).toContain("Harbor Stand");
    expect(result.replies[0]?.body).toMatch(/\/stand\/[0-9a-f]{64}\/settings/);
  });

  it("offers the durable stand menu before interpreting free text when no target is selected", async () => {
    const senderHash = "d".repeat(64);
    await authorize(senderHash, ["North Stand", "South Stand"]);
    const interpret = vi.fn(async (_request: Parameters<InventoryInterpreter["interpret"]>[0]) => ({
      kind: "edits" as const,
      additions: [{ itemName: "Kale" }],
      changes: [],
      removals: [],
    }));

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret },
        inquiry: forbiddenInquiry(),
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "kale today",
        occurredAt: T0,
        providerEventId: "free-menu-1",
        inboxEventId: "11111111-1111-1111-1111-111111111111",
      },
    );

    expect(result.handled).toBe("none");
    expect(result.replies[0]?.body).toContain("1. North Stand");
    expect(result.replies[0]?.body).toContain("2. South Stand");
    expect(interpret).not.toHaveBeenCalled();
    expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);
  });

  it("revalidates the durable selected pair and proposes only for that exact stand", async () => {
    const senderHash = "e".repeat(64);
    const owned = await authorize(senderHash, ["North Stand", "South Stand"]);
    await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "STAND", occurredAt: T0, providerEventId: "stand-menu-2" },
    );
    await handleStandSelection(
      { db: database(), publicBaseUrl: "https://configured.example" },
      {
        senderHash,
        optionNumber: 2,
        occurredAt: new Date(T0.getTime() + 1_000),
        providerEventId: "stand-choice-2",
      },
    );
    const interpret = vi.fn(async (_request: Parameters<InventoryInterpreter["interpret"]>[0]) => ({
      kind: "edits" as const,
      additions: [{ itemName: "Kale" }],
      changes: [],
      removals: [],
    }));

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret },
        inquiry: forbiddenInquiry(),
        clock: new FixedClock(new Date(T0.getTime() + 2_000)),
      },
      {
        senderHash,
        taskText: "kale today",
        occurredAt: new Date(T0.getTime() + 2_000),
        providerEventId: "free-selected-2",
        inboxEventId: "22222222-2222-2222-2222-222222222222",
      },
    );

    expect(interpret).toHaveBeenCalledOnce();
    const modelInput = interpret.mock.calls[0]?.[0];
    expect(Object.keys(modelInput ?? {}).sort()).toEqual([
      "currentClosure",
      "currentEntries",
      "currentLocalDate",
      "taskText",
    ]);
    const serializedInput = JSON.stringify(modelInput);
    expect(serializedInput).not.toContain("North Stand");
    expect(serializedInput).not.toContain("South Stand");
    expect(serializedInput).not.toContain(owned.locations[0] as string);
    expect(serializedInput).not.toContain(owned.locations[1] as string);
    expect(result.handled).toBe("farmer");
    expect(result.replies[0]?.body).toContain("South Stand");
    expect(await client()`
      select sales_location_id from inventory_publication_proposals where state = 'open'
    `).toEqual([{ sales_location_id: owned.locations[1] }]);
  });
});
