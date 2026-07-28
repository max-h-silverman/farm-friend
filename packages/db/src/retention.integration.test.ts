import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, purgeExpiredBodies, type Db } from "./index";

// F-026 — the raw-context retention purge.
//
// Golden Rule #5 promises raw message context is short-lived. Every body is written with a
// `body_expires_at`; until this item nothing deleted one, so the promise was a claim rather
// than a mechanism. These tests are the spec for the mechanism: what goes, what stays, and
// what an open flag protects.
//
// They run against real Postgres because the check constraints are the thing under test —
// `sms_messages_retained_body_has_expiry` in particular means a purge that clears the body
// without clearing its expiry is not a valid write at all.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required; a skipped integration run is not green",
    );
  }
  return databaseUrl;
}

function testDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const senderHash = "7".repeat(64);
const adminHash = "8".repeat(64);

// The fixture timeline is ANCHORED TO THE REAL CLOCK, not to a calendar date (B-003).
//
// `outbox_work.created_at` defaults to `now()` and the schema enforces
// `body_expires_at > created_at`, so a literal date silently inverts once the wall clock
// passes it. T0 is a fixed point in the past; every other instant is an OFFSET from it.
// This suite is about EXPIRY, which makes the rule doubly binding: every instant here is
// derived, and `now` is always passed explicitly rather than read from the wall clock.
const T0 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

/** An instant relative to the fixture anchor. `at(0)` is T0; minutes may be fractional. */
const at = (minutesFromT0: number) =>
  new Date(T0.getTime() + minutesFromT0 * 60 * 1000);

const HOUR = 60;

/** A body written at T0 that expires an hour later. */
const EXPIRES_EARLY = at(HOUR);
/** A body written at T0 that is still well within its retention window. */
const EXPIRES_LATE = at(1000 * HOUR);
/** After `EXPIRES_EARLY`, before `EXPIRES_LATE`. The instant every purge runs at. */
const PURGE_AT = at(10 * HOUR);

