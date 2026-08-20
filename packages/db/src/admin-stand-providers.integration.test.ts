import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listStandProvidersForAdministration } from "./admin";
import type { Db } from "./index";
import type { Sql } from "./sql";

/*
  F-101 — the read behind the admin Stands and Sellers views.

  WHAT THIS EXISTS TO PROVE. The two views each render a pause/resume toggle and a Remove
  control PER ARRANGEMENT, so the read behind them must return the arrangement itself: its
  provider id, which seller, which stand, and what state it is in. The roster's existing
  `participantNames` cannot serve this — those rows come from `sales_location_participants`,
  which are display strings a stand owner typed, carrying no identity and no lifecycle. A
  control rendered against one of those names would have no row to act on.

  The distinction is the whole hazard, so it is asserted directly: a stand carrying BOTH a
  typed participant name and a real hosted seller must return only the latter here.

  `nativeSeller` is the other load-bearing field. The singular case renders as a plain fact
  rather than a list, and on a solo native-seller stand the toggle reads as the stand being
  open or closed — both are decisions the view can only make if it knows which arrangement
  belongs to the stand's own seller.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-101 admin stand providers (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";
  let soloStandId = "";
  let sharedStandId = "";
  let endedStandId = "";
  let hostSellerId = "";
  let guestSellerId = "";

  const handle = (): Db => {
    if (!sql) throw new Error("database not initialized");
    return { sql, orm: undefined as never, close: async () => {} };
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_standproviders_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 5 });

    const db = sql;
    const hosts = await db`insert into sellers (name) values ('Host Farm') returning id`;
    hostSellerId = hosts[0]?.id as string;
    const guests = await db`insert into sellers (name) values ('Guest Farm') returning id`;
    guestSellerId = guests[0]?.id as string;

    const mkStand = async (name: string): Promise<string> => {
      const rows = await db`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
          public_address, public_latitude, public_longitude
        ) values (
          ${hostSellerId}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable',
          'produce', true, ${`${name} Road`}, 47.4473, -122.4590
        ) returning id
      `;
      return rows[0]?.id as string;
    };

    // Only its own seller sells here — the case that must NOT render as a list.
    soloStandId = await mkStand("Solo Stand");

    // A typed participant NAME on the solo stand. It is not an arrangement and must never
    // appear as one: there is no row a control could pause.
    await db`
      insert into sales_location_participants (
        owner_seller_id, sales_location_id, display_name, source, confirmed_at
      ) values (${hostSellerId}, ${soloStandId}, 'Someone The Owner Mentioned', 'viga', now())
    `;

    // A host plus a paused guest — the shape that renders a per-seller list.
    sharedStandId = await mkStand("Shared Stand");
    await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${sharedStandId}, ${guestSellerId}, 'paused', false,
        now() - interval '9 days', now() - interval '9 days', 'viga', now() - interval '9 days'
      )
    `;

    // An ENDED arrangement. The lists are entities and an ended relationship is not one, so
    // it must not come back and leave a dead row wearing live controls.
    endedStandId = await mkStand("Ended Stand");
    await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at, ended_at
      ) values (
        ${endedStandId}, ${guestSellerId}, 'active', false,
        now() - interval '9 days', now() - interval '9 days', 'viga',
        now() - interval '9 days', now() - interval '1 day'
      )
    `;
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("returns the stand's own seller as its single native arrangement", async () => {
    const rows = await listStandProvidersForAdministration(handle());
    const solo = rows.filter((row) => row.salesLocationId === soloStandId);

    expect(solo).toHaveLength(1);
    expect(solo[0]).toMatchObject({
      sellerId: hostSellerId,
      sellerName: "Host Farm",
      standName: "Solo Stand",
      lifecycleState: "active",
      nativeSeller: true,
      ended: false,
    });
    // The identity a control acts on. Without it the toggle has no argument.
    expect(solo[0]?.providerId).toEqual(expect.any(String));
  });

  it("never returns a typed participant name as an arrangement", async () => {
    const rows = await listStandProvidersForAdministration(handle());
    const names = rows.map((row) => row.sellerName);

    // The name is real and sits on the solo stand, but it is a display string with no row.
    expect(names).not.toContain("Someone The Owner Mentioned");
  });

  it("returns a paused guest alongside the host, with the state each control needs", async () => {
    const rows = await listStandProvidersForAdministration(handle());
    const shared = rows.filter((row) => row.salesLocationId === sharedStandId);

    expect(shared).toHaveLength(2);
    expect(shared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sellerId: hostSellerId,
          lifecycleState: "active",
          nativeSeller: true,
        }),
        expect.objectContaining({
          sellerId: guestSellerId,
          sellerName: "Guest Farm",
          lifecycleState: "paused",
          nativeSeller: false,
        }),
      ]),
    );
  });

  it("omits an ended arrangement, leaving only the stand's own seller", async () => {
    const rows = await listStandProvidersForAdministration(handle());
    const ended = rows.filter((row) => row.salesLocationId === endedStandId);

    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ sellerId: hostSellerId, nativeSeller: true });
    expect(ended.map((row) => row.sellerId)).not.toContain(guestSellerId);
  });
});
