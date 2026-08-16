import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.0 — every index and CHECK added by 0042, proved by SABOTAGE.

  A constraint that exists is not a constraint that works. Each case below inserts the exact row
  the constraint was written to refuse and asserts Postgres rejects it — so a constraint
  weakened, misspelled, or written one-directionally fails HERE rather than admitting bad data
  silently in production.

  ## Why every nullability rule is a biconditional

  **A CHECK PASSES on NULL.** A one-directional test ("an approver is recorded") evaluates to
  NULL on the row that omits the column, and NULL is not false, so the row is admitted. Each
  `…_coherent` case below therefore attacks BOTH halves: the arm that states too much and the
  arm that states too little. A rule that only catches one direction fails one of the pair.

  ## What C.0 changed, and what these cases now assert

  Phase B expressed "the stand's own goods" as a **native brand slot** — a `stand_providers` row
  with `seller_id` NULL — and this file proved the rules that guarded it. §the stand-and-sellers
  correction removed that concept: `stand_providers.seller_id` is `NOT NULL`, a stand's own goods
  are simply its own seller named like any other, and `sales_locations.own_seller_id` — the
  **self-pointer** — records which nested seller IS the stand.

  So the native cases are not repaired here, they are REPLACED. What takes their place is the
  guarantee the correction actually makes:

  - `seller_id` is `NOT NULL`, so no row can exist with no seller behind it (23502).
  - The self-pointer is nullable and stays nullable — a venue like Morgan Hill sells nothing of
    its own, and NULL is that fact rather than a migration shim.
  - `sales_locations_create_own_seller_provider` fires **only when a stand names its own
    seller**, on insert and on any later change of the pointer, and fabricates nothing for a
    venue that names none. Phase B's trigger fired for every stand and would have had to invent
    a seller; this one cannot.
  - Every provider row is a real seller-at-stand relationship with an invitation behind it, so
    `stand_providers_hosting_lifecycle_coherent` has no native arm left to test.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/** Postgres codes: 23514 is a CHECK violation, 23505 a unique violation, 23503 an FK one. */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
/** 23502 is a NOT NULL violation — what refuses the removed native slot. */
const NOT_NULL_VIOLATION = "23502";

