import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashEmail } from "@farm-friend/core";

import { createDb } from "./index";
import { ingestFarmEmails } from "./farm-emails";

// F-078 — the roster ingest, against real Postgres and the real unique index.
//
// The idempotency claim is the reason this is an integration test rather than a unit one: it
// rests entirely on `on conflict do nothing` against
// `seller_emails_one_per_farm_address`, which indexes `lower(btrim(email, E' \t\r\n'))`. A fake
// database cannot tell you whether that index arbitrates the way the code assumes.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const SALT = "ingest-test-salt";
const NOW = new Date("2026-08-06T12:00:00Z");

describe("F-078 farm email ingest (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let databaseName = "";

  const sql = () => {
    if (!client) throw new Error("no database client");
    return client;
  };
  const database = () => {
    if (!db) throw new Error("no database");
    return db;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_email_ingest_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
    db = createDb(url.toString());

    for (const name of ["Lavender Hill Farm", "Holmestead"]) {
      await sql()`insert into sellers (name, created_at) values (${name}, ${NOW.toISOString()})`;
    }
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    await client?.end();
    if (adminClient) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end();
    }
  });

  it("writes every address, including a farm with three", async () => {
    const result = await ingestFarmEmails(
      database(),
      [
        {
          farmName: "Lavender Hill Farm",
          emails: ["cathy@example.com", "info@example.com", "shop@example.com"],
        },
        { farmName: "Holmestead", emails: ["holme@example.com"] },
      ],
      SALT,
      NOW,
    );

    expect(result.inserted).toBe(4);
    expect(result.skipped).toBe(0);

    // Read back from the rows, not from the return value.
    const rows = await sql()`select email, email_hash from seller_emails order by email`;
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.email)).toEqual([
      "cathy@example.com",
      "holme@example.com",
      "info@example.com",
      "shop@example.com",
    ]);
    // The hash is the lookup key, so a wrong one is a row nothing can ever find.
    for (const row of rows) {
      expect(row.email_hash).toBe(hashEmail(row.email as string, SALT));
    }
  });

  it("is IDEMPOTENT — a second identical run writes nothing", async () => {
    const before = await sql()`select count(*)::int as n from seller_emails`;

    const result = await ingestFarmEmails(
      database(),
      [
        {
          farmName: "Lavender Hill Farm",
          emails: ["cathy@example.com", "info@example.com", "shop@example.com"],
        },
        { farmName: "Holmestead", emails: ["holme@example.com"] },
      ],
      SALT,
      NOW,
    );

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(4);

    const after = await sql()`select count(*)::int as n from seller_emails`;
    expect((after[0] as { n: number }).n).toBe((before[0] as { n: number }).n);
  });

  it("treats a differently-cased address as the SAME address, matching the index", async () => {
    // The index normalizes case, so an ingest that did not would insert a row the index
    // rejects — or worse, would report success for a duplicate it never wrote.
    const result = await ingestFarmEmails(
      database(),
      [{ farmName: "Lavender Hill Farm", emails: ["CATHY@example.com"] }],
      SALT,
      NOW,
    );

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("REPORTS a farm it could not match rather than dropping it", async () => {
    const result = await ingestFarmEmails(
      database(),
      [{ farmName: "No Such Farm", emails: ["nobody@example.com"] }],
      SALT,
      NOW,
    );

    expect(result.unmatchedFarmNames).toEqual(["No Such Farm"]);
    expect(result.inserted).toBe(0);
    const rows = await sql()`select 1 from seller_emails where email = 'nobody@example.com'`;
    expect(rows).toHaveLength(0);
  });

  it("REPORTS a farm with no address — the set that must contact VIGA", async () => {
    // ~3 of the 35 seeded sellers are in this state. Naming them is the whole point: a farmer
    // who cannot verify needs to be told to contact VIGA, and VIGA needs to know who they are.
    const result = await ingestFarmEmails(
      database(),
      [{ farmName: "Holmestead", emails: [] }],
      SALT,
      NOW,
    );

    expect(result.farmsWithoutEmail).toEqual(["Holmestead"]);
    expect(result.inserted).toBe(0);
  });
});
