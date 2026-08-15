import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPhone } from "@farm-friend/core";
import {
  createFarmerInvitation,
  createDb,
  openFarmerOnboardingRequest,
  recordFarmerInvitationPendingPhone,
  recordFarmerInvitationPendingStock,
  recordFarmerInvitationSmsAgreement,
  type Db,
  type Sql,
} from "./index";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/*
  B-070 — a farm that ALREADY has a current revision must still be able to redeem.

  Production shape (Provo Farms, 2026-08-13): VIGA seeded the stand's offerings as a `viga`
  revision months before the farmer onboarded, so `is_current` was already taken when the
  farmer's `VIGA` text arrived carrying held stock. `publishPendingStockIn` inserted a second
  current revision for the same stand, `inventory_revisions_one_current_per_location` refused
  it, the whole redemption transaction rolled back, and `runInboundPass`'s bare `catch` left
  the inbound event to be retried forever — head-of-line blocking every later message from
  that handset.

  A seeded farm is the COMMON case at launch, not an edge one: every farm VIGA imported from
  the existing map has exactly this shape.
*/
describe("onboarding redemption over an existing current revision (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let administratorId = "";
  let farmId = "";
  let salesLocationId = "";

  const now = new Date(Date.now() - 60 * 60 * 1000);
  const sql = () => client as Sql;
  const database = () => db as Db;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_onboard_supersede_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 3 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${now}) returning id
    `;
    administratorId = administrators[0]?.id as string;

    const farms = await sql()`
      insert into farms (name) values ('Seeded Farm') returning id
    `;
    farmId = farms[0]?.id as string;

    const locations = await sql()`
      insert into sales_locations (
        owner_farm_id, kind, name, public_address, public_latitude, public_longitude,
        season_kind, open_hours_kind, open_days, stocking_cadence, visitability,
        offering_type, timezone, farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', 'Seeded Farm Stand', '1 Vashon Hwy; Vashon, WA 98070',
        47.42, -122.44, 'year_round', 'all_day', '{0,1,2,3,4,5,6}', 'variable',
        'visitable', 'produce', 'America/Los_Angeles', false, false
      )
      returning id
    `;
    salesLocationId = locations[0]?.id as string;

    // The VIGA seed: a current revision that exists BEFORE the farmer ever texts.
    const seeded = await sql()`
      insert into inventory_revisions (
        farm_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
        farm_approval_id, source, published_at
      )
      values (
${farmId}, ${salesLocationId},
(select id from stand_providers
  where sales_location_id = ${salesLocationId} and seller_id is null), null, null, null, 'viga', ${now})
      returning id
    `;
    await sql()`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, sort_order
      )
      values (${seeded[0]?.id as string}, ${salesLocationId}, 'garlic', 0)
    `;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  it("publishes held stock over a seeded revision instead of throwing", async () => {
    const created = await createFarmerInvitation(database(), {
      farmId,
      channel: "sms",
      administratorId,
      occurredAt: now,
    });
    if (created.status !== "created") throw new Error("invitation fixture was not created");

    const phone = "+12065550199";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    await sql()`insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})`;

    await recordFarmerInvitationSmsAgreement(database(), {
      token: created.token,
      occurredAt: new Date(now.getTime() + 1_000),
    });
    await recordFarmerInvitationPendingPhone(database(), {
      token: created.token,
      phoneE164: phone,
      phoneHash,
      occurredAt: new Date(now.getTime() + 2_000),
    });
    await recordFarmerInvitationPendingStock(database(), {
      token: created.token,
      entries: [{ itemName: "tomatoes" }, { itemName: "eggs" }],
      occurredAt: new Date(now.getTime() + 3_000),
    });

    // The farmer's `VIGA`. This is the call that threw in production.
    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      pendingPhoneHash: phoneHash,
      occurredAt: new Date(now.getTime() + 4_000),
      publicBaseUrl: "https://farmfriend.test",
    });

    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") return;
    expect(opened.authorizationId).not.toBeNull();

    // Exactly one current revision, and it is the FARMER's — the seed is superseded, not
    // duplicated. Asserting the item names rather than a count: a passing count would still
    // admit a revision that published the seed's garlic under the farmer's authorization.
    const current = await sql()`
      select revision.id, revision.source, entry.item_name
      from inventory_revisions revision
      join inventory_entries entry on entry.inventory_revision_id = revision.id
      where revision.sales_location_id = ${salesLocationId} and revision.is_current
      order by entry.sort_order asc
    `;
    expect(current.map((row) => row.item_name)).toEqual(["tomatoes", "eggs"]);
    expect(current[0]?.source).toBe("web");

    const superseded = await sql()`
      select source, superseded_at from inventory_revisions
      where sales_location_id = ${salesLocationId} and not is_current
    `;
    expect(superseded.length).toBe(1);
    expect(superseded[0]?.source).toBe("viga");
    expect(superseded[0]?.superseded_at).not.toBeNull();
  });

  /*
    B-070, second defect. Production ordering (Provo Farms): the farmer completed onboarding and
    texted `VIGA` 47 seconds later, and a SECOND onboarding pass created another invitation for
    the same handset 12.5 hours afterwards. `order by created_at desc` then selected the invitation
    that did not exist when the message was sent, and stamping the message time onto it violated
    `farmer_invitations_valid_redemption` (`redeemed_at >= created_at`).

    Asserting WHICH invitation was redeemed, not merely that redemption succeeded: bounding the
    query to invitations that already existed is the whole fix, and a status-only assertion would
    pass just as well against a query that redeemed the wrong one.
  */
  it("redeems the invitation that existed when the message was sent, not a later one", async () => {
    const farms = await sql()`insert into farms (name) values ('Late Invite Farm') returning id`;
    const lateFarmId = farms[0]?.id as string;

    const phone = "+12065550200";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    await sql()`insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})`;

    const textedAt = new Date(now.getTime() + 60_000);

    // The invitation the farmer was actually answering: created just before they texted.
    const answered = await createFarmerInvitation(database(), {
      farmId: lateFarmId,
      channel: "email",
      administratorId,
      occurredAt: new Date(textedAt.getTime() - 45_000),
    });
    if (answered.status !== "created") throw new Error("invitation fixture was not created");
    await recordFarmerInvitationSmsAgreement(database(), {
      token: answered.token,
      occurredAt: new Date(textedAt.getTime() - 44_000),
    });
    await recordFarmerInvitationPendingPhone(database(), {
      token: answered.token,
      phoneE164: phone,
      phoneHash,
      occurredAt: new Date(textedAt.getTime() - 43_000),
    });

    // A second onboarding pass, created AFTER the farmer's text. Their earlier message cannot
    // be a response to this.
    const later = await createFarmerInvitation(database(), {
      farmId: lateFarmId,
      channel: "sms",
      administratorId,
      occurredAt: new Date(textedAt.getTime() + 12 * 60 * 60 * 1000),
    });
    if (later.status !== "created") throw new Error("later invitation fixture was not created");
    await recordFarmerInvitationSmsAgreement(database(), {
      token: later.token,
      occurredAt: new Date(textedAt.getTime() + 12 * 60 * 60 * 1000 + 1_000),
    });
    await recordFarmerInvitationPendingPhone(database(), {
      token: later.token,
      phoneE164: phone,
      phoneHash,
      occurredAt: new Date(textedAt.getTime() + 12 * 60 * 60 * 1000 + 2_000),
    });

    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      pendingPhoneHash: phoneHash,
      occurredAt: textedAt,
      publicBaseUrl: "https://farmfriend.test",
    });

    expect(opened.status).toBe("opened");

    const redeemed = await sql()`
      select channel, created_at, redeemed_at from farmer_invitations
      where pending_phone_hash = ${phoneHash} and redeemed_at is not null
    `;
    expect(redeemed.length).toBe(1);
    // The one that already existed when the message was sent — identified by channel, and by
    // the property the constraint actually enforces.
    expect(redeemed[0]?.channel).toBe("email");
    expect((redeemed[0]?.created_at as Date).getTime()).toBeLessThanOrEqual(textedAt.getTime());
    expect((redeemed[0]?.redeemed_at as Date).getTime()).toBeGreaterThanOrEqual(
      (redeemed[0]?.created_at as Date).getTime(),
    );

    // The later invitation is left redeemable for the farmer's next text rather than consumed
    // by a message that predates it.
    const stillOpen = await sql()`
      select channel from farmer_invitations
      where pending_phone_hash = ${phoneHash} and redeemed_at is null
    `;
    expect(stillOpen.map((row) => row.channel)).toEqual(["sms"]);
  });
});
