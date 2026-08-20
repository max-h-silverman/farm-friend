import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

// F-038 — a farm you CONTACT rather than VISIT.
//
// The 2026 form export contains two members that are not farm stands, and they differ from each
// other in a way one enum cannot express:
//
//   Seedrain / Garden Cycles   has a street address, sells SERVICES — nothing to browse
//   Open Gate Lamb and Grazing has NO address at all ("On island delivery for orders over $50")
//
// So two independent properties, per max's decision (2026-07-29):
//
//   visitability   visitable | contact_only   — decides whether a location has a place to go
//   offering_type  produce | services | by_order — decides what the farm provides
//
// The invariant asserted here is the one that has to be STRUCTURAL, because Golden Rule #1 and
// the honesty of the map both rest on it: a `visitable` location must carry an address AND
// coordinates, and a `contact_only` location must carry NEITHER. All-or-nothing in both
// directions — same shape as F-035's `coherent_season`.
//
// Why "neither", rather than merely allowing null: a contact-only farm with a half-filled
// address is precisely what sends a customer driving to a place that has nothing. The old map
// export DOES carry coordinates for Open Gate Lamb, so this constraint is what stops those
// coordinates being seeded onto a farm with no stand.
//
// NOTE ON SQL NULL SEMANTICS — the standing rule from CLAUDE.md. A CHECK constraint PASSES on
// NULL, so `public_address is not null` written the obvious way still admits the row it was
// meant to forbid unless every branch is stated explicitly. Each case below is asserted with a
// concrete expected value rather than a shape.

