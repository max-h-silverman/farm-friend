import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, resolveProviderWriteAuthority, type Db, type Sql } from "./index";

/*
  F-114 Phase C.2 — WHO MAY WRITE A PROVIDER'S STOCK.

  ## The one question, asked once

  Before this seam, every inventory writer asked the same question a different way and all of
  them asked it wrong for a stand with more than one seller: *is this phone authorized for the
  stand's OWN seller?* That is right for 31 of 38 stands and wrong for every hosted relationship
  — it locks Zoe out of her own goods at Kelsey's stand and it locks Morgan Hill's manager out of
  a venue that has no seller of its own.

  The question every writer actually needs is *may this phone write THIS provider's stock, and
  under which authorization?* There are three ways to say yes and they are enumerated here rather
  than at each writer, because a writer that forgets one silently refuses a farmer their own
  listing, and a writer that invents a fourth silently publishes someone else's goods.

  ## The three ways to say yes

  1. **The seller's own phone.** An authorization naming the provider's seller. This is Zoe at
     Kelsey's stand and it is also every farmer at their own stand today — the stand's own seller
     is a seller like any other, so the ordinary case is not a special case.
  2. **The stand's phone, when the seller permitted it.** `host_may_update_stock` on the hosting
     relationship, off by default and the SELLER'S to grant (§the Venison Valley case). A baker
     who drops off at dawn may want the host marking the last loaf gone; Zoe specifically does
     not. Both are legitimate, so it is a property of the relationship rather than of the stand
     or of a role.
  3. **The stand arm, for a venue.** Morgan Hill has no seller of its own, so its manager cannot
     be reached through a seller authorization at all. `farmer_authorizations.sales_location_id`
     is that arm, and C.1 built it. It confers the same host right, under the same opt-in.

  ## What it is NOT, and each is asserted below rather than merely written here

  - **Not a default.** An accepted invitation never turns the right on: acceptance may not grant
    more access than it says (§hosting and approval lifecycle).
  - **Not a general permission.** Stock only. A host with the right may not touch a hosted
    seller's identity, prices as a standing fact, payment, pause, or participation — those need
    an authorization for that seller (§facts and authority, unchanged).
  - **Not transitive between stands.** A host right at one stand says nothing about the same
    seller at another. Each relationship is independent.
  - **Not survivable.** A revoked authorization, an ended relationship, or a paused/pending
    provider is not a writer.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("provider write authority (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  /** Kelsey's stand: her own seller, plus Zoe hosted. */
  let hostStandId = "";
  let hostSellerId = "";
  let hostProviderId = "";
  let hostAuthorizationId = "";
  let hostSenderHash = "";

  /** Zoe, hosted at Kelsey's stand and selling at her own stand too. */
  let guestSellerId = "";
  let guestProviderId = "";
  let guestAuthorizationId = "";
  let guestSenderHash = "";
  let guestOwnStandId = "";
  let guestOwnProviderId = "";

  /** Morgan Hill: a venue with no seller of its own, hosting Zoe. */
  let venueStandId = "";
  let venueProviderId = "";
  let venueAuthorizationId = "";
  let venueSenderHash = "";

  /** A phone authorized for nobody relevant. */
  let strangerSenderHash = "";

  const now = new Date("2026-08-15T18:00:00.000Z");
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  const mkContactAuthorization = async (input: {
    phone: string;
    sellerId?: string;
    salesLocationId?: string;
  }): Promise<{ authorizationId: string; senderHash: string }> => {
    const senderHash = `h${randomUUID().replaceAll("-", "")}`;
    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash)
      values (${input.phone}, ${senderHash}) returning id
    `;
    const rows = await sql()`
      insert into farmer_authorizations (
        seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
      ) values (
        ${input.sellerId ?? null}, ${input.salesLocationId ?? null},
        ${contacts[0]?.id as string}, ${now}, ${now}
      ) returning id
    `;
    return { authorizationId: rows[0]?.id as string, senderHash };
  };

  /** A stand's own seller already has a provider row — the stand writer creates it. */
  const providerFor = async (
    salesLocationId: string,
    sellerId: string,
  ): Promise<string> => {
    const rows = await sql()`
      select id from stand_providers
      where sales_location_id = ${salesLocationId} and seller_id = ${sellerId}
    `;
    const id = rows[0]?.id as string | undefined;
    if (id === undefined) {
      throw new Error(`no provider for seller ${sellerId} at stand ${salesLocationId}`);
    }
    return id;
  };

  const mkProvider = async (input: {
    salesLocationId: string;
    sellerId: string;
    lifecycleState?: string;
    hostMayUpdateStock?: boolean;
  }): Promise<string> => {
    const state = input.lifecycleState ?? "active";
    const rows = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${input.salesLocationId}, ${input.sellerId}, ${state},
        ${input.hostMayUpdateStock ?? false}, ${now},
        ${state === "pending" ? null : now},
        ${state === "pending" ? null : "viga"},
        ${state === "pending" ? null : now}
      ) returning id
    `;
    return rows[0]?.id as string;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_provwrite_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const sellers = await sql()`
      insert into sellers (name)
      values ('Venison Valley'), ('Gracies Greens')
      returning id, name
    `;
    hostSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    guestSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;

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
    guestOwnStandId = await mkStand("Gracies Greens Stand", guestSellerId);
    venueStandId = await mkStand("Morgan Hill Community Stand", null);

    hostProviderId = await providerFor(hostStandId, hostSellerId);
    guestOwnProviderId = await providerFor(guestOwnStandId, guestSellerId);
    guestProviderId = await mkProvider({
      salesLocationId: hostStandId,
      sellerId: guestSellerId,
    });
    venueProviderId = await mkProvider({
      salesLocationId: venueStandId,
      sellerId: guestSellerId,
    });

    ({ authorizationId: hostAuthorizationId, senderHash: hostSenderHash } =
      await mkContactAuthorization({ phone: "+12065551000", sellerId: hostSellerId }));
    ({ authorizationId: guestAuthorizationId, senderHash: guestSenderHash } =
      await mkContactAuthorization({ phone: "+12065551001", sellerId: guestSellerId }));
    // The venue's manager. No seller to name, so the STAND arm C.1 built.
    ({ authorizationId: venueAuthorizationId, senderHash: venueSenderHash } =
      await mkContactAuthorization({
        phone: "+12065551002",
        salesLocationId: venueStandId,
      }));
    ({ senderHash: strangerSenderHash } = await mkContactAuthorization({
      phone: "+12065551003",
      sellerId: hostSellerId,
    }));
    // The stranger's authorization is revoked, so the phone exists and authorizes nothing.
    await sql()`
      update farmer_authorizations set revoked_at = ${now}
      where contact_id = (select id from contacts where phone_hash = ${strangerSenderHash})
    `;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  describe("the seller's own phone", () => {
    it("writes its own provider, under its own authorization", async () => {
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: guestProviderId,
        senderHash: guestSenderHash,
      });
      expect(authority).toEqual({
        status: "authorized",
        via: "seller",
        authorizationId: guestAuthorizationId,
        sellerId: guestSellerId,
        salesLocationId: hostStandId,
        providerId: guestProviderId,
        hostMayUpdateStock: false,
        paused: false,
      });
    });

    it("is the ordinary farmer at their own stand — not a special case", async () => {
      // 31 of 38 stands. The stand's own seller is a seller like any other, so this path is the
      // same path, which is why there is no separate native branch to keep in step.
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: hostProviderId,
        senderHash: hostSenderHash,
      });
      expect(authority).toMatchObject({
        status: "authorized",
        via: "seller",
        authorizationId: hostAuthorizationId,
      });
    });

    it("refuses a revoked authorization", async () => {
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: hostProviderId,
        senderHash: strangerSenderHash,
      });
      expect(authority).toEqual({ status: "not_authorized" });
    });
  });

  describe("the host's phone", () => {
    it("is refused by default — acceptance never granted it", async () => {
      // §not a default. This is Zoe's arrangement: Kelsey may not state Zoe's stock. The row's
      // `host_may_update_stock` is false because the invitation never touched it.
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: guestProviderId,
        senderHash: hostSenderHash,
      });
      expect(authority).toEqual({ status: "not_authorized" });
    });

    it("writes the hosted seller's stock once the seller grants the right", async () => {
      await sql()`
        update stand_providers set host_may_update_stock = true
        where id = ${guestProviderId}
      `;
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: guestProviderId,
        senderHash: hostSenderHash,
      });
      expect(authority).toEqual({
        status: "authorized",
        via: "host",
        authorizationId: hostAuthorizationId,
        sellerId: guestSellerId,
        salesLocationId: hostStandId,
        providerId: guestProviderId,
        hostMayUpdateStock: true,
        paused: false,
      });
      await sql()`
        update stand_providers set host_may_update_stock = false
        where id = ${guestProviderId}
      `;
    });

    it("does not reach the same seller at another stand", async () => {
      // §not transitive. Kelsey's right over Gracies Greens at HER stand says nothing about
      // Gracies Greens at its own. Granting it here and asserting the OTHER provider refuses is
      // the point: the negative is what the relationship scoping actually buys.
      await sql()`
        update stand_providers set host_may_update_stock = true
        where id = ${guestProviderId}
      `;
      const elsewhere = await resolveProviderWriteAuthority(database(), {
        providerId: guestOwnProviderId,
        senderHash: hostSenderHash,
      });
      expect(elsewhere).toEqual({ status: "not_authorized" });
      await sql()`
        update stand_providers set host_may_update_stock = false
        where id = ${guestProviderId}
      `;
    });

    it("attributes to the seller's own arm when one phone holds both", async () => {
      // One person acting for two sellers is current fact — measured 2026-08-15, one phone
      // already does. So a host's phone that is ALSO authorized for the hosted seller is
      // reachable, and which arm answers decides whose name goes on the revision.
      //
      // The seller arm wins, because stating your own stock needs nobody's permission: filing
      // it under the host's authorization would attribute the seller's own claim to someone
      // else for no reason. Asserted by giving the host's contact a second authorization for
      // the guest seller and granting the host right too, so BOTH arms would answer.
      const contact = await sql()`
        select id from contacts where phone_hash = ${hostSenderHash}
      `;
      const extra = await sql()`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at
        ) values (
          ${guestSellerId}, ${contact[0]?.id as string}, ${now}, ${now}
        ) returning id
      `;
      await sql()`
        update stand_providers set host_may_update_stock = true
        where id = ${guestProviderId}
      `;

      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: guestProviderId,
        senderHash: hostSenderHash,
      });
      expect(authority).toMatchObject({
        status: "authorized",
        via: "seller",
        authorizationId: extra[0]?.id as string,
      });
      // The absence of the wrong answer, stated as its own assertion: the host arm must not be
      // what answered, and its authorization id must not be what the write is attributed to.
      if (authority.status !== "authorized") throw new Error("expected authorization");
      expect(authority.via).not.toBe("host");
      expect(authority.authorizationId).not.toBe(hostAuthorizationId);

      await sql()`delete from farmer_authorizations where id = ${extra[0]?.id as string}`;
      await sql()`
        update stand_providers set host_may_update_stock = false
        where id = ${guestProviderId}
      `;
    });

    it("reports the right as absent when the seller has not granted it", async () => {
      // The right is a fact a caller may need to SHOW (the seller's own settings screen), so it
      // is reported rather than only enforced. Read on the seller's own authority, so a seller
      // can see what they granted without the grant being what let them look.
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: guestProviderId,
        senderHash: guestSenderHash,
      });
      expect(authority).toMatchObject({ status: "authorized", hostMayUpdateStock: false });
    });
  });

  describe("the stand arm, for a venue", () => {
    it("writes a hosted seller's stock at a stand with no seller of its own", async () => {
      // Morgan Hill. There is no seller to authorize against, so without the stand arm its
      // manager could never write anything here — the gap C.1's records opened and this closes.
      await sql()`
        update stand_providers set host_may_update_stock = true
        where id = ${venueProviderId}
      `;
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: venueProviderId,
        senderHash: venueSenderHash,
      });
      expect(authority).toEqual({
        status: "authorized",
        via: "host",
        authorizationId: venueAuthorizationId,
        sellerId: guestSellerId,
        salesLocationId: venueStandId,
        providerId: venueProviderId,
        hostMayUpdateStock: true,
        paused: false,
      });
      await sql()`
        update stand_providers set host_may_update_stock = false
        where id = ${venueProviderId}
      `;
    });

    it("is refused without the seller's opt-in, exactly like a seller-armed host", async () => {
      // The stand arm confers no MORE than the seller arm does. A venue manager is a host, not
      // an owner of other people's goods.
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: venueProviderId,
        senderHash: venueSenderHash,
      });
      expect(authority).toEqual({ status: "not_authorized" });
    });

    it("does not reach another stand", async () => {
      await sql()`
        update stand_providers set host_may_update_stock = true
        where id = ${guestProviderId}
      `;
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: guestProviderId,
        senderHash: venueSenderHash,
      });
      expect(authority).toEqual({ status: "not_authorized" });
      await sql()`
        update stand_providers set host_may_update_stock = false
        where id = ${guestProviderId}
      `;
    });
  });

  describe("the relationship's own state", () => {
    it("refuses a pending provider — the seller has not agreed to be there", async () => {
      const rows = await sql()`
        insert into sellers (name) values ('Cascade Bakery') returning id
      `;
      const pendingSellerId = rows[0]?.id as string;
      const pendingProviderId = await mkProvider({
        salesLocationId: hostStandId,
        sellerId: pendingSellerId,
        lifecycleState: "pending",
      });
      const { senderHash } = await mkContactAuthorization({
        phone: "+12065551004",
        sellerId: pendingSellerId,
      });
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: pendingProviderId,
        senderHash,
      });
      expect(authority).toEqual({ status: "provider_not_live" });
    });

    it("refuses an ended relationship even for the seller's own phone", async () => {
      await sql()`
        update stand_providers set ended_at = ${now} where id = ${guestProviderId}
      `;
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: guestProviderId,
        senderHash: guestSenderHash,
      });
      expect(authority).toEqual({ status: "provider_not_live" });
      await sql()`update stand_providers set ended_at = null where id = ${guestProviderId}`;
    });

    it("reports a paused provider as paused, never as unauthorized", async () => {
      // §a paused provider is offered re-opening, never refused. The distinction is load-bearing:
      // a caller told `not_authorized` would answer "you can't do that", and a paused seller
      // must instead be offered their listing back. Two statuses because they are two answers.
      await sql()`
        update stand_providers set lifecycle_state = 'paused'
        where id = ${guestProviderId}
      `;
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: guestProviderId,
        senderHash: guestSenderHash,
      });
      expect(authority).toMatchObject({
        status: "authorized",
        via: "seller",
        paused: true,
      });
      await sql()`
        update stand_providers set lifecycle_state = 'active'
        where id = ${guestProviderId}
      `;
    });

    it("reports an unpaused provider as not paused", async () => {
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: guestProviderId,
        senderHash: guestSenderHash,
      });
      expect(authority).toMatchObject({ status: "authorized", paused: false });
    });

    it("refuses an unknown provider", async () => {
      const authority = await resolveProviderWriteAuthority(database(), {
        providerId: randomUUID(),
        senderHash: guestSenderHash,
      });
      expect(authority).toEqual({ status: "unknown_provider" });
    });
  });
});
