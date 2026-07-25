import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

const dbPackage = resolve(process.cwd(), "packages/db");
const migrationsDir = resolve(dbPackage, "drizzle");
const schemaFile = resolve(dbPackage, "src/schema.ts");
const indexFile = resolve(dbPackage, "src/index.ts");
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

const expectedTables = [
  "administrators",
  "audit_events",
  "consent_transition_watermarks",
  "contacts",
  "farm_approvals",
  "farm_links",
  "farmer_authorizations",
  "farms",
  "flags",
  "inventory_entries",
  "inventory_publication_proposals",
  "inventory_revisions",
  "model_runs",
  "outbox_dispatch_attempts",
  "outbox_work",
  "provider_inbox_events",
  "sales_location_payment_methods",
  "sales_locations",
  "sender_states",
  "sms_consents",
  "sms_messages",
  "stock_out_reports",
];

describe("clean launch database foundation (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let testDatabaseName: string | undefined;
  let emptyTableCount = -1;

  const ids: Record<string, string> = {};
  const adminHash = "a".repeat(64);
  const farmerHash = "b".repeat(64);
  const customerHash = "c".repeat(64);
  const now = "2026-07-25T16:00:00.000Z";
  const later = "2026-07-25T17:00:00.000Z";
  const tomorrow = "2026-07-26T16:00:00.000Z";

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    client = postgres(testDatabaseUrl(baseUrl, testDatabaseName), { max: 1 });
    const before = await client`
      select count(*)::integer as count
      from pg_tables
      where schemaname not in ('pg_catalog', 'information_schema')
    `;
    emptyTableCount = before[0]?.count as number;

    await migrate(drizzle(client), {
      migrationsFolder: migrationsDir,
    });
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

  function db(): ReturnType<typeof postgres> {
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

  it("commits the executable initial migration with Drizzle metadata", () => {
    const migrationFiles = existsSync(migrationsDir)
      ? readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()
      : [];

    // The initial migration stays first and is never rewritten; later tranches add
    // forward migrations beside it.
    expect(migrationFiles[0]).toBe("0000_clean_launch.sql");
    expect(existsSync(resolve(migrationsDir, "meta/_journal.json"))).toBe(true);
    expect(
      existsSync(resolve(migrationsDir, "meta/0000_snapshot.json")),
    ).toBe(true);
  });

  it("removes forbidden concepts from schema, migration, metadata, and exports", () => {
    const artifactSource = [
      readFileSync(schemaFile, "utf8"),
      readFileSync(indexFile, "utf8"),
      readFileSync(resolve(migrationsDir, "0000_clean_launch.sql"), "utf8"),
      readFileSync(
        resolve(migrationsDir, "meta/0000_snapshot.json"),
        "utf8",
      ),
    ].join("\n");
    const forbidden = [
      /\btenant/i,
      /\bgleaning/i,
      /\bvolunteer/i,
      /\bprovenance\b/i,
      /\bclaim_status\b/i,
      /\brole_name\b/i,
      /\bperson_roles\b/i,
      /\bprogram_(?:id|key|name|discriminator)\b/i,
      /\binventory_status\b/i,
      /['"]draft['"]/i,
      /\bfollow_up\b/i,
      /\bMUTE\b/,
    ];

    for (const pattern of forbidden) {
      expect(artifactSource, `database artifact contains ${pattern}`).not.toMatch(
        pattern,
      );
    }
  });

  it("migrates a newly created empty Postgres database and is journal-idempotent", async () => {
    expect(emptyTableCount).toBe(0);

    const tableRows = await db()`
      select tablename
      from pg_tables
      where schemaname = 'public'
      order by tablename
    `;
    expect(tableRows.map((row) => row.tablename)).toEqual(expectedTables);

    const farmCount = await db()`select count(*)::integer as count from farms`;
    expect(farmCount[0]?.count).toBe(0);

    const journal = JSON.parse(
      readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: unknown[] };

    const before = await db()`
      select count(*)::integer as count from drizzle.__drizzle_migrations
    `;
    await migrate(drizzle(db()), { migrationsFolder: migrationsDir });
    const after = await db()`
      select count(*)::integer as count from drizzle.__drizzle_migrations
    `;
    // Every committed migration applied once, and a second run is a no-op.
    expect(before[0]?.count).toBe(journal.entries.length);
    expect(after[0]?.count).toBe(journal.entries.length);
  });

  it("stores normalized raw E.164 once and uses the unique hash elsewhere", async () => {
    const rawPhoneColumns = await db()`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public' and column_name = 'phone_e164'
    `;
    expect(rawPhoneColumns).toEqual([
      { table_name: "contacts", column_name: "phone_e164" },
    ]);

    await expect(
      db()`
        insert into contacts (phone_e164, phone_hash)
        values ('206-555-0100', ${"x".repeat(64)})
      `,
    ).rejects.toThrow();

    const contacts = await db()`
      insert into contacts (phone_e164, phone_hash)
      values
        ('+12065550101', ${adminHash}),
        ('+12065550102', ${farmerHash}),
        ('+12065550103', ${customerHash})
      returning id, phone_hash
    `;
    for (const contact of contacts) {
      ids[contact.phone_hash as string] = contact.id as string;
    }

    await expect(
      db()`
        insert into contacts (phone_e164, phone_hash)
        values ('+12065550199', ${farmerHash})
      `,
    ).rejects.toThrow();

    const rawPhoneOutsideContacts = await db()`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name <> 'contacts'
        and column_name in ('phone', 'phone_number', 'phone_e164', 'raw_phone')
    `;
    expect(rawPhoneOutsideContacts).toHaveLength(0);
  });

  it("separates administrator authority, farmer authority, and VIGA approval", async () => {
    const adminRows = await db()`
      insert into administrators (contact_id, authorized_at)
      values (${storedId(adminHash)}, ${now})
      returning id
    `;
    ids.administrator = adminRows[0]?.id as string;

    const farmRows = await db()`
      insert into farms (name, map_projection, public_latitude, public_longitude)
      values
        ('Exact Projection Farm', 'exact', 47.45, -122.46),
        ('Approximate Projection Farm', 'approximate', 47.46, -122.47),
        ('Hidden Projection Farm', 'hidden', null, null),
        ('Sales Location Farm', null, null, null)
      returning id, name
    `;
    for (const farm of farmRows) {
      ids[farm.name as string] = farm.id as string;
    }
    ids.farm = storedId("Sales Location Farm");

    await expect(
      db()`
        insert into farms (
          name, map_projection, public_latitude, public_longitude
        )
        values ('Invalid Hidden Projection', 'hidden', 47.4, -122.4)
      `,
    ).rejects.toThrow();
    await expect(
      db()`
        insert into farms (
          name, map_projection, public_latitude, public_longitude
        )
        values ('Incomplete Approximation', 'approximate', 47.4, null)
      `,
    ).rejects.toThrow();

    const authorizationRows = await db()`
      insert into farmer_authorizations (
        farm_id, contact_id, phone_verified_at, authorized_at
      )
      values (${storedId("farm")}, ${storedId(farmerHash)}, ${now}, ${later})
      returning id
    `;
    ids.authorization = authorizationRows[0]?.id as string;

    const approvalRows = await db()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${storedId("farm")}, ${storedId("administrator")}, ${later})
      returning id
    `;
    ids.approval = approvalRows[0]?.id as string;

    await expect(
      db()`
        insert into farmer_authorizations (
          farm_id, contact_id, phone_verified_at, authorized_at, revoked_at
        )
        values (
          ${storedId("Approximate Projection Farm")},
          ${storedId(customerHash)},
          ${now},
          ${later},
          ${now}
        )
      `,
    ).rejects.toThrow();

    const authorityTables = await db()`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'administrators', 'farmer_authorizations', 'farm_approvals'
        )
      order by table_name
    `;
    expect(authorityTables.map((row) => row.table_name)).toEqual([
      "administrators",
      "farm_approvals",
      "farmer_authorizations",
    ]);
  });

  it("keeps contextual farm projections separate from actionable sales locations", async () => {
    await expect(
      db()`
        insert into sales_locations (
          farm_id, kind, name, public_address, public_latitude,
          public_longitude, farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${storedId("Exact Projection Farm")}, 'farm_stand',
          'Conflicting Public Location', '0 Stand Way',
          47.45, -122.46, false, false
        )
      `,
    ).rejects.toThrow();

    const locationRows = await db()`
      insert into sales_locations (
        farm_id, kind, name, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible
      )
      values
        (
          ${storedId("farm")}, 'farm_stand', 'Exact Farm Stand', '1 Stand Way',
          47.45, -122.46, true, true
        ),
        (
          ${storedId("farm")}, 'farmers_market', 'VIGA Farmers Market',
          '2 Market Way', 47.44, -122.45, false, true
        )
      returning id, kind
    `;
    for (const location of locationRows) {
      ids[location.kind as string] = location.id as string;
    }
    ids.location = storedId("farm_stand");

    await expect(
      db()`
        insert into sales_locations (
          farm_id, kind, name, public_address, public_latitude,
          public_longitude, farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${storedId("farm")}, 'farm_stand', 'Bad Coordinates', '3 Stand Way',
          91, -122.4, false, false
        )
      `,
    ).rejects.toThrow();
    await expect(
      db()`
        insert into sales_locations (
          farm_id, kind, name, public_address, public_latitude,
          public_longitude, farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${storedId("farm")}, 'farm_stand', 'Bad Farm Bucks Fact', '4 Stand Way',
          47.4, -122.4, true, false
        )
      `,
    ).rejects.toThrow();

    await db()`
      insert into sales_location_payment_methods (sales_location_id, method)
      values (${storedId("location")}, 'cash'), (${storedId("location")}, 'card')
    `;
    await db()`
      insert into farm_links (farm_id, label, url)
      values (${storedId("farm")}, 'Farm website', 'https://example.test/farm')
    `;

    const kinds = await db()`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'sales_location_kind'
      order by enumsortorder
    `;
    expect(kinds.map((row) => row.enumlabel)).toEqual([
      "farm_stand",
      "farmers_market",
    ]);
  });

  it("bounds inbox claims, retained messages, consent, and transition evidence", async () => {
    await expect(
      db()`
        insert into sms_messages (
          provider_message_id, sender_hash, body, received_at
        )
        values ('message-without-expiry', ${farmerHash}, 'hello', ${now})
      `,
    ).rejects.toThrow();

    const messages = await db()`
      insert into sms_messages (
        provider_message_id, sender_hash, body, body_expires_at, received_at
      )
      values
        ('message-1', ${farmerHash}, 'first', ${tomorrow}, ${now}),
        ('message-2', ${farmerHash}, 'second', ${tomorrow}, ${now})
      returning id, provider_message_id
    `;
    for (const message of messages) {
      ids[message.provider_message_id as string] = message.id as string;
    }

    await db()`
      insert into provider_inbox_events (
        provider_event_id, message_id, sender_hash, occurred_at, state,
        claim_token, claimed_at, claim_expires_at
      )
      values (
        'event-1', ${storedId("message-1")}, ${farmerHash}, ${now}, 'processing',
        ${randomUUID()}, ${now}, ${later}
      )
    `;
    await expect(
      db()`
        insert into provider_inbox_events (
          provider_event_id, message_id, sender_hash, occurred_at, state,
          claim_token, claimed_at, claim_expires_at
        )
        values (
          'event-2', ${storedId("message-2")}, ${farmerHash}, ${later}, 'processing',
          ${randomUUID()}, ${now}, ${later}
        )
      `,
    ).rejects.toThrow();
    await expect(
      db()`
        insert into provider_inbox_events (
          provider_event_id, message_id, sender_hash, occurred_at
        )
        values ('event-1', ${storedId("message-2")}, ${farmerHash}, ${later})
      `,
    ).rejects.toThrow();

    await expect(
      db()`
        insert into sms_consents (recipient_hash, state, updated_at)
        values (${farmerHash}, 'active', ${now})
      `,
    ).rejects.toThrow();
    await db()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at,
        capture_evidence_ref, updated_at
      )
      values (
        ${farmerHash}, 'active', 'farmer_onboarding', ${now},
        'onboarding-verification-1', ${now}
      )
    `;
    await expect(
      db()`
        insert into sms_consents (
          recipient_hash, state, capture_source, captured_at,
          capture_evidence_ref, updated_at
        )
        values (
          ${farmerHash}, 'active', 'start', ${later}, 'event-2', ${later}
        )
      `,
    ).rejects.toThrow();

    await db()`
      insert into consent_transition_watermarks (
        recipient_hash, transition, occurred_at, provider_event_id
      )
      values (${farmerHash}, 'start', ${now}, 'consent-event-1')
    `;
  });

  it("enforces one activated, versioned open publication proposal per sender", async () => {
    const promptRows = await db()`
      insert into outbox_work (
        logical_key, recipient_hash, message_kind, body, body_expires_at,
        available_at
      )
      values (
        'proposal-prompt-1', ${farmerHash}, 'inventory_confirmation',
        'Confirm this inventory', ${tomorrow}, ${now}
      )
      returning id
    `;
    ids.prompt1 = promptRows[0]?.id as string;

    const proposalRows = await db()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version,
        proposal_version, yes_token, no_token, base_is_first_publication,
        expires_at, activation_outbox_id, activated_version, activated_at
      )
      values (
        ${farmerHash}, ${storedId("location")}, ${db().json({ items: [] })}, '1',
        1, 'YES', 'NO', true, ${tomorrow}, ${storedId("prompt1")}, 1, ${later}
      )
      returning id
    `;
    ids.proposal1 = proposalRows[0]?.id as string;

    await expect(
      db()`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, payload, schema_version,
          proposal_version, yes_token, no_token, base_is_first_publication
        )
        values (
          ${farmerHash}, ${storedId("location")}, ${db().json({ items: [] })}, '1',
          1, 'YES', 'NO', true
        )
      `,
    ).rejects.toThrow();

    await expect(
      db()`
        update inventory_publication_proposals
        set state = 'accepted', consumed_token = 'yes',
            consumption_provider_event_id = 'accept-too-old',
            closed_at = ${later}, proposal_version = 2
        where id = ${storedId("proposal1")}
      `,
    ).rejects.toThrow();

    await db()`
      update inventory_publication_proposals
      set state = 'accepted', consumed_token = 'yes',
          consumption_provider_event_id = 'accept-1', closed_at = ${later}
      where id = ${storedId("proposal1")}
    `;
  });

  it("keeps inventory publication-only, current per location, and immutable", async () => {
    const revisionRows = await db()`
      insert into inventory_revisions (
        farm_id, sales_location_id, proposal_id,
        published_by_authorization_id, farm_approval_id, published_at
      )
      values (
        ${storedId("farm")}, ${storedId("location")}, ${storedId("proposal1")},
        ${storedId("authorization")}, ${storedId("approval")}, ${later}
      )
      returning id
    `;
    ids.revision1 = revisionRows[0]?.id as string;

    const entryRows = await db()`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, approximation
      )
      values (${storedId("revision1")}, ${storedId("location")}, 'Seasonal item', 'some')
      returning id
    `;
    ids.entry1 = entryRows[0]?.id as string;

    await expect(
      db()`
        update inventory_entries set item_name = 'Changed'
        where id = ${storedId("entry1")}
      `,
    ).rejects.toThrow();

    const secondPromptRows = await db()`
      insert into outbox_work (
        logical_key, recipient_hash, message_kind, body, body_expires_at,
        available_at
      )
      values (
        'proposal-prompt-2', ${farmerHash}, 'inventory_confirmation',
        'Confirm revised inventory', ${tomorrow}, ${now}
      )
      returning id
    `;
    const secondPromptId = secondPromptRows[0]?.id as string;
    const secondProposalRows = await db()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version,
        proposal_version, yes_token, no_token, base_is_first_publication,
        state, expires_at, activation_outbox_id, activated_version,
        activated_at, consumed_token, consumption_provider_event_id, closed_at
      )
      values (
        ${farmerHash}, ${storedId("location")},
        ${db().json({ items: [{ name: "Revised item" }] })}, '1',
        1, 'YES', 'NO', true, 'accepted', ${tomorrow},
        ${secondPromptId}, 1, ${later}, 'yes', 'accept-2', ${later}
      )
      returning id
    `;
    const secondProposalId = secondProposalRows[0]?.id as string;

    await expect(
      db()`
        insert into inventory_revisions (
          farm_id, sales_location_id, proposal_id,
          published_by_authorization_id, farm_approval_id, published_at
        )
        values (
          ${storedId("farm")}, ${storedId("location")}, ${secondProposalId},
          ${storedId("authorization")}, ${storedId("approval")}, ${tomorrow}
        )
      `,
    ).rejects.toThrow();

    await db()`
      update inventory_revisions
      set is_current = false, superseded_at = ${tomorrow}
      where id = ${storedId("revision1")}
    `;
    await db()`
      insert into inventory_revisions (
        farm_id, sales_location_id, proposal_id,
        published_by_authorization_id, farm_approval_id, published_at
      )
      values (
        ${storedId("farm")}, ${storedId("location")}, ${secondProposalId},
        ${storedId("authorization")}, ${storedId("approval")}, ${tomorrow}
      )
    `;
    await expect(
      db()`
        update inventory_revisions set published_at = ${tomorrow}
        where id = ${storedId("revision1")}
      `,
    ).rejects.toThrow();

    const inventoryColumns = await db()`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('inventory_revisions', 'inventory_entries')
        and column_name in ('status', 'draft', 'provenance', 'claim_status')
    `;
    expect(inventoryColumns).toHaveLength(0);
  });

  it("keeps private stock-out reports location-bound and structurally separate", async () => {
    await db()`
      insert into stock_out_reports (
        sales_location_id, referenced_inventory_entry_id
      )
      values (${storedId("location")}, ${storedId("entry1")})
    `;
    await db()`
      insert into stock_out_reports (sales_location_id, unlisted_item_text)
      values (${storedId("farmers_market")}, 'Unlisted seasonal item')
    `;

    await expect(
      db()`
        insert into stock_out_reports (sales_location_id)
        values (${storedId("location")})
      `,
    ).rejects.toThrow();
    await expect(
      db()`
        insert into stock_out_reports (
          sales_location_id, referenced_inventory_entry_id
        )
        values (${storedId("farmers_market")}, ${storedId("entry1")})
      `,
    ).rejects.toThrow();

    const mutationColumns = await db()`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'stock_out_reports'
        and column_name in (
          'quantity', 'availability', 'inventory_status',
          'inventory_revision_id'
        )
    `;
    expect(mutationColumns).toHaveLength(0);
  });

  it("bounds logical outbox work and dispatch attempts without carrier exactly-once claims", async () => {
    await expect(
      db()`
        insert into outbox_work (
          logical_key, recipient_hash, message_kind, body, body_expires_at,
          available_at
        )
        values (
          'proposal-prompt-1', ${farmerHash}, 'duplicate', 'duplicate',
          ${tomorrow}, ${now}
        )
      `,
    ).rejects.toThrow();

    await expect(
      db()`
        insert into outbox_dispatch_attempts (
          outbox_work_id, attempt_number, state, started_at
        )
        values (${storedId("prompt1")}, 4, 'authorized', ${now})
      `,
    ).rejects.toThrow();
    await expect(
      db()`
        insert into outbox_dispatch_attempts (
          outbox_work_id, attempt_number, state, started_at, completed_at
        )
        values (${storedId("prompt1")}, 1, 'accepted', ${now}, ${later})
      `,
    ).rejects.toThrow();

    const rawRecipientColumns = await db()`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('outbox_work', 'outbox_dispatch_attempts')
        and column_name in ('phone', 'phone_number', 'phone_e164', 'raw_phone')
    `;
    expect(rawRecipientColumns).toHaveLength(0);

    const exactlyOnceNames = await db()`
      select indexname
      from pg_indexes
      where schemaname = 'public' and indexname ilike '%exactly_once%'
    `;
    expect(exactlyOnceNames).toHaveLength(0);
  });

  it("keeps audit and model-run evidence content-free", async () => {
    await db()`
      insert into audit_events (
        action, actor_contact_hash, subject_type, subject_id
      )
      values (
        'inventory.published', ${farmerHash}, 'inventory_revision',
        ${storedId("revision1")}
      )
    `;
    await db()`
      insert into model_runs (
        seam, provider, model, schema_version, validation_status,
        opaque_refs, latency_ms, input_tokens, output_tokens, cost_micros,
        started_at, completed_at
      )
      values (
        'inventory_interpretation', 'test-provider', 'test-model', '1',
        'passed', ${db().json([storedId("proposal1")])},
        10, 20, 10, 5, ${now}, ${later}
      )
    `;

    const contentColumns = await db()`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('audit_events', 'model_runs')
        and column_name in (
          'body', 'content', 'message_text', 'model_input', 'model_output',
          'prompt', 'response', 'phone_e164'
        )
    `;
    expect(contentColumns).toHaveLength(0);

    const modelColumns = await db()`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'model_runs'
      order by ordinal_position
    `;
    expect(modelColumns.map((row) => row.column_name)).toEqual([
      "id",
      "seam",
      "provider",
      "model",
      "schema_version",
      "validation_status",
      "repair_count",
      "opaque_refs",
      "latency_ms",
      "input_tokens",
      "output_tokens",
      "cost_micros",
      "started_at",
      "completed_at",
    ]);
  });
});
