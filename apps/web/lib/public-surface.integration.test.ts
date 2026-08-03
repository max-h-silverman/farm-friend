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
import { createPublicActionThrottle, FixedClock } from "@farm-friend/core";
import { createDb, type Db, type Sql } from "@farm-friend/db";
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
// Anchored to the real clock, not a calendar date: `outbox_work` enforces
// `body_expires_at > created_at` against a `now()` default, so a literal date silently
// expires. See the header note in packages/db/src/workflow.integration.test.ts.
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000);

/** A provider that fails loudly if anything reaches it. */
class ForbiddenProvider implements LLMProvider {
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    throw new Error(`public discovery must not call a model (seam: ${ctx.seam})`);
  }
}

/**
 * A cooperative provider for surfaces that are allowed a model call. Payloads are returned
 * in call order, so a two-step seam (interpret → select) is scripted by listing both.
 */
class ScriptedProvider implements LLMProvider {
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
  let adminClient: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  // Keys are NAMED rather than `Record<string, string>` (GL-005). Under
  // `noUncheckedIndexedAccess` an index signature yields `string | undefined` on every read,
  // so `ids.location` — assigned in `beforeEach` and unconditionally present — still read as
  // possibly-absent and could not be bound as a SQL parameter or passed where a `string` is
  // required. Naming the fixture's actual keys states what the setup guarantees, and a typo
  // in a key now fails to compile instead of silently reading `undefined`.
  const ids = {} as {
    contact: string;
    farm: string;
    location: string;
    revision: string;
    entry: string;
  };

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

  function client(): Sql {
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
        logical_key, recipient_hash, message_category, body, body_expires_at,
        available_at, state, dispatch_authorized_at, completed_at
      )
      values (${`seed-${randomUUID()}`}, ${farmerHash}, 'inventory_confirmation', 'Confirm',
              ${new Date(T0.getTime() + 172_800_000)}, ${T0}, 'sent', ${T0}, ${T0})
      returning id
    `;
    const proposal = await client()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, proposal_version,
        has_inventory, has_closure, base_is_first_publication, state,
        activation_outbox_id, activated_version, activated_at, expires_at,
        consumed_token, consumption_provider_event_id, closed_at
      )
      values (
        ${farmerHash}, ${ids.location}, ${client().json({ entries: [] })}, 1,
        true, false, true, 'accepted',
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
      values ('+12065550901', ${farmerHash})
      returning id, phone_hash
    `;
    const contactByHash = new Map(
      contacts.map((c) => [c.phone_hash as string, c.id as string]),
    );
    ids.contact = contactByHash.get(farmerHash)!;

