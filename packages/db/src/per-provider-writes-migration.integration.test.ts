import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.2 — `0045` against a POPULATED copy of the schema that precedes it.

  ## Why a constraint-only migration still needs this

  `0045` adds no column and rewrites no data, which is exactly the shape that looks safest and
  is not. `ADD CONSTRAINT ... FOREIGN KEY` on a populated table VALIDATES against every existing
  row, so the new `(provider_id, seller_id)` key either holds for all 38 stands' revisions or the
  migration fails in production having succeeded on every empty database in the repo.

  The claim being tested is a claim about real data: *every revision today names the stand's own
  provider, whose seller IS the stand's own seller, so the new key is already satisfied.* That is
  reasoning, not evidence, until a populated run proves it — the same reasoning that made `0042`'s
  generated `ADD COLUMN ... NOT NULL` look fine and fail on the first real database.

  ## What this file populates, and why each row is here

    1. A revision on a stand's OWN provider — the 38-stand case, and the rows the new key must
       accept unchanged.
    2. A revision published under a real authorization and approval — the `sms`/`web` chain,
       because statement 3 REPLACES the composite `(authorization, seller)` key and a replacement
       that silently dropped the reference would leave these rows pointing at nothing.
    3. A HOSTED provider with no revision of its own — present so the migration is proved not to
       backfill, infer, or re-root anything onto it.
    4. A venue with no seller of its own, whose stand has no own-provider at all.
    5. A superseded revision beside a current one, so the history the key validates against is not
       only the current row.

  ## What is asserted

  Exact row effects: every revision's identity, seller, and provider unchanged; the count
  unchanged; the dropped constraint absent BY NAME; both replacements present BY NAME; and the new
  key actually enforcing rather than added `NOT VALID` — proved by inserting a violating row after
  the migration and requiring the refusal.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/* Ordered BEFORE `0045`, never "everything that is not `0045`" — an exclusion filter is correct
   only while its own migration is the newest in the repo, and breaks the moment one lands after
   it. Both earlier migration suites were repaired for exactly this. */
