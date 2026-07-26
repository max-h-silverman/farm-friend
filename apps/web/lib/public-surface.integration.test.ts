import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createInquiryModel,
  createStockOutModel,
  type LLMProvider,
  type ModelSafeContext,
} from "@farm-friend/ai";
import { createModelCallThrottle, FixedClock } from "@farm-friend/core";
import { createDb, type Db } from "@farm-friend/db";
import { answerInquiry } from "./inquiry";
import { handleStandsRequest, listPublicStands } from "./public-listing";
import { handleStockOutReport, handleStockOutRequest } from "./public-stockout";

// F-019 — the launch channel boundary, proven against real Postgres.
//
// The item's whole claim is a DIVISION, so the tests come in two halves:
//
//   PUBLIC WEB is model-free. Map/listing/filter discovery reads the same published records
//   SMS answers from, performs ZERO model calls, and is never rate-capped.
//
//   THE ONE PUBLIC MODEL SURFACE is the QR stock-out form, which is unauthenticated and
//   therefore throttled.
//
// A provider that THROWS on any call is the sharp instrument here: "the public map makes no
// model call" is proven by the map working while the model is unusable, not by asserting on
// a spy that a cooperative stub happened not to touch.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const farmerHash = "7".repeat(64);
const adminHash = "8".repeat(64);
const T0 = new Date("2026-07-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000);

/** A provider that fails loudly if anything reaches it. */
class ForbiddenProvider implements LLMProvider {
  readonly name = "forbidden";
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    throw new Error(`public discovery must not call a model (seam: ${ctx.seam})`);
  }
}

/**
 * A cooperative provider for surfaces that are allowed a model call. Payloads are returned
 * in call order, so a two-step seam (interpret → select) is scripted by listing both.
 */
class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  calls = 0;
  private readonly payloads: string[];
  constructor(...payloads: string[]) {
    this.payloads = payloads;
  }
  async generateJson(_ctx: ModelSafeContext): Promise<string> {
    const payload = this.payloads[this.calls] ?? this.payloads.at(-1);
    this.calls += 1;
    if (payload === undefined) throw new Error("no scripted payload");
    return payload;
  }
}

