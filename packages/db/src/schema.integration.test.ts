import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
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
  "admin_login_failures",
  "admin_sessions",
  // F-074 — who may see test farms over SMS. Hashes only; no raw number, because nothing on
  // this path ever sends to it.
  "administrator_phones",
  "administrators",
  "audit_events",
  "closure_revisions",
  "consent_transition_watermarks",
  "contacts",
  "farm_approvals",
  // F-079 — an issued verification code, and the publish grant redeeming it produces. Hashed at
  // rest like every other credential; the email HASH only, never a second copy of the address.
  // Its partial unique index is what makes "one live code per farm" a database guarantee.
  "farm_email_verifications",
  // F-078 — the email roster VIGA already holds, so a farmer can prove who they are without a
  // volunteer vouching for them. Raw address in exactly one column read only by the send path;
  // the hash is the only lookup key. Golden Rule #5, applied to a second kind of personal data.
  "farm_emails",
  "farm_links",
  "farmer_authorizations",
  "farmer_invitations",
  // F-040 — the two records that close the chain from "a farmer texts us" to "that farmer
  // can publish". Neither is an authorization: a request grants nothing, and a link is a
  // pointer to one.
  "farmer_links",
  "farmer_onboarding_requests",
  "farmer_target_contexts",
  "farmer_target_menu_options",
  "farms",
  "flags",
  "inventory_entries",
  "inventory_prompt_preferences",
  "inventory_publication_proposals",
  "inventory_revisions",
  "model_runs",
  "outbox_dispatch_attempts",
  "outbox_work",
  // F-046 — the pending result list `MORE` pages through.
  "pending_result_lists",
  // B-065 — the stock-out report held between a clarifying question and its answer.
  "pending_stock_out_reports",
  "provider_inbox_events",
  "sales_location_offerings",
  "sales_location_participants",
  "sales_location_payment_methods",
  "sales_locations",
  "scheduled_inventory_prompt_subjects",
  "sender_states",
  "sms_consents",
  "sms_messages",
  "stand_data_flags",
  // F-066 — one item vocabulary per stand, carrying both the standing state and the
  // confirmations. `sales_location_offerings` remains only as the 0020 backfill's source.
  "stand_items",
  "stock_out_reports",
];