const beforeThisWork = migrationFiles.filter((name) => name < "0045_");
const thisWork = migrationFiles.filter((name) => name.startsWith("0045_"));

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-114 Phase C.2 per-provider write migration against a populated schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let ownSellerId = "";
  let hostedSellerId = "";
  let standLocationId = "";
  let venueLocationId = "";
  let ownProviderId = "";
  let hostedProviderId = "";
  let authorizationId = "";
  let approvalId = "";

  let plainRevisionId = "";
  let chainedRevisionId = "";
  let supersededRevisionId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114provmig_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 4 });
    const db = client();

    // ---- 1. the schema as it stands BEFORE this work ---------------------------------------
    expect(thisWork).toHaveLength(1);
    expect(beforeThisWork.length).toBeGreaterThan(44);
    for (const file of beforeThisWork) await applyFile(db, file);

    // ---- 2. populate it --------------------------------------------------------------------
    const sellers = await db`
      insert into sellers (name) values ('Venison Valley'), ('Gracies Greens') returning id
    `;
    ownSellerId = sellers[0]?.id as string;
    hostedSellerId = sellers[1]?.id as string;

    const approvals = await db`
      insert into seller_approvals (seller_id, approved_at)
      values (${ownSellerId}, now()) returning id
    `;
    approvalId = approvals[0]?.id as string;

    const mkLocation = async (name: string, owner: string | null): Promise<string> => {
      const rows = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          ${owner}, 'farm_stand', ${name}, 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          ${`${name} Road, Vashon WA`}, 47.4473, -122.4590
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    standLocationId = await mkLocation("Venison Valley Stand", ownSellerId);
    // The venue: no seller of its own, so the trigger creates no provider. Here so the migration
    // is proved not to invent one — the fabricated authority C.0 removed.
    venueLocationId = await mkLocation("Morgan Hill Community Stand", null);

    const own = await db`
      select id from stand_providers
      where sales_location_id = ${standLocationId} and seller_id = ${ownSellerId}
    `;
    ownProviderId = own[0]?.id as string;

    // A hosted relationship with NO revision. It exists so the migration is proved not to
    // backfill or re-root anything onto a provider that has published nothing.
    const hosted = await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standLocationId}, ${hostedSellerId}, 'active',
        now() - interval '2 days', now() - interval '1 day', 'viga', now()
      ) returning id
    `;
    hostedProviderId = hosted[0]?.id as string;

    const contacts = await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065551000', ${`h${randomUUID().replaceAll("-", "")}`}) returning id
    `;
    const authorizations = await db`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${ownSellerId}, ${contacts[0]?.id as string}, now(), now()) returning id
    `;
    authorizationId = authorizations[0]?.id as string;

    // A superseded revision beneath a current one, so the key validates against history rather
    // than only against what is live.
    const superseded = await db`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, source, published_at,
        is_current, superseded_at
      ) values (
        ${ownSellerId}, ${standLocationId}, ${ownProviderId}, 'viga',
        now() - interval '3 days', false, now() - interval '2 days'
      ) returning id
    `;
    supersededRevisionId = superseded[0]?.id as string;

    // The handset chain: `published_by_authorization_id` and `farm_approval_id` populated, which
    // is what statement 3 replaces the composite key over. A replacement that dropped the
    // reference entirely would leave this row pointing at nothing.
    const chained = await db`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, published_by_authorization_id,
        farm_approval_id, source, published_at, is_current
      ) values (
        ${ownSellerId}, ${standLocationId}, ${ownProviderId}, ${authorizationId},
        ${approvalId}, 'web', now(), true
      ) returning id
    `;
    chainedRevisionId = chained[0]?.id as string;
    plainRevisionId = supersededRevisionId;

    // ---- 3. apply 0045 alone, against that data --------------------------------------------
    for (const file of thisWork) await applyFile(db, file);
  }, 90_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("leaves every revision exactly as it found it", async () => {
    // Identity and values, not "it did not throw". A migration that re-rooted a seller onto a
    // provider, or dropped a chain it could not validate, fails here rather than in production.
    const rows = await client()`
      select id, seller_id, sales_location_id, provider_id,
        published_by_authorization_id, farm_approval_id, source, is_current
      from inventory_revisions
      order by published_at
    `;
    expect(rows).toHaveLength(2);

    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(supersededRevisionId)).toMatchObject({
      seller_id: ownSellerId,
      provider_id: ownProviderId,
      sales_location_id: standLocationId,
      source: "viga",
      is_current: false,
    });
    expect(byId.get(supersededRevisionId)?.published_by_authorization_id).toBeNull();
    expect(byId.get(chainedRevisionId)).toMatchObject({
      seller_id: ownSellerId,
      provider_id: ownProviderId,
      published_by_authorization_id: authorizationId,
      farm_approval_id: approvalId,
      source: "web",
      is_current: true,
    });
    expect(plainRevisionId).toBe(supersededRevisionId);
  });

  it("invents nothing for the hosted provider or the venue", async () => {
    // The migration backfills nothing, so the hosted relationship still has no revision and the
    // venue still has no provider. Both stated as counts of ZERO, which is the assertion that
    // fails if a future edit adds an inference.
    const hostedRevisions = await client()`
      select count(*)::int as total from inventory_revisions
      where provider_id = ${hostedProviderId}
    `;
    expect(hostedRevisions[0]?.total).toBe(0);

    const venueProviders = await client()`
      select count(*)::int as total from stand_providers
      where sales_location_id = ${venueLocationId}
    `;
    expect(venueProviders[0]?.total).toBe(0);
  });

  it("drops the stand's own-seller key and adds both replacements, by name", async () => {
    const rows = await client()`
      select conname from pg_constraint
      where conrelid = 'inventory_revisions'::regclass
        and conname in (
          'inventory_revisions_location_own_seller_fk',
          'inventory_revisions_authorization_farm_fk',
          'inventory_revisions_location_provider_fk',
          'inventory_revisions_provider_seller_fk',
          'inventory_revisions_authorization_fk'
        )
      order by conname
    `;
    expect(rows.map((row) => row.conname)).toEqual([
      "inventory_revisions_authorization_fk",
      "inventory_revisions_location_provider_fk",
      "inventory_revisions_provider_seller_fk",
    ]);
  });

  it("validated the new key against the rows that were already there", async () => {
    /*
      The specific way a constraint migration passes a whole suite while leaving live data
      unchecked. `NOT VALID` on a FOREIGN KEY still refuses every NEW row — so the obvious probe,
      inserting a violating row and requiring the refusal, passes either way and proves nothing.
      That probe was written first and a deliberate `NOT VALID` sabotage sailed through it.

      What `NOT VALID` actually skips is the scan of the rows that were already there. So the
      assertion is on `convalidated` itself, which is the fact that differs, and it is checked
      against the populated schema precisely because that is where unvalidated rows would hide.
    */
    const rows = await client()`
      select convalidated from pg_constraint
      where conname = 'inventory_revisions_provider_seller_fk'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.convalidated).toBe(true);
  });

  it("refuses a revision whose seller is not the provider's", async () => {
    // The key's effect on new writes, beside the validation above. Both are asserted because
    // they fail independently: an unvalidated key still refuses this, and a key dropped
    // entirely would pass the `convalidated` case vacuously if it were written as "not false".
    await expect(
      client()`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, source, published_at, is_current
        ) values (
          ${hostedSellerId}, ${standLocationId}, ${ownProviderId}, 'viga', now(), false
        )
      `,
    ).rejects.toThrow(/inventory_revisions_provider_seller_fk/);
  });

  it("admits the hosted publication the old key forbade", async () => {
    // The whole point of the migration, asserted by effect against real preceding data rather
    // than in a fresh database: Gracie's Greens can now publish at Venison Valley's stand.
    const rows = await client()`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, source, published_at, is_current
      ) values (
        ${hostedSellerId}, ${standLocationId}, ${hostedProviderId}, 'viga', now(), true
      ) returning id
    `;
    expect(rows[0]?.id).toBeTruthy();
  });

  it("is a no-op when applied a second time", async () => {
    // Every statement is guarded; the suite requires the second run to change nothing.
    // `ADD CONSTRAINT` and `DROP CONSTRAINT` are not idempotent on their own.
    const before = await client()`
      select count(*)::int as total from pg_constraint
      where conrelid = 'inventory_revisions'::regclass
    `;
    for (const file of thisWork) await applyFile(client(), file);
    const after = await client()`
      select count(*)::int as total from pg_constraint
      where conrelid = 'inventory_revisions'::regclass
    `;
    expect(after[0]?.total).toBe(before[0]?.total);
  });
});