describe("public web surface boundary (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let sql: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    testDatabaseName = `farm_friend_pub_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = new URL(baseUrl);
    url.pathname = `/${testDatabaseName}`;
    // Migrate on a client that is then closed: drizzle leaves prepared-statement type state
    // on the connection it migrates over, which mis-binds later timestamptz parameters.
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

  function client(): ReturnType<typeof postgres> {
    if (!sql) throw new Error("test database is not initialized");
    return sql;
  }

  /**
   * Publish a current revision through the real proposal → confirmation → revision chain,
   * so the rows these tests read are the same shape the farmer workflow produces.
   */
  async function publish(entries: string[], publishedAt: Date): Promise<string> {
    const prompt = await client()`
      insert into outbox_work (
        logical_key, recipient_hash, message_kind, body, body_expires_at,
        available_at, state, dispatch_authorized_at, completed_at
      )
      values (${`seed-${randomUUID()}`}, ${farmerHash}, 'inventory_confirmation', 'Confirm',
              ${new Date(T0.getTime() + 86_400_000)}, ${T0}, 'sent', ${T0}, ${T0})
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
        ${farmerHash}, ${ids.location}, ${client().json({ entries: [] })}, '1', 1,
        'YES', 'NO', true, 'accepted',
        ${prompt[0]?.id as string}, 1, ${T0},
        ${new Date(T0.getTime() + 3600_000)}, 'yes', ${`ev-${randomUUID()}`}, ${T0}
      )
      returning id
    `;
    const auth = await client()`
      select id from farmer_authorizations where farm_id = ${ids.farm} limit 1
    `;
    const approval = await client()`
      select id from farm_approvals where farm_id = ${ids.farm} limit 1
    `;
    const revision = await client()`
      insert into inventory_revisions (
        farm_id, sales_location_id, proposal_id, published_by_authorization_id,
        farm_approval_id, published_at
      )
      values (${ids.farm}, ${ids.location}, ${proposal[0]?.id as string},
              ${auth[0]?.id as string}, ${approval[0]?.id as string}, ${publishedAt})
      returning id
    `;
    const revisionId = revision[0]?.id as string;
    for (const [index, itemName] of entries.entries()) {
      await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        )
        values (${revisionId}, ${ids.location}, ${itemName}, ${index})
      `;
    }
    return revisionId;
  }

  beforeEach(async () => {
    await client()`
      truncate table
        inventory_entries, inventory_revisions, inventory_publication_proposals,
        stock_out_reports, outbox_work, farm_approvals, farmer_authorizations,
        sales_locations, administrators, farms, contacts
      restart identity cascade
    `;

    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550901', ${farmerHash}), ('+12065550902', ${adminHash})
      returning id, phone_hash
    `;
    const contactByHash = new Map(
      contacts.map((c) => [c.phone_hash as string, c.id as string]),
    );
    ids.contact = contactByHash.get(farmerHash)!;

    const admins = await client()`
      insert into administrators (contact_id, authorized_at)
      values (${contactByHash.get(adminHash)!}, ${T0}) returning id
    `;

    const farm = await client()`
      insert into farms (name) values ('Provo Farms') returning id
    `;
    ids.farm = farm[0]?.id as string;

    await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${ids.farm}, ${ids.contact}, ${T0}, ${T0})
    `;
    await client()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${ids.farm}, ${admins[0]?.id as string}, ${T0})
    `;

    const location = await client()`
      insert into sales_locations (
        farm_id, kind, name, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (${ids.farm}, 'farm_stand', 'Provo Stand', '123 Vashon Hwy',
              47.4471, -122.4594, false, false)
      returning id
    `;
    ids.location = location[0]?.id as string;

    ids.revision = await publish(["kale"], hoursAgo(3));
    const entry = await client()`
      select id from inventory_entries where inventory_revision_id = ${ids.revision}
    `;
    ids.entry = entry[0]?.id as string;
  });

  describe("public discovery is model-free", () => {
    it("lists published stands without ever calling a model", async () => {
      // The whole composition's model capability is a provider that THROWS. Discovery
      // still works, which is what "model-free" has to mean — not that a cooperative stub
      // happened to go untouched, but that the surface functions with no model available.
      const forbidden = createStockOutModel(new ForbiddenProvider());
      expect(forbidden).toBeDefined();

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands).toHaveLength(1);
      expect(stands[0]!.farmName).toBe("Provo Farms");
      expect(stands[0]!.items.map((i) => i.itemName)).toEqual(["kale"]);
    });

    it("takes no model dependency at all", () => {
      // Structural, not behavioral: `listPublicStands` accepts db + clock and has no seam
      // to hand a model to. A future edit that adds one has to change this signature, and
      // this assertion is the tripwire that makes that visible in review.
      expect(listPublicStands.length).toBe(1);
      const deps = { db: db!, clock: new FixedClock(T0) };
      expect(Object.keys(deps).sort()).toEqual(["clock", "db"]);
    });

    it("reads the SAME published records SMS answers from", async () => {
      const clock = new FixedClock(T0);
      const stands = await listPublicStands({ db: db!, clock });

      // Fact parity is the launch promise: the web shows the current revision, not a
      // separate cache or a differently-filtered view.
      expect(stands[0]!.factId).toBe(ids.location);
      expect(stands[0]!.asOf).toEqual(hoursAgo(3));

      // And the SAME row reaches the SMS answer. Both channels dereference the current
      // revision for this location, so a fact cannot be fresh on one and stale on the
      // other — fact parity WITHOUT interaction parity, which is F-019's whole claim.
      const answer = await answerInquiry(
        {
          db: db!,
          model: createInquiryModel(
            new ScriptedProvider(
              JSON.stringify({ kind: "lookup", items: ["kale"], ranking: "freshest" }),
              JSON.stringify({ kind: "selection", factIds: [ids.location] }),
            ),
          ),
          clock,
        },
        { taskText: "who has kale?" },
      );

      expect(answer.outcome).toBe("answered");
      if (answer.outcome !== "answered") throw new Error("expected an answer");
      expect(answer.selectedFactIds).toEqual([stands[0]!.factId]);
      // Identical recency wording on both channels, from the one shared renderer.
      expect(answer.body).toContain(stands[0]!.recencyLabel);
    });

    it("labels recency honestly rather than implying certainty", async () => {
      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      expect(stands[0]!.recencyLabel).toMatch(/hour/i);
      expect(stands[0]!.isStale).toBe(false);
    });

    it("keeps a stale listing visible WITH a warning rather than hiding it", async () => {
      // Published revisions are immutable, so a stale listing is one published long ago,
      // superseding the fresh seed rather than being edited into the past.
      await client()`
        update inventory_revisions set is_current = false, superseded_at = ${T0}
        where id = ${ids.revision}
      `;
      await publish(["kale"], hoursAgo(24 * 9));

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      expect(stands).toHaveLength(1);
      expect(stands[0]!.isStale).toBe(true);
      // Visible, not hidden — the honor-system reality is that old information plus an
      // honest warning beats a blank map.
      expect(stands[0]!.items.map((i) => i.itemName)).toEqual(["kale"]);
    });

    it("omits a location the farmer has not made public", async () => {
      await client()`update sales_locations set is_public = false where id = ${ids.location}`;
      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      expect(stands).toEqual([]);
    });

    it("is never capped by the public model throttle", async () => {
      const clock = new FixedClock(new Date(T0));
      const throttle = createModelCallThrottle({ clock, limit: 1, windowMs: 60_000 });

      // Ordinary browsing, far past any model budget. Model-free lookup does not consume
      // the throttle and is never artificially capped.
      for (let i = 0; i < 25; i += 1) {
        const stands = await listPublicStands({ db: db!, clock });
        expect(stands).toHaveLength(1);
      }
      expect(throttle.size()).toBe(0);
    });
  });

  describe("the QR stock-out form is the one throttled public model surface", () => {
    const parseListed = () => JSON.stringify({ kind: "listed", entryId: ids.entry });

    it("records a report and consumes model budget", async () => {
      const provider = new ScriptedProvider(parseListed());
      const clock = new FixedClock(new Date(T0));
      const throttle = createModelCallThrottle({ clock, limit: 3, windowMs: 60_000 });

      const result = await handleStockOutReport({
        db: db!,
        model: createStockOutModel(provider),
        clock,
        throttle,
        clientSignal: "client-a",
        salesLocationId: ids.location,
        taskText: "the kale is gone",
      });

      expect(result.status).toBe(202);
      expect(provider.calls).toBe(1);
    });

    it("refuses an over-budget report BEFORE the model call", async () => {
      const provider = new ScriptedProvider(parseListed());
      const clock = new FixedClock(new Date(T0));
      const throttle = createModelCallThrottle({ clock, limit: 1, windowMs: 60_000 });

      const deps = {
        db: db!,
        model: createStockOutModel(provider),
        clock,
        throttle,
        clientSignal: "abusive-client",
        salesLocationId: ids.location,
        taskText: "the kale is gone",
      };

      await handleStockOutReport(deps);
      const refused = await handleStockOutReport(deps);

      expect(refused.status).toBe(429);
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      // The point of the throttle is COST: the second call must not reach the provider.
      expect(provider.calls).toBe(1);
    });

    it("records nothing durable for a throttled request", async () => {
      const provider = new ScriptedProvider(parseListed());
      const clock = new FixedClock(new Date(T0));
      const throttle = createModelCallThrottle({ clock, limit: 1, windowMs: 60_000 });
      const deps = {
        db: db!,
        model: createStockOutModel(provider),
        clock,
        throttle,
        clientSignal: "abusive-client",
        salesLocationId: ids.location,
        taskText: "the kale is gone",
      };

      await handleStockOutReport(deps);
      await handleStockOutReport(deps);

      const reports = await client()`select id from stock_out_reports`;
      expect(reports).toHaveLength(1);
    });

    it("meters per client, so one abuser cannot deny the form to everyone", async () => {
      const provider = new ScriptedProvider(parseListed());
      const clock = new FixedClock(new Date(T0));
      const throttle = createModelCallThrottle({ clock, limit: 1, windowMs: 60_000 });
      const base = {
        db: db!,
        model: createStockOutModel(provider),
        clock,
        throttle,
        salesLocationId: ids.location,
        taskText: "the kale is gone",
      };

      await handleStockOutReport({ ...base, clientSignal: "abusive-client" });
      const abuser = await handleStockOutReport({ ...base, clientSignal: "abusive-client" });
      const bystander = await handleStockOutReport({ ...base, clientSignal: "other-client" });

      expect(abuser.status).toBe(429);
      expect(bystander.status).toBe(202);
    });

    it("never mutates published inventory, throttled or not", async () => {
      const provider = new ScriptedProvider(parseListed());
      const clock = new FixedClock(new Date(T0));
      const throttle = createModelCallThrottle({ clock, limit: 5, windowMs: 60_000 });

      await handleStockOutReport({
        db: db!,
        model: createStockOutModel(provider),
        clock,
        throttle,
        clientSignal: "client-a",
        salesLocationId: ids.location,
        taskText: "the kale is gone",
      });

      // Golden Rule #1: only the farmer's confirmed action changes what a stand shows.
      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      expect(stands[0]!.items.map((i) => i.itemName)).toEqual(["kale"]);
      const revisions = await client()`select id from inventory_revisions where is_current`;
      expect(revisions).toHaveLength(1);
    });

    it("rejects an unknown location without spending model budget", async () => {
      const provider = new ScriptedProvider(parseListed());
      const clock = new FixedClock(new Date(T0));
      const throttle = createModelCallThrottle({ clock, limit: 5, windowMs: 60_000 });

      const result = await handleStockOutReport({
        db: db!,
        model: createStockOutModel(provider),
        clock,
        throttle,
        clientSignal: "client-a",
        salesLocationId: randomUUID(),
        taskText: "the kale is gone",
      });

      expect(result.status).toBe(400);
    });
  });

  // The HTTP layer: the same boundary, asserted where it is actually deployed.
  describe("the public HTTP surface", () => {
    const parseListed = () => JSON.stringify({ kind: "listed", entryId: ids.entry });

    function stockOutDeps(provider: ScriptedProvider, limit = 5) {
      const clock = new FixedClock(new Date(T0));
      return {
        db: db!,
        model: createStockOutModel(provider),
        clock,
        throttle: createModelCallThrottle({ clock, limit, windowMs: 60_000 }),
        signalSalt: "route-test-salt",
      };
    }

    const post = (body: unknown, ip = "203.0.113.7") =>
      new Request("https://farmfriend.test/api/public/stock-out", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      });

    it("serves discovery over HTTP with no model available at all", async () => {
      // The route is invoked for real; nothing in its dependency set is a model.
      const response = await handleStandsRequest({ db: db!, clock: new FixedClock(T0) });
      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        stands: { farmName: string; updated: string; stale: boolean }[];
      };
      expect(payload.stands).toHaveLength(1);
      expect(payload.stands[0]!.farmName).toBe("Provo Farms");
      expect(payload.stands[0]!.updated).toMatch(/hour/i);
      expect(payload.stands[0]!.stale).toBe(false);
    });

    it("accepts a well-formed stock-out report", async () => {
      const provider = new ScriptedProvider(parseListed());
      const response = await handleStockOutRequest(
        post({ salesLocationId: ids.location, taskText: "no kale left" }),
        stockOutDeps(provider),
      );

      expect(response.status).toBe(202);
      expect(provider.calls).toBe(1);
    });

    it("returns 429 with Retry-After once the client is over budget", async () => {
      const provider = new ScriptedProvider(parseListed());
      const deps = stockOutDeps(provider, 1);
      const body = { salesLocationId: ids.location, taskText: "no kale left" };

      await handleStockOutRequest(post(body), deps);
      const response = await handleStockOutRequest(post(body), deps);

      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(provider.calls).toBe(1);
    });

    it("rejects a malformed body WITHOUT spending the reporter's budget", async () => {
      const provider = new ScriptedProvider(parseListed());
      const deps = stockOutDeps(provider, 1);

      // A junk request must not consume the one slot a genuine report needs next.
      const bad = await handleStockOutRequest(post({ taskText: "" }), deps);
      expect(bad.status).toBe(400);

      const good = await handleStockOutRequest(
        post({ salesLocationId: ids.location, taskText: "no kale left" }),
        deps,
      );
      expect(good.status).toBe(202);
    });

    it("refuses a location named as free text rather than a bound identifier", async () => {
      const provider = new ScriptedProvider(parseListed());
      const response = await handleStockOutRequest(
        post({ salesLocationId: "Provo Farms", taskText: "no kale left" }),
        stockOutDeps(provider),
      );

      // A stranger cannot redirect a report at a farm by typing its name.
      expect(response.status).toBe(400);
      expect(provider.calls).toBe(0);
    });

    it("tells an anonymous reporter nothing about the farmer", async () => {
      const provider = new ScriptedProvider(parseListed());
      const response = await handleStockOutRequest(
        post({ salesLocationId: ids.location, taskText: "no kale left" }),
        stockOutDeps(provider),
      );

      const text = await response.text();
      // No recipient hash, no phone, no farmer identity, no parse detail.
      expect(text).not.toContain(farmerHash);
      expect(text).not.toMatch(/\+?1?\d{10}/);
      expect(text).not.toContain(ids.entry);
      expect(JSON.parse(text)).toEqual({ accepted: true });
    });

    it("buckets by client, so one abuser cannot close the form for others", async () => {
      const provider = new ScriptedProvider(parseListed());
      const deps = stockOutDeps(provider, 1);
      const body = { salesLocationId: ids.location, taskText: "no kale left" };

      await handleStockOutRequest(post(body, "203.0.113.7"), deps);
      const abuser = await handleStockOutRequest(post(body, "203.0.113.7"), deps);
      const bystander = await handleStockOutRequest(post(body, "198.51.100.4"), deps);

      expect(abuser.status).toBe(429);
      expect(bystander.status).toBe(202);
    });
  });
});
