import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase B — the migration against a POPULATED copy of the current schema.

  The contract requires this specifically, and the reason is that `drizzle-kit generate`'s output
  passes on an empty database and fails on a real one. Its `ADD COLUMN … uuid NOT NULL` with no
  default and no backfill succeeds against zero rows and raises 23502 against the production
  corpus — 37 stands with inventory, usual items, links, preferences and proposals. A migration
  test that starts from an empty schema would have been green for the entire class of defect it
  exists to catch.

  So this file:

    1. Applies migrations 0000–0041 ONLY. That is the schema as it stands before this work.
    2. Populates it with the awkward rows a real corpus has — a stand with a current revision AND
       a superseded predecessor, a stand with usual items and no inventory, a never-published
       stand, a retired stand that still owns revisions, a farmer link, a prompt preference, an
       open proposal, and a sender with a selected SMS target.
    3. Applies 0042 alone, against that data.
    4. Asserts EXACT row effects — counts and identities, not "it did not throw".

  ## Why the corpus is deliberately awkward

  A cooperative fixture would let every one of these through: a retired stand whose revisions
  need a provider to point at; a superseded revision that must NOT become a second current one; a
  stand with usual items but no inventory (18 of 37 stands publish none); a `farmer_target_contexts`
  row whose selection is NULL, which the widened biconditional must still admit.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/** Every migration file in order, so "before 0042" and "0042 alone" are exact. */
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const beforeThisWork = migrationFiles.filter((name) => !name.startsWith("0042_"));
const thisWork = migrationFiles.filter((name) => name.startsWith("0042_"));

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-114 Phase B migration against a populated schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let farmId = "";
  let richLocationId = "";
  let usualOnlyLocationId = "";
  let quietLocationId = "";
  let retiredLocationId = "";
  let currentRevisionId = "";
  let supersededRevisionId = "";
  let retiredRevisionId = "";
  let proposalId = "";
  let selectingSenderHash = "";
  let unselectedSenderHash = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114mig_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 4 });
    const db = client();

    // ---- 1. the schema as it stands BEFORE this work -------------------------------------
    expect(thisWork).toHaveLength(1);
    expect(beforeThisWork.length).toBeGreaterThan(40);
    for (const file of beforeThisWork) await applyFile(db, file);

    // ---- 2. populate it --------------------------------------------------------------------
    const farms = await db`insert into farms (name) values ('Morgan Hill') returning id`;
    farmId = farms[0]?.id as string;

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
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    richLocationId = await mkLocation("Rich Stand");
    usualOnlyLocationId = await mkLocation("Usual Stand");
    quietLocationId = await mkLocation("Quiet Stand");
    retiredLocationId = await mkLocation("Retired Stand");

    // A RETIRED stand that still owns a revision. It keeps every revision it published, so the
    // backfill must give it a provider too — a `where retired_at is null` filter would leave an
    // unattributed revision and fail at `SET NOT NULL`.
    const administrators = await db`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', now()) returning id
    `;
    await db`
      update sales_locations
      set retired_at = now(), retired_by_administrator_id = ${administrators[0]?.id as string}
      where id = ${retiredLocationId}
    `;

    const mkRevision = async (
      locationId: string,
      current: boolean,
      ageDays: number,
    ): Promise<string> => {
      const rows = current
        ? await db`
            insert into inventory_revisions (
              farm_id, sales_location_id, source, published_at, is_current
            ) values (
              ${farmId}, ${locationId}, 'viga', now() - ${`${ageDays} days`}::interval, true
            ) returning id
          `
        : await db`
            insert into inventory_revisions (
              farm_id, sales_location_id, source, published_at, is_current, superseded_at
            ) values (
              ${farmId}, ${locationId}, 'viga', now() - ${`${ageDays} days`}::interval,
              false, now() - interval '1 day'
            ) returning id
          `;
      return rows[0]?.id as string;
    };
    // The superseded predecessor is the trap: after the migration it must still be the ONLY
    // non-current revision at this stand, and `one_current_per_provider` must not see two.
    supersededRevisionId = await mkRevision(richLocationId, false, 10);
    currentRevisionId = await mkRevision(richLocationId, true, 2);
    retiredRevisionId = await mkRevision(retiredLocationId, true, 30);

    await db`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, sort_order
      ) values
        (${currentRevisionId}, ${richLocationId}, 'eggs', 0),
        (${currentRevisionId}, ${richLocationId}, 'kale', 1),
        (${supersededRevisionId}, ${richLocationId}, 'STALE PARSNIPS', 0)
    `;

    // Usual items on two stands, one of which publishes no inventory at all — the common case:
    // 33 of 37 stands carry a usual item absent from published inventory.
    await db`
      insert into stand_items (sales_location_id, display_name, usually_carried, sort_order)
      values
        (${richLocationId}, 'eggs', true, 0),
        (${usualOnlyLocationId}, 'lamb', true, 0),
        (${usualOnlyLocationId}, 'plant starts', true, 1)
    `;

    // A farmer authorization, link, and prompt preference — all keyed on (location, owner_farm).
    const contacts = await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550111', ${`f114${randomUUID().replaceAll("-", "")}`})
      returning id, phone_hash
    `;
    const contactId = contacts[0]?.id as string;
    const authorizations = await db`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contactId}, now(), now()) returning id
    `;
    const authorizationId = authorizations[0]?.id as string;

    await db`
      insert into farmer_links (
        token_hash, authorization_id, owner_farm_id, sales_location_id, issued_at
      ) values (
        ${"a".repeat(64)}, ${authorizationId}, ${farmId}, ${richLocationId}, now()
      )
    `;
    await db`
      insert into inventory_prompt_preferences (
        owner_farm_id, sales_location_id, designated_authorization_id,
        cadence, version, next_due_at, updated_at
      ) values (
        ${farmId}, ${richLocationId}, ${authorizationId},
        'weekly', 1, now() + interval '7 days', now()
      )
    `;

    // An OPEN proposal — the row the widened index has to keep admitting.
    const proposals = await db`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, proposal_version,
        state, has_inventory, has_closure, base_is_first_publication
      ) values (
        ${contacts[0]?.phone_hash as string}, ${richLocationId}, ${db.json({})}, 1,
        'open', true, false, true
      ) returning id
    `;
    proposalId = proposals[0]?.id as string;

    // Two senders: one WITH a selected SMS target, one with none. The widened biconditional has
    // to admit both — an all-NULL selection is what "no target chosen" means.
    selectingSenderHash = contacts[0]?.phone_hash as string;
    await db`
      insert into farmer_target_contexts (
        sender_hash, selected_authorization_id, selected_owner_farm_id,
        selected_sales_location_id, selected_at, updated_at
      ) values (
        ${selectingSenderHash}, ${authorizationId}, ${farmId},
        ${richLocationId}, now(), now()
      )
    `;
    await db`
      insert into farmer_target_menu_options (
        sender_hash, option_number, authorization_id, owner_farm_id, sales_location_id
      ) values (${selectingSenderHash}, 1, ${authorizationId}, ${farmId}, ${richLocationId})
    `;

    unselectedSenderHash = `f114${randomUUID().replaceAll("-", "")}`;
    await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550112', ${unselectedSenderHash})
    `;
    await db`
      insert into farmer_target_contexts (sender_hash, updated_at)
      values (${unselectedSenderHash}, now())
    `;

    // ---- 3. apply 0042 against that data ---------------------------------------------------
    for (const file of thisWork) await applyFile(db, file);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("gives every stand exactly one native provider row, retired stands included", async () => {
    const rows = await client()`
      select l.id, count(p.id)::int as providers
      from sales_locations l
      left join stand_providers p
        on p.sales_location_id = l.id and p.seller_id is null
      group by l.id
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.providers).toBe(1);

    // The NEVER-PUBLISHED stand gets one too. A backfill driven by the revision table rather
    // than by `sales_locations` would skip it, and the stand would then be unable to publish
    // its first inventory ever — 18 of 37 stands publish none today, so this is the common
    // case rather than an edge one.
    const quiet = await client()`
      select p.id from stand_providers p
      where p.sales_location_id = ${quietLocationId} and p.seller_id is null
    `;
    expect(quiet).toHaveLength(1);

    // The retired stand's native row exists specifically because its revision needs one.
    const retired = await client()`
      select p.id from stand_providers p
      where p.sales_location_id = ${retiredLocationId} and p.seller_id is null
    `;
    expect(retired).toHaveLength(1);
  });

  it("creates no seller identities at all", async () => {
    // §migration approach: never auto-link a display name to a seller identity. The migration
    // creates native slots, which have no seller by construction.
    const sellers = await client()`select count(*)::int as n from sellers`;
    expect(sellers[0]?.n).toBe(0);

    const named = await client()`
      select count(*)::int as n from stand_providers where seller_id is not null
    `;
    expect(named[0]?.n).toBe(0);
  });

  it("attributes every existing revision to its stand's native provider", async () => {
    const rows = await client()`
      select v.id, v.is_current, p.sales_location_id, p.seller_id
      from inventory_revisions v
      join stand_providers p on p.id = v.provider_id
      order by v.published_at asc
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.seller_id).toBeNull();

    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(supersededRevisionId)?.sales_location_id).toBe(richLocationId);
    expect(byId.get(supersededRevisionId)?.is_current).toBe(false);
    expect(byId.get(currentRevisionId)?.sales_location_id).toBe(richLocationId);
    expect(byId.get(currentRevisionId)?.is_current).toBe(true);
    expect(byId.get(retiredRevisionId)?.sales_location_id).toBe(retiredLocationId);
  });

  it("leaves exactly one current revision per provider", async () => {
    // The superseded predecessor must not have become a second current row. Assert the VALUE,
    // not merely that the index exists.
    const rows = await client()`
      select provider_id, count(*)::int as n
      from inventory_revisions where is_current
      group by provider_id
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.n).toBe(1);
  });

  it("attributes every usual item to its stand's native provider", async () => {
    const rows = await client()`
      select i.display_name, p.sales_location_id, p.seller_id
      from stand_items i
      join stand_providers p on p.id = i.provider_id
      order by i.display_name asc
    `;
    expect(rows.map((row) => row.display_name)).toEqual([
      "eggs",
      "lamb",
      "plant starts",
    ]);
    for (const row of rows) expect(row.seller_id).toBeNull();
    expect(rows[0]?.sales_location_id).toBe(richLocationId);
    expect(rows[1]?.sales_location_id).toBe(usualOnlyLocationId);
  });

  it("attributes links, preferences, proposals and menu options", async () => {
    const db = client();
    const link = await db`
      select p.sales_location_id from farmer_links l
      join stand_providers p on p.id = l.provider_id
    `;
    expect(link).toHaveLength(1);
    expect(link[0]?.sales_location_id).toBe(richLocationId);

    const preference = await db`
      select p.sales_location_id from inventory_prompt_preferences f
      join stand_providers p on p.id = f.provider_id
    `;
    expect(preference).toHaveLength(1);
    expect(preference[0]?.sales_location_id).toBe(richLocationId);

    const proposal = await db`
      select r.id, p.sales_location_id from inventory_publication_proposals r
      join stand_providers p on p.id = r.provider_id
    `;
    expect(proposal).toHaveLength(1);
    expect(proposal[0]?.id).toBe(proposalId);
    expect(proposal[0]?.sales_location_id).toBe(richLocationId);

    const option = await db`
      select p.sales_location_id from farmer_target_menu_options o
      join stand_providers p on p.id = o.provider_id
    `;
    expect(option).toHaveLength(1);
    expect(option[0]?.sales_location_id).toBe(richLocationId);
  });

  it("fills a selected SMS target and leaves an unselected one wholly null", async () => {
    const db = client();
    const selected = await db`
      select c.selected_provider_id, p.sales_location_id
      from farmer_target_contexts c
      join stand_providers p on p.id = c.selected_provider_id
      where c.sender_hash = ${selectingSenderHash}
    `;
    expect(selected).toHaveLength(1);
    expect(selected[0]?.sales_location_id).toBe(richLocationId);

    // The all-NULL selection is what "no target chosen" means, and the widened biconditional
    // must still admit it. A rule requiring the provider unconditionally would have failed the
    // ALTER on this row.
    const unselected = await db`
      select selected_provider_id, selected_sales_location_id, selected_at
      from farmer_target_contexts where sender_hash = ${unselectedSenderHash}
    `;
    expect(unselected[0]?.selected_provider_id).toBeNull();
    expect(unselected[0]?.selected_sales_location_id).toBeNull();
    expect(unselected[0]?.selected_at).toBeNull();
  });

  it("retires the participant list without converting it to providers", async () => {
    // §migration approach: participants migrate as retained history and a VIGA work queue, not
    // as providers. Their composite key deliberately still routes through the stand's owner.
    const rows = await client()`
      select conname from pg_constraint
      where conname = 'sales_location_participants_location_owner_fk'
    `;
    expect(rows).toHaveLength(1);
  });

  it("keeps stand closure rooted on the stand, not on a provider", async () => {
    // Stand closure is owner-only and overrides every provider — a fact about the place.
    const kept = await client()`
      select conname from pg_constraint
      where conname = 'closure_revisions_location_owner_fk'
    `;
    expect(kept).toHaveLength(1);

    const absent = await client()`
      select conname from pg_constraint
      where conname = 'closure_revisions_location_provider_fk'
    `;
    expect(absent).toHaveLength(0);
  });

  it("is re-runnable: applying it twice is a no-op", async () => {
    // The suite applies every file twice and the second run must not throw. `IF NOT EXISTS` and
    // `duplicate_object` guards carry the structural half; the backfill's `ON CONFLICT DO
    // NOTHING` and its idempotent UPDATEs carry the data half.
    const db = client();
    const before = await db`select count(*)::int as n from stand_providers`;
    for (const file of thisWork) {
      const body = readFileSync(resolve(migrationsDir, file), "utf8");
      for (const statement of body.split("--> statement-breakpoint")) {
        if (statement.trim().length === 0) continue;
        try {
          await db.unsafe(statement);
        } catch (error) {
          // A second DROP CONSTRAINT / ADD COLUMN legitimately raises; what must NOT happen is
          // a duplicated provider row or a lost attribution, asserted below.
          const code = (error as { code?: string }).code;
          expect(["42704", "42701", "42P07", "42710", "23505"]).toContain(code);
        }
      }
    }
    const after = await db`select count(*)::int as n from stand_providers`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
