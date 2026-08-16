import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.2 / B-077 — A VENUE CAN RECORD A CLOSURE.

  ## The gap C.1's records left, stated plainly

  §there is no second permission system says two tables carry stand-level facts written by an
  authorization, and that both pair against the authorization's STAND arm. `closure_revisions`
  did not: `owner_seller_id`, `owner_authorization_id` and `owner_approval_id` were all NOT NULL
  and all routed through the stand's self-pointer. Morgan Hill Community Stand has no seller of
  its own, so it could hold none of them — **a venue could not record a closure at all**, and the
  one fact a venue's manager most needs to state is that the stand is shut.

  C.1 filed it rather than half-building it, because widening a column without the writer would
  leave a nullable column no code can produce. This is the writer and the column together.

  ## The shape: two arms, mirroring the authorization's own

  Closure is a STAND fact, so it is recorded the same way the authority to record it is:

  - **The seller arm** — a stand with a seller of its own. `owner_seller_id` names it,
    `owner_approval_id` names VIGA's approval OF that seller. Every closure in production today.
  - **The stand arm** — a venue. Both are NULL, because there is no seller to name and therefore
    no seller-approval to name either: VIGA's approval gates whether a SELLER may be public, and
    a venue sells nothing. The authorization is stand-armed.

  `owner_authorization_id` stays NOT NULL in both arms. A closure always has a person behind it,
  and which arm they hold does not change that.

  ## Why a biconditional, again

  A CHECK PASSES on NULL, so "a seller is named" evaluates to NULL on the row that omits it and
  the row is admitted. Both directions here are real failures: a seller named without its
  approval would publish a closure VIGA never approved the seller for, and an approval named
  without its seller would file one under nobody. So it is written as one biconditional over the
  pair, and both directions are asserted below.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("closure revisions, both arms (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let databaseName = "";

  let standId = "";
  let standSellerId = "";
  let standApprovalId = "";
  let standAuthorizationId = "";
  let venueId = "";
  let venueAuthorizationId = "";
  /** A seller with an approval, hosted at the venue — never the venue's own. */
  let hostedSellerId = "";
  let hostedApprovalId = "";
  let hostedAuthorizationId = "";

  const now = new Date("2026-08-15T18:00:00.000Z");
  const sql = (): Sql => client as Sql;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_closurearm_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    const sellers = await sql()`
      insert into sellers (name) values ('Venison Valley'), ('Gracies Greens')
      returning id, name
    `;
    standSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    hostedSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;

    const approvals = await sql()`
      insert into seller_approvals (seller_id, approved_at)
      values (${standSellerId}, ${now}), (${hostedSellerId}, ${now})
      returning id, seller_id
    `;
    standApprovalId = approvals.find((row) => row.seller_id === standSellerId)?.id as string;
    hostedApprovalId = approvals.find((row) => row.seller_id === hostedSellerId)?.id as string;

    const mkStand = async (name: string, owner: string | null): Promise<string> => {
      const rows = await sql()`
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
    standId = await mkStand("Venison Valley Stand", standSellerId);
    venueId = await mkStand("Morgan Hill Community Stand", null);

    // Gracies Greens sells AT the venue. Present so the stand arm is proved to be about the
    // venue having no seller of its OWN, never about the venue having no sellers at all.
    await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
        approval_source, approved_at
      ) values (
        ${venueId}, ${hostedSellerId}, 'active', ${now}, ${now}, 'viga', ${now}
      )
    `;

    const mkAuthorization = async (input: {
      phone: string;
      sellerId?: string;
      salesLocationId?: string;
    }): Promise<string> => {
      const contacts = await sql()`
        insert into contacts (phone_e164, phone_hash)
        values (${input.phone}, ${`h${randomUUID().replaceAll("-", "")}`}) returning id
      `;
      const rows = await sql()`
        insert into farmer_authorizations (
          seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (
          ${input.sellerId ?? null}, ${input.salesLocationId ?? null},
          ${contacts[0]?.id as string}, ${now}, ${now}
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    standAuthorizationId = await mkAuthorization({
      phone: "+12065551000",
      sellerId: standSellerId,
    });
    venueAuthorizationId = await mkAuthorization({
      phone: "+12065551001",
      salesLocationId: venueId,
    });
    hostedAuthorizationId = await mkAuthorization({
      phone: "+12065551002",
      sellerId: hostedSellerId,
    });
  }, 60_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  /**
   * `closure_revisions_one_current_per_location` is global to the stand, so a residue row from
   * an earlier case makes the next fail on the index rather than on the constraint it tests —
   * green proving the wrong thing in one direction, red hiding a real result in the other.
   */
  beforeEach(async () => {
    await sql()`
      update closure_revisions
      set is_current = false, superseded_at = ${new Date(now.getTime() + 60_000)}
      where is_current
    `;
  });

  /** Distinct handsets, so no two fixture contacts collide on `phone_e164`. */
  let phoneCounter = 2000;
  const nextPhone = (): number => {
    phoneCounter += 1;
    return phoneCounter;
  };

  /** Closure rows need a proposal to hang from; each case gets its own. */
  const mkProposal = async (salesLocationId: string): Promise<string> => {
    const providers = await sql()`
      select id from stand_providers where sales_location_id = ${salesLocationId} limit 1
    `;
    // A proposal names a sender, and a sender must be a known contact. Fresh per proposal so
    // `inventory_publication_proposals_one_open_per_provider` never collides across cases.
    const senderHash = `h${randomUUID().replaceAll("-", "")}`;
    await sql()`
      insert into contacts (phone_e164, phone_hash)
      values (${`+1206555${String(nextPhone()).padStart(4, "0")}`}, ${senderHash})
    `;
    await sql()`
      insert into sender_states (sender_hash, updated_at) values (${senderHash}, ${now})
    `;
    const rows = await sql()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure, closure_base_is_first_instruction,
        created_at, updated_at
      ) values (
        ${senderHash}, ${salesLocationId},
        ${providers[0]?.id as string}, ${sql().json({ closure: { result: "reopen" } })}, 1,
        false, true, true, ${now}, ${now}
      ) returning id
    `;
    return rows[0]?.id as string;
  };

  const insertClosure = async (input: {
    salesLocationId: string;
    ownerSellerId: string | null;
    ownerAuthorizationId: string;
    ownerApprovalId: string | null;
  }): Promise<string> => {
    const proposalId = await mkProposal(input.salesLocationId);
    const rows = await sql()`
      insert into closure_revisions (
        owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
        owner_approval_id, result, published_at
      ) values (
        ${input.ownerSellerId}, ${input.salesLocationId}, ${proposalId},
        ${input.ownerAuthorizationId}, ${input.ownerApprovalId}, 'reopen', ${now}
      ) returning id
    `;
    return rows[0]?.id as string;
  };

  describe("the seller arm", () => {
    it("records a closure for a stand with a seller of its own", async () => {
      // Every closure in production today, unchanged. Asserted first so the widening below is
      // proved not to have loosened the arm that already worked.
      const id = await insertClosure({
        salesLocationId: standId,
        ownerSellerId: standSellerId,
        ownerAuthorizationId: standAuthorizationId,
        ownerApprovalId: standApprovalId,
      });
      const rows = await sql()`
        select owner_seller_id, owner_approval_id from closure_revisions where id = ${id}
      `;
      expect(rows[0]?.owner_seller_id).toBe(standSellerId);
      expect(rows[0]?.owner_approval_id).toBe(standApprovalId);
    });

    it("refuses a seller that is not the stand's own", async () => {
      // Unchanged and asserted here: closure is owner-only, so a hosted seller's identity on a
      // closure row would let one seller shut a stand they merely sell at.
      await expect(
        insertClosure({
          salesLocationId: standId,
          ownerSellerId: hostedSellerId,
          ownerAuthorizationId: hostedAuthorizationId,
          ownerApprovalId: hostedApprovalId,
        }),
      ).rejects.toThrow(/closure_revisions_location_own_seller_fk/);
    });

    it("refuses an approval that names a different seller", async () => {
      await expect(
        insertClosure({
          salesLocationId: standId,
          ownerSellerId: standSellerId,
          ownerAuthorizationId: standAuthorizationId,
          ownerApprovalId: hostedApprovalId,
        }),
      ).rejects.toThrow(/closure_revisions_approval_owner_fk/);
    });

    it("refuses an authorization that names a different seller", async () => {
      await expect(
        insertClosure({
          salesLocationId: standId,
          ownerSellerId: standSellerId,
          ownerAuthorizationId: hostedAuthorizationId,
          ownerApprovalId: standApprovalId,
        }),
      ).rejects.toThrow(/closure_revisions_authorization_owner_fk/);
    });
  });

  describe("the stand arm", () => {
    it("records a closure for a venue with no seller of its own", async () => {
      // B-077, closed. Before this, all three columns were NOT NULL and Morgan Hill could hold
      // none of them — the one fact its manager most needs to state was unrecordable.
      const id = await insertClosure({
        salesLocationId: venueId,
        ownerSellerId: null,
        ownerAuthorizationId: venueAuthorizationId,
        ownerApprovalId: null,
      });
      const rows = await sql()`
        select owner_seller_id, owner_approval_id, owner_authorization_id, sales_location_id
        from closure_revisions where id = ${id}
      `;
      expect(rows[0]?.owner_seller_id).toBeNull();
      expect(rows[0]?.owner_approval_id).toBeNull();
      expect(rows[0]?.owner_authorization_id).toBe(venueAuthorizationId);
      expect(rows[0]?.sales_location_id).toBe(venueId);
    });

    it("still demands a person — the authorization is never null", async () => {
      // A closure without an authorization is a stand shut by nobody. The stand arm drops the
      // SELLER, never the person.
      const proposalId = await mkProposal(venueId);
      await expect(
        sql()`
          insert into closure_revisions (
            owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
            owner_approval_id, result, published_at
          ) values (
            null, ${venueId}, ${proposalId}, null, null, 'reopen', ${now}
          )
        `,
      ).rejects.toThrow(/owner_authorization_id/);
    });

    it("refuses a seller named without its approval", async () => {
      // The biconditional's first direction. A CHECK passes on NULL, so this must be written
      // over the PAIR — a per-column rule admits exactly this row.
      await expect(
        insertClosure({
          salesLocationId: standId,
          ownerSellerId: standSellerId,
          ownerAuthorizationId: standAuthorizationId,
          ownerApprovalId: null,
        }),
      ).rejects.toThrow(/closure_revisions_owner_arm/);
    });

    it("refuses an approval named without its seller", async () => {
      // The other direction, which a one-directional implication would silently admit: a
      // closure filed under an approval belonging to nobody named on the row.
      await expect(
        insertClosure({
          salesLocationId: venueId,
          ownerSellerId: null,
          ownerAuthorizationId: venueAuthorizationId,
          ownerApprovalId: hostedApprovalId,
        }),
      ).rejects.toThrow(/closure_revisions_owner_arm/);
    });

    it("refuses a stand-armed closure at a stand that HAS its own seller", async () => {
      /*
        The arm is not a choice. A stand with a seller of its own has an approval to name, and
        omitting it would let its owner publish a closure with no VIGA approval behind it —
        reaching around the gate by picking the weaker arm.

        Asserted because it is the way the widening could go wrong that costs the most: the
        venue's arm becoming an escape hatch for every stand.
      */
      await expect(
        insertClosure({
          salesLocationId: standId,
          ownerSellerId: null,
          ownerAuthorizationId: standAuthorizationId,
          ownerApprovalId: null,
        }),
      ).rejects.toThrow(/closure_revisions_arm_matches_stand/);
    });

    it("refuses a seller-armed closure at a venue", async () => {
      // The converse, and the one that would re-invent the fabricated seller C.0 removed: a
      // venue's closure filed under a seller it does not have.
      //
      // Two things refuse this — the arm trigger and `location_own_seller_fk`, which a venue's
      // NULL self-pointer can never satisfy — and the TRIGGER gets there first because it fires
      // BEFORE INSERT. The assertion names the one that actually rejects rather than the one
      // that would have; naming the key here would pass only until the trigger's ordering
      // changed and then report a defect that was not one.
      await expect(
        insertClosure({
          salesLocationId: venueId,
          ownerSellerId: hostedSellerId,
          ownerAuthorizationId: hostedAuthorizationId,
          ownerApprovalId: hostedApprovalId,
        }),
      ).rejects.toThrow(/closure_revisions_arm_matches_stand/);
    });

  });

  describe("what did not change", () => {
    it("still admits exactly one current closure per stand", async () => {
      await insertClosure({
        salesLocationId: venueId,
        ownerSellerId: null,
        ownerAuthorizationId: venueAuthorizationId,
        ownerApprovalId: null,
      });
      await expect(
        insertClosure({
          salesLocationId: venueId,
          ownerSellerId: null,
          ownerAuthorizationId: venueAuthorizationId,
          ownerApprovalId: null,
        }),
      ).rejects.toThrow(/closure_revisions_one_current_per_location/);
    });
  });
});
