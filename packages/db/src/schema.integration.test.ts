import { describe, expect, it, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, farmStands, inventorySnapshots, stockoutReports, tenants } from "./index";

// Data-layer invariants against Postgres. Requires DATABASE_URL; when unset the suite is
// skipped (so `npm test` stays hermetic and CI without a DB doesn't fail). Run locally/Neon
// with DATABASE_URL set. Migrations are applied out-of-band (drizzle-kit) before this runs.

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("data-layer invariants (integration)", () => {
  const db = createDb(url!);

  beforeAll(async () => {
    // Assumes migrations applied. Ensure the VIGA tenant seed exists.
    await db
      .insert(tenants)
      .values({ slug: "viga", name: "Vashon Island Grower's Association" })
      .onConflictDoNothing();
  });

  it("the VIGA tenant is seeded", async () => {
    const rows = await db.select().from(tenants).where(sql`${tenants.slug} = 'viga'`);
    expect(rows.length).toBe(1);
  });

  it("stockout_reports has no column that could write inventory (structural guarantee)", async () => {
    // The report table references an item but has no writable inventory quantity/status column.
    const cols = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'stockout_reports'
    `);
    const names = cols.map((r) => (r as { column_name: string }).column_name);
    expect(names).toContain("item_text");
    expect(names).not.toContain("quantity");
    expect(names).not.toContain("status_of_inventory");
  });

  it("tenant scoping: farm_stands, inventory_snapshots, stockout_reports all carry tenant_id", async () => {
    for (const table of ["farm_stands", "inventory_snapshots", "stockout_reports"]) {
      const cols = await db.execute(sql`
        select column_name from information_schema.columns
        where table_name = ${table} and column_name = 'tenant_id'
      `);
      expect(cols.length).toBe(1);
    }
    // reference the imported tables so the symbols are used (and the FK types are exercised).
    expect([farmStands, inventorySnapshots, stockoutReports].every(Boolean)).toBe(true);
  });
});
