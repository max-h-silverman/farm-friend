import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acceptProviderEvent,
  applyDeliveryEvent,
  applyPendingDeliveryEvents,
  authorizeDispatch,
  recordDispatchResult,
  releaseAbandonedClaims,
  createDb,
  type Db,
} from "./index";

// B-012 — delivery callbacks are claimed and applied exactly once.
//
// The webhook stores `message.sent` / `message.finalized` as minimized inbox events and
// correlates each to its dispatch attempt. Before this, nothing ever read them: 20 rows
// sat `pending` in production while `outbox_work.delivery_status` stayed NULL, so `sent`
// meant "the provider accepted it" and never "the handset got it".
//
// These run against real Postgres because the properties under test ARE the constraints,
// the row locks, and the transactions — not a mock of them. B-011 is the standing lesson:
// its first guard passed every unit test and enrolled three of eight concurrent senders,
// because stubs cannot model row contention.

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

const farmerHash = "1".repeat(64);

// Anchored to the real clock, never a calendar literal (B-003): `outbox_work.created_at`
// defaults to now() and the schema enforces `body_expires_at > created_at`, so a fixture
// written as a fixed date silently becomes invalid when the wall clock passes it.
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const at = (minutesFromT0: number) =>
  new Date(T0.getTime() + minutesFromT0 * 60 * 1000);
const BODY_EXPIRES_AT = at(48 * 60);

