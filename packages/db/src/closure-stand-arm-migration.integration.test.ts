import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.2 / B-077 — `0046` against a POPULATED copy of the schema that precedes it.

  ## The defect class this file exists to catch

  `0046` drops three NOT NULLs and adds two CHECKs and a trigger. Dropping a NOT NULL cannot fail
  on data — which is exactly what makes it look safe and is not the risk. The risk is the CHECKs:
  `ADD CONSTRAINT ... CHECK` on a populated table VALIDATES against every existing row, so a rule
  written the wrong way round is green on every empty database in the repo and fails in production
  against the 38 stands' real closures.

  The specific way each could be wrong:

  - **`closure_revisions_owner_arm`** stated as `owner_seller_id IS NULL` rather than as the
    biconditional would refuse every closure that exists.
  - **`inventory_proposals_provider_arm`** stated as `provider_id IS NULL` for closure proposals
    would refuse every OPEN proposal in flight at the moment of the migration — a farmer mid-
    conversation whose reply then commits nothing, with no error anyone sees.
  - **The trigger** fires on UPDATE as well as INSERT, so it also has to accept the supersede that
    every future publication performs on the row it replaces. A trigger that only reasoned about
    inserts would make the FIRST closure after the migration fail while superseding its
    predecessor.

  ## What this populates

  A stand with its own seller and a REAL closure history — one current revision and one superseded
  beneath it, because the trigger validates on UPDATE and history is what it will meet. An OPEN
  proposal carrying a closure, which is the row `provider_arm` is most likely to get wrong. And the
  venue, which has no closure at all yet and must still have none after: the migration makes a
  venue's closure POSSIBLE and must not invent one.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/* Ordered BEFORE `0046`, never "everything that is not `0046`". */
const beforeThisWork = migrationFiles.filter((name) => name < "0046_");
const thisWork = migrationFiles.filter((name) => name.startsWith("0046_"));

async function applyFile(db: Sql, fileName: string): Promise<void> {
  const body = readFileSync(resolve(migrationsDir, fileName), "utf8");
  for (const statement of body.split("--> statement-breakpoint")) {
    if (statement.trim().length === 0) continue;
    await db.unsafe(statement);
  }
}

