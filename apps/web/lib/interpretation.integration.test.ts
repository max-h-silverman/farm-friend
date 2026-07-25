import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FixedClock,
  type InventoryInterpretation,
  type InventoryInterpreter,
} from "@farm-friend/core";
import { createDb, type Db } from "@farm-friend/db";
import { applyInterpretedInventory } from "./interpretation";

// F-014 — the workflow between the typed interpreter port and the one pending proposal.
// The interpreter is a deterministic fake: F-014 owns this contract, while the live
// model adapter and its privacy boundary are F-015.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const farmerHash = "3".repeat(64);
const T0 = new Date("2026-07-25T12:00:00Z");

function fakeInterpreter(result: InventoryInterpretation): InventoryInterpreter {
  return { async interpret() { return result; } };
}

describe("interpreted inventory → pending proposal (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let sql: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) {
      throw new Error(
        "DATABASE_URL is required; a skipped integration run is not green",
      );
    }
    testDatabaseName = `farm_friend_ip_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = new URL(baseUrl);
    url.pathname = `/${testDatabaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    sql = postgres(url.toString(), { max: 4 });
    db = createDb(url.toString());
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (sql) await sql.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(
        `drop database if exists "${testDatabaseName}" with (force)`,
      );
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  function client(): ReturnType<typeof postgres> {
    if (!sql) throw new Error("test database is not initialized");
    return sql;
  }

  beforeEach(async () => {
    await client()`
      truncate table
        inventory_entries, inventory_revisions, inventory_publication_proposals,
        outbox_work, farm_approvals, farmer_authorizations, sales_locations,
        administrators, farms, contacts
      restart identity cascade
    `;
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550801', ${farmerHash}), ('+12065550802', ${"4".repeat(64)})
      returning id, phone_hash
    `;
    ids.farmerContact = contacts.find((r) => r.phone_hash === farmerHash)
      ?.id as string;
    ids.adminContact = contacts.find((r) => r.phone_hash !== farmerHash)
      ?.id as string;

    const admins = await client()`
      insert into administrators (contact_id, authorized_at)
      values (${ids.adminContact}, ${T0}) returning id
    `;
    const farms = await client()`
      insert into farms (name) values ('Interpreted Farm') returning id
    `;
    ids.farm = farms[0]?.id as string;
    await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${ids.farm}, ${ids.farmerContact}, ${T0}, ${T0})
    `;
    await client()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${ids.farm}, ${admins[0]?.id as string}, ${T0})
    `;
    const locations = await client()`
      insert into sales_locations (
        farm_id, kind, name, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (${ids.farm}, 'farm_stand', 'Interpreted Stand', '11 Stand Way',
              47.45, -122.46, false, false)
      returning id
    `;
    ids.location = locations[0]?.id as string;
  });

  function deps(interpretation: InventoryInterpretation) {
    return {
      db: db as Db,
      interpreter: fakeInterpreter(interpretation),
      clock: new FixedClock(T0),
    };
  }

  it("opens a first-publication proposal from typed additions", async () => {
    const result = await applyInterpretedInventory(
      deps({
        kind: "edits",
        additions: [{ itemName: "Potatoes" }],
        changes: [],
        removals: [],
      }),
      {
        senderHash: farmerHash,
        salesLocationId: ids.location as string,
        taskText: "got potatoes",
      },
    );

    expect(result.outcome).toBe("proposed");
    if (result.outcome !== "proposed") return;
    // The confirmation renders the complete resulting snapshot.
    expect(result.confirmationText).toContain("Potatoes");

    const proposals = await client()`
      select payload, base_is_first_publication, proposal_version
      from inventory_publication_proposals where state = 'open'
    `;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.base_is_first_publication).toBe(true);
    expect(proposals[0]?.proposal_version).toBe(1);
  });

  it("preserves omitted published items when revising", async () => {
    // Seed a published base revision with two items. The prompt outbox row and the
    // activation it implies are what a real confirmation would have created.
    const prompt = await client()`
      insert into outbox_work (
        logical_key, recipient_hash, message_kind, body, body_expires_at,
        available_at, state, dispatch_authorized_at, completed_at
      )
      values ('seed-prompt', ${farmerHash}, 'inventory_confirmation', 'Confirm',
              ${new Date(T0.getTime() + 86_400_000)}, ${T0}, 'sent', ${T0}, ${T0})
      returning id
    `;
    const proposal = await client()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version, proposal_version,
        yes_token, no_token, base_is_first_publication, state,
        activation_outbox_id, activated_version, activated_at, expires_at,
        consumed_token, consumption_provider_event_id, closed_at
      )
      values (
        ${farmerHash}, ${ids.location}, ${client().json({ entries: [] })}, '1', 1,
        'YES', 'NO', true, 'accepted',
        ${prompt[0]?.id as string}, 1, ${T0},
        ${new Date(T0.getTime() + 3600_000)}, 'yes', 'seed-event', ${T0}
      )
      returning id
    `;

    const auth = await client()`
      select id from farmer_authorizations where farm_id = ${ids.farm}
    `;
    const approval = await client()`
      select id from farm_approvals where farm_id = ${ids.farm}
    `;
    const revision = await client()`
      insert into inventory_revisions (
        farm_id, sales_location_id, proposal_id, published_by_authorization_id,
        farm_approval_id, published_at
      )
      values (${ids.farm}, ${ids.location}, ${proposal[0]?.id as string},
              ${auth[0]?.id as string}, ${approval[0]?.id as string}, ${T0})
      returning id
    `;
    const entries = await client()`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, sort_order
      )
      values
        (${revision[0]?.id as string}, ${ids.location}, 'Potatoes', 0),
        (${revision[0]?.id as string}, ${ids.location}, 'Bok choy', 1)
      returning id, item_name
    `;

    const bokChoyId = entries.find((e) => e.item_name === "Bok choy")
      ?.id as string;

    // The farmer only mentions bok choy; potatoes must survive by omission.
    const result = await applyInterpretedInventory(
      deps({
        kind: "edits",
        additions: [],
        changes: [],
        removals: [{ entryId: bokChoyId }],
      }),
      {
        senderHash: farmerHash,
        salesLocationId: ids.location as string,
        taskText: "bok choy is gone",
      },
    );

    expect(result.outcome).toBe("proposed");
    if (result.outcome !== "proposed") return;
    expect(result.confirmationText).toContain("Potatoes");
    expect(result.confirmationText).not.toContain("Bok choy");
  });

  it("queues a clarification and creates no proposal", async () => {
    const result = await applyInterpretedInventory(
      deps({ kind: "clarification", question: "Did you mean everything?" }),
      {
        senderHash: farmerHash,
        salesLocationId: ids.location as string,
        taskText: "all gone?",
      },
    );

    expect(result.outcome).toBe("clarification");
    const proposals = await client()`
      select count(*)::integer as count from inventory_publication_proposals
    `;
    expect(proposals[0]?.count).toBe(0);
  });

  it("rejects an interpretation naming an entry outside the snapshot", async () => {
    const result = await applyInterpretedInventory(
      deps({
        kind: "edits",
        additions: [],
        changes: [],
        removals: [{ entryId: randomUUID() }],
      }),
      {
        senderHash: farmerHash,
        salesLocationId: ids.location as string,
        taskText: "drop the invented item",
      },
    );

    // Code validates membership; a hallucinated identifier has no consequence.
    expect(result.outcome).toBe("rejected");
    const proposals = await client()`
      select count(*)::integer as count from inventory_publication_proposals
    `;
    expect(proposals[0]?.count).toBe(0);
  });
});
