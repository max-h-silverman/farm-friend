import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { createDb, type Db, type Sql } from "./index";
import { setInventoryPromptPreference } from "./scheduled-prompts";

/*
  F-114 Phase C.4 — WHOSE REMINDER SCHEDULE THIS IS.

  ## The gate this closes

  `setInventoryPromptPreference` said "the stand's own listing" three separate times: it locked
  `sales_locations` by id, checked the caller against `own_seller_id`, and called
  `readNativeProviderId` to decide which provider the preference names. Each of those is the same
  wrong sentence C.3 removed from targeting — *a farmer may schedule the stands they own* — and it
  makes a hosted seller's cadence unwritable at a stand she does not own, while letting a host's
  phone silently overwrite the ONE cadence row the stand had.

  §facts and authority: **reminder cadence is per provider, not per stand.** A hosted seller
  restocking weekly at a stand whose owner restocks daily needs her own, and the recipient differs
  BY CONSTRUCTION — the whole point of hosting is that the seller, not the host, confirms the
  seller's goods.

  ## The fixture, and why it is shaped this way

  Every case below needs TWO LISTINGS AT ONE STAND ON DIFFERENT CADENCES, which no suite in the
  repo had. That absence is exactly what made the old behavior unfalsifiable: with one listing per
  stand, "the stand's cadence" and "this listing's cadence" name the same row, so every guard that
  distinguishes them is satisfied by either answer. C.2 and C.3 each closed escapes of precisely
  this shape.

  So: Kelsey's stand, with Kelsey's own listing and Zoe's hosted one. Different cadences, different
  designated recipients, one `sales_location_id`.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-114 C.4 per-provider reminder cadence (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  /** Kelsey: the stand's own seller, reached through the self-pointer. */
  let hostStandId = "";
  let hostSellerId = "";
  let hostProviderId = "";
  let hostAuthorizationId = "";
  let hostSenderHash = "";

  /** Zoe: hosted at Kelsey's stand, with no stand of her own. */
  let guestSellerId = "";
  let guestProviderId = "";
  let guestAuthorizationId = "";
  let guestSenderHash = "";

  /** A venue, to prove a stand with no seller of its own still schedules its nested sellers. */
  let venueStandId = "";
  let venueProviderId = "";
  let venueAuthorizationId = "";
  let venueSenderHash = "";
  let venueSellerId = "";

  const now = new Date("2026-08-16T18:00:00.000Z");
  const clock = new FixedClock(now);
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
    if (id === undefined) throw new Error(`no provider for ${sellerId} at ${salesLocationId}`);
    return id;
  };

  const mkProvider = async (input: {
    salesLocationId: string;
    sellerId: string;
    hostMayUpdateStock?: boolean;
  }): Promise<string> => {
    const rows = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${input.salesLocationId}, ${input.sellerId}, 'active',
        ${input.hostMayUpdateStock ?? false}, ${now}, ${now}, 'viga', ${now}
      ) returning id
    `;
    return rows[0]?.id as string;
  };

  const cadenceRows = async (): Promise<Record<string, unknown>[]> =>
    (await sql()`
      select provider_id, sales_location_id, owner_seller_id, designated_authorization_id,
             cadence, version
      from inventory_prompt_preferences
      order by cadence
    `) as unknown as Record<string, unknown>[];

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_c4cadence_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
      values ('Kelseys Farm'), ('Gracies Greens'), ('Cascade Bakery')
      returning id, name
    `;
    hostSellerId = sellers.find((row) => row.name === "Kelseys Farm")?.id as string;
    guestSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;
    venueSellerId = sellers.find((row) => row.name === "Cascade Bakery")?.id as string;

    const mkStand = async (name: string, owner: string | null): Promise<string> => {
      const rows = await sql()`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
          public_address, public_latitude, public_longitude
        ) values (
          ${owner}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable', 'produce',
          true, ${`${name} Road, Vashon WA`}, 47.4473, -122.4590
        ) returning id
      `;
      return rows[0]?.id as string;
    };

    hostStandId = await mkStand("Kelseys Stand", hostSellerId);
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

    ({ authorizationId: hostAuthorizationId, senderHash: hostSenderHash } =
      await mkContactAuthorization({ phone: "+12065552000", sellerId: hostSellerId }));
    ({ authorizationId: guestAuthorizationId, senderHash: guestSenderHash } =
      await mkContactAuthorization({ phone: "+12065552001", sellerId: guestSellerId }));
    ({ authorizationId: venueAuthorizationId, senderHash: venueSenderHash } =
      await mkContactAuthorization({
        phone: "+12065552002",
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
    await sql()`truncate inventory_prompt_preferences, sender_states restart identity cascade`;
    await sql()`
      update stand_providers set host_may_update_stock = false
      where id in (${guestProviderId}, ${venueProviderId})
    `;
  });

  describe("two listings at one stand hold two cadences", () => {
    it("keeps each seller's schedule and recipient separate under ONE sales_location_id", async () => {
      // The case the old shape could not survive. Both writes name the same stand; only the
      // provider tells them apart. Under `readNativeProviderId` the second would have collided
      // with the first on `inventory_prompt_preferences_provider_unique` — both resolving to
      // Kelsey's listing — and Zoe's chosen schedule would have silently replaced Kelsey's.
      const host = await setInventoryPromptPreference(database(), {
        senderHash: hostSenderHash,
        authorizationId: hostAuthorizationId,
        providerId: hostProviderId,
        cadence: "every_2_days",
        clock,
      });
      const guest = await setInventoryPromptPreference(database(), {
        senderHash: guestSenderHash,
        authorizationId: guestAuthorizationId,
        providerId: guestProviderId,
        cadence: "weekly",
        clock,
      });
      expect(host.status).toBe("saved");
      expect(guest.status).toBe("saved");

      const rows = await cadenceRows();
      expect(rows).toHaveLength(2);
      expect(rows).toMatchObject([
        {
          provider_id: hostProviderId,
          sales_location_id: hostStandId,
          owner_seller_id: hostSellerId,
          designated_authorization_id: hostAuthorizationId,
          cadence: "every_2_days",
          version: 1,
        },
        {
          provider_id: guestProviderId,
          sales_location_id: hostStandId,
          owner_seller_id: guestSellerId,
          designated_authorization_id: guestAuthorizationId,
          cadence: "weekly",
          version: 1,
        },
      ]);
    });

    it("files the cadence under the SELLER whose goods it is, never the stand's owner", async () => {
      // `owner_seller_id` is the column that says whose reminder this is, and it is the one a
      // stand-rooted writer gets wrong in the direction nothing else would notice: the row would
      // still be per-provider and still unique, but it would name Kelsey on Zoe's schedule and
      // the composite key to `farmer_authorizations` would then bind Zoe's reminder to Kelsey's
      // authorization.
      await setInventoryPromptPreference(database(), {
        senderHash: guestSenderHash,
        authorizationId: guestAuthorizationId,
        providerId: guestProviderId,
        cadence: "every_2_weeks",
        clock,
      });
      const rows = await cadenceRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.owner_seller_id).toBe(guestSellerId);
      expect(rows[0]?.owner_seller_id).not.toBe(hostSellerId);
    });

    it("re-saving one listing advances only its own version", async () => {
      for (const cadence of ["weekly", "every_2_days"] as const) {
        await setInventoryPromptPreference(database(), {
          senderHash: hostSenderHash,
          authorizationId: hostAuthorizationId,
          providerId: hostProviderId,
          cadence,
          clock,
        });
      }
      await setInventoryPromptPreference(database(), {
        senderHash: guestSenderHash,
        authorizationId: guestAuthorizationId,
        providerId: guestProviderId,
        cadence: "weekly",
        clock,
      });

      const rows = await sql()`
        select provider_id, cadence, version from inventory_prompt_preferences
        order by version desc
      `;
      expect(rows).toMatchObject([
        { provider_id: hostProviderId, cadence: "every_2_days", version: 2 },
        { provider_id: guestProviderId, cadence: "weekly", version: 1 },
      ]);
    });
  });

  describe("who may set a listing's schedule", () => {
    it("refuses the host's phone on a hosted listing without the seller's opt-in", async () => {
      // Kelsey owns the roof, not Zoe's schedule. §facts and authority: stand owners may update a
      // hosted seller's CURRENT STOCK as a physical observation and nothing else — a reminder
      // preference is not an observation, and its recipient is the seller by construction.
      const result = await setInventoryPromptPreference(database(), {
        senderHash: hostSenderHash,
        authorizationId: hostAuthorizationId,
        providerId: guestProviderId,
        cadence: "weekly",
        clock,
      });
      expect(result.status).toBe("not_authorized");
      expect(await cadenceRows()).toHaveLength(0);
    });

    it("still refuses the host WITH the stock opt-in granted", async () => {
      // The opt-in is `host_may_update_stock`, and it says stock. This is the case that proves
      // the refusal above is about the KIND of write rather than about Kelsey being unable to
      // reach Zoe's listing at all — with the opt-in on she can write Zoe's stock, and this must
      // still refuse. Without it, granting the opt-in would silently hand over the schedule too.
      await sql()`
        update stand_providers set host_may_update_stock = true where id = ${guestProviderId}
      `;
      const result = await setInventoryPromptPreference(database(), {
        senderHash: hostSenderHash,
        authorizationId: hostAuthorizationId,
        providerId: guestProviderId,
        cadence: "weekly",
        clock,
      });
      expect(result.status).toBe("not_authorized");
      expect(await cadenceRows()).toHaveLength(0);
    });

    it("lets a hosted seller set her own, at a stand she does not own", async () => {
      const result = await setInventoryPromptPreference(database(), {
        senderHash: guestSenderHash,
        authorizationId: guestAuthorizationId,
        providerId: guestProviderId,
        cadence: "weekly",
        clock,
      });
      expect(result.status).toBe("saved");
    });

    it("refuses a venue's stand-armed manager on a nested seller's listing", async () => {
      // Morgan Hill's manager holds a STAND-ARMED authorization and is not Cascade Bakery. The
      // host arm is the same one Kelsey holds above, reached through the stand rather than
      // through a seller — so this is the venue's shape of the same refusal, and the opt-in does
      // not change it. §facts and authority: the cadence addresses the seller, and "other
      // authorized users may still update it manually" — manually, not by owning the schedule.
      await sql()`
        update stand_providers set host_may_update_stock = true where id = ${venueProviderId}
      `;
      const result = await setInventoryPromptPreference(database(), {
        senderHash: venueSenderHash,
        authorizationId: venueAuthorizationId,
        providerId: venueProviderId,
        cadence: "weekly",
        clock,
      });
      expect(result.status).toBe("not_authorized");
      expect(await cadenceRows()).toHaveLength(0);
    });

    it("lets a venue's nested SELLER set her own schedule there", async () => {
      // The other half, and the one that proves the refusal above is about who is asking rather
      // than about a venue being unschedulable. Cascade Bakery has no stand of her own and her
      // host has no seller of its own — before C.4 this resolved authority against
      // `own_seller_id`, which is NULL at a venue, and `auth.seller_id = NULL` is never true, so
      // nothing at Morgan Hill could hold a cadence at all.
      const bakery = await mkContactAuthorization({
        phone: "+12065552003",
        sellerId: venueSellerId,
      });
      const result = await setInventoryPromptPreference(database(), {
        senderHash: bakery.senderHash,
        authorizationId: bakery.authorizationId,
        providerId: venueProviderId,
        cadence: "weekly",
        clock,
      });
      expect(result.status).toBe("saved");
      const rows = await cadenceRows();
      expect(rows[0]?.owner_seller_id).toBe(venueSellerId);
      expect(rows[0]?.sales_location_id).toBe(venueStandId);
      expect(rows[0]?.designated_authorization_id).toBe(bakery.authorizationId);
    });

    it("refuses an authorization that belongs to a DIFFERENT phone", async () => {
      // The authorization id and the sender hash are two separate inputs, so a caller holding one
      // valid id could otherwise present it beside any hash. Both must name the same contact.
      const result = await setInventoryPromptPreference(database(), {
        senderHash: hostSenderHash,
        authorizationId: guestAuthorizationId,
        providerId: guestProviderId,
        cadence: "weekly",
        clock,
      });
      expect(result.status).toBe("not_authorized");
      expect(await cadenceRows()).toHaveLength(0);
    });

    it("refuses this phone's OTHER authorization, the one that did not answer", async () => {
      /*
        The case that isolates the agreement check, and the reason the one above cannot.

        `resolveProviderWriteAuthority` resolves by SENDER HASH, so a mismatched phone is already
        refused by the arms before the ids are ever compared — deleting the comparison changed no
        test result until this case existed. The only shape where the check is the sole thing that
        could refuse is ONE phone holding TWO live authorizations, presenting the one that did not
        answer for this listing.

        Zoe manages the venue as well as selling her own goods: a seller-armed authorization for
        Gracie's Greens, and a stand-armed one at Morgan Hill. Both are hers, both are live, and
        only the first is the authority under which her own listing's schedule may be filed.
        Without the check the write commits under the venue authorization — and
        `inventory_prompt_preferences_authorization_owner_fk` would then bind Zoe's reminder to an
        authorization naming no seller at all.
      */
      const venueSideJob = await sql()`
        insert into farmer_authorizations (
          sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (
          ${venueStandId},
          (select contact_id from farmer_authorizations where id = ${guestAuthorizationId}),
          ${now}, ${now}
        ) returning id
      `;
      const otherAuthorizationId = venueSideJob[0]?.id as string;

      const result = await setInventoryPromptPreference(database(), {
        senderHash: guestSenderHash,
        authorizationId: otherAuthorizationId,
        providerId: guestProviderId,
        cadence: "weekly",
        clock,
      });
      await sql()`delete from farmer_authorizations where id = ${otherAuthorizationId}`;
      expect(result.status).toBe("not_authorized");
      expect(await cadenceRows()).toHaveLength(0);
    });

    it("refuses a revoked authorization", async () => {
      await sql()`
        update farmer_authorizations set revoked_at = ${now} where id = ${guestAuthorizationId}
      `;
      const result = await setInventoryPromptPreference(database(), {
        senderHash: guestSenderHash,
        authorizationId: guestAuthorizationId,
        providerId: guestProviderId,
        cadence: "weekly",
        clock,
      });
      await sql()`
        update farmer_authorizations set revoked_at = null where id = ${guestAuthorizationId}
      `;
      expect(result.status).toBe("not_authorized");
      expect(await cadenceRows()).toHaveLength(0);
    });

    it("refuses an unknown provider rather than creating a schedule for nothing", async () => {
      const result = await setInventoryPromptPreference(database(), {
        senderHash: guestSenderHash,
        authorizationId: guestAuthorizationId,
        providerId: randomUUID(),
        cadence: "weekly",
        clock,
      });
      expect(result.status).toBe("not_authorized");
      expect(await cadenceRows()).toHaveLength(0);
    });

    it("refuses a listing whose relationship has ENDED", async () => {
      // `provider_not_live`, not a refusal about the phone: Zoe's authorization is intact and she
      // is still the seller, but there is no relationship left to schedule against. A cadence
      // written here would text her about goods she no longer sells at that stand.
      // There is no `ended` lifecycle state — the enum is `pending | active | paused`, and
      // ending is `ended_at` on an otherwise live row. `resolveProviderWriteAuthority` reads
      // `ended_at` first for exactly that reason.
      await sql()`update stand_providers set ended_at = ${now} where id = ${guestProviderId}`;
      const result = await setInventoryPromptPreference(database(), {
        senderHash: guestSenderHash,
        authorizationId: guestAuthorizationId,
        providerId: guestProviderId,
        cadence: "weekly",
        clock,
      });
      await sql()`update stand_providers set ended_at = null where id = ${guestProviderId}`;
      expect(result.status).toBe("not_authorized");
      expect(await cadenceRows()).toHaveLength(0);
    });
  });
});
