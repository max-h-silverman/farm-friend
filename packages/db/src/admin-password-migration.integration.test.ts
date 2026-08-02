import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const NOW = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const LATER = new Date(Date.now() - 30 * 60 * 1000).toISOString();
const contactHash = "f".repeat(64);

describe("F-056 forward migration from populated pre-change schema (integration)", () => {
  let admin: Sql;
  let sql: Sql;
  let databaseName = "";
  let preChangeMigrations = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `farm_friend_f056_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    preChangeMigrations = mkdtempSync(resolve(tmpdir(), "farm-friend-pre-f056-"));
    mkdirSync(resolve(preChangeMigrations, "meta"));

    const journal = JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8")) as {
      version: string; dialect: string; entries: unknown[];
    };
    writeFileSync(
      resolve(preChangeMigrations, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 15) }),
    );
    for (let index = 0; index < 15; index += 1) {
      const prefix = index.toString().padStart(4, "0");
      const file = readdirSync(migrationsDir).find(
        (candidate) => candidate.startsWith(`${prefix}_`) && candidate.endsWith(".sql"),
      );
      if (!file) throw new Error(`missing pre-change migration ${prefix}`);
      copyFileSync(resolve(migrationsDir, file), resolve(preChangeMigrations, file));
    }

    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: preChangeMigrations });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 2 });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
    if (preChangeMigrations) rmSync(preChangeMigrations, { recursive: true, force: true });
  }, 30_000);

  it("preserves the fixed administrator and every referencing history row while revoking old sessions", async () => {
    const administratorId = randomUUID();
    const sessionId = randomUUID();
    const farmId = randomUUID();
    const contactId = randomUUID();
    const authorizationId = randomUUID();
    const approvalId = randomUUID();
    const locationId = randomUUID();
    const onboardingId = randomUUID();
    const auditId = randomUUID();
    const standFlagId = randomUUID();
    const reportId = randomUUID();
    const flagId = randomUUID();

    await sql`
      insert into administrators (id, email, authorized_at)
      values (${administratorId}, 'board@vigavashon.org', ${NOW})
    `;
    await sql`
      insert into admin_sessions
        (id, token_hash, administrator_id, issued_at, expires_at, magic_nonce_hash)
      values (${sessionId}, ${"1".repeat(64)}, ${administratorId}, ${NOW},
        ${new Date(Date.now() + 60 * 60 * 1000).toISOString()}, ${"2".repeat(64)})
    `;
    await sql`insert into contacts (id, phone_e164, phone_hash) values (${contactId}, '+12065550199', ${contactHash})`;
    await sql`insert into farms (id, name) values (${farmId}, 'Migration Farm')`;
    await sql`
      insert into sales_locations (
        id, owner_farm_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${locationId}, ${farmId}, 'farm_stand', 'Migration Stand', 'America/Los_Angeles',
        'visitable', 'produce', '1 Migration Way', 47.4, -122.4, false, false
      )
    `;
    await sql`
      insert into farmer_authorizations
        (id, farm_id, contact_id, phone_verified_at, authorized_at)
      values (${authorizationId}, ${farmId}, ${contactId}, ${NOW}, ${NOW})
    `;
    await sql`
      insert into farmer_onboarding_requests
        (id, contact_hash, requested_at, settled_at, settled_by_administrator_id, authorization_id)
      values (${onboardingId}, ${contactHash}, ${NOW}, ${LATER}, ${administratorId}, ${authorizationId})
    `;
    await sql`
      insert into farm_approvals (id, farm_id, administrator_id, approved_at)
      values (${approvalId}, ${farmId}, ${administratorId}, ${NOW})
    `;
    await sql`
      insert into audit_events
        (id, action, actor_administrator_id, subject_type, subject_id, occurred_at)
      values (${auditId}, 'migration-proof', ${administratorId}, 'farm', ${farmId}, ${LATER})
    `;
    await sql`
      insert into stand_data_flags
        (id, sales_location_id, reason, source_text, resolution_note,
         resolved_by_administrator_id, resolved_at)
      values (${standFlagId}, ${locationId}, 'contradictory_hours', 'source', 'reviewed',
        ${administratorId}, ${LATER})
    `;
    await sql`
      insert into stock_out_reports
        (id, sales_location_id, unlisted_item_text, status,
         reviewed_by_administrator_id, reviewed_at, reported_at)
      values (${reportId}, ${locationId}, 'eggs', 'reviewed', ${administratorId}, ${LATER}, ${NOW})
    `;
    await sql`
      insert into flags
        (id, contact_hash, reason_code, status, disposition_code,
         disposed_by_administrator_id, disposed_at, created_at)
      values (${flagId}, ${contactHash}, 'operator-review', 'resolved', 'resolved-safe',
        ${administratorId}, ${LATER}, ${NOW})
    `;

    await migrate(drizzle(sql), { migrationsFolder: migrationsDir });

    expect(await sql`select id, email from administrators`).toEqual([
      { id: administratorId, email: "board@vigavashon.org" },
    ]);
    expect(await sql`
      select id, revoked_at is not null as revoked from admin_sessions where id = ${sessionId}
    `).toEqual([{ id: sessionId, revoked: true }]);
    expect(await sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'admin_sessions'
        and column_name = 'magic_nonce_hash'
    `).toHaveLength(0);
    expect(await sql`
      select
        (select administrator_id from farm_approvals where id = ${approvalId}) as approval_admin,
        (select actor_administrator_id from audit_events where id = ${auditId}) as audit_admin,
        (select resolved_by_administrator_id from stand_data_flags where id = ${standFlagId}) as stand_admin,
        (select reviewed_by_administrator_id from stock_out_reports where id = ${reportId}) as report_admin,
        (select disposed_by_administrator_id from flags where id = ${flagId}) as flag_admin,
        (select settled_by_administrator_id from farmer_onboarding_requests where id = ${onboardingId}) as onboarding_admin
    `).toEqual([{
      approval_admin: administratorId,
      audit_admin: administratorId,
      stand_admin: administratorId,
      report_admin: administratorId,
      flag_admin: administratorId,
      onboarding_admin: administratorId,
    }]);
    expect(await sql`select * from admin_login_failures`).toHaveLength(0);
    expect(await sql`select count(*)::integer as count from drizzle.__drizzle_migrations`).toEqual([
      { count: 16 },
    ]);
  });
});