describe("delivery callback application (integration)", () => {
  let adminClient: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_delivery_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    // Enough connections that the concurrency test can actually contend.
    sql = postgres(url, { max: 12 });
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
        outbox_work, consent_transition_watermarks, sms_consents, sender_states,
        audit_events, contacts
      restart identity cascade
    `;
    await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550401', ${farmerHash})
    `;
    await client()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      )
      values (${farmerHash}, 'active', 'farmer_onboarding', ${T0}, 'onboarding-1', ${T0})
    `;
  });

  /** Queue outbound work, dispatch it, and return the attempt a callback would name. */
  async function dispatchedWork(logicalKey: string): Promise<{
    outboxWorkId: string;
    dispatchAttemptId: string;
  }> {
    const rows = await client()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at, available_at
      )
      values (${logicalKey}, ${farmerHash}, 'inventory_prompt', 'hello',
              ${BODY_EXPIRES_AT}, ${T0})
      returning id
    `;
    const outboxWorkId = rows[0]?.id as string;

    const claim = await authorizeDispatch(database(), { outboxWorkId, now: T0 });
    if (claim.status !== "authorized") throw new Error("expected authorization");
    await recordDispatchResult(database(), {
      dispatchAttemptId: claim.dispatchAttemptId,
      outcome: "accepted",
      providerMessageId: `pm-${logicalKey}`,
      now: T0,
    });
    return { outboxWorkId, dispatchAttemptId: claim.dispatchAttemptId };
  }

  /** Store a delivery callback the way the webhook does. */
  async function storeCallback(input: {
    dispatchAttemptId: string;
    providerEventId: string;
    eventType: "message_sent" | "message_finalized";
    deliveryStatus: "sent" | "delivered" | "delivery_failed";
    occurredAt: Date;
  }): Promise<void> {
    await acceptProviderEvent(database(), {
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      dispatchAttemptId: input.dispatchAttemptId,
      deliveryStatus: input.deliveryStatus,
      occurredAt: input.occurredAt,
    });
  }

  async function eventStates(): Promise<Record<string, number>> {
    const rows = await client()`
      select state, count(*)::integer as count from provider_inbox_events
      group by state
    `;
    return Object.fromEntries(
      rows.map((row) => [row.state as string, row.count as number]),
    );
  }

  describe("the pass applies what the webhook stored", () => {
    it("applies a pending delivery event and marks it processed", async () => {
      // This is B-012 itself: before the fix this event stayed `pending` forever and
      // `delivery_status` stayed NULL.
      const { outboxWorkId, dispatchAttemptId } = await dispatchedWork("d-basic");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-delivered",
        eventType: "message_finalized",
        deliveryStatus: "delivered",
        occurredAt: at(5),
      });

      const result = await applyPendingDeliveryEvents(database(), { now: at(6) });

      expect(result.applied).toBe(1);
      const work = await client()`
        select delivery_status, delivery_occurred_at, delivery_event_id
        from outbox_work where id = ${outboxWorkId}
      `;
      expect(work[0]?.delivery_status).toBe("delivered");
      expect(work[0]?.delivery_event_id).toBe("evt-delivered");
      expect(await eventStates()).toEqual({ processed: 1 });
    });

    it("leaves nothing pending after a pass over a full callback sequence", async () => {
      // Production's exact shape: `message_sent` then `message_finalized` for one send.
      const { outboxWorkId, dispatchAttemptId } = await dispatchedWork("d-seq");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-seq-sent",
        eventType: "message_sent",
        deliveryStatus: "sent",
        occurredAt: at(1),
      });
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-seq-final",
        eventType: "message_finalized",
        deliveryStatus: "delivered",
        occurredAt: at(2),
      });

      const result = await applyPendingDeliveryEvents(database(), { now: at(3) });

      expect(result.applied).toBe(2);
      expect(await eventStates()).toEqual({ processed: 2 });
      const work = await client()`
        select delivery_status from outbox_work where id = ${outboxWorkId}
      `;
      // The later event wins the monotonic watermark.
      expect(work[0]?.delivery_status).toBe("delivered");
    });

    it("records a carrier failure as the delivery outcome", async () => {
      const { outboxWorkId, dispatchAttemptId } = await dispatchedWork("d-failed");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-failed",
        eventType: "message_finalized",
        deliveryStatus: "delivery_failed",
        occurredAt: at(5),
      });

      await applyPendingDeliveryEvents(database(), { now: at(6) });

      const work = await client()`
        select delivery_status from outbox_work where id = ${outboxWorkId}
      `;
      // The distinction B-012 exists to restore: the provider ACCEPTED this message and
      // the carrier then failed to deliver it. Without this, both look like `sent`.
      expect(work[0]?.delivery_status).toBe("delivery_failed");
      const attempt = await client()`
        select state from outbox_dispatch_attempts where id = ${dispatchAttemptId}
      `;
      expect(attempt[0]?.state).toBe("accepted");
    });

    it("applies an out-of-order pair monotonically, never regressing the watermark", async () => {
      // Telnyx does not promise callback order. `finalized` arriving before `sent` must
      // not leave the row reading `sent`.
      const { outboxWorkId, dispatchAttemptId } = await dispatchedWork("d-order");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-order-final",
        eventType: "message_finalized",
        deliveryStatus: "delivered",
        occurredAt: at(10),
      });
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-order-sent",
        eventType: "message_sent",
        deliveryStatus: "sent",
        occurredAt: at(5),
      });

      const result = await applyPendingDeliveryEvents(database(), { now: at(11) });

      // BOTH are consumed — the older one is applied (a no-op against the watermark) and
      // finalized, never left pending to be retried forever.
      expect(result.applied).toBe(2);
      expect(await eventStates()).toEqual({ processed: 2 });
      const work = await client()`
        select delivery_status from outbox_work where id = ${outboxWorkId}
      `;
      expect(work[0]?.delivery_status).toBe("delivered");
    });
  });

  describe("exactly once under replay and contention", () => {
    it("is a no-op on a second pass over the same events", async () => {
      const { outboxWorkId, dispatchAttemptId } = await dispatchedWork("d-replay");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-replay",
        eventType: "message_finalized",
        deliveryStatus: "delivered",
        occurredAt: at(5),
      });

      const first = await applyPendingDeliveryEvents(database(), { now: at(6) });
      const second = await applyPendingDeliveryEvents(database(), { now: at(7) });

      expect(first.applied).toBe(1);
      expect(second.applied).toBe(0);
      const work = await client()`
        select delivery_status, delivery_event_id from outbox_work
        where id = ${outboxWorkId}
      `;
      expect(work[0]?.delivery_event_id).toBe("evt-replay");
    });

    it("ignores a repeat of the applied event even when it carries a later instant", async () => {
      // This isolates `applyDeliveryEvent`'s DUPLICATE-EVENT guard specifically. The
      // monotonic guard alone cannot cover it: a re-sent event bearing the same provider
      // event ID but a LATER timestamp passes the `occurredAt <= previousAt` check and
      // would be re-applied.
      //
      // Written after sabotage: deleting the duplicate guard left the whole suite green,
      // because every other replay case here re-sends the SAME instant and is caught by the
      // monotonic check. A test that cannot fail proves nothing.
      // The first status is deliberately `sent`, which is NOT terminal. A terminal first
      // status would let the trigger's "a terminal result cannot be replaced" branch
      // enforce this instead, and the test would pass for the wrong reason — it did, until
      // sabotaging each mechanism in turn showed two of them overlapping here.
      const { outboxWorkId, dispatchAttemptId } = await dispatchedWork("d-dup-later");
      await applyDeliveryEvent(database(), {
        dispatchAttemptId,
        deliveryStatus: "sent",
        occurredAt: at(5),
        providerEventId: "evt-dup-later",
      });

      await applyDeliveryEvent(database(), {
        dispatchAttemptId,
        deliveryStatus: "delivered",
        occurredAt: at(9),
        providerEventId: "evt-dup-later",
      });

      const work = await client()`
        select delivery_status, delivery_occurred_at from outbox_work
        where id = ${outboxWorkId}
      `;
      // The first application stands: same event ID, so the second is not a new fact —
      // even though it is later AND a legal forward transition.
      expect(work[0]?.delivery_status).toBe("sent");
      expect((work[0]?.delivery_occurred_at as Date).getTime()).toBe(at(5).getTime());
    });

    it("applies each event exactly once under eight simultaneous passes", async () => {
      // B-011's lesson, applied. Two branches under `Promise.all` do NOT contend — the
      // first transaction commits before the second begins — so this uses eight genuine
      // simultaneous claimants against a real connection pool. Sabotage-proven: removing
      // `for update skip locked` from the claim makes this fail with applied > 8.
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          dispatchedWork(`d-contend-${index}`),
        ),
      );
      await Promise.all(
        attempts.map((attempt, index) =>
          storeCallback({
            dispatchAttemptId: attempt.dispatchAttemptId,
            providerEventId: `evt-contend-${index}`,
            eventType: "message_finalized",
            deliveryStatus: "delivered",
            occurredAt: at(5),
          }),
        ),
      );

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          applyPendingDeliveryEvents(database(), { now: at(6) }),
        ),
      );

      // Eight events exist. Across eight racing passes each is claimed by exactly one.
      const total = results.reduce((sum, result) => sum + result.applied, 0);
      expect(total).toBe(8);
      expect(await eventStates()).toEqual({ processed: 8 });
    });

    it("does not double-apply when a claim lapses and the event is retried", async () => {
      // A pass that dies mid-flight leaves a `processing` claim. `releaseAbandonedClaims`
      // returns it to `pending`; applying it again must still land on the same watermark.
      const { outboxWorkId, dispatchAttemptId } = await dispatchedWork("d-lapse");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-lapse",
        eventType: "message_finalized",
        deliveryStatus: "delivered",
        occurredAt: at(5),
      });

      await applyPendingDeliveryEvents(database(), { now: at(6) });

      // Force the applied row back to pending, as a lapse-and-recover would.
      await client()`
        update provider_inbox_events
        set state = 'pending', finalized_at = null, claim_token = null,
            claimed_at = null, claim_expires_at = null
        where provider_event_id = 'evt-lapse'
      `;

      const second = await applyPendingDeliveryEvents(database(), { now: at(7) });

      expect(second.applied).toBe(1);
      const work = await client()`
        select delivery_status, delivery_occurred_at, delivery_event_id
        from outbox_work where id = ${outboxWorkId}
      `;
      // Same event ID, same instant: `applyDeliveryEvent`'s duplicate guard held, so the
      // replay changed nothing rather than writing a second time.
      expect(work[0]?.delivery_event_id).toBe("evt-lapse");
      expect(work[0]?.delivery_status).toBe("delivered");
      expect(
        (work[0]?.delivery_occurred_at as Date).getTime(),
      ).toBe(at(5).getTime());
    });

    it("recovers a delivery claim abandoned by a dead pass", async () => {
      const { dispatchAttemptId } = await dispatchedWork("d-abandoned");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-abandoned",
        eventType: "message_finalized",
        deliveryStatus: "delivered",
        occurredAt: at(5),
      });
      // Simulate a pass that claimed and then died.
      await client()`
        update provider_inbox_events
        set state = 'processing', claim_token = ${randomUUID()},
            claimed_at = ${at(6)}, claim_expires_at = ${at(7)}
        where provider_event_id = 'evt-abandoned'
      `;

      // A pass now finds nothing to do — the row is claimed, not pending.
      const blocked = await applyPendingDeliveryEvents(database(), { now: at(8) });
      expect(blocked.applied).toBe(0);

      // Recovery is the SAME mechanism the inbound path uses; it is not scoped to
      // `message_received`, so it already covers delivery claims.
      const released = await releaseAbandonedClaims(database(), { now: at(8) });
      expect(released).toBe(1);

      const after = await applyPendingDeliveryEvents(database(), { now: at(9) });
      expect(after.applied).toBe(1);
      expect(await eventStates()).toEqual({ processed: 1 });
    });
  });

  describe("boundaries", () => {
    it("never claims an inbound conversational event", async () => {
      // Claiming `message_received` here would steal a farmer's message from the inbound
      // pass and apply it as a delivery callback.
      await client()`
        insert into sms_messages (provider_message_id, sender_hash, body, body_expires_at, received_at)
        values ('pm-inbound', ${farmerHash}, 'potatoes', ${BODY_EXPIRES_AT}, ${T0})
      `;
      const messages = await client()`select id from sms_messages`;
      await client()`
        insert into provider_inbox_events (
          provider_event_id, event_type, message_id, sender_hash, occurred_at
        )
        values ('evt-inbound', 'message_received', ${messages[0]?.id as string},
                ${farmerHash}, ${T0})
      `;

      const result = await applyPendingDeliveryEvents(database(), { now: at(1) });

      expect(result.applied).toBe(0);
      const row = await client()`
        select state from provider_inbox_events where provider_event_id = 'evt-inbound'
      `;
      expect(row[0]?.state).toBe("pending");
    });

    it("advances no sender conversation watermark", async () => {
      // A delivery callback is not conversational work. Advancing a watermark from one
      // would make the sender's NEXT real message look stale and be rejected.
      const { dispatchAttemptId } = await dispatchedWork("d-watermark");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-watermark",
        eventType: "message_finalized",
        deliveryStatus: "delivered",
        occurredAt: at(5),
      });

      await applyPendingDeliveryEvents(database(), { now: at(6) });

      const senders = await client()`
        select conversation_occurred_at from sender_states
        where sender_hash = ${farmerHash}
      `;
      // Either no row at all, or one whose conversation watermark was never set.
      expect(senders[0]?.conversation_occurred_at ?? null).toBeNull();
    });

    it("bounds one pass to its limit and leaves the rest pending", async () => {
      const attempts = await Promise.all(
        Array.from({ length: 5 }, (_, index) => dispatchedWork(`d-bound-${index}`)),
      );
      for (const [index, attempt] of attempts.entries()) {
        await storeCallback({
          dispatchAttemptId: attempt.dispatchAttemptId,
          providerEventId: `evt-bound-${index}`,
          eventType: "message_finalized",
          deliveryStatus: "delivered",
          occurredAt: at(5),
        });
      }

      const result = await applyPendingDeliveryEvents(database(), {
        now: at(6),
        limit: 2,
      });

      expect(result.applied).toBe(2);
      expect(await eventStates()).toEqual({ pending: 3, processed: 2 });
    });

    it("carries no raw phone in its result", async () => {
      const { dispatchAttemptId } = await dispatchedWork("d-privacy");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-privacy",
        eventType: "message_finalized",
        deliveryStatus: "delivered",
        occurredAt: at(5),
      });

      const result = await applyPendingDeliveryEvents(database(), { now: at(6) });

      // Counts only, in keeping with the retention pass. Nothing identifying an actor.
      expect(JSON.stringify(result)).not.toMatch(/\+1\d{10}/);
      expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{64}/i);
      expect(Object.keys(result)).toEqual(["applied"]);
    });

    it("cannot hold a delivery event that correlates to nothing", async () => {
      // A pass that hit an event whose dispatch attempt was missing would leave it pending
      // and re-claim it on every pass forever, so the obvious fix is a `rejected` terminal
      // state for it. The database makes that state UNREACHABLE, which is better than
      // handling it — so this asserts the guarantee instead of building the handler.
      //
      // Two constraints together: the projection check forbids a delivery event without a
      // `dispatch_attempt_id`, and the FK is `on delete restrict` so the attempt cannot be
      // deleted out from under it. If either is ever relaxed, this fails and the pass needs
      // an orphan path.
      const { dispatchAttemptId } = await dispatchedWork("d-orphan");
      await storeCallback({
        dispatchAttemptId,
        providerEventId: "evt-orphan",
        eventType: "message_finalized",
        deliveryStatus: "delivered",
        occurredAt: at(5),
      });

      await expect(
        client()`
          update provider_inbox_events set dispatch_attempt_id = null
          where provider_event_id = 'evt-orphan'
        `,
      ).rejects.toThrow(/minimal_projection_per_event_type/);

      await expect(
        client()`
          delete from outbox_dispatch_attempts where id = ${dispatchAttemptId}
        `,
      ).rejects.toThrow(/dispatch_attempt_fk|violates foreign key/);
    });
  });
});