describe("F-114 Phase C.2 closure stand-arm migration against a populated schema (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let standId = "";
  let venueId = "";
  let standSellerId = "";
  let standApprovalId = "";
  let standAuthorizationId = "";
  let standProviderId = "";

  let currentClosureId = "";
  let supersededClosureId = "";
  let openProposalId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114closuremig_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    sql = postgres(url.toString(), { max: 4 });
    const db = client();

    // ---- 1. the schema as it stands BEFORE this work ---------------------------------------
    expect(thisWork).toHaveLength(1);
    expect(beforeThisWork.length).toBeGreaterThan(45);
    for (const file of beforeThisWork) await applyFile(db, file);

    // ---- 2. populate it --------------------------------------------------------------------
    const sellers = await db`
      insert into sellers (name) values ('Venison Valley') returning id
    `;
    standSellerId = sellers[0]?.id as string;
    const approvals = await db`
      insert into seller_approvals (seller_id, approved_at)
      values (${standSellerId}, now()) returning id
    `;
    standApprovalId = approvals[0]?.id as string;

    const mkLocation = async (name: string, owner: string | null): Promise<string> => {
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
    standId = await mkLocation("Venison Valley Stand", standSellerId);
    // No closure of its own, and none after. The migration makes a venue's closure POSSIBLE; it
    // must never invent one.
    venueId = await mkLocation("Morgan Hill Community Stand", null);

    const providers = await db`
      select id from stand_providers
      where sales_location_id = ${standId} and seller_id = ${standSellerId}
    `;
    standProviderId = providers[0]?.id as string;

    const contacts = await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065551000', ${`h${randomUUID().replaceAll("-", "")}`}) returning id
    `;
    const authorizations = await db`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${standSellerId}, ${contacts[0]?.id as string}, now(), now()) returning id
    `;
    standAuthorizationId = authorizations[0]?.id as string;

    // Counted, never random: a random handset can collide with another fixture's on
    // `phone_e164` and fail one run in a hundred, which reads as flake rather than as the
    // fixture defect it is.
    let phoneCounter = 3000;
    const mkProposal = async (input: {
      hasClosure: boolean;
      state: string;
    }): Promise<string> => {
      const senderHash = `h${randomUUID().replaceAll("-", "")}`;
      phoneCounter += 1;
      await db`
        insert into contacts (phone_e164, phone_hash)
        values (${`+1206555${phoneCounter}`}, ${senderHash})
      `;
      await db`insert into sender_states (sender_hash, updated_at) values (${senderHash}, now())`;
      const rows = await db`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, provider_id, payload, proposal_version,
          has_inventory, has_closure, closure_base_is_first_instruction, state,
          closed_at, created_at, updated_at
        ) values (
          ${senderHash}, ${standId}, ${standProviderId},
          ${db.json({ closure: { result: "reopen" } })}, 1,
          false, ${input.hasClosure}, true, ${input.state},
          ${input.state === "open" ? null : db`now()`}, now(), now()
        ) returning id
      `;
      return rows[0]?.id as string;
    };

    // Real closure history: one superseded beneath one current. The trigger fires on UPDATE too,
    // so the supersede every future publication performs must keep working against these.
    // `invalidated` rather than `accepted`: the closure rows below are what this migration
    // validates against, and `state_coherent` demands the whole activation chain for `accepted`
    // — chain the proposal's state does not change what the CHECK under test sees.
    const supersededProposal = await mkProposal({ hasClosure: true, state: "invalidated" });
    const currentProposal = await mkProposal({ hasClosure: true, state: "invalidated" });
    const superseded = await db`
      insert into closure_revisions (
        owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
        owner_approval_id, result, published_at, is_current, superseded_at
      ) values (
        ${standSellerId}, ${standId}, ${supersededProposal}, ${standAuthorizationId},
        ${standApprovalId}, 'reopen', now() - interval '2 days', false, now() - interval '1 day'
      ) returning id
    `;
    supersededClosureId = superseded[0]?.id as string;
    const current = await db`
      insert into closure_revisions (
        owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
        owner_approval_id, result, closure_kind, starts_on, published_at, is_current
      ) values (
        ${standSellerId}, ${standId}, ${currentProposal}, ${standAuthorizationId},
        ${standApprovalId}, 'close', 'temporary', current_date, now(), true
      ) returning id
    `;
    currentClosureId = current[0]?.id as string;

    // An OPEN closure proposal, mid-conversation. `provider_arm` written the wrong way round
    // would refuse exactly this row and strand the farmer's reply.
    openProposalId = await mkProposal({ hasClosure: true, state: "open" });

    // ---- 3. apply 0046 alone, against that data --------------------------------------------
    for (const file of thisWork) await applyFile(db, file);
  }, 90_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("leaves every closure exactly as it found it", async () => {
    const rows = await client()`
      select id, owner_seller_id, owner_approval_id, owner_authorization_id,
        sales_location_id, result, is_current
      from closure_revisions order by published_at
    `;
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(supersededClosureId)).toMatchObject({
      owner_seller_id: standSellerId,
      owner_approval_id: standApprovalId,
      owner_authorization_id: standAuthorizationId,
      result: "reopen",
      is_current: false,
    });
    expect(byId.get(currentClosureId)).toMatchObject({
      owner_seller_id: standSellerId,
      owner_approval_id: standApprovalId,
      result: "close",
      is_current: true,
    });
  });

  it("leaves the open proposal open and still naming its provider", async () => {
    // The row `provider_arm` is most likely to get wrong. A farmer mid-conversation whose
    // proposal the migration invalidated would reply YES to nothing, with no error anyone sees.
    const rows = await client()`
      select state, provider_id, has_closure from inventory_publication_proposals
      where id = ${openProposalId}
    `;
    expect(rows[0]).toMatchObject({
      state: "open",
      provider_id: standProviderId,
      has_closure: true,
    });
  });

  it("invents no closure for the venue", async () => {
    const rows = await client()`
      select count(*)::int as total from closure_revisions
      where sales_location_id = ${venueId}
    `;
    expect(rows[0]?.total).toBe(0);
  });

  it("validated both new CHECKs against the rows that were already there", async () => {
    // `NOT VALID` skips the scan of existing rows while still refusing every new one, so a
    // violating-insert probe cannot tell the difference. `convalidated` is the fact that does.
    const rows = await client()`
      select conname, convalidated from pg_constraint
      where conname in (
        'closure_revisions_owner_arm',
        'inventory_proposals_provider_arm'
      )
      order by conname
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.convalidated).toBe(true);
  });

  it("still lets a closure be superseded, which the trigger also sees", async () => {
    // The trigger fires BEFORE UPDATE as well as INSERT. A version reasoning only about inserts
    // would make the first publication after the migration fail while superseding its
    // predecessor — a failure arriving one publication later than the migration that caused it.
    await client()`
      update closure_revisions
      set is_current = false, superseded_at = now()
      where id = ${currentClosureId}
    `;
    const rows = await client()`
      select is_current from closure_revisions where id = ${currentClosureId}
    `;
    expect(rows[0]?.is_current).toBe(false);
  });

  it("guards UPDATE too, not only INSERT", async () => {
    /*
      The case above proves the trigger does not BREAK a supersede. It says nothing about whether
      the trigger sees updates at all — a `BEFORE INSERT`-only version passes it unchanged, and
      that sabotage escaped until this case existed.

      What an INSERT-only trigger would leave open: a closure row inserted correctly and then
      UPDATEd to swap its arm. The row would end up asserting a venue's closure at a stand that
      has its own seller, or the reverse, with nothing having refused it — which is exactly the
      state the trigger exists to make unreachable.
    */
    await expect(
      client()`
        update closure_revisions
        set owner_seller_id = null, owner_approval_id = null
        where id = ${supersededClosureId}
      `,
    ).rejects.toThrow(/closure_revisions_arm_matches_stand/);

    // The absence of the effect: the row still names its seller.
    const rows = await client()`
      select owner_seller_id from closure_revisions where id = ${supersededClosureId}
    `;
    expect(rows[0]?.owner_seller_id).toBe(standSellerId);
  });

  it("now admits a venue's closure, which it could not before", async () => {
    // B-077, proved by effect against real preceding data rather than in a fresh database.
    const senderHash = `h${randomUUID().replaceAll("-", "")}`;
    await client()`
      insert into contacts (phone_e164, phone_hash) values ('+12065559998', ${senderHash})
    `;
    await client()`
      insert into sender_states (sender_hash, updated_at) values (${senderHash}, now())
    `;
    const venueContact = await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065559997', ${`h${randomUUID().replaceAll("-", "")}`}) returning id
    `;
    const venueAuth = await client()`
      insert into farmer_authorizations (
        sales_location_id, contact_id, phone_verified_at, authorized_at
      ) values (${venueId}, ${venueContact[0]?.id as string}, now(), now()) returning id
    `;
    const proposal = await client()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure, closure_base_is_first_instruction,
        created_at, updated_at
      ) values (
        ${senderHash}, ${venueId}, null,
        ${client().json({ closure: { result: "close" } })}, 1,
        false, true, true, now(), now()
      ) returning id
    `;
    const rows = await client()`
      insert into closure_revisions (
        owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
        owner_approval_id, result, closure_kind, starts_on, published_at
      ) values (
        null, ${venueId}, ${proposal[0]?.id as string}, ${venueAuth[0]?.id as string},
        null, 'close', 'temporary', current_date, now()
      ) returning id
    `;
    expect(rows[0]?.id).toBeTruthy();
  });

  it("is a no-op when applied a second time", async () => {
    const before = await client()`
      select
        (select count(*)::int from pg_constraint
          where conrelid = 'closure_revisions'::regclass) as closure_constraints,
        (select count(*)::int from pg_trigger
          where tgrelid = 'closure_revisions'::regclass and not tgisinternal) as triggers
    `;
    for (const file of thisWork) await applyFile(client(), file);
    const after = await client()`
      select
        (select count(*)::int from pg_constraint
          where conrelid = 'closure_revisions'::regclass) as closure_constraints,
        (select count(*)::int from pg_trigger
          where tgrelid = 'closure_revisions'::regclass and not tgisinternal) as triggers
    `;
    expect(after[0]).toEqual(before[0]);
  });
});
