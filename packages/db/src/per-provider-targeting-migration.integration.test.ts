import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.3 — `0047` against a POPULATED copy of the schema that precedes it.

  ## Why a constraint-only migration still needs this

  `0047` adds no column and rewrites no row, which is exactly the shape that looks safest and is
  not. `ADD CONSTRAINT … FOREIGN KEY` on a populated table VALIDATES against every row already
  there, so each replacement either holds for the live targeting rows or the migration fails in
  production having passed on every empty database in the repo.

  The claim under test is a claim about real data: *every target and every standing link today
  names the stand's own listing, whose seller IS the stand's own seller, so the `(provider,
  seller)` replacements are already satisfied.* That is reasoning, not evidence, until a
  populated run proves it — the same reasoning that made `0042`'s generated
  `ADD COLUMN … NOT NULL` look fine and fail on the first real database.

  ## What this file populates, and why each row is here

    1. A stand with a seller of its own, a live authorization, and a standing link — the 38-stand
       case, and the rows every replacement must accept unchanged.
    2. A durable target selection and a two-option menu, because those are the rows carrying the
       `(location, own_seller)` and `(authorization, seller)` pairs the migration replaces. A
       migration that dropped a reference silently would leave these pointing at nothing.
    3. A HOSTED provider with no target of its own — present so the migration is proved not to
       backfill, infer, or re-root anything onto it.
    4. A revoked authorization's link, so the `restrict`/`cascade` behaviours are exercised on
       rows that exist rather than only on the ones under test.

  ## What is asserted

  Exact row effects: every target, menu option and link unchanged by id; the counts unchanged;
  each dropped constraint absent BY NAME; each replacement present BY NAME; the replacements
  actually VALIDATED rather than added `NOT VALID` (`convalidated`, because `NOT VALID` still
  refuses new rows and a violating-insert probe therefore cannot detect it); and the new
  behaviour the whole phase exists for — a hosted target — admitted where it was refused.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/* Ordered BEFORE `0047`, never "everything that is not `0047`" — an exclusion filter is correct
   only while its own migration is the newest in the repo, and breaks the moment one lands after
   it. Three earlier migration suites were repaired for exactly this. */
