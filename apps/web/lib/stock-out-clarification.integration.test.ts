import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, type InventoryInterpreter } from "@farm-friend/core";
import type {
  RequestCategory,
  RequestClassificationModel,
  CatalogMatcher,
  StockOutModel,
} from "@farm-friend/ai";
import type { Db, Sql } from "@farm-friend/db";
import { handleFreeText, STOCK_OUT_STAND_QUESTION, STOCK_OUT_UNCLEAR_ITEM } from "./free-text";

/*
  B-065 — Farm Friend asks a question and listens for the answer.

  The transcript this file exists for, observed on a handset 2026-08-12:

      customer  "Pinecome is out of eggs"
      Farm Friend  "Thanks for letting us know. Which stand are you at?"
      customer  "Pinecone"
      Farm Friend  "Sorry, I did not catch which item or farm you meant."  ← the defect

  Every component behaved correctly in isolation. The report was classified right, the stand
  genuinely did not resolve ("pinecome" scores zero against "pinecone"), and a bare stand name
  really is a question by the classifier's own rules. What was missing was any memory that the
  question had been asked.

  These run against real Postgres because the pending row, its expiry and its unique index are
  the mechanism — a stubbed driver would be asserting the mock.
*/

const T0 = new Date(Date.now() - 60_000);
const minutesAfter = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("B-065 stock-out clarification memory (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let pineconeId = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_stockout_clarify_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: "packages/db/drizzle" });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await client()`truncate contacts, farms restart identity cascade`;
    await client()`truncate pending_stock_out_reports`;
    pineconeId = await seedStand("Pinecone Gardens", ["kale", "bok choy", "potatoes"], ["eggs"]);
  });

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  function database(): Db {
    return { sql: client(), orm: {}, close: async () => {} } as unknown as Db;
  }

  /**
   * A stand with a published revision, a usual offering, and an authorized farmer to alert —
   * production's shape. Without the authorization no alert is queued and every assertion
   * about the farmer's message would vacuously pass on an empty table.
   */
  async function seedStand(
    name: string,
    published: string[],
    offerings: string[],
  ): Promise<string> {
    const farms = await client()`insert into farms (name) values (${name}) returning id`;
    const farmId = farms[0]?.id as string;
    const contacts = await client()`
      insert into contacts (phone_hash, phone_e164)
      values (${"f".repeat(64)}, '+12065550100') returning id
    `;
    await client()`
      insert into farmer_authorizations (farm_id, contact_id, authorized_at, phone_verified_at)
      values (${farmId}, ${contacts[0]?.id as string}, ${T0}, ${T0})
    `;
    const locations = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable', 'produce',
        '1 Road', 47.44, -122.46, false, false
      ) returning id
    `;
    const locationId = locations[0]?.id as string;

    if (published.length > 0) {
      const revisions = await client()`
        insert into inventory_revisions
          (farm_id, sales_location_id, provider_id, is_current, published_at, source)
        values (${farmId}, ${locationId}, (select id from stand_providers where sales_location_id = ${locationId} and seller_id is null), true, ${T0}, 'viga') returning id
      `;
      const revisionId = revisions[0]?.id as string;
      for (const [index, itemName] of published.entries()) {
        await client()`
          insert into inventory_entries
            (inventory_revision_id, sales_location_id, item_name, sort_order)
          values (${revisionId}, ${locationId}, ${itemName}, ${index})
        `;
      }
    }
    for (const [index, displayName] of offerings.entries()) {
      await client()`
        insert into stand_items (sales_location_id, provider_id, display_name, usually_carried, sort_order)
        values (${locationId}, (select id from stand_providers
          where sales_location_id = ${locationId} and seller_id is null), ${displayName}, false, ${index})
      `;
    }
    return locationId;
  }

  function forbiddenInquiry(): CatalogMatcher {
    return {
      async match() {
        throw new Error("the catalog matcher must not run once a clarification resolves");
      },
    };
  }

  /**
   * The first-pass classifier, scripted per message text (F-111).
   *
   * Deliberately still scripted per phrase: these tests assert that a HELD clarification
   * rescues a message the classifier gets legitimately "wrong" — a bare stand name really is a
   * lookup — so the classifier's verdict must be pinned rather than inferred.
   */
  function classifier(
    byText: Record<string, RequestCategory>,
  ): RequestClassificationModel {
    return {
      async classify({ taskText }) {
        const kind = byText[taskText];
        if (kind === undefined) {
          throw new Error(`unscripted classification for ${JSON.stringify(taskText)}`);
        }
        if (kind === "search_stands") return { ok: true, kind, request: { operation: "inventory" } };
        if (kind === "stand_lookup") return { ok: true, kind, request: { operation: "overview" } };
        return { ok: true, kind };
      },
    };
  }

  /** The stock-out item seam: picks whichever candidate name appears in the text. */
  function stockOutSeam(): StockOutModel {
    return {
      async parseItem({ taskText, listedItems }) {
        const hit = listedItems.find((item) =>
          taskText.toLowerCase().includes(item.itemName.toLowerCase()),
        );
        if (hit) return { kind: "listed", entryId: hit.entryId };
        return { kind: "unclear" };
      },
    };
  }

  function deps(intent: RequestClassificationModel, stockOut = stockOutSeam()) {
    return {
      db: database(),
      interpreter: {
        interpret: async () => {
          throw new Error("the farmer interpreter must not run for a customer");
        },
      } as unknown as InventoryInterpreter,
      catalogMatcher: forbiddenInquiry(),
      classifier: intent,
      stockOut,
      clock: new FixedClock(T0),
    };
  }

  const senderHash = "c".repeat(64);

  async function send(
    depsValue: ReturnType<typeof deps>,
    taskText: string,
    occurredAt: Date,
    eventId: string,
  ) {
    return handleFreeText(depsValue, {
      senderHash,
      taskText,
      occurredAt,
      providerEventId: eventId,
      inboxEventId: randomUUID(),
    });
  }

  async function alertBodies(): Promise<string[]> {
    const rows = await client()`
      select body from outbox_work where message_category = 'stock_out_alert'
    `;
    return rows.map((row) => row.body as string);
  }

  it("completes the report when the customer answers which stand", async () => {
    // The exact filed transcript. The second message names no item, so the intent seam calls
    // it a question — as it correctly does live — and the pending report is what rescues it.
    const d = deps(
      classifier({
        "Pinecome is out of eggs": "inventory_report",
        Pinecone: "stand_lookup",
      }),
    );

    const first = await send(d, "Pinecome is out of eggs", T0, "evt-1");
    expect(first.replies[0]?.body).toBe(STOCK_OUT_STAND_QUESTION);
    expect(await alertBodies()).toHaveLength(0);

    const second = await send(d, "Pinecone", minutesAfter(1), "evt-2");

    // The farmer hears about the EGGS — the item from the FIRST message, which is the whole
    // point. Anchored to the alert body, not to the reply the customer saw.
    const bodies = await alertBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("sold out of eggs");
    expect(bodies[0]).toContain("Pinecone Gardens");
    expect(second.handled).toBe("customer");

    // Recorded against the usual offering, and the held row is gone.
    const reports = await client()`
      select referenced_stand_item_id, unlisted_item_text from stock_out_reports
    `;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.referenced_stand_item_id).not.toBeNull();
    expect(await client()`select id from pending_stock_out_reports`).toHaveLength(0);
  });

  it("completes it when the customer misspells the stand a SECOND time", async () => {
    // The case that motivated the fuzzy tier (max, 2026-08-12): a reply moments after the
    // question is a retry at the name, not a new topic. Remembering alone would drop this.
    const d = deps(
      classifier({
        "Pinecome is out of eggs": "inventory_report",
        Pinecomb: "stand_lookup",
      }),
    );

    await send(d, "Pinecome is out of eggs", T0, "evt-1");
    await send(d, "Pinecomb", minutesAfter(1), "evt-2");

    const bodies = await alertBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("sold out of eggs");
  });

  it("completes the report when the customer answers WHAT was sold out", async () => {
    // The other arm: the stand resolved, the item did not. The held row carries the stand.
    const d = deps(
      classifier({
        "something is out at Pinecone Gardens": "inventory_report",
        eggs: "search_stands",
      }),
    );

    const first = await send(d, "something is out at Pinecone Gardens", T0, "evt-1");
    expect(first.replies[0]?.body).toBe(STOCK_OUT_UNCLEAR_ITEM);

    const rows = await client()`
      select awaiting, sales_location_id from pending_stock_out_reports
    `;
    expect(rows[0]?.awaiting).toBe("item");
    expect(rows[0]?.sales_location_id).toBe(pineconeId);

    await send(d, "eggs", minutesAfter(1), "evt-2");
    const bodies = await alertBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("sold out of eggs");
  });

  it("releases the held report when the reply is plainly a new question", async () => {
    // A customer who moved on must still get a real answer. "kale" names no stand, so the
    // pending row is dropped and the message goes to the ordinary inquiry path.
    const inquiry = vi.fn(async () => ({ ok: true as const, matches: [] }));
    const d = {
      ...deps(
        classifier({
          "Pinecome is out of eggs": "inventory_report",
          "who has kale": "search_stands",
        }),
      ),
      catalogMatcher: {
        match: inquiry,
      },
    };

    await send(d, "Pinecome is out of eggs", T0, "evt-1");
    await send(d, "who has kale", minutesAfter(1), "evt-2");

    // Released: no report filed, no alert, and the row is gone rather than lying in wait.
    expect(await alertBodies()).toHaveLength(0);
    expect(await client()`select id from pending_stock_out_reports`).toHaveLength(0);
    expect(inquiry).toHaveBeenCalled();
  });

  it("ignores a held report once it has expired", async () => {
    // Judged by the MESSAGE's clock. An answer an hour later is a new conversation, and the
    // stand name alone is then just a question — exactly the behavior that predates B-065.
    const inquiry = vi.fn(async () => ({ ok: true as const, matches: [] }));
    const d = {
      ...deps(
        classifier({
          "Pinecome is out of eggs": "inventory_report",
          Pinecone: "stand_lookup",
        }),
      ),
      catalogMatcher: {
        match: inquiry,
      },
    };

    await send(d, "Pinecome is out of eggs", T0, "evt-1");
    await send(d, "Pinecone", minutesAfter(60), "evt-2");

    expect(await alertBodies()).toHaveLength(0);
    expect(inquiry).not.toHaveBeenCalled();
  });

  it("does not fuzzy-match a stand on a COLD message", async () => {
    // The fuzzy tier is confined to an open clarification. A misspelled report with nothing
    // held must still ask, or max's 2026-08-11 ruling is quietly reversed for every message.
    const d = deps(classifier({ "Pinecome is out of eggs": "inventory_report" }));

    const only = await send(d, "Pinecome is out of eggs", T0, "evt-1");
    expect(only.replies[0]?.body).toBe(STOCK_OUT_STAND_QUESTION);
    expect(await alertBodies()).toHaveLength(0);
  });

  it("keeps one open clarification per sender", async () => {
    // A second unfinished report replaces the first. The unique index is the arbiter, so the
    // answer can never be ambiguous about which report it completes.
    const d = deps(
      classifier({
        "Pinecome is out of eggs": "inventory_report",
        "Bartz is out of plums": "inventory_report",
      }),
    );

    await send(d, "Pinecome is out of eggs", T0, "evt-1");
    await send(d, "Bartz is out of plums", minutesAfter(1), "evt-2");

    const rows = await client()`select report_text from pending_stock_out_reports`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.report_text).toBe("Bartz is out of plums");
  });
});