const databaseUrl = process.env.DATABASE_URL;
const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe.skipIf(!databaseUrl)("visitability and offering type (integration)", () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let dbName: string;
  let farmId: string;

  function db(): Sql {
    return sql as unknown as Sql;
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    dbName = `farm_friend_f038_${randomUUID().replace(/-/g, "")}`;
    admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${dbName}"`);

    const target = new URL(databaseUrl);
    target.pathname = `/${dbName}`;
    sql = postgres(target.toString(), { max: 1, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: migrationsDir });

    const sellers = await sql`
      insert into sellers (name)
      values ('F-038 Farm')
      returning id
    `;
    farmId = sellers[0]!.id as string;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin) {
      await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  /** Insert a location, letting the caller state exactly which fields are present. */
  function insertLocation(fields: {
    name: string;
    visitability: string;
    offeringType: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  }) {
    return db()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude
      )
      values (
        ${farmId}, 'farm_stand', ${fields.name}, 'America/Los_Angeles',
        ${fields.visitability}::sales_location_visitability,
        ${fields.offeringType}::sales_location_offering_type, ${fields.address},
        ${fields.latitude}, ${fields.longitude}
      )
      returning id, visitability, offering_type, public_address
    `;
  }

  it("declares both new enums with exactly the intended values", async () => {
    const values = async (typname: string) =>
      (
        await db()`
          select enumlabel from pg_enum
          join pg_type on pg_type.oid = pg_enum.enumtypid
          where pg_type.typname = ${typname}
          order by enumsortorder
        `
      ).map((row) => row.enumlabel);

    expect(await values("sales_location_visitability")).toEqual([
      "visitable",
      "contact_only",
    ]);
    expect(await values("sales_location_offering_type")).toEqual([
      "produce",
      "services",
      "by_order",
    ]);
  });

  it("accepts an ordinary visitable stand with address and coordinates", async () => {
    const rows = await insertLocation({
      name: "Ordinary Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "13609 SW 220th St",
      latitude: 47.45,
      longitude: -122.46,
    });
    expect(rows[0]!.visitability).toBe("visitable");
    expect(rows[0]!.public_address).toBe("13609 SW 220th St");
  });

  it("accepts a contact-only farm with no address and no coordinates", async () => {
    // Open Gate Lamb: delivery only, ordered by email. Before F-038 this row was impossible —
    // `public_address` was NOT NULL, which is exactly why the seeder refused it.
    const rows = await insertLocation({
      name: "Open Gate Lamb and Grazing",
      visitability: "contact_only",
      offeringType: "by_order",
      address: null,
      latitude: null,
      longitude: null,
    });
    expect(rows[0]!.visitability).toBe("contact_only");
    expect(rows[0]!.public_address).toBeNull();
  });

  it("accepts a visitable farm that sells services rather than produce", async () => {
    // Seedrain: a real street address, but nothing to browse. The two properties are
    // independent, and this row is the proof — `visitable` with `services`.
    const rows = await insertLocation({
      name: "Seedrain and Garden Cycles",
      visitability: "visitable",
      offeringType: "services",
      address: "20407 81st Ave SW",
      latitude: 47.42,
      longitude: -122.47,
    });
    expect(rows[0]!.offering_type).toBe("services");
    expect(rows[0]!.visitability).toBe("visitable");
  });

  it("REFUSES a visitable location missing its address", async () => {
    await expect(
      insertLocation({
        name: "Visitable Without Address",
        visitability: "visitable",
        offeringType: "produce",
        address: null,
        latitude: 47.45,
        longitude: -122.46,
      }),
    ).rejects.toThrow();
  });

  it("REFUSES a visitable location missing its coordinates", async () => {
    // Without coordinates the map cannot place it, so "visitable" would be a promise the
    // system cannot keep.
    await expect(
      insertLocation({
        name: "Visitable Without Coordinates",
        visitability: "visitable",
        offeringType: "produce",
        address: "1 Somewhere Rd",
        latitude: null,
        longitude: null,
      }),
    ).rejects.toThrow();
  });

  it("REFUSES a visitable location with only one coordinate", async () => {
    // Half a coordinate pair places a pin in the ocean. Latitude alone is not a location.
    await expect(
      insertLocation({
        name: "Half A Coordinate",
        visitability: "visitable",
        offeringType: "produce",
        address: "2 Somewhere Rd",
        latitude: 47.45,
        longitude: null,
      }),
    ).rejects.toThrow();
  });

  it("REFUSES a contact-only location that carries an address", async () => {
    // The dangerous direction. The OLD map export has coordinates and prose for Open Gate
    // Lamb; seeding those onto a farm with no stand is what would send a customer driving to
    // nothing. The database refuses it rather than trusting the loader to remember.
    await expect(
      insertLocation({
        name: "Contact Only With Address",
        visitability: "contact_only",
        offeringType: "by_order",
        address: "3 Somewhere Rd",
        latitude: null,
        longitude: null,
      }),
    ).rejects.toThrow();
  });

  it("REFUSES a contact-only location that carries coordinates", async () => {
    await expect(
      insertLocation({
        name: "Contact Only With Coordinates",
        visitability: "contact_only",
        offeringType: "by_order",
        address: null,
        latitude: 47.41,
        longitude: -122.49,
      }),
    ).rejects.toThrow();
  });

  it("still enforces the coordinate RANGE on visitable locations", async () => {
    // The pre-existing `valid_coordinates` check must survive being made conditional. A
    // constraint rewritten to allow NULL is the classic way to accidentally allow everything.
    await expect(
      insertLocation({
        name: "Out Of Range",
        visitability: "visitable",
        offeringType: "produce",
        address: "4 Somewhere Rd",
        latitude: 91,
        longitude: -122.46,
      }),
    ).rejects.toThrow();
  });

  it("still enforces the non-blank address rule on visitable locations", async () => {
    // Blank is not null. Making the column nullable must not turn "   " into a legal address.
    await expect(
      insertLocation({
        name: "Blank Address",
        visitability: "visitable",
        offeringType: "produce",
        address: "   ",
        latitude: 47.45,
        longitude: -122.46,
      }),
    ).rejects.toThrow();
  });

});
