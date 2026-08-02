import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(repo, path), "utf8");

function declaration(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `missing declaration start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing declaration end: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

function proposalInsertColumns(source: string): string {
  const marker = "insert into inventory_publication_proposals (";
  const from = source.indexOf(marker);
  expect(from, "missing production proposal insert call site").toBeGreaterThanOrEqual(0);
  const to = source.indexOf(") values (", from + marker.length);
  expect(to, "proposal insert has no values boundary").toBeGreaterThan(from);
  return source.slice(from + marker.length, to);
}

describe("B-032 final schema source tripwires", () => {
  it("declares every required location and proposal fact without a live default", () => {
    const schema = read("packages/db/src/schema.ts");
    const locationFacts = declaration(
      schema,
      'visitability: salesLocationVisitability("visitability")',
      "publicAddress:",
    );
    expect(locationFacts).toContain('.notNull()');
    expect(locationFacts).not.toContain(".default(");

    const proposalFacts = declaration(
      schema,
      'hasInventory: boolean("has_inventory")',
      "baseRevisionId:",
    );
    expect(proposalFacts).toContain('hasInventory: boolean("has_inventory").notNull()');
    expect(proposalFacts).toContain('hasClosure: boolean("has_closure").notNull()');
    expect(proposalFacts).not.toContain(".default(");
  });

  it("anchors both production proposal writers to explicit section flags and no dead fields", () => {
    for (const file of [
      "packages/db/src/transactions.ts",
      "apps/web/lib/scheduled-prompts.ts",
    ]) {
      const columns = proposalInsertColumns(read(file));
      expect(columns, file).toContain("has_inventory, has_closure");
      expect(columns, file).not.toContain("schema_version");
      expect(columns, file).not.toContain("yes_token");
      expect(columns, file).not.toContain("no_token");
    }
  });

  it("anchors the pending migration to each final-schema cutover operation", () => {
    const migration = read("packages/db/drizzle/0010_absurd_mandrill.sql");
    for (const operation of [
      'ALTER TABLE "sales_locations" ALTER COLUMN "visitability" DROP DEFAULT;',
      'ALTER TABLE "sales_locations" ALTER COLUMN "offering_type" DROP DEFAULT;',
      'ALTER TABLE "inventory_publication_proposals" ALTER COLUMN "has_inventory" DROP DEFAULT;',
      'ALTER TABLE "inventory_publication_proposals" ALTER COLUMN "has_closure" DROP DEFAULT;',
      'ALTER TABLE "inventory_publication_proposals" DROP CONSTRAINT "inventory_publication_proposals_distinct_tokens";',
      'ALTER TABLE "inventory_publication_proposals" DROP COLUMN "schema_version";',
      'ALTER TABLE "inventory_publication_proposals" DROP COLUMN "yes_token";',
      'ALTER TABLE "inventory_publication_proposals" DROP COLUMN "no_token";',
    ]) {
      expect(migration, operation).toContain(operation);
    }
  });

  it("keeps every pending snapshot on the final shape while preserving model telemetry", () => {
    for (let index = 10; index <= 14; index += 1) {
      const snapshot = JSON.parse(
        read(`packages/db/drizzle/meta/${String(index).padStart(4, "0")}_snapshot.json`),
      ) as {
        tables: Record<string, { columns: Record<string, { default?: unknown }> }>;
      };
      const proposal = snapshot.tables["public.inventory_publication_proposals"]?.columns;
      const location = snapshot.tables["public.sales_locations"]?.columns;
      const modelRun = snapshot.tables["public.model_runs"]?.columns;
      expect(proposal?.schema_version, `001${index - 10} proposal schema_version`).toBeUndefined();
      expect(proposal?.yes_token, `001${index - 10} proposal yes_token`).toBeUndefined();
      expect(proposal?.no_token, `001${index - 10} proposal no_token`).toBeUndefined();
      expect(proposal?.has_inventory?.default, `001${index - 10} inventory default`).toBeUndefined();
      expect(proposal?.has_closure?.default, `001${index - 10} closure default`).toBeUndefined();
      expect(location?.visitability?.default, `001${index - 10} visitability default`).toBeUndefined();
      expect(location?.offering_type?.default, `001${index - 10} offering default`).toBeUndefined();
      expect(modelRun?.schema_version, `001${index - 10} model telemetry`).toBeDefined();
    }
  });
});
