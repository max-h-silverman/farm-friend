import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  saveOnboardingListing,
  selfSelectHostStand,
  setProviderParticipation,
} from "./index";
import type { Db } from "./index";
import type { Sql } from "./sql";

/*
  F-117 — A SELLER ARRIVING ON HER OWN SAYS SHE SELLS AT SOMEONE ELSE'S STAND.

  ## The gap

  Onboarding asked *"Do you have a farm stand people can visit?"* and offered two answers: yes,
  or "I deliver, or coordinate with people". A farmer who sells **at someone else's stand** could
  say neither honestly — she either claimed a stand that is not hers or picked "no stand" and
  vanished from the map. F-114 covered the seller a host INVITED; nobody covered the seller who
  arrives by herself.

  ## What is settled (max, 2026-08-17)

  - **No VIGA approval anywhere in this flow.** Keeping the volunteer out of it is the point.
  - **She goes live immediately.** max weighed listing an unconfirmed seller against making her
    wait on a host who may never reply, and chose live: *"i really don't imagine any fraud
    here."* The realistic error is a mis-picked stand, and the host confirmation catches that.
  - **The host is asked and may deny.** A `NO` ends the arrangement through
    `setProviderParticipation` — the same seam and the same authority rule as every other
    ending, and a host ENDING is exactly what F-116 already permits.

  ## `approval_source = 'seller'`

  A third source, added by `0052` (max, 2026-08-17). The two that existed could not tell the
  truth about this row: `viga` would make a self-selected seller indistinguishable from one VIGA
  actually approved — in a flow whose whole premise is that VIGA never saw her — and `host`
  requires a vouching authorization that does not exist until the host answers, which is after
  she is already live.

  So the record says plainly who put her there: she did. That is also what makes the row
  findable later, which is the difference between "we know nobody vouched" and "we cannot tell".
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-117 a seller self-selects a host stand (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let hostSellerId = "";
  let hostStandId = "";
  let guestSellerId = "";
  let guestSenderHash = "";

  const T0 = new Date("2026-06-01T17:00:00.000Z");
  const T1 = new Date("2026-06-02T17:00:00.000Z");

  const handle = (): Db => {
    if (!sql) throw new Error("database not initialized");
    return { sql, orm: undefined as never, close: async () => {} };
  };
  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_selfselect_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 5 });
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await client()`truncate contacts, sellers, sales_locations restart identity cascade`;

    const hosts = await client()`insert into sellers (name) values ('Kelseys Farm') returning id`;
    hostSellerId = hosts[0]?.id as string;
    const stands = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Kelseys Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        '1 Kelsey Road', 47.4473, -122.4590
      ) returning id
    `;
    hostStandId = stands[0]?.id as string;

    const guests = await client()`insert into sellers (name) values ('Gracies Greens') returning id`;
    guestSellerId = guests[0]?.id as string;
    guestSenderHash = `h${randomUUID().replaceAll("-", "")}`;
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550188', ${guestSenderHash}, ${T0}) returning id
    `;
    await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${guestSellerId}, ${contacts[0]?.id as string}, ${T0}, ${T0})
    `;
  });

  async function readProvider(providerId: string): Promise<Record<string, unknown>> {
    const rows = await client()`
      select lifecycle_state, approval_source, approved_by_authorization_id,
             accepted_at, approved_at, ended_at
      from stand_providers where id = ${providerId}
    `;
    return rows[0] as Record<string, unknown>;
  }

  it("lists her immediately, recording that SHE put herself there", async () => {
    const result = await selfSelectHostStand(handle(), {
      sellerId: guestSellerId,
      salesLocationId: hostStandId,
      occurredAt: T0,
    });
    expect(result.status).toBe("selling");
    if (result.status !== "selling") throw new Error("expected selling");

    const provider = await readProvider(result.providerId);
    // LIVE, not pending: max chose listing her over making her wait on a host who may never
    // reply. `active` is what every liveness predicate admits.
    expect(provider.lifecycle_state).toBe("active");
    expect(provider.ended_at).toBeNull();
    // The honest record. Not `viga` — VIGA never saw her — and not `host`, which would claim a
    // vouching authorization that does not exist.
    expect(provider.approval_source).toBe("seller");
    expect(provider.approved_by_authorization_id).toBeNull();

    // No VIGA approval anywhere in this flow: nothing wrote a seller approval for her.
    const approvals = await client()`
      select id from seller_approvals where seller_id = ${guestSellerId}
    `;
    expect(approvals).toHaveLength(0);
  });

  it("uses the SAME stand_providers shape F-114 built, not a second mechanism", async () => {
    /*
      The acceptance criterion states it directly. A self-selected seller that lived in its own
      table would need every liveness predicate, every targeting arm and every participation
      control taught about it — and each one taught separately is one that gets forgotten.

      Proved by acting on the row through the ordinary participation seam: if it were a second
      mechanism, `setProviderParticipation` would not find it.
    */
    const result = await selfSelectHostStand(handle(), {
      sellerId: guestSellerId,
      salesLocationId: hostStandId,
      occurredAt: T0,
    });
    if (result.status !== "selling") throw new Error("expected selling");

    const paused = await setProviderParticipation(handle(), {
      providerId: result.providerId,
      transition: "pause",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });
    expect(paused.status).toBe("changed");
    expect((await readProvider(result.providerId)).lifecycle_state).toBe("paused");
  });

  it("is idempotent, and refuses a stand that is already hers", async () => {
    // A double-tapped submit must not list her twice; the partial unique index is the arbiter.
    const first = await selfSelectHostStand(handle(), {
      sellerId: guestSellerId,
      salesLocationId: hostStandId,
      occurredAt: T0,
    });
    const second = await selfSelectHostStand(handle(), {
      sellerId: guestSellerId,
      salesLocationId: hostStandId,
      occurredAt: T0,
    });
    expect(first.status).toBe("selling");
    expect(second.status).toBe("already_selling_here");
    const rows = await client()`
      select id from stand_providers
      where sales_location_id = ${hostStandId} and seller_id = ${guestSellerId}
    `;
    expect(rows).toHaveLength(1);

    // Her OWN stand is not a host stand. Saying "I sell at someone else's stand" and picking
    // your own is a mis-pick, and the arrangement it would create is the native one that
    // already exists.
    const ownStand = await selfSelectHostStand(handle(), {
      sellerId: hostSellerId,
      salesLocationId: hostStandId,
      occurredAt: T0,
    });
    expect(ownStand.status).toBe("own_stand");
  });

  it("is written by ONBOARDING itself, in the transaction that creates her own stand", async () => {
    /*
      THE SIMPLE PATH, and a correction to this item's first reading.

      I had assumed the arrangement could not be written at form time — that it needed holding
      on the invitation until `START`, like `pendingStock` and `pendingPromptCadence` do. That
      is wrong, and the difference matters: those two wait because they need an AUTHORIZATION
      (a dated confirmation needs somebody to stand behind it; a reminder preference needs a
      recipient). `stand_providers` needs only a `seller_id`, and the seller already exists when
      the form is submitted — the invitation names her farm, and onboarding writes her own
      stand's provider row in this very transaction.

      So no migration, no pending column, and no change to the redemption path. She is listed at
      the host stand the moment she submits, which is also what max asked for: live immediately.
    */
    const result = await saveOnboardingListing(handle(), {
      farmId: guestSellerId,
      standName: "Gracies Greens Stand",
      listing: {
        visitability: "contact_only",
        offeringType: "produce",
        publicAddress: null,
        addressPublic: true,
        pricesPublic: false,
        latitude: null,
        longitude: null,
        hoursText: null,
        paymentMethods: [],
        items: [],
      },
      hostStandId: hostStandId,
      occurredAt: T0,
    });
    expect(result.status).toBe("saved");

    const hosted = await client()`
      select id, lifecycle_state, approval_source from stand_providers
      where sales_location_id = ${hostStandId} and seller_id = ${guestSellerId}
    `;
    expect(hosted).toHaveLength(1);
    expect(hosted[0]?.lifecycle_state).toBe("active");
    expect(hosted[0]?.approval_source).toBe("seller");

    // Her OWN stand still exists beside it — the two arrangements are independent facts, which
    // is the whole reason this is not a third `visitability` value.
    if (result.status !== "saved") throw new Error("expected saved");
    const own = await client()`
      select id from stand_providers
      where sales_location_id = ${result.salesLocationId} and seller_id = ${guestSellerId}
    `;
    expect(own).toHaveLength(1);
  });

  it("saves the listing even when the host stand is bad, rather than losing her whole form", async () => {
    /*
      The arrangement is a SECONDARY fact. A farmer who picked a stand that was retired between
      loading the form and submitting it must still get her own listing — losing an entire
      onboarding form over the optional half of one question is a far worse failure than a
      missing arrangement she can add later from her settings screen.
    */
    const result = await saveOnboardingListing(handle(), {
      farmId: guestSellerId,
      standName: "Gracies Greens Stand",
      listing: {
        visitability: "contact_only",
        offeringType: "produce",
        publicAddress: null,
        addressPublic: true,
        pricesPublic: false,
        latitude: null,
        longitude: null,
        hoursText: null,
        paymentMethods: [],
        items: [],
      },
      hostStandId: randomUUID(),
      occurredAt: T0,
    });
    expect(result.status).toBe("saved");
    // Nothing dangling was written for the stand that does not exist.
    expect(await client()`
      select id from stand_providers where seller_id = ${guestSellerId}
    `).toHaveLength(1);
  });

  it("refuses an unknown seller or stand rather than writing a dangling row", async () => {
    expect(
      (await selfSelectHostStand(handle(), {
        sellerId: randomUUID(),
        salesLocationId: hostStandId,
        occurredAt: T0,
      })).status,
    ).toBe("unknown_seller");

    expect(
      (await selfSelectHostStand(handle(), {
        sellerId: guestSellerId,
        salesLocationId: randomUUID(),
        occurredAt: T0,
      })).status,
    ).toBe("unknown_stand");

    expect(await client()`select id from stand_providers`).toHaveLength(1);
  });
});
