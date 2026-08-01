import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createInquiryModel,
  type LLMProvider,
  type ModelSafeContext,
} from "@farm-friend/ai";
import { FixedClock, PAGE_SIZE } from "@farm-friend/core";
import { createDb, type Db, type Sql } from "@farm-friend/db";
import { answerInquiry } from "./inquiry";
import { handleNextPage } from "./paging";

// F-046 part 3 — a question and its MORE, end to end against real Postgres.
//
// The gap parts 1-2 left: the renderer and the table existed and nothing connected them. So
// what this file proves is the CONNECTION — that answering a big question leaves a list
// behind, that MORE reads it and renders the next page with no model call at all, and that
// the eight cases in the PM item behave as specified against real rows rather than fixtures
// shaped to agree.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const customerHash = "9".repeat(64);
const otherCustomerHash = "8".repeat(64);
// Clock-derived, never a calendar literal (B-003).
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000);

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  readonly seen: ModelSafeContext[] = [];
  constructor(private readonly payloads: Record<string, string>) {}
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.seen.push(ctx);
    const payload = this.payloads[ctx.seam];
    if (payload === undefined) throw new Error(`no payload for seam ${ctx.seam}`);
    return payload;
  }
}

// There is deliberately no model stand-in for the pager below: `handleNextPage` takes no
// model dependency at all, so "MORE reaches no model" is a property of its SIGNATURE rather
// than of a seam that happens not to be called. `public-surface-model-free.test.ts` polices
// the same kind of claim for the map by import graph.

