import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, issueFarmerLinkToken } from "@farm-friend/core";
import {
  issueFarmerLink,
  readNativeProviderId,
  setProviderParticipation,
  type Db,
  type Sql,
} from "@farm-friend/db";
import {
  handleFarmerParticipationPost,
  handleFarmerSettingsPost,
  loadFarmerSettings,
  saveFarmerDefaultListing,
} from "./farmer-settings";

const T0 = new Date(Date.now() - 60_000);
/**
 * After every fixture row, for the acts that WRITE a timestamp.
 *
 * `stand_providers_ending_coherent` requires `ended_at >= invited_at`, and the fixtures invite
 * at `T0`. Acting at `T0` too would end a relationship at the instant it began — which the
 * schema refuses, correctly.
 */
const T_ACT = new Date(Date.now() + 60_000);

describe("F-051 farmer default stand settings (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_farmer_settings_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: "packages/db/drizzle" });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await client()`truncate contacts, sellers restart identity cascade`;
  });

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  function database(): Db {
    return { sql: client(), orm: {}, close: async () => {} } as unknown as Db;
  }

  async function farmer(senderHash: string, names: string[]) {
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550177', ${senderHash}, ${T0}) returning id
    `;
    const sellers = await client()`insert into sellers (name) values ('Settings Farm') returning id`;
    const farmId = sellers[0]?.id as string;
    const authorizations = await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    const locationIds: string[] = [];
    for (const name of names) {
      const rows = await client()`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        ) values (
          ${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles', 'visitable', 'produce',
          '1 Stand Way', 47.44, -122.46, false, false
        )
        returning id
      `;
      locationIds.push(rows[0]?.id as string);
    }
    const issued = await issueFarmerLink(database(), {
      authorizationId: authorizations[0]?.id as string,
      providerId: await readNativeProviderId(database(), {
        salesLocationId: locationIds[0] as string,
      }),
      occurredAt: T0,
    });
    if (issued.status !== "issued") throw new Error("fixture link was not issued");
    // The stand's own listing at each stand, by SELF-POINTER. The screen speaks in listings
    // now (C.4), so the cases need their ids alongside the stands'.
    const providerIds: string[] = [];
    for (const locationId of locationIds) {
      const rows = await client()`
        select id from stand_providers
        where sales_location_id = ${locationId} and seller_id = ${farmId}
      `;
      providerIds.push(rows[0]?.id as string);
    }
    return {
      authorizationId: authorizations[0]?.id as string,
      farmId,
      locationIds,
      providerIds,
      token: issued.token,
    };
  }

  function request(body: unknown): Request {
    return new Request("https://example.test/api/farmer/participation", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** The row's real state, read back rather than inferred from the handler's own answer. */
  async function lifecycleOf(providerId: string): Promise<{ state: string; ended: boolean }> {
    const rows = await client()`
      select lifecycle_state, ended_at from stand_providers where id = ${providerId}
    `;
    return {
      state: rows[0]?.lifecycle_state as string,
      ended: rows[0]?.ended_at !== null,
    };
  }

  it("loads only the standing link authorization's owned locations and no contact identity", async () => {
    const own = await farmer("a".repeat(64), ["North Stand", "South Stand"]);
    const other = await farmer("b".repeat(64), ["Private Other Stand"]);

    const settings = await loadFarmerSettings(database(), own.token);

    expect(settings).toEqual({
      status: "active",
      listings: [
        {
          providerId: own.providerIds[0],
          salesLocationId: own.locationIds[0],
          locationName: "North Stand",
          sellerName: "Settings Farm",
          describesOwnStand: true,
          mayPause: true,
          selected: false,
          cadence: null,
        },
        {
          providerId: own.providerIds[1],
          salesLocationId: own.locationIds[1],
          locationName: "South Stand",
          sellerName: "Settings Farm",
          describesOwnStand: true,
          mayPause: true,
          selected: false,
          cadence: null,
        },
      ],
    });
    const serialized = JSON.stringify(settings);
    expect(serialized).not.toContain(other.locationIds[0] as string);
    expect(serialized).not.toContain("Private Other Stand");
    expect(serialized).not.toContain("a".repeat(64));
    expect(serialized).not.toMatch(/\+1\d{10}/);
  });

  it("shows a hosted listing as its OWN row, credited to its seller", async () => {
    /*
      F-114 C.4, inverting C.3's deliberate placeholder.

      C.3 kept the stand's own listing and DROPPED the hosted one, because this screen showed
      stands and a stand rendered twice under one name is two radios that read identically and
      save different things. The row is a LISTING now, so both belong — and the seller name is
      what tells them apart.

      Credited by SELF-POINTER, never a name match: the row carries `describesOwnStand`, the
      pointer itself, and `creditSeller` decides from it on every surface (F-115 Tranche C).
      The reader states the fact; nothing downstream re-derives it from a name or a null.
    */
    const own = await farmer("e".repeat(64), ["North Stand"]);
    const guests = await client()`
      insert into sellers (name) values ('Fernhorn Bakery') returning id
    `;
    const hosted = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${own.locationIds[0] as string}, ${guests[0]?.id as string}, 'active', true,
        ${T0}, ${T0}, 'viga', ${T0}
      ) returning id
    `;

    const settings = await loadFarmerSettings(database(), own.token);
    expect(settings).toEqual({
      status: "active",
      listings: expect.arrayContaining([
        {
          providerId: own.providerIds[0],
          salesLocationId: own.locationIds[0],
          locationName: "North Stand",
          sellerName: "Settings Farm",
          describesOwnStand: true,
          mayPause: true,
          selected: false,
          cadence: null,
        },
        {
          providerId: hosted[0]?.id as string,
          salesLocationId: own.locationIds[0],
          locationName: "North Stand",
          sellerName: "Fernhorn Bakery",
          describesOwnStand: false,
          mayPause: false,
          selected: false,
          cadence: null,
        },
      ]),
    });
    if (settings.status !== "active") throw new Error("expected active settings");
    expect(settings.listings).toHaveLength(2);
    // Asserted as an absence too: a reader that credited EVERY seller would satisfy the
    // positive assertion above while labelling the farmer's own stand with her own name, which
    // is the `Provo Farms — Provo Farms` §suppression follows a pointer forbids.
    expect(
      settings.listings.filter((listing) => listing.describesOwnStand),
    ).toHaveLength(1);
  });

  it("refuses a farmer whose only listing is at somebody else's stand", async () => {
    // A hosted-only seller like Zoe has no stand of her own, and before C.4 this screen
    // refused her outright — her only listing was filtered away and the empty result read as
    // "not authorized". She holds a real link to a real listing now.
    const host = await farmer("g".repeat(64), ["Host Stand"]);
    const guests = await client()`
      insert into sellers (name) values ('Gracies Greens') returning id
    `;
    const guestSellerId = guests[0]?.id as string;
    const hosted = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${host.locationIds[0] as string}, ${guestSellerId}, 'active', false,
        ${T0}, ${T0}, 'viga', ${T0}
      ) returning id
    `;
    const guestHash = "h".repeat(64);
    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash) values ('+12065559099', ${guestHash})
      returning id
    `;
    const guestAuth = await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${guestSellerId}, ${contacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    const issued = await issueFarmerLink(database(), {
      authorizationId: guestAuth[0]?.id as string,
      providerId: hosted[0]?.id as string,
      occurredAt: T0,
    });
    if (issued.status !== "issued") throw new Error("guest link was not issued");

    const settings = await loadFarmerSettings(database(), issued.token);
    expect(settings).toEqual({
      status: "active",
      listings: [
        {
          providerId: hosted[0]?.id as string,
          salesLocationId: host.locationIds[0],
          locationName: "Host Stand",
          sellerName: "Gracies Greens",
          describesOwnStand: false,
          // NOT her stand, but her GOODS — she is the seller, so pause is hers. The two fields
          // answer different questions and this row is where they diverge: a screen deriving
          // the control from `describesOwnStand` would refuse a hosted seller her own pause.
          mayPause: true,
          selected: false,
          cadence: null,
        },
      ],
    });
  });

  it("says which ARM reaches each listing, so the screen never offers a refused control", async () => {
    /*
      F-101 — the seller half. `setProviderParticipation` refuses a host who asks to pause, and
      the acceptance criterion is that the UI never offers the control it would be refused for.
      A screen cannot honour that without knowing WHICH arm reached each listing, so the reader
      states it.

      The case that matters is a host holding `host_may_update_stock`: that opt-in is what
      reaches a hosted listing at all, so the host's row is present and looks in every other
      respect like the seller's. `mayPause` is the only thing that separates them, and it must
      be false — a host may end and may NEVER pause, with or without that opt-in.

      Asserted from the HOST's token, not the guest's, so a reader that returned the guest's
      arm for every row would fail here rather than pass by coincidence.
    */
    const host = await farmer("i".repeat(64), ["Shared Stand"]);
    const guests = await client()`
      insert into sellers (name) values ('Fernhorn Bakery') returning id
    `;
    const hosted = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${host.locationIds[0] as string}, ${guests[0]?.id as string}, 'active', true,
        ${T0}, ${T0}, 'viga', ${T0}
      ) returning id
    `;

    const settings = await loadFarmerSettings(database(), host.token);
    if (settings.status !== "active") throw new Error("expected active settings");
    const byProvider = new Map(
      settings.listings.map((listing) => [listing.providerId, listing]),
    );

    // Her own listing: she IS the seller, so all three transitions are hers.
    expect(byProvider.get(host.providerIds[0] as string)?.mayPause).toBe(true);
    // The bakery's listing at her stand: she is the HOST. End only.
    expect(byProvider.get(hosted[0]?.id as string)?.mayPause).toBe(false);
  });

  it("refuses a host pause with and without the stock opt-in, from the same screen", async () => {
    /*
      The arm is a PRESENTATION fact; the refusal is the seam's. Both are asserted because a
      screen that hid the control while the seam allowed the write would be a UI-only guarantee,
      which Golden Rule #3 forbids — and a seam that refused while the screen offered the button
      is the `not_authorized` the criterion names.

      Run BOTH ways on `host_may_update_stock` (F-115's own requirement): the flag governs stock
      and must never widen participation. Without it the host does not reach the listing at all,
      so the row is absent AND the write is refused.
    */
    const host = await farmer("j".repeat(64), ["Opt-in Stand"]);
    const guests = await client()`
      insert into sellers (name) values ('Gracies Greens') returning id
    `;

    for (const optIn of [true, false]) {
      const hosted = await client()`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
          invited_at, accepted_at, approval_source, approved_at
        ) values (
          ${host.locationIds[0] as string}, ${guests[0]?.id as string}, 'active', ${optIn},
          ${T0}, ${T0}, 'viga', ${T0}
        ) returning id
      `;
      const providerId = hosted[0]?.id as string;

      const settings = await loadFarmerSettings(database(), host.token);
      if (settings.status !== "active") throw new Error("expected active settings");
      const row = settings.listings.find((listing) => listing.providerId === providerId);
      // Present only when the opt-in reaches it; never pausable either way.
      expect(row?.mayPause ?? false).toBe(false);

      const refused = await setProviderParticipation(database(), {
        providerId,
        transition: "pause",
        senderHash: "j".repeat(64),
        occurredAt: new Date(),
      });
      expect(refused.status).toBe("not_authorized");

      await client()`delete from stand_providers where id = ${providerId}`;
    }
  });

  it("pauses, resumes and ends the seller's OWN listing through the seam", async () => {
    /*
      F-101 — the seller half's write path. The farmer's token replaces the admin session; the
      seam is the same one `/api/admin/participation` calls, and it stays the only writer.

      All three transitions in one case because the acceptance criterion is all three, and
      because resume has to be reachable FROM paused — a handler that wrote `active`
      unconditionally would pass a pause-only test.
    */
    const own = await farmer("k".repeat(64), ["Own Stand"]);
    const providerId = own.providerIds[0] as string;

    const paused = await handleFarmerParticipationPost(
      { db: database(), clock: new FixedClock(T_ACT) },
      request({ token: own.token, providerId, transition: "pause" }),
    );
    expect(paused.status).toBe(200);
    expect(await lifecycleOf(providerId)).toEqual({ state: "paused", ended: false });

    const resumed = await handleFarmerParticipationPost(
      { db: database(), clock: new FixedClock(T_ACT) },
      request({ token: own.token, providerId, transition: "resume" }),
    );
    expect(resumed.status).toBe(200);
    expect(await lifecycleOf(providerId)).toEqual({ state: "active", ended: false });

    const ended = await handleFarmerParticipationPost(
      { db: database(), clock: new FixedClock(T_ACT) },
      request({ token: own.token, providerId, transition: "end" }),
    );
    expect(ended.status).toBe(200);
    expect((await lifecycleOf(providerId)).ended).toBe(true);
  });

  it("refuses a host's pause at the write path and lets the same host END", async () => {
    /*
      THE CONTRACT'S CORE PROTECTION, asserted at the surface a farmer can actually reach.

      The seam's own suite proves the rule; this proves the ROUTE inherits it rather than
      resolving authority for itself. Both halves matter: a route that refused everything would
      pass the pause assertion and fail the end one, which is why `end` is asserted here too.
    */
    const host = await farmer("l".repeat(64), ["Host Stand"]);
    const guests = await client()`
      insert into sellers (name) values ('Fernhorn Bakery') returning id
    `;
    const hosted = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${host.locationIds[0] as string}, ${guests[0]?.id as string}, 'active', true,
        ${T0}, ${T0}, 'viga', ${T0}
      ) returning id
    `;
    const providerId = hosted[0]?.id as string;

    const refused = await handleFarmerParticipationPost(
      { db: database(), clock: new FixedClock(T_ACT) },
      request({ token: host.token, providerId, transition: "pause" }),
    );
    expect(refused.status).toBe(403);
    expect(await lifecycleOf(providerId)).toEqual({ state: "active", ended: false });

    const ended = await handleFarmerParticipationPost(
      { db: database(), clock: new FixedClock(T_ACT) },
      request({ token: host.token, providerId, transition: "end" }),
    );
    expect(ended.status).toBe(200);
    expect((await lifecycleOf(providerId)).ended).toBe(true);
  });

  it("refuses a listing outside the token's authority, and a fabricated token", async () => {
    // The token is the whole credential here, so the two ways to misuse it are asserted
    // together: a real token pointed at somebody else's listing, and no real token at all.
    const own = await farmer("m".repeat(64), ["Mine"]);
    const stranger = await farmer("n".repeat(64), ["Theirs"]);
    const strangerProvider = stranger.providerIds[0] as string;

    const crossed = await handleFarmerParticipationPost(
      { db: database(), clock: new FixedClock(T_ACT) },
      request({ token: own.token, providerId: strangerProvider, transition: "end" }),
    );
    expect(crossed.status).toBe(403);
    expect((await lifecycleOf(strangerProvider)).ended).toBe(false);

    const forged = await handleFarmerParticipationPost(
      { db: database(), clock: new FixedClock(T_ACT) },
      request({ token: "0".repeat(64), providerId: own.providerIds[0] as string, transition: "end" }),
    );
    expect(forged.status).toBe(403);
    expect((await lifecycleOf(own.providerIds[0] as string)).ended).toBe(false);
  });

  it("saves and returns one revalidated exact default without changing STOP consent", async () => {
    const senderHash = "c".repeat(64);
    const own = await farmer(senderHash, ["North Stand", "South Stand"]);
    await client()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      )
      values (${senderHash}, 'stopped', 'start', ${T0}, 'settings-consent', ${T0})
    `;

    const saved = await saveFarmerDefaultListing(
      { db: database(), clock: new FixedClock(new Date(T0.getTime() + 1_000)) },
      { token: own.token, providerId: own.providerIds[1] as string },
    );

    expect(saved).toEqual({
      status: "saved",
      providerId: own.providerIds[1],
      salesLocationId: own.locationIds[1],
      locationName: "South Stand",
    });
    expect(await loadFarmerSettings(database(), own.token)).toMatchObject({
      status: "active",
      listings: [
        { providerId: own.providerIds[0], selected: false },
        { providerId: own.providerIds[1], selected: true },
      ],
    });
    expect(await client()`select state from sms_consents where recipient_hash = ${senderHash}`)
      .toEqual([{ state: "stopped" }]);
  });

  it("refuses a listing outside the link authorization and a revoked or fabricated token", async () => {
    const own = await farmer("d".repeat(64), ["Own Stand"]);
    const other = await farmer("e".repeat(64), ["Other Stand"]);

    await expect(saveFarmerDefaultListing(
      { db: database(), clock: new FixedClock(T0) },
      { token: own.token, providerId: other.providerIds[0] as string },
    )).resolves.toEqual({ status: "not_authorized" });
    expect(await client()`select * from farmer_target_contexts`).toHaveLength(0);

    await client()`
      update farmer_links set revoked_at = ${new Date(T0.getTime() + 1_000)}
      where authorization_id = ${own.authorizationId}
    `;
    await expect(loadFarmerSettings(database(), own.token)).resolves.toEqual({
      status: "not_authorized",
    });
    await expect(loadFarmerSettings(database(), issueFarmerLinkToken())).resolves.toEqual({
      status: "not_authorized",
    });
  });

  it("accepts only a structured token and LISTING id at the settings API boundary", async () => {
    const own = await farmer("f".repeat(64), ["North Stand", "South Stand"]);
    const deps = { db: database(), clock: new FixedClock(T0) };

    const malformed = await handleFarmerSettingsPost(
      deps,
      new Request("https://farmfriend.example/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: own.token }),
      }),
    );
    expect(malformed.status).toBe(400);

    const saved = await handleFarmerSettingsPost(
      deps,
      new Request("https://farmfriend.example/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: own.token,
          providerId: own.providerIds[1],
        }),
      }),
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({
      status: "saved",
      providerId: own.providerIds[1],
      salesLocationId: own.locationIds[1],
      locationName: "South Stand",
    });

    // A STAND id is now a malformed body, not a quieter way to say the same thing. Asserted
    // because the two are both UUIDs: without this the route would happily take either and the
    // seam would refuse the stand id for an unrelated reason one layer down.
    const standShaped = await handleFarmerSettingsPost(
      deps,
      new Request("https://farmfriend.example/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: own.token,
          salesLocationId: own.locationIds[1],
        }),
      }),
    );
    expect(standShaped.status).toBe(400);
  });

  it("saves one explicit cadence for the chosen LISTING without changing STOP consent", async () => {
    const senderHash = "1".repeat(64);
    const own = await farmer(senderHash, ["Cadence Stand"]);
    await client()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      ) values (${senderHash}, 'stopped', 'start', ${T0}, 'cadence-stopped', ${T0})
    `;
    const response = await handleFarmerSettingsPost(
      { db: database(), clock: new FixedClock(T0) },
      new Request("https://farmfriend.example/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: own.token,
          providerId: own.providerIds[0]!,
          cadence: "weekly",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await client()`
      select designated_authorization_id, cadence, version, next_due_at
      from inventory_prompt_preferences where provider_id = ${own.providerIds[0]!}
    `).toEqual([expect.objectContaining({
      designated_authorization_id: own.authorizationId,
      cadence: "weekly",
      version: 1,
      next_due_at: expect.any(Date),
    })]);
    expect(await client()`select state from sms_consents where recipient_hash = ${senderHash}`)
      .toEqual([{ state: "stopped" }]);
  });
});
