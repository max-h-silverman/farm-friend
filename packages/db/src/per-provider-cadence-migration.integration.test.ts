import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.4 — `0048` and `0049` against a POPULATED copy of the schema that precedes them.

  ## What they claim, and why only real rows can test it

  Both make the SAME substitution on two tables, which is why they are proved in one file rather
  than two near-identical ones:

    * `0048` — `inventory_prompt_preferences_location_own_seller_fk`
    * `0049` — `scheduled_prompt_subjects_location_own_seller_fk`

  `0050` rides along because it is C.4's too and shares this fixture: it adds
  `inventory_publication_proposals.reopening_stated_version`, the farmer's recorded consent to
  re-opening a paused listing. A column ADD is the shape `drizzle-kit` gets wrong against a
  populated table (`NOT NULL` with no default, an instant 23502), so it is proved here as well —
  nullable, and every existing proposal left untouched.

  Each said *this row's seller must be the seller that owns the stand*, and each is replaced by
  `(provider_id, owner_seller_id)` -> `stand_providers(id, seller_id)`: whose reminder this is is
  decided by the RELATIONSHIP. They are the second and third of that family to move, after
  `inventory_revisions` in `0045`. The remaining two — on `closure_revisions` and
  `sales_location_participants` — deliberately STAY, because both carry facts about the PLACE
  (max, 2026-08-15).

  All three lived only in `0042` and were never carried into `schema.ts`, so none could be found
  by reading the schema — only by a hosted write.

  `ADD CONSTRAINT … FOREIGN KEY` VALIDATES against every row already present, so each new key
  either holds for every row in production or the migration fails there having passed on every
  empty database in the repo. The claim under test is a claim about real data: *every preference
  and every prompt subject today names the stand's own listing, whose seller IS the stand's own
  seller, so the `(provider, seller)` replacements are already satisfied.* That is reasoning
  until a populated run proves it.

  ## What this file populates, and why each row is here

    1. A stand with a seller of its own, a preference on its own listing, and a scheduled prompt
       subject referencing that preference — the 38-stand case, and the rows both replacements
       must accept UNCHANGED.
    2. A HOSTED provider at that same stand with neither of its own, so the migrations are proved
       not to backfill, infer, or re-root anything onto it. Its rows are written AFTER, which is
       the behaviour the whole phase exists for and is refused before.
    3. A VENUE with a nested seller, because `own_seller_id` is NULL there and the dropped keys
       could never be satisfied at all — no row matches NULL. It is the shape that proves the old
       keys forbade a class of listing outright rather than merely constraining it.

  ## What is asserted

  Exact row effects: every row unchanged BY ID, counts unchanged; each dropped constraint absent
  BY NAME; each replacement present BY NAME and actually VALIDATED (`convalidated` — a
  `NOT VALID` foreign key still refuses new rows, so a violating-insert probe cannot detect it);
  the new behaviour admitted where it was refused; and a genuinely wrong row still refused, so
  each replacement is a constraint rather than a removal.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/* Ordered BEFORE `0048`, never "everything that is not `0048`" — an exclusion filter is correct
   only while its own migration is the newest in the repo, and breaks the moment one lands after
   it. Several earlier migration suites were repaired for exactly this. */
