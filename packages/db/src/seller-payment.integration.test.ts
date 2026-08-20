import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./index";

/*
  F-125 — payment belongs to the SELLER, and a stand may only NARROW it.

  `payment-resolution.test.ts` in core proves the rule as pure logic. This proves the parts only
  a real database can: that the schema puts the fact in exactly one place, that the override can
  remove but has no way to add, and that the two tables' constraints actually hold.

  ## Why "cannot add" is tested as a SHAPE rather than as a refusal

  There is no representation for "this stand adds a method the seller does not take" — the
  override table names exclusions. So the test does not assert that adding is rejected; it
  asserts that the resolved answer is always a SUBSET of what the seller states, no matter what
  the exclusions say. A guard could be forgotten by the next writer; a missing column cannot.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/**
 * The resolution, as SQL — the same rule `resolvePaymentMethods` states in code and the public
 * map runs inline. Written once here so every assertion below exercises the real join rather
 * than a hand-built expectation.
 */
async function resolved(
  sql: Sql,
  input: { locationId: string; sellerId: string },
): Promise<string[]> {
  const rows = await sql`
    select payment.method
    from seller_payment_methods payment
    where payment.seller_id = ${input.sellerId}
      and not exists (
        select 1 from sales_location_payment_method_exclusions excluded
        where excluded.sales_location_id = ${input.locationId}
          and excluded.seller_id = payment.seller_id
          and lower(btrim(excluded.method)) = lower(btrim(payment.method))
      )
    order by payment.method
  `;
  return rows.map((row) => row.method as string);
}

