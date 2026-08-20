import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  disposeFlag,
  listFlagsForReview,
  listStandDataFlags,
  listStockOutReports,
  purgeExpiredBodies,
  readFlaggedThread,
  resolveStandDataFlag,
  triageStockOutReport,
  type Db,
} from "./index";

// F-030 — the operator review queues, against real Postgres.
//
// These tests are the spec for two surfaces that did not exist: flag review (the FLAG safety
// rail's human half — a registered 10DLC commitment that until now no human could act on) and
// stock-out report visibility (private customer signals that accumulated with no reader).
//
// Three properties are load-bearing and each is proven by sabotage rather than by shape:
//
//   1. Disposing a flag makes F-026's retention purge clear that thread's expired bodies. The
//      exemption fails safe, so before F-030 nothing moved a flag out of `open` and a flagged
//      body retained forever. That is proven END TO END here — real flag, real purge.
//   2. No triage action mutates published inventory, answers, or ranking (Golden Rule #1).
//      A customer's report and an operator's triage of it are signals; only the farmer's
//      confirmed action changes what a stand shows.
//   3. Nothing these queues return carries a raw phone or a hash. The thread viewer shows the
//      retained context of a flagged thread with the sender masked.

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

const senderHash = "a".repeat(64);
const otherSenderHash = "b".repeat(64);
const farmerHash = "c".repeat(64);

// Anchored to the real clock, never a date literal (B-003): this suite drives an expiry
// boundary, and a literal date silently inverts once the wall clock passes it.
const T0 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const at = (minutesFromT0: number) =>
  new Date(T0.getTime() + minutesFromT0 * 60 * 1000);
const HOUR = 60;

/** Expires an hour after T0 — already past at PURGE_AT. */
const EXPIRES_EARLY = at(HOUR);
/** The instant every purge in this file runs at. */
const PURGE_AT = at(10 * HOUR);