describe("SMS result paging end to end (integration)", () => {
  let adminClient: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;

  /** The nine stands the "eggs" fixture publishes as offerings, in seeded order. */
  const standNames = Array.from({ length: 9 }, (_, i) => `Stand Number ${i}`);
  let locationIds: string[] = [];

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    testDatabaseName = `farm_friend_paging_web_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = new URL(baseUrl);
    url.pathname = `/${testDatabaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    sql = postgres(url.toString(), { max: 4 });
    db = createDb(url.toString());
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (sql) await sql.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  function client(): Sql {
    if (!sql) throw new Error("test database is not initialized");
    return sql;
  }

  beforeEach(async () => {
    await client()`
      truncate table
        inventory_entries, inventory_revisions, inventory_publication_proposals,
        pending_result_lists, outbox_work, farm_approvals, farmer_authorizations,
        sales_location_offerings, sales_locations, administrators, farms, contacts
      restart identity cascade
    `;

    // Nine public stands, each with "eggs" as a standing offering. Nine is the real corpus's
    // leafy-greens count and exactly three pages at PAGE_SIZE — so exhaustion is reached
    // rather than approximated.
    locationIds = [];
    for (const [index, name] of standNames.entries()) {
      const farm = await client()`insert into farms (name) values (${name}) returning id`;
      const location = await client()`
        insert into sales_locations (
          owner_farm_id, kind, name, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (${farm[0]?.id as string}, 'farm_stand', ${name},
                ${`${10000 + index} SW 220th St`}, 47.45, -122.46, false, false)
        returning id
      `;
      const locationId = location[0]?.id as string;
      locationIds.push(locationId);
      await client()`
        insert into sales_location_offerings (sales_location_id, item, sort_order)
        values (${locationId}, 'eggs', 0)
      `;
    }
  });

  /**
   * Publish a current inventory revision at a seeded location, through the same columns the
   * real confirmation chain writes. Case 4 needs a stand whose eggs a farmer actually
   * CONFIRMED, so that "confirmed stock is never paged away" has something to be about.
   */
  async function publishEggs(index: number): Promise<void> {
    const locationId = locationIds[index]!;
    const farms = await client()`
      select owner_farm_id from sales_locations where id = ${locationId}
    `;
    const farmId = farms[0]?.owner_farm_id as string;

    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550999', ${"7".repeat(64)})
      returning id
    `;
    const contactId = contacts[0]?.id as string;
    const admins = await client()`
      insert into administrators (email, contact_id, authorized_at)
      values ('paging-admin@viga.example', ${contactId}, ${T0})
      returning id
    `;
    const auth = await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contactId}, ${T0}, ${T0})
      returning id
    `;
    const approval = await client()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${farmId}, ${admins[0]?.id as string}, ${T0})
      returning id
    `;
    const prompt = await client()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at,
        available_at, state, dispatch_authorized_at, completed_at
      )
      values (${`seed-${randomUUID()}`}, ${"7".repeat(64)}, 'inventory_confirmation',
              'Confirm', ${new Date(T0.getTime() + 172_800_000)}, ${T0}, 'sent', ${T0}, ${T0})
      returning id
    `;
    const proposal = await client()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version, proposal_version,
        yes_token, no_token, base_is_first_publication, state,
        activation_outbox_id, activated_version, activated_at, expires_at,
        consumed_token, consumption_provider_event_id, closed_at
      )
      values (
        ${"7".repeat(64)}, ${locationId}, ${client().json({ entries: [] })}, '1', 1,
        'YES', 'NO', true, 'accepted', ${prompt[0]?.id as string}, 1, ${T0},
        ${new Date(T0.getTime() + 3_600_000)}, 'yes', ${`ev-${randomUUID()}`}, ${T0}
      )
      returning id
    `;
    const revision = await client()`
      insert into inventory_revisions (
        farm_id, sales_location_id, proposal_id, published_by_authorization_id,
        farm_approval_id, published_at
      )
      values (${farmId}, ${locationId}, ${proposal[0]?.id as string},
              ${auth[0]?.id as string}, ${approval[0]?.id as string}, ${hoursAgo(2)})
      returning id
    `;
    await client()`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, quantity, unit, sort_order
      )
      values (${revision[0]?.id as string}, ${locationId}, 'eggs', 4, 'dozen', 0)
    `;
  }

  /** Ask a question whose selection returns every seeded stand, in seeded order. */
  async function askForEggs(
    senderHash: string,
    occurredAt: Date,
    factIds: string[] = locationIds.map((id) => `offering-${id}`),
  ) {
    const provider = new ScriptedProvider({
      "inquiry-interpretation": JSON.stringify({
        kind: "lookup",
        items: ["eggs"],
        ranking: "freshest",
      }),
      "grounded-fact-selection": JSON.stringify({ kind: "selection", factIds }),
    });
    return answerInquiry(
      {
        db: db as Db,
        model: createInquiryModel(provider),
        clock: new FixedClock(occurredAt),
      },
      { taskText: "any eggs?", senderHash, occurredAt },
    );
  }

  /** MORE, with a provider that detonates if paging ever reaches a model. */
  async function more(senderHash: string, occurredAt: Date) {
    return handleNextPage(
      {
        db: db as Db,
        clock: new FixedClock(occurredAt),
      },
      { senderHash, occurredAt },
    );
  }

  // ------------------------------------------------------------------- cases 2 and 3

  it("case 3 — a big answer shows the first page and saves the rest", async () => {
    const answer = await askForEggs(customerHash, T0);

    expect(answer.outcome).toBe("answered");
    if (answer.outcome !== "answered") return;
    expect(answer.body).toMatch(/1-3 of 9/);
    expect(answer.body).toMatch(/reply MORE/i);
    // Exactly PAGE_SIZE stands are named; the rest are not spent in this message.
    const named = standNames.filter((name) => answer.body.includes(name));
    expect(named).toHaveLength(PAGE_SIZE);

    const rows = await client()`
      select fact_ids, items_requested, "offset"
      from pending_result_lists where sender_hash = ${customerHash}
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0]?.fact_ids as string[]).length).toBe(9);
    expect(rows[0]?.offset).toBe(PAGE_SIZE);
    expect(rows[0]?.items_requested).toEqual(["eggs"]);
  });

  it("case 2 — an answer that fits saves nothing at all", async () => {
    // Paging machinery must not intrude on the common small case: no row, no MORE offer, no
    // count. A stored list nobody can page would also be a privacy cost with no benefit.
    const answer = await askForEggs(
      customerHash,
      T0,
      locationIds.slice(0, 3).map((id) => `offering-${id}`),
    );

    expect(answer.outcome).toBe("answered");
    if (answer.outcome !== "answered") return;
    expect(answer.body).not.toMatch(/MORE/i);

    const rows = await client()`
      select id from pending_result_lists where sender_hash = ${customerHash}
    `;
    expect(rows).toHaveLength(0);
  });

  it("case 1 — a question nothing matches saves nothing and offers no paging", async () => {
    const provider = new ScriptedProvider({
      "inquiry-interpretation": JSON.stringify({
        kind: "lookup",
        items: ["durian"],
        ranking: "freshest",
      }),
      "grounded-fact-selection": JSON.stringify({ kind: "selection", factIds: [] }),
    });
    const answer = await answerInquiry(
      { db: db as Db, model: createInquiryModel(provider), clock: new FixedClock(T0) },
      { taskText: "any durian?", senderHash: customerHash, occurredAt: T0 },
    );

    expect(answer.outcome).toBe("answered");
    if (answer.outcome !== "answered") return;
    expect(answer.body).not.toMatch(/MORE/i);
    const rows = await client()`
      select id from pending_result_lists where sender_hash = ${customerHash}
    `;
    expect(rows).toHaveLength(0);
  });

  // ------------------------------------------------------------------------ paging

  it("MORE returns the next page, with no model call anywhere on the path", async () => {
    await askForEggs(customerHash, T0);
    const page = await more(customerHash, at(1));

    expect(page.status).toBe("paged");
    expect(page.body).toMatch(/4-6 of 9/);
    expect(page.body).toContain(standNames[3]!);
    expect(page.body).toContain(standNames[5]!);
    // The first page's stands are not repeated.
    expect(page.body).not.toContain(standNames[0]!);
    expect(page.body).toMatch(/reply MORE/i);
  });

  it("case 5 — the last page closes with the map, and the list is spent", async () => {
    await askForEggs(customerHash, T0);
    await more(customerHash, at(1));
    const last = await more(customerHash, at(2));

    expect(last.status).toBe("paged");
    expect(last.body).toMatch(/7-9 of 9/);
    expect(last.body).not.toMatch(/reply MORE/i);
    expect(last.body).toMatch(/map/i);

    // Exhausted lists are deleted, so the next MORE is case 6 rather than an empty page.
    const rows = await client()`
      select id from pending_result_lists where sender_hash = ${customerHash}
    `;
    expect(rows).toHaveLength(0);

    const beyond = await more(customerHash, at(3));
    expect(beyond.status).toBe("no_pending_list");
  });

  it("case 4 — confirmed stock leads page one even when the model ranks it last", async () => {
    // THE guarantee: confirmed stock is what the customer actually wants, and it must never
    // be deferred to a page they may never ask for. The model here puts the one confirmed
    // stand DEAD LAST — a legitimate ordering it is entitled to propose — so if code did not
    // pull confirmed facts forward, that stand would land on page three.
    await publishEggs(8);
    const factIds = [
      ...locationIds.slice(0, 8).map((id) => `offering-${id}`),
      locationIds[8]!,
    ];
    const answer = await askForEggs(customerHash, T0, factIds);

    expect(answer.outcome).toBe("answered");
    if (answer.outcome !== "answered") return;
    // On page ONE, above the offerings, carrying its recency.
    expect(answer.body).toContain(standNames[8]!);
    expect(answer.body).toMatch(/updated 2 hours ago/);
    expect(answer.body.indexOf(standNames[8]!)).toBeLessThan(
      answer.body.indexOf(standNames[0]!),
    );

    // And it is not repeated on a later page, having already been shown.
    const page = await more(customerHash, at(1));
    expect(page.body).not.toContain(standNames[8]!);
  });

  it("case 6 — MORE with nothing pending answers honestly", async () => {
    const page = await more(customerHash, T0);
    expect(page.status).toBe("no_pending_list");
    expect(page.body).toMatch(/looking for/i);
    expect(page.body.length).toBeGreaterThan(0);
  });

  it("case 7 — a new question REPLACES the pending list", async () => {
    await askForEggs(customerHash, T0);
    // A second, smaller question. Its list is what MORE must page through afterwards.
    await askForEggs(
      customerHash,
      at(5),
      locationIds.slice(5, 9).map((id) => `offering-${id}`),
    );

    const rows = await client()`
      select fact_ids from pending_result_lists where sender_hash = ${customerHash}
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0]?.fact_ids as string[]).length).toBe(4);

    const page = await more(customerHash, at(6));
    expect(page.status).toBe("paged");
    // The fourth stand of the SECOND question, not the fourth of the first.
    expect(page.body).toContain(standNames[8]!);
    expect(page.body).not.toContain(standNames[3]!);
  });

  it("case 8 — a list older than its expiry pages nothing, and says so", async () => {
    await askForEggs(customerHash, T0);
    // Well past the TTL. Stale paging is worse than none: the answer may have changed.
    const page = await more(customerHash, at(24 * 60));

    expect(page.status).toBe("no_pending_list");
    expect(page.body).toMatch(/looking for/i);
    const rows = await client()`
      select id from pending_result_lists where sender_hash = ${customerHash}
    `;
    expect(rows).toHaveLength(0);
  });

  it("still pages a list inside its expiry window", async () => {
    // The complement of the case above, so it is not passing because everything expires.
    await askForEggs(customerHash, T0);
    const page = await more(customerHash, at(30));
    expect(page.status).toBe("paged");
  });

  it("keeps one customer's list out of another's MORE", async () => {
    await askForEggs(customerHash, T0);
    const page = await more(otherCustomerHash, at(1));
    expect(page.status).toBe("no_pending_list");
    // And the first customer's list is untouched by the stranger's MORE.
    const still = await more(customerHash, at(2));
    expect(still.status).toBe("paged");
    expect(still.body).toMatch(/4-6 of 9/);
  });

  // ------------------------------------------------------------- replay, not re-retrieval

  it("replays the saved list rather than re-running retrieval", async () => {
    // max, 2026-07-31. A stand that starts offering eggs mid-paging does NOT appear on page
    // two: identity and order are frozen at question time, which is what makes paging
    // consistent — no stand appearing twice, none skipped as ordering shifts.
    await askForEggs(customerHash, T0);

    const farm = await client()`insert into farms (name) values ('Latecomer Farm') returning id`;
    const location = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (${farm[0]?.id as string}, 'farm_stand', 'Latecomer Farm', '1 New Rd',
              47.45, -122.46, false, false)
      returning id
    `;
    await client()`
      insert into sales_location_offerings (sales_location_id, item, sort_order)
      values (${location[0]?.id as string}, 'eggs', 0)
    `;

    const page = await more(customerHash, at(1));
    expect(page.body).not.toContain("Latecomer Farm");
    // The total the customer was quoted does not move under them either.
    expect(page.body).toMatch(/of 9/);
  });

  it("drops a fact that has since gone unpublished rather than inventing it", async () => {
    // The values are dereferenced fresh at page time even though identity is frozen. A stand
    // withdrawn between page one and page two must not be rendered from a stale copy — the
    // table stores identifiers precisely so there is no copy to render from.
    await askForEggs(customerHash, T0);
    await client()`
      update sales_locations set is_public = false where id = ${locationIds[3]!}
    `;

    const page = await more(customerHash, at(1));
    expect(page.status).toBe("paged");
    expect(page.body).not.toContain(standNames[3]!);
    // The rest of the page still renders; one withdrawn stand does not sink the answer.
    expect(page.body).toContain(standNames[4]!);
  });

  it("skips a page that has become entirely unpublishable rather than sending an empty one", async () => {
    // All three of page two withdrawn. An empty page reads as "no results" to a customer,
    // which is a false claim — the honest move is to serve the next page that has content.
    await askForEggs(customerHash, T0);
    for (const id of locationIds.slice(3, 6)) {
      await client()`update sales_locations set is_public = false where id = ${id}`;
    }

    const page = await more(customerHash, at(1));
    expect(page.status).toBe("paged");
    expect(page.body).toContain(standNames[6]!);
  });

  it("stores no message text — only identifiers, the product words, and a position", async () => {
    // Golden Rule #5. The customer's question has a short retention life of its own; a copy
    // here would be a second, longer-lived home for it.
    await askForEggs(customerHash, T0);
    const rows = await client()`
      select * from pending_result_lists where sender_hash = ${customerHash}
    `;
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain("any eggs?");
    // The rendered reply is not stored either — it would carry the same text back.
    expect(stored).not.toMatch(/reply MORE/i);
    expect(stored).not.toContain("SW 220th St");
  });
});
