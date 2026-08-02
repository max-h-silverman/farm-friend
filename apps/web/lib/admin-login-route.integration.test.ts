import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashSessionToken } from "@farm-friend/core";
import type { Sql } from "@farm-friend/db";
import { hashAdminPassword } from "./admin-password";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  return databaseUrl;
}

function post(body: unknown): Request {
  return new Request("https://ff.example/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.42, 35.191.0.1",
    },
    body: JSON.stringify(body),
  });
}

async function snapshot(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    cookie: response.headers.get("set-cookie"),
  };
}

describe("administrator password route (integration)", () => {
  let admin: Sql;
  let sql: Sql;
  let databaseName = "";
  let route: typeof import("../app/api/auth/login/route");
  let verifier = "";

  beforeAll(async () => {
    databaseName = `farm_friend_admin_login_route_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(requiredDatabaseUrl(), { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 2 });
    await sql`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', now())
    `;

    verifier = await hashAdminPassword("correct horse battery staple");
    process.env.DATABASE_URL = url.toString();
    process.env.PHONE_HASH_SALT = "route-signal-salt";
    process.env.ADMIN_PASSWORD_HASH = verifier;
    route = await import("../app/api/auth/login/route");
  }, 30_000);

  afterAll(async () => {
    const { publicReadContext } = await import("./public-context");
    await publicReadContext().db.close();
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  it("makes wrong email, password, malformed input, and missing config byte-identical", async () => {
    const wrongEmail = await snapshot(await route.POST(post({
      email: "other@example.org", password: "correct horse battery staple",
    })));
    const wrongPassword = await snapshot(await route.POST(post({
      email: "board@vigavashon.org", password: "wrong",
    })));
    const malformed = await snapshot(await route.POST(post({ email: "board@vigavashon.org" })));
    delete process.env.ADMIN_PASSWORD_HASH;
    const missingConfig = await snapshot(await route.POST(post({
      email: "board@vigavashon.org", password: "correct horse battery staple",
    })));
    process.env.ADMIN_PASSWORD_HASH = verifier;

    expect(wrongPassword).toEqual(wrongEmail);
    expect(malformed).toEqual(wrongEmail);
    expect(missingConfig).toEqual(wrongEmail);
    expect(wrongEmail).toEqual({
      status: 401,
      body: '{"authenticated":false}',
      cookie: null,
    });
  });

  it("stores only a token hash and returns raw session material only in the secure cookie", async () => {
    const response = await route.POST(post({
      email: "BOARD@VIGAVASHON.ORG",
      password: "correct horse battery staple",
    }));
    const body = await response.text();
    const cookie = response.headers.get("set-cookie") ?? "";
    const token = /^ff_admin_session=([0-9a-f]{64});/.exec(cookie)?.[1];
    expect(response.status).toBe(200);
    expect(body).toBe('{"authenticated":true}');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).toContain(
      "HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=43200",
    );
    expect(body).not.toContain(token as string);
    expect(body).not.toContain(verifier);

    const rows = await sql`
      select token_hash, administrator_id,
        extract(epoch from (expires_at - issued_at))::integer as lifetime
      from admin_sessions
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashSessionToken(token as string));
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.lifetime).toBe(43_200);
    const serialized = JSON.stringify(await sql`select * from admin_sessions`);
    expect(serialized).not.toContain("correct horse battery staple");
    expect(serialized).not.toContain(verifier);
  });

  it("makes revoked authority the same refusal", async () => {
    await sql`update administrators set revoked_at = now()`;
    const response = await snapshot(await route.POST(post({
      email: "board@vigavashon.org", password: "correct horse battery staple",
    })));
    expect(response).toEqual({
      status: 401,
      body: '{"authenticated":false}',
      cookie: null,
    });
  });
});
