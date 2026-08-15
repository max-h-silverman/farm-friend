import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.1 (invitation) — `0044` against a POPULATED copy of the schema that precedes it.

  The contract requires this specifically, and the two migrations before this one proved why: a
  populated run has now caught composite keys created before their unique target, keys rooted on a
  dropped column, triggers depending on it, constraints left asserting old names, and backfill
  joins matching a removed slot. An empty-schema run is green for every one of those.

  So this file:

    1. Applies migrations 0000–0043 ONLY, selected BY ORDER (`name < "0044_"`) rather than by
       exclusion. The exclusion form was correct only while its own migration was the newest in
       the repo, and it broke the moment a successor landed — every future migration would have
       broken it the same way.
    2. Populates it with a real corpus's awkward rows: the 39 existing invitations' shape
       (administrator-issued and self-issued, redeemed and open, naming a farm and naming none),
       a hosted provider, and the venue with no seller of its own.
    3. Applies 0044 alone, against that data.
    4. Asserts EXACT row effects — identities and values, not "it did not throw".

  ## The defect class this file exists to catch

  `0044` adds a NULLABLE column and two constraints beside it. Adding a nullable column cannot
  fail on any data, so the migration is green whatever it does to the 39 invitations that were
  already there. What must be proved is that each of them survives unchanged and still redeemable
  — in particular the SELF-ISSUED one, whose own CHECK (`farmer_invitations_self_issued_names_farm`)
  interacts with the new one and could be made unsatisfiable by a coherence rule written the wrong
  way round — and that the new CHECK is VALIDATED against those rows rather than added `NOT VALID`,
  which passes every insert test in the suite while live data violates it.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/* Ordered BEFORE `0044`, never "everything that is not `0044`" — see the header. */
