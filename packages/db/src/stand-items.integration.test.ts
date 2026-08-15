import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

// F-066 — one item vocabulary per stand, with two independent states.
//
// "Eggs" is ONE record per stand. The two things anyone can say about it — does this stand
// usually carry it, and was it confirmed present on a date — are independent states of that
// one record, not two disjoint lists a reader has to reconcile. Before this, they were two
// tables sharing no vocabulary, and `standListingLines` case-folded and subtracted one from
// the other at render time.
//
// What is asserted here is what only real Postgres can prove:
//   1. The unique index makes "eggs exists once here" structural, across case and whitespace.
//   2. Normalization is case and whitespace ONLY — never singular/plural, never synonyms.
//      That line is what keeps this from becoming a produce taxonomy (CLAUDE.md).
//   3. The index is the FIRST-INSERT ARBITER under genuine contention. A row lock cannot
//      serialize a row that does not exist yet, and two concurrent confirmations naming the
//      same new item share no parent row to lock.
//   4. The two states are independent: either, both, or neither may hold.
//   5. The item OUTLIVES its states — clearing the standing state keeps the record and its
//      confirmation history.
//   6. An entry resolves to its item by the same normalized key, WITHOUT published history
//      being touched. `inventory_entries` refuses every UPDATE (measured, not assumed), which
//      is why the link is the key it already carries rather than a backfilled column.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-066 stand items (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let farmId = "";
  let locationId = "";
  let otherLocationId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_items_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    // A pool, not a single connection: the contention test needs genuinely parallel sessions.
    sql = postgres(url.toString(), { max: 10 });

    const sellers = await client()`insert into sellers (name) values ('Item Farm') returning id`;
    farmId = sellers[0]?.id as string;
    const locations = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', 'Item Stand', 'America/Los_Angeles',
        'visitable', 'produce', '1 Item Way', 47.4, -122.4, false, false
      )
      returning id
    `;
    locationId = locations[0]?.id as string;
    const others = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', 'Other Item Stand', 'America/Los_Angeles',
        'visitable', 'produce', '2 Item Way', 47.5, -122.5, false, false
      )
      returning id
    `;
    otherLocationId = others[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  /** Insert an item the way every writer must: the index arbitrates, never a prior read. */
  async function claimItem(
    location: string,
    name: string,
    options: { usuallyCarried?: boolean } = {},
  ): Promise<string | undefined> {
    const rows = await client()`
      insert into stand_items (sales_location_id, provider_id, display_name, usually_carried)
      values (${location}, (select id from stand_providers
        where sales_location_id = ${location} and seller_id = (select own_seller_id from sales_locations where id = ${location})), ${name}, ${options.usuallyCarried ?? false})
      on conflict do nothing
      returning id
    `;
    return rows[0]?.id as string | undefined;
  }

  describe("one item per stand per name", () => {
    it("refuses a second row for the same name at the same stand", async () => {
      const first = await claimItem(locationId, "rhubarb");
      expect(first).toBeDefined();

      // Not `on conflict do nothing` — this asserts Postgres genuinely REFUSES the row.
      await expect(
        client()`
          insert into stand_items (sales_location_id, provider_id, display_name, usually_carried)
          values (${locationId}, (select id from stand_providers
            where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})), 'rhubarb', false)
        `,
      ).rejects.toThrow();
    });

    it("treats case and surrounding whitespace as the same item", async () => {
      const first = await claimItem(locationId, "Eggs", { usuallyCarried: true });
      expect(first).toBeDefined();

      // The real collision this exists for: the profile form seeds "eggs" lowercase and the
      // weekly stock form states "Eggs" capitalized. Same item, two sources, one record.
      for (const variant of ["eggs", "EGGS", "  eggs  ", "\tEggs\n"]) {
        const duplicate = await claimItem(locationId, variant);
        expect(duplicate, `${JSON.stringify(variant)} must collide with "Eggs"`).toBeUndefined();
      }

      const rows = await client()`
        select display_name from stand_items
        where sales_location_id = ${locationId} and lower(btrim(display_name)) = 'eggs'
      `;
      // Exactly one row, and it kept the FARMER'S OWN CASING for display.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.display_name).toBe("Eggs");
    });

    it("does NOT fold singulars, plurals, or synonyms into each other", async () => {
      // The line that keeps this from becoming a produce taxonomy. "tomato" and "tomatoes"
      // are different words; the database has no opinion about whether they mean one thing.
      // Anyone tempted to normalize harder has to delete this test first.
      const singular = await claimItem(locationId, "tomato");
      const plural = await claimItem(locationId, "tomatoes");
      const synonym = await claimItem(locationId, "love apple");
      expect(singular).toBeDefined();
      expect(plural).toBeDefined();
      expect(synonym).toBeDefined();
      expect(new Set([singular, plural, synonym]).size).toBe(3);
    });

    it("keeps each stand's vocabulary its own", async () => {
      // Two stands that both sell eggs share nothing. No global food ontology.
      const mine = await claimItem(locationId, "honey");
      const theirs = await claimItem(otherLocationId, "honey");
      expect(mine).toBeDefined();
      expect(theirs).toBeDefined();
      expect(mine).not.toBe(theirs);
    });

    it("refuses a blank or whitespace-only name", async () => {
      // Anchored to the NAMED constraint, not to "some error happened". A bare `.rejects`
      // here passes when the table does not exist at all, which is how this test first ran
      // green against nothing.
      for (const blank of ["", "   ", "\t\n"]) {
        await expect(
          client()`
            insert into stand_items (sales_location_id, provider_id, display_name, usually_carried)
            values (${locationId}, (select id from stand_providers
              where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})), ${blank}, false)
          `,
          `${JSON.stringify(blank)} must be refused`,
        ).rejects.toThrow(/stand_items_display_name_not_blank/);
      }

      // And a real name still goes in, so the check is not simply refusing everything.
      const real = await claimItem(locationId, "pea shoots");
      expect(real).toBeDefined();
    });
  });

  describe("the unique index is the first-insert arbiter", () => {
    it("admits exactly one winner when concurrent writers name the same new item", async () => {
      // GENUINE contention: 8 simultaneous claimants on their own connections, each racing to
      // create an item that does not exist yet. `select ... for update` cannot serialize a row
      // that does not exist, and these writers share no parent row to lock — so the unique
      // index is the only arbiter available. An empty `returning` means someone else won.
      const contenders = 8;
      const name = `zucchini-${randomUUID().slice(0, 8)}`;

      const results = await Promise.all(
        Array.from({ length: contenders }, () => claimItem(locationId, name)),
      );

      const winners = results.filter((id) => id !== undefined);
      expect(winners).toHaveLength(1);

      const rows = await client()`
        select count(*)::int as n from stand_items
        where sales_location_id = ${locationId} and lower(btrim(display_name)) = ${name}
      `;
      expect(rows[0]?.n).toBe(1);
    });
  });

  describe("the two states are independent", () => {
    it("holds either, both, or neither", async () => {
      // The whole point of max's question: "usually sells" and "confirmed in stock" are two
      // states of ONE item, and every combination is representable.
      const usualOnly = await claimItem(locationId, "lamb", { usuallyCarried: true });
      const neither = await claimItem(locationId, "quince");
      expect(usualOnly).toBeDefined();
      expect(neither).toBeDefined();

      const rows = await client()`
        select display_name, usually_carried from stand_items
        where id in (${usualOnly!}, ${neither!})
        order by display_name
      `;
      expect(rows).toEqual([
        { display_name: "lamb", usually_carried: true },
        { display_name: "quince", usually_carried: false },
      ]);
    });

    it("carries no confirmation time of its own", async () => {
      // A standing claim is dated by NOTHING. If this table ever grows a timestamp that reads
      // as a confirmation, the "no confirmation time" property stops surviving to the screen —
      // which is the property the whole specialty/revision split exists to protect.
      const columns = await client()`
        select column_name, data_type from information_schema.columns
        where table_name = 'stand_items'
      `;
      // Assert the anchor is PRESENT before drawing a conclusion from its absence. Querying a
      // table that does not exist returns zero rows, and "no timestamps among no columns" is a
      // vacuous pass — which is exactly how this test first ran green against nothing.
      expect(columns.length, "stand_items must exist for this assertion to mean anything")
        .toBeGreaterThan(0);
      expect(columns.map((column) => column.column_name)).toContain("display_name");

      const temporal = columns.filter((column) =>
        String(column.data_type).includes("timestamp"),
      );
      expect(
        temporal.map((column) => column.column_name),
        "a stand item must carry no timestamp that could be read as a confirmation",
      ).toEqual([]);
    });

    it("keeps the item and its confirmations when the standing state is cleared", async () => {
      // An item that stopped being a standing claim did not stop having been confirmed in June.
      const id = await claimItem(locationId, "plums", { usuallyCarried: true });
      expect(id).toBeDefined();

      await client()`
        update stand_items set usually_carried = false where id = ${id!}
      `;

      const rows = await client()`
        select display_name, usually_carried from stand_items where id = ${id!}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.usually_carried).toBe(false);
    });
  });

  describe("published history is untouched", () => {
    it("resolves an entry to its item by the normalized key, across a case difference", async () => {
      // THE LINK, and why it is not a column. `inventory_entries` refuses every UPDATE (its
      // guard trigger raises unconditionally — measured against real Postgres), so backfilling
      // a `stand_item_id` onto published rows is impossible without disabling the immutability
      // guarantee. It is not needed: an entry already carries the farmer's words, and an entry
      // belongs to a stand, so (location, normalized name) resolves it — the same key the
      // unique index enforces.
      const revision = await client()`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, source, published_at, is_current
        )
        values (
${farmId}, ${locationId},
(select id from stand_providers
  where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})), 'viga', now(), true)
        returning id
      `;
      const revisionId = revision[0]?.id as string;

      // The weekly form's capitalization, against a lowercase seeded item.
      await claimItem(locationId, "salad greens", { usuallyCarried: true });
      await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        )
        values (${revisionId}, ${locationId}, 'Salad Greens', 0)
      `;

      const joined = await client()`
        select item.id as item_id, item.display_name, item.usually_carried, entry.item_name
        from inventory_entries entry
        join stand_items item
          on item.sales_location_id = entry.sales_location_id
         and lower(btrim(item.display_name)) = lower(btrim(entry.item_name))
        where entry.inventory_revision_id = ${revisionId}
      `;
      expect(joined).toHaveLength(1);
      // The entry kept ITS words; the item kept ITS words; they resolve to each other anyway.
      expect(joined[0]?.item_name).toBe("Salad Greens");
      expect(joined[0]?.display_name).toBe("salad greens");
      expect(joined[0]?.usually_carried).toBe(true);
    });

    it("still refuses to mutate a published entry", async () => {
      // The guarantee that made the join-by-key design necessary. If this ever passes, the
      // immutability guard has been weakened and the reason for that design is gone.
      const revision = await client()`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, source, published_at, is_current
        )
        values (
${farmId}, ${otherLocationId},
(select id from stand_providers
  where sales_location_id = ${otherLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${otherLocationId})), 'viga', now(), true)
        returning id
      `;
      const revisionId = revision[0]?.id as string;
      await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        )
        values (${revisionId}, ${otherLocationId}, 'rhubarb', 0)
      `;

      await expect(
        client()`
          update inventory_entries set item_name = 'something else'
          where inventory_revision_id = ${revisionId}
        `,
      ).rejects.toThrow(/immutable/i);
    });

    it("keeps an item that a past confirmation still names, after the mix drops it", async () => {
      // The two rules meeting: the farmer removes it from what they usually sell, and June's
      // card must still read the way June read.
      const revision = await client()`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, source, published_at, is_current
        )
        values (
${farmId}, ${locationId},
(select id from stand_providers
  where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})), 'viga', now() - interval '40 days', false)
        returning id
      `;
      const revisionId = revision[0]?.id as string;
      const itemId = await claimItem(locationId, "garlic scapes", { usuallyCarried: true });
      await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        )
        values (${revisionId}, ${locationId}, 'garlic scapes', 0)
      `;

      // The farmer edits their mix on the web form: scapes are out of season.
      await client()`update stand_items set usually_carried = false where id = ${itemId!}`;

      const entries = await client()`
        select item_name from inventory_entries where inventory_revision_id = ${revisionId}
      `;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.item_name).toBe("garlic scapes");

      const items = await client()`
        select usually_carried from stand_items where id = ${itemId!}
      `;
      expect(items[0]?.usually_carried).toBe(false);
    });
  });
});
