import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, PUBLIC_MAP_URL, type InventoryInterpreter } from "@farm-friend/core";
import type {
  CatalogMatcher,
  RequestCategory,
  RequestClassificationModel,
  StockOutModel,
} from "@farm-friend/ai";
import type { Db, Sql } from "@farm-friend/db";
import {
  CHITCHAT_REPLY,
  CLASSIFIER_UNAVAILABLE_REPLY,
  handleFreeText,
  STOCK_OUT_STAND_QUESTION,
  STOCK_OUT_THANKS,
  SYSTEM_INQUIRY_REPLY,
  UNCLEAR_REQUEST_REPLY,
  VIGA_BUCKS_INQUIRY_REPLY,
} from "./free-text";

/*
  F-111 Phase 2 — routing around the first-pass request classifier.

  Two defects were live on handsets when this was written, and they shared one cause: stand-name
  matching ran against the whole message BEFORE anything classified it, so "another stand's name
  appears in this text" and "this is a report about that stand" were treated as one claim.

    A  "where's the farm stand map?"  → the generic clarification. No free-text phrasing of the
       map question reached the MAP keyword's answer, because a customer path could only look up
       a PRODUCT.
    B  any message containing the word "open", from a farmer handset → bound to Open Gate Lamb
       and Grazing and answered as a stock-out report about it.

  These run against real Postgres because the access fork reads `farmer_authorizations` and the
  clarification memory is a real row with a real unique index — a stubbed driver would be
  asserting the mock.
*/

const T0 = new Date(Date.now() - 60_000);

