import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// F-014 — the authoritative transaction surface the forward migration must support:
// one generalized provider-webhook inbox, base-revision-bound proposals with
// activation-relative expiry and honest invalidation, and monotonic delivery state.
// F-022's initial migration is not rewritten; 0001 moves the schema forward.

const dbPackage = resolve(process.cwd(), "packages/db");
const migrationsDir = resolve(dbPackage, "drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required; a skipped integration run is not green",
    );
  }
  return databaseUrl;
}

function testDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("authoritative SMS transaction schema (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let testDatabaseName: string | undefined;

  const ids: Record<string, string> = {};
  const farmerHash = "e".repeat(64);
  const customerHash = "f".repeat(64);
  // Anchored to the real clock, not a calendar date: `outbox_work` enforces
  // `body_expires_at > created_at` against a `now()` default, so a literal date silently
  // expires. See the header note in workflow.integration.test.ts.
  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const offset = (hours: number) => new Date(anchor + hours * 60 * 60 * 1000).toISOString();
  const t0 = offset(0);
  const t1 = offset(1);
  const t2 = offset(2);
  const tomorrow = offset(48);

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_tx_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    client = postgres(testDatabaseUrl(baseUrl, testDatabaseName), { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });

    // Fixtures: an approved farm with an authorized farmer and one sales location.
    const contacts = await client`
      insert into contacts (phone_e164, phone_hash)
      values
        ('+12065550202', ${farmerHash}),
        ('+12065550203', ${customerHash})
      returning id, phone_hash
    `;
    for (const contact of contacts) {
      ids[contact.phone_hash as string] = contact.id as string;
    }

    const administrators = await client`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${t0})
      returning id
    `;
    ids.administrator = administrators[0]?.id as string;

    const farms = await client`
      insert into farms (name) values ('Transaction Farm') returning id
    `;
    ids.farm = farms[0]?.id as string;

    const authorizations = await client`
      insert into farmer_authorizations (
        farm_id, contact_id, phone_verified_at, authorized_at
      )
      values (${ids.farm}, ${ids[farmerHash] as string}, ${t0}, ${t0})
      returning id
    `;
    ids.authorization = authorizations[0]?.id as string;

    const approvals = await client`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${ids.farm}, ${ids.administrator}, ${t0})
      returning id
    `;
    ids.approval = approvals[0]?.id as string;

    const locations = await client`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${ids.farm}, 'farm_stand', 'Transaction Stand', 'America/Los_Angeles', 'visitable', 'produce', '5 Stand Way',
        47.45, -122.46, true, true
      )
      returning id
    `;
    ids.location = locations[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (client) {
      await client.end({ timeout: 5 });
    }
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(
        `drop database if exists "${testDatabaseName}" with (force)`,
      );
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  function db(): Sql {
    if (!client) {
      throw new Error("test database is not initialized");
    }
    return client;
  }

  function storedId(key: string): string {
    const value = ids[key];
    if (!value) {
      throw new Error(`missing test fixture id: ${key}`);
    }
    return value;
  }

  async function insertMessage(providerMessageId: string): Promise<string> {
    const rows = await db()`
      insert into sms_messages (
        provider_message_id, sender_hash, body, body_expires_at, received_at
      )
      values (
        ${providerMessageId}, ${farmerHash}, 'inventory text', ${tomorrow}, ${t0}
      )
      returning id
    `;
    return rows[0]?.id as string;
  }

  it("adds a forward migration without rewriting the initial migration", () => {
    const migrationFiles = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    expect(migrationFiles[0]).toBe("0000_clean_launch.sql");
    expect(migrationFiles.length).toBeGreaterThan(1);

    // F-022's committed migration is immutable history: its bytes must not change.
    const initial = readFileSync(
      resolve(migrationsDir, "0000_clean_launch.sql"),
      "utf8",
    );
    expect(initial).toContain("CREATE TABLE IF NOT EXISTS \"provider_inbox_events\"");
    expect(existsSync(resolve(migrationsDir, "meta/0001_snapshot.json"))).toBe(
      true,
    );
  });

  it("accepts all three provider event types through one constrained inbox", async () => {
    const eventTypes = await db()`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'provider_event_type'
      order by enumsortorder
    `;
    expect(eventTypes.map((row) => row.enumlabel)).toEqual([
      "message_received",
      "message_sent",
      "message_finalized",
    ]);

    // There is exactly one inbox and one deduplication path for every event type.
    const inboxTables = await db()`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and (
          table_name ilike '%delivery_event%'
          or table_name ilike '%delivery_receipt%'
          or table_name ilike '%_inbox%'
          or table_name ilike '%inbox_%'
        )
      order by table_name
    `;
    expect(inboxTables.map((row) => row.table_name)).toEqual([
      "provider_inbox_events",
    ]);

    ids.inboundMessage = await insertMessage("tx-message-1");

    await db()`
      insert into provider_inbox_events (
        provider_event_id, event_type, message_id, sender_hash, occurred_at
      )
      values (
        'tx-event-received-1', 'message_received', ${storedId("inboundMessage")},
        ${farmerHash}, ${t0}
      )
    `;

    // A received event must carry its minimized message and sender.
    await expect(
      db()`
        insert into provider_inbox_events (
          provider_event_id, event_type, occurred_at
        )
        values ('tx-event-received-invalid', 'message_received', ${t0})
      `,
    ).rejects.toThrow();

    // Delivery events carry only their delivery projection and outbound correlation.
    const outbox = await db()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at,
        available_at
      )
      values (
        'tx-outbox-1', ${farmerHash}, 'inventory_confirmation',
        'Confirm this inventory', ${tomorrow}, ${t0}
      )
      returning id
    `;
    ids.outbox1 = outbox[0]?.id as string;

    const attempts = await db()`
      insert into outbox_dispatch_attempts (
        outbox_work_id, attempt_number, state, provider_message_id,
        started_at, completed_at
      )
      values (
        ${storedId("outbox1")}, 1, 'accepted', 'tx-provider-message-1',
        ${t0}, ${t1}
      )
      returning id
    `;
    ids.attempt1 = attempts[0]?.id as string;

    await db()`
      insert into provider_inbox_events (
        provider_event_id, event_type, dispatch_attempt_id, delivery_status,
        occurred_at
      )
      values (
        'tx-event-sent-1', 'message_sent', ${storedId("attempt1")}, 'sent', ${t1}
      )
    `;

    // A delivery event must never reference an inbound message or a sender.
    await expect(
      db()`
        insert into provider_inbox_events (
          provider_event_id, event_type, dispatch_attempt_id, delivery_status,
          message_id, sender_hash, occurred_at
        )
        values (
          'tx-event-sent-invalid', 'message_sent', ${storedId("attempt1")},
          'sent', ${storedId("inboundMessage")}, ${farmerHash}, ${t1}
        )
      `,
    ).rejects.toThrow();

    // A delivery event must carry its outbound correlation and status.
    await expect(
      db()`
        insert into provider_inbox_events (
          provider_event_id, event_type, occurred_at
        )
        values ('tx-event-finalized-invalid', 'message_finalized', ${t2})
      `,
    ).rejects.toThrow();

    // One event-ID deduplication path spans every event type.
    await expect(
      db()`
        insert into provider_inbox_events (
          provider_event_id, event_type, dispatch_attempt_id, delivery_status,
          occurred_at
        )
        values (
          'tx-event-received-1', 'message_finalized', ${storedId("attempt1")},
          'delivered', ${t2}
        )
      `,
    ).rejects.toThrow();
  });

  it("claims and orders only inbound events per sender", async () => {
    // Sender claiming applies to inbound conversation work only.
    const secondMessage = await insertMessage("tx-message-2");
    await db()`
      insert into provider_inbox_events (
        provider_event_id, event_type, message_id, sender_hash, occurred_at,
        state, claim_token, claimed_at, claim_expires_at
      )
      values (
        'tx-event-received-2', 'message_received', ${secondMessage},
        ${farmerHash}, ${t1}, 'processing', ${randomUUID()}, ${t1}, ${t2}
      )
    `;

    const thirdMessage = await insertMessage("tx-message-3");
    await expect(
      db()`
        insert into provider_inbox_events (
          provider_event_id, event_type, message_id, sender_hash, occurred_at,
          state, claim_token, claimed_at, claim_expires_at
        )
        values (
          'tx-event-received-3', 'message_received', ${thirdMessage},
          ${farmerHash}, ${t2}, 'processing', ${randomUUID()}, ${t1}, ${t2}
        )
      `,
    ).rejects.toThrow();

    // Two concurrently processing delivery events do not contend for a sender claim.
    const secondAttempt = await db()`
      insert into outbox_dispatch_attempts (
        outbox_work_id, attempt_number, state, provider_message_id,
        started_at, completed_at
      )
      values (
        ${storedId("outbox1")}, 2, 'accepted', 'tx-provider-message-2',
        ${t1}, ${t2}
      )
      returning id
    `;
    await db()`
      insert into provider_inbox_events (
        provider_event_id, event_type, dispatch_attempt_id, delivery_status,
        occurred_at, state, claim_token, claimed_at, claim_expires_at
      )
      values (
        'tx-event-finalized-2', 'message_finalized',
        ${secondAttempt[0]?.id as string}, 'delivered', ${t2}, 'processing',
        ${randomUUID()}, ${t1}, ${t2}
      )
    `;
  });

  it("binds a proposal to its base revision and expires relative to activation", async () => {
    const proposalColumns = await db()`
      select column_name, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inventory_publication_proposals'
        and column_name in (
          'base_revision_id', 'base_is_first_publication', 'expires_at'
        )
      order by column_name
    `;
    expect(proposalColumns).toEqual([
      { column_name: "base_is_first_publication", is_nullable: "YES" },
      { column_name: "base_revision_id", is_nullable: "YES" },
      // Activation-relative: an unactivated proposal has no window at all.
      { column_name: "expires_at", is_nullable: "YES" },
    ]);

    // An unactivated proposal has no live window at all; expiry is activation-relative.
    const openProposal = await db()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, proposal_version,
        has_inventory, has_closure, base_is_first_publication
      )
      values (
        ${farmerHash}, ${storedId("location")}, ${db().json({ items: [] })},
        1, true, false, true
      )
      returning id, expires_at
    `;
    ids.proposal1 = openProposal[0]?.id as string;
    expect(openProposal[0]?.expires_at).toBeNull();

    // Activation stamps a 12-hour window measured from provider acceptance.
    await db()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at,
        available_at
      )
      values (
        'tx-prompt-1', ${farmerHash}, 'inventory_confirmation',
        'Confirm this inventory', ${tomorrow}, ${t0}
      )
      returning id
    `;
    const prompt = await db()`
      select id from outbox_work where logical_key = 'tx-prompt-1'
    `;
    ids.prompt1 = prompt[0]?.id as string;

    await db()`
      update inventory_publication_proposals
      set activation_outbox_id = ${storedId("prompt1")},
          activated_version = 1,
          activated_at = ${t1},
          expires_at = ${t1}::timestamptz + interval '12 hours'
      where id = ${storedId("proposal1")}
    `;

    // An activated proposal must carry the window that activation started.
    await expect(
      db()`
        update inventory_publication_proposals
        set expires_at = null
        where id = ${storedId("proposal1")}
      `,
    ).rejects.toThrow();

    // A first-publication proposal must not also name a base revision.
    await expect(
      db()`
        update inventory_publication_proposals
        set base_revision_id = ${storedId("proposal1")}
        where id = ${storedId("proposal1")}
      `,
    ).rejects.toThrow();
  });

  it("records proposal invalidation honestly without a draft revision", async () => {
    const states = await db()`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'proposal_state'
      order by enumsortorder
    `;
    expect(states.map((row) => row.enumlabel)).toEqual([
      "open",
      "accepted",
      "declined",
      "expired",
      "invalidated",
    ]);

    // Publish a revision so the next proposal can bind to a real base.
    await db()`
      update inventory_publication_proposals
      set state = 'accepted', consumed_token = 'yes',
          consumption_provider_event_id = 'tx-accept-1', closed_at = ${t1}
      where id = ${storedId("proposal1")}
    `;
    const revisions = await db()`
      insert into inventory_revisions (
        farm_id, sales_location_id, proposal_id,
        published_by_authorization_id, farm_approval_id, source, published_at
      )
      values (
        ${storedId("farm")}, ${storedId("location")}, ${storedId("proposal1")},
        ${storedId("authorization")}, ${storedId("approval")}, 'sms', ${t1}
      )
      returning id
    `;
    ids.revision1 = revisions[0]?.id as string;

    // A proposal bound to a base revision must not claim first publication.
    await expect(
      db()`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, payload, proposal_version,
          has_inventory, has_closure, base_revision_id,
          base_is_first_publication
        )
        values (
          ${farmerHash}, ${storedId("location")}, ${db().json({ items: [] })},
          1, true, false, ${storedId("revision1")}, true
        )
      `,
    ).rejects.toThrow();

    const bound = await db()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, proposal_version,
        has_inventory, has_closure, base_revision_id,
        base_is_first_publication
      )
      values (
        ${farmerHash}, ${storedId("location")}, ${db().json({ items: [] })},
        1, true, false, ${storedId("revision1")}, false
      )
      returning id
    `;
    ids.proposal2 = bound[0]?.id as string;

    // Invalidation closes the proposal without consuming a token or publishing.
    await db()`
      update inventory_publication_proposals
      set state = 'invalidated', closed_at = ${t2}
      where id = ${storedId("proposal2")}
    `;
    await expect(
      db()`
        update inventory_publication_proposals
        set consumed_token = 'yes'
        where id = ${storedId("proposal2")}
      `,
    ).rejects.toThrow();

    // An invalidated proposal frees the single open slot for its replacement.
    await db()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, proposal_version,
        has_inventory, has_closure, base_revision_id,
        base_is_first_publication
      )
      values (
        ${farmerHash}, ${storedId("location")}, ${db().json({ items: [] })},
        2, true, false, ${storedId("revision1")}, false
      )
    `;

    const revisionColumns = await db()`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inventory_revisions'
        and column_name in ('state', 'status', 'draft', 'is_draft')
    `;
    expect(revisionColumns).toHaveLength(0);
  });

  it("advances delivery state monotonically by provider occurrence time", async () => {
    const deliveryColumns = await db()`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'outbox_work'
        and column_name in (
          'delivery_status', 'delivery_occurred_at', 'delivery_event_id'
        )
      order by column_name
    `;
    expect(deliveryColumns.map((row) => row.column_name)).toEqual([
      "delivery_event_id",
      "delivery_occurred_at",
      "delivery_status",
    ]);

    const statuses = await db()`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'delivery_status'
      order by enumsortorder
    `;
    expect(statuses.map((row) => row.enumlabel)).toEqual([
      "sent",
      "delivered",
      "delivery_failed",
    ]);

    // The delivery watermark is coherent: a status implies its occurrence and event.
    await expect(
      db()`
        update outbox_work
        set delivery_status = 'delivered'
        where id = ${storedId("outbox1")}
      `,
    ).rejects.toThrow();

    await db()`
      update outbox_work
      set state = 'dispatching', dispatch_authorized_at = ${t0}
      where id = ${storedId("outbox1")}
    `;
    await db()`
      update outbox_work
      set state = 'sent', completed_at = ${t1},
          delivery_status = 'sent', delivery_occurred_at = ${t1},
          delivery_event_id = 'tx-event-sent-1'
      where id = ${storedId("outbox1")}
    `;

    // A terminal delivery result cannot be regressed by a late event.
    await db()`
      update outbox_work
      set delivery_status = 'delivered', delivery_occurred_at = ${t2},
          delivery_event_id = 'tx-event-finalized-2'
      where id = ${storedId("outbox1")}
    `;
    await expect(
      db()`
        update outbox_work
        set delivery_status = 'sent', delivery_occurred_at = ${t1},
            delivery_event_id = 'tx-event-sent-1'
        where id = ${storedId("outbox1")}
      `,
    ).rejects.toThrow();
  });
});
