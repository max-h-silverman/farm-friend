import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

// F-063 — `inventory_revisions.source` and the provenance CHECK it carries.
//
// Verified BY EFFECT against a freshly migrated database (B-022), never by the migration's exit
// status: a migration reports success and can still have created nothing. Every assertion below
// either reads a real row back or proves Postgres REFUSED a write.
//
// The refusals are the point. A CHECK constraint PASSES on NULL, which is the classic silent
// inversion: three independent per-column rules would each be satisfied by the very
// half-populated rows the constraint exists to reject, and the suite would read green while
// guaranteeing nothing. So this file asserts the refusal in BOTH directions — a 'viga' row
// carrying a handset key, and an 'sms' row missing one — for all three keys.
//
// Every accepted fixture row is written `is_current = false` and never cleaned up, because the
// schema REFUSES to delete a published revision ("published inventory revisions cannot be
// deleted") — the audit trail is append-only on purpose. Non-current rows do not contend for
// `one_current_per_location`, so they coexist without a teardown.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const migrationCount = (
  JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8")) as {
    entries: unknown[];
  }
).entries.length;

describe("F-063 inventory revision provenance (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  // A whole fixture farm: a farm, a location, a contact, an authorization, an approval, and a
  // proposal — everything an 'sms' revision's foreign keys demand.
  let farmId = "";
  let salesLocationId = "";
  let authorizationId = "";
  let approvalId = "";

  // Fixture instants are offsets from a clock-derived anchor, never calendar literals (B-003).
  const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  /**
   * A fresh proposal, since `inventory_revisions_proposal_unique` permits each only once.
   *
   * Each gets its OWN sender, because `one_open_per_sender` allows a sender exactly one open
   * proposal at a time (Golden Rule #2). Reusing one contact would collide on the second call.
   */
  let senderCounter = 0;
  async function proposal(): Promise<string> {
    senderCounter += 1;
    const senderHash = senderCounter.toString(16).padStart(64, "0");
    await client()`
      insert into contacts (phone_e164, phone_hash)
      values (${`+1206555${String(3000 + senderCounter)}`}, ${senderHash})
    `;
    const rows = await client()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, proposal_version, state,
        has_inventory, has_closure, base_is_first_publication,
        payload, created_at, updated_at
      )
      values (
${senderHash}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), 1, 'open',
        true, false, true, ${client().json({ entries: [] })}, ${at(0)}, ${at(0)}
      )
      returning id
    `;
    return rows[0]?.id as string;
  }

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_revision_source_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 1 });

    const farms = await client()`
      insert into farms (name) values (${`Provenance ${randomUUID()}`}) returning id
    `;
    farmId = farms[0]?.id as string;

    const locations = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', ${`Provenance Stand ${randomUUID()}`},
        'America/Los_Angeles', 'visitable', 'produce',
        '1 Vashon Hwy', 47.4, -122.4, false, false
      )
      returning id
    `;
    salesLocationId = locations[0]?.id as string;

    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550101', ${"f".repeat(64)})
      returning id
    `;

    const authorizations = await client()`
      insert into farmer_authorizations (
        farm_id, contact_id, phone_verified_at, authorized_at
      )
      values (${farmId}, ${contacts[0]?.id as string}, ${at(0)}, ${at(0)})
      returning id
    `;
    authorizationId = authorizations[0]?.id as string;

    // `administrators_fixed_identity` permits exactly one address, so this is not
    // parameterizable — there is one VIGA board account by design.
    const administrators = await client()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${at(0)})
      returning id
    `;
    const approvals = await client()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${farmId}, ${administrators[0]?.id as string}, ${at(0)})
      returning id
    `;
    approvalId = approvals[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  it("applied every committed migration, in strictly increasing order", async () => {
    // The migration exists and ran — asserted against the journal rather than assumed, so a
    // forgotten journal entry fails here rather than surfacing as a missing column later.
    const applied = await client()`
      select count(*)::int as n from drizzle.__drizzle_migrations
    `;
    expect(applied[0]?.n).toBe(migrationCount);

    const journal = JSON.parse(
      readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: { when: number; tag: string }[] };
    const stamps = journal.entries.map((entry) => entry.when);
    expect([...stamps].sort((a, b) => a - b)).toStrictEqual(stamps);
    // THIS migration is present and ordered — not that it is the newest one. Asserting it was
    // last made the test a tripwire on every future migration (it fired on 0020) while proving
    // nothing extra: what F-063 needs is that its own entry exists in a strictly increasing
    // journal, which the two assertions above and this one cover.
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toContain("0019_inventory_revision_source");
  });

  it("created the column and the constraint, not merely a successful apply", async () => {
    const columns = await client()`
      select data_type, udt_name, is_nullable, column_default
      from information_schema.columns
      where table_name = 'inventory_revisions' and column_name = 'source'
    `;
    expect(columns).toHaveLength(1);
    expect(columns[0]?.udt_name).toBe("inventory_revision_source");
    expect(columns[0]?.is_nullable).toBe("NO");

    const constraints = await client()`
      select conname from pg_constraint
      where conname = 'inventory_revisions_source_keys_coherent'
    `;
    expect(constraints).toHaveLength(1);

    // NO DEFAULT. The migration adds one only to carry the backfill past the immutability
    // trigger, then drops it. If it survived, a writer that forgot `source` would be silently
    // recorded as a farmer's SMS confirmation — the exact false statement F-063 exists to
    // prevent — and every "refuses a row with no source" test below would still pass, because
    // the default would satisfy the NOT NULL. Asserted here because nothing else can see it.
    expect(columns[0]?.column_default).toBeNull();

    // The three handset keys had to become nullable for a 'viga' row to exist at all. If any
    // is still NOT NULL the constraint's 'viga' branch is unreachable and the whole feature is
    // dead — the column would exist and nothing could ever use it.
    const keys = await client()`
      select column_name, is_nullable
      from information_schema.columns
      where table_name = 'inventory_revisions'
        and column_name in (
          'proposal_id', 'published_by_authorization_id', 'farm_approval_id'
        )
      order by column_name
    `;
    expect(keys.map((row) => row.is_nullable)).toStrictEqual(["YES", "YES", "YES"]);
  });

  it("accepts a 'viga' row carrying no handset keys, and reads it back", async () => {
    const inserted = await client()`
      insert into inventory_revisions (
        farm_id, sales_location_id, provider_id, source, published_at, is_current
      )
      values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), 'viga', ${at(1)}, false)
      returning id
    `;
    expect(inserted).toHaveLength(1);

    // Read it back rather than trusting the insert: the row is really there, really 'viga',
    // and really carries no fabricated authorization.
    const rows = await client()`
      select source, proposal_id, published_by_authorization_id, farm_approval_id
      from inventory_revisions where id = ${inserted[0]?.id as string}
    `;
    expect(rows[0]?.source).toBe("viga");
    expect(rows[0]?.proposal_id).toBeNull();
    expect(rows[0]?.published_by_authorization_id).toBeNull();
    expect(rows[0]?.farm_approval_id).toBeNull();
  });

  it("accepts an 'sms' row carrying the full chain — existing confirmations still satisfy it", async () => {
    const proposalId = await proposal();
    const inserted = await client()`
      insert into inventory_revisions (
        farm_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
        farm_approval_id, source, published_at, is_current
      )
      values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), ${proposalId}, ${authorizationId},
        ${approvalId}, 'sms', ${at(2)}, false
      )
      returning id
    `;
    expect(inserted).toHaveLength(1);

    const rows = await client()`
      select source, proposal_id from inventory_revisions
      where id = ${inserted[0]?.id as string}
    `;
    expect(rows[0]?.source).toBe("sms");
    expect(rows[0]?.proposal_id).toBe(proposalId);
  });

  describe("Postgres REFUSES a half-populated row", () => {
    /** Assert the write genuinely failed on OUR constraint, not on something incidental. */
    async function refused(write: Promise<unknown>): Promise<void> {
      await expect(write).rejects.toThrow(/inventory_revisions_source_keys_coherent/);
    }

    it("refuses a 'viga' row carrying a proposal_id", async () => {
      const proposalId = await proposal();
      await refused(client()`
        insert into inventory_revisions (
          farm_id, sales_location_id, provider_id, proposal_id, source, published_at, is_current
        )
        values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), ${proposalId}, 'viga', ${at(3)}, false
        )
      `);
    });

    it("refuses a 'viga' row carrying a published_by_authorization_id", async () => {
      await refused(client()`
        insert into inventory_revisions (
          farm_id, sales_location_id, provider_id, published_by_authorization_id, source,
          published_at, is_current
        )
        values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), ${authorizationId}, 'viga', ${at(4)}, false
        )
      `);
    });

    it("refuses a 'viga' row carrying a farm_approval_id", async () => {
      await refused(client()`
        insert into inventory_revisions (
          farm_id, sales_location_id, provider_id, farm_approval_id, source, published_at, is_current
        )
        values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), ${approvalId}, 'viga', ${at(5)}, false
        )
      `);
    });

    it("refuses an 'sms' row missing published_by_authorization_id", async () => {
      const proposalId = await proposal();
      await refused(client()`
        insert into inventory_revisions (
          farm_id, sales_location_id, provider_id, proposal_id, farm_approval_id, source,
          published_at, is_current
        )
        values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), ${proposalId}, ${approvalId}, 'sms',
          ${at(6)}, false
        )
      `);
    });

    it("refuses an 'sms' row missing proposal_id", async () => {
      await refused(client()`
        insert into inventory_revisions (
          farm_id, sales_location_id, provider_id, published_by_authorization_id, farm_approval_id,
          source, published_at, is_current
        )
        values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), ${authorizationId}, ${approvalId}, 'sms',
          ${at(7)}, false
        )
      `);
    });

    it("refuses an 'sms' row missing farm_approval_id", async () => {
      const proposalId = await proposal();
      await refused(client()`
        insert into inventory_revisions (
          farm_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
          source, published_at, is_current
        )
        values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), ${proposalId}, ${authorizationId}, 'sms',
          ${at(8)}, false
        )
      `);
    });

    it("refuses an 'sms' row with no handset keys at all", async () => {
      // The shape a naive 'viga' writer would produce if it forgot to set `source`. Without
      // the biconditional this is exactly the row that slips through.
      await refused(client()`
        insert into inventory_revisions (
          farm_id, sales_location_id, provider_id, source, published_at, is_current
        )
        values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), 'sms', ${at(9)}, false)
      `);
    });

    it("refuses a row with no source at all", async () => {
      // NOT NULL, so provenance can never be silently omitted. This one fails on the column's
      // own constraint rather than the CHECK, which is why it does not use `refused`.
      await expect(
        client()`
          insert into inventory_revisions (
            farm_id, sales_location_id, provider_id, published_at, is_current
          )
          values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), ${at(10)}, false)
        `,
      ).rejects.toThrow(/source/);
    });
  });
});