describe("F-111 request-classification routing (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let ownStandId = "";
  let otherStandId = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_classify_route_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
    await client()`truncate contacts, sellers restart identity cascade`;
    await client()`truncate pending_stock_out_reports`;
    // The farmer's own stand, and a stand belonging to someone else. The access fork's three
    // rows are only distinguishable with both present.
    ownStandId = await seedStand("North Stand", FARMER_HASH, ["kale"]);
    otherStandId = await seedStand("Plum Forest Stand", OTHER_FARMER_HASH, ["eggs"]);
    // The stand whose NAME contains an ordinary English word — defect B's whole cause. It is
    // seeded so the matcher has a real row to bind to if the bar ever drops again.
    await seedStand("Open Gate Lamb and Grazing", OTHER_FARMER_HASH, ["lamb"]);
  });

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  function database(): Db {
    return { sql: client(), orm: {}, close: async () => {} } as unknown as Db;
  }

  const FARMER_HASH = "a".repeat(64);
  const OTHER_FARMER_HASH = "b".repeat(64);
  const CUSTOMER_HASH = "c".repeat(64);

  /** Real E.164 numbers — `contacts_phone_e164_normalized` refuses anything else. */
  const PHONE_BY_HASH: Record<string, string> = {
    [FARMER_HASH]: "+12065550101",
    [OTHER_FARMER_HASH]: "+12065550102",
    [CUSTOMER_HASH]: "+12065550103",
  };

  /** A stand with a published revision and an authorized farmer to alert. */
  async function seedStand(
    name: string,
    farmerHash: string,
    published: string[],
  ): Promise<string> {
    const sellers = await client()`insert into sellers (name) values (${name}) returning id`;
    const farmId = sellers[0]?.id as string;
    const existing = await client()`select id from contacts where phone_hash = ${farmerHash}`;
    const contactId =
      (existing[0]?.id as string | undefined) ??
      ((
        await client()`
          insert into contacts (phone_hash, phone_e164)
          values (${farmerHash}, ${PHONE_BY_HASH[farmerHash] ?? "+12065550199"}) returning id
        `
      )[0]?.id as string);
    await client()`
      insert into farmer_authorizations (seller_id, contact_id, authorized_at, phone_verified_at)
      values (${farmId}, ${contactId}, ${T0}, ${T0})
    `;
    const locations = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable', 'produce',
        '1 Road', 47.44, -122.46, false, false
      ) returning id
    `;
    const locationId = locations[0]?.id as string;
    const revisions = await client()`
      insert into inventory_revisions
        (seller_id, sales_location_id, provider_id, is_current, published_at, source)
      values (${farmId}, ${locationId}, (select id from stand_providers where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})), true, ${T0}, 'viga') returning id
    `;
    for (const [index, itemName] of published.entries()) {
      await client()`
        insert into inventory_entries
          (inventory_revision_id, sales_location_id, item_name, sort_order)
        values (${revisions[0]?.id as string}, ${locationId}, ${itemName}, ${index})
      `;
    }
    return locationId;
  }

  /** A classifier pinned to one category — the model's verdict, held still. */
  function classifier(kind: RequestCategory): RequestClassificationModel {
    return {
      async classify() {
        if (kind === "search_stands") return { ok: true, kind, request: { operation: "inventory" } };
        if (kind === "stand_lookup") return { ok: true, kind, request: { operation: "overview" } };
        return { ok: true, kind };
      },
    };
  }

  /** The seam could not be reached, or returned nothing valid. */
  function failingClassifier(): RequestClassificationModel {
    return { async classify() { return { ok: false }; } };
  }

  function forbiddenInquiry(): CatalogMatcher {
    return {
      async match() { throw new Error("the catalog matcher must not run on this path"); },
    };
  }

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

  function deps(overrides: {
    classifier: RequestClassificationModel;
    catalogMatcher?: CatalogMatcher;
    interpreter?: InventoryInterpreter;
    stockOut?: StockOutModel;
  }) {
    return {
      db: database(),
      classifier: overrides.classifier,
      catalogMatcher: overrides.catalogMatcher ?? forbiddenInquiry(),
      interpreter:
        overrides.interpreter ??
        ({
          interpret: async () => {
            throw new Error("the interpreter must not run on this path");
          },
        } as unknown as InventoryInterpreter),
      stockOut: overrides.stockOut ?? stockOutSeam(),
      clock: new FixedClock(T0),
    };
  }

  async function send(
    depsValue: ReturnType<typeof deps>,
    senderHash: string,
    taskText: string,
    eventId: string,
  ) {
    return handleFreeText(depsValue, {
      senderHash,
      taskText,
      occurredAt: T0,
      providerEventId: eventId,
      inboxEventId: randomUUID(),
    });
  }

  // ------------------------------------------------------------------ the access fork

  describe("the inventory_report access fork", () => {
    it("routes a CUSTOMER's report to the report flow and alerts the stand's farmer", async () => {
      const d = deps({ classifier: classifier("inventory_report") });
      const result = await send(
        d, CUSTOMER_HASH, "no eggs left at Plum Forest Stand", "evt-cust",
      );

      expect(result.replies[0]?.body).toBe(STOCK_OUT_THANKS);
      const reports = await client()`select sales_location_id from stock_out_reports`;
      expect(reports).toHaveLength(1);
      expect(reports[0]?.sales_location_id).toBe(otherStandId);
      // A customer's report publishes nothing (Golden Rule #1).
      expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);
    });

    it("routes a FARMER's report about THEIR OWN stand to the update flow", async () => {
      const interpret = vi.fn(async () => ({
        kind: "edits" as const,
        additions: [{ itemName: "Kale" }],
        changes: [],
        removals: [],
      }));
      const d = deps({
        classifier: classifier("inventory_report"),
        interpreter: { interpret } as unknown as InventoryInterpreter,
        stockOut: {
          parseItem: async (): Promise<never> => {
            throw new Error("an own-stand update must not reach the stock-out seam");
          },
        },
      });

      const result = await send(d, FARMER_HASH, "kale at North Stand today", "evt-own");

      // A proposal was opened — the publish path — and no report was filed.
      expect(interpret).toHaveBeenCalled();
      expect(result.handled).toBe("farmer");
      expect(await client()`select id from inventory_publication_proposals`).toHaveLength(1);
      expect(await client()`select id from stock_out_reports`).toHaveLength(0);
    });

    it("routes a FARMER's report about SOMEONE ELSE'S stand to the report flow (B-053)", async () => {
      // The case the whole fork exists for. The classifier returns the SAME category it
      // returned above; only access differs, and access is read from `farmer_authorizations`.
      const d = deps({
        classifier: classifier("inventory_report"),
        interpreter: {
          interpret: async () => {
            throw new Error("another farm's stock-out must not open a proposal");
          },
        } as unknown as InventoryInterpreter,
      });

      const result = await send(
        d, FARMER_HASH, "no eggs left at Plum Forest Stand", "evt-other",
      );

      expect(result.replies[0]?.body).toBe(STOCK_OUT_THANKS);
      const reports = await client()`select sales_location_id from stock_out_reports`;
      expect(reports).toHaveLength(1);
      // Filed against the OTHER farm's stand, never the sender's own.
      expect(reports[0]?.sales_location_id).toBe(otherStandId);
      expect(reports[0]?.sales_location_id).not.toBe(ownStandId);
      expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);

      // And the alert goes to that stand's farmer, not to the reporter.
      const queued = await client()`
        select recipient_hash from outbox_work where message_category = 'stock_out_alert'
      `;
      expect(queued).toHaveLength(1);
      expect(queued[0]?.recipient_hash).toBe(OTHER_FARMER_HASH);
      expect(queued[0]?.recipient_hash).not.toBe(FARMER_HASH);
    });

    it("treats a farmer's report naming NO stand as their own update", async () => {
      const interpret = vi.fn(async () => ({
        kind: "edits" as const,
        additions: [{ itemName: "Kale" }],
        changes: [],
        removals: [],
      }));
      const d = deps({
        classifier: classifier("inventory_report"),
        interpreter: { interpret } as unknown as InventoryInterpreter,
      });

      await send(d, FARMER_HASH, "sold out of kale", "evt-bare");

      expect(interpret).toHaveBeenCalled();
      expect(await client()`select id from inventory_publication_proposals`).toHaveLength(1);
    });

    it("asks which stand when a CUSTOMER's report names none, and holds it (B-065)", async () => {
      const d = deps({ classifier: classifier("inventory_report") });
      const result = await send(d, CUSTOMER_HASH, "sold out of eggs", "evt-hold");

      expect(result.replies[0]?.body).toBe(STOCK_OUT_STAND_QUESTION);
      const held = await client()`select awaiting from pending_stock_out_reports`;
      expect(held).toHaveLength(1);
      expect(held[0]?.awaiting).toBe("stand");
      expect(await client()`select id from stock_out_reports`).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------- the word "open" (defect B)

  describe("defect B — an ordinary English word inside a stand's name", () => {
    /*
      "Open Gate Lamb and Grazing" contributes the distinctive word `open`. Before this phase a
      farmer texting ANY message containing that word had a stand bound before classification
      and was answered "Thanks for letting us know. What was sold out?".

      Two independent defences now, and this asserts BOTH — either alone would leave the other
      untested:
        1. classification runs FIRST, so a question never reaches stand matching (below);
        2. the matcher's bar rejects one word out of four even when it IS reached (next test).
    */
    it("answers 'when do you open' from a farmer handset as a question, not a report", async () => {
      const d = deps({
        classifier: {
          async classify() {
            return { ok: true, kind: "search_stands", request: { operation: "hours" } };
          },
        },
        stockOut: {
          parseItem: async (): Promise<never> => {
            throw new Error("a question must not reach the stock-out seam");
          },
        },
      });

      const result = await send(d, FARMER_HASH, "when do you open", "evt-open-1");

      // It reached the grounded inquiry path, and NOTHING was filed against Open Gate.
      expect(result.handled).toBe("customer");
      expect(await client()`select id from stock_out_reports`).toHaveLength(0);
    });

    it("does not bind Open Gate even when the message IS an inventory report", async () => {
      // The second defence, measured on its own: the classifier says `inventory_report`, so
      // stand matching genuinely runs — and the bar rejects one distinctive word out of four.
      // Without the raised bar this files a report against Open Gate Lamb and Grazing.
      const d = deps({ classifier: classifier("inventory_report") });

      const result = await send(
        d, CUSTOMER_HASH, "everything is sold out, are any stands open", "evt-open-2",
      );

      expect(await client()`select sales_location_id from stock_out_reports`).toHaveLength(0);
      // Asked rather than guessed.
      expect(result.replies[0]?.body).toBe(STOCK_OUT_STAND_QUESTION);
    });

    it("still resolves a stand named in full", async () => {
      // The bar must not be so high that a real name stops working. Both directions matter.
      const d = deps({ classifier: classifier("inventory_report") });
      await send(d, CUSTOMER_HASH, "no eggs at Plum Forest Stand", "evt-full-name");

      const reports = await client()`select sales_location_id from stock_out_reports`;
      expect(reports).toHaveLength(1);
      expect(reports[0]?.sales_location_id).toBe(otherStandId);
    });
  });

  // ------------------------------------------------------------------- the new arms

  describe("system_inquiry — defect A", () => {
    it("answers the map question with the same URL the MAP keyword serves", async () => {
      const d = deps({ classifier: classifier("system_inquiry") });
      const result = await send(
        d, CUSTOMER_HASH, "where's the farm stand map?", "evt-map",
      );

      expect(result.replies[0]?.body).toBe(SYSTEM_INQUIRY_REPLY);
      // Anchored to the shared constant, not to a copy of the string: if the two ever drift
      // apart, this fails rather than pinning a stale URL.
      expect(result.replies[0]?.body).toContain(PUBLIC_MAP_URL);
      // It is an answer, not a clarification — the defect was returning "I did not catch which
      // item or farm you meant" to a perfectly clear question.
      expect(result.replies[0]?.body).not.toContain("did not catch");
      expect(await client()`select id from stock_out_reports`).toHaveLength(0);
    });

    it("uses VIGA's live Food Access page for VIGA Bucks details", async () => {
      const d = deps({
        classifier: {
          async classify() {
            return { ok: true as const, kind: "system_inquiry" as const, topic: "viga_bucks" as const };
          },
        },
      });
      const result = await send(d, CUSTOMER_HASH, "how do I get VIGA Bucks?", "evt-bucks");

      expect(result.replies[0]?.body).toBe(VIGA_BUCKS_INQUIRY_REPLY);
      expect(result.replies[0]?.body).toContain("vigavashon.org/food-access-partnership");
    });
  });

  describe("chitchat and unclear are answered in code", () => {
    it("greets rather than searching the corpus for a greeting", async () => {
      const d = deps({ classifier: classifier("chitchat") });
      const result = await send(d, CUSTOMER_HASH, "hi there", "evt-hi");
      expect(result.replies[0]?.body).toBe(CHITCHAT_REPLY);
      expect(result.replies[0]?.body).toBe(
        "Ask me what a Vashon farm stand has, or tell us if something is sold out.",
      );
      // No claim about any stand: "no stand has a current listing for hi" was the old answer.
      expect(result.replies[0]?.body).not.toContain("no stand");
    });

    it("tells an unhandleable message it was not understood", async () => {
      const d = deps({ classifier: classifier("unclear") });
      const result = await send(d, CUSTOMER_HASH, "asdf qwerty", "evt-unclear");
      expect(result.replies[0]?.body).toBe(UNCLEAR_REQUEST_REPLY);
    });
  });

  describe("a failed classifier call blames our outage, not their wording (B-049)", () => {
    it("replies with the outage message when the seam returns no category", async () => {
      const d = deps({ classifier: failingClassifier() });
      const result = await send(d, CUSTOMER_HASH, "who has kale today", "evt-down");

      expect(result.replies[0]?.body).toBe(CLASSIFIER_UNAVAILABLE_REPLY);
      // The three cases are three DIFFERENT messages. An outage that reads as "I didn't catch
      // that" asks the sender to retype something that was already fine.
      expect(result.replies[0]?.body).not.toBe(UNCLEAR_REQUEST_REPLY);
      // And it claims nothing about the corpus — nothing was searched.
      expect(result.replies[0]?.body).not.toContain("No stand has a current listing");
      expect(await client()`select id from stock_out_reports`).toHaveLength(0);
    });

    it("does not degrade into a search, a report, or a proposal", async () => {
      const d = deps({ classifier: failingClassifier() });
      // Every downstream seam throws, so any fallback into a real arm fails loudly here.
      await send(d, FARMER_HASH, "sold out of kale at North Stand", "evt-down-2");

      expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);
      expect(await client()`select id from stock_out_reports`).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------- ordering invariants

  describe("ordering invariants", () => {
    it("answers an open clarification ABOVE classification, for any sender", async () => {
      // The held report is what makes a bare stand name an answer rather than a lookup. A
      // classifier that never runs cannot reinterpret it — asserted by making it throw.
      const explodingClassifier: RequestClassificationModel = {
        async classify() {
          throw new Error("the classifier must not run while a clarification is open");
        },
      };

      // First message: hold a report awaiting the stand.
      await send(
        deps({ classifier: classifier("inventory_report") }),
        CUSTOMER_HASH, "the eggs are gone", "evt-clarify-1",
      );
      expect(await client()`select id from pending_stock_out_reports`).toHaveLength(1);

      // The answer arrives and completes the report WITHOUT consulting the classifier.
      const result = await send(
        deps({ classifier: explodingClassifier }),
        CUSTOMER_HASH, "Plum Forest Stand", "evt-clarify-2",
      );

      expect(result.replies[0]?.body).toBe(STOCK_OUT_THANKS);
      const reports = await client()`select sales_location_id from stock_out_reports`;
      expect(reports).toHaveLength(1);
      expect(reports[0]?.sales_location_id).toBe(otherStandId);
      expect(await client()`select id from pending_stock_out_reports`).toHaveLength(0);
    });

    it("sends an empty message to no seam at all", async () => {
      const explodingClassifier: RequestClassificationModel = {
        async classify() {
          throw new Error("an empty body must not reach the classifier");
        },
      };
      const result = await send(
        deps({ classifier: explodingClassifier }), CUSTOMER_HASH, "   ", "evt-empty",
      );
      expect(result).toEqual({ replies: [], handled: "none" });
    });
  });

  // ------------------------------------------------------ the swap test, written out

  describe("the swap test — a hostile classifier changes no consequence", () => {
    it("cannot publish to a stand the sender does not hold, whatever it returns", async () => {
      // The worst category for this message: a stranger's text, claimed as an inventory report.
      // Authority is not in the enum, so the fork sends it to the report flow regardless.
      for (const kind of ["inventory_report", "stand_lookup", "system_inquiry"] as const) {
        const d = deps({
          classifier: classifier(kind),
          catalogMatcher: {
            match: async () => ({ ok: true, matches: ["eggs"] }),
          } as unknown as CatalogMatcher,
          interpreter: {
            interpret: async () => {
              throw new Error("a customer's message must never reach the interpreter");
            },
          } as unknown as InventoryInterpreter,
        });

        await send(d, CUSTOMER_HASH, "no eggs at Plum Forest Stand", `evt-swap-${kind}`);

        // Nothing published, under any category the model could have returned.
        expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);
      }
    });
  });
});