const beforeThisWork = migrationFiles.filter((name) => name < "0047_");
const thisWork = migrationFiles.filter((name) => name.startsWith("0047_"));

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-114 C.3 targeting migration against a populated schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let ownSellerId = "";
  let hostedSellerId = "";
  let standLocationId = "";
  let ownProviderId = "";
  let hostedProviderId = "";
  let authorizationId = "";
  let revokedAuthorizationId = "";
  let senderHash = "";
  let liveLinkId = "";
  let revokedLinkId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114targetmig_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 4 });
    const db = client();

    // ---- 1. the schema as it stands BEFORE this work ---------------------------------------
    expect(thisWork).toHaveLength(1);
    expect(beforeThisWork.length).toBeGreaterThan(46);
    for (const file of beforeThisWork) await applyFile(db, file);

    // ---- 2. populate it --------------------------------------------------------------------
    const sellers = await db`
      insert into sellers (name) values ('Venison Valley'), ('Gracies Greens') returning id
    `;
    ownSellerId = sellers[0]?.id as string;
    hostedSellerId = sellers[1]?.id as string;

    const locations = await db`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${ownSellerId}, 'farm_stand', 'Venison Valley Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        'Venison Valley Road, Vashon WA', 47.4473, -122.4590
      ) returning id
    `;
    standLocationId = locations[0]?.id as string;

    const own = await db`
      select id from stand_providers
      where sales_location_id = ${standLocationId} and seller_id = ${ownSellerId}
    `;
    ownProviderId = own[0]?.id as string;

    const hosted = await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standLocationId}, ${hostedSellerId}, 'active', true,
        now(), now(), 'viga', now()
      ) returning id
    `;
    hostedProviderId = hosted[0]?.id as string;

    senderHash = `h${randomUUID().replaceAll("-", "")}`;
    const contacts = await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065551000', ${senderHash}) returning id
    `;
    const contactId = contacts[0]?.id as string;

    /*
      The REVOKED one is inserted first and revoked before the live one exists.
      `farmer_authorizations_one_active_contact_per_seller` admits exactly one live row per
      (seller, contact), so inserting both and revoking afterwards is refused — which is the
      constraint doing its job, and is also how the real corpus reaches this state.
    */
    const revoked = await db`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${ownSellerId}, ${contactId}, now(), now()) returning id
    `;
    revokedAuthorizationId = revoked[0]?.id as string;
    await db`
      update farmer_authorizations set revoked_at = now() where id = ${revokedAuthorizationId}
    `;
    const authorizations = await db`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${ownSellerId}, ${contactId}, now(), now()) returning id
    `;
    authorizationId = authorizations[0]?.id as string;

    // The durable selection and its menu — the rows carrying both pairs `0047` replaces.
    await db`
      insert into farmer_target_contexts (
        sender_hash, selected_authorization_id, selected_owner_seller_id,
        selected_sales_location_id, selected_provider_id, selected_at,
        menu_issued_at, menu_expires_at, menu_purpose, updated_at
      ) values (
        ${senderHash}, ${authorizationId}, ${ownSellerId},
        ${standLocationId}, ${ownProviderId}, now(),
        now(), now() + interval '12 hours', 'update', now()
      )
    `;
    await db`
      insert into farmer_target_menu_options (
        sender_hash, option_number, authorization_id, owner_seller_id,
        sales_location_id, provider_id
      ) values (
        ${senderHash}, 1, ${authorizationId}, ${ownSellerId},
        ${standLocationId}, ${ownProviderId}
      )
    `;

    const links = await db`
      insert into farmer_links (
        token_hash, authorization_id, owner_seller_id, sales_location_id,
        provider_id, issued_at
      ) values
        (
          ${"a".repeat(64)}, ${authorizationId}, ${ownSellerId},
          ${standLocationId}, ${ownProviderId}, now()
        ),
        (
          ${"b".repeat(64)}, ${revokedAuthorizationId}, ${ownSellerId},
          ${standLocationId}, ${ownProviderId}, now()
        )
      returning id, token_hash
    `;
    liveLinkId = links.find((row) => row.token_hash === "a".repeat(64))?.id as string;
    revokedLinkId = links.find((row) => row.token_hash === "b".repeat(64))?.id as string;

    // ---- 3. the migration under test -------------------------------------------------------
    for (const file of thisWork) await applyFile(db, file);
  }, 90_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  it("preserves every target, menu option, and link exactly", async () => {
    expect(await client()`
      select sender_hash, selected_authorization_id, selected_owner_seller_id,
             selected_sales_location_id, selected_provider_id
      from farmer_target_contexts
    `).toEqual([
      {
        sender_hash: senderHash,
        selected_authorization_id: authorizationId,
        selected_owner_seller_id: ownSellerId,
        selected_sales_location_id: standLocationId,
        selected_provider_id: ownProviderId,
      },
    ]);
    expect(await client()`
      select option_number, authorization_id, owner_seller_id, sales_location_id, provider_id
      from farmer_target_menu_options
    `).toEqual([
      {
        option_number: 1,
        authorization_id: authorizationId,
        owner_seller_id: ownSellerId,
        sales_location_id: standLocationId,
        provider_id: ownProviderId,
      },
    ]);
    expect(await client()`
      select id, authorization_id, owner_seller_id, provider_id
      from farmer_links order by token_hash
    `).toEqual([
      {
        id: liveLinkId,
        authorization_id: authorizationId,
        owner_seller_id: ownSellerId,
        provider_id: ownProviderId,
      },
      {
        id: revokedLinkId,
        authorization_id: revokedAuthorizationId,
        owner_seller_id: ownSellerId,
        provider_id: ownProviderId,
      },
    ]);
  });

  it("removed each constraint that asserted the target's seller is the stand's own", async () => {
    const gone = await client()`
      select conname from pg_constraint
      where conname in (
        'farmer_target_contexts_selected_location_own_seller_fk',
        'farmer_target_menu_options_location_own_seller_fk',
        'farmer_target_contexts_selected_authorization_owner_fk',
        'farmer_target_menu_options_authorization_owner_fk',
        'farmer_links_targeted_authorization_owner_fk',
        'farmer_links_targeted_location_own_seller_fk'
      )
    `;
    expect(gone).toEqual([]);
  });

  it("added each replacement by name", async () => {
    const rows = await client()`
      select conname from pg_constraint
      where conname in (
        'farmer_target_contexts_selected_provider_seller_fk',
        'farmer_target_menu_options_provider_seller_fk',
        'farmer_links_targeted_provider_seller_fk',
        'farmer_target_contexts_selected_authorization_fk',
        'farmer_target_menu_options_authorization_fk',
        'farmer_links_targeted_authorization_fk'
      )
      order by conname
    `;
    expect(rows.map((row) => row.conname as string)).toEqual([
      "farmer_links_targeted_authorization_fk",
      "farmer_links_targeted_provider_seller_fk",
      "farmer_target_contexts_selected_authorization_fk",
      "farmer_target_contexts_selected_provider_seller_fk",
      "farmer_target_menu_options_authorization_fk",
      "farmer_target_menu_options_provider_seller_fk",
    ]);
  });

  it("validated every replacement against the rows that were already there", async () => {
    /*
      The specific way a constraint migration passes a whole suite while leaving live data
      unchecked. `NOT VALID` on a FOREIGN KEY still refuses every NEW row — so the obvious probe,
      inserting a violating row and requiring the refusal, passes either way and proves nothing.
      A deliberate `NOT VALID` sabotage sailed straight through that probe in C.2.

      What `NOT VALID` actually skips is the scan of rows already present. So the assertion is on
      `convalidated`, which is the fact that differs, checked against the populated schema
      precisely because that is where unvalidated rows would hide.
    */
    const rows = await client()`
      select conname, convalidated from pg_constraint
      where conname in (
        'farmer_target_contexts_selected_provider_seller_fk',
        'farmer_target_menu_options_provider_seller_fk',
        'farmer_links_targeted_provider_seller_fk',
        'farmer_target_contexts_selected_authorization_fk',
        'farmer_target_menu_options_authorization_fk',
        'farmer_links_targeted_authorization_fk'
      )
      order by conname
    `;
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.convalidated === true)).toBe(true);
  });

  it("admits the hosted target the old keys forbade", async () => {
    // The whole point of the migration, by effect against real preceding data: a menu option
    // naming Gracie's Greens' listing under the HOST'S authorization — a hosted seller's goods
    // reached under the stand's own phone, which is arms 2 of the write authority.
    const inserted = await client()`
      insert into farmer_target_menu_options (
        sender_hash, option_number, authorization_id, owner_seller_id,
        sales_location_id, provider_id
      ) values (
        ${senderHash}, 2, ${authorizationId}, ${hostedSellerId},
        ${standLocationId}, ${hostedProviderId}
      ) returning option_number
    `;
    expect(inserted).toEqual([{ option_number: 2 }]);
    await client()`
      delete from farmer_target_menu_options
      where sender_hash = ${senderHash} and option_number = 2
    `;
  });

  it("still refuses an option whose seller is not the provider's", async () => {
    /*
      The guarantee the replacement KEEPS, and the reason dropping these keys outright was
      wrong: without it a menu row could name one seller's listing under another's name and
      nothing anywhere would see it.

      A SECOND sender, and `one_number_per_pair` is why. That unique index covers
      `(sender, authorization, provider)`, and the fixture's sender already holds a row for this
      exact (authorization, provider) pair — so a probe on that sender is refused by the INDEX
      before any foreign key is consulted, and passes whether or not `0047` ran. On a fresh
      sender the pair is free, leaving the mismatched SELLER as the only thing that can refuse.
    */
    const otherHash = `h${randomUUID().replaceAll("-", "")}`;
    await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065551099', ${otherHash})
    `;
    await client()`
      insert into farmer_target_contexts (sender_hash, updated_at)
      values (${otherHash}, now())
    `;
    await expect(
      client()`
        insert into farmer_target_menu_options (
          sender_hash, option_number, authorization_id, owner_seller_id,
          sales_location_id, provider_id
        ) values (
          ${otherHash}, 1, ${authorizationId}, ${hostedSellerId},
          ${standLocationId}, ${ownProviderId}
        )
      `,
    ).rejects.toThrow(/farmer_target_menu_options_provider_seller_fk/);
  });

  it("still refuses a selection whose seller is not the provider's", async () => {
    await expect(
      client()`
        update farmer_target_contexts
        set selected_owner_seller_id = ${hostedSellerId}
        where sender_hash = ${senderHash}
      `,
    ).rejects.toThrow(/farmer_target_contexts_selected_provider_seller_fk/);
  });

  it("still refuses a link whose seller is not the provider's", async () => {
    /*
      `farmer_links_one_live_per_authorization` is a partial unique index on the live rows, so a
      second live link for an authorization that already holds one is refused by the INDEX
      before any foreign key is consulted — passing with or without `0047`. The REVOKED
      authorization's slot is used instead, which is free, leaving the mismatched seller as the
      only thing that can refuse.
    */
    await expect(
      client()`
        insert into farmer_links (
          token_hash, authorization_id, owner_seller_id, sales_location_id,
          provider_id, issued_at, revoked_at
        ) values (
          ${"c".repeat(64)}, ${revokedAuthorizationId}, ${hostedSellerId},
          ${standLocationId}, ${ownProviderId}, now(), now()
        )
      `,
    ).rejects.toThrow(/farmer_links_targeted_provider_seller_fk/);
  });

  it("is a no-op when applied twice", async () => {
    // Every integration run applies the folder twice, so a non-idempotent statement fails the
    // whole suite far from its cause. Asserted here against the populated schema as well.
    for (const file of thisWork) await applyFile(client(), file);
    expect(await client()`select count(*)::int as n from farmer_target_menu_options`)
      .toEqual([{ n: 1 }]);
    expect(await client()`select count(*)::int as n from farmer_links`).toEqual([{ n: 2 }]);
  });
});
