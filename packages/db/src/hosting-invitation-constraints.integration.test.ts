import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./sql";

/*
  F-114 Phase C.1 (invitation) — THE HOSTING INVITATION'S RECORD, BY SABOTAGE.

  Each case inserts the exact row the constraint was written to refuse and asserts Postgres rejects
  it, so a constraint weakened, misspelled, or written one-directionally fails HERE rather than
  admitting bad data silently.

  ## Why the hosting invitation is the farmer invitation, and not a second record

  §there is no second permission system already cut the "access grant" C.1 was once going to
  build: the permission that follows acceptance is an ORDINARY farmer authorization for the seller
  who accepted. The same reasoning applies one level up. `farmer_invitations` already names a
  seller, holds the handset the redemption must arrive from, carries the SMS agreement, and — on a
  bare `START` — mints the authorization and the approval in one transaction. That IS invitation
  and acceptance; a hosted seller needs no second lifecycle beside it.

  What it could not express is WHICH pending relationship the redemption accepts. That is one
  nullable reference, `stand_provider_id`, and this file is what proves it cannot be abused:

  - **A provider-bound invitation must name the seller it invites.** `seller_id` is nullable
    because a plain invitation may start onboarding a farm Farm Friend has never heard of. A
    hosting invitation cannot: it is the acceptance of a specific seller's participation at a
    specific stand, so a row binding a provider while naming no seller would redeem into
    `authorizeInvitedFarmerIn`'s "nothing to authorize" branch and silently accept nothing.
    Written as a one-directional implication ON PURPOSE and asserted as such below — the converse
    is legitimate and common: every one of the 39 existing invitations names a seller and no
    provider.

  - **The invitation's seller must be the provider's seller.** Without this the record could invite
    Zoe to accept Gracie's Greens' participation while authorizing her for Venison Valley — the
    fabricated authority §migration approach forbids, arrived at through a typo rather than a
    guess. A composite foreign key onto `(stand_providers.id, stand_providers.seller_id)` makes
    the agreement a database guarantee rather than a check some future caller might skip, exactly
    as `(stand_providers.id, sales_location_id)` already does for the stand.

  - **One live invitation per pending relationship.** Two unredeemed invitations for one provider
    row would let two different handsets each accept the same relationship, and the second would
    find the row already `active` with no honest answer for its farmer. Partial on unredeemed, so
    a lapsed invitation can be reissued.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/** Postgres codes: 23514 is a CHECK violation, 23505 a unique violation, 23503 a foreign key. */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

