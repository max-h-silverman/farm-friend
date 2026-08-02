import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();
const migration = readFileSync(
  resolve(repo, "packages/db/drizzle/0015_overrated_gertrude_yorkes.sql"),
  "utf8",
);
const snapshot = JSON.parse(
  readFileSync(resolve(repo, "packages/db/drizzle/meta/0015_snapshot.json"), "utf8"),
) as {
  tables: Record<string, { columns: Record<string, unknown> }>;
};
const journal = JSON.parse(
  readFileSync(resolve(repo, "packages/db/drizzle/meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

describe("F-056 migration metadata", () => {
  it("keeps every hand-authored CHECK in executable migration SQL", () => {
    // drizzle-kit omits these checks. This is intentionally anchored to the complete
    // ALTER/CREATE constructs so nearby vocabulary cannot satisfy the tripwire.
    expect(migration).toMatch(
      /CONSTRAINT "admin_login_failures_bucket_hash_shape"\s+CHECK \("admin_login_failures"\."bucket_hash" ~ '\^\[0-9a-f\]\{64\}\$'\)/,
    );
    expect(migration).toMatch(
      /CONSTRAINT "admin_login_failures_positive_count"\s+CHECK \("admin_login_failures"\."failure_count" > 0\)/,
    );
    expect(migration).toMatch(
      /CONSTRAINT "admin_login_failures_future_window"\s+CHECK \("admin_login_failures"\."window_expires_at" > "admin_login_failures"\."updated_at"\)/,
    );
    expect(migration).toMatch(
      /ALTER TABLE "administrators" ADD CONSTRAINT "administrators_fixed_identity"\s+CHECK \("administrators"\."email" = 'board@vigavashon\.org'\)/,
    );
  });

  it("revokes every old session before removing magic-link provenance", () => {
    const revoke = migration.indexOf('UPDATE "admin_sessions"');
    const drop = migration.indexOf(
      'ALTER TABLE "admin_sessions" DROP COLUMN IF EXISTS "magic_nonce_hash"',
    );
    expect(revoke).toBeGreaterThan(-1);
    expect(migration.slice(revoke, drop)).toMatch(
      /SET "revoked_at" = greatest\("issued_at", now\(\)\)\s+WHERE "revoked_at" IS NULL/,
    );
    expect(drop).toBeGreaterThan(revoke);
  });

  it("records one ordered migration and a final schema with no nonce", () => {
    const latest = journal.entries.at(-1);
    const previous = journal.entries.at(-2);
    expect(latest).toEqual({
      idx: 15,
      when: 1_786_400_000_000,
      tag: "0015_overrated_gertrude_yorkes",
      breakpoints: true,
      version: "7",
    });
    expect(latest!.when).toBeGreaterThan(previous!.when);
    expect(Object.keys(snapshot.tables["public.admin_sessions"]!.columns).sort()).toEqual(
      ["administrator_id", "expires_at", "id", "issued_at", "revoked_at", "token_hash"].sort(),
    );
    expect(Object.keys(snapshot.tables["public.admin_login_failures"]!.columns).sort()).toEqual(
      ["bucket_hash", "failure_count", "updated_at", "window_expires_at"].sort(),
    );
  });
});
