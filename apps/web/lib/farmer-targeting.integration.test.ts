import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, type InventoryInterpreter } from "@farm-friend/core";
import type {
  CatalogMatcher,
  RequestCategory,
  RequestClassificationModel,
} from "@farm-friend/ai";
import { resolveFarmerLink, type Db, type Sql } from "@farm-friend/db";
import { handleFreeText, UNCLEAR_REQUEST_REPLY } from "./free-text";
import { handleFarmerTarget, handleStandSelection } from "./farmer-targeting";

const T0 = new Date(Date.now() - 60_000);

describe("F-051 deterministic farmer targeting handler (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_target_handler_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
  });

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  function database(): Db {
    return { sql: client(), orm: {}, close: async () => {} } as unknown as Db;
  }

  function forbiddenInquiry(): CatalogMatcher {
    return {
      async match() { throw new Error("catalog matcher reached for a farmer"); },
    };
  }

  /**
   * The first-pass classifier, pinned to one category (F-111).
   *
   * One seam for both senders now: what a message IS no longer depends on who sent it, and who
   * may act on it is decided in code from `farmer_authorizations`.
   */
  function classifier(kind: RequestCategory): RequestClassificationModel {
    return {
      async classify() {
        if (kind === "search_stands") return { ok: true, kind, request: { operation: "inventory" } };
        if (kind === "stand_lookup") return { ok: true, kind, request: { operation: "overview" } };
        return { ok: true, kind };
      },
    };
  }

  async function authorize(senderHash: string, names: string[]) {
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550155', ${senderHash}, ${T0}) returning id
    `;
    const sellers = await client()`insert into sellers (name) values ('Target Farm') returning id`;
    const farmId = sellers[0]?.id as string;
    const authorizations = await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    const locations: string[] = [];
    for (const name of names) {
      const inserted = await client()`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          public_address, public_latitude, public_longitude
        ) values (${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable',
          'produce', '1 Stand Way', 47.44, -122.46)
        returning id
      `;
      locations.push(inserted[0]?.id as string);
    }
    return { authorizationId: authorizations[0]?.id as string, locations };
  }

  it("continues a multi-stand LINK action after the stored numbered choice", async () => {
    const senderHash = "a".repeat(64);
    const owned = await authorize(senderHash, ["North Stand", "South Stand"]);
    const menu = await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "LINK", occurredAt: T0, providerEventId: "link-1" },
    );

    expect(menu.status).toBe("menu");
    expect(menu.replies[0]?.body).toContain("1. North Stand");
    expect(menu.replies[0]?.body).toContain("2. South Stand");
    expect(await client()`select id from farmer_links`).toHaveLength(0);

    const selected = await handleStandSelection(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, optionNumber: 2, occurredAt: new Date(T0.getTime() + 1_000), providerEventId: "choice-1" },
    );
    expect(selected.status).toBe("issued");
    expect(selected.replies[0]?.body).toContain("South Stand");
    expect(selected.replies[0]?.body).toContain("https://configured.example/stand/");
    const rows = await client()`select token_hash from farmer_links where revoked_at is null`;
    await expect(resolveFarmerLink(database(), {
      tokenHash: rows[0]?.token_hash as string,
    })).resolves.toMatchObject({ salesLocationId: owned.locations[1] });
  });

  it("uses the same non-disclosing response for unauthorized STAND and SETTINGS", async () => {
    const senderHash = "b".repeat(64);
    await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550156', ${senderHash}, ${T0})
    `;
    const stand = await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "STAND", occurredAt: T0, providerEventId: "stand-1" },
    );
    const settings = await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "SETTINGS", occurredAt: T0, providerEventId: "settings-1" },
    );

    expect(stand.status).toBe("not_authorized");
    expect(settings.status).toBe("not_authorized");
    expect(stand.replies[0]?.body).toBe(settings.replies[0]?.body);
    expect(stand.replies[0]?.body).not.toMatch(/https?:\/\//);
  });

  it("issues one exact settings link for the only valid stand", async () => {
    const senderHash = "c".repeat(64);
    await authorize(senderHash, ["Harbor Stand"]);
    const result = await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "SETTINGS", occurredAt: T0, providerEventId: "settings-2" },
    );

    expect(result.status).toBe("issued");
    expect(result.replies[0]?.body).toContain("Harbor Stand");
    // F-097 — the stand token is base64url now, not 64 hex. Anchored to the SHAPE of a link
    // token rather than to a literal length, so this keeps proving the reply carries a real
    // settings URL for this stand without re-pinning the encoding.
    expect(result.replies[0]?.body).toMatch(/\/stand\/[A-Za-z0-9_-]{22,64}\/settings/);
  });

  it("offers the durable stand menu before interpreting free text when no target is selected", async () => {
    const senderHash = "d".repeat(64);
    await authorize(senderHash, ["North Stand", "South Stand"]);
    const interpret = vi.fn(async (_request: Parameters<InventoryInterpreter["interpret"]>[0]) => ({
      kind: "edits" as const,
      additions: [{ itemName: "Kale" }],
      changes: [],
      removals: [],
    }));

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "kale today",
        occurredAt: T0,
        providerEventId: "free-menu-1",
        inboxEventId: "11111111-1111-1111-1111-111111111111",
      },
    );

    expect(result.handled).toBe("none");
    expect(result.replies[0]?.body).toContain("1. North Stand");
    expect(result.replies[0]?.body).toContain("2. South Stand");
    expect(interpret).not.toHaveBeenCalled();
    expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);
  });

  it("routes a farmer's general stand question before requiring a stand target", async () => {
    const senderHash = "q".repeat(64);
    await authorize(senderHash, ["North Stand", "South Stand"]);
    const classify = vi.fn(async () => ({
      ok: true as const,
      kind: "search_stands" as const,
      request: { operation: "inventory" as const },
    }));
    const match = vi.fn(async () => ({ ok: true as const, matches: [] }));

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: { match },
        classifier: { classify },
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "What does the north stand have today?",
        occurredAt: T0,
        providerEventId: "farmer-question-1",
        inboxEventId: "33333333-3333-3333-3333-333333333333",
      },
    );

    expect(classify).toHaveBeenCalledOnce();
    expect(match).toHaveBeenCalledOnce();
    expect(result.handled).toBe("customer");
    expect(result.replies[0]?.body).toMatch(/no stand has a current listing/i);
    expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);
    expect(await client()`select menu_issued_at from farmer_target_contexts`).toHaveLength(0);
  });

  /*
    F-111 replaced the UPDATE-or-QUESTION round trip. `unclear` used to be the farmer seam's
    FALLBACK as well as an arm, so an unreachable model asked a farmer to pick a keyword — a
    round trip that buys nothing (DEVELOPMENT.md's warning about exactly this seam). It is now a
    real category with an honest code-rendered answer, and an outage is a DIFFERENT reply.

    What this test still guards is the load-bearing half: an unclear message opens no proposal,
    reaches no interpreter, and issues no stand menu.
  */
  it("answers an unclear farmer message without proposing or targeting anything", async () => {
    const senderHash = "u".repeat(64);
    await authorize(senderHash, ["North Stand", "South Stand"]);
    const inventory = vi.fn(async () => ({
      kind: "edits" as const,
      additions: [],
      changes: [],
      removals: [],
    }));
    const catalogMatcher = forbiddenInquiry();

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: inventory },
        catalogMatcher,
        classifier: classifier("unclear"),
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "The stand is busy today.",
        occurredAt: T0,
        providerEventId: "farmer-unclear-1",
        inboxEventId: "44444444-4444-4444-4444-444444444444",
      },
    );

    expect(result.replies[0]?.body).toBe(UNCLEAR_REQUEST_REPLY);
    // It offers no keyword and makes no claim about any stand.
    expect(result.replies[0]?.body).not.toContain("UPDATE");
    expect(inventory).not.toHaveBeenCalled();
    expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);
    expect(await client()`select menu_issued_at from farmer_target_contexts`).toHaveLength(0);
  });

  it("revalidates the durable selected pair and proposes only for that exact stand", async () => {
    const senderHash = "e".repeat(64);
    const owned = await authorize(senderHash, ["North Stand", "South Stand"]);
    await handleFarmerTarget(
      { db: database(), publicBaseUrl: "https://configured.example" },
      { senderHash, keyword: "STAND", occurredAt: T0, providerEventId: "stand-menu-2" },
    );
    await handleStandSelection(
      { db: database(), publicBaseUrl: "https://configured.example" },
      {
        senderHash,
        optionNumber: 2,
        occurredAt: new Date(T0.getTime() + 1_000),
        providerEventId: "stand-choice-2",
      },
    );
    const interpret = vi.fn(async (_request: Parameters<InventoryInterpreter["interpret"]>[0]) => ({
      kind: "edits" as const,
      additions: [{ itemName: "Kale" }],
      changes: [],
      removals: [],
    }));

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        clock: new FixedClock(new Date(T0.getTime() + 2_000)),
      },
      {
        senderHash,
        taskText: "kale today",
        occurredAt: new Date(T0.getTime() + 2_000),
        providerEventId: "free-selected-2",
        inboxEventId: "22222222-2222-2222-2222-222222222222",
      },
    );

    expect(interpret).toHaveBeenCalledOnce();
    const modelInput = interpret.mock.calls[0]?.[0];
    expect(Object.keys(modelInput ?? {}).sort()).toEqual([
      "currentClosure",
      "currentEntries",
      "currentLocalDate",
      "taskText",
    ]);
    const serializedInput = JSON.stringify(modelInput);
    expect(serializedInput).not.toContain("North Stand");
    expect(serializedInput).not.toContain("South Stand");
    expect(serializedInput).not.toContain(owned.locations[0] as string);
    expect(serializedInput).not.toContain(owned.locations[1] as string);
    expect(result.handled).toBe("farmer");
    expect(result.replies[0]?.body).toContain("South Stand");
    expect(await client()`
      select sales_location_id from inventory_publication_proposals where state = 'open'
    `).toEqual([{ sales_location_id: owned.locations[1] }]);
  });

  // -------------------------------------------------- F-104: the customer stock-out door

  /**
   * A stand belonging to somebody else, so a customer reporting against it is reporting
   * against a farmer they have no relationship with — the real shape of this flow.
   */
  async function otherFarmersStand(
    name: string,
    // Distinct per call so a test can create two stands; the first farmer's hash is the
    // default because most cases have exactly one and assert against it by name.
    owner: { phone: string; hash: string } = {
      phone: "+12065550188",
      hash: "f".repeat(64),
    },
  ): Promise<string> {
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values (${owner.phone}, ${owner.hash}, ${T0}) returning id
    `;
    const sellers = await client()`insert into sellers (name) values (${name}) returning id`;
    const farmId = sellers[0]?.id as string;
    await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contacts[0]?.id as string}, ${T0}, ${T0})
    `;
    const inserted = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude
      ) values (${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable',
        'produce', '2 Stand Way', 47.44, -122.46)
      returning id
    `;
    return inserted[0]?.id as string;
  }

  /**
   * Publish one current listing for a stand's own seller.
   *
   * F-114 C.3 — a stock-out report only reaches a provider whose current confirmed inventory
   * CONTRADICTS it, so a case asserting that the right FARMER is texted has to give that farmer
   * something to be contradicted about. `viga` is the one source whose coherence arm needs no
   * proposal, authorization or approval keys; how the listing was published is not what these
   * routing cases are about.
   */
  async function publishItems(locationId: string, items: string[]): Promise<string[]> {
    const location = await client()`
      select own_seller_id from sales_locations where id = ${locationId}
    `;
    const revisions = await client()`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, source, published_at, is_current
      )
      select ${location[0]?.own_seller_id as string}, ${locationId}, provider.id,
             'viga', ${T0}, true
      from stand_providers as provider
      join sales_locations as l on l.id = provider.sales_location_id
      where provider.sales_location_id = ${locationId}
        and provider.seller_id = l.own_seller_id
      returning id
    `;
    const ids: string[] = [];
    for (const [index, itemName] of items.entries()) {
      const entries = await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        ) values (${revisions[0]?.id as string}, ${locationId}, ${itemName}, ${index})
        returning id
      `;
      ids.push(entries[0]?.id as string);
    }
    return ids;
  }

  it("asks which stand a customer is at rather than guessing one", async () => {
    const senderHash = "c".repeat(64);
    await otherFarmersStand("Plum Forest Stand");
    const classifyCustomer = vi.fn(async () => ({ ok: true as const, kind: "inventory_report" as const }));
    const customerClassifier = { classify: classifyCustomer };
    const inquiry = {
      match: vi.fn(async () => {
        throw new Error("a report must not reach the inquiry seam");
      }),
    };

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: inquiry as unknown as CatalogMatcher,
        classifier: customerClassifier,
        stockOut: { parseItem: vi.fn() },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "the tomatoes are all gone",
        occurredAt: T0,
        providerEventId: "stockout-ask-1",
        inboxEventId: "44444444-4444-4444-4444-444444444444",
      },
    );

    // Max's rule (2026-08-10): a customer has no stand affiliation, so when the stand is
    // unclear we ask, rather than letting a model pick one.
    expect(result.replies[0]?.body).toMatch(/which stand/i);
    // Nothing durable happened. A question is not a report.
    expect(await client()`select id from stock_out_reports`).toHaveLength(0);
    expect(await client()`select id from outbox_work`).toHaveLength(0);
  });

  it("records the report and alerts the farmer when the customer names the stand", async () => {
    const senderHash = "g".repeat(64);
    const locationId = await otherFarmersStand("Plum Forest Stand");
    // The farmer currently claims tomatoes, so the report CONTRADICTS her (F-114 C.3) and she
    // is the one who hears about it. Which is what this case is about: the report reaching the
    // farmer at the stand the customer NAMED.
    const [tomatoEntryId] = await publishItems(locationId, ["tomatoes"]);
    const classifyCustomer = vi.fn(async () => ({ ok: true as const, kind: "inventory_report" as const }));
    // The item seam runs only AFTER code has bound the stand, and never sees the location.
    // Typed to the seam's real input so the projection assertion below inspects what was
    // actually passed rather than an untyped `undefined`.
    const parseItem = vi.fn(
      async (_input: {
        taskText: string;
        listedItems: readonly { entryId: string; itemName: string }[];
      }) => ({ kind: "listed" as const, entryId: tomatoEntryId as string }),
    );

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: {
          match: vi.fn(async () => {
            throw new Error("a report must not reach the inquiry seam");
          }),
        } as unknown as CatalogMatcher,
        classifier: { classify: classifyCustomer },
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "no tomatoes left at Plum Forest Stand",
        occurredAt: T0,
        providerEventId: "stockout-record-1",
        inboxEventId: "66666666-6666-6666-6666-666666666666",
      },
    );

    // The report landed on the stand the customer NAMED, resolved in code.
    const reports = await client()`
      select sales_location_id, referenced_inventory_entry_id from stock_out_reports
    `;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.sales_location_id).toBe(locationId);

    // And the farmer who owns that stand was queued an alert.
    const queued = await client()`
      select recipient_hash, message_category, body from outbox_work
      where message_category = 'stock_out_alert'
    `;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.recipient_hash).toBe("f".repeat(64));
    // The stand is named, and the item comes from the BOUND ROW rather than from the model's
    // echo of it (Golden Rule #6) — the two are the same word here, which is why the seam
    // projection assertion below is the one that proves the model chose nothing.
    expect(queued[0]?.body).toContain("Plum Forest Stand");
    expect(queued[0]?.body).toContain("sold out of tomatoes");

    // The reporter is told the farmer will be told — intent, never a delivery receipt.
    expect(result.replies[0]?.body).toBe("Thanks, we'll let the farmer know.");
    // The seam that binds the item never received a location to choose from.
    expect(JSON.stringify(parseItem.mock.calls[0]?.[0])).not.toContain(locationId);
  });

  it("asks rather than guessing when the text matches more than one stand", async () => {
    const senderHash = "h".repeat(64);
    // Two stands whose names both appear in the message. Picking either would be a silent
    // guess that texts a farmer about a stand the customer may not have meant.
    await otherFarmersStand("Plum Forest Stand");
    await otherFarmersStand("Plum Forest Stand North", {
      phone: "+12065550199",
      hash: "9".repeat(64),
    });
    const parseItem = vi.fn(async () => {
      throw new Error("the item seam must not run before a stand is bound");
    });

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "nothing left at Plum Forest Stand North",
        occurredAt: T0,
        providerEventId: "stockout-ambiguous-1",
        inboxEventId: "77777777-7777-7777-7777-777777777777",
      },
    );

    expect(result.replies[0]?.body).toMatch(/which stand/i);
    expect(parseItem).not.toHaveBeenCalled();
    expect(await client()`select id from stock_out_reports`).toHaveLength(0);
    expect(await client()`
      select id from outbox_work where message_category = 'stock_out_alert'
    `).toHaveLength(0);
  });

  /*
    F-106 tier 1 — punctuation and case must not defeat the EXACT match.

    "Bart's Cart" is a real production stand, and nobody types the apostrophe. Folding both
    sides is still an exact match on the folded text: it widens the spelling accepted for one
    name, never the set of names a message can reach. A message that folds to two stands is
    still ambiguous and still asks.
  */
  it("matches a stand name across punctuation and case without a model call", async () => {
    const senderHash = "p".repeat(64);
    const locationId = await otherFarmersStand("Bart's Cart");
    const parseItem = vi.fn(
      async (_input: {
        taskText: string;
        listedItems: readonly { entryId: string; itemName: string }[];
      }) => ({ kind: "unlisted" as const, itemText: "kale" }),
    );

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        // No apostrophe, lowercase — what a person actually sends.
        taskText: "kale out at barts cart",
        occurredAt: T0,
        providerEventId: "stockout-folded-1",
        inboxEventId: "88888888-8888-8888-8888-888888888888",
      },
    );

    // Bound in code, silently, exactly as a fully-spelled name is. No confirmation step.
    const reports = await client()`
      select sales_location_id from stock_out_reports
    `;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.sales_location_id).toBe(locationId);
    expect(result.replies[0]?.body).toBe("Thanks, we'll let the farmer know.");
  });

  /*
    The mirror of the case above, and it is NOT redundant: "barts cart" has no punctuation to
    strip, so folding only the STAND NAME already passed that test. Removing the customer-side
    strip left every folding test green. This is the one that fails when it goes.
  */
  it("folds punctuation on the customer's side of the match too", async () => {
    const senderHash = "r".repeat(64);
    // Production spells this stand with a CURLY apostrophe (U+2019) — "Bart’s Cart" — which
    // no phone keyboard produces by default. Measured against the live corpus 2026-08-11:
    // before folding, that name was unmatchable by anyone typing it normally. The stand row
    // here carries the real character, and the customer below types the straight one.
    const locationId = await otherFarmersStand("Bart’s Cart");
    const parseItem = vi.fn(
      async (_input: {
        taskText: string;
        listedItems: readonly { entryId: string; itemName: string }[];
      }) => ({ kind: "unlisted" as const, itemText: "kale" }),
    );

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        // The APOSTROPHE is the customer's, and the stand's own name has none.
        taskText: "kale out at Bart's Cart",
        occurredAt: T0,
        providerEventId: "stockout-folded-2",
        inboxEventId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      },
    );

    const reports = await client()`select sales_location_id from stock_out_reports`;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.sales_location_id).toBe(locationId);
    expect(result.replies[0]?.body).toBe("Thanks, we'll let the farmer know.");
  });

  /*
    F-106 tier 2 — a PARTIAL stand name, resolved in code (max, 2026-08-11).

    "kale out at barts" names one real stand to any islander, but "barts" is not a substring
    of "barts cart" reversed — the message does not contain the name, so tier 1 cannot see it.

    Scoring the stand's DISTINCTIVE words against the message resolves it, and measurement
    against the 36 live stands is why this is code and not a model call: a single best score
    identified the right stand in every partial-name case tried, and produced a tie (which
    asks) for the genuinely ambiguous ones. A model here would add a seam, a projection and a
    validation path to reproduce an answer `Set.has` already gets right.

    A MISSPELLED name ("pinecome") still asks. That is the deliberate stopping point (max,
    2026-08-11): fuzzy matching is the only part that needs a model, and needing a model means
    needing a confirmation token before a stranger's guess can text a farmer. Asking costs one
    round-trip and risks nothing.
  */
  it("resolves a partial stand name by its distinctive words, with no model call", async () => {
    const senderHash = "s".repeat(64);
    const locationId = await otherFarmersStand("Bart’s Cart");
    // A second stand sharing a GENERIC word, to prove the score ignores "farm"/"stand".
    await otherFarmersStand("Forest Garden Farm", {
      phone: "+12065550197",
      hash: "7".repeat(64),
    });
    const parseItem = vi.fn(
      async (_input: {
        taskText: string;
        listedItems: readonly { entryId: string; itemName: string }[];
      }) => ({ kind: "unlisted" as const, itemText: "kale" }),
    );

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        // Just "barts" — the stand's own name is never spelled out.
        taskText: "kale out at barts",
        occurredAt: T0,
        providerEventId: "stockout-partial-1",
        inboxEventId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      },
    );

    const reports = await client()`select sales_location_id from stock_out_reports`;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.sales_location_id).toBe(locationId);
    expect(result.replies[0]?.body).toBe("Thanks, we'll let the farmer know.");
  });

  /*
    The tie rule, re-measured under Phase 2b's bar (F-111).

    This pair used to tie: "Vashon Garlic" and "Vashon Island Farmers Market" share their first
    distinctive word, both scored 1, and a tie asks. Under the coverage bar they no longer score
    alike — `vashon` is the WHOLE of Vashon Garlic's distinctive name but one word of four for
    the Market, which the bar rejects. So "vashon" now names Vashon Garlic, and that is correct:
    typing a stand's entire distinctive name is identification, not coincidence.

    The tie rule itself is unchanged and still asks; it is asserted here on a pair that still
    ties under the bar — two stands each named by half of what was typed.
  */
  it("asks when two stands score equally on a partial name", async () => {
    const senderHash = "t".repeat(64);
    // Both are two distinctive words, both matched once by "hill farm" -> each 1 of 2, which
    // clears the bar and ties.
    await otherFarmersStand("Flora Hill Farm");
    await otherFarmersStand("Lavender Hill Farm", {
      phone: "+12065550196",
      hash: "6".repeat(64),
    });
    const parseItem = vi.fn(async () => {
      throw new Error("the item seam must not run before a stand is bound");
    });

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "nothing at hill",
        occurredAt: T0,
        providerEventId: "stockout-partial-ambiguous-1",
        inboxEventId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      },
    );

    expect(result.replies[0]?.body).toMatch(/which stand/i);
    expect(parseItem).not.toHaveBeenCalled();
    expect(await client()`select id from stock_out_reports`).toHaveLength(0);
  });

  it("asks rather than guessing at a misspelled stand name", async () => {
    const senderHash = "u".repeat(64);
    await otherFarmersStand("Pinecone Gardens");
    const parseItem = vi.fn(async () => {
      throw new Error("the item seam must not run before a stand is bound");
    });

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        // "pinecome" is not "pinecone". Code does not guess at spelling.
        taskText: "no eggs at pinecome garden",
        occurredAt: T0,
        providerEventId: "stockout-misspelled-1",
        inboxEventId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      },
    );

    expect(result.replies[0]?.body).toMatch(/which stand/i);
    expect(parseItem).not.toHaveBeenCalled();
    expect(await client()`select id from stock_out_reports`).toHaveLength(0);
  });

  it("does not let a generic word alone bind a report to a stand", async () => {
    const senderHash = "v".repeat(64);
    // "farm" is in most stand names and distinguishes nothing. A message carrying only a
    // generic word must reach nobody — silently texting a farmer off "farm" would be the
    // worst failure this scoring could have.
    await otherFarmersStand("Narwhal Farm");
    const parseItem = vi.fn(async () => {
      throw new Error("the item seam must not run before a stand is bound");
    });

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "the farm stand is out of eggs",
        occurredAt: T0,
        providerEventId: "stockout-generic-1",
        inboxEventId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      },
    );

    expect(result.replies[0]?.body).toMatch(/which stand/i);
    expect(parseItem).not.toHaveBeenCalled();
    expect(await client()`select id from stock_out_reports`).toHaveLength(0);
  });

  it("still refuses when the folded text matches two stands", async () => {
    const senderHash = "q".repeat(64);
    // Folding must not collapse two distinct names into one silent guess.
    await otherFarmersStand("Bart's Cart");
    await otherFarmersStand("Barts Cart North", {
      phone: "+12065550198",
      hash: "8".repeat(64),
    });
    const parseItem = vi.fn(async () => {
      throw new Error("the item seam must not run before a stand is bound");
    });

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "nothing left at barts cart north",
        occurredAt: T0,
        providerEventId: "stockout-folded-ambiguous-1",
        inboxEventId: "99999999-9999-9999-9999-999999999999",
      },
    );

    expect(result.replies[0]?.body).toMatch(/which stand/i);
    expect(parseItem).not.toHaveBeenCalled();
    expect(await client()`select id from stock_out_reports`).toHaveLength(0);
  });

  /*
    F-104 follow-up (max, 2026-08-11). An authorized farmer who names SOMEONE ELSE'S stand is
    reporting a stock-out, not updating their own listing.

    Found by a live test: Max texted "no eggs left at Pinecone Gardens" from a farmer handset
    and got the farmer stand-menu, because `hasLiveFarmerAuthorization` routes on WHO sent the
    message and nothing downstream reconsiders. The discriminator is WHOSE STAND was named —
    resolvable in code, so no model decides it.
  */
  it("treats a farmer naming another farm's stand as a stock-out report", async () => {
    const senderHash = "j".repeat(64);
    // The sender owns these; the report names neither.
    await authorize(senderHash, ["North Stand", "South Stand"]);
    const otherId = await otherFarmersStand("Plum Forest Stand");
    // The other farm currently claims eggs, so the report contradicts THEM and reaches THEIR
    // farmer (F-114 C.3) — which is the point of this case.
    const [eggsEntryId] = await publishItems(otherId, ["eggs"]);
    const parseItem = vi.fn(
      async (_input: {
        taskText: string;
        listedItems: readonly { entryId: string; itemName: string }[];
      }) => ({ kind: "listed" as const, entryId: eggsEntryId as string }),
    );
    // The classifier IS consulted now, and returns the one category every inventory statement
    // gets. Access -- not the category -- is what sends this to the report flow.
    const farmerClassify = vi.fn(async () => ({ ok: true as const, kind: "inventory_report" as const }));

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: {
          interpret: vi.fn(async () => {
            throw new Error("a report must not open an inventory proposal");
          }),
        } as unknown as InventoryInterpreter,
        catalogMatcher: forbiddenInquiry(),
        /*
          B-053, now enforced by the ACCESS FORK rather than by a classifier arm (F-111). The
          classifier says only "someone asserted a stand's inventory needs updating" — the same
          category a customer's report gets. That the stand is not this farmer's is decided in
          CODE from `farmer_authorizations`, which is why a hostile classifier cannot route a
          stranger's report into anyone's publish path.
        */
        classifier: { classify: farmerClassify },
        stockOut: { parseItem },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "no eggs left at Plum Forest Stand",
        occurredAt: T0,
        providerEventId: "farmer-reports-other-1",
        inboxEventId: "88888888-8888-8888-8888-888888888888",
      },
    );

    // The report landed on the OTHER farm's stand, and alerts ITS farmer.
    const reports = await client()`select sales_location_id from stock_out_reports`;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.sales_location_id).toBe(otherId);
    const queued = await client()`
      select recipient_hash from outbox_work where message_category = 'stock_out_alert'
    `;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.recipient_hash).toBe("f".repeat(64));
    // Not the reporting farmer — they are the messenger, not the recipient.
    expect(queued[0]?.recipient_hash).not.toBe(senderHash);

    // No stand menu, no proposal: this was never about the sender's own stands.
    expect(result.replies[0]?.body).toBe("Thanks, we'll let the farmer know.");
    expect(await client()`select id from inventory_publication_proposals`).toHaveLength(0);
  });

  it("still routes a farmer's own-stand update to the inventory path", async () => {
    const senderHash = "k".repeat(64);
    await authorize(senderHash, ["North Stand"]);
    // Naming their OWN stand must stay an update — this is the regression the change risks.
    const interpret = vi.fn(async () => ({
      kind: "edits" as const,
      additions: [{ itemName: "Kale" }],
      changes: [],
      removals: [],
    }));

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret },
        catalogMatcher: forbiddenInquiry(),
        classifier: classifier("inventory_report"),
        stockOut: {
          parseItem: async (): Promise<never> => {
            throw new Error("a farmer's own-stand update must not reach the stock-out seam");
          },
        },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "we have kale at North Stand",
        occurredAt: T0,
        providerEventId: "farmer-own-stand-1",
        inboxEventId: "99999999-9999-9999-9999-999999999999",
      },
    );

    expect(result.handled).toBe("farmer");
    expect(await client()`select id from stock_out_reports`).toHaveLength(0);
    expect(await client()`
      select id from inventory_publication_proposals where state = 'open'
    `).toHaveLength(1);
  });

  it("keeps an ordinary customer question on the inquiry path", async () => {
    const senderHash = "e".repeat(64);
    const classifyCustomer = vi.fn(async () => ({
      ok: true as const,
      kind: "search_stands" as const,
      request: { operation: "inventory" as const },
    }));
    const customerClassifier = { classify: classifyCustomer };
    const match = vi.fn(async () => ({ ok: true as const, matches: [] }));

    const result = await handleFreeText(
      {
        db: database(),
        interpreter: { interpret: vi.fn() },
        catalogMatcher: { match },
        classifier: customerClassifier,
        stockOut: { parseItem: vi.fn() },
        clock: new FixedClock(T0),
      },
      {
        senderHash,
        taskText: "who has kale?",
        occurredAt: T0,
        providerEventId: "customer-question-1",
        inboxEventId: "55555555-5555-5555-5555-555555555555",
      },
    );

    // The whole reason this is a separate seam: the question path is untouched.
    expect(match).toHaveBeenCalledOnce();
    expect(result.handled).toBe("customer");
    expect(await client()`select id from stock_out_reports`).toHaveLength(0);
  });
});