describe("seller-owned payment with a stand override (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let databaseName = "";

  /** Sells at her own stand AND, as a guest, at the host's. The case F-125 exists for. */
  let bakerSellerId = "";
  let hostSellerId = "";
  let bakerStandId = "";
  let hostStandId = "";

  const sql = (): Sql => client as Sql;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_sellerpay_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    const sellers = await sql()`
      insert into sellers (name) values ('Fernhorn Bakery'), ('Tian Tian Farm')
      returning id, name
    `;
    bakerSellerId = sellers.find((row) => row.name === "Fernhorn Bakery")?.id as string;
    hostSellerId = sellers.find((row) => row.name === "Tian Tian Farm")?.id as string;

    const stands = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
        public_address, public_latitude, public_longitude
      ) values
        (${bakerSellerId}, 'farm_stand', 'Bakery Stand', 'America/Los_Angeles',
         'visitable', 'produce', true, '1 Baker Way', 47.44, -122.45),
        (${hostSellerId}, 'farm_stand', 'Host Stand', 'America/Los_Angeles',
         'visitable', 'produce', true, '2 Host Way', 47.45, -122.46)
      returning id, name
    `;
    bakerStandId = stands.find((row) => row.name === "Bakery Stand")?.id as string;
    hostStandId = stands.find((row) => row.name === "Host Stand")?.id as string;

    // She states her methods ONCE, as herself.
    await sql()`
      insert into seller_payment_methods (seller_id, method)
      values (${bakerSellerId}, 'Cash'), (${bakerSellerId}, 'Check'), (${bakerSellerId}, 'Venmo')
    `;
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    if (adminClient) {
      await adminClient.unsafe(`drop database if exists "${databaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("gives one seller the same answer at every stand she sells at", async () => {
    // The defect F-125 removes: she used to state this per stand and could leave three
    // disagreeing. One row set, read from two different stands, is the fix.
    expect(await resolved(sql(), { locationId: bakerStandId, sellerId: bakerSellerId }))
      .toEqual(["Cash", "Check", "Venmo"]);
    expect(await resolved(sql(), { locationId: hostStandId, sellerId: bakerSellerId }))
      .toEqual(["Cash", "Check", "Venmo"]);
  });

  it("lets a host narrow what she takes AT ITS STAND ONLY", async () => {
    // The motivating case, stated by max: a hosted seller who cannot take cash at a particular
    // stand because the host cannot support it.
    await sql()`
      insert into sales_location_payment_method_exclusions (sales_location_id, seller_id, method)
      values (${hostStandId}, ${bakerSellerId}, 'Cash')
    `;

    expect(await resolved(sql(), { locationId: hostStandId, sellerId: bakerSellerId }))
      .toEqual(["Check", "Venmo"]);
    // Her OWN stand is untouched — the override is the host's fact about its location, and it
    // must not leak into what she states everywhere else.
    expect(await resolved(sql(), { locationId: bakerStandId, sellerId: bakerSellerId }))
      .toEqual(["Cash", "Check", "Venmo"]);
  });

  it("cannot ADD a method through the override, whatever it names", async () => {
    // Excluding something she does not take is inert. This is "cannot add" expressed as a
    // value: there is no exclusion row that makes the resolved list longer.
    await sql()`
      insert into sales_location_payment_method_exclusions (sales_location_id, seller_id, method)
      values (${hostStandId}, ${bakerSellerId}, 'Zelle')
    `;

    const answer = await resolved(sql(), { locationId: hostStandId, sellerId: bakerSellerId });
    expect(answer).toEqual(["Check", "Venmo"]);
    expect(answer).not.toContain("Zelle");

    // Stated as the general property too, so a future change that invents some other way to
    // widen the answer fails here rather than only in the specific case above.
    const stated = await sql()`
      select method from seller_payment_methods where seller_id = ${bakerSellerId}
    `;
    const statedMethods = stated.map((row) => row.method as string);
    for (const method of answer) expect(statedMethods).toContain(method);
  });

  it("narrows ONLY the seller the exclusion names, not everyone at that stand", async () => {
    /*
      Found by sabotage: dropping the seller match from the resolution left every other test
      green, because no second seller sold at the host's stand. A host restriction that leaked
      onto its co-sellers would tell customers a farm refuses cash it actually takes — and the
      host would have no way to see it, since the fact reads correctly on its own card.

      The host sells at its own stand too, so it is the co-seller here.
    */
    await sql()`
      insert into seller_payment_methods (seller_id, method)
      values (${hostSellerId}, 'Cash'), (${hostSellerId}, 'Check')
    `;

    // The bakery's cash exclusion at this stand is already in place from the test above.
    expect(await resolved(sql(), { locationId: hostStandId, sellerId: bakerSellerId }))
      .not.toContain("Cash");
    // The HOST still takes cash at the very same stand.
    expect(await resolved(sql(), { locationId: hostStandId, sellerId: hostSellerId }))
      .toEqual(["Cash", "Check"]);
  });

  it("refuses an exclusion whose seller or stand does not exist", async () => {
    // The composite pair is unavailable as an FK target (`stand_providers` is unique on
    // (location, seller) only through a PARTIAL index), so each side is referenced separately.
    // These two assertions are what prove those references are real rather than decorative.
    await expect(sql()`
      insert into sales_location_payment_method_exclusions (sales_location_id, seller_id, method)
      values (${randomUUID()}, ${bakerSellerId}, 'Cash')
    `).rejects.toThrow(/foreign key|violates/i);

    await expect(sql()`
      insert into sales_location_payment_method_exclusions (sales_location_id, seller_id, method)
      values (${hostStandId}, ${randomUUID()}, 'Cash')
    `).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses a blank method on either table", async () => {
    await expect(sql()`
      insert into seller_payment_methods (seller_id, method)
      values (${hostSellerId}, '   ')
    `).rejects.toThrow(/not_blank|violates/i);

    await expect(sql()`
      insert into sales_location_payment_method_exclusions (sales_location_id, seller_id, method)
      values (${hostStandId}, ${bakerSellerId}, '  ')
    `).rejects.toThrow(/not_blank|violates/i);
  });

  it("keeps VIGA Bucks off the methods list and on the seller (B-054, F-125)", async () => {
    // B-054 — Farm Bucks is a separate boolean, never an ordinary method, because a stand
    // carrying the claim in two places printed it twice. F-125 moved the boolean to the
    // seller; the "one home" rule is what must survive the move.
    const methods = await sql()`
      select method from seller_payment_methods where seller_id = ${bakerSellerId}
    `;
    expect(methods.map((row) => row.method as string)).not.toContain("VIGA Farm Bucks");

    // And it defaults to ACCEPTING for a seller nobody has asked (max, 2026-08-20): Farm Bucks
    // is near-universal among VIGA farms, so silence is nobody ticking a box, not a refusal.
    const sellerRow = await sql()`
      select farm_bucks_accepted from sellers where id = ${bakerSellerId}
    `;
    expect(sellerRow[0]?.farm_bucks_accepted).toBe(true);
  });

  it("drops a seller's methods and exclusions with the seller", async () => {
    // Both tables cascade from the seller. A payment row outliving the seller it describes
    // would be an orphaned claim about somebody who no longer exists.
    const doomed = await sql()`insert into sellers (name) values ('Doomed Farm') returning id`;
    const doomedId = doomed[0]?.id as string;
    await sql()`
      insert into seller_payment_methods (seller_id, method) values (${doomedId}, 'Cash')
    `;
    await sql()`
      insert into sales_location_payment_method_exclusions (sales_location_id, seller_id, method)
      values (${hostStandId}, ${doomedId}, 'Cash')
    `;

    await sql()`delete from sellers where id = ${doomedId}`;

    expect(await sql()`
      select method from seller_payment_methods where seller_id = ${doomedId}
    `).toHaveLength(0);
    expect(await sql()`
      select method from sales_location_payment_method_exclusions where seller_id = ${doomedId}
    `).toHaveLength(0);
  });
});
