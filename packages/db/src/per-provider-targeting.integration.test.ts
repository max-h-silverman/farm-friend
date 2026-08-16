import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  resolveAdministratorLinkTarget,
  resolveProviderWriteAuthority,
  type Db,
  type Sql,
} from "./index";
import {
  hasLiveFarmerAuthorization,
  resolveFarmerTarget,
  selectFarmerTarget,
  selectFarmerTargetForAuthorization,
} from "./farmer-targeting";

/*
  F-114 Phase C.3 — WHAT A FARMER'S SMS CAN REACH.

  ## The gate this closes

  Before C.3, `lockLiveTargets` joined `sales_locations.own_seller_id = auth.seller_id`. That
  sentence says *a farmer may reach the stands they own*, which was true of every stand in the
  corpus and is false of every hosting relationship C.1 and C.2 built. Zoe could publish Gracie's
  Greens' stock at Kelsey's stand through the web writer — C.2 proved it — and could not be
  reached by SMS at all, because the only join that turns her phone into a target ran through a
  stand she does not own. A seller with no stand of her own was untargetable outright.

  A target is therefore a PROVIDER, not a stand. It is the same three ways to say yes
  `resolveProviderWriteAuthority` enumerates, asked in the other direction: instead of *may this
  phone write this provider*, *which providers may this phone write*. One rule, two directions —
  and the round trip is asserted here, so the two can never drift into disagreeing about the same
  phone.

  ## The menu names the seller only where it differs from the stand

  §suppression follows a pointer: a customer must never see `Provo Farms — Provo Farms`, and a
  farmer must never see it either. The stand's own seller renders as the bare stand name; every
  other seller is named beside it. By SELF-POINTER, never a name match — a farmer who renames her
  seller stays unlabeled, and a hosted `Hill Farm` at `Hill Farm Stand` stays credited.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-114 C.3 per-provider SMS targeting (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  /** Kelsey's stand: her own seller, plus Zoe hosted on it. */
  let hostStandId = "";
  let hostSellerId = "";
  let hostProviderId = "";
  let hostSenderHash = "";

  /** Zoe. Hosted at Kelsey's stand, and nowhere else — she has no stand of her own. */
  let guestSellerId = "";
  let guestProviderId = "";
  let guestAuthorizationId = "";
  let guestSenderHash = "";

  /**
   * Morgan Hill: a venue with no seller of its own, hosting a THIRD seller.
   *
   * Deliberately not Zoe. Zoe's single relationship is what makes "her only target" a claim
   * about the join rather than about which of several rows sorted first.
   */
  let venueStandId = "";
  let venueSellerId = "";
  let venueProviderId = "";
  let venueAuthorizationId = "";
  let venueSenderHash = "";

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
    databaseName = `ff_c3target_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
      values ('Venison Valley'), ('Gracies Greens'), ('Cascade Bakery')
      returning id, name
    `;
    hostSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    guestSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;
    venueSellerId = sellers.find((row) => row.name === "Cascade Bakery")?.id as string;

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
    venueStandId = await mkStand("Morgan Hill Community Stand", null);

    hostProviderId = await providerFor(hostStandId, hostSellerId);
    guestProviderId = await mkProvider({
      salesLocationId: hostStandId,
      sellerId: guestSellerId,
    });
    venueProviderId = await mkProvider({
      salesLocationId: venueStandId,
      sellerId: venueSellerId,
    });

    ({ senderHash: hostSenderHash } =
      await mkContactAuthorization({ phone: "+12065551000", sellerId: hostSellerId }));
    ({ authorizationId: guestAuthorizationId, senderHash: guestSenderHash } =
      await mkContactAuthorization({ phone: "+12065551001", sellerId: guestSellerId }));
    ({ authorizationId: venueAuthorizationId, senderHash: venueSenderHash } =
      await mkContactAuthorization({
        phone: "+12065551002",
        salesLocationId: venueStandId,
      }));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await sql()`truncate farmer_target_menu_options, farmer_target_contexts, sender_states
      restart identity cascade`;
    await sql()`
      update stand_providers set host_may_update_stock = false
      where id in (${guestProviderId}, ${venueProviderId})
    `;
    // Restore the WHOLE lifecycle row, not the state column alone:
    // `stand_providers_hosting_lifecycle_coherent` binds the state to `accepted_at`,
    // `approval_source` and `approved_at` together, so resetting one leaves a row no writer can
    // produce and every later case dies on the constraint rather than on its own claim.
    // `accepted_at` is restored from each row's OWN `invited_at`, never from the suite's clock:
    // the stand's own provider is created by `create_own_seller_provider` at stand-insert time,
    // so its invitation is later than this fixture's fixed `now` and a constant would fail the
    // `accepted_at >= invited_at` arm.
    await sql()`
      update stand_providers
      set lifecycle_state = 'active', ended_at = null, accepted_at = invited_at,
          approval_source = 'viga', approved_at = invited_at
      where id in (${guestProviderId}, ${venueProviderId}, ${hostProviderId})
    `;
  });

  describe("a hosted seller is reachable at all", () => {
    it("targets the hosted seller's own provider at a stand she does not own", async () => {
      const result = await resolveFarmerTarget(database(), {
        senderHash: guestSenderHash,
        occurredAt: now,
        purpose: "update",
      });

      // Zoe's ONLY target is Gracie's Greens at Kelsey's stand. Before C.3 this was
      // `not_authorized`: she owns no stand, so the self-pointer join returned nothing and no
      // SMS could reach her.
      expect(result).toMatchObject({
        status: "selected",
        autoSelected: true,
        target: {
          authorizationId: guestAuthorizationId,
          providerId: guestProviderId,
          sellerId: guestSellerId,
          salesLocationId: hostStandId,
          locationName: "Venison Valley Stand",
          sellerName: "Gracies Greens",
        },
      });
      expect(
        await hasLiveFarmerAuthorization(database(), {
          senderHash: guestSenderHash,
          occurredAt: now,
        }),
      ).toBe(true);
    });

    it("stores the hosted provider on the durable selection, not the stand's own", async () => {
      await resolveFarmerTarget(database(), {
        senderHash: guestSenderHash,
        occurredAt: now,
        purpose: "update",
      });
      expect(await sql()`
        select selected_provider_id, selected_sales_location_id, selected_owner_seller_id
        from farmer_target_contexts where sender_hash = ${guestSenderHash}
      `).toEqual([
        {
          selected_provider_id: guestProviderId,
          selected_sales_location_id: hostStandId,
          selected_owner_seller_id: guestSellerId,
        },
      ]);
    });

    it("reaches a venue's provider through the stand arm", async () => {
      // Morgan Hill's manager holds a stand-armed authorization and no seller at all. The
      // venue's provider is Zoe's, and the manager reaches it only under the seller's opt-in.
      await sql()`
        update stand_providers set host_may_update_stock = true where id = ${venueProviderId}
      `;
      const result = await resolveFarmerTarget(database(), {
        senderHash: venueSenderHash,
        occurredAt: now,
        purpose: "update",
      });
      expect(result).toMatchObject({
        status: "selected",
        target: {
          authorizationId: venueAuthorizationId,
          providerId: venueProviderId,
          sellerId: venueSellerId,
          salesLocationId: venueStandId,
          sellerName: "Cascade Bakery",
          describesOwnStand: false,
        },
      });
    });
  });

  describe("the host reaches a hosted provider only under the seller's opt-in", () => {
    it("offers Kelsey her own listing alone while Zoe has not granted the right", async () => {
      const result = await resolveFarmerTarget(database(), {
        senderHash: hostSenderHash,
        occurredAt: now,
        purpose: "update",
      });
      // Zoe specifically does not want Kelsey restocking for her (§the Venison Valley case), so
      // Kelsey's only target is her own listing — which auto-selects rather than offering a menu.
      expect(result).toMatchObject({
        status: "selected",
        autoSelected: true,
        target: { providerId: hostProviderId, sellerId: hostSellerId },
      });
    });

    it("adds the hosted provider to the host's menu once the seller grants it", async () => {
      await sql()`
        update stand_providers set host_may_update_stock = true where id = ${guestProviderId}
      `;
      const result = await resolveFarmerTarget(database(), {
        senderHash: hostSenderHash,
        occurredAt: now,
        purpose: "update",
      });
      expect(result).toMatchObject({
        status: "menu",
        options: [
          {
            optionNumber: 1,
            providerId: guestProviderId,
            sellerId: guestSellerId,
            salesLocationId: hostStandId,
            sellerName: "Gracies Greens",
          },
          {
            optionNumber: 2,
            providerId: hostProviderId,
            sellerId: hostSellerId,
            salesLocationId: hostStandId,
            sellerName: "Venison Valley",
          },
        ],
      });
    });

    it("withdraws the hosted provider from a MENU NUMBER the seller revoked the right for", async () => {
      // The opt-in is the ONLY thing standing between this phone and this listing: Kelsey holds
      // a live authorization for her own seller at this exact stand throughout, so nothing else
      // in the query can refuse her. Withdrawing the grant between issuing the menu and
      // answering it is the case where the opt-in is the sole arbiter.
      await sql()`
        update stand_providers set host_may_update_stock = true where id = ${guestProviderId}
      `;
      await resolveFarmerTarget(database(), {
        senderHash: hostSenderHash,
        occurredAt: now,
        purpose: "update",
        forceMenu: true,
      });
      await sql()`
        update stand_providers set host_may_update_stock = false where id = ${guestProviderId}
      `;

      const selected = await selectFarmerTarget(database(), {
        senderHash: hostSenderHash,
        optionNumber: 1,
        occurredAt: new Date(now.getTime() + 60_000),
      });
      expect(selected).toEqual({ status: "not_authorized" });
      expect(await sql()`
        select selected_provider_id from farmer_target_contexts
        where sender_hash = ${hostSenderHash}
      `).toEqual([{ selected_provider_id: null }]);
    });
  });

  describe("a provider that is not live is not a target", () => {
    it("drops a pending relationship from the seller's own targets", async () => {
      // Zoe's phone and authorization are untouched and her relationship is the only one she
      // has, so the lifecycle state is the sole thing that can refuse.
      await sql()`
        update stand_providers
        set lifecycle_state = 'pending', accepted_at = null,
            approval_source = null, approved_at = null
        where id = ${guestProviderId}
      `;
      await expect(
        resolveFarmerTarget(database(), {
          senderHash: guestSenderHash,
          occurredAt: now,
          purpose: "update",
        }),
      ).resolves.toEqual({ status: "not_authorized" });
    });

    it("keeps a PAUSED relationship targetable so re-opening can be offered", async () => {
      // §facts and authority: a paused provider is offered re-opening, never refused. A target
      // list that dropped it would answer "you cannot do that" to a seller whose listing is
      // hers to have back.
      await sql()`
        update stand_providers set lifecycle_state = 'paused' where id = ${guestProviderId}
      `;
      await expect(
        resolveFarmerTarget(database(), {
          senderHash: guestSenderHash,
          occurredAt: now,
          purpose: "update",
        }),
      ).resolves.toMatchObject({
        status: "selected",
        target: { providerId: guestProviderId, paused: true },
      });
    });

    it("drops an ENDED relationship even while the lifecycle state still reads active", async () => {
      // `ended_at` and `lifecycle_state` are two columns, and the authority seam refuses on
      // either. A target list reading only the state would keep an ended relationship live.
      await sql()`
        update stand_providers set ended_at = ${now} where id = ${guestProviderId}
      `;
      await expect(
        resolveFarmerTarget(database(), {
          senderHash: guestSenderHash,
          occurredAt: now,
          purpose: "update",
        }),
      ).resolves.toEqual({ status: "not_authorized" });
      await sql()`update stand_providers set ended_at = null where id = ${guestProviderId}`;
    });
  });

  describe("the stand's own listing is named by SELF-POINTER, never by a name match", () => {
    /*
      §suppression follows a pointer, and this is the pair of cases that separates the two
      rules. A name match and the self-pointer agree on every ordinary stand, so a suite built
      only from ordinary stands cannot tell them apart — a deliberate swap to
      `lower(seller.name) = lower(location.name)` passed the whole file untouched until these
      two existed.

      They fail in OPPOSITE directions, which is why both are here: a name match would start
      crediting a farmer on her own stand the moment she renamed her seller, and would erase a
      genuine hosted seller whose name happens to match the venue's.
    */
    it("keeps a farmer unlabeled on her own stand after she renames her seller", async () => {
      await sql()`update sellers set name = 'Kelseys Meats' where id = ${hostSellerId}`;
      const result = await resolveFarmerTarget(database(), {
        senderHash: hostSenderHash,
        occurredAt: now,
        purpose: "update",
      });
      expect(result).toMatchObject({
        status: "selected",
        // The seller's name no longer resembles the stand's, and she is STILL the stand's own.
        target: { sellerName: "Kelseys Meats", describesOwnStand: true },
      });
      await sql()`update sellers set name = 'Venison Valley' where id = ${hostSellerId}`;
    });

    it("still credits a hosted seller whose name matches the stand's", async () => {
      // The other direction. Gracie renames to the stand's exact name; she is a hosted seller
      // and must stay credited, or her goods would render as the stand's own on the card.
      await sql()`
        update sellers set name = 'Venison Valley Stand' where id = ${guestSellerId}
      `;
      const result = await resolveFarmerTarget(database(), {
        senderHash: guestSenderHash,
        occurredAt: now,
        purpose: "update",
      });
      expect(result).toMatchObject({
        status: "selected",
        target: { sellerName: "Venison Valley Stand", describesOwnStand: false },
      });
      await sql()`update sellers set name = 'Gracies Greens' where id = ${guestSellerId}`;
    });
  });

  describe("the menu and the writer answer the same question", () => {
    /*
      The two directions of one rule. `lockLiveTargets` asks *which providers may this phone
      reach*; `resolveProviderWriteAuthority` asks *may this phone write this provider*. They are
      written separately on purpose — the writer must additionally report which arm said yes and
      under which authorization — so their agreement is a TESTED invariant rather than a shared
      line of SQL, and this is that test.

      A disagreement is not a cosmetic bug: a menu offering a listing the writer then refuses is
      a farmer told to choose and then told no, and a menu omitting one the writer would accept
      is a farmer who cannot reach her own goods.
    */
    const everyPhoneAndProvider = (): { label: string; sender: () => string;
      provider: () => string }[] => [
      { label: "seller at her host's stand", sender: () => guestSenderHash,
        provider: () => guestProviderId },
      { label: "seller at another seller's listing", sender: () => guestSenderHash,
        provider: () => hostProviderId },
      { label: "host at her own listing", sender: () => hostSenderHash,
        provider: () => hostProviderId },
      { label: "host at a hosted listing", sender: () => hostSenderHash,
        provider: () => guestProviderId },
      { label: "venue manager at the venue's listing", sender: () => venueSenderHash,
        provider: () => venueProviderId },
      { label: "venue manager at another stand's listing", sender: () => venueSenderHash,
        provider: () => hostProviderId },
      { label: "host at the venue's listing", sender: () => hostSenderHash,
        provider: () => venueProviderId },
    ];

    for (const grant of [false, true]) {
      it(`agrees on every phone and listing with the opt-in ${grant ? "on" : "off"}`, async () => {
        // Swept with the grant BOTH ways, because the arm it controls is the only one where the
        // two queries could plausibly diverge: with it off, four of the seven pairs are
        // refusals, and a reader that ignored the column would look correct on the other three.
        await sql()`
          update stand_providers set host_may_update_stock = ${grant}
          where id in (${guestProviderId}, ${venueProviderId})
        `;
        for (const pair of everyPhoneAndProvider()) {
          const writer = await resolveProviderWriteAuthority(database(), {
            providerId: pair.provider(),
            senderHash: pair.sender(),
          });
          const reachable = await resolveFarmerTarget(database(), {
            senderHash: pair.sender(),
            occurredAt: now,
            purpose: "update",
            forceMenu: true,
          });
          const offered =
            reachable.status === "menu"
              ? reachable.options.some((option) => option.providerId === pair.provider())
              : reachable.status === "selected" &&
                reachable.target.providerId === pair.provider();
          expect(
            { pair: pair.label, grant, offered },
            `${pair.label} (grant ${grant})`,
          ).toEqual({ pair: pair.label, grant, offered: writer.status === "authorized" });
        }
      });
    }
  });

  describe("VIGA's door resolves a stand to ONE listing, or refuses", () => {
    /*
      F-114 C.3. The operator's Farms roster shows one row per STAND and a link opens one
      LISTING, so the `(authorization, stand)` pair an operator gives has to become a provider
      before anything can be issued. `resolveAdministratorLinkTarget` refuses on zero AND on
      more than one, rather than picking — a stand where the chosen farmer holds two listings is
      a real ambiguity, and resolving it silently hands out a link to the wrong seller's goods
      with nothing on screen to say so.

      The ambiguous case needs the opt-in ON, because that is the only way one authorization
      reaches two listings at one stand. Without it the pair resolves to exactly one and the
      refusal has nothing to refuse — which is how a "pick the first" sabotage survived the
      whole 854-test db suite before this existed.
    */
    it("resolves the one listing an authorization holds at that stand", async () => {
      const resolved = await resolveAdministratorLinkTarget(database(), {
        authorizationId: guestAuthorizationId,
        salesLocationId: hostStandId,
      });
      expect(resolved).toEqual({
        providerId: guestProviderId,
        sellerId: guestSellerId,
      });
    });

    it("refuses when the pair names no listing at all", async () => {
      await expect(
        resolveAdministratorLinkTarget(database(), {
          authorizationId: guestAuthorizationId,
          salesLocationId: venueStandId,
        }),
      ).resolves.toBeNull();
    });

    it("refuses rather than picking when the pair names TWO", async () => {
      // Kelsey's own listing plus Gracie's, both reachable by her one authorization once the
      // grant is on. The count is the only thing that can refuse here.
      await sql()`
        update stand_providers set host_may_update_stock = true where id = ${guestProviderId}
      `;
      const authorizations = await sql()`
        select auth.id from farmer_authorizations as auth
        join contacts on contacts.id = auth.contact_id
        where contacts.phone_hash = ${hostSenderHash} and auth.revoked_at is null
      `;
      await expect(
        resolveAdministratorLinkTarget(database(), {
          authorizationId: authorizations[0]?.id as string,
          salesLocationId: hostStandId,
        }),
      ).resolves.toBeNull();
    });
  });

  describe("the settings door resolves the same provider the menu does", () => {
    it("selects a hosted provider by its own id", async () => {
      const selected = await selectFarmerTargetForAuthorization(database(), {
        senderHash: guestSenderHash,
        authorizationId: guestAuthorizationId,
        providerId: guestProviderId,
        occurredAt: now,
      });
      expect(selected).toMatchObject({
        status: "selected",
        target: { providerId: guestProviderId, salesLocationId: hostStandId },
      });
    });

    it("refuses a provider this authorization cannot write", async () => {
      // Zoe's authorization, Kelsey's listing. The pair is the only thing wrong: both rows are
      // live and both belong to the same stand.
      await expect(
        selectFarmerTargetForAuthorization(database(), {
          senderHash: guestSenderHash,
          authorizationId: guestAuthorizationId,
          providerId: hostProviderId,
          occurredAt: now,
        }),
      ).resolves.toEqual({ status: "not_authorized" });
    });
  });
});
