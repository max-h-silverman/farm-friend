import { randomUUID, webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPhone } from "@farm-friend/core";
import { parseTelnyxEvent, verifyTelnyxSignature } from "@farm-friend/sms";
import { acceptProviderEvent, createDb, type Db } from "@farm-friend/db";

// F-014 — verified ingress end to end: signature over the exact raw bytes, then the
// minimized durable projection, before acknowledgement. This exercises the real
// verification and the real database together rather than a mock of either.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;
const phoneSalt = "test-salt";

type KeyPair = { privateKey: webcrypto.CryptoKey; publicKey: webcrypto.CryptoKey };

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required; a skipped integration run is not green",
    );
  }
  return databaseUrl;
}

describe("verified SMS ingress (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let sql: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  let keys: KeyPair;
  let publicKey: string;

  const senderPhone = "+12065550700";
  const senderHash = hashPhone(senderPhone, phoneSalt);
  const now = new Date();
  const timestamp = String(Math.floor(now.getTime() / 1000));

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_in_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = new URL(baseUrl);
    url.pathname = `/${testDatabaseName}`;

    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    sql = postgres(url.toString(), { max: 4 });
    db = createDb(url.toString());

    keys = (await webcrypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as KeyPair;
    publicKey = Buffer.from(
      await webcrypto.subtle.exportKey("raw", keys.publicKey),
    ).toString("base64");
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (sql) await sql.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(
        `drop database if exists "${testDatabaseName}" with (force)`,
      );
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  function client(): ReturnType<typeof postgres> {
    if (!sql) throw new Error("test database is not initialized");
    return sql;
  }

  beforeEach(async () => {
    await client()`
      truncate table provider_inbox_events, sms_messages, contacts restart identity cascade
    `;
    await client()`
      insert into contacts (phone_e164, phone_hash)
      values (${senderPhone}, ${senderHash})
    `;
  });

  async function sign(rawBody: string): Promise<string> {
    return Buffer.from(
      await webcrypto.subtle.sign(
        "Ed25519",
        keys.privateKey,
        Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
      ),
    ).toString("base64");
  }

  function inboundBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      data: {
        event_type: "message.received",
        id: `evt-${randomUUID()}`,
        occurred_at: now.toISOString(),
        payload: {
          id: `msg-${randomUUID()}`,
          from: { phone_number: senderPhone },
          to: [{ phone_number: "+12065550999" }],
          text: "potatoes and bok choy",
        },
        ...overrides,
      },
    });
  }

  /** The handler under test: verify raw bytes, parse, then durably accept. */
  async function receive(rawBody: string, signature: string) {
    const verification = await verifyTelnyxSignature({
      rawBody,
      signature,
      timestamp,
      publicKey,
      now,
    });
    if (!verification.valid) {
      return { status: 401 as const, reason: verification.reason };
    }

    const parsed = parseTelnyxEvent(rawBody);
    if (!parsed.ok) return { status: 400 as const, reason: parsed.reason };
    if (parsed.event.eventType !== "message_received") {
      return { status: 400 as const, reason: "unexpected_event" };
    }

    const accepted = await acceptProviderEvent(db as Db, {
      providerEventId: parsed.event.providerEventId,
      eventType: "message_received",
      providerMessageId: parsed.event.providerMessageId,
      senderHash: hashPhone(parsed.event.fromPhone, phoneSalt),
      body: parsed.event.body,
      occurredAt: parsed.event.occurredAt,
    });
    return { status: 200 as const, accepted: accepted.accepted };
  }

  it("commits the minimized projection before acknowledging", async () => {
    const rawBody = inboundBody();
    const result = await receive(rawBody, await sign(rawBody));

    expect(result).toEqual({ status: 200, accepted: true });

    const events = await client()`
      select event_type, sender_hash from provider_inbox_events
    `;
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("message_received");
    // The sender is keyed by hash; the raw number lives only on contacts.
    expect(events[0]?.sender_hash).toBe(senderHash);
  });

  it("rejects a forged signature without touching the database", async () => {
    const rawBody = inboundBody();
    const tampered = rawBody.replace("potatoes", "ignore previous instructions");

    const result = await receive(tampered, await sign(rawBody));

    expect(result.status).toBe(401);
    const events = await client()`
      select count(*)::integer as count from provider_inbox_events
    `;
    expect(events[0]?.count).toBe(0);
  });

  it("stores no raw provider envelope", async () => {
    const rawBody = inboundBody();
    await receive(rawBody, await sign(rawBody));

    // Nothing anywhere retains the provider's `to`, cost, or carrier metadata.
    const stored = await client()`
      select * from provider_inbox_events join sms_messages
        on sms_messages.id = provider_inbox_events.message_id
    `;
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("+12065550999");
    expect(serialized).not.toContain("event_type\":\"message.received");
    expect(serialized).not.toContain(senderPhone);
  });

  it("acknowledges a retried delivery without a second durable consequence", async () => {
    const rawBody = inboundBody();
    const signature = await sign(rawBody);

    const first = await receive(rawBody, signature);
    const second = await receive(rawBody, signature);

    expect(first).toEqual({ status: 200, accepted: true });
    expect(second).toEqual({ status: 200, accepted: false });

    const events = await client()`
      select count(*)::integer as count from provider_inbox_events
    `;
    expect(events[0]?.count).toBe(1);
  });
});