const beforeThisWork = migrationFiles.filter((name) => name < "0044_");
const thisWork = migrationFiles.filter((name) => name.startsWith("0044_"));

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-114 Phase C.1 hosting-invitation migration against a populated schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let hostSellerId = "";
  let hostedSellerId = "";
  let standLocationId = "";
  let venueLocationId = "";
  let administratorId = "";
  let hostedProviderId = "";
  let adminInvitationId = "";
  let selfIssuedInvitationId = "";
  let newFarmInvitationId = "";
  let redeemedInvitationId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  const freshToken = (): string =>
    `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114invmig_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 4 });
    const db = client();

    // ---- 1. the schema as it stands BEFORE this work ---------------------------------------
    expect(thisWork).toHaveLength(1);
    expect(beforeThisWork.length).toBeGreaterThan(43);
    for (const file of beforeThisWork) await applyFile(db, file);

    // ---- 2. populate it --------------------------------------------------------------------
    const sellers = await db`
      insert into sellers (name) values ('Venison Valley'), ('Gracies Greens') returning id
    `;
    hostSellerId = sellers[0]?.id as string;
    hostedSellerId = sellers[1]?.id as string;

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
    standLocationId = await mkLocation("Venison Valley Stand", hostSellerId);
    // The venue: no seller of its own, and therefore no provider the trigger could create. It is
    // here so the migration is proved not to invent one — the fabricated authority C.0 removed.
    venueLocationId = await mkLocation("Morgan Hill Community Stand", null);

    const administrators = await db`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', now()) returning id
    `;
    administratorId = administrators[0]?.id as string;

    // A hosted provider already ACTIVE at Kelsey's stand. `0044`'s new composite key targets
    // `(id, seller_id)` on this table, and a unique constraint added to a populated table fails
    // loudly on a duplicate — so this row is what makes that statement run against real data.
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

    // The four invitation shapes production actually holds. Each is a row `0044`'s new CHECK is
    // validated against, and the self-issued one is the interesting one: its own CHECK requires a
    // farm, so a coherence rule written the wrong way round would make it unsatisfiable.
    const mkInvitation = async (values: {
      sellerId: string | null;
      administratorId: string | null;
      redeemed?: boolean;
    }): Promise<string> => {
      const rows = await db`
        insert into farmer_invitations (
          seller_id, token_hash, channel, created_by_administrator_id,
          created_at, expires_at, redeemed_at
        ) values (
          ${values.sellerId}, ${freshToken()}, 'sms', ${values.administratorId},
          now(), now() + interval '14 days', ${values.redeemed === true ? db`now()` : null}
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    adminInvitationId = await mkInvitation({
      sellerId: hostSellerId,
      administratorId,
    });
    selfIssuedInvitationId = await mkInvitation({
      sellerId: hostedSellerId,
      administratorId: null,
    });
    newFarmInvitationId = await mkInvitation({
      sellerId: null,
      administratorId,
    });
    redeemedInvitationId = await mkInvitation({
      sellerId: hostSellerId,
      administratorId,
      redeemed: true,
    });

    // ---- 3. apply 0044 alone, against that data --------------------------------------------
    for (const file of thisWork) await applyFile(db, file);
  }, 90_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("leaves every existing invitation unchanged and bound to no relationship", async () => {
    // The migration adds a binding; it must not CREATE one. Asserted by identity rather than by
    // count, so a migration that guessed a provider for an invitation naming a hosted seller —
    // exactly the name-matching §the 11 hosted names forbids — fails here.
    const rows = await client()`
      select id, seller_id, stand_provider_id, redeemed_at, created_by_administrator_id
      from farmer_invitations
      order by created_at, id
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.stand_provider_id).toBeNull();

    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(adminInvitationId)?.seller_id).toBe(hostSellerId);
    expect(byId.get(selfIssuedInvitationId)?.seller_id).toBe(hostedSellerId);
    expect(byId.get(selfIssuedInvitationId)?.created_by_administrator_id).toBeNull();
    expect(byId.get(newFarmInvitationId)?.seller_id).toBeNull();
    expect(byId.get(redeemedInvitationId)?.redeemed_at).not.toBeNull();
  });

  it("validates the hosting CHECK against the rows that were already there", async () => {
    // A constraint added `NOT VALID` passes every insert test in the suite while live data
    // violates it. Ask Postgres directly rather than inferring it from an insert written after
    // the migration ran.
    const rows = await client()`
      select convalidated from pg_constraint
      where conname = 'farmer_invitations_hosting_names_seller'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.convalidated).toBe(true);
  });

  it("leaves the self-issued invitation still redeemable", async () => {
    // `farmer_invitations_self_issued_names_farm` requires a self-issued row to name its farm.
    // The new rule requires a provider-bound row to name its seller. Written as a biconditional
    // the second would have demanded a provider on every seller-naming row, which is every
    // self-issued one — making the honour-system door unwritable. Proved by writing one.
    const db = client();
    const rows = await db`
      insert into farmer_invitations (
        seller_id, token_hash, channel, created_at, expires_at
      ) values (
        ${hostedSellerId}, ${freshToken()}, 'sms', now(), now() + interval '14 days'
      ) returning id, stand_provider_id
    `;
    expect(rows[0]?.stand_provider_id).toBeNull();
  });

  it("admits the hosting invitation the pre-0044 schema could not hold at all", async () => {
    // What this migration exists for, asserted by writing the row rather than by reading the
    // catalogue. Gracie's Greens is pending at Kelsey's stand and Zoe's invitation names both.
    const db = client();
    const pending = await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at
      ) values (
        ${venueLocationId}, ${hostedSellerId}, 'pending', now()
      ) returning id
    `;
    const rows = await db`
      insert into farmer_invitations (
        seller_id, stand_provider_id, token_hash, channel,
        created_by_administrator_id, created_at, expires_at
      ) values (
        ${hostedSellerId}, ${pending[0]?.id as string}, ${freshToken()}, 'sms',
        ${administratorId}, now(), now() + interval '14 days'
      ) returning id, seller_id, stand_provider_id
    `;
    expect(rows[0]?.stand_provider_id).toBe(pending[0]?.id);
    expect(rows[0]?.seller_id).toBe(hostedSellerId);
  });

  it("refuses a hosting invitation naming a relationship of another seller", async () => {
    // The composite key's whole guarantee, proved against real rows rather than inferred from
    // the constraint's presence. `hostedProviderId` belongs to Gracie's Greens; binding it while
    // authorizing for Venison Valley must be refused by the database.
    await expect(
      client()`
        insert into farmer_invitations (
          seller_id, stand_provider_id, token_hash, channel,
          created_by_administrator_id, created_at, expires_at
        ) values (
          ${hostSellerId}, ${hostedProviderId}, ${freshToken()}, 'sms',
          ${administratorId}, now(), now() + interval '14 days'
        )
      `,
    ).rejects.toMatchObject({
      code: "23503",
      constraint_name: "farmer_invitations_provider_seller_fk",
    });
  });

  it("invents no provider for the venue", async () => {
    // `0044` touches neither `stand_providers` rows nor the self-pointer, and the venue is the
    // row a migration is most tempted to repair. Counted after the migration, so a statement that
    // created one fails here.
    const rows = await client()`
      select count(*)::int as total from stand_providers
      where sales_location_id = ${venueLocationId} and lifecycle_state <> 'pending'
    `;
    expect(rows[0]?.total).toBe(0);
  });

  it("is a no-op when applied a second time", async () => {
    // The integration suite applies every file twice. `ADD CONSTRAINT` and `CREATE INDEX` have no
    // unguarded idempotent form, so a re-run must change nothing rather than raising.
    const db = client();
    const before = await db`
      select
        (select count(*)::int from farmer_invitations) as invitations,
        (select count(*)::int from stand_providers) as providers,
        (
          select count(*)::int from farmer_invitations where stand_provider_id is not null
        ) as bound
    `;
    for (const file of thisWork) await applyFile(db, file);
    const after = await db`
      select
        (select count(*)::int from farmer_invitations) as invitations,
        (select count(*)::int from stand_providers) as providers,
        (
          select count(*)::int from farmer_invitations where stand_provider_id is not null
        ) as bound
    `;
    expect(after[0]).toEqual(before[0]);
  });
});
