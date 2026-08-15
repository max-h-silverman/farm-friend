import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.1 (records) — `0043` against a POPULATED copy of the schema that precedes it.

  The contract requires this specifically, and C.0 proved why: a populated run caught five defects
  an empty one passed — a composite foreign key created before its unique target, six keys rooted
  on a dropped column, two triggers depending on it, 25 constraints left asserting old names, and
  eight backfill joins matching a removed slot. Only the last two were data-dependent; the rest
  simply never ran against an empty schema because nothing referenced the column yet.

  So this file:

    1. Applies migrations 0000–0042 ONLY. That is the schema C.1 starts from — sellers are the
       identity root, `own_seller_id` is the self-pointer, `stand_providers.seller_id` is NOT
       NULL, and `farmer_authorizations.seller_id` is NOT NULL with nine composite keys onto it.
    2. Populates it with the awkward rows a real corpus has — 14 live authorizations' worth of
       shape, including the one phone that already acts for TWO sellers, a revoked authorization
       whose contact was later restored, a venue with no seller of its own, a hosted provider,
       and every seller-level fact that keys through `(authorization, seller)`.
    3. Applies 0043 alone, against that data.
    4. Asserts EXACT row effects — counts and identities, not "it did not throw".

  ## The defect class this file exists to catch

  `0043` makes `farmer_authorizations.seller_id` NULLABLE. That is the reverse of C.0's trap and
  just as quiet: dropping NOT NULL cannot fail on any data, so the migration is green whatever it
  does to the nine composite foreign keys that route through that column. What must be proved is
  that every existing authorization still names its seller afterwards, that every seller-level
  fact still resolves through its key, and that the new CHECK is VALIDATED against the rows that
  were already there — a constraint added `NOT VALID` passes every insert test while live data
  violates it.

  ## Why the corpus is deliberately awkward

  A cooperative fixture would let all of this through: the phone acting for two sellers (measured
  2026-08-15, and collapsing seller and person would break it); the revoked-then-restored contact,
  which proves the partial index survived the widening; and the venue, which has no seller at all
  and is the only reason the stand arm exists.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/** Every migration file in order, so "before 0043" and "0043 alone" are exact. */
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/*
  Ordered BEFORE `0043`, never "everything that is not `0043`". C.0's file used the exclusion
  form and it was correct only while its migration was the last one in the repo — this file's
  `0043` was swept into its pre-migration set and applied decades of columns too early. The
  comparison form is stable for every migration that lands after this one.
*/
const beforeThisWork = migrationFiles.filter((name) => name < "0043_");
const thisWork = migrationFiles.filter((name) => name.startsWith("0043_"));

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-114 Phase C.1 migration against a populated schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let sellerId = "";
  let secondSellerId = "";
  let hostedSellerId = "";
  let standLocationId = "";
  let venueLocationId = "";
  let sharedContactId = "";
  let restoredContactId = "";
  let authorizationId = "";
  let secondAuthorizationId = "";
  let revokedAuthorizationId = "";
  let restoredAuthorizationId = "";
  let linkId = "";
  let preferenceId = "";
  let revisionId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114armmig_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 4 });
    const db = client();

    // ---- 1. the schema as it stands BEFORE this work ---------------------------------------
    expect(thisWork).toHaveLength(1);
    expect(beforeThisWork.length).toBeGreaterThan(42);
    for (const file of beforeThisWork) await applyFile(db, file);

    // ---- 2. populate it --------------------------------------------------------------------
    const sellers = await db`
      insert into sellers (name)
      values ('Venison Valley'), ('Pacific Crest'), ('Gracies Greens')
      returning id
    `;
    sellerId = sellers[0]?.id as string;
    secondSellerId = sellers[1]?.id as string;
    hostedSellerId = sellers[2]?.id as string;

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
    standLocationId = await mkLocation("Venison Valley Stand", sellerId);
    // Pacific Crest's own stand. Nothing reads its id — it exists so `secondSellerId` has a real
    // provider behind it, which is what makes the cross-authorization sabotage case meaningful
    // rather than a foreign key failing for an unrelated reason.
    await mkLocation("Pacific Crest Stand", secondSellerId);
    // The venue: no seller of its own. Morgan Hill's shape, and the reason the stand arm exists.
    venueLocationId = await mkLocation("Morgan Hill Community Stand", null);

    const mkContact = async (): Promise<string> => {
      const rows = await db`
        insert into contacts (phone_e164, phone_hash)
        values (
          ${`+1206555${String(Math.floor(Math.random() * 9000) + 1000)}`},
          ${`m43${randomUUID().replaceAll("-", "")}`}
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    sharedContactId = await mkContact();
    restoredContactId = await mkContact();

    // ONE PHONE ACTING FOR TWO SELLERS — measured in production 2026-08-15. This is why seller
    // and person stay separate records, and the migration must not disturb either row.
    const first = await db`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${sellerId}, ${sharedContactId}, now(), now()) returning id
    `;
    authorizationId = first[0]?.id as string;
    const second = await db`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${secondSellerId}, ${sharedContactId}, now(), now()) returning id
    `;
    secondAuthorizationId = second[0]?.id as string;

    // A REVOKED authorization and a later live one for the same contact and seller. The partial
    // index admits this today; a widening that rebuilt the index wrongly would refuse it.
    const revoked = await db`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at, revoked_at
      ) values (${hostedSellerId}, ${restoredContactId}, now(), now(), now()) returning id
    `;
    revokedAuthorizationId = revoked[0]?.id as string;
    const restored = await db`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${hostedSellerId}, ${restoredContactId}, now(), now()) returning id
    `;
    restoredAuthorizationId = restored[0]?.id as string;

    // A hosted provider at Kelsey's stand — the Venison Valley case as measured.
    await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standLocationId}, ${hostedSellerId}, 'active',
        now() - interval '2 days', now() - interval '1 day', 'viga', now()
      )
    `;

    // Seller-level facts that key through `(authorization, seller)`. Each must still resolve
    // after `seller_id` becomes nullable; a composite key silently stops enforcing on NULL, so
    // these rows are what prove the existing ones kept their guarantee.
    const ownProviderId = async (): Promise<string> => {
      const rows = await db`
        select id from stand_providers
        where sales_location_id = ${standLocationId} and seller_id = ${sellerId}
      `;
      return rows[0]?.id as string;
    };

    const links = await db`
      insert into farmer_links (
        token_hash, authorization_id, owner_seller_id, sales_location_id, provider_id, issued_at
      ) values (
        ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")},
        ${authorizationId}, ${sellerId}, ${standLocationId}, ${await ownProviderId()}, now()
      ) returning id
    `;
    linkId = links[0]?.id as string;

    const preferences = await db`
      insert into inventory_prompt_preferences (
        owner_seller_id, sales_location_id, provider_id, designated_authorization_id,
        cadence, version, next_due_at, updated_at
      ) values (
        ${sellerId}, ${standLocationId}, ${await ownProviderId()},
        ${authorizationId}, 'weekly', 1, now() + interval '7 days', now()
      ) returning id
    `;
    preferenceId = preferences[0]?.id as string;

    // `source = 'web'` carries an authorization and an approval but no proposal — the cheapest
    // shape `inventory_revisions_source_keys_coherent` admits that still exercises the
    // `(authorization, seller)` key this file is here to prove survived.
    const administrators = await db`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', now()) returning id
    `;
    const approvals = await db`
      insert into seller_approvals (seller_id, administrator_id, approved_at)
      values (${sellerId}, ${administrators[0]?.id as string}, now()) returning id
    `;
    const revisions = await db`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, source, published_by_authorization_id,
        farm_approval_id, published_at, is_current
      ) values (
        ${sellerId}, ${standLocationId}, ${await ownProviderId()},
        'web', ${authorizationId}, ${approvals[0]?.id as string}, now(), true
      ) returning id
    `;
    revisionId = revisions[0]?.id as string;

    // ---- 3. apply 0043 alone, against that data --------------------------------------------
    for (const file of thisWork) await applyFile(db, file);
  }, 90_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("leaves every existing authorization naming its seller and no stand", async () => {
    // The migration adds an arm; it must not MOVE anybody onto it. Every row that existed was a
    // seller authorization and stays one — asserted by identity, not by count, so a migration
    // that nulled a seller and repointed it at a stand fails here.
    const rows = await client()`
      select id, seller_id, sales_location_id
      from farmer_authorizations
      order by authorized_at, id
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.sales_location_id).toBeNull();
      expect(row.seller_id).not.toBeNull();
    }
    const bySeller = new Map(rows.map((row) => [row.id as string, row.seller_id as string]));
    expect(bySeller.get(authorizationId)).toBe(sellerId);
    expect(bySeller.get(secondAuthorizationId)).toBe(secondSellerId);
    expect(bySeller.get(revokedAuthorizationId)).toBe(hostedSellerId);
    expect(bySeller.get(restoredAuthorizationId)).toBe(hostedSellerId);
  });

  it("keeps the one phone that acts for two sellers acting for both", async () => {
    const rows = await client()`
      select count(*)::int as live
      from farmer_authorizations
      where contact_id = ${sharedContactId} and revoked_at is null
    `;
    expect(rows[0]?.live).toBe(2);
  });

  it("leaves every seller-level fact still resolving through its composite key", async () => {
    // The nine keys route through `(farmer_authorizations.id, seller_id)`. Making that column
    // nullable cannot fail on data, so this asserts the JOIN still lands — a key silently
    // dropped by the migration would leave these rows orphaned with nothing raising.
    const db = client();
    const link = await db`
      select l.id from farmer_links l
      join farmer_authorizations a
        on a.id = l.authorization_id and a.seller_id = l.owner_seller_id
      where l.id = ${linkId}
    `;
    expect(link).toHaveLength(1);
    const preference = await db`
      select p.id from inventory_prompt_preferences p
      join farmer_authorizations a
        on a.id = p.designated_authorization_id and a.seller_id = p.owner_seller_id
      where p.id = ${preferenceId}
    `;
    expect(preference).toHaveLength(1);
    const revision = await db`
      select r.id from inventory_revisions r
      join farmer_authorizations a
        on a.id = r.published_by_authorization_id and a.seller_id = r.seller_id
      where r.id = ${revisionId}
    `;
    expect(revision).toHaveLength(1);
  });

  it("still refuses a seller-level fact filed under the wrong authorization", async () => {
    // The guarantee the nine keys actually make, proved by sabotage rather than by their
    // presence. `secondAuthorizationId` is for Pacific Crest, so filing Venison Valley's link
    // under it must be refused by the key, not by any application check.
    const db = client();
    await expect(
      db`
        insert into farmer_links (
          token_hash, authorization_id, owner_seller_id, sales_location_id, provider_id,
          issued_at
        ) values (
          ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")},
          ${secondAuthorizationId}, ${sellerId}, ${standLocationId},
          (
            select id from stand_providers
            where sales_location_id = ${standLocationId} and seller_id = ${sellerId}
          ),
          now()
        )
      `,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("validates the arm CHECK against the rows that were already there", async () => {
    // A constraint added `NOT VALID` passes every insert test while live data violates it. Ask
    // Postgres directly whether the constraint is validated, rather than inferring it from an
    // insert that was written after the migration ran.
    const rows = await client()`
      select convalidated from pg_constraint where conname = 'farmer_authorizations_subject_arm'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.convalidated).toBe(true);
  });

  it("gives every existing provider the host stock right turned OFF", async () => {
    // The backfill's whole job. Defaulting these to true would silently hand every host rights
    // over goods that are not theirs, across 38 stands, with nothing in any output saying so.
    const rows = await client()`
      select
        count(*) filter (where host_may_update_stock)::int as granted,
        count(*) filter (where host_may_update_stock is null)::int as unstated,
        count(*)::int as total
      from stand_providers
    `;
    expect(rows[0]?.granted).toBe(0);
    expect(rows[0]?.unstated).toBe(0);
    // Three stands, each with an own-seller provider from the trigger, plus the hosted one.
    expect(rows[0]?.total).toBe(3);
  });

  it("leaves the venue with no seller, no provider, and now a way to be managed", async () => {
    // The migration must not invent a seller for Morgan Hill — that is the fabricated authority
    // C.0 removed. What C.1 adds is the ability to authorize a phone for it, which is asserted
    // by writing the row the pre-0043 schema could not hold at all.
    const db = client();
    const venue = await db`
      select own_seller_id from sales_locations where id = ${venueLocationId}
    `;
    expect(venue[0]?.own_seller_id).toBeNull();
    const providers = await db`
      select count(*)::int as total from stand_providers
      where sales_location_id = ${venueLocationId}
    `;
    expect(providers[0]?.total).toBe(0);

    const contacts = await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065559999', ${`m43${randomUUID().replaceAll("-", "")}`}) returning id
    `;
    const written = await db`
      insert into farmer_authorizations (
        seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
      ) values (null, ${venueLocationId}, ${contacts[0]?.id as string}, now(), now())
      returning id, sales_location_id
    `;
    expect(written[0]?.sales_location_id).toBe(venueLocationId);
  });

  it("is a no-op when applied a second time", async () => {
    // The integration suite applies every file twice, and `ALTER TABLE … RENAME` and
    // `ADD CONSTRAINT` have no `IF EXISTS`/`IF NOT EXISTS` forms that cover every case. A
    // re-run must change nothing rather than raising.
    const db = client();
    const before = await db`
      select
        (select count(*)::int from farmer_authorizations) as authorizations,
        (select count(*)::int from stand_providers) as providers,
        (
          select count(*)::int from farmer_authorizations
          where seller_id is null and sales_location_id is null
        ) as armless
    `;
    for (const file of thisWork) await applyFile(db, file);
    const after = await db`
      select
        (select count(*)::int from farmer_authorizations) as authorizations,
        (select count(*)::int from stand_providers) as providers,
        (
          select count(*)::int from farmer_authorizations
          where seller_id is null and sales_location_id is null
        ) as armless
    `;
    expect(after[0]).toEqual(before[0]);
    expect(after[0]?.armless).toBe(0);
  });
});
