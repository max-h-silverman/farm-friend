import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.2 — THE CONSTRAINTS THAT MAKE HOSTED PUBLICATION POSSIBLE AND HONEST.

  ## What `0045` removes, and why removing it is the correction

  `0042` gave `inventory_revisions` a composite key onto `(sales_locations.id, own_seller_id)`.
  Read plainly, it says: **every revision's seller is the stand's own seller.** That is true of
  38 of 38 stands today and structurally forbids the thing F-114 exists to build — Gracie's
  Greens publishing at Venison Valley's stand fails at the database, not at a guard.

  It was correct when written: C.0 re-rooted identity onto sellers and every stand still had
  exactly one. It is the last place the one-seller-per-stand assumption survived a phase that
  removed it everywhere else.

  ## What replaces it, which is strictly stronger

  Dropping a key without replacing it would leave `seller_id` free to say anything. Two keys
  already bound part of it and one more closes the gap:

  - `inventory_revisions_location_provider_fk` on `(provider_id, sales_location_id)` — the
    provider belongs to this stand. Already present since Phase B.
  - **New: `inventory_revisions_provider_seller_fk`** on `(provider_id, seller_id)` — the seller
    is the PROVIDER'S seller. This is the fact the old key was reaching for and getting wrong:
    whose goods these are is decided by the relationship, not by who owns the roof.

  Together they say a revision belongs to one real relationship at one real stand, for the
  seller that relationship names. The old key was a special case of this that happened to hold
  while every stand had one seller.

  ## What `0045` widens

  `inventory_revisions_authorization_farm_fk` bound `(published_by_authorization_id, seller_id)`
  — the publisher's authorization must name the seller being published. Under the host stock
  right the publisher is the HOST and the goods are the guest's, so the key refuses exactly the
  write §the Venison Valley case permits. It is replaced by a plain reference to the
  authorization: WHO may publish for whom is a live question about the relationship's opt-in and
  the authorization's revocation, which a static key cannot answer and
  `resolveProviderWriteAuthority` does.

  **This is a real loosening and it is named rather than buried.** What the database no longer
  refuses, the writer refuses, and `per-provider-publication.integration.test.ts` proves it does
  — including the negative: the host without the opt-in publishes nothing.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("per-provider write constraints (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let databaseName = "";

  let standId = "";
  let hostSellerId = "";
  let hostProviderId = "";
  let hostApprovalId = "";
  let hostAuthorizationId = "";
  let guestSellerId = "";
  let guestProviderId = "";
  let guestApprovalId = "";
  let otherStandId = "";
  let otherProviderId = "";

  const now = new Date("2026-08-15T18:00:00.000Z");
  const sql = (): Sql => client as Sql;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_provconstraints_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
    hostSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    guestSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;

    const approvals = await sql()`
      insert into seller_approvals (seller_id, approved_at)
      values (${hostSellerId}, ${now}), (${guestSellerId}, ${now})
      returning id, seller_id
    `;
    hostApprovalId = approvals.find((row) => row.seller_id === hostSellerId)?.id as string;
    guestApprovalId = approvals.find((row) => row.seller_id === guestSellerId)?.id as string;

    const mkStand = async (name: string, owner: string): Promise<string> => {
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
    standId = await mkStand("Venison Valley Stand", hostSellerId);
    otherStandId = await mkStand("Gracies Greens Stand", guestSellerId);

    const own = await sql()`
      select id from stand_providers
      where sales_location_id = ${standId} and seller_id = ${hostSellerId}
    `;
    hostProviderId = own[0]?.id as string;
    const other = await sql()`
      select id from stand_providers
      where sales_location_id = ${otherStandId} and seller_id = ${guestSellerId}
    `;
    otherProviderId = other[0]?.id as string;

    const guest = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
        approval_source, approved_at
      ) values (
        ${standId}, ${guestSellerId}, 'active', ${now}, ${now}, 'viga', ${now}
      ) returning id
    `;
    guestProviderId = guest[0]?.id as string;

    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065551000', ${`h${randomUUID().replaceAll("-", "")}`}) returning id
    `;
    const authorizations = await sql()`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${hostSellerId}, ${contacts[0]?.id as string}, ${now}, ${now}) returning id
    `;
    hostAuthorizationId = authorizations[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  /**
   * `source = 'viga'` forbids the handset chain and `'web'` requires it, per
   * `inventory_revisions_source_keys_coherent`. The source therefore follows whether a chain
   * was supplied, rather than being a separate thing every caller has to keep in step.
   */
  const insertRevision = async (input: {
    sellerId: string;
    providerId: string;
    salesLocationId: string;
    authorizationId?: string | null;
    approvalId?: string | null;
  }): Promise<void> => {
    const hasChain = input.authorizationId != null || input.approvalId != null;
    await sql()`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, published_by_authorization_id,
        farm_approval_id, source, published_at
      ) values (
        ${input.sellerId}, ${input.salesLocationId}, ${input.providerId},
        ${input.authorizationId ?? null}, ${input.approvalId ?? null},
        ${hasChain ? "web" : "viga"}, ${now}
      )
    `;
  };

  /**
   * Revisions are append-only — `inventory_revisions_guard_history` refuses a delete, which is
   * the point of a published record. Cases that need a clean slate SUPERSEDE instead, which is
   * also what production does and therefore exercises the real transition.
   */
  const supersedeAll = async (): Promise<void> => {
    await sql()`
      update inventory_revisions
      set is_current = false, superseded_at = ${new Date(now.getTime() + 60_000)}
      where is_current
    `;
  };

  // Every case starts from a clean CURRENT set. `inventory_revisions_one_current_per_provider`
  // is global to the provider, so a residue row from an earlier case would make the next one
  // fail on the index rather than on the key it is actually testing — a green suite proving the
  // wrong thing in one direction and a red one hiding a real result in the other.
  beforeEach(async () => {
    await supersedeAll();
  });

  describe("a hosted seller's revision", () => {
    it("is admitted at a stand it does not own", async () => {
      // The whole point. Before `0045` this failed on `location_own_seller_fk` — Gracie's
      // Greens is not Venison Valley Stand's own seller, and the key said no revision may say
      // otherwise. The relationship is what makes it legitimate, and the relationship exists.
      await insertRevision({
        sellerId: guestSellerId,
        providerId: guestProviderId,
        salesLocationId: standId,
      });
      const rows = await sql()`
        select seller_id, provider_id from inventory_revisions
        where sales_location_id = ${standId}
      `;
      expect(rows[0]?.seller_id).toBe(guestSellerId);
    });

    it("refuses a seller that is not the provider's seller", async () => {
      // The replacement key, and the reason dropping the old one is not a loosening of the
      // fact that mattered. Claiming the host's provider for the guest's goods — the shape a
      // confused writer would produce — is refused by `provider_seller_fk`.
      await expect(
        insertRevision({
          sellerId: guestSellerId,
          providerId: hostProviderId,
          salesLocationId: standId,
        }),
      ).rejects.toThrow(/inventory_revisions_provider_seller_fk/);
    });

    it("refuses the host's seller on the hosted provider, the other direction", async () => {
      // Both directions asserted, because a key is a biconditional in practice and only one
      // direction failing would leave the other silently admitted.
      await expect(
        insertRevision({
          sellerId: hostSellerId,
          providerId: guestProviderId,
          salesLocationId: standId,
        }),
      ).rejects.toThrow(/inventory_revisions_provider_seller_fk/);
    });

    it("refuses a provider that belongs to another stand", async () => {
      // Unchanged from Phase B and asserted here so `0045` is proved not to have weakened it
      // while removing the key beside it.
      await expect(
        insertRevision({
          sellerId: guestSellerId,
          providerId: otherProviderId,
          salesLocationId: standId,
        }),
      ).rejects.toThrow(/inventory_revisions_location_provider_fk/);
    });
  });

  describe("the publisher's authorization", () => {
    it("admits the host publishing the hosted seller's goods", async () => {
      // §the Venison Valley case, at the constraint layer. The old key bound the publisher's
      // authorization to the seller being published, which refuses exactly this. What replaces
      // it is the writer's live check, because the opt-in and the revocation are both live
      // facts a static key cannot see.
      await insertRevision({
        sellerId: guestSellerId,
        providerId: guestProviderId,
        salesLocationId: standId,
        authorizationId: hostAuthorizationId,
        approvalId: guestApprovalId,
      });
      const rows = await sql()`
        select published_by_authorization_id, seller_id from inventory_revisions
        where is_current
      `;
      expect(rows[0]?.published_by_authorization_id).toBe(hostAuthorizationId);
      expect(rows[0]?.seller_id).toBe(guestSellerId);
    });

    it("still refuses an authorization that does not exist", async () => {
      // The reference itself survives the widening. A revision naming a publisher who is not a
      // real authorization would be an audit trail pointing at nothing.
      await expect(
        insertRevision({
          sellerId: hostSellerId,
          providerId: hostProviderId,
          salesLocationId: standId,
          authorizationId: randomUUID(),
          approvalId: hostApprovalId,
        }),
      ).rejects.toThrow(/authorization/);
    });

    it("still requires the approval to name the seller being published", async () => {
      // Deliberately NOT widened. VIGA's approval is the real gate on whether a seller may be
      // public at all, and it is a fact about that seller — never about who typed the update.
      // So the host's approval on the guest's goods stays refused.
      await expect(
        insertRevision({
          sellerId: guestSellerId,
          providerId: guestProviderId,
          salesLocationId: standId,
          authorizationId: hostAuthorizationId,
          approvalId: hostApprovalId,
        }),
      ).rejects.toThrow(/approval/);
    });
  });

  describe("what did not change", () => {
    it("still admits exactly one current revision per provider", async () => {
      await insertRevision({
        sellerId: hostSellerId,
        providerId: hostProviderId,
        salesLocationId: standId,
      });
      await expect(
        insertRevision({
          sellerId: hostSellerId,
          providerId: hostProviderId,
          salesLocationId: standId,
        }),
      ).rejects.toThrow(/one_current_per_provider/);
    });

    it("admits two current revisions at one stand, one per provider", async () => {
      // The invariant read from the other side: per PROVIDER, not per stand. Both sellers'
      // listings are current at once, which is what a customer's card has to show.
      await insertRevision({
        sellerId: hostSellerId,
        providerId: hostProviderId,
        salesLocationId: standId,
      });
      await insertRevision({
        sellerId: guestSellerId,
        providerId: guestProviderId,
        salesLocationId: standId,
      });
      const rows = await sql()`
        select count(*)::int as total from inventory_revisions
        where sales_location_id = ${standId} and is_current
      `;
      expect(rows[0]?.total).toBe(2);
    });

    it("no longer carries the stand's own-seller key at all", async () => {
      // Asserted by NAME against the catalogue, because a dropped constraint that silently
      // survives in one database and not another is the drift this whole phase is undoing.
      const rows = await sql()`
        select count(*)::int as total from pg_constraint
        where conname = 'inventory_revisions_location_own_seller_fk'
      `;
      expect(rows[0]?.total).toBe(0);
    });

    it("carries both replacement keys", async () => {
      const rows = await sql()`
        select conname from pg_constraint
        where conname in (
          'inventory_revisions_location_provider_fk',
          'inventory_revisions_provider_seller_fk'
        )
        order by conname
      `;
      expect(rows.map((row) => row.conname)).toEqual([
        "inventory_revisions_location_provider_fk",
        "inventory_revisions_provider_seller_fk",
      ]);
    });
  });
});
