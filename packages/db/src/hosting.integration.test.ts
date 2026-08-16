import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  inviteSellerToStand,
  loadFarmerInvitation,
  type Db,
  type Sql,
} from "./index";

/*
  F-114 Phase C.1 (invitation) — INVITING A SELLER TO A STAND.

  ## What this writer is, and what it deliberately is not

  The Venison Valley case, in VIGA's own words: *"Venison Valley carries Gracie's Greens. We want
  Zoe to be able to give her inventory without telling Kelsey."* Measured 2026-08-15, Gracie's
  Greens exists only as a display-only participant NAME — no seller record, no phone — so Zoe can
  text nothing today. Turning that name into a seller with her own phone and her own inventory at
  Kelsey's stand is the whole of this sub-phase.

  **The hosting invitation is the farmer invitation, and the onboarding is the farmer onboarding**
  (max, 2026-08-15). A hosted seller is set up exactly the way a stand owner is: a one-use link,
  the same form, and a bare `START` from their own handset. There is no second lifecycle, no
  parallel form, and no approval queue in front of it.

  **Onboarding happens even for a seller Farm Friend already knows** (max, 2026-08-15), because
  the stand-specific details vary — hours, season, what they sell THERE, and whether the host may
  restock for them. So one path, parameterized by whether the seller already exists, rather than
  two paths that would drift.

  **Kelsey forwards the link; Farm Friend never texts Zoe first** (max, 2026-08-15). No consent row
  exists for a number nobody gave us, so every outbound send to it would be suppressed anyway —
  the link travelling by the host's own hand is the honest shape rather than a limitation.

  **Two doors, one record.** The stand owner's vouch and VIGA's own are distinguished by which
  issuer the invitation names, and that is what `approval_source` becomes at acceptance:

    - Kelsey issues it   → `invited_by_authorization_id`   → `approval_source = 'host'`
    - VIGA issues it     → `created_by_administrator_id`   → `approval_source = 'viga'`

  VIGA is the approver on record whenever VIGA issues the link (max, 2026-08-15), even when a
  coordinator is doing it for a stand owner who asked.

  **Nothing is public until the seller finishes** (max, 2026-08-15). The provider row is `pending`,
  which every public reader already excludes, so an invited seller who never answers is simply
  never listed — nobody is shown as selling somewhere before they agreed to be.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("hosted-seller invitation (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let administratorId = "";
  let hostSellerId = "";
  let hostStandId = "";
  let hostAuthorizationId = "";
  let venueStandId = "";
  let knownSellerId = "";

  const now = new Date("2026-08-15T18:00:00.000Z");
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_hosting_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${now}) returning id
    `;
    administratorId = administrators[0]?.id as string;

    const sellers = await sql()`
      insert into sellers (name) values ('Venison Valley'), ('Fernhorn Bakery')
      returning id, name
    `;
    hostSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    // A seller Farm Friend already knows, selling at its own stand elsewhere. Invited to a SECOND
    // stand it still onboards, because the stand-specific details differ.
    knownSellerId = sellers.find((row) => row.name === "Fernhorn Bakery")?.id as string;

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
    hostStandId = await mkStand("Venison Valley Stand", hostSellerId);
    // Morgan Hill's shape: a venue with no seller of its own, so its owner's authorization takes
    // the STAND arm. It is here because a venue is exactly the place that hosts sellers.
    venueStandId = await mkStand("Morgan Hill Community Stand", null);

    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065551000', ${`k${randomUUID().replaceAll("-", "")}`}) returning id
    `;
    const authorizations = await sql()`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${hostSellerId}, ${contacts[0]?.id as string}, ${now}, ${now}) returning id
    `;
    hostAuthorizationId = authorizations[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  const providerFor = async (
    standId: string,
    sellerId: string,
  ): Promise<Record<string, unknown> | undefined> => {
    const rows = await sql()`
      select * from stand_providers
      where sales_location_id = ${standId} and seller_id = ${sellerId}
    `;
    return rows[0] as Record<string, unknown> | undefined;
  };

  describe("the stand owner's door", () => {
    it("creates the seller, the pending relationship, and a link Kelsey can forward", async () => {
      // The Venison Valley case end to end, as far as an invitation goes. Gracie's Greens does
      // not exist yet, so the name becomes a seller here — a person deciding, never a name match.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: hostStandId,
        newSellerName: "Gracies Greens",
        invitedByAuthorizationId: hostAuthorizationId,
        occurredAt: now,
      });
      expect(result.status).toBe("invited");
      if (result.status !== "invited") return;

      // The token is returned ONCE and only the hash is stored, exactly as the administrator
      // invitation already works. Kelsey forwards the link; Farm Friend texts nobody.
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.sellerName).toBe("Gracies Greens");

      const provider = await providerFor(hostStandId, result.sellerId);
      expect(provider).toMatchObject({
        lifecycle_state: "pending",
        host_may_update_stock: false,
      });
      expect(provider?.accepted_at).toBeNull();
      expect(provider?.approval_source).toBeNull();
      expect(provider?.invited_at).not.toBeNull();

      const invitations = await sql()`
        select seller_id, stand_provider_id, invited_by_authorization_id,
          created_by_administrator_id
        from farmer_invitations where stand_provider_id = ${provider?.id as string}
      `;
      expect(invitations[0]).toMatchObject({
        seller_id: result.sellerId,
        invited_by_authorization_id: hostAuthorizationId,
        created_by_administrator_id: null,
      });
    });

    it("the invited seller is not public before they answer", async () => {
      // §nothing is public until the seller finishes. A `pending` provider is excluded by every
      // public reader, so an invitation nobody answers lists nobody. Asserted on the row's state
      // rather than through a reader, which is what the state means.
      const rows = await sql()`
        select count(*)::int as live from stand_providers
        where sales_location_id = ${hostStandId}
          and lifecycle_state = 'active' and ended_at is null
          and seller_id <> ${hostSellerId}
      `;
      expect(rows[0]?.live).toBe(0);
    });

    it("invites a seller Farm Friend already knows, to a second stand", async () => {
      // Fernhorn already sells elsewhere. It still gets an invitation and still onboards, because
      // the stand-specific details vary (max, 2026-08-15) — but no second seller record is
      // created for it, which would split one bakery into two identities.
      const before = await sql()`select count(*)::int as total from sellers`;
      const result = await inviteSellerToStand(database(), {
        salesLocationId: hostStandId,
        sellerId: knownSellerId,
        invitedByAuthorizationId: hostAuthorizationId,
        occurredAt: now,
      });
      expect(result.status).toBe("invited");
      if (result.status !== "invited") return;
      expect(result.sellerId).toBe(knownSellerId);

      const after = await sql()`select count(*)::int as total from sellers`;
      expect(after[0]?.total).toBe(before[0]?.total);
      expect(await providerFor(hostStandId, knownSellerId)).toMatchObject({
        lifecycle_state: "pending",
      });
    });

    it("refuses a phone that is not authorized for the stand", async () => {
      // The whole gate, and the only one. Kelsey may invite to HER stand; her authorization says
      // nothing about Morgan Hill. Derived through the self-pointer, never stored as a role.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: venueStandId,
        newSellerName: "Someone Elses Idea",
        invitedByAuthorizationId: hostAuthorizationId,
        occurredAt: now,
      });
      expect(result.status).toBe("not_authorized");
      const sellers = await sql()`
        select count(*)::int as total from sellers where name = 'Someone Elses Idea'
      `;
      expect(sellers[0]?.total).toBe(0);
    });

    it("refuses a revoked authorization", async () => {
      const contacts = await sql()`
        insert into contacts (phone_e164, phone_hash)
        values ('+12065551001', ${`r${randomUUID().replaceAll("-", "")}`}) returning id
      `;
      const revoked = await sql()`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at, revoked_at
        ) values (${hostSellerId}, ${contacts[0]?.id as string}, ${now}, ${now}, ${now})
        returning id
      `;
      const result = await inviteSellerToStand(database(), {
        salesLocationId: hostStandId,
        newSellerName: "Revoked Idea",
        invitedByAuthorizationId: revoked[0]?.id as string,
        occurredAt: now,
      });
      expect(result.status).toBe("not_authorized");
    });
  });

  describe("VIGA's door", () => {
    it("records VIGA as the approver, even for a stand owner who asked", async () => {
      // max, 2026-08-15: VIGA is the approver on record whenever VIGA issues the link. The
      // coordinator is not typing on the owner's behalf in the record; they are deciding.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: venueStandId,
        newSellerName: "Tian Tian Farm",
        administratorId,
        occurredAt: now,
      });
      expect(result.status).toBe("invited");
      if (result.status !== "invited") return;

      const provider = await providerFor(venueStandId, result.sellerId);
      const invitations = await sql()`
        select invited_by_authorization_id, created_by_administrator_id
        from farmer_invitations where stand_provider_id = ${provider?.id as string}
      `;
      expect(invitations[0]).toMatchObject({
        invited_by_authorization_id: null,
        created_by_administrator_id: administratorId,
      });
    });

    it("can invite to a venue that has no seller of its own", async () => {
      // Morgan Hill hosts four sellers and owns none. It is the stand most in need of this
      // writer, and the one a seller-rooted invite could never reach.
      const rows = await sql()`
        select own_seller_id from sales_locations where id = ${venueStandId}
      `;
      expect(rows[0]?.own_seller_id).toBeNull();
      const providers = await sql()`
        select count(*)::int as total from stand_providers
        where sales_location_id = ${venueStandId}
      `;
      expect(providers[0]?.total).toBeGreaterThan(0);
    });

    it("refuses an issuer that is neither an administrator nor an authorization", async () => {
      // Exactly one issuer, and the writer answers rather than letting the CHECK raise: an
      // operator gets a result instead of a constraint violation, and no seller is created
      // pointing at an invitation that was never minted.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: hostStandId,
        newSellerName: "Unissued Idea",
        occurredAt: now,
      });
      expect(result.status).toBe("invalid_issuer");
      const sellers = await sql()`
        select count(*)::int as total from sellers where name = 'Unissued Idea'
      `;
      expect(sellers[0]?.total).toBe(0);
    });

    it("refuses BOTH issuers named at once", async () => {
      const result = await inviteSellerToStand(database(), {
        salesLocationId: hostStandId,
        newSellerName: "Doubly Issued Idea",
        administratorId,
        invitedByAuthorizationId: hostAuthorizationId,
        occurredAt: now,
      });
      expect(result.status).toBe("invalid_issuer");
    });
  });

  describe("what an invitation may not say", () => {
    it("refuses naming both an existing seller and a new name", async () => {
      // Two different sellers for one invitation is an ambiguous instruction, and guessing which
      // was meant would bind the farmer to the wrong seller. Same rule, same reason, as
      // `createFarmerInvitation`.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: hostStandId,
        sellerId: knownSellerId,
        newSellerName: "Ambiguous Farm",
        invitedByAuthorizationId: hostAuthorizationId,
        occurredAt: now,
      });
      expect(result.status).toBe("invalid_seller");
    });

    it("refuses a blank new seller name", async () => {
      // Trimmed before the test, so padding decides nothing. `sellers_name_not_blank` is the
      // database's backstop; answering here means no invitation is minted at a seller that was
      // never created.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: hostStandId,
        newSellerName: "   ",
        invitedByAuthorizationId: hostAuthorizationId,
        occurredAt: now,
      });
      expect(result.status).toBe("invalid_seller");
    });

    it("refuses a new seller name carrying contact details, creating nothing", async () => {
      /*
        A seller name is PUBLIC TEXT. §suppression follows a pointer credits every seller a stand
        hosts on its public card, so a name typed here reaches the island's guide — and since the
        stand owner's own door (F-114 Phase C.1) lets an untrusted farmer type it, the same
        boundary `saveSalesLocationParticipants` already applies to the display-only names has to
        apply to the real ones. Launch forbids direct farmer contact; a name is not an exemption.

        Refused HERE rather than at each door, so both doors cannot come to disagree — and before
        the seller row is written, because a refusal that left a seller behind would put an
        unreachable brand in the identity root.
      */
      for (const name of [
        "Gracies Greens 206-555-0199",
        "Gracies Greens zoe@example.com",
        "Gracies Greens graciesgreens.com",
        "Gracies Greens call us for orders",
      ]) {
        const result = await inviteSellerToStand(database(), {
          salesLocationId: hostStandId,
          newSellerName: name,
          invitedByAuthorizationId: hostAuthorizationId,
          occurredAt: now,
        });
        expect(result.status, name).toBe("unsafe_public_text");
        if (result.status === "unsafe_public_text") {
          expect(result.prohibited.length, name).toBeGreaterThan(0);
        }
      }

      const sellers = await sql()`
        select count(*)::int as total from sellers where name like 'Gracies Greens %'
      `;
      expect(sellers[0]?.total, "a refused name may not leave a seller behind").toBe(0);
    });

    it("admits an ordinary seller name the guard has no business refusing", async () => {
      // The guard has to be able to PASS, or the case above proves only that everything is
      // refused. An apostrophe, an ampersand, and a number are all ordinary in a farm name.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: venueStandId,
        newSellerName: "Gracie's Greens & Co No. 2",
        administratorId,
        occurredAt: now,
      });
      expect(result.status).toBe("invited");
    });

    it("refuses inviting the stand's own seller to its own stand", async () => {
      // Venison Valley already sells at Venison Valley Stand — that is what the self-pointer
      // means. An invitation here would either collide with the existing provider row or invent a
      // second one for the same seller, and neither is a thing anybody asked for.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: hostStandId,
        sellerId: hostSellerId,
        invitedByAuthorizationId: hostAuthorizationId,
        occurredAt: now,
      });
      expect(result.status).toBe("already_selling_here");
    });

    it("refuses a seller already invited here, without minting a second link", async () => {
      // The uniqueness the index enforces, answered honestly by the writer. A second link for one
      // relationship would let two handsets each accept it, and the second would find the
      // relationship already live with no honest answer for its farmer.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: hostStandId,
        sellerId: knownSellerId,
        invitedByAuthorizationId: hostAuthorizationId,
        occurredAt: now,
      });
      expect(result.status).toBe("already_selling_here");
      const invitations = await sql()`
        select count(*)::int as total from farmer_invitations i
        join stand_providers p on p.id = i.stand_provider_id
        where p.sales_location_id = ${hostStandId} and p.seller_id = ${knownSellerId}
      `;
      expect(invitations[0]?.total).toBe(1);
    });

    it("refuses an unknown stand", async () => {
      const result = await inviteSellerToStand(database(), {
        salesLocationId: randomUUID(),
        newSellerName: "Nowhere Farm",
        administratorId,
        occurredAt: now,
      });
      expect(result.status).toBe("unknown_stand");
    });
  });

  describe("the link the invited seller opens", () => {
    it("resolves through the ordinary onboarding lookup", async () => {
      // The proof that this is the FARMER invitation and not a parallel record: the token the
      // host forwards is loaded by the same function an administrator's invitation is, so the
      // invited seller reaches the same onboarding form a stand owner does.
      const result = await inviteSellerToStand(database(), {
        salesLocationId: venueStandId,
        newSellerName: "Cascade Bakery",
        administratorId,
        occurredAt: now,
      });
      expect(result.status).toBe("invited");
      if (result.status !== "invited") return;

      const loaded = await loadFarmerInvitation(database(), result.token, now);
      expect(loaded).toMatchObject({
        status: "active",
        farmId: result.sellerId,
        farmName: "Cascade Bakery",
      });
    });
  });
});