describe("clean launch database foundation (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let testDatabaseName: string | undefined;
  let emptyTableCount = -1;

  const ids: Record<string, string> = {};
  const adminHash = "a".repeat(64);
  const farmerHash = "b".repeat(64);
  const customerHash = "c".repeat(64);
  // Anchored to the real clock, not a calendar date: `outbox_work` enforces
  // `body_expires_at > created_at` against a `now()` default, so a literal date silently
  // expires. See the header note in workflow.integration.test.ts.
  //
  // The guard test "integration fixtures carry no hard-coded calendar dates" below keeps
  // this from creeping back in.
  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const offset = (hours: number) => new Date(anchor + hours * 60 * 60 * 1000).toISOString();
  const now = offset(0);
  const later = offset(1);
  const tomorrow = offset(48);

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
      // F-027 assembles this term from fragments rather than writing it literally, so that the
      // application-source tripwire in packages/core/src/architecture.test.ts can scan EVERY
      // source with no carve-outs — including the files that forbid the concept.
      new RegExp(`\\b${["ten", "ant"].join("")}`, "i"),
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
      // F-016 — launch is ONE registered operational program. No enrollment table, no
      // per-category consent, and no passive follow-up subscription may appear.
      /\bfollow_up_interest\b/i,
      /\bprogram_enrollment/i,
      /\bconsent_program/i,
      /\bsubscriptions?\b/i,
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
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${now})
      returning id
    `;
    ids.administrator = adminRows[0]?.id as string;

    expect(await db()`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'administrators'
        and column_name = 'contact_id'
    `).toHaveLength(0);

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
    // `name` then `timezone`, matching the column list. Those two were transposed here, so
    // this insert failed on an invalid timezone enum value rather than on the rule under
    // test, and the assertion passed for the wrong reason. Found 2026-08-10, when dropping
    // the farm-bucks CHECK removed the other accidental source of an error in this block.
    await expect(
      db()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude,
          public_longitude, farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${storedId("Exact Projection Farm")}, 'farm_stand',
          'Conflicting Public Location', 'America/Los_Angeles', 'visitable', 'produce',
          '0 Stand Way', 47.45, -122.46, false, false
        )
      `,
    ).rejects.toThrow();

    const locationRows = await db()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible
      )
      values
        (
          ${storedId("farm")}, 'farm_stand', 'Exact Farm Stand', 'America/Los_Angeles', 'visitable', 'produce', '1 Stand Way',
          47.45, -122.46, true, true
        ),
        (
          ${storedId("farm")}, 'farmers_market', 'VIGA Farmers Market', 'America/Los_Angeles',
          'visitable', 'produce', '2 Market Way', 47.44, -122.45, false, true
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
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude,
          public_longitude, farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${storedId("farm")}, 'farm_stand', 'Bad Coordinates', 'America/Los_Angeles', 'visitable', 'produce', '3 Stand Way',
          91, -122.4, false, false
        )
      `,
    ).rejects.toThrow();
    // Acceptance without eligibility is now ALLOWED (max, 2026-08-10). The CHECK
    // `sales_locations_farm_bucks_acceptance_requires_eligibility` was dropped in `0037`:
    // eligibility is VIGA's own record, and gating the farmer's claim on it made the
    // onboarding toggle unreachable for every new farm, since eligibility lives on a stand
    // row that does not exist until onboarding saves.
    await db()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${storedId("farm")}, 'farm_stand', 'Accepted Not Yet Eligible', 'America/Los_Angeles', 'visitable', 'produce', '4 Stand Way',
        47.4, -122.4, true, false
      )
    `;
    expect(
      await db()`
        select farm_bucks_accepted, farm_bucks_eligible from sales_locations
        where name = 'Accepted Not Yet Eligible'
      `,
    ).toEqual([{ farm_bucks_accepted: true, farm_bucks_eligible: false }]);

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

  it("keeps launch consent to one program with no future-program key (F-016)", async () => {
    // The consent record carries state and provenance only. A program/category/topic
    // column here would BE the speculative future-program enrollment the contract
    // forbids, so its absence is the structural claim worth pinning.
    const consentColumns = await db()`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'sms_consents'
      order by ordinal_position
    `;
    expect(consentColumns.map((row) => row.column_name)).toEqual([
      "recipient_hash",
      "state",
      "capture_source",
      "captured_at",
      "capture_evidence_ref",
      "updated_at",
    ]);

    // Only the two registered opt-in spellings plus documented onboarding may establish
    // consent — all of them establishing the SAME one program.
    const sources = await db()`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'consent_capture_source'
      order by enumsortorder
    `;
    expect(sources.map((row) => row.enumlabel)).toEqual([
      "join",
      "start",
      "farmer_onboarding",
    ]);

    // Launch message categories are bounded and live inside that one program. A new
    // category is a deliberate edit here, never an implicit new enrollment.
    const categories = await db()`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'message_category'
      order by enumsortorder
    `;
    expect(categories.map((row) => row.enumlabel)).toEqual([
      "required_reply",
      "inquiry_reply",
      "inventory_prompt",
      "inventory_confirmation",
      "stock_out_alert",
    ]);

    // The superseded pair is gone from the migrated database. This is asserted against
    // the live schema rather than the migration text, because 0000 and 0002 must keep
    // naming the old columns in order to create and then drop them.
    const supersededColumns = await db()`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'outbox_work'
        and column_name in ('message_kind', 'is_required')
    `;
    expect(supersededColumns).toHaveLength(0);

    // No table anywhere models a customer's interest in being notified later.
    const followUpTables = await db()`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and (
          table_name ilike '%follow%'
          or table_name ilike '%subscription%'
          or table_name ilike '%enrollment%'
        )
    `;
    expect(followUpTables).toHaveLength(0);
  });

  it("enforces one activated, versioned open publication proposal per sender", async () => {
    const promptRows = await db()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at,
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
        sender_hash, sales_location_id, payload, proposal_version,
        has_inventory, has_closure, base_is_first_publication,
        expires_at, activation_outbox_id, activated_version, activated_at
      )
      values (
        ${farmerHash}, ${storedId("location")}, ${db().json({ items: [] })},
        1, true, false, true, ${tomorrow}, ${storedId("prompt1")}, 1, ${later}
      )
      returning id
    `;
    ids.proposal1 = proposalRows[0]?.id as string;

    await expect(
      db()`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, payload, proposal_version,
          has_inventory, has_closure, base_is_first_publication
        )
        values (
          ${farmerHash}, ${storedId("location")}, ${db().json({ items: [] })},
          1, true, false, true
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
        published_by_authorization_id, farm_approval_id, source, published_at
      )
      values (
        ${storedId("farm")}, ${storedId("location")}, ${storedId("proposal1")},
        ${storedId("authorization")}, ${storedId("approval")}, 'sms', ${later}
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
        logical_key, recipient_hash, message_category, body, body_expires_at,
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
        sender_hash, sales_location_id, payload, proposal_version,
        has_inventory, has_closure, base_is_first_publication,
        state, expires_at, activation_outbox_id, activated_version,
        activated_at, consumed_token, consumption_provider_event_id, closed_at
      )
      values (
        ${farmerHash}, ${storedId("location")},
        ${db().json({ items: [{ name: "Revised item" }] })},
        1, true, false, true, 'accepted', ${tomorrow},
        ${secondPromptId}, 1, ${later}, 'yes', 'accept-2', ${later}
      )
      returning id
    `;
    const secondProposalId = secondProposalRows[0]?.id as string;

    await expect(
      db()`
        insert into inventory_revisions (
          farm_id, sales_location_id, proposal_id,
          published_by_authorization_id, farm_approval_id, source, published_at
        )
        values (
          ${storedId("farm")}, ${storedId("location")}, ${secondProposalId},
          ${storedId("authorization")}, ${storedId("approval")}, 'sms', ${tomorrow}
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
        published_by_authorization_id, farm_approval_id, source, published_at
      )
      values (
        ${storedId("farm")}, ${storedId("location")}, ${secondProposalId},
        ${storedId("authorization")}, ${storedId("approval")}, 'sms', ${tomorrow}
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

  /*
    B-057 — a report may name the stand's USUAL offering, not only its published inventory.

    The third reference is a column of its own rather than a widening of either existing one.
    A `stand_items` row and an `inventory_entries` row are different facts: one is what the
    stand usually carries, the other what the farmer last confirmed. Collapsing them would
    make VIGA's queue unable to tell an operator which of the two a report matched, and would
    silently drop the composite foreign key that proves the item belongs to the BOUND stand.
  */
  it("binds a stock-out report's usual-offering reference to the same stand", async () => {
    const items = await db()`
      insert into stand_items (sales_location_id, display_name, usually_carried)
      values (${storedId("location")}, 'Duck eggs', false)
      returning id
    `;
    const itemId = items[0]?.id as string;

    await db()`
      insert into stock_out_reports (sales_location_id, referenced_stand_item_id)
      values (${storedId("location")}, ${itemId})
    `;

    // A hostile or buggy writer pointing at a stand item belonging to ANOTHER location is
    // refused by the composite key, exactly as the inventory-entry reference already is.
    await expect(
      db()`
        insert into stock_out_reports (sales_location_id, referenced_stand_item_id)
        values (${storedId("farmers_market")}, ${itemId})
      `,
    ).rejects.toThrow();

    // Exactly one of the three references, still. Two at once is not a report we can render.
    await expect(
      db()`
        insert into stock_out_reports (
          sales_location_id, referenced_stand_item_id, unlisted_item_text
        )
        values (${storedId("location")}, ${itemId}, 'duck eggs')
      `,
    ).rejects.toThrow();
    await expect(
      db()`
        insert into stock_out_reports (
          sales_location_id, referenced_stand_item_id, referenced_inventory_entry_id
        )
        values (${storedId("location")}, ${itemId}, ${storedId("entry1")})
      `,
    ).rejects.toThrow();
  });

  it("bounds logical outbox work and dispatch attempts without carrier exactly-once claims", async () => {
    await expect(
      db()`
        insert into outbox_work (
          logical_key, recipient_hash, message_category, body, body_expires_at,
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

  describe("structured stand availability (F-035)", () => {
    // The enums are only worth having if the DATABASE refuses an incoherent combination.
    // Otherwise a `date_range` with no dates loads silently and every reader downstream needs
    // a defensive branch for a state that should never have been written.
    //
    // Each test here inserts a row that a careless seeder could plausibly produce.

    /** A minimal valid location, with F-035 fields supplied by the caller. */
    async function insertLocation(
      fields: Record<string, unknown>,
    ): Promise<void> {
      const columns = Object.keys(fields);
      const base = `insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible${columns.length ? ", " + columns.map((c) => `"${c}"`).join(", ") : ""}
      ) values (
        '${storedId("farm")}', 'farm_stand', 'Constraint Probe ${randomUUID()}', 'America/Los_Angeles', 'visitable', 'produce', '9 Probe Way',
        47.45, -122.46, false, true${columns.length ? ", " + columns.map((_, i) => `$${i + 1}`).join(", ") : ""}
      )`;
      await db().unsafe(base, Object.values(fields) as never[]);
    }

    it("accepts every open-hours kind with exactly the detail it needs", async () => {
      // The relative kinds carry no clock times — that is the point of having them.
      for (const kind of ["dawn_to_dusk", "daylight_hours", "all_day", "by_appointment"]) {
        await expect(insertLocation({ open_hours_kind: kind })).resolves.not.toThrow();
      }
      await expect(
        insertLocation({
          open_hours_kind: "clock_range",
          open_from_minutes: 600,
          open_until_minutes: 1140,
        }),
      ).resolves.not.toThrow();
      // `until_dusk` has a start but deliberately no end.
      await expect(
        insertLocation({ open_hours_kind: "until_dusk", open_from_minutes: 600 }),
      ).resolves.not.toThrow();
    });

    it("refuses a clock range with no clock times", async () => {
      await expect(insertLocation({ open_hours_kind: "clock_range" })).rejects.toThrow();
    });

    it("refuses clock times on a kind that has none", async () => {
      // The failure this prevents: storing dawn-to-dusk as 06:00–20:00 and thereby inventing
      // a precision the farmer never stated. Dusk on Vashon moves ~6 hours across the season.
      await expect(
        insertLocation({ open_hours_kind: "dawn_to_dusk", open_from_minutes: 360 }),
      ).rejects.toThrow();
      await expect(
        insertLocation({ open_hours_kind: "all_day", open_until_minutes: 1200 }),
      ).rejects.toThrow();
    });

    it("refuses an out-of-range time of day", async () => {
      await expect(
        insertLocation({
          open_hours_kind: "clock_range",
          open_from_minutes: 600,
          open_until_minutes: 1440,
        }),
      ).rejects.toThrow();
    });

    it("accepts each season kind with its own required detail", async () => {
      await expect(insertLocation({ season_kind: "year_round" })).resolves.not.toThrow();
      await expect(
        insertLocation({
          season_kind: "date_range",
          season_start_month: 5,
          season_start_day: 1,
          season_end_month: 11,
          season_end_day: 1,
        }),
      ).resolves.not.toThrow();
      await expect(
        insertLocation({ season_kind: "named_season", season_names: ["spring", "fall"] }),
      ).resolves.not.toThrow();
      await expect(
        insertLocation({
          season_kind: "open_ended",
          season_start_month: 6,
          season_start_day: 1,
        }),
      ).resolves.not.toThrow();
    });

    it("refuses a date range missing an endpoint", async () => {
      await expect(
        insertLocation({
          season_kind: "date_range",
          season_start_month: 5,
          season_start_day: 1,
          season_end_month: 11,
        }),
      ).rejects.toThrow();
    });

    it("refuses an open-ended season that carries an end", async () => {
      // "June 1 - TBD" means the end is genuinely unknown. Storing one would be an invention.
      await expect(
        insertLocation({
          season_kind: "open_ended",
          season_start_month: 6,
          season_start_day: 1,
          season_end_month: 10,
          season_end_day: 15,
        }),
      ).rejects.toThrow();
    });

    it("refuses a named season with no names, and a month out of range", async () => {
      await expect(insertLocation({ season_kind: "named_season" })).rejects.toThrow();
      await expect(
        insertLocation({
          season_kind: "date_range",
          season_start_month: 13,
          season_start_day: 1,
          season_end_month: 11,
          season_end_day: 1,
        }),
      ).rejects.toThrow();
    });

    it("keeps year_round distinct from an unknown season", async () => {
      // Both are legal, and they mean different things: "open all year" is a fact, a null
      // season is an absence. A filter must be able to tell them apart, so `year_round`
      // exists as a value rather than being encoded as null-null.
      await expect(insertLocation({ season_kind: "year_round" })).resolves.not.toThrow();
      await expect(insertLocation({})).resolves.not.toThrow();

      const rows = await db()`
        select count(*) filter (where season_kind = 'year_round')::integer as year_round,
               count(*) filter (where season_kind is null)::integer as unknown_season
        from sales_locations
      `;
      expect(rows[0]!.year_round as number).toBeGreaterThan(0);
      expect(rows[0]!.unknown_season as number).toBeGreaterThan(0);
    });

    it("refuses a year_round season that also carries dates", async () => {
      await expect(
        insertLocation({
          season_kind: "year_round",
          season_start_month: 3,
          season_start_day: 1,
        }),
      ).rejects.toThrow();
    });

    it("requires days exactly when the cadence is specific_days", async () => {
      await expect(
        insertLocation({ stocking_cadence: "specific_days", stocking_days: [2, 5] }),
      ).resolves.not.toThrow();
      // Promising specific days without saying which is the one incoherent cadence.
      await expect(
        insertLocation({ stocking_cadence: "specific_days" }),
      ).rejects.toThrow();
      await expect(
        insertLocation({ stocking_cadence: "daily", stocking_days: [2] }),
      ).rejects.toThrow();
    });

    it("treats variable, as_needed and intermittent as real answers", async () => {
      // Not missing data. "We restock as stock runs low" is an honest description of an
      // honor-system stand, and as NULL it would be indistinguishable from never having asked.
      for (const cadence of ["variable", "as_needed", "intermittent", "daily"]) {
        await expect(
          insertLocation({ stocking_cadence: cadence }),
        ).resolves.not.toThrow();
      }
    });

    it("refuses an empty or invalid day set", async () => {
      // An empty array asserts "open on no day", which no stand means and which NULL
      // ("not stated") already expresses.
      await expect(insertLocation({ open_days: [] })).rejects.toThrow();
      await expect(insertLocation({ open_days: [7] })).rejects.toThrow();
      await expect(insertLocation({ open_days: [0, 6] })).resolves.not.toThrow();
    });
  });

  describe("specialties are not current stock (F-035)", () => {
    // A location of this suite's own, deliberately never given an inventory revision. The
    // shared `ids.location` accumulates one from the workflow tests above, and reusing it
    // would make these assertions depend on test ORDER — the exact fragility that makes a
    // suite pass for the wrong reason.
    let unconfirmedLocation = "";

    beforeAll(async () => {
      const rows = await db()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (${storedId("farm")}, 'farm_stand', 'Specialty Probe Stand', 'America/Los_Angeles', 'visitable', 'produce', '11 Specialty Way',
                47.44, -122.47, false, true)
        returning id
      `;
      unconfirmedLocation = rows[0]?.id as string;
    });

    it("stores a standing claim against a location without any inventory revision", async () => {
      // The whole point of the two states: a stand can say what it USUALLY has without any
      // farmer having confirmed anything today. F-066 moved this from a separate table to the
      // `usually_carried` state of a stand item; the property it protects is unchanged, which
      // is why the assertion is the same.
      await db()`
        insert into stand_items (sales_location_id, display_name, usually_carried, sort_order)
        values (${unconfirmedLocation}, 'eggs', true, 0), (${unconfirmedLocation}, 'lamb', true, 1)
      `;

      const rows = await db()`
        select o.display_name as item
        from stand_items o
        left join inventory_revisions r
          on r.sales_location_id = o.sales_location_id and r.is_current
        where o.sales_location_id = ${unconfirmedLocation}
          and o.usually_carried and r.id is null
        order by o.sort_order
      `;
      expect(rows.map((r) => r.item)).toEqual(["eggs", "lamb"]);
    });

    it("refuses a blank item and duplicate items", async () => {
      await expect(
        db()`
          insert into stand_items (sales_location_id, display_name)
          values (${unconfirmedLocation}, '   ')
        `,
      ).rejects.toThrow(/stand_items_display_name_not_blank/);
      // The unique index makes re-seeding safe rather than duplicative — and, unlike the
      // primary key it replaced, it catches a re-seed that differs only in casing.
      await expect(
        db()`
          insert into stand_items (sales_location_id, display_name)
          values (${unconfirmedLocation}, 'eggs')
        `,
      ).rejects.toThrow(/stand_items_one_per_location_name/);
      await expect(
        db()`
          insert into stand_items (sales_location_id, display_name)
          values (${unconfirmedLocation}, 'EGGS')
        `,
      ).rejects.toThrow(/stand_items_one_per_location_name/);
    });

    it("cannot make a stand look confirmed", async () => {
      // THE load-bearing separation, and the thing F-066 had to preserve while merging the two
      // vocabularies. `listPublicStands` and the SMS inquiry both dereference
      // `inventory_revisions` for confirmed availability; a standing claim is a state on
      // `stand_items` that neither reads for that purpose. Writing standing claims must
      // therefore leave the stand with NO current revision — which is what lets B-002 seed
      // VIGA's stands without fabricating a confirmation no farmer made.
      //
      // Sharing the VOCABULARY is not sharing the SLOT: that is the whole answer to whether
      // these two facts could live on one record, and this is where it is proven.
      const revisions = await db()`
        select count(*)::integer as count
        from inventory_revisions
        where sales_location_id = ${unconfirmedLocation} and is_current
      `;
      const standing = await db()`
        select count(*)::integer as count
        from stand_items
        where sales_location_id = ${unconfirmedLocation} and usually_carried
      `;
      expect(standing[0]!.count as number).toBeGreaterThan(0);
      expect(revisions[0]!.count as number).toBe(0);
    });
  });

  describe("stand data flags (F-035)", () => {
    // Its own location, for the same reason as the specialties suite: the shared fixture
    // carries state from earlier tests and reusing it couples these assertions to test order.
    let flagLocation = "";

    beforeAll(async () => {
      const rows = await db()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (${storedId("farm")}, 'farm_stand', 'Flag Probe Stand', 'America/Los_Angeles', 'visitable', 'produce', '12 Flag Way',
                47.43, -122.48, false, true)
        returning id
      `;
      flagLocation = rows[0]?.id as string;
    });

    it("holds one OPEN flag per reason but keeps resolved ones as history", async () => {
      await db()`
        insert into stand_data_flags (sales_location_id, reason, source_text)
        values (${flagLocation}, 'contradictory_hours', 'Open: April - July / Open Thursday - Sunday')
      `;
      // Re-running the seeder must not pile up duplicates of the same open question.
      await expect(
        db()`
          insert into stand_data_flags (sales_location_id, reason, source_text)
          values (${flagLocation}, 'contradictory_hours', 'Open: April - July / Open Thursday - Sunday')
        `,
      ).rejects.toThrow();

      // A different reason for the same stand is a different question, and is allowed.
      await expect(
        db()`
          insert into stand_data_flags (sales_location_id, reason, source_text)
          values (${flagLocation}, 'season_unresolved', 'Open: June 1, 2026 - TBD')
        `,
      ).resolves.not.toThrow();
    });

    it("requires a resolver and a time together, or neither", async () => {
      await expect(
        db()`
          insert into stand_data_flags (sales_location_id, reason, source_text, resolved_at)
          values (${flagLocation}, 'possibly_closed', '7/9/2026 Update: Closed', ${now})
        `,
      ).rejects.toThrow();
    });

    it("refuses a flag with no source text", async () => {
      // The operator's whole job here is reading what the source actually said.
      await expect(
        db()`
          insert into stand_data_flags (sales_location_id, reason, source_text)
          values (${flagLocation}, 'unparsed_availability', '  ')
        `,
      ).rejects.toThrow();
    });
  });
});