const beforeThisWork = migrationFiles.filter((name) => name < "0048_");
const thisWork = migrationFiles.filter((name) => name >= "0048_");

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-114 C.4 cadence migration against a populated schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let ownSellerId = "";
  let hostedSellerId = "";
  let venueSellerId = "";
  let standLocationId = "";
  let venueLocationId = "";
  let ownProviderId = "";
  let hostedProviderId = "";
  let venueProviderId = "";
  let ownAuthorizationId = "";
  let hostedAuthorizationId = "";
  let venueAuthorizationId = "";
  let preferenceId = "";
  let subjectId = "";
  const subjectSenderHash = "9".repeat(64);

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114cadencemig_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 4 });
    const db = client();

    // ---- 1. the schema as it stands BEFORE this work ---------------------------------------
    expect(thisWork).toHaveLength(3);
    expect(beforeThisWork.length).toBeGreaterThan(47);
    for (const file of beforeThisWork) await applyFile(db, file);

    // ---- 2. populate it --------------------------------------------------------------------
    const sellers = await db`
      insert into sellers (name)
      values ('Venison Valley'), ('Gracies Greens'), ('Cascade Bakery')
      returning id, name
    `;
    ownSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    hostedSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;
    venueSellerId = sellers.find((row) => row.name === "Cascade Bakery")?.id as string;

    const mkStand = async (name: string, owner: string | null): Promise<string> => {
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
    standLocationId = await mkStand("Venison Valley Stand", ownSellerId);
    venueLocationId = await mkStand("Morgan Hill Community Stand", null);

    const own = await db`
      select id from stand_providers
      where sales_location_id = ${standLocationId} and seller_id = ${ownSellerId}
    `;
    ownProviderId = own[0]?.id as string;

    const mkProvider = async (location: string, seller: string): Promise<string> => {
      const rows = await db`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
          invited_at, accepted_at, approval_source, approved_at
        ) values (
          ${location}, ${seller}, 'active', false, now(), now(), 'viga', now()
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    hostedProviderId = await mkProvider(standLocationId, hostedSellerId);
    venueProviderId = await mkProvider(venueLocationId, venueSellerId);

    const mkAuthorization = async (input: {
      phone: string;
      sellerId?: string;
      salesLocationId?: string;
    }): Promise<string> => {
      const contacts = await db`
        insert into contacts (phone_e164, phone_hash)
        values (${input.phone}, ${`h${randomUUID().replaceAll("-", "")}`}) returning id
      `;
      const rows = await db`
        insert into farmer_authorizations (
          seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (
          ${input.sellerId ?? null}, ${input.salesLocationId ?? null},
          ${contacts[0]?.id as string}, now(), now()
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    ownAuthorizationId = await mkAuthorization({
      phone: "+12065553000",
      sellerId: ownSellerId,
    });
    hostedAuthorizationId = await mkAuthorization({
      phone: "+12065553001",
      sellerId: hostedSellerId,
    });
    venueAuthorizationId = await mkAuthorization({
      phone: "+12065553002",
      sellerId: venueSellerId,
    });

    // The 38-stand row: a preference on the stand's OWN listing, which satisfies both the old key
    // and the new one. It is the row the replacement must accept untouched.
    const preferences = await db`
      insert into inventory_prompt_preferences (
        owner_seller_id, sales_location_id, provider_id,
        designated_authorization_id, cadence, version, next_due_at, updated_at
      ) values (
        ${ownSellerId}, ${standLocationId}, ${ownProviderId},
        ${ownAuthorizationId}, 'weekly', 1, now() + interval '7 days', now()
      ) returning id
    `;
    preferenceId = preferences[0]?.id as string;

    // The matching 38-stand row for `0049`: a scheduled prompt subject on the stand's OWN
    // listing. It needs a proposal, an outbox row and a contact behind the sender hash, because
    // the subject keys all three — and a migration test whose table is EMPTY proves nothing
    // about a constraint that validates existing rows.
    const subjectContacts = await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065553009', ${subjectSenderHash}) returning id
    `;
    expect(subjectContacts).toHaveLength(1);
    const subjectProposals = await db`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure, base_revision_id, base_is_first_publication
      ) values (
        ${subjectSenderHash}, ${standLocationId}, ${ownProviderId},
        ${db.json({ entries: [] })}, 1, true, false, null, true
      ) returning id
    `;
    const subjectOutbox = await db`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body,
        body_expires_at, available_at
      ) values (
        ${`cadence-migration-${randomUUID()}`}, ${subjectSenderHash}, 'inventory_prompt',
        'Items listed', now() + interval '30 days', now()
      ) returning id
    `;
    const subjects = await db`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_seller_id, sales_location_id, provider_id,
        closure_base_is_first_instruction, due_slot_at, outbox_work_id,
        offers_same, created_at
      ) values (
        ${subjectProposals[0]?.id as string}, 1, ${preferenceId}, 1,
        ${ownAuthorizationId}, ${ownSellerId}, ${standLocationId}, ${ownProviderId},
        true, now(), ${subjectOutbox[0]?.id as string}, false, now()
      ) returning proposal_id
    `;
    subjectId = subjects[0]?.proposal_id as string;

    // ---- 3. the migrations under test -------------------------------------------------------
    for (const file of thisWork) await applyFile(db, file);
  }, 90_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  it("preserves the existing preference exactly, and adds none", async () => {
    // Values spelled out rather than a shape: a migration that rewrote `owner_seller_id` to
    // something else would still produce one row with the right column names.
    expect(await client()`
      select id, owner_seller_id, sales_location_id, provider_id,
             designated_authorization_id, cadence, version
      from inventory_prompt_preferences
    `).toEqual([
      {
        id: preferenceId,
        owner_seller_id: ownSellerId,
        sales_location_id: standLocationId,
        provider_id: ownProviderId,
        designated_authorization_id: ownAuthorizationId,
        cadence: "weekly",
        version: 1,
      },
    ]);
  });

  it("drops the stand's own-seller key BY NAME", async () => {
    expect(await client()`
      select conname from pg_constraint
      where conname = 'inventory_prompt_preferences_location_own_seller_fk'
    `).toEqual([]);
  });

  it("adds the relationship key BY NAME, over the right columns, and VALIDATED", async () => {
    // `convalidated` is the fact that actually differs: a `NOT VALID` foreign key still refuses
    // NEW rows, so the obvious violating-insert probe passes either way and proves nothing. The
    // rows already present are the only thing at risk, and only validation covers them.
    const rows = await client()`
      select conname, convalidated,
             pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'inventory_prompt_preferences_provider_seller_fk'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.convalidated).toBe(true);
    expect(rows[0]?.definition as string).toMatch(
      /FOREIGN KEY \(provider_id, owner_seller_id\) REFERENCES stand_providers\(id, seller_id\)/,
    );
  });

  it("now admits a HOSTED seller's cadence, which the old key forbade", async () => {
    // The behaviour the phase exists for. Gracie's Greens is not Venison Valley, so
    // `(sales_location_id, owner_seller_id)` does not match `sales_locations(id, own_seller_id)`
    // and the dropped key refused this row at the database, where no writer could reach around
    // it.
    const rows = await client()`
      insert into inventory_prompt_preferences (
        owner_seller_id, sales_location_id, provider_id,
        designated_authorization_id, cadence, version, next_due_at, updated_at
      ) values (
        ${hostedSellerId}, ${standLocationId}, ${hostedProviderId},
        ${hostedAuthorizationId}, 'every_2_days', 1, now() + interval '7 days', now()
      ) returning id, owner_seller_id
    `;
    expect(rows[0]?.owner_seller_id).toBe(hostedSellerId);
    await client()`delete from inventory_prompt_preferences where id = ${rows[0]?.id as string}`;
  });

  it("now admits a VENUE's nested seller, whose stand owns no seller at all", async () => {
    // The strongest case against the dropped key. `own_seller_id` is NULL at Morgan Hill, and a
    // foreign key cannot match NULL — so the old key did not merely constrain a venue's
    // preference, it made one impossible. Nothing in the schema said so.
    const rows = await client()`
      insert into inventory_prompt_preferences (
        owner_seller_id, sales_location_id, provider_id,
        designated_authorization_id, cadence, version, next_due_at, updated_at
      ) values (
        ${venueSellerId}, ${venueLocationId}, ${venueProviderId},
        ${venueAuthorizationId}, 'weekly', 1, now() + interval '7 days', now()
      ) returning id
    `;
    expect(rows[0]?.id).toBeTruthy();
    await client()`delete from inventory_prompt_preferences where id = ${rows[0]?.id as string}`;
  });

  it("still refuses a preference naming a seller who is NOT the listing's seller", async () => {
    /*
      The replacement has to be a constraint, not a removal. This is the row the old key would
      also have refused, and it must stay refused: Venison Valley's seller filed on Gracie's
      Greens' listing, which would text the host about goods they do not control.

      `next_due_at` is supplied deliberately. Written without it, the row is refused by
      `inventory_prompt_preferences_due_state_coherent` — a CHECK, evaluated before any foreign
      key is consulted — and the case then passes with or without `0048`, proving nothing. It is
      the "probed with an actor already refused for another reason" shape, and it cost a real
      false green here before the constraint NAME was asserted rather than just the rejection.
    */
    await expect(
      client()`
        insert into inventory_prompt_preferences (
          owner_seller_id, sales_location_id, provider_id,
          designated_authorization_id, cadence, version, next_due_at, updated_at
        ) values (
          ${ownSellerId}, ${standLocationId}, ${hostedProviderId},
          ${ownAuthorizationId}, 'weekly', 1, now() + interval '7 days', now()
        )
      `,
    ).rejects.toMatchObject({
      code: "23503",
      constraint_name: "inventory_prompt_preferences_provider_seller_fk",
    });
  });

  it("preserves the existing prompt subject exactly (0049)", async () => {
    expect(await client()`
      select proposal_id, owner_seller_id, sales_location_id, provider_id, authorization_id,
             preference_id
      from scheduled_inventory_prompt_subjects
    `).toEqual([
      {
        proposal_id: subjectId,
        owner_seller_id: ownSellerId,
        sales_location_id: standLocationId,
        provider_id: ownProviderId,
        authorization_id: ownAuthorizationId,
        preference_id: preferenceId,
      },
    ]);
  });

  it("drops the prompt subject's own-seller key and adds the relationship one (0049)", async () => {
    expect(await client()`
      select conname from pg_constraint
      where conname = 'scheduled_prompt_subjects_location_own_seller_fk'
    `).toEqual([]);

    const rows = await client()`
      select convalidated, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'scheduled_prompt_subjects_provider_seller_fk'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.convalidated).toBe(true);
    expect(rows[0]?.definition as string).toMatch(
      /FOREIGN KEY \(provider_id, owner_seller_id\) REFERENCES stand_providers\(id, seller_id\)/,
    );
  });

  it("now admits a HOSTED seller's prompt subject, which the old key forbade (0049)", async () => {
    // The row the scheduler pass writes for Zoe. Before `0049` every application check could
    // pass and this insert would still be refused, because Gracie's Greens does not own the
    // roof — which is what made the pass's own fix untestable end to end.
    const proposals = await client()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure, base_revision_id, base_is_first_publication
      ) values (
        ${subjectSenderHash}, ${standLocationId}, ${hostedProviderId},
        ${client().json({ entries: [] })}, 1, true, false, null, true
      ) returning id
    `;
    const outbox = await client()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body,
        body_expires_at, available_at
      ) values (
        ${`hosted-subject-${randomUUID()}`}, ${subjectSenderHash}, 'inventory_prompt',
        'Items listed', now() + interval '30 days', now()
      ) returning id
    `;
    const rows = await client()`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_seller_id, sales_location_id, provider_id,
        closure_base_is_first_instruction, due_slot_at, outbox_work_id,
        offers_same, created_at
      ) values (
        ${proposals[0]?.id as string}, 1, ${preferenceId}, 1,
        ${hostedAuthorizationId}, ${hostedSellerId}, ${standLocationId}, ${hostedProviderId},
        true, now(), ${outbox[0]?.id as string}, false, now()
      ) returning proposal_id, owner_seller_id
    `;
    expect(rows[0]?.owner_seller_id).toBe(hostedSellerId);
    await client()`
      delete from scheduled_inventory_prompt_subjects
      where proposal_id = ${rows[0]?.proposal_id as string}
    `;
  });

  it("adds the re-opening consent column WITHOUT disturbing existing proposals (0050)", async () => {
    // Nullable and NULL everywhere: the ordinary case is that no farmer was ever shown the
    // sentence. A generated `ADD COLUMN … NOT NULL` would have raised 23502 against the
    // proposal row this fixture already holds.
    const columns = await client()`
      select is_nullable, data_type from information_schema.columns
      where table_name = 'inventory_publication_proposals'
        and column_name = 'reopening_stated_version'
    `;
    expect(columns).toEqual([{ is_nullable: "YES", data_type: "integer" }]);
    expect(await client()`
      select count(*)::int as count from inventory_publication_proposals
      where reopening_stated_version is not null
    `).toEqual([{ count: 0 }]);
  });

  it("is a no-op when applied a second time", async () => {
    // The integration suite applies every file twice, so a non-idempotent statement fails there
    // rather than here — but the exact row effect is what this file is for.
    for (const file of thisWork) await applyFile(client(), file);
    expect(await client()`
      select count(*)::int as count from inventory_prompt_preferences
    `).toEqual([{ count: 1 }]);
    expect(await client()`
      select count(*)::int as count from pg_constraint
      where conname = 'inventory_prompt_preferences_provider_seller_fk'
    `).toEqual([{ count: 1 }]);
  });
});
