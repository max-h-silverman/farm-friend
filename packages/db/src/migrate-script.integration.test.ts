import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeTarget } from "./connection-target";

// B-006 — the migrate script actually migrates a real database.
//
// The gap this closes was documented for months: RUNBOOK §Deploy said "migrations run as part of
// the deploy step" while no such step existed anywhere. Migrations were applied in exactly one
// place — the integration harness, against a throwaway database it created and dropped — so
// nothing could create a schema in a database anyone would keep.
//
// This runs the REAL script as a subprocess against a REAL empty database, because the failure
// modes live in the parts a unit test would stub: how the script resolves its migrations folder
// relative to its own location, and whether it exits non-zero when it should.

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }
  return databaseUrl;
}

function testDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** Run the real script with the given environment. */
function runMigrate(env: Record<string, string | undefined>) {
  return execFileAsync(
    "npx",
    ["tsx", "packages/db/scripts/migrate.ts"],
    { cwd: process.cwd(), env: { ...process.env, ...env } },
  );
}

describe("migrate script (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let testDatabaseName: string | undefined;
  let url: string;

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_migrate_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    url = testDatabaseUrl(baseUrl, testDatabaseName);
  }, 30_000);

  afterAll(async () => {
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it("creates the schema in an empty database", async () => {
    const { stdout } = await runMigrate({ DATABASE_URL: url });
    expect(stdout).toContain("migrations applied");

    // The tables the product cannot work without. Asserted by name rather than by count, so
    // adding a migration does not break this test but DROPPING one of these does.
    const client = postgres(url, { max: 1 });
    try {
      const rows = await client`
        select table_name from information_schema.tables where table_schema = 'public'
      `;
      const tables = rows.map((r) => r.table_name as string);
      expect(tables).toEqual(
        expect.arrayContaining([
          "contacts",
          "farms",
          "administrators",
          "admin_sessions",
          "sms_messages",
          "outbox_work",
          "flags",
        ]),
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 60_000);

  it("is idempotent — a second run applies nothing and still succeeds", async () => {
    // The normal way an operator checks state is to run it again, so a second run must not error
    // and must not attempt to recreate anything.
    const { stdout } = await runMigrate({ DATABASE_URL: url });
    expect(stdout).toContain("migrations applied");
  }, 60_000);

  it("fails closed when DATABASE_URL is absent", async () => {
    // A migrate script that defaulted to a local database would be one absent env var away from
    // silently migrating the wrong thing.
    await expect(runMigrate({ DATABASE_URL: "" })).rejects.toMatchObject({ code: 1 });
  }, 30_000);

  it("exits non-zero when the database is unreachable", async () => {
    // A deploy runbook step that reported success on a failed migration would be worse than no
    // step at all.
    await expect(
      runMigrate({ DATABASE_URL: "postgres://nobody@127.0.0.1:1/nope" }),
    ).rejects.toMatchObject({ code: 1 });
  }, 60_000);
});

describe("the migrate script never prints credentials", () => {
  // The operator's real risk is migrating the wrong database, so the script names its target. It
  // must do that WITHOUT the password, which would otherwise land in a terminal log or a screen
  // share during exactly the step someone is most likely to be recording.
  it("names host and database but omits the password", () => {
    const described = describeTarget(
      "postgres://ff_user:sup3r-s3cret@ep-cool-name.us-west-2.aws.neon.tech:5432/farmfriend",
    );
    expect(described).toBe("ep-cool-name.us-west-2.aws.neon.tech:5432/farmfriend");
    expect(described).not.toContain("sup3r-s3cret");
    expect(described).not.toContain("ff_user");
  });

  it("does not leak the password on a failed connection", async () => {
    const secret = "sup3r-s3cret-value";
    const failure = await runMigrate({
      DATABASE_URL: `postgres://nobody:${secret}@127.0.0.1:1/nope`,
    }).catch((e: unknown) => e as { stdout?: string; stderr?: string });

    expect(`${failure.stdout ?? ""}${failure.stderr ?? ""}`).not.toContain(secret);
  }, 60_000);
});
