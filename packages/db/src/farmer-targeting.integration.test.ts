import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./index";
import type { Sql } from "./sql";
import {
  FARMER_TARGET_MENU_TTL_MS,
  resolveFarmerTarget,
  selectFarmerTarget,
} from "./farmer-targeting";
import { hashFarmerLinkToken } from "@farm-friend/core";
import { issueFarmerLink, resolveFarmerLink } from "./farmer";
import { readNativeProviderId } from "./current-inventory";

const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);

describe("F-051 durable farmer target context (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let databaseUrl = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `farm_friend_targeting_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: "packages/db/drizzle" });
    await migrationClient.end({ timeout: 5 });
    // Drizzle replaces timestamp serializers on its client. Repository SQL gets a fresh
    // client so binding Date values exercises the same split createDb uses in production.
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
    await client()`
      truncate farmer_target_menu_options, farmer_target_contexts,
        sales_locations, farmer_authorizations, contacts, sellers
      restart identity cascade
    `;
  });

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  function database(): Db {
    return { sql: client(), orm: {}, close: async () => {} } as unknown as Db;
  }

  it("returns the non-disclosing refusal for an unknown sender without persisting context", async () => {
    const senderHash = "f".repeat(64);
    await expect(resolveFarmerTarget(database(), {
      senderHash,
      occurredAt: T0,
      purpose: "settings",
      forceMenu: true,
    })).resolves.toEqual({ status: "not_authorized" });
    expect(await client()`
      select sender_hash from farmer_target_contexts where sender_hash = ${senderHash}
    `).toHaveLength(0);
    expect(await client()`
      select sender_hash from sender_states where sender_hash = ${senderHash}
    `).toHaveLength(0);
  });

  it("queues behind concurrent contact deletion and returns the non-disclosing refusal", async () => {
    const senderHash = "d".repeat(64);
    await contact(senderHash);
    const blocker = postgres(databaseUrl, { max: 1 });
    let releaseDelete = () => {};
    let markDeleting = () => {};
    const released = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleting = new Promise<void>((resolve) => {
      markDeleting = resolve;
    });
    const deletion = blocker.begin(async (tx) => {
      await tx`delete from contacts where phone_hash = ${senderHash}`;
      markDeleting();
      await released;
    });
    await deleting;

    const resolving = resolveFarmerTarget(database(), {
      senderHash,
      occurredAt: T0,
      purpose: "settings",
      forceMenu: true,
    });
    let queued = 0;
    try {
      for (let attempt = 0; attempt < 100 && queued < 1; attempt += 1) {
        const rows = await client()`
          select count(*)::integer as count
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%sender_states%'
        `;
        queued = rows[0]?.count as number;
        if (queued < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseDelete();
    }

    await deletion;
    await blocker.end({ timeout: 5 });
    expect(queued, "resolve must queue behind the deleting contact row").toBe(1);
    await expect(resolving).resolves.toEqual({ status: "not_authorized" });
    expect(await client()`
      select sender_hash from sender_states where sender_hash = ${senderHash}
    `).toHaveLength(0);
    expect(await client()`
      select sender_hash from farmer_target_contexts where sender_hash = ${senderHash}
    `).toHaveLength(0);
  });

  async function contact(senderHash = "a".repeat(64)): Promise<string> {
    const rows = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550199', ${senderHash}, ${T0}) returning id
    `;
    return rows[0]?.id as string;
  }

  async function target(
    contactId: string,
    farmName: string,
    locationName: string,
  ): Promise<{ authorizationId: string; farmId: string; locationId: string }> {
    const sellers = await client()`insert into sellers (name) values (${farmName}) returning id`;
    const farmId = sellers[0]?.id as string;
    const authorizations = await client()`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${farmId}, ${contactId}, ${T0}, ${T0}) returning id
    `;
    const locations = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farmId}, 'farm_stand', ${locationName}, 'America/Los_Angeles', 'visitable', 'produce', '1 Target Way', 47.44, -122.46,
        false, false
      ) returning id
    `;
    return {
      authorizationId: authorizations[0]?.id as string,
      farmId,
      locationId: locations[0]?.id as string,
    };
  }

  it("auto-selects and durably stores the only valid authorization-location pair", async () => {
    const contactId = await contact();
    const only = await target(contactId, "One Farm", "Only Stand");

    const result = await resolveFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      occurredAt: T0,
      purpose: "update",
    });

    expect(result).toMatchObject({
      status: "selected",
      autoSelected: true,
      target: {
        authorizationId: only.authorizationId,
        salesLocationId: only.locationId,
        locationName: "Only Stand",
      },
    });
    expect(await client()`
      select selected_authorization_id, selected_sales_location_id, selected_at
      from farmer_target_contexts where sender_hash = ${"a".repeat(64)}
    `).toEqual([
      {
        selected_authorization_id: only.authorizationId,
        selected_sales_location_id: only.locationId,
        selected_at: T0,
      },
    ]);
  });

  it("binds each menu number to its exact pair so a later display reorder cannot retarget it", async () => {
    const contactId = await contact();
    const first = await target(contactId, "A Farm", "A Stand");
    const second = await target(contactId, "B Farm", "B Stand");

    const menu = await resolveFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      occurredAt: T0,
      purpose: "update",
      forceMenu: true,
    });
    expect(menu).toMatchObject({
      status: "menu",
      options: [
        { optionNumber: 1, salesLocationId: first.locationId, locationName: "A Stand" },
        { optionNumber: 2, salesLocationId: second.locationId, locationName: "B Stand" },
      ],
    });

    await client()`update sales_locations set name = 'Z Stand' where id = ${first.locationId}`;
    await client()`update sales_locations set name = '0 Stand' where id = ${second.locationId}`;

    const selected = await selectFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      optionNumber: 1,
      occurredAt: new Date(T0.getTime() + 60_000),
    });
    expect(selected).toMatchObject({
      status: "selected",
      target: {
        authorizationId: first.authorizationId,
        salesLocationId: first.locationId,
        locationName: "Z Stand",
      },
    });
    expect(await client()`
      select selected_authorization_id, selected_sales_location_id
      from farmer_target_contexts where sender_hash = ${"a".repeat(64)}
    `).toEqual([
      {
        selected_authorization_id: first.authorizationId,
        selected_sales_location_id: first.locationId,
      },
    ]);
  });

  it("expires a menu at exactly twelve hours and leaves no selected target", async () => {
    const contactId = await contact();
    await target(contactId, "A Farm", "A Stand");
    await target(contactId, "B Farm", "B Stand");
    await resolveFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      occurredAt: T0,
      purpose: "settings",
      forceMenu: true,
    });

    const result = await selectFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      optionNumber: 1,
      occurredAt: new Date(T0.getTime() + FARMER_TARGET_MENU_TTL_MS),
    });
    expect(result).toEqual({ status: "expired" });
    expect(await client()`
      select selected_sales_location_id, menu_issued_at, menu_expires_at, menu_purpose
      from farmer_target_contexts where sender_hash = ${"a".repeat(64)}
    `).toEqual([
      {
        selected_sales_location_id: null,
        menu_issued_at: null,
        menu_expires_at: null,
        menu_purpose: null,
      },
    ]);
    expect(await client()`select * from farmer_target_menu_options`).toHaveLength(0);
  });

  it("revalidates a remembered target, clears revoked authority, and selects the sole survivor", async () => {
    const contactId = await contact();
    const first = await target(contactId, "A Farm", "A Stand");
    const second = await target(contactId, "B Farm", "B Stand");
    await resolveFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      occurredAt: T0,
      purpose: "update",
      forceMenu: true,
    });
    await selectFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      optionNumber: 1,
      occurredAt: new Date(T0.getTime() + 60_000),
    });

    await client()`
      update farmer_authorizations
      set revoked_at = ${new Date(T0.getTime() + 120_000)}
      where id = ${first.authorizationId}
    `;
    const resolved = await resolveFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      occurredAt: new Date(T0.getTime() + 180_000),
      purpose: "update",
    });

    expect(resolved).toMatchObject({
      status: "selected",
      autoSelected: true,
      target: { authorizationId: second.authorizationId, salesLocationId: second.locationId },
    });
    expect(await client()`
      select selected_authorization_id, selected_sales_location_id
      from farmer_target_contexts where sender_hash = ${"a".repeat(64)}
    `).toEqual([
      {
        selected_authorization_id: second.authorizationId,
        selected_sales_location_id: second.locationId,
      },
    ]);
  });

  it("queues behind an in-flight revocation and cannot retain the revoked target", async () => {
    const senderHash = "a".repeat(64);
    const contactId = await contact(senderHash);
    const only = await target(contactId, "Revoked Farm", "Revoked Stand");
    await resolveFarmerTarget(database(), {
      senderHash,
      occurredAt: T0,
      purpose: "update",
    });

    const blocker = postgres(databaseUrl, { max: 1 });
    let releaseRevocation = () => {};
    let markRevoking = () => {};
    const released = new Promise<void>((resolve) => { releaseRevocation = resolve; });
    const revoking = new Promise<void>((resolve) => { markRevoking = resolve; });
    const revocation = blocker.begin(async (tx) => {
      await tx`
        update farmer_authorizations set revoked_at = ${new Date(T0.getTime() + 1_000)}
        where id = ${only.authorizationId}
      `;
      markRevoking();
      await released;
    });
    await revoking;

    const resolving = resolveFarmerTarget(database(), {
      senderHash,
      occurredAt: new Date(T0.getTime() + 2_000),
      purpose: "update",
    });
    let queued = 0;
    try {
      for (let attempt = 0; attempt < 100 && queued < 1; attempt += 1) {
        const rows = await client()`
          select count(*)::integer as count
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%farmer_authorizations%for update%'
        `;
        queued = rows[0]?.count as number;
        if (queued < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseRevocation();
    }

    await revocation;
    await blocker.end({ timeout: 5 });
    expect(queued, "target resolution must wait on the authorization row").toBe(1);
    await expect(resolving).resolves.toEqual({ status: "not_authorized" });
    expect(await client()`
      select selected_sales_location_id from farmer_target_contexts
      where sender_hash = ${senderHash}
    `).toEqual([{ selected_sales_location_id: null }]);
  });

  it("a removed location cascades its stale context and the next use selects a current target", async () => {
    const contactId = await contact();
    const first = await target(contactId, "A Farm", "A Stand");
    const second = await target(contactId, "B Farm", "B Stand");
    await resolveFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      occurredAt: T0,
      purpose: "update",
      forceMenu: true,
    });
    await selectFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      optionNumber: 1,
      occurredAt: new Date(T0.getTime() + 60_000),
    });

    await client()`delete from sales_locations where id = ${first.locationId}`;
    expect(await client()`select * from farmer_target_contexts`).toHaveLength(0);

    const resolved = await resolveFarmerTarget(database(), {
      senderHash: "a".repeat(64),
      occurredAt: new Date(T0.getTime() + 120_000),
      purpose: "update",
    });
    expect(resolved).toMatchObject({
      status: "selected",
      autoSelected: true,
      target: { salesLocationId: second.locationId },
    });
  });

  it("target and menu operations never mutate STOP/START consent", async () => {
    const senderHash = "a".repeat(64);
    const contactId = await contact(senderHash);
    await target(contactId, "A Farm", "A Stand");
    await target(contactId, "B Farm", "B Stand");
    await client()`
      insert into sms_consents (recipient_hash, state, updated_at)
      values (${senderHash}, 'stopped', ${T0})
    `;
    await resolveFarmerTarget(database(), {
      senderHash,
      occurredAt: T0,
      purpose: "settings",
      forceMenu: true,
    });
    await selectFarmerTarget(database(), {
      senderHash,
      optionNumber: 2,
      occurredAt: new Date(T0.getTime() + 60_000),
    });
    expect(await client()`
      select state, capture_source, captured_at, capture_evidence_ref
      from sms_consents where recipient_hash = ${senderHash}
    `).toEqual([
      {
        state: "stopped",
        capture_source: null,
        captured_at: null,
        capture_evidence_ref: null,
      },
    ]);
  });

  it("binds a standing link to the selected exact stand even when its farm has several", async () => {
    const contactId = await contact();
    const first = await target(contactId, "Many Stands Farm", "North Stand");
    const locations = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${first.farmId}, 'farm_stand', 'South Stand', 'America/Los_Angeles', 'visitable', 'produce', '2 Target Way', 47.45, -122.47,
        false, false
      ) returning id
    `;
    const southId = locations[0]?.id as string;

    const issued = await issueFarmerLink(database(), {
      authorizationId: first.authorizationId,
      providerId: await readNativeProviderId(database(), {
            salesLocationId: southId,
      }),
      occurredAt: T0,
    });
    expect(issued.status).toBe("issued");
    const token = issued.status === "issued" ? issued.token : "";
    await expect(resolveFarmerLink(database(), {
      tokenHash: hashFarmerLinkToken(token),
    })).resolves.toMatchObject({
      authorizationId: first.authorizationId,
      salesLocationId: southId,
    });
  });

  it("refuses to mint a targeted link for a stand outside the authorization's farm", async () => {
    const contactId = await contact();
    const own = await target(contactId, "Own Farm", "Own Stand");
    const otherContact = await contact("e".repeat(64));
    const other = await target(otherContact, "Other Farm", "Other Stand");

    await expect(issueFarmerLink(database(), {
      authorizationId: own.authorizationId,
      providerId: await readNativeProviderId(database(), {
            salesLocationId: other.locationId,
      }),
      occurredAt: T0,
    })).resolves.toEqual({ status: "not_authorized" });
    expect(await client()`select id from farmer_links`).toHaveLength(0);
  });

  it("rejects decisive NULL and half-populated context shapes in real Postgres", async () => {
    await contact();
    await expect(client()`
      insert into farmer_target_contexts (
        sender_hash, selected_authorization_id, updated_at
      ) values (${"a".repeat(64)}, ${randomUUID()}, ${T0})
    `).rejects.toThrow(/selected_context_coherent/);
    await expect(client()`
      insert into farmer_target_contexts (
        sender_hash, menu_issued_at, updated_at
      ) values (${"a".repeat(64)}, ${T0}, ${T0})
    `).rejects.toThrow(/menu_context_coherent/);
  });
});