describe("F-114 stand_providers constraints, by sabotage (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let farmId = "";
  let otherSellerId = "";
  let locationId = "";
  let otherLocationId = "";
  /** The provider row for the seller the stand's self-pointer names — no longer a native slot. */
  let ownProviderId = "";
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

  /**
   * A fresh seller, so each availability case attacks its own row rather than colliding on
   * `stand_providers_one_per_seller_per_location`. Phase B's cases reached for the native slot
   * to get a cheap insert; with the slot gone every row needs a seller behind it.
   */
  const freshSeller = async (name: string): Promise<string> => {
    const rows = await client()`
      insert into sellers (name) values (${`${name} ${randomUUID().slice(0, 8)}`}) returning id
    `;
    return rows[0]?.id as string;
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

    // The trigger created this row when the stand named its own seller. It is found through the
    // SELF-POINTER, which is the recorded fact that replaced the native slot.
    const own = await db`
      select id from stand_providers
      where sales_location_id = ${locationId}
        and seller_id = (select own_seller_id from sales_locations where id = ${locationId})
    `;
    ownProviderId = own[0]?.id as string;

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

  describe("the native brand slot is gone", () => {
    it("refuses a provider row naming NO seller", async () => {
      // The concept `stand_providers_one_native_per_location` guarded no longer exists. What
      // replaced it is stronger and needs no partial index: `seller_id` is NOT NULL, so the
      // sellerless row cannot be written at all rather than being written once per stand.
      const db = client();
      await refuses(
        () => db`
          insert into stand_providers (sales_location_id, seller_id, lifecycle_state)
          values (${locationId}, null, 'active')
        `,
        { code: NOT_NULL_VIOLATION },
      );
    });

    it("holds no sellerless row anywhere, including the ones the migration wrote", async () => {
      // The NOT NULL above proves nothing about rows the migration itself created. Assert the
      // populated table directly: every provider row, however it got here, names a seller.
      const rows = await client()`
        select
          count(*) filter (where seller_id is null)::int as sellerless,
          count(*)::int as total
        from stand_providers
      `;
      expect(rows[0]?.sellerless).toBe(0);
      expect(rows[0]?.total as number).toBeGreaterThan(0);
    });

    it("keeps the index keyed on the seller, with no native partial index beside it", async () => {
      // A sellerless row being unwritable is what makes a plain unique on (location, seller)
      // sufficient — Postgres treats NULLs as distinct, which is exactly why Phase B needed a
      // second partial index. If that index came back, one concept would be stored two ways.
      const rows = await client()`
        select indexname from pg_indexes
        where tablename = 'stand_providers' and indexname like '%native%'
      `;
      expect(rows).toHaveLength(0);
    });
  });

  describe("the self-pointer", () => {
    it("admits a VENUE that names no seller of its own", async () => {
      // Morgan Hill Community Stand: real identity, nested sellers, no goods of its own. NULL
      // here is a permanent shape, not a migration shim — a NOT NULL would force VIGA to invent
      // the fabricated owner farm this correction exists to remove.
      const db = client();
      const venue = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          null, 'farm_stand', 'Venue With No Goods', 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          'Venue Road, Vashon WA', 47.4473, -122.4590
        ) returning id
      `;
      const venueId = venue[0]?.id as string;
      expect(venueId).toBeTruthy();

      // And the trigger fabricated NOTHING for it. This is the half Phase B's trigger could not
      // express: firing for every stand, it would have had to invent a seller here.
      const providers = await db`
        select id from stand_providers where sales_location_id = ${venueId}
      `;
      expect(providers).toHaveLength(0);
    });

    it("refuses a self-pointer naming a seller that does not exist", async () => {
      const db = client();
      await refuses(
        () => db`
          insert into sales_locations (
            own_seller_id, kind, name, timezone, visitability, offering_type,
            is_public, farm_bucks_accepted, farm_bucks_eligible,
            public_address, public_latitude, public_longitude
          ) values (
            ${randomUUID()}, 'farm_stand', 'Phantom Stand', 'America/Los_Angeles',
            'visitable', 'produce', true, false, false,
            'Phantom Road, Vashon WA', 47.4473, -122.4590
          )
        `,
        { code: FK_VIOLATION },
      );
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
    it("refuses an ACTIVE provider with an invitation but no acceptance", async () => {
      // The half that says too much about state and too little about evidence. Phase B had a
      // native arm exempting the sellerless row from all of this; C.0 removed the arm because
      // every provider row is now a real relationship with an invitation behind it.
      const db = client();
      const seller = await freshSeller("Unaccepted");
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at
          ) values (${otherLocationId}, ${seller}, 'active', now())
        `,
        {
          code: CHECK_VIOLATION,
          constraint: "stand_providers_hosting_lifecycle_coherent",
        },
      );
    });

    it("refuses a PENDING provider that already records an acceptance", async () => {
      // The mirror image: `pending` means an invitation nobody has answered, so an acceptance
      // recorded against it contradicts the state it claims.
      const db = client();
      const seller = await freshSeller("PendingButAccepted");
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at
          ) values (${otherLocationId}, ${seller}, 'pending', now(), now())
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
      const seller = await freshSeller("EmptyDays");
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, open_days
          ) values (
            ${otherLocationId}, ${seller}, 'active', now(), now(), 'viga', now(),
            ${db.array([] as number[])}::integer[]
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_valid_open_days" },
      );
    });

    it("refuses a weekday outside 0..6", async () => {
      const db = client();
      const seller = await freshSeller("BadWeekday");
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, open_days
          ) values (
            ${otherLocationId}, ${seller}, 'active', now(), now(), 'viga', now(),
            ${db.array([0, 7])}::integer[]
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_valid_open_days" },
      );
    });
  });

  describe("stand_providers_coherent_open_hours and season", () => {
    it("refuses a clock_range with no times", async () => {
      const db = client();
      const seller = await freshSeller("ClockNoTimes");
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, open_hours_kind
          ) values (
            ${otherLocationId}, ${seller}, 'active', now(), now(), 'viga', now(), 'clock_range'
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_coherent_open_hours" },
      );
    });

    it("refuses a date_range season with no dates", async () => {
      const db = client();
      const seller = await freshSeller("RangeNoDates");
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, season_kind
          ) values (
            ${otherLocationId}, ${seller}, 'active', now(), now(), 'viga', now(), 'date_range'
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_coherent_season" },
      );
    });

    it("refuses a named_season with an EMPTY name array", async () => {
      const db = client();
      const seller = await freshSeller("NamedNoNames");
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, season_kind, season_names
          ) values (
            ${otherLocationId}, ${seller}, 'active', now(), now(), 'viga', now(),
            'named_season', ${db.array([] as string[])}::text[]
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_coherent_season" },
      );
    });
  });

  describe("stand_providers_ending_coherent and public_note", () => {
    it("refuses a relationship that ended BEFORE it was invited", async () => {
      // Phase B's case here was "the native slot never ends", which the removed arm enforced.
      // What survives is the ordering rule, and it needs a real relationship to attack.
      const db = client();
      const seller = await freshSeller("EndedTooEarly");
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, ended_at
          ) values (
            ${otherLocationId}, ${seller}, 'active', now(), now(), 'viga', now(),
            now() - interval '1 day'
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_ending_coherent" },
      );
    });

    it("refuses a blank public note", async () => {
      // `btrim(text)` with no second argument strips SPACES ONLY, so the whitespace characters
      // are named explicitly — a tab-and-newline note caught the default admitting it.
      const db = client();
      const seller = await freshSeller("BlankNote");
      await refuses(
        () => db`
          insert into stand_providers (
            sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
            approval_source, approved_at, public_note
          ) values (
            ${otherLocationId}, ${seller}, 'active', now(), now(), 'viga', now(), ${"\t\n "}
          )
        `,
        { code: CHECK_VIOLATION, constraint: "stand_providers_public_note_not_blank" },
      );
    });
  });

  describe("sellers constraints", () => {
    it("refuses an empty and a space-only seller name", async () => {
      // `sellers_name_not_blank` is the RENAMED `farms_name_not_blank` — 0042 changed its name
      // and nothing else, so what it guarantees is unchanged: `trim()` with no second argument
      // strips SPACES ONLY. Both values below are what it actually refuses.
      await refuses(
        () => client()`insert into sellers (name) values (${""})`,
        { code: CHECK_VIOLATION, constraint: "sellers_name_not_blank" },
      );
      await refuses(
        () => client()`insert into sellers (name) values (${"   "})`,
        { code: CHECK_VIOLATION, constraint: "sellers_name_not_blank" },
      );
    });

    it("ADMITS a tab-and-newline seller name — the gap bare trim() leaves", async () => {
      // Not an endorsement: an assertion of the measured truth, so this file states what the
      // database does rather than what the constraint's name suggests. `stand_providers`'
      // `btrim(…, E' \t\r\n')` is the shape that closes it, and seventeen `*_not_blank` CHECKs
      // predating F-114 share this one — B-076 tracks fixing them together, since fixing one
      // would leave two behaviours for one rule. INVERT this case when that lands.
      const rows = await client()`
        insert into sellers (name) values (${"\t\n "}) returning name
      `;
      expect(rows).toHaveLength(1);
    });

    it("refuses a retirement naming nobody, and an actor with no retirement", async () => {
      // Phase B had a separate `sellers` table with its own `revoked_at`/`revoked_by` pair. When
      // that table merged into the renamed identity record, `retired_at` already meant exactly
      // this, so `sellers_coherent_revocation` was NOT recreated — keeping both would be two
      // ways to state one fact. This asserts the surviving biconditional, both halves.
      const db = client();
      await refuses(
        () => db`insert into sellers (name, retired_at) values ('Half', now())`,
        { code: CHECK_VIOLATION, constraint: "sellers_coherent_retirement" },
      );
      await refuses(
        () => db`
          insert into sellers (name, retired_by_administrator_id)
          values ('OtherHalf', ${administratorId})
        `,
        { code: CHECK_VIOLATION, constraint: "sellers_coherent_retirement" },
      );
    });

    it("carries no revocation pair beside the retirement one", async () => {
      // The merge is only real if the duplicate columns actually went. A `revoked_at` still
      // sitting on the table would be a second way to say "VIGA took this seller down", and
      // the reader that picked the wrong one would silently keep a retired seller published.
      const rows = await client()`
        select column_name from information_schema.columns
        where table_name = 'sellers' and column_name like 'revoked%'
      `;
      expect(rows).toHaveLength(0);
    });

    it("carries no seller-of-a-seller reference", async () => {
      // `sellers_one_per_farm` paired Phase B's brand table to a farm. `farms` was renamed INTO
      // this table, so a seller pointing at a seller would be the two-records-for-one-brand
      // shape the correction collapsed.
      const rows = await client()`
        select column_name from information_schema.columns
        where table_name = 'sellers' and column_name = 'seller_id'
      `;
      expect(rows).toHaveLength(0);
    });

    it("admits many sellers, none of which owns a stand", async () => {
      // A bakery and a maker are two sellers and neither has a stand of its own. Nothing about
      // a seller requires one — that is what lets `Fernhorn Bakery` exist as a hosted seller.
      const db = client();
      const rows = await db`
        insert into sellers (name) values ('Baker A'), ('Maker B') returning id
      `;
      expect(rows).toHaveLength(2);
      const owned = await db`
        select count(*)::int as n from sales_locations
        where own_seller_id in ${db(rows.map((row) => row.id as string))}
      `;
      expect(owned[0]?.n).toBe(0);
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
            ${farmId}, ${otherLocationId}, ${ownProviderId}, 'viga', now(), true
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
          values (${otherLocationId}, ${ownProviderId}, 'eggs')
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
        values (${locationId}, ${ownProviderId}, 'Eggs')
      `;
      await refuses(
        () => db`
          insert into stand_items (sales_location_id, provider_id, display_name)
          values (${locationId}, ${ownProviderId}, ${"  eggs "})
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
        ) values (${farmId}, ${locationId}, ${ownProviderId}, 'viga', now(), true)
      `;
      await refuses(
        () => db`
          insert into inventory_revisions (
            seller_id, sales_location_id, provider_id, source, published_at, is_current
          ) values (${farmId}, ${locationId}, ${ownProviderId}, 'viga', now(), true)
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
      //
      // The hosted row carries the HOSTED seller. It once carried `farmId` — the stand's own
      // seller on the hosted seller's relationship — which was admissible only because nothing
      // checked it; `inventory_revisions_provider_seller_fk` (F-114 C.2, `0045`) now refuses
      // that shape, and rightly: it files the host's goods under someone else's arrangement.
      const db = client();
      const hosted = await db`
        select id from stand_providers
        where sales_location_id = ${locationId} and seller_id = ${sellerId}
      `;
      const rows = await db`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, source, published_at, is_current
        ) values (
          ${sellerId}, ${locationId}, ${hosted[0]?.id as string}, 'viga', now(), true
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

  describe("create_own_seller_provider — the trigger that fires only on a self-pointer", () => {
    it("creates the provider for a stand that NAMES its own seller on insert", async () => {
      // Two writers create stands today. The guarantee lives in the database so the number of
      // writers that must remember it is zero.
      const db = client();
      const seller = await freshSeller("BrandNew");
      const created = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          ${seller}, 'farm_stand', 'Brand New Stand', 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          'New Road, Vashon WA', 47.4473, -122.4590
        ) returning id
      `;
      const rows = await db`
        select seller_id, lifecycle_state, approval_source from stand_providers
        where sales_location_id = ${created[0]?.id as string}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.seller_id).toBe(seller);
      expect(rows[0]?.lifecycle_state).toBe("active");
      expect(rows[0]?.approval_source).toBe("viga");
    });

    it("creates it when a VENUE later names one of its sellers as itself", async () => {
      // The trigger fires on UPDATE OF own_seller_id too, which is the path VIGA takes when a
      // venue turns out to sell something of its own. Without it the stand would name a seller
      // it holds no provider row for, and could publish no inventory at all.
      const db = client();
      const venue = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          null, 'farm_stand', 'Venue That Grows Up', 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          'Growup Road, Vashon WA', 47.4473, -122.4590
        ) returning id
      `;
      const venueId = venue[0]?.id as string;
      expect(await db`
        select id from stand_providers where sales_location_id = ${venueId}
      `).toHaveLength(0);

      const seller = await freshSeller("GrewGoods");
      await db`
        update sales_locations set own_seller_id = ${seller} where id = ${venueId}
      `;
      const rows = await db`
        select seller_id, lifecycle_state from stand_providers
        where sales_location_id = ${venueId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.seller_id).toBe(seller);
      expect(rows[0]?.lifecycle_state).toBe("active");
    });

    it("does not disturb the existing row when the self-pointer is set to the same seller", async () => {
      // `ON CONFLICT DO NOTHING` is what makes the update arm idempotent. Without it a no-op
      // save of a stand's own listing would raise a unique violation the farmer would see.
      const db = client();
      const before = await db`
        select id from stand_providers where sales_location_id = ${locationId}
      `;
      await db`
        update sales_locations set own_seller_id = ${farmId} where id = ${locationId}
      `;
      const after = await db`
        select id from stand_providers where sales_location_id = ${locationId}
      `;
      expect(after.map((row) => row.id as string).sort())
        .toEqual(before.map((row) => row.id as string).sort());
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
        where provider_id = ${ownProviderId} and is_current
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
