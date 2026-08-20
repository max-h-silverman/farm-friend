import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingStockOutReport,
  readPendingStockOutReport,
  savePendingStockOutReport,
  createDb,
  type Db,
  type Sql,
} from "./index";

// B-065 — the durable half of "Farm Friend asked a question and listens for the answer".
//
// The claims this file makes falsifiable, none of which a stubbed driver could make: that a
// second unfinished report REPLACES the first (the unique index is the arbiter, not a
// read-then-write); that an expired context is indistinguishable from none; that the two
// `awaiting` arms cannot be stored in an incoherent shape; and that the expiry is judged by
// the MESSAGE's clock rather than the database's.
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

describe("the pending stock-out report a clarification leaves behind (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;

  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const at = (minutes: number) => new Date(anchor + minutes * 60_000);
  const sql = () => client as Sql;
  const database = () => db as Db;

  let senderCounter = 0;
  function sender(): string {
    senderCounter += 1;
    return senderCounter.toString(16).padStart(64, "0");
  }

  let locationId: string;

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_pending_stockout_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url);

    const sellers = await sql()`
      insert into sellers (name) values ('Alpha Farm') returning id
    `;
    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude
      ) values (
        ${sellers[0]?.id as string}, 'farm_stand', 'Alpha Stand',
        'America/Los_Angeles', 'visitable', 'produce', '1 Road', 47.44, -122.46
      )
      returning id
    `;
    locationId = locations[0]?.id as string;
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
    await sql()`truncate table pending_stock_out_reports`;
  });

  describe("saving the question we asked", () => {
    it("stores the original report text against the sender, awaiting a stand", async () => {
      const senderHash = sender();
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "Pinecome is out of eggs",
        awaiting: "stand",
        occurredAt: at(0),
        ttlMinutes: 15,
      });

      const rows = await sql()`
        select report_text, awaiting, sales_location_id, expires_at
        from pending_stock_out_reports where sender_hash = ${senderHash}
      `;
      expect(rows).toHaveLength(1);
      // The ITEM lives in this text. Losing it is the whole defect B-065 filed.
      expect(rows[0]?.report_text).toBe("Pinecome is out of eggs");
      expect(rows[0]?.awaiting).toBe("stand");
      expect(rows[0]?.sales_location_id).toBeNull();
      // Computed from the MESSAGE's time, never `now()`: a replayed delayed event must not
      // silently extend the window.
      expect((rows[0]?.expires_at as Date).getTime()).toBe(at(15).getTime());
    });

    it("stores the bound stand when the ITEM is what is missing", async () => {
      const senderHash = sender();
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "something is out at Alpha Stand",
        awaiting: "item",
        salesLocationId: locationId,
        occurredAt: at(0),
        ttlMinutes: 15,
      });

      const rows = await sql()`
        select awaiting, sales_location_id from pending_stock_out_reports
        where sender_hash = ${senderHash}
      `;
      expect(rows[0]?.awaiting).toBe("item");
      expect(rows[0]?.sales_location_id).toBe(locationId);
    });

    it("REPLACES the sender's previous pending report rather than accumulating", async () => {
      // One open clarification per sender. The unique index is the arbiter, not a
      // read-then-write, which two messages arriving together could both pass.
      const senderHash = sender();
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "Pinecome is out of eggs",
        awaiting: "stand",
        occurredAt: at(0),
        ttlMinutes: 15,
      });
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "Bart's is out of plums",
        awaiting: "stand",
        occurredAt: at(1),
        ttlMinutes: 15,
      });

      const rows = await sql()`
        select report_text from pending_stock_out_reports where sender_hash = ${senderHash}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.report_text).toBe("Bart's is out of plums");
    });

    it("switches a sender from awaiting a stand to awaiting an item, clearing the stand", async () => {
      // The replace path must move BOTH columns together, or a stale sales_location_id
      // survives under `awaiting = 'stand'` and violates the shape the CHECK enforces.
      const senderHash = sender();
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "something is out at Alpha Stand",
        awaiting: "item",
        salesLocationId: locationId,
        occurredAt: at(0),
        ttlMinutes: 15,
      });
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "Pinecome is out of eggs",
        awaiting: "stand",
        occurredAt: at(1),
        ttlMinutes: 15,
      });

      const rows = await sql()`
        select awaiting, sales_location_id from pending_stock_out_reports
        where sender_hash = ${senderHash}
      `;
      expect(rows[0]?.awaiting).toBe("stand");
      expect(rows[0]?.sales_location_id).toBeNull();
    });
  });

  describe("the database refuses an incoherent row", () => {
    it("refuses awaiting an item with no stand bound", async () => {
      await expect(
        sql()`
          insert into pending_stock_out_reports
            (sender_hash, report_text, awaiting, created_at, expires_at)
          values (${sender()}, 'text', 'item', ${at(0)}, ${at(15)})
        `,
      ).rejects.toThrow(/awaiting_shape/);
    });

    it("refuses awaiting a stand while one is already bound", async () => {
      await expect(
        sql()`
          insert into pending_stock_out_reports
            (sender_hash, report_text, awaiting, sales_location_id, created_at, expires_at)
          values (${sender()}, 'text', 'stand', ${locationId}, ${at(0)}, ${at(15)})
        `,
      ).rejects.toThrow(/awaiting_shape/);
    });

    it("refuses a report text that is only whitespace", async () => {
      // Not merely ''. `btrim` with no argument strips spaces only, so a tab-and-newline
      // body is what actually slips through a careless guard — the `stand_items` trap.
      // `created_at` is passed explicitly: it defaults to `now()`, and the anchor is a day in
      // the past, so an implicit default would trip `expires_after_creation` first and this
      // test would pass on the wrong constraint.
      for (const blank of ["", "   ", "\t\n", " \r\n "]) {
        await expect(
          sql()`
            insert into pending_stock_out_reports
              (sender_hash, report_text, awaiting, created_at, expires_at)
            values (${sender()}, ${blank}, 'stand', ${at(0)}, ${at(15)})
          `,
        ).rejects.toThrow(/report_text_not_blank/);
      }
    });

    it("refuses a row that expires at or before it was created", async () => {
      await expect(
        sql()`
          insert into pending_stock_out_reports
            (sender_hash, report_text, awaiting, created_at, expires_at)
          values (${sender()}, 'text', 'stand', ${at(10)}, ${at(10)})
        `,
      ).rejects.toThrow(/expires_after_creation/);
    });
  });

  describe("reading it back", () => {
    it("returns the pending report inside its window", async () => {
      const senderHash = sender();
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "Pinecome is out of eggs",
        awaiting: "stand",
        occurredAt: at(0),
        ttlMinutes: 15,
      });

      const pending = await readPendingStockOutReport(database(), {
        senderHash,
        occurredAt: at(14),
      });
      expect(pending?.reportText).toBe("Pinecome is out of eggs");
      expect(pending?.awaiting).toBe("stand");
    });

    it("treats an expired report as no report at all", async () => {
      const senderHash = sender();
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "Pinecome is out of eggs",
        awaiting: "stand",
        occurredAt: at(0),
        ttlMinutes: 15,
      });

      // Judged by the MESSAGE's clock. A reply arriving an hour later is a new conversation.
      expect(
        await readPendingStockOutReport(database(), {
          senderHash,
          occurredAt: at(16),
        }),
      ).toBeNull();
    });

    it("expires on the boundary rather than one message late", async () => {
      const senderHash = sender();
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "Pinecome is out of eggs",
        awaiting: "stand",
        occurredAt: at(0),
        ttlMinutes: 15,
      });
      expect(
        await readPendingStockOutReport(database(), {
          senderHash,
          occurredAt: at(15),
        }),
      ).toBeNull();
    });

    it("never returns another sender's pending report", async () => {
      await savePendingStockOutReport(database(), {
        senderHash: sender(),
        reportText: "Pinecome is out of eggs",
        awaiting: "stand",
        occurredAt: at(0),
        ttlMinutes: 15,
      });
      expect(
        await readPendingStockOutReport(database(), {
          senderHash: sender(),
          occurredAt: at(1),
        }),
      ).toBeNull();
    });
  });

  describe("clearing it", () => {
    it("removes the row so the next message is an ordinary one", async () => {
      const senderHash = sender();
      await savePendingStockOutReport(database(), {
        senderHash,
        reportText: "Pinecome is out of eggs",
        awaiting: "stand",
        occurredAt: at(0),
        ttlMinutes: 15,
      });
      await clearPendingStockOutReport(database(), { senderHash });

      expect(
        await readPendingStockOutReport(database(), {
          senderHash,
          occurredAt: at(1),
        }),
      ).toBeNull();
    });

    it("clears only the named sender", async () => {
      const kept = sender();
      const cleared = sender();
      for (const senderHash of [kept, cleared]) {
        await savePendingStockOutReport(database(), {
          senderHash,
          reportText: "Pinecome is out of eggs",
          awaiting: "stand",
          occurredAt: at(0),
          ttlMinutes: 15,
        });
      }
      await clearPendingStockOutReport(database(), { senderHash: cleared });

      expect(
        await readPendingStockOutReport(database(), { senderHash: kept, occurredAt: at(1) }),
      ).not.toBeNull();
    });
  });
});