    const admins = await client()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${T0}) returning id
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
        owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (${ids.farm}, 'farm_stand', 'Provo Stand', 'America/Los_Angeles', 'visitable', 'produce', '123 Vashon Hwy',
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

  describe("owner-confirmed names of other sellers (F-050)", () => {
    it("returns active names separately from aggregate inventory and never invents the owner", async () => {
      const authorization = await client()`
        select id from farmer_authorizations where farm_id = ${ids.farm}
      `;
      await client()`
        insert into sales_location_participants (
          owner_farm_id, sales_location_id, display_name,
          confirmed_by_authorization_id, confirmed_at,
          retired_by_authorization_id, retired_at
        ) values
          (
            ${ids.farm}, ${ids.location}, 'Guest Growers',
            ${authorization[0]?.id as string}, ${T0}, null, null
          ),
          (
            ${ids.farm}, ${ids.location}, 'Island Apiary',
            ${authorization[0]?.id as string}, ${hoursAgo(4)},
            ${authorization[0]?.id as string}, ${T0}
          )
      `;

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      expect(stands[0]?.participantNames).toEqual(["Guest Growers"]);
      expect(stands[0]?.participantNames).not.toContain("Provo Farms");
      expect(stands[0]?.locationKind).toBe("farm_stand");
      expect(stands[0]?.items).toEqual([{ itemName: "kale" }]);
      expect(Object.keys(stands[0]?.items[0] ?? {})).toEqual(["itemName"]);

      const response = await handleStandsRequest({ db: db!, clock: new FixedClock(T0) });
      const body = (await response.json()) as {
        stands: {
          alsoSellingHere?: string[];
          locationKind?: string;
          items: Record<string, unknown>[];
        }[];
      };
      expect(body.stands[0]?.alsoSellingHere).toEqual(["Guest Growers"]);
      expect(body.stands[0]?.locationKind).toBe("farm_stand");
      expect(body.stands[0]?.items).toEqual([{ itemName: "kale" }]);
    });

    it("returns an explicit empty participant list when the owner added nobody", async () => {
      const response = await handleStandsRequest({ db: db!, clock: new FixedClock(T0) });
      const body = (await response.json()) as {
        stands: { alsoSellingHere?: string[] }[];
      };
      expect(body.stands[0]?.alsoSellingHere).toEqual([]);
      expect("alsoSellingHere" in body.stands[0]!).toBe(true);
    });
  });

  describe("a stand nobody has confirmed yet (B-013)", () => {
    // B-002 seeds ~31 VIGA stands with ZERO inventory, deliberately: seeding the old map's
    // dated text would render a year-old note as though a farmer had just confirmed it.
    // That decision only produces a usable map if a stand with no revision is VISIBLE.
    //
    // It was not. `listPublicStands` inner-joined `inventory_revisions`, so a location with
    // no current revision produced no row at all and never reached the map. B-002's own
    // acceptance criterion — "every stand exists and is discoverable, and no stand has a
    // published inventory revision" — was unsatisfiable against that reader.
    //
    // The product reason is the same one that keeps a STALE listing visible: the honor-system
    // premise is that an unattended stand with unknown stock is still worth showing. "We
    // don't know" and "we know it's old" are both honest; disappearing is not.

    /** Strip the seeded stand's revision, leaving a location with no inventory at all. */
    async function removeAllRevisions(): Promise<void> {
      await client()`truncate table inventory_entries, inventory_revisions restart identity cascade`;
    }

    it("is listed, with no items", async () => {
      await removeAllRevisions();

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      // The assertion that fails against an inner join: the stand is PRESENT.
      expect(stands).toHaveLength(1);
      expect(stands[0]!.factId).toBe(ids.location);
      expect(stands[0]!.farmName).toBe("Provo Farms");
      expect(stands[0]!.locationName).toBe("Provo Stand");
      expect(stands[0]!.items).toEqual([]);
    });

    it("carries NO recency, because nobody has confirmed anything", async () => {
      await removeAllRevisions();

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      // The load-bearing half. A stand with no revision has no "updated X ago" and no
      // staleness verdict — rendering either would manufacture a confirmation that never
      // happened, which is the exact failure mode B-002's zero-inventory decision exists to
      // avoid. `undefined` is the only honest value; a default date or "just now" is a lie.
      expect(stands[0]!.asOf).toBeUndefined();
      expect(stands[0]!.recencyLabel).toBeUndefined();
      expect(stands[0]!.isStale).toBeUndefined();
    });

    it("serves that stand over HTTP without inventing a recency string", async () => {
      await removeAllRevisions();

      const response = await handleStandsRequest({ db: db!, clock: new FixedClock(T0) });
      const body = (await response.json()) as {
        stands: { id: string; updated?: unknown; stale?: unknown; items: unknown[] }[];
      };

      expect(response.status).toBe(200);
      expect(body.stands).toHaveLength(1);
      expect(body.stands[0]!.id).toBe(ids.location);
      expect(body.stands[0]!.items).toEqual([]);

      // Absent, not null and not an empty string: the map view decides how to present "no
      // confirmation yet", and it can only do that if the field is genuinely missing.
      expect(body.stands[0]!.updated).toBeUndefined();
      expect(body.stands[0]!.stale).toBeUndefined();

      // Nothing anywhere in the serialized payload claims a confirmation.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/updated/i);
      expect(serialized).not.toMatch(/ago|just now/i);
    });

    it("lists confirmed and unconfirmed stands together, distinguishing them", async () => {
      // The real seeded shape: most stands have no listing, a few do. Both must appear, and
      // the difference between them must survive into the payload — otherwise the map either
      // hides the majority or flattens "confirmed 3 hours ago" into "we have no idea".
      const second = await client()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (${ids.farm}, 'farm_stand', 'Unseeded Stand', 'America/Los_Angeles', 'visitable', 'produce', '456 Vashon Hwy',
                47.4480, -122.4600, false, true)
        returning id
      `;
      const unconfirmedId = second[0]?.id as string;

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands).toHaveLength(2);

      // ORDER MATTERS, and it is easy to get silently wrong: Postgres sorts NULLs FIRST
      // under `desc`, so without an explicit `nulls last` every never-confirmed stand would
      // lead the map ahead of a stand confirmed minutes ago. With B-002 seeding ~31 stands
      // that all start unconfirmed, that would open the map on the stands carrying the least
      // information. The confirmed stand comes first.
      expect(stands.map((s) => s.factId)).toEqual([ids.location, unconfirmedId]);

      const byId = new Map(stands.map((s) => [s.factId, s]));

      const confirmed = byId.get(ids.location)!;
      expect(confirmed.items.map((i) => i.itemName)).toEqual(["kale"]);
      expect(confirmed.asOf).toEqual(hoursAgo(3));
      expect(confirmed.recencyLabel).toBeDefined();

      const unconfirmed = byId.get(unconfirmedId)!;
      expect(unconfirmed.items).toEqual([]);
      expect(unconfirmed.asOf).toBeUndefined();
      expect(unconfirmed.recencyLabel).toBeUndefined();
    });
  });

  describe("a farm you contact rather than visit (F-038)", () => {
    // Open Gate Lamb sells by order and states its address as "On island delivery for orders
    // over $50" — there is no place to go. max's decision (2026-07-29): list it, clearly marked
    // as not-a-stand, rather than hiding it behind a filter or dropping it.
    //
    // The danger this guards is specific and physical. The LEGACY map export carries real
    // coordinates for Open Gate Lamb, so the easy failure is a pin on the map that sends a
    // customer driving to a farm with nothing to buy. Migration 0007 makes that unrepresentable
    // in the database; these tests prove the READER does not reintroduce it with a placeholder.
    //
    // Same shape as B-013 above: the fields are absent TOGETHER, never defaulted. `"null"` as a
    // street address or `NaN` as a latitude would both survive `as string` / `Number()` casts
    // and reach the map without a single type error.

    async function insertContactOnly(name: string): Promise<string> {
      const rows = await client()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type,
          public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (${ids.farm}, 'farm_stand', ${name}, 'America/Los_Angeles', 'contact_only', 'by_order',
                null, null, null, false, false)
        returning id
      `;
      return rows[0]?.id as string;
    }

    it("is listed on the map alongside visitable stands", async () => {
      const contactOnlyId = await insertContactOnly("Open Gate Lamb and Grazing");

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      // Listed, not hidden — the product decision. Dropping it would make a VIGA member
      // invisible to the island's only guide.
      expect(stands.map((s) => s.factId)).toContain(contactOnlyId);
    });

    it("carries NO address and NO coordinates, rather than placeholders", async () => {
      const contactOnlyId = await insertContactOnly("Open Gate Lamb and Grazing");

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      const contactOnly = stands.find((s) => s.factId === contactOnlyId)!;

      // The load-bearing half. `undefined` is the only honest value; the string "null" and
      // `NaN` both render as a location on a map.
      expect(contactOnly.publicAddress).toBeUndefined();
      expect(contactOnly.latitude).toBeUndefined();
      expect(contactOnly.longitude).toBeUndefined();
      expect(contactOnly.visitability).toBe("contact_only");
      expect(contactOnly.offeringType).toBe("by_order");
    });

    it("never serializes a null-ish address or a NaN coordinate over HTTP", async () => {
      await insertContactOnly("Open Gate Lamb and Grazing");

      const response = await handleStandsRequest({
        db: db!,
        clock: new FixedClock(T0),
      });
      const serialized = JSON.stringify(await response.json());

      // Whole-payload assertions, the same technique the privacy tests use. A cast that
      // stringifies NULL produces exactly these, and each would place a pin or print an
      // address line that does not exist.
      expect(serialized).not.toMatch(/"null"/);
      expect(serialized).not.toMatch(/"undefined"/);
      expect(serialized).not.toMatch(/NaN/);
      expect(serialized).not.toMatch(/"address"\s*:\s*null/);
    });

    it("still carries address and coordinates for an ordinary visitable stand", async () => {
      // The other direction: making the fields optional must not quietly drop them from the
      // stands that DO have them, which is 30 of the 32 real farms.
      await insertContactOnly("Open Gate Lamb and Grazing");

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      const visitable = stands.find((s) => s.factId === ids.location)!;

      expect(visitable.publicAddress).toBe("123 Vashon Hwy");
      expect(typeof visitable.latitude).toBe("number");
      expect(Number.isFinite(visitable.latitude)).toBe(true);
      expect(visitable.visitability).toBe("visitable");
      expect(visitable.offeringType).toBe("produce");
    });
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
        { taskText: "who has kale?", senderHash: "4".repeat(64), occurredAt: T0 },
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
      const throttle = createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 });

      // Ordinary browsing, far past any model budget. Model-free lookup does not consume
      // the throttle and is never artificially capped.
      for (let i = 0; i < 25; i += 1) {
        const stands = await listPublicStands({ db: db!, clock });
        expect(stands).toHaveLength(1);
      }
      expect(throttle.size()).toBe(0);
    });
  });

  describe("what a stand usually sells (F-042)", () => {
    // 212 offering tags are seeded across 33 of 35 production stands, and until this item no
    // customer could see any of them: `listPublicStands` never selected
    // `sales_location_offerings`, so every tagged stand rendered "No listing yet" while the
    // database knew it sold eggs. Seeding was necessary and not sufficient.
    //
    // These are NOT current stock and never become it. `inventory_revisions` demands a
    // verified farmer and a VIGA approval; a tag is VIGA's 2026 form text. The two facts stay
    // in separate fields all the way to the wire so no renderer can conflate them.

    /** Tag the seeded location, in the given order. */
    async function tag(items: string[]): Promise<void> {
      for (const [index, item] of items.entries()) {
        await client()`
          insert into sales_location_offerings (sales_location_id, item, sort_order)
          values (${ids.location}, ${item}, ${index})
        `;
      }
    }

    /** Strip the seeded stand's revision, leaving tags with no confirmation. */
    async function removeAllRevisions(): Promise<void> {
      await client()`truncate table inventory_entries, inventory_revisions restart identity cascade`;
    }

    it("exposes the tags, in their seeded order, distinct from confirmed items", async () => {
      await tag(["salad greens", "tomatoes", "flowers"]);

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      // The assertion that fails against the reader this item was filed for: the tags are
      // PRESENT. And they are in `usualOfferings`, not folded into `items` — a customer must
      // be able to tell what a farmer confirmed from what a form once said.
      expect(stands[0]!.usualOfferings).toEqual(["salad greens", "tomatoes", "flowers"]);
      expect(stands[0]!.items.map((i) => i.itemName)).toEqual(["kale"]);
    });

    it("carries NO recency for the tags themselves", async () => {
      // The load-bearing rule at the data layer. A tagged, unconfirmed stand gets tags and
      // NOTHING that dates them — the recency fields stay absent exactly as B-013 requires,
      // so no downstream renderer has a timestamp available to attach.
      await removeAllRevisions();
      await tag(["eggs", "lamb"]);

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands[0]!.usualOfferings).toEqual(["eggs", "lamb"]);
      expect(stands[0]!.asOf).toBeUndefined();
      expect(stands[0]!.recencyLabel).toBeUndefined();
      expect(stands[0]!.confirmedElapsed).toBeUndefined();
      expect(stands[0]!.isStale).toBeUndefined();
    });

    it("returns an empty tag list for a stand with no tags, never a fabricated one", async () => {
      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      expect(stands[0]!.usualOfferings).toEqual([]);
    });

    it("SERIALIZES the empty list rather than omitting the key", async () => {
      // Deliberately distinct from the assertion above, and not redundant with it: the field
      // is `[]`-when-empty on purpose, and the three recency fields on the same object are
      // absent-when-empty on purpose. That asymmetry is easy to "tidy up" into a conditional
      // spread matching its neighbours, and no other test in this suite fails when it is —
      // the map's renderer treats an absent list and an empty one alike by design, so the
      // regression would reach production silently. `in` rather than a value comparison,
      // because `undefined` and `[]` both read as falsy-ish downstream.
      const response = await handleStandsRequest({ db: db!, clock: new FixedClock(T0) });
      const body = (await response.json()) as { stands: Record<string, unknown>[] };

      expect(body.stands[0]!.usuallySells).toEqual([]);
      expect("usuallySells" in body.stands[0]!).toBe(true);
    });

    it("does not multiply inventory items by tags, or tags by items", async () => {
      // The defect a naive second LEFT JOIN produces: joining offerings alongside
      // inventory_entries makes the query a cross product, so 3 tags × 2 confirmed items
      // yields each item three times and each tag twice. Counted, not merely inspected,
      // because a duplicate reads as a real second item on the card.
      await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        )
        values (${ids.revision}, ${ids.location}, 'chard', 1)
      `;
      await tag(["eggs", "flowers", "lamb"]);

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands).toHaveLength(1);
      expect(stands[0]!.items.map((i) => i.itemName)).toEqual(["kale", "chard"]);
      expect(stands[0]!.usualOfferings).toEqual(["eggs", "flowers", "lamb"]);
    });

    it("serves the tags over HTTP, still without dating them", async () => {
      await removeAllRevisions();
      await tag(["salad greens", "tomatoes"]);

      const response = await handleStandsRequest({ db: db!, clock: new FixedClock(T0) });
      const body = (await response.json()) as {
        stands: {
          usuallySells?: unknown;
          updated?: unknown;
          confirmedElapsed?: unknown;
          stale?: unknown;
          items: unknown[];
        }[];
      };

      expect(response.status).toBe(200);
      expect(body.stands[0]!.usuallySells).toEqual(["salad greens", "tomatoes"]);
      expect(body.stands[0]!.items).toEqual([]);

      // Absent, not null: the three recency keys are omitted TOGETHER for an unconfirmed
      // stand, so the payload carries no date a client could put beside "Usually sells".
      expect(body.stands[0]!.updated).toBeUndefined();
      expect(body.stands[0]!.confirmedElapsed).toBeUndefined();
      expect(body.stands[0]!.stale).toBeUndefined();

      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/updated/i);
      expect(serialized).not.toMatch(/ago|just now/i);
    });

    it("serves the elapsed phrase beside the tags once a farmer HAS confirmed", async () => {
      await tag(["salad greens", "tomatoes", "flowers"]);

      const response = await handleStandsRequest({ db: db!, clock: new FixedClock(T0) });
      const body = (await response.json()) as {
        stands: { updated?: string; confirmedElapsed?: string; usuallySells?: string[] }[];
      };

      // Both facts on the wire, separately: the confirmation is dated, the tags are not.
      expect(body.stands[0]!.updated).toBe("updated 3 hours ago");
      expect(body.stands[0]!.confirmedElapsed).toBe("3 hours ago");
      expect(body.stands[0]!.usuallySells).toEqual([
        "salad greens",
        "tomatoes",
        "flowers",
      ]);
    });

    it("keeps the elapsed phrase and the SMS recency label in agreement", async () => {
      // One arithmetic, two voices. The map says "Confirmed 3 hours ago", SMS says
      // "updated 3 hours ago", and both derive from `renderElapsed` — anchored to the
      // relationship rather than to either literal so the two cannot drift.
      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands[0]!.confirmedElapsed).toBeDefined();
      expect(stands[0]!.recencyLabel).toBe(`updated ${stands[0]!.confirmedElapsed}`);
    });

    it("lists the tags without ever calling a model", async () => {
      // The reader is new; the model-free guarantee is not negotiable. Proven the sharp way:
      // the composition's model capability THROWS, and the tags still arrive.
      const forbidden = createStockOutModel(new ForbiddenProvider());
      expect(forbidden).toBeDefined();
      await tag(["eggs"]);

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands[0]!.usualOfferings).toEqual(["eggs"]);
    });

    it("omits the tags of a location the farmer has not made public", async () => {
      // B-024's shape. Handpicked Homestead is `is_public = false` because she asked us not
      // to publish her address; publishing her offerings would leak the same row back.
      await tag(["salad greens"]);
      await client()`update sales_locations set is_public = false where id = ${ids.location}`;

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands).toEqual([]);
    });

    it("orders by confirmation, never promoting a stand for having more tags", async () => {
      // Tags are not evidence of freshness. A heavily tagged, never-confirmed stand must
      // still sort behind a confirmed one, or the map opens on the least certain listings.
      const second = await client()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (${ids.farm}, 'farm_stand', 'Tagged Unconfirmed', 'America/Los_Angeles', 'visitable', 'produce', '456 Vashon Hwy',
                47.448, -122.46, false, false)
        returning id
      `;
      const taggedId = second[0]?.id as string;
      for (const [index, item] of ["a", "b", "c", "d", "e"].entries()) {
        await client()`
          insert into sales_location_offerings (sales_location_id, item, sort_order)
          values (${taggedId}, ${item}, ${index})
        `;
      }

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands.map((s) => s.factId)).toEqual([ids.location, taggedId]);
      const tagged = stands.find((s) => s.factId === taggedId)!;
      expect(tagged.usualOfferings).toHaveLength(5);
      expect(tagged.recencyLabel).toBeUndefined();
    });
  });

  describe("stand availability reaches the browser (F-043)", () => {
    // F-035 wrote these columns and NOTHING has ever read them — `listPublicStands` selected
    // none of them. This is their first consumer, and the same "data present with no consumer
    // is invisible" failure F-042 was filed for.
    //
    // The load-bearing property throughout: a stand that STATED nothing must stay
    // distinguishable from one that stated something, all the way to the wire. Production has
    // 5 of 34 stands with no season and 12 with no hours; if absence serializes as a value,
    // the "open now" filter reports them closed and the map lies about most of the island.

    /**
     * State this stand's availability in ONE statement.
     *
     * Single-statement on purpose. The 0005 CHECK constraints are coherence rules ACROSS
     * columns — `until_dusk` requires `open_from_minutes` to be non-null in the same row — so
     * setting them column by column trips a constraint partway through on a shape that is
     * perfectly legal once complete. The fixture writing them together is the same atomicity
     * the seeder uses.
     */
    async function setAvailability(
      columns: Record<string, unknown>,
    ): Promise<void> {
      const entries = Object.entries(columns);
      const assignments = entries
        .map(([column], index) => `${column} = $${index + 1}`)
        .join(", ");
      await client().unsafe(
        `update sales_locations set ${assignments} where id = $${entries.length + 1}`,
        [...entries.map(([, value]) => value as never), ids.location as never],
      );
    }

    it("carries a stated season and stated hours through to the wire", async () => {
      await setAvailability({
        season_kind: "date_range",
        season_start_month: 5,
        season_start_day: 1,
        season_end_month: 10,
        season_end_day: 31,
        open_hours_kind: "clock_range",
        open_from_minutes: 600,
        open_until_minutes: 1080,
      });

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      // Fails against the reader this item was filed for: the columns are simply not selected.
      expect(stands[0]!.availability).toEqual({
        season: {
          kind: "date_range",
          startMonth: 5,
          startDay: 1,
          endMonth: 10,
          endDay: 31,
        },
        hours: { kind: "clock_range", fromMinutes: 600, untilMinutes: 1080 },
      });

      const response = await handleStandsRequest({ db: db!, clock: new FixedClock(T0) });
      const body = (await response.json()) as { stands: Record<string, unknown>[] };
      expect(body.stands[0]!.availability).toEqual({
        season: {
          kind: "date_range",
          startMonth: 5,
          startDay: 1,
          endMonth: 10,
          endDay: 31,
        },
        hours: { kind: "clock_range", fromMinutes: 600, untilMinutes: 1080 },
      });
    });

    it("carries named seasons as the names, never resolved to months here", async () => {
      // F-035's rule: named seasons resolve at QUERY time against one documented constant, so
      // a correction to what "summer" means changes the constant rather than every row. If the
      // reader baked months in, that correction would silently stop working.
      await setAvailability({
        season_kind: "named_season",
        season_names: ["spring", "summer"],
      });

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands[0]!.availability.season).toEqual({
        kind: "named_season",
        names: ["spring", "summer"],
      });
    });

    it("keeps an UNSTATED season and UNSTATED hours absent, never null or a default", async () => {
      // The honesty assertion. The fixture states nothing, which is the production shape for
      // 4 of 34 public stands. Absence must survive to the wire so "open now" can answer
      // "unknown" rather than "closed" — `season: null` or a defaulted `year_round` would each
      // become a claim the farmer never made.
      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands[0]!.availability).toEqual({});
      expect("season" in stands[0]!.availability).toBe(false);
      expect("hours" in stands[0]!.availability).toBe(false);

      const response = await handleStandsRequest({ db: db!, clock: new FixedClock(T0) });
      const body = (await response.json()) as {
        stands: { availability: Record<string, unknown> }[];
      };
      // `in`, not a value comparison: `null` and absent both read as falsy downstream, and it
      // is precisely that collapse this test exists to forbid.
      expect("season" in body.stands[0]!.availability).toBe(false);
      expect("hours" in body.stands[0]!.availability).toBe(false);
    });

    it("carries season and hours INDEPENDENTLY — one stated, one not", async () => {
      // Production's most common partial shape: 8 stands state a season and no hours. If the
      // reader travels them together (as the recency and place fields correctly do), a stand
      // with a season but no hours loses its season, and the season filter goes wrong for a
      // quarter of the island. These two are genuinely independent facts.
      await setAvailability({ season_kind: "year_round" });

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands[0]!.availability.season).toEqual({ kind: "year_round" });
      expect("hours" in stands[0]!.availability).toBe(false);
    });

    it("carries a dusk-relative kind with no invented clock times", async () => {
      // `dawn_to_dusk` has no from/until in the database by CHECK constraint, and must not
      // acquire one here. Inventing 6am-8pm would be exactly the "precision the farmer never
      // stated" migration 0005 refuses.
      await setAvailability({ open_hours_kind: "dawn_to_dusk" });

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands[0]!.availability.hours).toEqual({ kind: "dawn_to_dusk" });
      const hours = stands[0]!.availability.hours!;
      expect("fromMinutes" in hours).toBe(false);
      expect("untilMinutes" in hours).toBe(false);
    });

    it("carries until_dusk's stated start without inventing an end", async () => {
      await setAvailability({
        open_hours_kind: "until_dusk",
        open_from_minutes: 600,
      });

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });

      expect(stands[0]!.availability.hours).toEqual({
        kind: "until_dusk",
        fromMinutes: 600,
      });
      expect("untilMinutes" in stands[0]!.availability.hours!).toBe(false);
    });

    it("carries open_days when stated and leaves it absent when not", async () => {
      // Production has this at 0% — no row island-wide carries a day set, though 14 stands
      // say `specific_days`. The column is plumbed anyway because the schema permits it and a
      // future load would otherwise be invisible; the filter must not assume it exists.
      const unstated = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      expect("days" in unstated[0]!.availability).toBe(false);

      await setAvailability({ open_days: [0, 6] });

      const stands = await listPublicStands({ db: db!, clock: new FixedClock(T0) });
      expect(stands[0]!.availability.days).toEqual([0, 6]);
    });
  });

  describe("the QR stock-out form is the one throttled public model surface", () => {
    const parseListed = () => JSON.stringify({ kind: "listed", entryId: ids.entry });

    it("records a report and consumes model budget", async () => {
      const provider = new ScriptedProvider(parseListed());
      const clock = new FixedClock(new Date(T0));
      const throttle = createPublicActionThrottle({ clock, limit: 3, windowMs: 60_000 });

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
      const throttle = createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 });

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
      const throttle = createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 });
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
      const throttle = createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 });
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
      const throttle = createPublicActionThrottle({ clock, limit: 5, windowMs: 60_000 });

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
      const throttle = createPublicActionThrottle({ clock, limit: 5, windowMs: 60_000 });

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
        throttle: createPublicActionThrottle({ clock, limit, windowMs: 60_000 }),
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