describe("F-114 Phase C.1 hosting invitation records, by sabotage (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let hostSellerId = "";
  let hostedSellerId = "";
  let otherSellerId = "";
  let standLocationId = "";
  let pendingProviderId = "";
  let administratorId = "";
  let hostAuthorizationId = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

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

  /** A distinct token per row: `farmer_invitations_token_hash_unique` predates this work. */
  const freshToken = (): string =>
    `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;

  const invite = async (
    values: {
      sellerId: string | null;
      standProviderId: string | null;
      /** Redeemed at creation. `farmer_invitations_valid_redemption` forbids backdating it. */
      redeemed?: boolean;
      /**
       * Who issued it. `administrator` is VIGA's door and `vouch` is the stand owner's; the
       * default is VIGA, because that is what every case below except the issuer ones is about.
       */
      issuer?: "administrator" | "vouch" | "neither" | "both";
    },
  ): Promise<Record<string, unknown>[]> => {
    const issuer = values.issuer ?? "administrator";
    const byAdministrator =
      issuer === "administrator" || issuer === "both" ? administratorId : null;
    const byVouch = issuer === "vouch" || issuer === "both" ? hostAuthorizationId : null;
    const rows = await client()`
      insert into farmer_invitations (
        seller_id, stand_provider_id, token_hash, channel,
        created_by_administrator_id, invited_by_authorization_id,
        created_at, expires_at, redeemed_at
      ) values (
        ${values.sellerId}, ${values.standProviderId}, ${freshToken()}, 'sms',
        ${byAdministrator}, ${byVouch}, now(), now() + interval '14 days',
        ${values.redeemed === true ? client()`now()` : null}
      )
      returning id, seller_id, stand_provider_id, invited_by_authorization_id
    `;
    return rows as unknown as Record<string, unknown>[];
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114inv_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });

    const db = client();
    // Every invitation below is administrator-issued. `farmer_invitations_self_issued_names_farm`
    // predates this work and requires a self-issued row to name its farm, so the new-farm case
    // (naming neither) can only exist on the administrator door.
    const administrators = await db`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', now()) returning id
    `;
    administratorId = administrators[0]?.id as string;

    // The Venison Valley case as measured 2026-08-15: Kelsey's stand, and Gracie's Greens
    // existing only as a display-only participant name until this tranche turns it into a seller.
    const sellers = await db`
      insert into sellers (name)
      values ('Venison Valley'), ('Gracies Greens'), ('Tian Tian Farm')
      returning id
    `;
    hostSellerId = sellers[0]?.id as string;
    hostedSellerId = sellers[1]?.id as string;
    otherSellerId = sellers[2]?.id as string;

    const locations = await db`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Venison Valley Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        'Venison Valley Road, Vashon WA', 47.4473, -122.4590
      ) returning id
    `;
    standLocationId = locations[0]?.id as string;

    const pending = await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at
      ) values (
        ${standLocationId}, ${hostedSellerId}, 'pending', now()
      ) returning id
    `;
    pendingProviderId = pending[0]?.id as string;

    // Kelsey's own authorization — the stand owner's vouch. Derived through the self-pointer
    // exactly as §there is no second permission system requires: she is authorized for Venison
    // Valley, the seller her stand names as itself, and that IS being the stand's owner.
    const contacts = await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065551000', ${`h44${randomUUID().replaceAll("-", "")}`}) returning id
    `;
    const hostAuthorizations = await db`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${hostSellerId}, ${contacts[0]?.id as string}, now(), now()) returning id
    `;
    hostAuthorizationId = hostAuthorizations[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  describe("an invitation may bind the relationship it accepts", () => {
    it("admits the hosting invitation — a seller AND the pending provider it accepts", async () => {
      const rows = await invite({
        sellerId: hostedSellerId,
        standProviderId: pendingProviderId,
      });
      expect(rows[0]).toMatchObject({
        seller_id: hostedSellerId,
        stand_provider_id: pendingProviderId,
      });
    });

    it("admits the ordinary invitation, naming a seller and no provider", async () => {
      // 39 live invitations have this shape. Asserted as a POSITIVE case rather than assumed,
      // because a coherence rule written the wrong way round would refuse every one of them.
      const rows = await invite({ sellerId: otherSellerId, standProviderId: null });
      expect(rows[0]).toMatchObject({
        seller_id: otherSellerId,
        stand_provider_id: null,
      });
    });

    it("admits the new-farm invitation, naming neither", async () => {
      // `seller_id` is nullable precisely so an invitation can start onboarding a farm Farm
      // Friend has never heard of. That door stays open.
      const rows = await invite({ sellerId: null, standProviderId: null });
      expect(rows[0]).toMatchObject({ seller_id: null, stand_provider_id: null });
    });

    it("refuses a provider-bound invitation that names no seller", async () => {
      // The row that would redeem into "nothing to authorize" and silently accept nothing: the
      // farmer texts START, the invitation is spent, and the relationship stays pending forever.
      await refuses(
        () => invite({ sellerId: null, standProviderId: pendingProviderId }),
        {
          code: CHECK_VIOLATION,
          constraint: "farmer_invitations_hosting_names_seller",
        },
      );
    });
  });

  describe("the invitation's seller is the provider's seller", () => {
    it("refuses an invitation binding a provider for a DIFFERENT seller", async () => {
      // Invite Zoe to accept Gracie's Greens' participation, but authorize her for Tian Tian. A
      // typo away, and the composite key is what makes it impossible rather than merely unlikely.
      //
      // Its OWN provider row, deliberately: reusing one that already carries an open invitation
      // would trip `farmer_invitations_one_open_per_provider` first, and the case would pass
      // while proving nothing about the composite key it names.
      const db = client();
      const seller = await db`insert into sellers (name) values ('Mismatch Farm') returning id`;
      const provider = await db`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, invited_at
        ) values (${standLocationId}, ${seller[0]?.id as string}, 'pending', now())
        returning id
      `;
      await refuses(
        () =>
          invite({
            sellerId: otherSellerId,
            standProviderId: provider[0]?.id as string,
          }),
        {
          code: FOREIGN_KEY_VIOLATION,
          constraint: "farmer_invitations_provider_seller_fk",
        },
      );
    });

    it("refuses an invitation naming a provider that does not exist", async () => {
      await refuses(
        () => invite({ sellerId: hostedSellerId, standProviderId: randomUUID() }),
        {
          code: FOREIGN_KEY_VIOLATION,
          constraint: "farmer_invitations_provider_seller_fk",
        },
      );
    });
  });

  describe("a hosting invitation has exactly one issuer", () => {
    /** A fresh pending relationship per case, so uniqueness never decides an issuer case. */
    const freshPendingProvider = async (name: string): Promise<{
      sellerId: string;
      providerId: string;
    }> => {
      const db = client();
      const seller = await db`insert into sellers (name) values (${name}) returning id`;
      const sellerId = seller[0]?.id as string;
      const provider = await db`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, invited_at
        ) values (${standLocationId}, ${sellerId}, 'pending', now()) returning id
      `;
      return { sellerId, providerId: provider[0]?.id as string };
    };

    it("admits the stand owner's vouch", async () => {
      // Kelsey's door. She is authorized for the seller her stand points at, so inviting a
      // seller to her own stand IS the approval — §hosting and approval lifecycle, and the
      // reason this needs no VIGA step.
      const target = await freshPendingProvider("Vouched Bakery");
      const rows = await invite({
        sellerId: target.sellerId,
        standProviderId: target.providerId,
        issuer: "vouch",
      });
      expect(rows[0]).toMatchObject({
        stand_provider_id: target.providerId,
        invited_by_authorization_id: hostAuthorizationId,
      });
    });

    it("admits VIGA's own", async () => {
      // The coordinator's door, used to resolve the 11 retained hosted names. VIGA is the
      // approver on record when VIGA issues the link (max, 2026-08-15) — not the stand owner on
      // whose behalf the coordinator typed it.
      const target = await freshPendingProvider("VIGA Issued Bakery");
      const rows = await invite({
        sellerId: target.sellerId,
        standProviderId: target.providerId,
        issuer: "administrator",
      });
      expect(rows[0]?.invited_by_authorization_id).toBeNull();
    });

    it("refuses a hosting invitation with NO issuer", async () => {
      // It would accept into a provider row naming no approver, and
      // `stand_providers_hosting_lifecycle_coherent` would refuse the activation — the
      // invitation spent and the farmer stuck, discovered only at redemption.
      const target = await freshPendingProvider("Unissued Bakery");
      await refuses(
        () =>
          invite({
            sellerId: target.sellerId,
            standProviderId: target.providerId,
            issuer: "neither",
          }),
        { code: CHECK_VIOLATION, constraint: "farmer_invitations_hosting_issuer" },
      );
    });

    it("refuses a hosting invitation issued by BOTH", async () => {
      // Two answers to "who approved this", and the acceptance writer would have to pick one —
      // the guess code must never make.
      const target = await freshPendingProvider("Doubly Issued Bakery");
      await refuses(
        () =>
          invite({
            sellerId: target.sellerId,
            standProviderId: target.providerId,
            issuer: "both",
          }),
        { code: CHECK_VIOLATION, constraint: "farmer_invitations_hosting_issuer" },
      );
    });

    it("refuses a vouch on an invitation that binds no relationship", async () => {
      // An approval of no relationship at all. The ordinary farmer invitation has no vouch to
      // record, and admitting one would put a claim in the record with nothing it applies to.
      await refuses(
        () => invite({ sellerId: otherSellerId, standProviderId: null, issuer: "vouch" }),
        { code: CHECK_VIOLATION, constraint: "farmer_invitations_hosting_issuer" },
      );
    });
  });

  describe("one live invitation per pending relationship", () => {
    it("refuses a second unredeemed invitation for one provider", async () => {
      const db = client();
      const provider = await db`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, invited_at
        ) values (
          ${standLocationId}, ${otherSellerId}, 'pending', now()
        ) returning id
      `;
      const providerId = provider[0]?.id as string;
      await invite({ sellerId: otherSellerId, standProviderId: providerId });
      await refuses(
        () => invite({ sellerId: otherSellerId, standProviderId: providerId }),
        {
          code: UNIQUE_VIOLATION,
          constraint: "farmer_invitations_one_open_per_provider",
        },
      );
    });

    it("admits a fresh invitation once the first is redeemed", async () => {
      // A lapsed or spent invitation must be reissuable: a farmer who never texted START is the
      // ordinary case, and an index that refused a reissue would strand the relationship.
      const db = client();
      const seller = await db`insert into sellers (name) values ('Reissue Farm') returning id`;
      const sellerId = seller[0]?.id as string;
      const provider = await db`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, invited_at
        ) values (${standLocationId}, ${sellerId}, 'pending', now()) returning id
      `;
      const providerId = provider[0]?.id as string;
      await invite({ sellerId, standProviderId: providerId, redeemed: true });
      const rows = await invite({ sellerId, standProviderId: providerId });
      expect(rows[0]).toMatchObject({ stand_provider_id: providerId });
    });
  });
});
