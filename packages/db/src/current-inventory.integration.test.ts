import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentEntriesJoin,
  currentInventoryJoin,
  readCurrentInventory,
  readCurrentRevisionRef,
} from "./current-inventory";
import type { Sql } from "./sql";

/*
  B-074 — the golden-output gate for F-114 Phase A.

  THE THING THIS TEST HAS TO PROVE is not that the shared reader works. It is that the shared
  reader returns EXACTLY what the SQL it replaced returned, per enumerated site, against a
  populated database. A reader that is merely correct-looking would let the consolidation change
  the map or an SMS answer silently, which is the one outcome Phase A is forbidden to produce.

  So every case below holds the ORIGINAL SQL verbatim — copied from the site as it stood at
  eca6c24 — runs it and the shared reader against the same rows, and compares. When the two
  disagree, the test names which site regressed.

  ## Why the original SQL is duplicated here rather than imported

  Because it no longer exists anywhere else after the move. An imported "old implementation" kept
  alive beside the new one is a second way to do one thing (CLAUDE.md), and it would drift.
  Frozen literal text in a test is the record of what the output USED to be — which is what a
  golden test is.

  ## The corpus is deliberately awkward

  A stand with entries and no closure; a stand with a superseded revision AND a current one, so
  a query that forgot `is_current` returns the wrong rows rather than no rows; a stand that never
  published; a stand whose entries share a `sort_order`, so an unstable order is visible; entries
  with every nullable column both null and set. A cooperative fixture would let every one of
  these regressions pass.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("B-074 shared current-inventory reader (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let farmId = "";
  /** Entries, a superseded predecessor, mixed nulls, and a duplicated sort_order. */
  let richLocationId = "";
  /** Current revision with zero entries — publication is not the same as having stock. */
  let emptyLocationId = "";
  /** Never published at all. */
  let unpublishedLocationId = "";
  let currentRevisionId = "";
  let supersededRevisionId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_curinv_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });

    const db = client();
    const farms = await db`
      insert into farms (name) values ('Golden Farm') returning id
    `;
    farmId = farms[0]?.id as string;

    // `visitable` carries an address and a coordinate pair, because
    // `sales_locations_coherent_visitability` requires them — a visitable stand with nowhere to
    // go is refused by the database, not by convention.
    const mkLocation = async (name: string): Promise<string> => {
      const rows = await db`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          ${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          ${`${name} Road, Vashon WA`}, 47.4473, -122.4590
        )
        returning id
      `;
      return rows[0]?.id as string;
    };
    // Named so the admin roster's `order by location.name` is a known sequence: Empty, Quiet,
    // Rich. The roster assertion depends on that ordering being stable, not on insert order.
    richLocationId = await mkLocation("Rich Stand");
    emptyLocationId = await mkLocation("Empty Stand");
    unpublishedLocationId = await mkLocation("Quiet Stand");

    // THE SUPERSEDED PREDECESSOR. Its entries are deliberately DIFFERENT from the current
    // revision's, so a reader that drops `is_current` returns visibly wrong rows instead of
    // an empty result that a lenient assertion might tolerate.
    // `source = 'viga'` throughout, because `inventory_revisions_source_keys_coherent` is a
    // biconditional: an 'sms' or 'web' revision REQUIRES an authorization and an approval, and
    // this fixture is about currency, not provenance. Using 'viga' keeps the three key columns
    // legitimately null instead of manufacturing an authorization chain the test never reads.
    const superseded = await db`
      insert into inventory_revisions (
        farm_id, sales_location_id, source, published_at, is_current, superseded_at
      ) values (
        ${farmId}, ${richLocationId}, 'viga', now() - interval '10 days',
        false, now() - interval '2 days'
      ) returning id
    `;
    supersededRevisionId = superseded[0]?.id as string;
    await db`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, sort_order
      ) values (
        ${supersededRevisionId}, ${richLocationId}, 'STALE PARSNIPS', 0
      )
    `;

    const current = await db`
      insert into inventory_revisions (
        farm_id, sales_location_id, source, published_at, is_current
      ) values (
        ${farmId}, ${richLocationId}, 'viga', now() - interval '2 days', true
      ) returning id
    `;
    currentRevisionId = current[0]?.id as string;

    // Every nullable column both null and set, and TWO entries sharing sort_order 1 so an
    // order that is not total is visible as a flapping result rather than a stable wrong one.
    await db`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, quantity, unit,
        price_text, approximation, sort_order
      ) values
        (${currentRevisionId}, ${richLocationId}, 'Eggs', 3, 'dozen', '$8', 'limited', 0),
        (${currentRevisionId}, ${richLocationId}, 'Kale', null, null, null, null, 1),
        (${currentRevisionId}, ${richLocationId}, 'Cucumbers', 12, null, '$2 each', 'plentiful', 1)
    `;

    await db`
      insert into inventory_revisions (
        farm_id, sales_location_id, source, published_at, is_current
      ) values (
        ${farmId}, ${emptyLocationId}, 'viga', now() - interval '1 day', true
      )
    `;
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  /*
    ============================================================================
    Sites 9–12 — the revision identity, `readCurrentRevisionRef`.

    transactions.ts:746 (unlocked), transactions.ts:956, transactions.ts:1384 and farmer.ts:621
    (all `for update`). Their original SQL differs only in the lock and in whether it selected
    `published_at` alongside `id`.
    ============================================================================
  */
  describe("site 9-12 — readCurrentRevisionRef", () => {
    it("returns the same revision the original unlocked SQL returned", async () => {
      // transactions.ts:746 verbatim.
      const original = await client()`
        select id from inventory_revisions
        where sales_location_id = ${richLocationId} and is_current
      `;
      const shared = await readCurrentRevisionRef(client(), {
        salesLocationId: richLocationId,
        lock: false,
      });
      expect(original[0]?.id).toBe(currentRevisionId);
      expect(shared?.revisionId).toBe(original[0]?.id as string);
    });

    it("returns the same revision the original locked SQL returned", async () => {
      // farmer.ts:621 verbatim, inside a transaction because `for update` requires one.
      await client().begin(async (tx) => {
        const original = await tx`
          select id from inventory_revisions
          where sales_location_id = ${richLocationId} and is_current
          for update
        `;
        const shared = await readCurrentRevisionRef(tx as unknown as Sql, {
          salesLocationId: richLocationId,
          lock: true,
        });
        expect(shared?.revisionId).toBe(original[0]?.id as string);
      });
    });

    it("carries published_at, which scheduled-prompts reads for the cadence reset", async () => {
      // scheduled-prompts.ts:148 and packages/db/src/scheduled-prompts.ts:71 verbatim.
      const original = await client()`
        select id, published_at from inventory_revisions
        where sales_location_id = ${richLocationId} and is_current
      `;
      const shared = await readCurrentRevisionRef(client(), {
        salesLocationId: richLocationId,
        lock: false,
      });
      expect(shared?.publishedAt).toEqual(original[0]?.published_at as Date);
    });

    it("returns null for a stand that never published, as the original's empty result did", async () => {
      const original = await client()`
        select id from inventory_revisions
        where sales_location_id = ${unpublishedLocationId} and is_current
      `;
      expect(original).toHaveLength(0);
      expect(
        await readCurrentRevisionRef(client(), {
          salesLocationId: unpublishedLocationId,
          lock: false,
        }),
      ).toBeNull();
    });

    it("never returns the superseded predecessor", async () => {
      const shared = await readCurrentRevisionRef(client(), {
        salesLocationId: richLocationId,
        lock: false,
      });
      expect(shared?.revisionId).not.toBe(supersededRevisionId);
    });

    it("takes a real row lock when asked, and none when not", async () => {
      // The lock is a GUARANTEE (B-070), so it is measured rather than trusted: a second
      // session's `for update ... nowait` on the same row must fail while the first holds it,
      // and must succeed when the first read unlocked.
      const locked = await client().begin(async (tx) => {
        await readCurrentRevisionRef(tx as unknown as Sql, {
          salesLocationId: richLocationId,
          lock: true,
        });
        try {
          await client()`
            select id from inventory_revisions
            where id = ${currentRevisionId} for update nowait
          `;
          return false;
        } catch {
          return true;
        }
      });
      expect(locked).toBe(true);

      const unlocked = await client().begin(async (tx) => {
        await readCurrentRevisionRef(tx as unknown as Sql, {
          salesLocationId: richLocationId,
          lock: false,
        });
        try {
          await client()`
            select id from inventory_revisions
            where id = ${currentRevisionId} for update nowait
          `;
          return false;
        } catch {
          return true;
        }
      });
      expect(unlocked).toBe(false);
    });
  });

  /*
    ============================================================================
    Sites 4-7 — the stand-scoped entry read, `readCurrentInventory`.
    ============================================================================
  */
  describe("site 4-7 — readCurrentInventory", () => {
    it("returns byte-identical entries to farmer-stand.ts:129's original SQL", async () => {
      // farmer-stand.ts:129 verbatim — the farmer stand/settings editor prefill and the
      // post-publish refresh both run this.
      const original = await client()`
        select entry.id, entry.item_name, entry.quantity, entry.unit,
          entry.price_text, entry.approximation
        from inventory_entries entry
        join inventory_revisions revision on revision.id = entry.inventory_revision_id
        where revision.sales_location_id = ${richLocationId} and revision.is_current
        order by entry.sort_order asc
      `;
      const shared = await readCurrentInventory(client(), {
        salesLocationId: richLocationId,
      });
      expect(shared).not.toBeNull();
      expect(shared?.entries.map((e) => e.itemName).sort()).toEqual(
        original.map((r) => r.item_name as string).sort(),
      );
      // Every column, value by value — a shape assertion would pass on nulls where the
      // original returned values.
      const byId = new Map(
        original.map((r) => [r.id as string, r as Record<string, unknown>]),
      );
      for (const entry of shared?.entries ?? []) {
        const row = byId.get(entry.entryId);
        expect(row).toBeDefined();
        expect(entry.itemName).toBe(row?.item_name);
        expect(entry.quantity).toBe(
          row?.quantity === null ? null : Number(row?.quantity),
        );
        expect(entry.unit).toBe(row?.unit ?? null);
        expect(entry.priceText).toBe(row?.price_text ?? null);
        expect(entry.approximation).toBe(row?.approximation ?? null);
      }
      expect(shared?.entries).toHaveLength(original.length);
    });

    it("returns byte-identical entries to interpretation.ts:134's original two-step SQL", async () => {
      // interpretation.ts:134 + 142 verbatim: revision id, then entries by that id.
      const revisions = await client()`
        select id from inventory_revisions
        where sales_location_id = ${richLocationId} and is_current
      `;
      const revisionId = revisions[0]?.id as string;
      const original = await client()`
        select id, item_name, quantity, unit, price_text, approximation
        from inventory_entries
        where inventory_revision_id = ${revisionId}
        order by sort_order asc
      `;
      const shared = await readCurrentInventory(client(), {
        salesLocationId: richLocationId,
      });
      expect(shared?.revisionId).toBe(revisionId);
      expect(new Set(shared?.entries.map((e) => e.entryId))).toEqual(
        new Set(original.map((r) => r.id as string)),
      );
    });

    it("returns byte-identical entries to stockout.ts:98's original SQL", async () => {
      // stockout.ts:98 verbatim — the stock-out matcher's published-item candidates. Order is
      // the precedence rule there, so it is asserted as a SEQUENCE, not a set.
      const original = await client()`
        select e.id, e.item_name
        from inventory_entries e
        join inventory_revisions r on r.id = e.inventory_revision_id
        where r.sales_location_id = ${richLocationId} and r.is_current
        order by e.sort_order asc, e.id asc
      `;
      const shared = await readCurrentInventory(client(), {
        salesLocationId: richLocationId,
      });
      expect(shared?.entries.map((e) => e.entryId)).toEqual(
        original.map((r) => r.id as string),
      );
      expect(shared?.entries.map((e) => e.itemName)).toEqual(
        original.map((r) => r.item_name as string),
      );
    });

    it("orders totally, so a duplicated sort_order cannot flap", async () => {
      // Two entries share sort_order 1. Read the same question ten times: an order that is not
      // total is free to differ between runs, and this is what catches that.
      const runs: string[][] = [];
      for (let i = 0; i < 10; i += 1) {
        const shared = await readCurrentInventory(client(), {
          salesLocationId: richLocationId,
        });
        runs.push((shared?.entries ?? []).map((e) => e.entryId));
      }
      for (const run of runs) expect(run).toEqual(runs[0]);
      // And the order is the stated one: sort_order first, id as the tiebreak.
      const expected = await client()`
        select e.id from inventory_entries e
        where e.inventory_revision_id = ${currentRevisionId}
        order by e.sort_order asc, e.id asc
      `;
      expect(runs[0]).toEqual(expected.map((r) => r.id as string));
    });

    it("distinguishes a published-but-empty stand from an unpublished one", async () => {
      // The two are DIFFERENT facts and every original site treated them differently: an empty
      // current revision is "the farmer published nothing in stock", a missing one is "the
      // farmer has never published". Collapsing them to `[]` loses the revision id every
      // writer composes its next proposal against.
      const empty = await readCurrentInventory(client(), {
        salesLocationId: emptyLocationId,
      });
      expect(empty).not.toBeNull();
      expect(empty?.entries).toEqual([]);
      expect(
        await readCurrentInventory(client(), {
          salesLocationId: unpublishedLocationId,
        }),
      ).toBeNull();
    });

    it("never returns the superseded revision's entries", async () => {
      const shared = await readCurrentInventory(client(), {
        salesLocationId: richLocationId,
      });
      expect(shared?.entries.map((e) => e.itemName)).not.toContain("STALE PARSNIPS");
    });
  });

  /*
    ============================================================================
    Sites 1-3 — the corpus-wide SQL fragments.

    These are proved by composing the fragment into the SAME statement the site runs and
    comparing against the site's original hand-written join text. What matters is that the
    fragment produces the identical result set, including the left/inner distinction that
    decides whether an unconfirmed stand survives.
    ============================================================================
  */
  describe("site 1-3 — the composed join fragments", () => {
    it("the inner join matches inquiry.ts:277's original, dropping unconfirmed stands", async () => {
      const originalSql = `
        select l.id as location_id, e.item_name, r.published_at
        from sales_locations l
        join inventory_revisions r
          on r.sales_location_id = l.id and r.is_current
        join inventory_entries e on e.inventory_revision_id = r.id
        order by l.id asc, e.sort_order asc, e.id asc
      `;
      const sharedSql = `
        select l.id as location_id, e.item_name, r.published_at
        from sales_locations l
        ${currentInventoryJoin({ locationAlias: "l", revisionAlias: "r", kind: "inner" })}
        ${currentEntriesJoin({ revisionAlias: "r", entryAlias: "e", kind: "inner" })}
        order by l.id asc, e.sort_order asc, e.id asc
      `;
      const original = await client().unsafe(originalSql);
      const shared = await client().unsafe(sharedSql);
      expect(shared).toEqual(original);
      // The inner join is load-bearing: the two stands with no entries must be ABSENT.
      const locations = new Set(original.map((r) => r.location_id as string));
      expect(locations.has(richLocationId)).toBe(true);
      expect(locations.has(emptyLocationId)).toBe(false);
      expect(locations.has(unpublishedLocationId)).toBe(false);
      expect(original.map((r) => r.item_name as string)).not.toContain("STALE PARSNIPS");
    });

    it("the left join matches public-listing.ts:469's original, keeping unconfirmed stands", async () => {
      const originalSql = `
        select l.id as location_id, r.published_at, e.item_name
        from sales_locations l
        left join inventory_revisions r
          on r.sales_location_id = l.id and r.is_current
        left join inventory_entries e on e.inventory_revision_id = r.id
        order by r.published_at desc nulls last, l.id asc, e.sort_order asc, e.id asc
      `;
      const sharedSql = `
        select l.id as location_id, r.published_at, e.item_name
        from sales_locations l
        ${currentInventoryJoin({ locationAlias: "l", revisionAlias: "r", kind: "left" })}
        ${currentEntriesJoin({ revisionAlias: "r", entryAlias: "e", kind: "left" })}
        order by r.published_at desc nulls last, l.id asc, e.sort_order asc, e.id asc
      `;
      const original = await client().unsafe(originalSql);
      const shared = await client().unsafe(sharedSql);
      expect(shared).toEqual(original);
      // B-013 — the left join is what keeps a never-confirmed stand on the map.
      const locations = new Set(original.map((r) => r.location_id as string));
      expect(locations.has(unpublishedLocationId)).toBe(true);
      expect(locations.has(emptyLocationId)).toBe(true);
    });

    it("the left join matches admin.ts:940's original, keeping every stand in the roster", async () => {
      // The admin roster aggregates entries in a correlated subquery rather than joining them,
      // so only the REVISION join comes from the fragment. Retired stands stay listed here,
      // which is why the operator can restore one.
      const originalSql = `
        select location.id as stand_id, inventory.id as revision_id,
          coalesce(
            (select jsonb_agg(jsonb_build_object('itemName', entry.item_name)
               order by entry.sort_order, entry.id)
             from inventory_entries entry
             where entry.inventory_revision_id = inventory.id),
            '[]'::jsonb
          ) as current_items
        from sales_locations location
        left join inventory_revisions inventory
          on inventory.sales_location_id = location.id and inventory.is_current
        order by location.name, location.id
      `;
      const sharedSql = `
        select location.id as stand_id, inventory.id as revision_id,
          coalesce(
            (select jsonb_agg(jsonb_build_object('itemName', entry.item_name)
               order by entry.sort_order, entry.id)
             from inventory_entries entry
             where entry.inventory_revision_id = inventory.id),
            '[]'::jsonb
          ) as current_items
        from sales_locations location
        ${currentInventoryJoin({
          locationAlias: "location",
          revisionAlias: "inventory",
          kind: "left",
        })}
        order by location.name, location.id
      `;
      const original = await client().unsafe(originalSql);
      const shared = await client().unsafe(sharedSql);
      expect(shared).toEqual(original);
      expect(original).toHaveLength(3);
      const rich = original.find((r) => r.stand_id === richLocationId);
      expect(rich?.revision_id).toBe(currentRevisionId);
      expect(JSON.stringify(rich?.current_items)).not.toContain("STALE PARSNIPS");
    });
  });
});
