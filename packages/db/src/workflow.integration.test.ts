import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import {
  acceptProviderEvent,
  applyConsentTransition,
  applyDeliveryEvent,
  authorizeDispatch,
  claimNextInboundEvent,
  confirmInventoryPublication,
  createDb,
  openOrReviseProposal,
  recordDispatchResult,
  releaseAbandonedClaims,
  type Db,
} from "./index";

// F-014 — the authoritative transaction path: one verified provider event produces at
// most one current, authorized durable consequence and one safely dispatched response.
// These run against real Postgres so the constraints, row locks, and transactions are
// the thing under test, not a mock of them.

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
const customerHash = "2".repeat(64);

// The fixture timeline is ANCHORED TO THE REAL CLOCK, not to a calendar date.
//
// `outbox_work.created_at` defaults to `now()`, and the schema enforces
// `body_expires_at > created_at` (the retention rule: a body must outlive its own row).
// Hard-coded calendar fixtures satisfied that only until the wall clock passed them — the
// suite was green on 2026-07-25 and 54 tests failed at midnight, because a fixture expiry
// written as "tomorrow" became "yesterday" without a line of code changing.
//
// So T0 is a fixed point a day in the past and every other instant is expressed as an
// OFFSET from it. Offsets preserve every ordering and duration the tests assert; only the
// absolute position of the timeline moves. Never reintroduce a literal date here.
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);

/** An instant relative to the fixture anchor. `at(0)` is T0; minutes may be fractional. */
const at = (minutesFromT0: number) => new Date(T0.getTime() + minutesFromT0 * 60 * 1000);

/** Far enough ahead of any row's `created_at` to satisfy the retention constraint. */
const BODY_EXPIRES_AT = at(48 * 60);

