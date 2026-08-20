import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb } from "@farm-friend/db";
import { hashEmail } from "@farm-friend/core";

import { handleStandsRequest, listPublicStands } from "./public-listing";

/** A fixed clock — the reader needs one, and recency plays no part in this file's property. */
const CLOCK = { now: () => new Date("2026-08-06T12:00:00Z") };

// F-078 — "no public read path returns an email", proven BY EFFECT.
//
// This is the acceptance criterion that a schema cannot enforce and a source scan cannot
// honestly prove. `seller_emails` has no `is_public` column and no display column; whether an
// address reaches a customer is a property of the QUERIES, and the only way to know is to put
// a real address in a real database and look at what the real reader returns.
//
// **Why not a source grep.** A test asserting `public-listing.ts` does not contain the string
// "seller_emails" passes the moment someone selects the column through a join, an alias, or a
// `select *` — and it also passes if the reader is deleted entirely. The property is about
// returned BYTES, so the assertion is against returned bytes.
//
// **Verifying is not publishing.** Six of VIGA's sellers answered "No" to putting contact email
// on the printed map and two left it blank, and all of them still authenticate. That is only
// coherent if storage and publication are genuinely separate, which is what this file measures.

// The integration config runs from the repository root, matching every other integration test.
const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

const SALT = "test-salt";
const FARMER_EMAIL = "cathy@lavenderhillfarm.example";

describe("F-078 farm email privacy (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let databaseName = "";

  const sql = () => {
    if (!client) throw new Error("no database client");
    return client;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_email_privacy_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
    db = createDb(url.toString());

    const now = new Date("2026-08-06T12:00:00Z");
    const sellers = await sql()`
      insert into sellers (name, created_at) values ('Lavender Hill Farm', ${now.toISOString()})
      returning id
    `;
    const farmId = sellers[0]?.id as string;

    // A real, public, visitable stand — so the public reader genuinely returns this farm and
    // an absent email cannot be explained by the farm simply not being on the map.
    await sql()`
      insert into sales_locations
        (own_seller_id, name, kind, timezone, visitability, offering_type,
         public_address, public_latitude, public_longitude, is_public)
      values
        (${farmId}, 'Lavender Hill Stand', 'farm_stand', 'America/Los_Angeles',
         'visitable', 'produce', '12345 Vashon Hwy SW', 47.4496, -122.4609, true)
    `;

    await sql()`
      insert into seller_emails (seller_id, email, email_hash, added_at)
      values (${farmId}, ${FARMER_EMAIL}, ${hashEmail(FARMER_EMAIL, SALT)},
              ${now.toISOString()})
    `;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    await client?.end();
    if (adminClient) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end();
    }
  });

  it("stored the address, so a later absence is a real absence", async () => {
    // Asserted FIRST and deliberately. Every assertion below is of the form "the email is not
    // there" — and all of them would pass against a database where the insert silently failed.
    // This is what makes the rest evidence rather than a tautology.
    const rows = await sql()`select email, email_hash from seller_emails`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe(FARMER_EMAIL);
    expect(rows[0]?.email_hash).toBe(hashEmail(FARMER_EMAIL, SALT));
  });

  /**
   * The SERVED BYTES of `/api/public/stands`, which is what an islander actually receives.
   *
   * **This is the level the assertion has to be at, and a sabotage proved it.** An earlier
   * version of this file asserted on the objects `listPublicStands` returns. Selecting the
   * email straight into that query — `(select fe.email from seller_emails …) as leaked_email`,
   * the exact shape a careless join would take — left all four tests PASSING.
   *
   * The reason is a REAL ARCHITECTURAL PROPERTY worth stating: `serializePublicStand` is an
   * explicit allowlist that names every field it emits, so a column leaked into the SQL cannot
   * reach the wire on its own. A single-point sabotage is therefore not enough to prove this
   * test works — the escape was the serializer doing its job, not the test failing.
   *
   * What DOES fail it is a leak carried the whole way: the column selected, mapped onto the
   * stand, AND named in the serializer — which is exactly what adding a well-meant "contact
   * the farmer" field would look like. Sabotaged that way, this test fails and names the
   * exposed address. The response body is asserted rather than the mapped object because the
   * body is the thing that goes over the wire.
   */
  async function servedBytes(): Promise<string> {
    if (!db) throw new Error("no database");
    return (await handleStandsRequest({ db, clock: CLOCK })).text();
  }

  it("the public stand list returns the farm and NOT its email", async () => {
    if (!db) throw new Error("no database");
    const stands = await listPublicStands({ db, clock: CLOCK });

    // The farm really is on the map, so the absence below is about the email and nothing else.
    expect(stands.length).toBeGreaterThan(0);
    expect(stands.some((stand) => stand.farmName.includes("Lavender Hill"))).toBe(true);

    const body = await servedBytes();
    expect(body).toContain("Lavender Hill");
    expect(body).not.toContain(FARMER_EMAIL);
    expect(body).not.toContain("cathy");
    // The domain alone would identify the farmer just as well.
    expect(body).not.toContain("lavenderhillfarm.example");
    // No stray address of any shape — catches one arriving through a field added later.
    expect(body).not.toMatch(/[^@\s"]+@[^@\s"]+\.[^@\s"]+/);
  });

  it("the hash never reaches a customer either", async () => {
    // The hash is a stable per-address identifier. Publishing it would let anyone confirm a
    // guessed address belongs to a farm, which is the lookup key doing the leaking instead.
    expect(await servedBytes()).not.toContain(hashEmail(FARMER_EMAIL, SALT));
  });

  it("no table but seller_emails holds the address anywhere in the database", async () => {
    // The "exactly one column" half of Golden Rule #5. A future writer copying the address
    // into a contact row, a description, or an audit payload would defeat every check above
    // while each of them still passed.
    const columns = (await sql()`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('text', 'character varying')
        and not (table_name = 'seller_emails' and column_name = 'email')
    `) as unknown as Array<{ table_name: string; column_name: string }>;

    for (const { table_name, column_name } of columns) {
      const hits = await sql().unsafe(
        `select count(*)::int as n from "${table_name}" where "${column_name}" = $1`,
        [FARMER_EMAIL],
      );
      expect(
        (hits[0] as unknown as { n: number }).n,
        `${table_name}.${column_name}`,
      ).toBe(0);
    }
  });
});
