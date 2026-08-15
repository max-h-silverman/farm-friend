import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase B — every index and CHECK added by 0042, proved by SABOTAGE.

  A constraint that exists is not a constraint that works. Each case below inserts the exact row
  the constraint was written to refuse and asserts Postgres rejects it — so a constraint
  weakened, misspelled, or written one-directionally fails HERE rather than admitting bad data
  silently in production.

  ## Why every nullability rule is a biconditional

  **A CHECK PASSES on NULL.** A one-directional test ("an approver is recorded") evaluates to
  NULL on the row that omits the column, and NULL is not false, so the row is admitted. Each
  `…_coherent` case below therefore attacks BOTH halves: the arm that states too much and the
  arm that states too little. A rule that only catches one direction fails one of the pair.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/** Postgres codes: 23514 is a CHECK violation, 23505 a unique violation, 23503 an FK one. */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

describe("F-114 stand_providers constraints, by sabotage (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let farmId = "";
  let otherSellerId = "";
  let locationId = "";
  let otherLocationId = "";
  let nativeProviderId = "";
  let sellerId = "";
  let authorizationId = "";
  let administratorId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  /** Assert a statement is refused, and by WHICH constraint — not merely that it threw. */
  const refuses = async (
    run: () => Promise<unknown>,
    expected: { code: string; constraint?: string },
  ): Promise<void> => {
    await expect(run()).rejects.toMatchObject(
      expected.constraint
        ? { code: expected.code, constraint_name: expected.constraint }
        : { code: expected.code },
    );
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114con_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });

    const db = client();
    const morganhillSeller = await db`
      insert into sellers (name) values ('Morgan Hill'), ('Cascade') returning id
    `;
    farmId = morganhillSeller[0]?.id as string;
    otherSellerId = morganhillSeller[1]?.id as string;

    const mkLocation = async (name: string, owner: string): Promise<string> => {
      const rows = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          ${owner}, 'farm_stand', ${name}, 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          ${`${name} Road, Vashon WA`}, 47.4473, -122.4590
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    locationId = await mkLocation("Morgan Hill Stand", farmId);
    otherLocationId = await mkLocation("Cascade Stand", otherSellerId);

    const native = await db`
      select id from stand_providers
      where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})
    `;
    nativeProviderId = native[0]?.id as string;

    const fernhornbakeSeller = await db`
      insert into sellers (name) values ('Fernhorn Bakery') returning id
    `;
    sellerId = fernhornbakeSeller[0]?.id as string;

    const contacts = await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550131', ${`f114${randomUUID().replaceAll("-", "")}`}) returning id
    `;
    const authorizations = await db`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contacts[0]?.id as string}, now(), now()) returning id
    `;
    authorizationId = authorizations[0]?.id as string;

    const administrators = await db`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', now()) returning id
    `;
    administratorId = administrators[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  describe("stand_providers_one_native_per_location", () => {
    it("refuses a SECOND native slot at one stand", async () => {
      // A stand has exactly one native slot because it has exactly one name. A plain unique on
      // (location, seller) would NOT catch this: Postgres treats NULLs as distinct, so every
      // native row would be its own key and this insert would succeed.
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (sales_location_id, seller_id, lifecycle_state)
          values (${locationId}, null, 'active')
        `,
        { code: UNIQUE_VIOLATION, constraint: "stand_providers_one_native_per_location" },
      );
    });

    it("admits a native slot at a DIFFERENT stand", async () => {
      // The partial index must not be a global one. Every stand already got its native row from
      // the trigger, so assert that fact rather than inserting a duplicate.
      const rows = await client()`
        select count(*)::int as n from stand_providers where seller_id is null
      `;
      expect(rows[0]?.n).toBe(2);
    });
  });

  describe("stand_providers_one_per_seller_per_location", () => {
    it("refuses the same seller twice at one stand", async () => {
      const db = client();
      const first = await db`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
          approval_source, approved_at
        ) values (
          ${locationId}, ${sellerId}, 'active', now(), now(), 'viga', now()
        ) returning id
      `;
      expect(first[0]?.id).toBeTruthy();

      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at
          ) values (
            ${locationId}, ${sellerId}, 'active', now(), now(), 'viga', now()
          )
        `,
        {
          code: UNIQUE_VIOLATION,
          constraint: "stand_providers_one_per_seller_per_location",
        },
      );
    });

    it("admits the same seller at a DIFFERENT stand", async () => {
      // The same seller may participate at many stands; each relationship is independent.
      const rows = await client()`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
          approval_source, approved_at
        ) values (
          ${otherLocationId}, ${sellerId}, 'active', now(), now(), 'viga', now()
        ) returning id
      `;
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("stand_providers_hosting_lifecycle_coherent", () => {
    it("refuses a NATIVE slot carrying an invitation", async () => {
      // The half that says too much: a stand selling under its own name was never invited.
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at
          ) values (${otherLocationId}, null, 'active', now())
        `,
        {
          code: CHECK_VIOLATION,
          constraint: "stand_providers_hosting_lifecycle_coherent",
        },
      );
    });

    it("refuses a NAMED provider that is active with NO invitation", async () => {
      // The half that says too little — the fabricated-authority row. A one-directional rule
      // would admit this, because a CHECK passes on NULL.
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (sales_location_id, seller_id, lifecycle_state)
          values (${otherLocationId}, ${sellerId}, 'active')
        `,
        {
          code: CHECK_VIOLATION,
          constraint: "stand_providers_hosting_lifecycle_coherent",
        },
      );
    });

    it("refuses a NAMED provider that is active with no APPROVAL", async () => {
      // VIGA approval is the real gate — visible on acceptance and approval, before any
      // confirmation exists. An accepted-but-unapproved row must not be `active`.
      const db = client();
      const seller = await db`insert into sellers (name) values ('Unapproved') returning id`;
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at
          ) values (
            ${otherLocationId}, ${seller[0]?.id as string}, 'active', now(), now()
          )
        `,
        {
          code: CHECK_VIOLATION,
          constraint: "stand_providers_hosting_lifecycle_coherent",
        },
      );
    });

    it("refuses acceptance BEFORE the invitation that prompted it", async () => {
      const db = client();
      const seller = await db`insert into sellers (name) values ('Backdated') returning id`;
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at
          ) values (
            ${otherLocationId}, ${seller[0]?.id as string}, 'active',
            now(), now() - interval '1 day', 'viga', now()
          )
        `,
        {
          code: CHECK_VIOLATION,
          constraint: "stand_providers_hosting_lifecycle_coherent",
        },
      );
    });

    it("refuses a NATIVE slot in the pending state", async () => {
      // `pending` means an invitation nobody has answered. The native slot has no invitation,
      // so pending is a state it can never legitimately be in.
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (sales_location_id, seller_id, lifecycle_state)
          values (${otherLocationId}, null, 'pending')
        `,
        {
          code: CHECK_VIOLATION,
          constraint: "stand_providers_hosting_lifecycle_coherent",
        },
      );
    });

    it("admits a pending invitation with no acceptance or approval", async () => {
      const db = client();
      const seller = await db`insert into sellers (name) values ('Invited') returning id`;
      const rows = await db`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, invited_at
        ) values (
          ${otherLocationId}, ${seller[0]?.id as string}, 'pending', now()
        ) returning id
      `;
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("stand_providers_approval_source_coherent", () => {
    it("refuses a host approval naming NOBODY", async () => {
      const db = client();
      const seller = await db`insert into sellers (name) values ('Vouched') returning id`;
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at
          ) values (
            ${otherLocationId}, ${seller[0]?.id as string}, 'active',
            now(), now(), 'host', now()
          )
        `,
        {
          code: CHECK_VIOLATION,
          constraint: "stand_providers_approval_source_coherent",
        },
      );
    });

    it("refuses a VIGA approval that names a vouching farmer", async () => {
      // The mirror image. VIGA's own approval names no farmer; recording one would attribute
      // the decision to somebody who never made it.
      const db = client();
      const seller = await db`insert into sellers (name) values ('MisattributedViga') returning id`;
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, approved_by_authorization_id
          ) values (
            ${otherLocationId}, ${seller[0]?.id as string}, 'active',
            now(), now(), 'viga', now(), ${authorizationId}
          )
        `,
        {
          code: CHECK_VIOLATION,
          constraint: "stand_providers_approval_source_coherent",
        },
      );
    });

    it("admits a host approval that names its vouching farmer", async () => {
      const db = client();
      const seller = await db`insert into sellers (name) values ('ProperlyVouched') returning id`;
      const rows = await db`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
          approval_source, approved_at, approved_by_authorization_id
        ) values (
          ${otherLocationId}, ${seller[0]?.id as string}, 'active',
          now(), now(), 'host', now(), ${authorizationId}
        ) returning id
      `;
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("stand_providers_reminder_coherent", () => {
    it("refuses a cadence with nobody to text", async () => {
      const db = client();
      const seller = await db`insert into sellers (name) values ('NoRecipient') returning id`;
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, reminder_cadence
          ) values (
            ${otherLocationId}, ${seller[0]?.id as string}, 'active',
            now(), now(), 'viga', now(), 'weekly'
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_reminder_coherent" },
      );
    });

    it("refuses a recipient with no cadence", async () => {
      const db = client();
      const seller = await db`insert into sellers (name) values ('NoCadence') returning id`;
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, reminder_authorization_id
          ) values (
            ${otherLocationId}, ${seller[0]?.id as string}, 'active',
            now(), now(), 'viga', now(), ${authorizationId}
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_reminder_coherent" },
      );
    });
  });

  describe("stand_providers_valid_open_days", () => {
    it("refuses an EMPTY day array", async () => {
      // `array_length(array[]::integer[], 1)` returns NULL — not 0 — and a CHECK passes on
      // NULL, so a bare `between 1 and 7` would admit the exact value it forbids. `coalesce`
      // is what makes this fail.
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, open_days
          ) values (${otherLocationId}, null, 'active', ${db.array([] as number[])}::integer[])
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_valid_open_days" },
      );
    });

    it("refuses a weekday outside 0..6", async () => {
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, open_days
          ) values (${otherLocationId}, null, 'active', ${db.array([0, 7])}::integer[])
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_valid_open_days" },
      );
    });
  });

  describe("stand_providers_coherent_open_hours and season", () => {
    it("refuses a clock_range with no times", async () => {
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, open_hours_kind
          ) values (${otherLocationId}, null, 'active', 'clock_range')
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_coherent_open_hours" },
      );
    });

    it("refuses a date_range season with no dates", async () => {
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, season_kind
          ) values (${otherLocationId}, null, 'active', 'date_range')
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_coherent_season" },
      );
    });

    it("refuses a named_season with an EMPTY name array", async () => {
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, season_kind, season_names
          ) values (
            ${otherLocationId}, null, 'active', 'named_season',
            ${db.array([] as string[])}::text[]
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_coherent_season" },
      );
    });
  });

  describe("stand_providers_ending_coherent and public_note", () => {
    it("refuses ending the NATIVE slot", async () => {
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, ended_at
          ) values (${otherLocationId}, null, 'active', now())
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_ending_coherent" },
      );
    });

    it("refuses a blank public note", async () => {
      // `btrim(text)` with no second argument strips SPACES ONLY, so the whitespace characters
      // are named explicitly — a tab-and-newline note caught the default admitting it.
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, public_note
          ) values (${otherLocationId}, null, 'active', ${"\t\n "})
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_public_note_not_blank" },
      );
    });
  });

  describe("sellers constraints", () => {
    it("refuses a blank seller name", async () => {
      await refuses(
        () => client()`insert into sellers (name) values (${"\t\n "})`,
        { code: CHECK_VIOLATION, constraint: "sellers_name_not_blank" },
      );
    });

    it("refuses a revocation naming nobody, and an actor with no revocation", async () => {
      const db = client();
      await refuses(
        () => db`insert into sellers (name, revoked_at) values ('Half', now())`,
        { code: CHECK_VIOLATION, constraint: "sellers_coherent_revocation" },
      );
      await refuses(
        () => db`
          insert into sellers (name, revoked_by_administrator_id)
          values ('OtherHalf', ${administratorId})
        `,
        { code: CHECK_VIOLATION, constraint: "sellers_coherent_revocation" },
      );
    });

    it("refuses two sellers for one farm", async () => {
      const db = client();
      await db`insert into sellers (name, seller_id) values ('Morgan Hill Brand', ${farmId})`;
      await refuses(
        () => db`insert into sellers (name, seller_id) values ('Second Brand', ${farmId})`,
        { code: UNIQUE_VIOLATION, constraint: "sellers_one_per_farm" },
      );
    });

    it("admits many sellers with NO farm", async () => {
      // The partial index must not collapse every farmless seller into one row — a bakery and a
      // maker are two sellers, and neither has a farm.
      const db = client();
      const rows = await db`
        insert into sellers (name) values ('Baker A'), ('Maker B') returning id
      `;
      expect(rows).toHaveLength(2);
    });
  });

  describe("the re-rooted composite keys", () => {
    it("refuses a revision naming a provider at ANOTHER stand", async () => {
      // The whole point of the composite key: "this record belongs to a provider AT the stand
      // the surface bound" is a database guarantee, not a caller's discipline.
      const db = client();
      await refuses(
        () => db`
          insert into inventory_revisions (
            seller_id, sales_location_id, provider_id, source, published_at, is_current
          ) values (
            ${farmId}, ${otherLocationId}, ${nativeProviderId}, 'viga', now(), true
          )
        `,
        { code: FK_VIOLATION },
      );
    });

    it("refuses a usual item naming a provider at ANOTHER stand", async () => {
      const db = client();
      await refuses(
        () => db`
          insert into stand_items (sales_location_id, provider_id, display_name)
          values (${otherLocationId}, ${nativeProviderId}, 'eggs')
        `,
        { code: FK_VIOLATION },
      );
    });
  });

  describe("stand_items_one_per_provider_name", () => {
    it("refuses one provider carrying the same item twice, case-folded", async () => {
      const db = client();
      await db`
        insert into stand_items (sales_location_id, provider_id, display_name)
        values (${locationId}, ${nativeProviderId}, 'Eggs')
      `;
      await refuses(
        () => db`
          insert into stand_items (sales_location_id, provider_id, display_name)
          values (${locationId}, ${nativeProviderId}, ${"  eggs "})
        `,
        { code: UNIQUE_VIOLATION, constraint: "stand_items_one_per_provider_name" },
      );
    });

    it("ADMITS a host and a hosted seller both usually carrying eggs", async () => {
      // This is the collision the stand-keyed index caused, and the reason `stand_items` could
      // not wait for Phase C. Two providers each usually carry eggs, at their own prices — an
      // honest fact the old index made unstorable.
      const db = client();
      const hosted = await db`
        select id from stand_providers
        where sales_location_id = ${locationId} and seller_id = ${sellerId}
      `;
      const rows = await db`
        insert into stand_items (sales_location_id, provider_id, display_name)
        values (${locationId}, ${hosted[0]?.id as string}, 'eggs')
        returning id
      `;
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("inventory_revisions_one_current_per_provider", () => {
    it("refuses two current revisions for ONE provider", async () => {
      const db = client();
      await db`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, source, published_at, is_current
        ) values (${farmId}, ${locationId}, ${nativeProviderId}, 'viga', now(), true)
      `;
      await refuses(
        () => db`
          insert into inventory_revisions (
            seller_id, sales_location_id, provider_id, source, published_at, is_current
          ) values (${farmId}, ${locationId}, ${nativeProviderId}, 'viga', now(), true)
        `,
        {
          code: UNIQUE_VIOLATION,
          constraint: "inventory_revisions_one_current_per_provider",
        },
      );
    });

    it("ADMITS a current revision for each of two providers at ONE stand", async () => {
      // The invariant per-provider inventory invalidates. Keyed on the stand, this second
      // insert was refused and a hosted seller could not publish at all.
      const db = client();
      const hosted = await db`
        select id from stand_providers
        where sales_location_id = ${locationId} and seller_id = ${sellerId}
      `;
      const rows = await db`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, source, published_at, is_current
        ) values (
          ${farmId}, ${locationId}, ${hosted[0]?.id as string}, 'viga', now(), true
        ) returning id
      `;
      expect(rows[0]?.id).toBeTruthy();

      const current = await db`
        select count(*)::int as n from inventory_revisions
        where sales_location_id = ${locationId} and is_current
      `;
      expect(current[0]?.n).toBe(2);
    });
  });

  describe("the native provider trigger", () => {
    it("creates a native slot for a stand created AFTER the migration", async () => {
      // Two writers create stands today. The guarantee lives in the database so the number of
      // writers that must remember it is zero.
      const db = client();
      const created = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          ${farmId}, 'farm_stand', 'Brand New Stand', 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          'New Road, Vashon WA', 47.4473, -122.4590
        ) returning id
      `;
      const rows = await db`
        select id, lifecycle_state from stand_providers
        where sales_location_id = ${created[0]?.id as string} and seller_id = (select own_seller_id from sales_locations where id = ${created[0]?.id as string})
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lifecycle_state).toBe("active");
    });
  });

  describe("farmer_target_contexts_selected_context_coherent", () => {
    it("refuses a selection carrying a stand but NO provider", async () => {
      // The ambiguous target item 7 exists to remove. A per-column rule would admit it, because
      // a CHECK passes on NULL.
      const db = client();
      const contacts = await db`
        insert into contacts (phone_e164, phone_hash)
        values ('+12065550132', ${`f114${randomUUID().replaceAll("-", "")}`})
        returning phone_hash
      `;
      await refuses(
        () => db`
          insert into farmer_target_contexts (
            sender_hash, selected_authorization_id, selected_owner_seller_id,
            selected_sales_location_id, selected_at, updated_at
          ) values (
            ${contacts[0]?.phone_hash as string}, ${authorizationId}, ${farmId},
            ${locationId}, now(), now()
          )
        `,
        {
          code: CHECK_VIOLATION,
          constraint: "farmer_target_contexts_selected_context_coherent",
        },
      );
    });

    it("admits a wholly unselected context", async () => {
      const db = client();
      const contacts = await db`
        insert into contacts (phone_e164, phone_hash)
        values ('+12065550133', ${`f114${randomUUID().replaceAll("-", "")}`})
        returning phone_hash
      `;
      const rows = await db`
        insert into farmer_target_contexts (sender_hash, updated_at)
        values (${contacts[0]?.phone_hash as string}, now())
        returning sender_hash
      `;
      expect(rows[0]?.sender_hash).toBeTruthy();
    });
  });

  describe("the revision history guard, widened", () => {
    it("refuses re-attributing a published revision to another provider", async () => {
      // 0042 widened `guard_inventory_revision_history` to cover `provider_id`. The migration
      // itself is the one legitimate actor that ever set it, and it disabled the trigger to do
      // so; from here on the column is as immutable as the columns beside it.
      const db = client();
      const hosted = await db`
        select id from stand_providers
        where sales_location_id = ${locationId} and seller_id = ${sellerId}
      `;
      const revision = await db`
        select id from inventory_revisions
        where provider_id = ${nativeProviderId} and is_current
      `;
      await expect(
        db`
          update inventory_revisions set provider_id = ${hosted[0]?.id as string}
          where id = ${revision[0]?.id as string}
        `,
      ).rejects.toMatchObject({
        message: "published inventory revision history is immutable",
      });
    });
  });
});