describe("operator review queues (integration)", () => {
  let adminClient: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  let testUrl = "";
  const ids: Record<string, string> = {};

  function id(key: string): string {
    const value = ids[key];
    if (value === undefined) throw new Error(`fixture id "${key}" is not set`);
    return value;
  }

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_review_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    testUrl = url;
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
        seller_approvals, farmer_authorizations, seller_payment_methods,
        seller_links, sales_locations, administrators, sellers, contacts,
        admin_sessions
      restart identity cascade
    `;

    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash)
      values
        ('+12065550701', ${senderHash}),
        ('+12065550702', ${otherSenderHash}),
        ('+12065550703', ${farmerHash})
      returning id, phone_hash
    `;
    for (const row of contacts) ids[row.phone_hash as string] = row.id as string;

    const admins = await client()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${T0}) returning id
    `;
    ids.administrator = admins[0]?.id as string;

    const sellers = await client()`
      insert into sellers (name) values ('Provo Farms') returning id
    `;
    ids.farm = sellers[0]?.id as string;

    const locations = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address,
        public_latitude, public_longitude
      )
      values (
        ${id("farm")}, 'farm_stand', 'Provo Farms Stand', 'America/Los_Angeles', 'visitable', 'produce',
        '1 Vashon Hwy', 47.4, -122.4
      )
      returning id
    `;
    ids.location = locations[0]?.id as string;
  });

  /** An inbound message plus its minimized inbox projection, with a caller-chosen expiry. */
  async function inboundMessage(input: {
    body: string;
    expiresAt: Date;
    receivedAt?: Date;
    sender?: string;
  }): Promise<{ messageId: string; inboxEventId: string }> {
    const receivedAt = input.receivedAt ?? T0;
    const sender = input.sender ?? senderHash;
    const messages = await client()`
      insert into sms_messages (
        provider_message_id, sender_hash, body, body_expires_at, received_at
      )
      values (
        ${`msg-${randomUUID()}`}, ${sender}, ${input.body},
        ${input.expiresAt}, ${receivedAt}
      )
      returning id
    `;
    const messageId = messages[0]?.id as string;
    const events = await client()`
      insert into provider_inbox_events (
        provider_event_id, event_type, message_id, sender_hash, occurred_at,
        state, finalized_at
      )
      values (
        ${`evt-${randomUUID()}`}, 'message_received', ${messageId},
        ${sender}, ${receivedAt}, 'processed', ${receivedAt}
      )
      returning id
    `;
    return { messageId, inboxEventId: events[0]?.id as string };
  }

  /** An open flag on a message, the way `routeInboundMessage` writes one. */
  async function openFlag(input: {
    inboxEventId: string;
    sender?: string;
    createdAt?: Date;
  }): Promise<string> {
    const rows = await client()`
      insert into flags (contact_hash, inbox_event_id, reason_code, status, created_at)
      values (
        ${input.sender ?? senderHash}, ${input.inboxEventId}, 'sender_flagged',
        'open', ${input.createdAt ?? T0}
      )
      returning id
    `;
    return rows[0]?.id as string;
  }

  async function bodyOf(messageId: string): Promise<string | null> {
    const rows = await client()`
      select body from sms_messages where id = ${messageId}
    `;
    return (rows[0]?.body as string | null) ?? null;
  }

  // ── The flag queue ────────────────────────────────────────────────────────────

  describe("listFlagsForReview", () => {
    it("lists an open flag with its masked sender and no phone material", async () => {
      const { inboxEventId } = await inboundMessage({
        body: "please have someone call me",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });

      const flags = await listFlagsForReview(database(), { status: "open" });

      expect(flags).toHaveLength(1);
      expect(flags[0]?.flagId).toBe(flagId);
      expect(flags[0]?.reasonCode).toBe("sender_flagged");
      expect(flags[0]?.status).toBe("open");
      expect(flags[0]?.senderMask).toBe("(•••) •••-0701");

      // Golden Rule #5, asserted on the whole serialized row rather than field by field: a
      // future column carrying a hash would fail here rather than shipping.
      const serialized = JSON.stringify(flags);
      expect(serialized).not.toMatch(/\+1\d{10}/);
      expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    });

    it("returns disposed flags only when asked for them", async () => {
      const open = await inboundMessage({
        body: "open one",
        expiresAt: EXPIRES_EARLY,
      });
      await openFlag({ inboxEventId: open.inboxEventId });

      const closed = await inboundMessage({
        body: "closed one",
        expiresAt: EXPIRES_EARLY,
        sender: otherSenderHash,
      });
      const closedFlag = await openFlag({
        inboxEventId: closed.inboxEventId,
        sender: otherSenderHash,
      });
      await disposeFlag(database(), {
        flagId: closedFlag,
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "handled",
        occurredAt: at(2 * HOUR),
      });

      expect(await listFlagsForReview(database(), { status: "open" })).toHaveLength(1);
      expect(await listFlagsForReview(database(), { status: "all" })).toHaveLength(2);
    });

    it("orders oldest first, because the oldest unreviewed flag is the most urgent", async () => {
      const first = await inboundMessage({
        body: "earlier",
        expiresAt: EXPIRES_EARLY,
      });
      const second = await inboundMessage({
        body: "later",
        expiresAt: EXPIRES_EARLY,
        sender: otherSenderHash,
      });
      const older = await openFlag({
        inboxEventId: first.inboxEventId,
        createdAt: at(1),
      });
      const newer = await openFlag({
        inboxEventId: second.inboxEventId,
        sender: otherSenderHash,
        createdAt: at(5),
      });

      const flags = await listFlagsForReview(database(), { status: "open" });
      expect(flags.map((flag) => flag.flagId)).toEqual([older, newer]);
    });
  });

  describe("disposeFlag", () => {
    it("records the disposition, the acting administrator, and the time", async () => {
      const { inboxEventId } = await inboundMessage({
        body: "review me",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });

      const result = await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "spoke_with_sender",
        occurredAt: at(3 * HOUR),
      });
      expect(result.status).toBe("disposed");

      const rows = await client()`
        select status, disposition_code, disposed_by_administrator_id, disposed_at
        from flags where id = ${flagId}
      `;
      expect(rows[0]?.status).toBe("resolved");
      expect(rows[0]?.disposition_code).toBe("spoke_with_sender");
      expect(rows[0]?.disposed_by_administrator_id).toBe(id("administrator"));
      expect(rows[0]?.disposed_at).toEqual(at(3 * HOUR));
    });

    it("writes the audit event in the SAME commit as the disposition", async () => {
      const { inboxEventId } = await inboundMessage({
        body: "audit me",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });

      await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "dismissed",
        dispositionCode: "no_action",
        occurredAt: at(3 * HOUR),
      });

      const audits = await client()`
        select action, actor_administrator_id, subject_type, subject_id
        from audit_events where subject_id = ${flagId}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe("flag_dismissed");
      expect(audits[0]?.actor_administrator_id).toBe(id("administrator"));
      expect(audits[0]?.subject_type).toBe("flag");
    });

    it("refuses a revoked administrator, re-reading authority inside the transaction", async () => {
      const { inboxEventId } = await inboundMessage({
        body: "still open",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });
      await client()`
        update administrators set revoked_at = ${at(1)} where id = ${id("administrator")}
      `;

      const result = await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "handled",
        occurredAt: at(3 * HOUR),
      });

      expect(result.status).toBe("not_an_administrator");
      const rows = await client()`select status from flags where id = ${flagId}`;
      expect(rows[0]?.status).toBe("open");
    });

    it("disposes exactly once — a second disposition cannot overwrite the first", async () => {
      const { inboxEventId } = await inboundMessage({
        body: "once",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });

      const first = await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "handled",
        occurredAt: at(3 * HOUR),
      });
      const second = await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "dismissed",
        dispositionCode: "changed_my_mind",
        occurredAt: at(4 * HOUR),
      });

      expect(first.status).toBe("disposed");
      expect(second.status).toBe("already_disposed");
      const rows = await client()`
        select status, disposition_code from flags where id = ${flagId}
      `;
      // The original disposition and its recorded actor survive.
      expect(rows[0]?.status).toBe("resolved");
      expect(rows[0]?.disposition_code).toBe("handled");
      const audits = await client()`
        select count(*)::integer as count from audit_events where subject_id = ${flagId}
      `;
      expect(audits[0]?.count).toBe(1);
    });

    it("does not dispose a flag that does not exist", async () => {
      const result = await disposeFlag(database(), {
        flagId: randomUUID(),
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "handled",
        occurredAt: at(3 * HOUR),
      });
      expect(result.status).toBe("unknown_flag");
    });

    it("serializes concurrent dispositions so exactly one wins", async () => {
      const { inboxEventId } = await inboundMessage({
        body: "contended",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });

      // Eight simultaneous claimants, not two: `Promise.all` over two async branches does not
      // race them (the first transaction resolves before the second starts), so a two-branch
      // test serializes itself and cannot fail.
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          disposeFlag(database(), {
            flagId,
            administratorId: id("administrator"),
            disposition: "resolved",
            dispositionCode: `claimant-${index}`,
            occurredAt: at(3 * HOUR),
          }),
        ),
      );

      expect(attempts.filter((a) => a.status === "disposed")).toHaveLength(1);
      const audits = await client()`
        select count(*)::integer as count from audit_events where subject_id = ${flagId}
      `;
      expect(audits[0]?.count).toBe(1);
    });
  });

  // ── The end-to-end retention proof ────────────────────────────────────────────

  describe("resolution lets the retention purge terminate (F-026 ⇄ F-030)", () => {
    it("retains a flagged body while open, and purges it after disposal", async () => {
      const { messageId, inboxEventId } = await inboundMessage({
        body: "evidence under review",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });

      // While OPEN: the body is expired but exempt. This is the state that, before F-030,
      // no code path could ever leave.
      const whileOpen = await purgeExpiredBodies(database(), { now: PURGE_AT });
      expect(whileOpen.messageBodiesPurged).toBe(0);
      expect(whileOpen.exempted).toBe(1);
      expect(await bodyOf(messageId)).toBe("evidence under review");

      // The operator acts. Nothing else changes.
      const disposed = await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "reviewed_no_action",
        occurredAt: at(4 * HOUR),
      });
      expect(disposed.status).toBe("disposed");

      // After DISPOSAL: the very next purge clears it. End to end, through the real purge.
      const afterDisposal = await purgeExpiredBodies(database(), { now: PURGE_AT });
      expect(afterDisposal.messageBodiesPurged).toBe(1);
      expect(afterDisposal.exempted).toBe(0);
      expect(await bodyOf(messageId)).toBeNull();

      // The flag itself survives its thread's body — the audit record is the point.
      const flags = await client()`select status from flags where id = ${flagId}`;
      expect(flags[0]?.status).toBe("resolved");
    });

    it("dismissal terminates the exemption too, not only resolution", async () => {
      // The exemption predicate is `status = 'open'`. A drift to `<> 'resolved'` would keep
      // a DISMISSED thread exempt forever and pass every resolution-only test — the exact
      // predicate-drift defect this project has already been bitten by once.
      const { messageId, inboxEventId } = await inboundMessage({
        body: "dismissed thread",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });

      await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "dismissed",
        dispositionCode: "not_a_concern",
        occurredAt: at(4 * HOUR),
      });

      // The DECISION the operator made is what got recorded. Asserting only that the purge
      // ran would pass even if dismissal silently wrote `resolved` — an operator's recorded
      // decision differing from the one they made is its own defect, independent of retention.
      const flagRows = await client()`select status from flags where id = ${flagId}`;
      expect(flagRows[0]?.status).toBe("dismissed");

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });
      expect(result.messageBodiesPurged).toBe(1);
      expect(await bodyOf(messageId)).toBeNull();
    });

    it("records resolution as resolution, not as some other disposition", async () => {
      // The mirror of the assertion above, so neither disposition can be written as the other.
      const { inboxEventId } = await inboundMessage({
        body: "resolved thread",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });

      await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "handled",
        occurredAt: at(4 * HOUR),
      });

      const rows = await client()`select status from flags where id = ${flagId}`;
      expect(rows[0]?.status).toBe("resolved");
    });

    it("keeps a thread exempt while ANY flag on it is still open", async () => {
      const { messageId, inboxEventId } = await inboundMessage({
        body: "two flags, one open",
        expiresAt: EXPIRES_EARLY,
      });
      const resolvedFlag = await openFlag({ inboxEventId });
      await openFlag({ inboxEventId });

      await disposeFlag(database(), {
        flagId: resolvedFlag,
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "handled",
        occurredAt: at(4 * HOUR),
      });

      const result = await purgeExpiredBodies(database(), { now: PURGE_AT });
      expect(result.messageBodiesPurged).toBe(0);
      expect(await bodyOf(messageId)).toBe("two flags, one open");
    });
  });

  // ── The thread viewer ─────────────────────────────────────────────────────────

  describe("readFlaggedThread", () => {
    it("shows the retained context of the flagged thread with the sender masked", async () => {
      const first = await inboundMessage({
        body: "first message in the thread",
        expiresAt: EXPIRES_EARLY,
        receivedAt: at(1),
      });
      await inboundMessage({
        body: "second message in the thread",
        expiresAt: EXPIRES_EARLY,
        receivedAt: at(2),
      });
      const flagId = await openFlag({ inboxEventId: first.inboxEventId });

      const thread = await readFlaggedThread(database(), { flagId });

      expect(thread).not.toBeNull();
      expect(thread?.senderMask).toBe("(•••) •••-0701");
      expect(thread?.messages.map((m) => m.body)).toEqual([
        "first message in the thread",
        "second message in the thread",
      ]);
      // The flagged message is marked, so an operator knows which one triggered review.
      expect(thread?.messages.filter((m) => m.isFlagged)).toHaveLength(1);
    });

    it("carries no raw phone number and no hash anywhere in the thread", async () => {
      const { inboxEventId } = await inboundMessage({
        body: "call me at +12065550999 please",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });

      const thread = await readFlaggedThread(database(), { flagId });
      const serialized = JSON.stringify(thread);

      // The thread's own identifiers carry no phone material: no sender hash, no E.164.
      expect(serialized).not.toMatch(/[0-9a-f]{64}/);
      expect(serialized).not.toContain("+12065550701");

      // What the SENDER voluntarily typed is shown verbatim — this is the retained context
      // the operator is reviewing, and redacting the thing under review would defeat the
      // rail. Farm Friend does not claim a general detector for text a sender chose to send
      // (CLAUDE.md Golden Rule #6); the guarantee is about OUR identifiers, not their prose.
      expect(thread?.messages[0]?.body).toBe("call me at +12065550999 please");
    });

    it("shows another sender's messages never — only the flagged thread's", async () => {
      const flagged = await inboundMessage({
        body: "the flagged thread",
        expiresAt: EXPIRES_EARLY,
      });
      await inboundMessage({
        body: "an unrelated person's message",
        expiresAt: EXPIRES_EARLY,
        sender: otherSenderHash,
      });
      const flagId = await openFlag({ inboxEventId: flagged.inboxEventId });

      const thread = await readFlaggedThread(database(), { flagId });
      expect(thread?.messages.map((m) => m.body)).toEqual(["the flagged thread"]);
    });

    it("reports an already-purged body honestly instead of pretending it is empty", async () => {
      const { messageId, inboxEventId } = await inboundMessage({
        body: "will be purged",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });
      await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "handled",
        occurredAt: at(4 * HOUR),
      });
      await purgeExpiredBodies(database(), { now: PURGE_AT });
      expect(await bodyOf(messageId)).toBeNull();

      const thread = await readFlaggedThread(database(), { flagId });
      // The message still existed; its content is gone. An operator must be able to tell
      // "this thread had a message whose body has been deleted" from "this was blank."
      expect(thread?.messages).toHaveLength(1);
      expect(thread?.messages[0]?.body).toBeNull();
      expect(thread?.messages[0]?.bodyPurged).toBe(true);
    });

    it("returns null for a flag that does not exist", async () => {
      expect(await readFlaggedThread(database(), { flagId: randomUUID() })).toBeNull();
    });
  });

  // ── Stock-out reports ─────────────────────────────────────────────────────────

  describe("listStockOutReports", () => {
    /** A customer report, the way `recordStockOutReport` writes one. */
    async function report(input: {
      unlistedItemText?: string;
      entryId?: string;
      reportedAt?: Date;
    }): Promise<string> {
      const rows = await client()`
        insert into stock_out_reports (
          sales_location_id, referenced_inventory_entry_id, unlisted_item_text,
          status, reported_at
        )
        values (
          ${id("location")}, ${input.entryId ?? null},
          ${input.entryId === undefined ? (input.unlistedItemText ?? "green beans") : null},
          'open', ${input.reportedAt ?? T0}
        )
        returning id
      `;
      return rows[0]?.id as string;
    }

    it("lists open reports with their farm and location, and no reporter identity at all", async () => {
      await report({ unlistedItemText: "green beans" });

      const reports = await listStockOutReports(database(), { status: "open" });

      expect(reports).toHaveLength(1);
      expect(reports[0]?.farmName).toBe("Provo Farms");
      expect(reports[0]?.salesLocationName).toBe("Provo Farms Stand");
      expect(reports[0]?.itemText).toBe("green beans");
      expect(reports[0]?.status).toBe("open");

      // A stock-out report stores NO reporter — there is no column for one, and the queue
      // must not acquire one by joining its way to a phone.
      const serialized = JSON.stringify(reports);
      expect(serialized).not.toMatch(/\+1\d{10}/);
      expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    });

    it("returns triaged reports only when asked", async () => {
      const open = await report({ unlistedItemText: "still open" });
      const triaged = await report({ unlistedItemText: "already handled" });
      await triageStockOutReport(database(), {
        reportId: triaged,
        administratorId: id("administrator"),
        status: "reviewed",
        occurredAt: at(2 * HOUR),
      });

      const openOnly = await listStockOutReports(database(), { status: "open" });
      expect(openOnly.map((r) => r.reportId)).toEqual([open]);
      expect(await listStockOutReports(database(), { status: "all" })).toHaveLength(2);
    });

    it("names the item a report referenced when it pointed at a published entry", async () => {
      // The report references an inventory entry rather than free text, so the queue has to
      // resolve the name through the entry — an operator reading "(entry 3f2a…)" learns
      // nothing actionable.
      const authorizations = await client()`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at
        )
        values (${id("farm")}, ${id(farmerHash)}, ${T0}, ${T0})
        returning id
      `;
      const approvals = await client()`
        insert into seller_approvals (seller_id, administrator_id, approved_at)
        values (${id("farm")}, ${id("administrator")}, ${T0})
        returning id
      `;
      // `inventory_publication_proposals_state_coherent` requires an `accepted` proposal to be
      // activated and consumed; this fixture only needs a revision to hang entries off, so it
      // uses `invalidated` — a legal closed state that needs no activation.
      const proposals = await client()`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, provider_id, payload, proposal_version,
          has_inventory, has_closure, state, base_is_first_publication, closed_at
        )
        values (
          ${farmerHash}, ${id("location")},
        (select id from stand_providers
          where sales_location_id = ${id("location")} and seller_id = (select own_seller_id from sales_locations where id = ${id("location")})), '{}'::jsonb, 1,
          true, false, 'invalidated', true, ${T0}
        )
        returning id
      `;
      const revisions = await client()`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
          farm_approval_id, source, published_at, is_current
        )
        values (
          ${id("farm")}, ${id("location")},
        (select id from stand_providers
          where sales_location_id = ${id("location")} and seller_id = (select own_seller_id from sales_locations where id = ${id("location")})), ${proposals[0]?.id as string},
          ${authorizations[0]?.id as string}, ${approvals[0]?.id as string}, 'sms', ${T0}, true
        )
        returning id
      `;
      const entries = await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        )
        values (${revisions[0]?.id as string}, ${id("location")}, 'bok choy', 0)
        returning id
      `;
      const reportId = await report({ entryId: entries[0]?.id as string });

      const reports = await listStockOutReports(database(), { status: "open" });
      expect(reports.map((r) => r.reportId)).toContain(reportId);
      expect(reports.find((r) => r.reportId === reportId)?.itemText).toBe("bok choy");
    });

    /*
      B-057 — a report may reference one of the stand's USUAL offerings instead. VIGA's queue
      has to resolve that name too: an operator reading a blank item learns nothing, and this
      is now the most common kind of report on the production corpus.
    */
    it("resolves the item name of a report against a usual offering", async () => {
      const items = await client()`
        insert into stand_items (sales_location_id, provider_id, display_name, usually_carried)
        values (${id("location")}, (select id from stand_providers where sales_location_id = ${id("location")} and seller_id = (select own_seller_id from sales_locations where id = ${id("location")})), 'Duck eggs', false)
        returning id
      `;
      const reports = await client()`
        insert into stock_out_reports (
          sales_location_id, referenced_stand_item_id, status, reported_at
        )
        values (${id("location")}, ${items[0]?.id as string}, 'open', ${T0})
        returning id
      `;
      const reportId = reports[0]?.id as string;

      const listed = await listStockOutReports(database(), { status: "open" });
      expect(listed.find((r) => r.reportId === reportId)?.itemText).toBe("Duck eggs");
    });
  });

  describe("triageStockOutReport", () => {
    async function openReport(): Promise<string> {
      const rows = await client()`
        insert into stock_out_reports (
          sales_location_id, unlisted_item_text, status, reported_at
        )
        values (${id("location")}, 'green beans', 'open', ${T0})
        returning id
      `;
      return rows[0]?.id as string;
    }

    it("records the status, the acting administrator, and the time", async () => {
      const reportId = await openReport();

      const result = await triageStockOutReport(database(), {
        reportId,
        administratorId: id("administrator"),
        status: "reviewed",
        occurredAt: at(2 * HOUR),
      });
      expect(result.status).toBe("triaged");

      const rows = await client()`
        select status, reviewed_by_administrator_id, reviewed_at
        from stock_out_reports where id = ${reportId}
      `;
      expect(rows[0]?.status).toBe("reviewed");
      expect(rows[0]?.reviewed_by_administrator_id).toBe(id("administrator"));
      expect(rows[0]?.reviewed_at).toEqual(at(2 * HOUR));
    });

    it("records a dismissal as a dismissal, not as reviewed", async () => {
      // Without this, writing a constant status would pass the `reviewed` test above and
      // never be caught — the operator's recorded decision must be the one they made.
      const reportId = await openReport();
      await triageStockOutReport(database(), {
        reportId,
        administratorId: id("administrator"),
        status: "dismissed",
        occurredAt: at(2 * HOUR),
      });

      const rows = await client()`
        select status from stock_out_reports where id = ${reportId}
      `;
      expect(rows[0]?.status).toBe("dismissed");
    });

    it("writes the audit event in the same commit", async () => {
      const reportId = await openReport();
      await triageStockOutReport(database(), {
        reportId,
        administratorId: id("administrator"),
        status: "dismissed",
        occurredAt: at(2 * HOUR),
      });

      const audits = await client()`
        select action, actor_administrator_id, subject_type
        from audit_events where subject_id = ${reportId}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe("stock_out_report_dismissed");
      expect(audits[0]?.subject_type).toBe("stock_out_report");
      expect(audits[0]?.actor_administrator_id).toBe(id("administrator"));
    });

    it("refuses a revoked administrator", async () => {
      const reportId = await openReport();
      await client()`
        update administrators set revoked_at = ${at(1)} where id = ${id("administrator")}
      `;

      const result = await triageStockOutReport(database(), {
        reportId,
        administratorId: id("administrator"),
        status: "reviewed",
        occurredAt: at(2 * HOUR),
      });

      expect(result.status).toBe("not_an_administrator");
      const rows = await client()`
        select status from stock_out_reports where id = ${reportId}
      `;
      expect(rows[0]?.status).toBe("open");
    });

    it("triages exactly once", async () => {
      const reportId = await openReport();
      const first = await triageStockOutReport(database(), {
        reportId,
        administratorId: id("administrator"),
        status: "reviewed",
        occurredAt: at(2 * HOUR),
      });
      const second = await triageStockOutReport(database(), {
        reportId,
        administratorId: id("administrator"),
        status: "dismissed",
        occurredAt: at(3 * HOUR),
      });

      expect(first.status).toBe("triaged");
      expect(second.status).toBe("already_triaged");
      const rows = await client()`
        select status from stock_out_reports where id = ${reportId}
      `;
      expect(rows[0]?.status).toBe("reviewed");
    });
  });

  // ── Golden Rule #1 ────────────────────────────────────────────────────────────

  describe("no triage action mutates published state (Golden Rule #1)", () => {
    /**
     * A complete published snapshot: the revision, its entries, and the approval it was
     * published under. This is everything a customer's answer, the map, and ranking read.
     */
    async function publishedState(): Promise<string> {
      const rows = await client()`
        select
          coalesce((
            select json_agg(json_build_object(
              'id', r.id, 'farm', r.seller_id, 'location', r.sales_location_id,
              'current', r.is_current, 'published', r.published_at,
              'superseded', r.superseded_at, 'approval', r.farm_approval_id
            ) order by r.id)
            from inventory_revisions r
          ), '[]'::json)::text as revisions,
          coalesce((
            select json_agg(json_build_object(
              'id', e.id, 'revision', e.inventory_revision_id, 'item', e.item_name,
              'quantity', e.quantity, 'unit', e.unit, 'price', e.price_text,
              'approximation', e.approximation, 'sort', e.sort_order
            ) order by e.id)
            from inventory_entries e
          ), '[]'::json)::text as entries,
          coalesce((
            select json_agg(json_build_object(
              'id', a.id, 'farm', a.seller_id, 'approved', a.approved_at,
              'revoked', a.revoked_at
            ) order by a.id)
            from seller_approvals a
          ), '[]'::json)::text as approvals
      `;
      return JSON.stringify(rows[0]);
    }

    it("leaves every published record byte-identical across flag disposal and report triage", async () => {
      // Build real published inventory, so the assertion is over state that actually exists.
      // A snapshot of nothing is trivially unchanged and would prove nothing.
      const authorizations = await client()`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at
        )
        values (${id("farm")}, ${id(farmerHash)}, ${T0}, ${T0})
        returning id
      `;
      const approvals = await client()`
        insert into seller_approvals (seller_id, administrator_id, approved_at)
        values (${id("farm")}, ${id("administrator")}, ${T0})
        returning id
      `;
      const proposals = await client()`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, provider_id, payload, proposal_version,
          has_inventory, has_closure, state, base_is_first_publication, closed_at
        )
        values (
          ${farmerHash}, ${id("location")},
        (select id from stand_providers
          where sales_location_id = ${id("location")} and seller_id = (select own_seller_id from sales_locations where id = ${id("location")})), '{}'::jsonb, 1,
          true, false, 'invalidated', true, ${T0}
        )
        returning id
      `;
      const revisions = await client()`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
          farm_approval_id, source, published_at, is_current
        )
        values (
          ${id("farm")}, ${id("location")},
        (select id from stand_providers
          where sales_location_id = ${id("location")} and seller_id = (select own_seller_id from sales_locations where id = ${id("location")})), ${proposals[0]?.id as string},
          ${authorizations[0]?.id as string}, ${approvals[0]?.id as string}, 'sms', ${T0}, true
        )
        returning id
      `;
      await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, quantity, unit, sort_order
        )
        values
          (${revisions[0]?.id as string}, ${id("location")}, 'bok choy', 12, 'bunches', 0),
          (${revisions[0]?.id as string}, ${id("location")}, 'green beans', 4, 'lbs', 1)
      `;

      const before = await publishedState();
      expect(before).toContain("bok choy");

      // Now every operator action F-030 introduces, against that published state.
      const { inboxEventId } = await inboundMessage({
        body: "flag this",
        expiresAt: EXPIRES_EARLY,
      });
      const flagId = await openFlag({ inboxEventId });
      await disposeFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        disposition: "resolved",
        dispositionCode: "handled",
        occurredAt: at(4 * HOUR),
      });

      const reports = await client()`
        insert into stock_out_reports (
          sales_location_id, unlisted_item_text, status, reported_at
        )
        values (${id("location")}, 'green beans', 'open', ${T0})
        returning id
      `;
      await triageStockOutReport(database(), {
        reportId: reports[0]?.id as string,
        administratorId: id("administrator"),
        status: "reviewed",
        occurredAt: at(4 * HOUR),
      });

      // Reads must not mutate either.
      await listFlagsForReview(database(), { status: "all" });
      await listStockOutReports(database(), { status: "all" });
      await readFlaggedThread(database(), { flagId });

      // Byte-identical: not "still one revision", but the same revisions, the same entries,
      // the same approval, unchanged in every field a public answer reads.
      expect(await publishedState()).toBe(before);
    });

    it("marking a report reviewed does not touch the entry it referenced", async () => {
      // The temptation this forecloses: "the customer said it is out, so remove the item."
      // Only the farmer's confirmed revision changes what a stand shows.
      const authorizations = await client()`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at
        )
        values (${id("farm")}, ${id(farmerHash)}, ${T0}, ${T0})
        returning id
      `;
      const approvals = await client()`
        insert into seller_approvals (seller_id, administrator_id, approved_at)
        values (${id("farm")}, ${id("administrator")}, ${T0})
        returning id
      `;
      const proposals = await client()`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, provider_id, payload, proposal_version,
          has_inventory, has_closure, state, base_is_first_publication, closed_at
        )
        values (
          ${farmerHash}, ${id("location")},
        (select id from stand_providers
          where sales_location_id = ${id("location")} and seller_id = (select own_seller_id from sales_locations where id = ${id("location")})), '{}'::jsonb, 1,
          true, false, 'invalidated', true, ${T0}
        )
        returning id
      `;
      const revisions = await client()`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
          farm_approval_id, source, published_at, is_current
        )
        values (
          ${id("farm")}, ${id("location")},
        (select id from stand_providers
          where sales_location_id = ${id("location")} and seller_id = (select own_seller_id from sales_locations where id = ${id("location")})), ${proposals[0]?.id as string},
          ${authorizations[0]?.id as string}, ${approvals[0]?.id as string}, 'sms', ${T0}, true
        )
        returning id
      `;
      const entries = await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, quantity, unit, sort_order
        )
        values (${revisions[0]?.id as string}, ${id("location")}, 'bok choy', 12, 'bunches', 0)
        returning id
      `;
      const entryId = entries[0]?.id as string;
      const reports = await client()`
        insert into stock_out_reports (
          sales_location_id, referenced_inventory_entry_id, status, reported_at
        )
        values (${id("location")}, ${entryId}, 'open', ${T0})
        returning id
      `;

      await triageStockOutReport(database(), {
        reportId: reports[0]?.id as string,
        administratorId: id("administrator"),
        status: "reviewed",
        occurredAt: at(4 * HOUR),
      });

      const after = await client()`
        select item_name, quantity, unit from inventory_entries where id = ${entryId}
      `;
      expect(after).toHaveLength(1);
      expect(after[0]?.item_name).toBe("bok choy");
      expect(after[0]?.quantity).toBe(12);

      const current = await client()`
        select is_current from inventory_revisions where id = ${revisions[0]?.id as string}
      `;
      expect(current[0]?.is_current).toBe(true);
    });
  });

  // ── Stand data flags (F-037) ──────────────────────────────────────────────────
  //
  // The seeder raises these when VIGA's export needs a human decision (contradictory hours,
  // an unresolvable season, a possible closure). Until this surface, the 3 real flags were
  // visible only by SQL. Same disciplines as the queues above: authority re-read inside the
  // writing transaction, the audit event in the same commit, disposal exactly once under a
  // row lock, and no path from resolution to anything a customer sees.

  describe("stand data flags (F-037)", () => {
    /** A flag the way the seeder writes one. */
    async function openStandDataFlag(input?: {
      reason?: string;
      sourceText?: string;
    }): Promise<string> {
      const rows = await client()`
        insert into stand_data_flags (sales_location_id, reason, source_text)
        values (
          ${id("location")},
          ${input?.reason ?? "contradictory_hours"},
          ${input?.sourceText ?? "Open: 9-5 | Open: dawn to dusk"}
        )
        returning id
      `;
      return rows[0]?.id as string;
    }

    it("lists an open flag with its stand, reason, and the text needing a decision", async () => {
      const flagId = await openStandDataFlag();

      const open = await listStandDataFlags(database(), { status: "open" });
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        flagId,
        standName: "Provo Farms Stand",
        reason: "contradictory_hours",
        sourceText: "Open: 9-5 | Open: dawn to dusk",
        resolutionNote: null,
        resolvedByEmail: null,
        resolvedAt: null,
      });
    });

    it("resolves exactly once, with the note and the audit event in the same commit", async () => {
      const flagId = await openStandDataFlag();

      const first = await resolveStandDataFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        resolutionNote: "confirmed with the farmer: dawn to dusk",
        occurredAt: at(2 * HOUR),
      });
      const second = await resolveStandDataFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        resolutionNote: "a second operator's decision",
        occurredAt: at(3 * HOUR),
      });

      expect(first.status).toBe("resolved");
      // The second decision is REFUSED, not silently overwritten: the first operator's
      // recorded decision is an audit fact.
      expect(second.status).toBe("already_resolved");

      const rows = await client()`
        select resolution_note, resolved_by_administrator_id, resolved_at
        from stand_data_flags where id = ${flagId}
      `;
      expect(rows[0]?.resolution_note).toBe("confirmed with the farmer: dawn to dusk");
      expect(rows[0]?.resolved_by_administrator_id).toBe(id("administrator"));
      expect(rows[0]?.resolved_at).not.toBeNull();

      const audits = await client()`
        select action, actor_administrator_id from audit_events
        where subject_id = ${flagId}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe("stand_data_flag_resolved");
      expect(audits[0]?.actor_administrator_id).toBe(id("administrator"));
    });

    it("a resolved flag leaves the open queue and stays visible under ?status=all", async () => {
      const flagId = await openStandDataFlag();
      await resolveStandDataFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        resolutionNote: "done",
        occurredAt: at(2 * HOUR),
      });

      expect(await listStandDataFlags(database(), { status: "open" })).toHaveLength(0);
      const all = await listStandDataFlags(database(), { status: "all" });
      expect(all).toHaveLength(1);
      expect(all[0]?.resolvedByEmail).toBe("board@vigavashon.org");
    });

    it("refuses an unknown flag and a revoked administrator", async () => {
      const unknown = await resolveStandDataFlag(database(), {
        flagId: randomUUID(),
        administratorId: id("administrator"),
        resolutionNote: "n/a",
        occurredAt: at(2 * HOUR),
      });
      expect(unknown.status).toBe("unknown_flag");

      const flagId = await openStandDataFlag();
      await client()`
        update administrators set revoked_at = ${at(HOUR)} where id = ${id("administrator")}
      `;
      const revoked = await resolveStandDataFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        resolutionNote: "should not land",
        occurredAt: at(2 * HOUR),
      });
      expect(revoked.status).toBe("not_an_administrator");
      const rows = await client()`
        select resolved_at from stand_data_flags where id = ${flagId}
      `;
      expect(rows[0]?.resolved_at).toBeNull();
    });

    it("queues every concurrent resolution behind the one authority lock so exactly one wins", async () => {
      const flagId = await openStandDataFlag();

      // One administrator is the final product architecture. Hold that authority row on a
      // separate connection until all eight independent request handles are visibly waiting
      // on a Postgres lock; Promise.all alone would not manufacture contention.
      const blocker = postgres(testUrl, { max: 1 });
      const handles = Array.from({ length: 8 }, () => createDb(testUrl));
      let attempts: Array<Promise<Awaited<ReturnType<typeof resolveStandDataFlag>>>> = [];
      await blocker.begin(async (tx) => {
        await tx`
          select id from administrators where id = ${id("administrator")} for update
        `;
        attempts = handles.map((handle, index) =>
          resolveStandDataFlag(handle, {
            flagId,
            administratorId: id("administrator"),
            resolutionNote: `claimant-${index}`,
            occurredAt: at(3 * HOUR),
          }),
        );
        let waitingCount = 0;
        for (let tries = 0; tries < 20 && waitingCount < 8; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const waiting = await client()`
            select count(*)::integer as count from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
          `;
          waitingCount = waiting[0]?.count as number;
        }
        expect(waitingCount).toBeGreaterThanOrEqual(8);
      });
      const results = await Promise.all(attempts);
      await Promise.all(handles.map((handle) => handle.close()));
      await blocker.end({ timeout: 5 });

      expect(results.filter((a) => a.status === "resolved")).toHaveLength(1);
      expect(results.filter((a) => a.status === "already_resolved")).toHaveLength(7);
      const audits = await client()`
        select count(*)::integer as count from audit_events where subject_id = ${flagId}
      `;
      expect(audits[0]?.count).toBe(1);
    });

    it("leaves the LISTING byte-identical across resolution — availability included", async () => {
      // The stand-data snapshot is wider than the published-inventory one above, because a
      // stand-data flag is ABOUT the listing's availability columns: the temptation is
      // "resolve the contradiction by fixing the hours while I'm here", and this pins that
      // resolution records a decision without touching what any customer sees.
      async function listingState(): Promise<string> {
        const rows = await client()`
          select
            coalesce((
              select json_agg(json_build_object(
                'id', l.id, 'name', l.name, 'address', l.public_address,
                'hours', l.hours_text, 'seasonKind', l.season_kind,
                'openKind', l.open_hours_kind, 'from', l.open_from_minutes,
                'until', l.open_until_minutes, 'cadence', l.stocking_cadence,
                'days', l.stocking_days, 'public', l.is_public
              ) order by l.id)
              from sales_locations l
            ), '[]'::json)::text as locations,
            coalesce((
              select json_agg(json_build_object(
                'location', o.sales_location_id, 'item', o.display_name, 'sort', o.sort_order
              ) order by o.sales_location_id, o.display_name)
              from stand_items o
            ), '[]'::json)::text as offerings,
            coalesce((
              select json_agg(json_build_object('id', r.id, 'current', r.is_current)
                order by r.id)
              from inventory_revisions r
            ), '[]'::json)::text as revisions
        `;
        return JSON.stringify(rows[0]);
      }

      await client()`
        insert into stand_items (sales_location_id, provider_id, display_name, usually_carried, sort_order)
        values (${id("location")}, (select id from stand_providers where sales_location_id = ${id("location")} and seller_id = (select own_seller_id from sales_locations where id = ${id("location")})), 'bok choy', true, 0), (${id("location")}, (select id from stand_providers where sales_location_id = ${id("location")} and seller_id = (select own_seller_id from sales_locations where id = ${id("location")})), 'eggs', true, 1)
      `;
      const flagId = await openStandDataFlag();

      const before = await listingState();
      expect(before).toContain("bok choy");

      await resolveStandDataFlag(database(), {
        flagId,
        administratorId: id("administrator"),
        resolutionNote: "hours confirmed; no listing change",
        occurredAt: at(2 * HOUR),
      });

      expect(await listingState()).toBe(before);
    });
  });
});
