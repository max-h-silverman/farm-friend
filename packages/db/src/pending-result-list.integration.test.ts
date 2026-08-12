import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  savePendingResultList,
  takeNextResultPage,
  createDb,
  type Db,
  type Sql,
} from "./index";

// F-046 part 3 — the durable half of SMS result paging, against real Postgres.
//
// The claims this file makes falsifiable, none of which a unit test with a stubbed driver
// could make: that a new question REPLACES the sender's list rather than adding a second one
// (the unique index is the arbiter, not a read-then-write in application code); that an
// expired list is indistinguishable from no list at all; and that advancing the offset is a
// single locked transaction, so two simultaneous MOREs cannot both be handed the same page.
//
// Fixture instants are OFFSETS from a clock-derived anchor, never calendar literals (B-003).

const migrationsDir = resolve(process.cwd(), "packages/db", "drizzle");
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

describe("the pending result list MORE pages through (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;

  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const at = (minutes: number) => new Date(anchor + minutes * 60_000);
  const sql = () => client as Sql;
  const database = () => db as Db;

  /** A sender hash shaped like the real thing: 64 hex characters. */
  let senderCounter = 0;
  function sender(): string {
    senderCounter += 1;
    return senderCounter.toString(16).padStart(64, "0");
  }

  const nine = Array.from({ length: 9 }, (_, i) => `fact-${i}`);

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_paging_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await sql()`truncate table pending_result_lists`;
  });

  describe("saving what a paged answer leaves behind", () => {
    it("stores the ordered fact ids and how far the first page read", async () => {
      const senderHash = sender();
      await savePendingResultList(database(), {
        senderHash,
        factIds: nine,
        itemsRequested: ["eggs"],
        broad: false,
        shown: 3,
        standTotal: nine.length,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });

      const rows = await sql()`
        select fact_ids, items_requested, "offset", expires_at
        from pending_result_lists where sender_hash = ${senderHash}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.fact_ids).toEqual(nine);
      expect(rows[0]?.items_requested).toEqual(["eggs"]);
      expect(rows[0]?.offset).toBe(3);
      // The TTL is computed from the message's own time, never from `now()` in the database:
      // a pass replaying a delayed event must not silently extend the window.
      expect((rows[0]?.expires_at as Date).getTime()).toBe(at(60).getTime());
    });

    it("REPLACES the sender's previous list rather than accumulating a second", async () => {
      // Case 7. One pending list per sender is what makes MORE unambiguous, and the unique
      // index is the arbiter — not a read-then-write, which two concurrent questions could
      // both pass.
      const senderHash = sender();
      await savePendingResultList(database(), {
        senderHash,
        factIds: nine,
        itemsRequested: ["eggs"],
        broad: false,
        shown: 3,
        standTotal: nine.length,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });
      await savePendingResultList(database(), {
        senderHash,
        factIds: ["lamb-a", "lamb-b", "lamb-c", "lamb-d"],
        itemsRequested: ["lamb"],
        broad: false,
        shown: 3,
        standTotal: 4,
        standsShown: 3,
        occurredAt: at(10),
        ttlMinutes: 60,
      });

      const rows = await sql()`
        select fact_ids, items_requested, "offset"
        from pending_result_lists where sender_hash = ${senderHash}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.items_requested).toEqual(["lamb"]);
      expect(rows[0]?.offset).toBe(3);
      // The old list is GONE, not merely outranked: a stale fact id must not survive to be
      // rendered on a later page of a different question.
      expect(rows[0]?.fact_ids).not.toContain("fact-4");
    });

    it("keeps two senders' lists independent", async () => {
      const one = sender();
      const two = sender();
      await savePendingResultList(database(), {
        senderHash: one,
        factIds: nine,
        itemsRequested: ["eggs"],
        broad: false,
        shown: 3,
        standTotal: nine.length,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });
      await savePendingResultList(database(), {
        senderHash: two,
        factIds: ["lamb-a", "lamb-b", "lamb-c", "lamb-d"],
        itemsRequested: ["lamb"],
        broad: false,
        shown: 3,
        standTotal: 4,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });

      const first = await takeNextResultPage(database(), {
        senderHash: one,
        occurredAt: at(1),
        pageSize: 3,
      });
      expect(first?.itemsRequested).toEqual(["eggs"]);
      const second = await takeNextResultPage(database(), {
        senderHash: two,
        occurredAt: at(1),
        pageSize: 3,
      });
      expect(second?.factIds).toEqual(["lamb-d"]);
    });
  });

  describe("taking the next page", () => {
    it("returns the next slice and advances the offset", async () => {
      const senderHash = sender();
      await savePendingResultList(database(), {
        senderHash,
        factIds: nine,
        itemsRequested: ["eggs"],
        broad: false,
        shown: 3,
        standTotal: nine.length,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });

      const page = await takeNextResultPage(database(), {
        senderHash,
        occurredAt: at(1),
        pageSize: 3,
      });
      expect(page).not.toBeNull();
      expect(page?.factIds).toEqual(["fact-3", "fact-4", "fact-5"]);
      expect(page?.offset).toBe(3);
      expect(page?.total).toBe(9);
      expect(page?.itemsRequested).toEqual(["eggs"]);

      const rows = await sql()`
        select "offset" from pending_result_lists where sender_hash = ${senderHash}
      `;
      expect(rows[0]?.offset).toBe(6);
    });

    it("walks a list to exhaustion and then has nothing left to give", async () => {
      const senderHash = sender();
      await savePendingResultList(database(), {
        senderHash,
        factIds: nine,
        itemsRequested: ["eggs"],
        broad: false,
        shown: 3,
        standTotal: nine.length,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });

      const second = await takeNextResultPage(database(), {
        senderHash,
        occurredAt: at(1),
        pageSize: 3,
      });
      expect(second?.factIds).toEqual(["fact-3", "fact-4", "fact-5"]);
      const third = await takeNextResultPage(database(), {
        senderHash,
        occurredAt: at(2),
        pageSize: 3,
      });
      expect(third?.factIds).toEqual(["fact-6", "fact-7", "fact-8"]);
      expect(third?.offset).toBe(6);

      // Exhausted. The row is deleted rather than left at a terminal offset, so an exhausted
      // list and a list that never existed are the same thing to the layer above — one honest
      // reply, not two.
      const fourth = await takeNextResultPage(database(), {
        senderHash,
        occurredAt: at(3),
        pageSize: 3,
      });
      expect(fourth).toBeNull();
      const rows = await sql()`
        select id from pending_result_lists where sender_hash = ${senderHash}
      `;
      expect(rows).toHaveLength(0);
    });

    it("returns a short final page rather than padding it", async () => {
      const senderHash = sender();
      await savePendingResultList(database(), {
        senderHash,
        factIds: ["a", "b", "c", "d"],
        itemsRequested: ["lamb"],
        broad: false,
        shown: 3,
        standTotal: 4,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });
      const page = await takeNextResultPage(database(), {
        senderHash,
        occurredAt: at(1),
        pageSize: 3,
      });
      expect(page?.factIds).toEqual(["d"]);
      expect(page?.total).toBe(4);
    });

    it("returns null for a sender who has no list at all", async () => {
      // Case 6 at the data layer: MORE with nothing pending resolves to nothing, and the
      // caller renders the honest reply.
      const page = await takeNextResultPage(database(), {
        senderHash: sender(),
        occurredAt: at(1),
        pageSize: 3,
      });
      expect(page).toBeNull();
    });
  });

  describe("expiry", () => {
    it("refuses a list that has expired and clears it away", async () => {
      // Case 8. Stale paging is worse than none: the answer may have changed, and a customer
      // has no way to tell a fresh page from an hour-old replay.
      const senderHash = sender();
      await savePendingResultList(database(), {
        senderHash,
        factIds: nine,
        itemsRequested: ["eggs"],
        broad: false,
        shown: 3,
        standTotal: nine.length,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });

      const page = await takeNextResultPage(database(), {
        senderHash,
        // One minute past expiry.
        occurredAt: at(61),
        pageSize: 3,
      });
      expect(page).toBeNull();
      const rows = await sql()`
        select id from pending_result_lists where sender_hash = ${senderHash}
      `;
      expect(rows).toHaveLength(0);
    });

    it("still serves a list one minute before it expires", async () => {
      // The complement, so the test above is not passing because expiry refuses everything.
      const senderHash = sender();
      await savePendingResultList(database(), {
        senderHash,
        factIds: nine,
        itemsRequested: ["eggs"],
        broad: false,
        shown: 3,
        standTotal: nine.length,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });
      const page = await takeNextResultPage(database(), {
        senderHash,
        occurredAt: at(59),
        pageSize: 3,
      });
      expect(page?.factIds).toEqual(["fact-3", "fact-4", "fact-5"]);
    });

    it("expires against the MESSAGE's time, not the database's clock", async () => {
      // The fixture anchor is a day in the past, so a list saved with a 60-minute TTL is long
      // expired by `now()`. It must still serve a page for a message that arrived inside the
      // window — otherwise a delayed pass would refuse a page the customer asked for in time.
      const senderHash = sender();
      await savePendingResultList(database(), {
        senderHash,
        factIds: nine,
        itemsRequested: ["eggs"],
        broad: false,
        shown: 3,
        standTotal: nine.length,
        standsShown: 3,
        occurredAt: at(0),
        ttlMinutes: 60,
      });
      const page = await takeNextResultPage(database(), {
        senderHash,
        occurredAt: at(5),
        pageSize: 3,
      });
      expect(page).not.toBeNull();
    });
  });

  describe("two MOREs arriving at once", () => {
    it("never hands the same page to both", async () => {
      // The offset is advanced inside the same locked transaction that reads it. A read
      // followed by a separate update would let two claimants both see offset 0 and both be
      // served stands 1-3, which reads to a customer as MORE doing nothing.
      //
      // **`Promise.all` alone does NOT race these** — measured, not assumed. Each claim runs
      // ~50ms and the driver's pool schedules them far enough apart that every transaction
      // commits before the next one reads, so the suite passed with `for update` deleted.
      //
      // So contention is MANUFACTURED: a separate connection takes the row's lock first and
      // holds it while every claimant queues behind it. When it releases, all of them are
      // already inside `takeNextResultPage` and resume together against the same row —
      // which is the situation the lock exists for. Verified by sabotage: without
      // `for update` three claimants read offset 0 simultaneously and this fails.
      const senderHash = sender();
      await savePendingResultList(database(), {
        senderHash,
        factIds: nine,
        itemsRequested: ["eggs"],
        broad: false,
        shown: 0,
        standTotal: nine.length,
        standsShown: 0,
        occurredAt: at(0),
        ttlMinutes: 60,
      });

      const claimants = 6;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        acquired = resolve;
      });

      // A blocker on its OWN connection — the claimants use the pooled `Db`, so a shared one
      // would exhaust the pool rather than contend on the row.
      const blocker = postgres(
        testDatabaseUrl(requiredDatabaseUrl(), testDatabaseName as string),
        { max: 1 },
      );
      const blocking = blocker.begin(async (tx) => {
        await tx`
          select id from pending_result_lists
          where sender_hash = ${senderHash}
          for update
        `;
        acquired();
        await held;
      });

      // Wait for the lock to actually be HELD before launching anyone. Without this the
      // claimants win the race to the row and finish before the blocker arrives — measured:
      // every claim completed within 4ms, so nothing ever contended and the test passed with
      // `for update` deleted.
      await lockHeld;

      const pages = Promise.all(
        Array.from({ length: claimants }, () =>
          takeNextResultPage(database(), {
            senderHash,
            occurredAt: at(1),
            pageSize: 3,
          }),
        ),
      );
      // Long enough for every claimant to reach the row and block on the held lock.
      await new Promise((resolve) => setTimeout(resolve, 250));
      release();
      await blocking;
      await blocker.end({ timeout: 5 });

      const served = (await pages).filter((page) => page !== null);
      // Nine facts at three per page is exactly three pages; the other three claimants find
      // the list exhausted.
      expect(served).toHaveLength(3);
      const offsets = served.map((page) => page!.offset).sort((a, b) => a - b);
      expect(offsets).toEqual([0, 3, 6]);
      const allFacts = served.flatMap((page) => page!.factIds);
      expect(new Set(allFacts).size).toBe(9);
    });
  });
});
