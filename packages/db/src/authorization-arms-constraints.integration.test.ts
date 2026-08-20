import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.1 (records) — the two arms of an authorization, and the host stock right, by
  SABOTAGE.

  Each case below inserts the exact row the constraint was written to refuse and asserts Postgres
  rejects it, so a constraint weakened, misspelled, or written one-directionally fails HERE rather
  than admitting bad data silently.

  ## What C.1's records add, and why each exists

  **An authorization names what it is for: a seller, or a stand** (§there is no second permission
  system). A stand with no seller of its own still has people who manage it — its hours, closure,
  description, and who sells there — and they cannot be reached through a seller authorization
  because there is no seller to name. So the record carries either a seller or a stand, one record
  with two arms, the way `stand_providers` used to name a seller or nothing.

  This is NOT a second permission system. "Stand owner" is not a role: it is what being authorized
  for the seller a stand points at already gets you, derived through the self-pointer and never
  stored. The stand arm exists only for the stand that HAS no such seller.

  **The host stock right is a property of the hosting relationship**, not of the stand and not of
  the role. Some hosted sellers want the host restocking on their behalf — a baker who drops off
  at dawn and would rather the host mark the last loaf gone than be texted about it. Zoe at
  Venison Valley specifically does not. So the `stand_providers` row that binds a seller to a
  stand carries whether that seller's stock may be updated by the stand's own authorized phones.

  Two things it must not become, and both are asserted below:

  - **Not a default.** An invitation that silently conferred stock rights would make acceptance
    mean more than it says, which §hosting and approval lifecycle forbids: *acceptance never
    grants more access than the explicit scopes attached to the relationship.* Off unless the
    seller turns it on.
  - **Not a general permission.** It covers current stock only, which is a rendering-and-writer
    fact rather than a constraint — what the column can guarantee here is that it is a plain
    boolean that is never NULL, so no reader has to defend against "never said".

  ## Why the arm rule is a biconditional

  **A CHECK PASSES on NULL.** "A seller is named" evaluates to NULL on the row that omits it, and
  NULL is not false, so the row is admitted. The rule below therefore attacks both directions: the
  row naming BOTH a seller and a stand (which would make "what is this for" ambiguous, and would
  let one authorization satisfy composite keys on both sides), and the row naming NEITHER (an
  authorization for nothing at all, which every reader would silently skip).
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/** Postgres codes: 23514 is a CHECK violation, 23505 a unique violation, 23502 a NOT NULL one. */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const NOT_NULL_VIOLATION = "23502";