describe("authoritative SMS transactions (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let sql: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_wf_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = testDatabaseUrl(baseUrl, testDatabaseName);

    // Migrate on a dedicated client that is then discarded: drizzle's migrator installs
    // type parsers on the connection it uses, which breaks Date parameter binding for
    // any later query on that same client.
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

  function client(): ReturnType<typeof postgres> {
    if (!sql) throw new Error("test database is not initialized");
    return sql;
  }

  function database(): Db {
    if (!db) throw new Error("test database is not initialized");
    return db;
  }

  beforeEach(async () => {
    // Each test starts from a clean, fully-approved fixture farm.
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
      values ('+12065550301', ${farmerHash}), ('+12065550302', ${customerHash})
      returning id, phone_hash
    `;
    for (const row of contacts) ids[row.phone_hash as string] = row.id as string;

    const admins = await client()`
      insert into administrators (email, contact_id, authorized_at)
      values ('workflow-admin@viga.example', ${ids[customerHash] as string}, ${T0}) returning id
    `;
    ids.administrator = admins[0]?.id as string;

    const farms = await client()`
      insert into farms (name) values ('Workflow Farm') returning id
    `;
    ids.farm = farms[0]?.id as string;

    const auths = await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${ids.farm}, ${ids[farmerHash] as string}, ${T0}, ${T0}) returning id
    `;
    ids.authorization = auths[0]?.id as string;

    const approvals = await client()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${ids.farm}, ${ids.administrator}, ${T0}) returning id
    `;
    ids.approval = approvals[0]?.id as string;

    const locations = await client()`
      insert into sales_locations (
        farm_id, kind, name, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (${ids.farm}, 'farm_stand', 'Workflow Stand', '9 Stand Way',
              47.45, -122.46, true, true)
      returning id
    `;
    ids.location = locations[0]?.id as string;

    await client()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      )
      values (${farmerHash}, 'active', 'farmer_onboarding', ${T0}, 'onboarding-1', ${T0})
    `;
  });

  const inbound = (overrides: Record<string, unknown> = {}) => ({
    providerEventId: `evt-${randomUUID()}`,
    eventType: "message_received" as const,
    providerMessageId: `msg-${randomUUID()}`,
    senderHash: farmerHash,
    body: "potatoes and bok choy",
    occurredAt: T0,
    ...overrides,
  });

  describe("durable acceptance and deduplication", () => {
    it("accepts a verified event once and treats a retry as a successful no-op", async () => {
      const event = inbound();

      const first = await acceptProviderEvent(database(), event);
      const second = await acceptProviderEvent(database(), event);

      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(false);
      expect(second.inboxEventId).toBe(first.inboxEventId);

      const rows = await client()`
        select count(*)::integer as count from provider_inbox_events
      `;
      expect(rows[0]?.count).toBe(1);
      const messages = await client()`
        select count(*)::integer as count from sms_messages
      `;
      expect(messages[0]?.count).toBe(1);
    });

    it("stores no raw provider envelope and no second raw phone", async () => {
      await acceptProviderEvent(database(), inbound());

      const columns = await client()`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'provider_inbox_events'
        order by column_name
      `;
      const names = columns.map((row) => row.column_name as string);
      expect(names).not.toContain("payload");
      expect(names).not.toContain("raw_payload");
      expect(names).not.toContain("envelope");
      expect(names).not.toContain("phone_e164");
    });

    it("accepts concurrent duplicate deliveries of the same event exactly once", async () => {
      const event = inbound();

      const results = await Promise.all([
        acceptProviderEvent(database(), event),
        acceptProviderEvent(database(), event),
        acceptProviderEvent(database(), event),
      ]);

      expect(results.filter((result) => result.accepted)).toHaveLength(1);
      const rows = await client()`
        select count(*)::integer as count from provider_inbox_events
      `;
      expect(rows[0]?.count).toBe(1);
    });
  });

  describe("sender claiming and conversation ordering", () => {
    it("lets only one worker claim work for a sender at a time", async () => {
      await acceptProviderEvent(database(), inbound({ occurredAt: at(0) }));
      await acceptProviderEvent(database(), inbound({ occurredAt: at(5) }));

      const claims = await Promise.all([
        claimNextInboundEvent(database(), { senderHash: farmerHash, now: T0 }),
        claimNextInboundEvent(database(), { senderHash: farmerHash, now: T0 }),
      ]);

      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    });

    it("recovers an abandoned claim on the same inbox row without duplicating it", async () => {
      const event = inbound();
      await acceptProviderEvent(database(), event);

      const first = await claimNextInboundEvent(database(), {
        senderHash: farmerHash,
        now: T0,
        claimTtlMs: 60_000,
      });
      expect(first).not.toBeNull();

      // The worker dies. After the claim lapses the same row becomes claimable again.
      const released = await releaseAbandonedClaims(database(), {
        now: at(2),
      });
      expect(released).toBe(1);

      const second = await claimNextInboundEvent(database(), {
        senderHash: farmerHash,
        now: at(2),
      });
      expect(second?.inboxEventId).toBe(first?.inboxEventId);

      const rows = await client()`
        select count(*)::integer as count from provider_inbox_events
      `;
      expect(rows[0]?.count).toBe(1);
    });

    it("fails closed on an event older than the sender's conversation watermark", async () => {
      const newer = inbound({ occurredAt: at(10) });
      await acceptProviderEvent(database(), newer);
      const claimed = await claimNextInboundEvent(database(), {
        senderHash: farmerHash,
        now: T0,
      });
      await claimed?.finalize({ outcome: "processed", now: T0 });

      const older = inbound({ occurredAt: at(1) });
      await acceptProviderEvent(database(), older);

      const stale = await claimNextInboundEvent(database(), {
        senderHash: farmerHash,
        now: T0,
      });
      expect(stale?.isStale).toBe(true);
    });

    it("does not let a delivery callback enter sender conversation state", async () => {
      await acceptProviderEvent(database(), inbound());
      const claimed = await claimNextInboundEvent(database(), {
        senderHash: farmerHash,
        now: T0,
      });
      expect(claimed).not.toBeNull();

      // A delivery event is durable and deduplicated, but claims no sender.
      const outbox = await client()`
        insert into outbox_work (
          logical_key, recipient_hash, message_category, body, body_expires_at,
          available_at, state, dispatch_authorized_at
        )
        values ('wf-delivery-1', ${farmerHash}, 'inquiry_reply', 'hi',
                ${BODY_EXPIRES_AT}, ${T0}, 'dispatching', ${T0})
        returning id
      `;
      const attempt = await client()`
        insert into outbox_dispatch_attempts (
          outbox_work_id, attempt_number, state, provider_message_id, started_at, completed_at
        )
        values (${outbox[0]?.id as string}, 1, 'accepted', 'pm-1', ${T0}, ${T0})
        returning id
      `;

      const result = await acceptProviderEvent(database(), {
        providerEventId: `evt-${randomUUID()}`,
        eventType: "message_sent",
        dispatchAttemptId: attempt[0]?.id as string,
        deliveryStatus: "sent",
        occurredAt: T0,
      });
      expect(result.accepted).toBe(true);

      const claims = await client()`
        select count(*)::integer as count from provider_inbox_events
        where state = 'processing' and event_type <> 'message_received'
          and sender_hash is not null
      `;
      expect(claims[0]?.count).toBe(0);
    });
  });

  describe("consent ordering", () => {
    it("does not let an older START undo a newer STOP", async () => {
      await applyConsentTransition(database(), {
        recipientHash: farmerHash,
        transition: "stop",
        occurredAt: at(10),
        providerEventId: "consent-stop",
      });

      const late = await applyConsentTransition(database(), {
        recipientHash: farmerHash,
        transition: "start",
        occurredAt: at(5),
        providerEventId: "consent-start-late",
      });

      expect(late.applied).toBe(false);
      const consent = await client()`
        select state from sms_consents where recipient_hash = ${farmerHash}
      `;
      expect(consent[0]?.state).toBe("stopped");
    });

    it("lets STOP win an exact timestamp tie", async () => {
      const tie = at(10);
      await applyConsentTransition(database(), {
        recipientHash: farmerHash,
        transition: "start",
        occurredAt: tie,
        providerEventId: "consent-start-tie",
      });
      await applyConsentTransition(database(), {
        recipientHash: farmerHash,
        transition: "stop",
        occurredAt: tie,
        providerEventId: "consent-stop-tie",
      });

      const consent = await client()`
        select state from sms_consents where recipient_hash = ${farmerHash}
      `;
      expect(consent[0]?.state).toBe("stopped");
    });

    it("is not made stale by intervening conversation messages", async () => {
      await applyConsentTransition(database(), {
        recipientHash: farmerHash,
        transition: "stop",
        occurredAt: at(10),
        providerEventId: "consent-stop-2",
      });

      // Ordinary inbound traffic advances the conversation watermark, not consent.
      await acceptProviderEvent(database(), inbound({ occurredAt: at(20) }));
      const claimed = await claimNextInboundEvent(database(), {
        senderHash: farmerHash,
        now: T0,
      });
      await claimed?.finalize({ outcome: "processed", now: T0 });

      const restored = await applyConsentTransition(database(), {
        recipientHash: farmerHash,
        transition: "start",
        occurredAt: at(30),
        providerEventId: "consent-start-2",
      });
      expect(restored.applied).toBe(true);
    });
  });

  describe("inventory proposal and publication", () => {
    async function openProposal(overrides: Record<string, unknown> = {}) {
      return openOrReviseProposal(database(), {
        senderHash: farmerHash,
        salesLocationId: ids.location as string,
        entries: [{ itemName: "Potatoes" }],
        now: T0,
        ...overrides,
      });
    }

    it("keeps exactly one open proposal per sender and increments its version", async () => {
      const first = await openProposal();
      const revised = await openProposal({ entries: [{ itemName: "Bok choy" }] });

      expect(revised.proposalId).toBe(first.proposalId);
      expect(revised.proposalVersion).toBe(2);

      const open = await client()`
        select count(*)::integer as count from inventory_publication_proposals
        where sender_hash = ${farmerHash} and state = 'open'
      `;
      expect(open[0]?.count).toBe(1);
    });

    it("refuses a token before its current prompt has been provider-accepted", async () => {
      const proposal = await openProposal();

      const result = await confirmInventoryPublication(database(), {
        proposalId: proposal.proposalId,
        senderHash: farmerHash,
        token: "yes",
        occurredAt: T0,
        providerEventId: "confirm-too-early",
        clock: new FixedClock(T0),
      });

      expect(result.status).toBe("not_activated");
      const revisions = await client()`
        select count(*)::integer as count from inventory_revisions
      `;
      expect(revisions[0]?.count).toBe(0);
    });

    it("publishes exactly once under concurrent YES tokens", async () => {
      const proposal = await openProposal();
      await proposal.activate({
        providerAcceptedAt: at(5),
        outboxLogicalKey: "wf-prompt-1",
      });

      const confirm = (eventId: string) =>
        confirmInventoryPublication(database(), {
          proposalId: proposal.proposalId,
          senderHash: farmerHash,
          token: "yes" as const,
          occurredAt: at(6),
          providerEventId: eventId,
          clock: new FixedClock(at(6)),
        });

      const results = await Promise.all([
        confirm("confirm-a"),
        confirm("confirm-b"),
      ]);

      expect(results.filter((r) => r.status === "published")).toHaveLength(1);
      const revisions = await client()`
        select count(*)::integer as count from inventory_revisions
      `;
      expect(revisions[0]?.count).toBe(1);
    });

    it("expires 12 hours after the prompt was accepted", async () => {
      const proposal = await openProposal();
      await proposal.activate({
        providerAcceptedAt: at(0),
        outboxLogicalKey: "wf-prompt-2",
      });

      const justInside = await confirmInventoryPublication(database(), {
        proposalId: proposal.proposalId,
        senderHash: farmerHash,
        token: "yes",
        occurredAt: at(719),
        providerEventId: "confirm-inside",
        clock: new FixedClock(at(719)),
      });
      expect(justInside.status).toBe("published");

      const second = await openProposal({ entries: [{ itemName: "Bok choy" }] });
      await second.activate({
        providerAcceptedAt: at(720),
        outboxLogicalKey: "wf-prompt-3",
      });
      const past = await confirmInventoryPublication(database(), {
        proposalId: second.proposalId,
        senderHash: farmerHash,
        token: "yes",
        occurredAt: at(1440.0166666666667),
        providerEventId: "confirm-expired",
        clock: new FixedClock(at(1440.0166666666667)),
      });
      expect(past.status).toBe("expired");
    });

    it("refuses to publish when farmer authority was revoked", async () => {
      const proposal = await openProposal();
      await proposal.activate({
        providerAcceptedAt: at(5),
        outboxLogicalKey: "wf-prompt-4",
      });
      await client()`
        update farmer_authorizations set revoked_at = ${at(5.5)}
        where id = ${ids.authorization as string}
      `;

      const result = await confirmInventoryPublication(database(), {
        proposalId: proposal.proposalId,
        senderHash: farmerHash,
        token: "yes",
        occurredAt: at(6),
        providerEventId: "confirm-unauthorized",
        clock: new FixedClock(at(6)),
      });

      expect(result.status).toBe("not_authorized");
      const revisions = await client()`
        select count(*)::integer as count from inventory_revisions
      `;
      expect(revisions[0]?.count).toBe(0);
    });

    it("refuses to publish when VIGA approval was revoked", async () => {
      const proposal = await openProposal();
      await proposal.activate({
        providerAcceptedAt: at(5),
        outboxLogicalKey: "wf-prompt-5",
      });
      await client()`
        update farm_approvals set revoked_at = ${at(5.5)}
        where id = ${ids.approval as string}
      `;

      const result = await confirmInventoryPublication(database(), {
        proposalId: proposal.proposalId,
        senderHash: farmerHash,
        token: "yes",
        occurredAt: at(6),
        providerEventId: "confirm-unapproved",
        clock: new FixedClock(at(6)),
      });

      expect(result.status).toBe("not_approved");
    });

    it("NO consumes the proposal and creates no revision", async () => {
      const proposal = await openProposal();
      await proposal.activate({
        providerAcceptedAt: at(5),
        outboxLogicalKey: "wf-prompt-6",
      });

      const result = await confirmInventoryPublication(database(), {
        proposalId: proposal.proposalId,
        senderHash: farmerHash,
        token: "no",
        occurredAt: at(6),
        providerEventId: "confirm-no",
        clock: new FixedClock(at(6)),
      });

      expect(result.status).toBe("declined");
      const revisions = await client()`
        select count(*)::integer as count from inventory_revisions
      `;
      expect(revisions[0]?.count).toBe(0);
      const state = await client()`
        select state from inventory_publication_proposals where id = ${proposal.proposalId}
      `;
      expect(state[0]?.state).toBe("declined");
    });

    it("invalidates a proposal whose base revision is no longer current", async () => {
      const first = await openProposal();
      await first.activate({
        providerAcceptedAt: at(5),
        outboxLogicalKey: "wf-prompt-7",
      });
      await confirmInventoryPublication(database(), {
        proposalId: first.proposalId,
        senderHash: farmerHash,
        token: "yes",
        occurredAt: at(6),
        providerEventId: "confirm-base-1",
        clock: new FixedClock(at(6)),
      });

      // A proposal computed against the now-superseded base must not publish.
      const stale = await openOrReviseProposal(database(), {
        senderHash: farmerHash,
        salesLocationId: ids.location as string,
        entries: [{ itemName: "Green beans" }],
        now: at(7),
        baseRevisionId: null,
        baseIsFirstPublication: true,
      });
      await stale.activate({
        providerAcceptedAt: at(8),
        outboxLogicalKey: "wf-prompt-8",
      });

      const result = await confirmInventoryPublication(database(), {
        proposalId: stale.proposalId,
        senderHash: farmerHash,
        token: "yes",
        occurredAt: at(9),
        providerEventId: "confirm-base-conflict",
        clock: new FixedClock(at(9)),
      });

      expect(result.status).toBe("base_conflict");
      const revisions = await client()`
        select count(*)::integer as count from inventory_revisions
      `;
      expect(revisions[0]?.count).toBe(1);
    });

    it("supersedes the prior current revision and queues its response atomically", async () => {
      const proposal = await openProposal();
      await proposal.activate({
        providerAcceptedAt: at(5),
        outboxLogicalKey: "wf-prompt-9",
      });
      const published = await confirmInventoryPublication(database(), {
        proposalId: proposal.proposalId,
        senderHash: farmerHash,
        token: "yes",
        occurredAt: at(6),
        providerEventId: "confirm-supersede-1",
        clock: new FixedClock(at(6)),
      });
      expect(published.status).toBe("published");

      const current = await client()`
        select id from inventory_revisions where is_current
      `;
      expect(current).toHaveLength(1);

      const queued = await client()`
        select count(*)::integer as count from outbox_work
        where message_category = 'inquiry_reply'
      `;
      expect(queued[0]?.count).toBe(1);
    });
  });

  describe("dispatch, STOP ordering, and delivery", () => {
    async function queueWork(
      logicalKey: string,
      category: "required_reply" | "inventory_prompt" = "inventory_prompt",
    ) {
      const rows = await client()`
        insert into outbox_work (
          logical_key, recipient_hash, message_category, body, body_expires_at,
          available_at
        )
        values (${logicalKey}, ${farmerHash}, ${category}, 'hello',
                ${BODY_EXPIRES_AT}, ${T0})
        returning id
      `;
      return rows[0]?.id as string;
    }

    it("suppresses queued non-required work when STOP commits first", async () => {
      const workId = await queueWork("wf-stop-1");
      await applyConsentTransition(database(), {
        recipientHash: farmerHash,
        transition: "stop",
        occurredAt: at(1),
        providerEventId: "stop-before-dispatch",
      });

      const claim = await authorizeDispatch(database(), {
        outboxWorkId: workId,
        now: at(2),
      });

      expect(claim.status).toBe("suppressed");
      const row = await client()`select state from outbox_work where id = ${workId}`;
      expect(row[0]?.state).toBe("suppressed");
    });

    it("treats work already dispatch-authorized as potentially in flight", async () => {
      const workId = await queueWork("wf-stop-2");
      const claim = await authorizeDispatch(database(), {
        outboxWorkId: workId,
        now: at(1),
      });
      expect(claim.status).toBe("authorized");

      await applyConsentTransition(database(), {
        recipientHash: farmerHash,
        transition: "stop",
        occurredAt: at(2),
        providerEventId: "stop-after-dispatch",
      });

      // Farm Friend does not claim it can recall authorized work.
      const row = await client()`select state from outbox_work where id = ${workId}`;
      expect(row[0]?.state).toBe("dispatching");
    });

    it("authorizes a given outbox row only once under concurrency", async () => {
      const workId = await queueWork("wf-dispatch-once");

      const claims = await Promise.all([
        authorizeDispatch(database(), { outboxWorkId: workId, now: T0 }),
        authorizeDispatch(database(), { outboxWorkId: workId, now: T0 }),
      ]);

      expect(claims.filter((c) => c.status === "authorized")).toHaveLength(1);
      const attempts = await client()`
        select count(*)::integer as count from outbox_dispatch_attempts
        where outbox_work_id = ${workId}
      `;
      expect(attempts[0]?.count).toBe(1);
    });

    it("retries a definite rejection within a bounded policy", async () => {
      const workId = await queueWork("wf-retry");
      const claim = await authorizeDispatch(database(), { outboxWorkId: workId, now: T0 });
      if (claim.status !== "authorized") throw new Error("expected authorization");

      const result = await recordDispatchResult(database(), {
        dispatchAttemptId: claim.dispatchAttemptId,
        outcome: "definitive_rejection",
        errorCode: "40003",
        now: T0,
      });

      expect(result.retryable).toBe(true);
      const row = await client()`select state from outbox_work where id = ${workId}`;
      expect(row[0]?.state).toBe("queued");
    });

    it("quarantines an ambiguous result instead of resending it", async () => {
      const workId = await queueWork("wf-ambiguous");
      const claim = await authorizeDispatch(database(), { outboxWorkId: workId, now: T0 });
      if (claim.status !== "authorized") throw new Error("expected authorization");

      const result = await recordDispatchResult(database(), {
        dispatchAttemptId: claim.dispatchAttemptId,
        outcome: "ambiguous",
        errorCode: "ETIMEDOUT",
        now: T0,
      });

      expect(result.retryable).toBe(false);
      const row = await client()`select state from outbox_work where id = ${workId}`;
      expect(row[0]?.state).toBe("ambiguous");

      const reclaim = await authorizeDispatch(database(), {
        outboxWorkId: workId,
        now: at(60),
      });
      expect(reclaim.status).not.toBe("authorized");
    });

    it("applies out-of-order delivery events monotonically", async () => {
      const workId = await queueWork("wf-delivery-order");
      const claim = await authorizeDispatch(database(), { outboxWorkId: workId, now: T0 });
      if (claim.status !== "authorized") throw new Error("expected authorization");
      await recordDispatchResult(database(), {
        dispatchAttemptId: claim.dispatchAttemptId,
        outcome: "accepted",
        providerMessageId: "pm-order-1",
        now: T0,
      });

      // finalized (later) arrives before sent (earlier).
      await applyDeliveryEvent(database(), {
        dispatchAttemptId: claim.dispatchAttemptId,
        deliveryStatus: "delivered",
        occurredAt: at(10),
        providerEventId: "delivery-finalized",
      });
      await applyDeliveryEvent(database(), {
        dispatchAttemptId: claim.dispatchAttemptId,
        deliveryStatus: "sent",
        occurredAt: at(5),
        providerEventId: "delivery-sent",
      });

      const row = await client()`
        select delivery_status from outbox_work where id = ${workId}
      `;
      expect(row[0]?.delivery_status).toBe("delivered");
    });

    it("treats a duplicate delivery event as a no-op", async () => {
      const workId = await queueWork("wf-delivery-dup");
      const claim = await authorizeDispatch(database(), { outboxWorkId: workId, now: T0 });
      if (claim.status !== "authorized") throw new Error("expected authorization");
      await recordDispatchResult(database(), {
        dispatchAttemptId: claim.dispatchAttemptId,
        outcome: "accepted",
        providerMessageId: "pm-dup-1",
        now: T0,
      });

      const event = {
        dispatchAttemptId: claim.dispatchAttemptId,
        deliveryStatus: "delivered" as const,
        occurredAt: at(10),
        providerEventId: "delivery-dup",
      };
      await applyDeliveryEvent(database(), event);
      await applyDeliveryEvent(database(), event);

      const row = await client()`
        select delivery_status, delivery_event_id from outbox_work where id = ${workId}
      `;
      expect(row[0]?.delivery_status).toBe("delivered");
      expect(row[0]?.delivery_event_id).toBe("delivery-dup");
    });

    it("never exposes a raw phone through queued work or dispatch records", async () => {
      const workId = await queueWork("wf-no-raw-phone");
      const claim = await authorizeDispatch(database(), { outboxWorkId: workId, now: T0 });
      if (claim.status !== "authorized") throw new Error("expected authorization");

      expect(JSON.stringify(claim)).not.toMatch(/\+1\d{10}/);
      const row = await client()`
        select * from outbox_work where id = ${workId}
      `;
      expect(JSON.stringify(row[0])).not.toMatch(/\+1\d{10}/);
      expect(row[0]?.recipient_hash).toBe(farmerHash);
    });
  });

  // F-016 — one launch operational SMS program. The dispatch claim is where the consent
  // MEANING defined in packages/core/src/sms/consent.ts becomes a durable consequence.
  describe("one launch program consent at the dispatch boundary", () => {
    // A recipient who has never opted in: no sms_consents row at all.
    const neverOptedIn = "3".repeat(64);

    async function queueFor(
      recipientHash: string,
      logicalKey: string,
      category: string,
    ) {
      const rows = await client()`
        insert into outbox_work (
          logical_key, recipient_hash, message_category, body, body_expires_at,
          available_at
        )
        values (${logicalKey}, ${recipientHash}, ${category}, 'hello',
                ${BODY_EXPIRES_AT}, ${T0})
        returning id
      `;
      return rows[0]?.id as string;
    }

    beforeEach(async () => {
      await client()`
        insert into contacts (phone_e164, phone_hash)
        values ('+12065550399', ${neverOptedIn})
        on conflict (phone_hash) do nothing
      `;
    });

    it("refuses proactive work for a recipient who never opted in", async () => {
      // Absent consent is NOT permission. Before F-016 the gate asked only whether the
      // recipient had STOPped, so silence read as consent and this was authorized.
      const workId = await queueFor(
        neverOptedIn,
        "wf-consent-absent",
        "inventory_prompt",
      );

      const claim = await authorizeDispatch(database(), {
        outboxWorkId: workId,
        now: T0,
      });

      expect(claim.status).toBe("suppressed");
      const row = await client()`select state from outbox_work where id = ${workId}`;
      expect(row[0]?.state).toBe("suppressed");
    });

    it("still delivers the required reply to a recipient who just STOPped", async () => {
      // The carrier-required answer to the recipient's own message must survive, or STOP
      // could not acknowledge itself. The STOPPED recipient is the case that matters:
      // an absent consent row would pass even if this exemption were deleted.
      await applyConsentTransition(database(), {
        recipientHash: neverOptedIn,
        transition: "stop",
        occurredAt: at(1),
        providerEventId: "consent-stop-required",
      });

      const workId = await queueFor(
        neverOptedIn,
        "wf-consent-required",
        "required_reply",
      );
      const claim = await authorizeDispatch(database(), {
        outboxWorkId: workId,
        now: at(2),
      });
      expect(claim.status).toBe("authorized");

      // ...while ordinary proactive work to that same stopped recipient is suppressed.
      const proactiveId = await queueFor(
        neverOptedIn,
        "wf-consent-required-proactive",
        "inventory_prompt",
      );
      const proactive = await authorizeDispatch(database(), {
        outboxWorkId: proactiveId,
        now: at(3),
      });
      expect(proactive.status).toBe("suppressed");
    });

    it("carries every launch message category on the one active consent", async () => {
      // The core of finding 4: these are categories, not enrollments. The farmer holds
      // ONE consent captured at onboarding, and all three proactive kinds ride on it —
      // none of them needs its own opt-in.
      for (const kind of [
        "inventory_prompt",
        "inventory_confirmation",
        "stock_out_alert",
      ]) {
        const workId = await queueFor(farmerHash, `wf-category-${kind}`, kind);
        const claim = await authorizeDispatch(database(), {
          outboxWorkId: workId,
          now: T0,
        });
        expect(claim.status, `${kind} should ride the one launch consent`).toBe(
          "authorized",
        );
      }

      // And exactly one consent row backs all of them — no per-category enrollment.
      const consents = await client()`
        select count(*)::integer as count from sms_consents
        where recipient_hash = ${farmerHash}
      `;
      expect(consents[0]?.count).toBe(1);
    });

    it("restores the one consent state on JOIN and on START alike", async () => {
      // JOIN and START are two spellings of one enrollment, differing only in recorded
      // provenance. Neither creates a second program.
      await applyConsentTransition(database(), {
        recipientHash: neverOptedIn,
        transition: "stop",
        occurredAt: at(1),
        providerEventId: "consent-stop-a",
      });

      const restored = await applyConsentTransition(database(), {
        recipientHash: neverOptedIn,
        transition: "start",
        occurredAt: at(2),
        providerEventId: "consent-join-a",
        captureSource: "join",
      });
      expect(restored.state).toBe("active");

      const rows = await client()`
        select state, capture_source from sms_consents
        where recipient_hash = ${neverOptedIn}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("active");
      expect(rows[0]?.capture_source).toBe("join");

      // Now proactive work to that recipient is permitted — by the one program.
      const workId = await queueFor(
        neverOptedIn,
        "wf-consent-after-join",
        "inventory_prompt",
      );
      const claim = await authorizeDispatch(database(), {
        outboxWorkId: workId,
        now: at(3),
      });
      expect(claim.status).toBe("authorized");
    });

    it("stores no follow-up interest and no second subscription for an answered inquiry", async () => {
      // A customer-initiated inquiry earns its direct reply and nothing durable. This is
      // the removed passive follow-up: answering must not enroll anyone.
      const workId = await queueFor(
        neverOptedIn,
        "wf-inquiry-reply",
        "inquiry_reply",
      );
      const claim = await authorizeDispatch(database(), {
        outboxWorkId: workId,
        now: T0,
      });
      expect(claim.status).toBe("authorized");

      // Answering created no consent record, so no later proactive message can claim
      // this customer as a subscriber.
      const consents = await client()`
        select count(*)::integer as count from sms_consents
        where recipient_hash = ${neverOptedIn}
      `;
      expect(consents[0]?.count).toBe(0);

      // And a proactive follow-up to that same customer is refused.
      const followUpId = await queueFor(
        neverOptedIn,
        "wf-inquiry-followup",
        "inventory_prompt",
      );
      const followUp = await authorizeDispatch(database(), {
        outboxWorkId: followUpId,
        now: at(60),
      });
      expect(followUp.status).toBe("suppressed");
    });
  });
});