describe("raw-context retention purge (integration)", () => {
  let adminClient: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  const ids: Record<string, string> = {};

  /** A fixture ID that must exist by now; a missing one is a broken fixture, not a null. */
  function id(key: string): string {
    const value = ids[key];
    if (value === undefined) throw new Error(`fixture id "${key}" is not set`);
    return value;
  }

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_ret_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    sql = postgres(url, { max: 8 });
    db = createDb(url);
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

  function client(): Sql {
    if (!sql) throw new Error("test database is not initialized");
    return sql;
  }

  function database(): Db {
    if (!db) throw new Error("test database is not initialized");
    return db;
  }

  beforeEach(async () => {
    await client()`
      truncate table
        provider_inbox_events, sms_messages, outbox_dispatch_attempts,
        inventory_entries, inventory_revisions, inventory_publication_proposals,
        outbox_work, consent_transition_watermarks, sms_consents, sender_states,
        stock_out_reports, flags, audit_events, model_runs,
        farm_approvals, farmer_authorizations, sales_location_payment_methods,
        farm_links, sales_locations, administrators, farms, contacts
      restart identity cascade
    `;

    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550701', ${senderHash}), ('+12065550702', ${adminHash})
      returning id, phone_hash
    `;
    for (const row of contacts) ids[row.phone_hash as string] = row.id as string;

    const admins = await client()`
      insert into administrators (email, contact_id, authorized_at)
      values ('retention-admin@viga.example', ${id(adminHash)}, ${T0}) returning id
    `;
    ids.administrator = admins[0]?.id as string;
  });

  /**
   * An inbound message and its minimized inbox projection, written directly so the test
   * controls the expiry instant rather than inheriting the 30-day production default.
   */
  async function inboundMessage(input: {
    body: string;
    expiresAt: Date;
    receivedAt?: Date;
  }): Promise<{ messageId: string; inboxEventId: string }> {
    const receivedAt = input.receivedAt ?? T0;
    const messages = await client()`
      insert into sms_messages (
        provider_message_id, sender_hash, body, body_expires_at, received_at
      )
      values (
        ${`msg-${randomUUID()}`}, ${senderHash}, ${input.body},
        ${input.expiresAt}, ${receivedAt}
      )
      returning id
    `;
    const messageId = messages[0]?.id as string;

    // `provider_inbox_events_coherent_claim_state` requires a processed event to carry a
    // `finalized_at` — a routed event, which is the only kind whose body ages into expiry.
    const events = await client()`
      insert into provider_inbox_events (
        provider_event_id, event_type, message_id, sender_hash, occurred_at,
        state, finalized_at
      )
      values (
        ${`evt-${randomUUID()}`}, 'message_received', ${messageId},
        ${senderHash}, ${receivedAt}, 'processed', ${receivedAt}
      )
      returning id
    `;
    return { messageId, inboxEventId: events[0]?.id as string };
  }

  /** Outbound work in a terminal state — the dispatcher will never read its body again. */
  async function completedOutboxWork(input: {
    body: string;
    expiresAt: Date;
  }): Promise<string> {
    const rows = await client()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at,
        available_at, state, dispatch_authorized_at, completed_at, created_at
      )
      values (
        ${`key-${randomUUID()}`}, ${senderHash}, 'inquiry_reply', ${input.body},
        ${input.expiresAt}, ${T0}, 'sent', ${T0}, ${T0}, ${T0}
      )
      returning id
    `;
    return rows[0]?.id as string;
  }

  async function messageBody(messageId: string): Promise<{
    body: string | null;
    bodyExpiresAt: Date | null;
    exists: boolean;
  }> {
    const rows = await client()`
      select body, body_expires_at from sms_messages where id = ${messageId}
    `;
    if (rows.length === 0)
      return { body: null, bodyExpiresAt: null, exists: false };
    return {
      body: rows[0]?.body as string | null,
      bodyExpiresAt: rows[0]?.body_expires_at as Date | null,
      exists: true,
    };
  }

  async function outboxBody(
    outboxWorkId: string,
  ): Promise<{ body: string | null; exists: boolean }> {
    const rows = await client()`
      select body from outbox_work where id = ${outboxWorkId}
    `;
    if (rows.length === 0) return { body: null, exists: false };
    return { body: rows[0]?.body as string | null, exists: true };
  }

  describe("expired bodies are deleted", () => {
    it("removes an inbound body whose retention window has closed", async () => {
      const { messageId } = await inboundMessage({
        body: "bok choy and green beans",
        expiresAt: EXPIRES_EARLY,
      });

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });

      const after = await messageBody(messageId);
      expect(after.body).toBeNull();
      expect(result.messageBodiesPurged).toBe(1);
    });

    it("removes an outbound body whose retention window has closed", async () => {
      const outboxWorkId = await completedOutboxWork({
        body: "Provo Farms: updated 2 hours ago",
        expiresAt: EXPIRES_EARLY,
      });

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });

      const after = await outboxBody(outboxWorkId);
      expect(after.body).toBe("");
      expect(result.outboxBodiesPurged).toBe(1);
    });

    it("leaves a body that has not yet expired", async () => {
      const { messageId } = await inboundMessage({
        body: "still within the window",
        expiresAt: EXPIRES_LATE,
      });
      const outboxWorkId = await completedOutboxWork({
        body: "also within the window",
        expiresAt: EXPIRES_LATE,
      });

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });

      expect((await messageBody(messageId)).body).toBe("still within the window");
      expect((await outboxBody(outboxWorkId)).body).toBe(
        "also within the window",
      );
      expect(result.messageBodiesPurged).toBe(0);
      expect(result.outboxBodiesPurged).toBe(0);
    });

    it("clears the expiry alongside the body it governed", async () => {
      // `sms_messages_retained_body_has_expiry` requires body and expiry to be present or
      // absent TOGETHER. A purge that clears one and not the other is not a legal write,
      // so this asserts the pair rather than the body alone.
      const { messageId } = await inboundMessage({
        body: "expired",
        expiresAt: EXPIRES_EARLY,
      });

      await purgeExpiredBodies(database(), { now: PURGE_AT });

      const after = await messageBody(messageId);
      expect(after.body).toBeNull();
      expect(after.bodyExpiresAt).toBeNull();
    });
  });

  describe("the minimized durable records survive", () => {
    it("keeps the message row, its inbox projection, flags, and audit events", async () => {
      const { messageId, inboxEventId } = await inboundMessage({
        body: "expired but the projection stays",
        expiresAt: EXPIRES_EARLY,
      });

      // A RESOLVED flag: it no longer exempts, but it must still exist afterwards.
      await client()`
        insert into flags (
          contact_hash, inbox_event_id, reason_code, status, disposition_code,
          disposed_by_administrator_id, disposed_at, created_at
        )
        values (
          ${senderHash}, ${inboxEventId}, 'abuse_review', 'resolved', 'no_action',
          ${id("administrator")}, ${at(2 * HOUR)}, ${T0}
        )
      `;
      await client()`
        insert into audit_events (action, actor_contact_hash, subject_type, subject_id, occurred_at)
        values ('inbound.processed', ${senderHash}, 'sms_message', ${messageId}, ${T0})
      `;

      await purgeExpiredBodies(database(), { now: PURGE_AT });

      // The body is gone; everything that made the record auditable is not.
      expect((await messageBody(messageId)).exists).toBe(true);
      expect((await messageBody(messageId)).body).toBeNull();

      const events = await client()`
        select count(*)::integer as count from provider_inbox_events
        where id = ${inboxEventId}
      `;
      expect(events[0]?.count).toBe(1);

      const flags = await client()`
        select count(*)::integer as count from flags
      `;
      expect(flags[0]?.count).toBe(1);

      const audits = await client()`
        select count(*)::integer as count from audit_events
      `;
      expect(audits[0]?.count).toBe(1);
    });

    it("keeps the outbox row and its dispatch attempt", async () => {
      const outboxWorkId = await completedOutboxWork({
        body: "expired outbound",
        expiresAt: EXPIRES_EARLY,
      });
      await client()`
        insert into outbox_dispatch_attempts (
          outbox_work_id, attempt_number, state, provider_message_id, started_at, completed_at
        )
        values (${outboxWorkId}, 1, 'accepted', ${`prov-${randomUUID()}`}, ${T0}, ${T0})
      `;

      await purgeExpiredBodies(database(), { now: PURGE_AT });

      expect((await outboxBody(outboxWorkId)).exists).toBe(true);
      const attempts = await client()`
        select count(*)::integer as count from outbox_dispatch_attempts
        where outbox_work_id = ${outboxWorkId}
      `;
      expect(attempts[0]?.count).toBe(1);
    });
  });

  describe("the flagged-thread exemption", () => {
    it("retains an expired body while its thread's flag is open", async () => {
      const { messageId, inboxEventId } = await inboundMessage({
        body: "evidence under review",
        expiresAt: EXPIRES_EARLY,
      });
      await client()`
        insert into flags (contact_hash, inbox_event_id, reason_code, status, created_at)
        values (${senderHash}, ${inboxEventId}, 'abuse_review', 'open', ${T0})
      `;

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });

      // Purging evidence out from under an open safety review is irreversible; the
      // exemption is the reason the retention window is not absolute.
      expect((await messageBody(messageId)).body).toBe("evidence under review");
      expect(result.messageBodiesPurged).toBe(0);
      expect(result.exempted).toBe(1);
    });

    it("purges the same body once the flag is resolved", async () => {
      const { messageId, inboxEventId } = await inboundMessage({
        body: "evidence under review",
        expiresAt: EXPIRES_EARLY,
      });
      const flags = await client()`
        insert into flags (contact_hash, inbox_event_id, reason_code, status, created_at)
        values (${senderHash}, ${inboxEventId}, 'abuse_review', 'open', ${T0})
        returning id
      `;
      const flagId = flags[0]?.id as string;

      // Still exempt while open.
      await purgeExpiredBodies(database(), { now: PURGE_AT });
      expect((await messageBody(messageId)).body).toBe("evidence under review");

      // F-025 builds the path that does this in production. Until then nothing can move a
      // flag out of `open`, so an exempted row retains indefinitely — correct, not a leak.
      await client()`
        update flags
        set status = 'resolved', disposition_code = 'no_action',
            disposed_by_administrator_id = ${id("administrator")},
            disposed_at = ${at(2 * HOUR)}
        where id = ${flagId}
      `;

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });
      expect((await messageBody(messageId)).body).toBeNull();
      expect(result.messageBodiesPurged).toBe(1);
      expect(result.exempted).toBe(0);
    });

    it("purges a thread whose only flag was dismissed, not just resolved", async () => {
      // `dismissed` and `resolved` are both terminal: the coherent-disposition constraint
      // treats them identically, and neither leaves a review open. Written because the
      // exemption is easy to express as "not resolved" instead of "open", which reads the
      // same on every other fixture in this file and silently exempts dismissed threads
      // forever. Only a dismissed-ONLY thread distinguishes the two predicates.
      const { messageId, inboxEventId } = await inboundMessage({
        body: "reviewed and dismissed",
        expiresAt: EXPIRES_EARLY,
      });
      await client()`
        insert into flags (
          contact_hash, inbox_event_id, reason_code, status, disposition_code,
          disposed_by_administrator_id, disposed_at, created_at
        )
        values (
          ${senderHash}, ${inboxEventId}, 'abuse_review', 'dismissed', 'not_actionable',
          ${id("administrator")}, ${at(2 * HOUR)}, ${T0}
        )
      `;

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });

      expect((await messageBody(messageId)).body).toBeNull();
      expect(result.messageBodiesPurged).toBe(1);
      expect(result.exempted).toBe(0);
    });

    it("retains when ANY flag on the thread is open, even beside a resolved one", async () => {
      const { messageId, inboxEventId } = await inboundMessage({
        body: "two reviews, one still open",
        expiresAt: EXPIRES_EARLY,
      });
      await client()`
        insert into flags (
          contact_hash, inbox_event_id, reason_code, status, disposition_code,
          disposed_by_administrator_id, disposed_at, created_at
        )
        values (
          ${senderHash}, ${inboxEventId}, 'abuse_review', 'dismissed', 'not_actionable',
          ${id("administrator")}, ${at(2 * HOUR)}, ${T0}
        )
      `;
      await client()`
        insert into flags (contact_hash, inbox_event_id, reason_code, status, created_at)
        values (${senderHash}, ${inboxEventId}, 'safety_review', 'open', ${T0})
      `;

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });

      expect((await messageBody(messageId)).body).toBe(
        "two reviews, one still open",
      );
      expect(result.exempted).toBe(1);
    });

    it("exempts only the flagged thread, not every expired body", async () => {
      const flagged = await inboundMessage({
        body: "flagged thread",
        expiresAt: EXPIRES_EARLY,
      });
      const unflagged = await inboundMessage({
        body: "ordinary thread",
        expiresAt: EXPIRES_EARLY,
      });
      await client()`
        insert into flags (contact_hash, inbox_event_id, reason_code, status, created_at)
        values (${senderHash}, ${flagged.inboxEventId}, 'abuse_review', 'open', ${T0})
      `;

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });

      expect((await messageBody(flagged.messageId)).body).toBe("flagged thread");
      expect((await messageBody(unflagged.messageId)).body).toBeNull();
      expect(result.messageBodiesPurged).toBe(1);
      expect(result.exempted).toBe(1);
    });
  });

  describe("safe beside live traffic", () => {
    it("never clears a body the dispatcher has not finished with", async () => {
      // `runOutboundPass` reads `outbox_work.body` to send it. Clearing the body of work
      // that is still queued or dispatching would race the dispatcher and deliver an empty
      // SMS to a real person — a worse outcome than retaining a body slightly too long.
      const queued = await client()`
        insert into outbox_work (
          logical_key, recipient_hash, message_category, body, body_expires_at,
          available_at, state, created_at
        )
        values (
          ${`key-${randomUUID()}`}, ${senderHash}, 'inquiry_reply', 'not yet sent',
          ${EXPIRES_EARLY}, ${T0}, 'queued', ${T0}
        )
        returning id
      `;
      const dispatching = await client()`
        insert into outbox_work (
          logical_key, recipient_hash, message_category, body, body_expires_at,
          available_at, state, dispatch_authorized_at, created_at
        )
        values (
          ${`key-${randomUUID()}`}, ${senderHash}, 'inquiry_reply', 'in flight',
          ${EXPIRES_EARLY}, ${T0}, 'dispatching', ${T0}, ${T0}
        )
        returning id
      `;

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });

      expect((await outboxBody(queued[0]?.id as string)).body).toBe(
        "not yet sent",
      );
      expect((await outboxBody(dispatching[0]?.id as string)).body).toBe(
        "in flight",
      );
      expect(result.outboxBodiesPurged).toBe(0);
    });

    it("is idempotent — a second pass finds nothing left to do", async () => {
      await inboundMessage({ body: "expired", expiresAt: EXPIRES_EARLY });
      await completedOutboxWork({ body: "expired", expiresAt: EXPIRES_EARLY });

      const first = await purgeExpiredBodies(database(), { now: PURGE_AT });
      const second = await purgeExpiredBodies(database(), { now: PURGE_AT });

      expect(first.messageBodiesPurged).toBe(1);
      expect(first.outboxBodiesPurged).toBe(1);
      expect(second.messageBodiesPurged).toBe(0);
      expect(second.outboxBodiesPurged).toBe(0);
    });

    it("is safe to run concurrently with itself", async () => {
      for (let index = 0; index < 5; index += 1) {
        await inboundMessage({ body: `expired ${index}`, expiresAt: EXPIRES_EARLY });
        await completedOutboxWork({
          body: `expired ${index}`,
          expiresAt: EXPIRES_EARLY,
        });
      }

      const results = await Promise.all([
        purgeExpiredBodies(database(), { now: PURGE_AT }),
        purgeExpiredBodies(database(), { now: PURGE_AT }),
        purgeExpiredBodies(database(), { now: PURGE_AT }),
      ]);

      // Concurrent passes must not double-count and must not error; between them every
      // eligible row is purged exactly once.
      const messagesPurged = results.reduce(
        (total, result) => total + result.messageBodiesPurged,
        0,
      );
      const outboxPurged = results.reduce(
        (total, result) => total + result.outboxBodiesPurged,
        0,
      );
      expect(messagesPurged).toBe(5);
      expect(outboxPurged).toBe(5);

      const remaining = await client()`
        select count(*)::integer as count from sms_messages where body is not null
      `;
      expect(remaining[0]?.count).toBe(0);
    });

    it("bounds one pass and leaves the rest for the next", async () => {
      for (let index = 0; index < 4; index += 1) {
        await inboundMessage({ body: `expired ${index}`, expiresAt: EXPIRES_EARLY });
      }

      const first = await purgeExpiredBodies(database(), {
        now: PURGE_AT,
        limit: 2,
      });
      expect(first.messageBodiesPurged).toBe(2);

      const second = await purgeExpiredBodies(database(), {
        now: PURGE_AT,
        limit: 2,
      });
      expect(second.messageBodiesPurged).toBe(2);

      const remaining = await client()`
        select count(*)::integer as count from sms_messages where body is not null
      `;
      expect(remaining[0]?.count).toBe(0);
    });
  });

  describe("model-run evidence stays within the MAY-store list", () => {
    it("stores no column that could carry model input or output content", async () => {
      // docs/DATA_ARCHITECTURE.md §"Model-run evidence": seam, provider, model, schema
      // version, validation status, repair count, opaque refs, and timing/cost metadata.
      // Anything holding a prompt, a completion, or a transcript is outside the list, so
      // there would be raw context here for the purge to reach. There is not.
      const columns = await client()`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'model_runs'
        order by column_name
      `;
      const names = columns.map((row) => row.column_name as string);

      expect(names.sort()).toEqual(
        [
          "completed_at",
          "cost_micros",
          "id",
          "input_tokens",
          "latency_ms",
          "model",
          "opaque_refs",
          "output_tokens",
          "provider",
          "repair_count",
          "schema_version",
          "seam",
          "started_at",
          "validation_status",
        ].sort(),
      );
    });
  });
});