describe("F-114 Phase C.1 authorization arms and host stock right, by sabotage (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let sellerId = "";
  let hostedSellerId = "";
  let standLocationId = "";
  let venueLocationId = "";
  let hostedProviderId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  /** Assert a statement is refused, and by WHICH constraint — not merely that it threw. */
  const refuses = async (
    run: () => Promise<unknown>,
    expected: { code: string; constraint?: string },
  ): Promise<void> => {
    await expect(run()).rejects.toMatchObject(
      expected.constraint
        ? { code: expected.code, constraint_name: expected.constraint }
        : { code: expected.code },
    );
  };

  /** A fresh contact per case, so each attacks its own row rather than colliding on uniqueness. */
  const freshContact = async (): Promise<string> => {
    const rows = await client()`
      insert into contacts (phone_e164, phone_hash)
      values (
        ${`+1206555${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`},
        ${`c1${randomUUID().replaceAll("-", "")}`}
      ) returning id
    `;
    return rows[0]?.id as string;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114arm_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });

    const db = client();
    const sellers = await db`
      insert into sellers (name) values ('Venison Valley'), ('Gracies Greens') returning id
    `;
    sellerId = sellers[0]?.id as string;
    hostedSellerId = sellers[1]?.id as string;

    const mkLocation = async (name: string, owner: string | null): Promise<string> => {
      const rows = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
          public_address, public_latitude, public_longitude
        ) values (
          ${owner}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable', 'produce',
          true, ${`${name} Road, Vashon WA`}, 47.4473, -122.4590
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    standLocationId = await mkLocation("Venison Valley Stand", sellerId);
    // Morgan Hill's shape: a venue that sells nothing of its own, so the self-pointer is NULL and
    // there is no seller an authorization could name. This is the row the stand arm exists for.
    venueLocationId = await mkLocation("Morgan Hill Community Stand", null);

    // Gracie's Greens hosted at Kelsey's stand — the Venison Valley case, exactly as measured.
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
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  describe("an authorization names a seller, or a stand, and never both or neither", () => {
    it("admits the seller arm — the ordinary farmer authorization, unchanged", async () => {
      // The arm every existing authorization uses. If C.1's widening broke this, 14 live
      // authorizations would stop being writable, so it is asserted as a POSITIVE case rather
      // than assumed from the sabotage cases below.
      const db = client();
      const rows = await db`
        insert into farmer_authorizations (
          seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (${sellerId}, null, ${await freshContact()}, now(), now())
        returning id, seller_id, sales_location_id
      `;
      expect(rows[0]?.seller_id).toBe(sellerId);
      expect(rows[0]?.sales_location_id).toBeNull();
    });

    it("admits the stand arm — the venue nobody could be authorized for before", async () => {
      // Morgan Hill has no seller of its own, so before this arm no phone could be authorized to
      // manage it at all. Measured 2026-08-15: no phone ever was, and its one inventory revision
      // has `source = 'viga'` — VIGA maintaining it by hand. That is a TRANSITIONAL state, not a
      // permanent one, and this row is what ends it.
      const db = client();
      const rows = await db`
        insert into farmer_authorizations (
          seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (null, ${venueLocationId}, ${await freshContact()}, now(), now())
        returning id, seller_id, sales_location_id
      `;
      expect(rows[0]?.seller_id).toBeNull();
      expect(rows[0]?.sales_location_id).toBe(venueLocationId);
    });

    it("refuses an authorization naming BOTH a seller and a stand", async () => {
      // The arm that states too much. Such a row would satisfy composite keys on both sides at
      // once, so a seller-level fact could be filed by a stand-armed authorization and the
      // question "what is this authorization for" would have two answers.
      const db = client();
      const contactId = await freshContact();
      await refuses(
        () => db`
          insert into farmer_authorizations (
            seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
          ) values (${sellerId}, ${venueLocationId}, ${contactId}, now(), now())
        `,
        { code: CHECK_VIOLATION, constraint: "farmer_authorizations_subject_arm" },
      );
    });

    it("refuses an authorization naming NEITHER", async () => {
      // The arm that states too little, and the half a one-directional CHECK would admit. An
      // authorization for nothing at all is not an error any reader would raise: every one of
      // them joins on a subject, so the row would simply never match and the person would be
      // silently unable to act with nothing saying why.
      const db = client();
      const contactId = await freshContact();
      await refuses(
        () => db`
          insert into farmer_authorizations (
            seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
          ) values (null, null, ${contactId}, now(), now())
        `,
        { code: CHECK_VIOLATION, constraint: "farmer_authorizations_subject_arm" },
      );
    });

    it("still refuses two live authorizations for one contact at one seller", async () => {
      // `farmer_authorizations_one_active_contact_per_seller` predates this work and must survive
      // the column becoming nullable. A partial unique index on a now-nullable column is exactly
      // where a widening quietly stops enforcing.
      const db = client();
      const contactId = await freshContact();
      await db`
        insert into farmer_authorizations (
          seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (${sellerId}, null, ${contactId}, now(), now())
      `;
      await refuses(
        () => db`
          insert into farmer_authorizations (
            seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
          ) values (${sellerId}, null, ${contactId}, now(), now())
        `,
        {
          code: UNIQUE_VIOLATION,
          constraint: "farmer_authorizations_one_active_contact_per_seller",
        },
      );
    });

    it("refuses two live authorizations for one contact at one stand", async () => {
      // The stand arm needs its OWN uniqueness. The seller index cannot cover it: both rows have
      // `seller_id` NULL, and NULLs never collide in a unique index, so without this a person
      // could hold five live authorizations for one venue.
      const db = client();
      const contactId = await freshContact();
      await db`
        insert into farmer_authorizations (
          seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (null, ${venueLocationId}, ${contactId}, now(), now())
      `;
      await refuses(
        () => db`
          insert into farmer_authorizations (
            seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
          ) values (null, ${venueLocationId}, ${contactId}, now(), now())
        `,
        {
          code: UNIQUE_VIOLATION,
          constraint: "farmer_authorizations_one_active_contact_per_stand",
        },
      );
    });

    it("admits the same contact again once the first authorization is revoked", async () => {
      // Both indexes are partial on `revoked_at is null`. A farmer removed and later restored is
      // an ordinary event, and an index that refused it would make revocation permanent.
      const db = client();
      const contactId = await freshContact();
      const first = await db`
        insert into farmer_authorizations (
          seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (null, ${venueLocationId}, ${contactId}, now(), now()) returning id
      `;
      await db`
        update farmer_authorizations set revoked_at = now() where id = ${first[0]?.id as string}
      `;
      const second = await db`
        insert into farmer_authorizations (
          seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (null, ${venueLocationId}, ${contactId}, now(), now()) returning id
      `;
      expect(second[0]?.id).toBeTruthy();
    });

    it("holds no armless row anywhere, including the ones the migration wrote", async () => {
      // The CHECK above proves nothing about rows that already existed when it was added. A
      // constraint added `NOT VALID`, or added after a backfill that missed a row, would pass
      // every insert case above while live data violated it. Assert the populated table.
      const rows = await client()`
        select
          count(*) filter (
            where (seller_id is null) = (sales_location_id is null)
          )::int as armless,
          count(*)::int as total
        from farmer_authorizations
      `;
      expect(rows[0]?.armless).toBe(0);
      expect(Number(rows[0]?.total)).toBeGreaterThan(0);
    });
  });

  describe("the host stock right is off unless the seller turns it on", () => {
    it("defaults to false on a provider row that never mentions it", async () => {
      // The whole point of the default. An invitation that silently conferred stock rights would
      // make acceptance mean more than it says. The hosted provider in `beforeAll` names no such
      // column, which is how every invitation writer will create one.
      const rows = await client()`
        select host_may_update_stock from stand_providers where id = ${hostedProviderId}
      `;
      expect(rows[0]?.host_may_update_stock).toBe(false);
    });

    it("defaults to false for every row the migration backfilled", async () => {
      // 38 stands' own-seller providers already exist. If the backfill defaulted them to true,
      // every host would silently gain rights over goods that are not theirs — and for an own
      // seller the value is meaningless anyway, since the host and the seller are the same party.
      const rows = await client()`
        select
          count(*) filter (where host_may_update_stock)::int as granted,
          count(*) filter (where host_may_update_stock is null)::int as unstated,
          count(*)::int as total
        from stand_providers
      `;
      expect(rows[0]?.granted).toBe(0);
      expect(rows[0]?.unstated).toBe(0);
      expect(Number(rows[0]?.total)).toBeGreaterThan(0);
    });

    it("refuses a NULL, so no reader has to defend against 'never said'", async () => {
      // Two-state, not three. `unknown` would force every stock writer to decide what silence
      // means, and the answer would be "no" at every one of them — a case that can only be got
      // wrong, expressed once here instead.
      const db = client();
      await refuses(
        () => db`
          update stand_providers set host_may_update_stock = null where id = ${hostedProviderId}
        `,
        { code: NOT_NULL_VIOLATION },
      );
    });

    it("records the seller's opt-in when they state it", async () => {
      // The baker who drops off at dawn. Asserted by effect rather than by the column existing.
      const db = client();
      await db`
        update stand_providers set host_may_update_stock = true where id = ${hostedProviderId}
      `;
      const rows = await db`
        select host_may_update_stock from stand_providers where id = ${hostedProviderId}
      `;
      expect(rows[0]?.host_may_update_stock).toBe(true);
      await db`
        update stand_providers set host_may_update_stock = false where id = ${hostedProviderId}
      `;
    });
  });
});
