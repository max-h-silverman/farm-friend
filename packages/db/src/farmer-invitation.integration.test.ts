import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPhone } from "@farm-friend/core";
import {
  authorizeFarmer,
  createDb,
  createFarmerInvitation,
  listOpenFarmerOnboardingRequests,
  loadFarmerInvitation,
  openFarmerOnboardingRequest,
  type Db,
  type Sql,
} from "./index";

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("administrator farmer invitations (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let administratorId = "";
  let farmId = "";
  let otherSellerId = "";

  const now = new Date(Date.now() - 60 * 60 * 1000);
  const sql = () => client as Sql;
  const database = () => db as Db;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_farmer_invites_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
    const sellers = await sql()`
      insert into sellers (name) values ('Invited Farm'), ('Other Farm') returning id, name
    `;
    farmId = sellers.find((farm) => farm.name === "Invited Farm")?.id as string;
    otherSellerId = sellers.find((farm) => farm.name === "Other Farm")?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  it("creates a one-use farm-bound invitation and carries it into the admin queue", async () => {
    const created = await createFarmerInvitation(database(), {
      farmId,
      channel: "email",
      administratorId,
      occurredAt: now,
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;

    const active = await loadFarmerInvitation(database(), created.token, now);
    expect(active).toMatchObject({ status: "active", farmId, farmName: "Invited Farm", channel: "email" });

    const phone = "+12065550123";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    await sql()`insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})`;

    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      invitationToken: created.token,
      occurredAt: new Date(now.getTime() + 1_000),
      publicBaseUrl: "https://farmfriend.test",
    });
    expect(opened.status).toBe("opened");

    const queue = await listOpenFarmerOnboardingRequests(database());
    expect(queue).toEqual([
      expect.objectContaining({
        farmId,
        farmName: "Invited Farm",
      }),
    ]);
    expect(await loadFarmerInvitation(database(), created.token, new Date(now.getTime() + 2_000)))
      .toEqual({ status: "invalid" });
  });

  // F-067 — "New farm — assign later" is replaced by naming the farm at invite time. The
  // invitation is the authorization decision, and a decision that names no farm cannot grant
  // anything: it left the farmer in VIGA's queue, which is the step this work removes. Creating
  // the farm here is what lets a brand-new farmer be set up by their own redemption.
  it("creates the named farm and binds the invitation to it", async () => {
    const created = await createFarmerInvitation(database(), {
      newFarmName: "  Misty Hollow Farm  ",
      channel: "email",
      administratorId,
      occurredAt: new Date(now.getTime() + 30_000),
    });

    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    // Trimmed, because the operator typed it into a text box. The database refuses a blank
    // name outright; a name that is merely padded would otherwise reach the public map with
    // its whitespace intact.
    expect(created.farmName).toBe("Misty Hollow Farm");

    const sellers = await sql()`select id, name from sellers where name = 'Misty Hollow Farm'`;
    expect(sellers.length).toBe(1);

    // Bound, not merely created alongside: the redemption reads `seller_id` from the invitation
    // to decide what to authorize, so an invitation that created a farm without pointing at it
    // would still dead-end in the queue.
    const active = await loadFarmerInvitation(
      database(),
      created.token,
      new Date(now.getTime() + 31_000),
    );
    expect(active).toMatchObject({
      status: "active",
      farmId: sellers[0]?.id as string,
      farmName: "Misty Hollow Farm",
    });
  });

  it("refuses a new farm name that is blank or only whitespace", async () => {
    // The database's own `sellers_name_not_blank` check is the backstop; refusing here means the
    // operator gets an answer instead of a constraint violation, and no invitation is minted
    // pointing at a farm that was never created.
    const created = await createFarmerInvitation(database(), {
      newFarmName: "   ",
      channel: "email",
      administratorId,
      occurredAt: new Date(now.getTime() + 32_000),
    });

    expect(created.status).toBe("invalid_farm_name");
  });

  it("refuses naming a new farm and choosing an existing one at once", async () => {
    // Two different sellers for one invitation is not a preference to resolve — it is an
    // ambiguous instruction, and guessing which the operator meant would bind the farmer to
    // the wrong farm.
    const created = await createFarmerInvitation(database(), {
      farmId,
      newFarmName: "Ambiguous Farm",
      channel: "email",
      administratorId,
      occurredAt: new Date(now.getTime() + 33_000),
    });

    expect(created.status).toBe("invalid_farm_name");
    const sellers = await sql()`select id from sellers where name = 'Ambiguous Farm'`;
    expect(sellers.length).toBe(0);
  });

  it("refuses authorizing an invited request for a different farm", async () => {
    const created = await createFarmerInvitation(database(), {
      farmId,
      channel: "sms",
      administratorId,
      occurredAt: new Date(now.getTime() + 10_000),
    });
    if (created.status !== "created") throw new Error("invitation fixture was not created");

    const phone = "+12065550124";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    await sql()`insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})`;
    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      invitationToken: created.token,
      occurredAt: new Date(now.getTime() + 11_000),
      publicBaseUrl: "https://farmfriend.test",
    });
    if (opened.status !== "opened") throw new Error("request fixture was not opened");

    expect(await authorizeFarmer(database(), {
      farmId: otherSellerId,
      requestId: opened.requestId,
      administratorId,
      occurredAt: new Date(now.getTime() + 12_000),
      publicBaseUrl: "https://farmfriend.test",
    })).toEqual({ status: "farm_mismatch" });
  });

  it("creates an unbound invitation for a new farm and leaves the queue farm blank", async () => {
    const created = await createFarmerInvitation(database(), {
      channel: "sms",
      administratorId,
      occurredAt: new Date(now.getTime() + 20_000),
    });
    expect(created).toMatchObject({
      status: "created",
      farmName: null,
      channel: "sms",
    });
    if (created.status !== "created") return;

    expect(await loadFarmerInvitation(database(), created.token, new Date(now.getTime() + 21_000)))
      .toMatchObject({
        status: "active",
        farmId: null,
        farmName: null,
        channel: "sms",
      });

    const phoneHash = hashPhone("+12065550125", "test-phone-salt");
    await sql()`insert into contacts (phone_e164, phone_hash) values ('+12065550125', ${phoneHash})`;
    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      invitationToken: created.token,
      occurredAt: new Date(now.getTime() + 22_000),
      publicBaseUrl: "https://farmfriend.test",
    });
    expect(opened.status).toBe("opened");

    expect(await listOpenFarmerOnboardingRequests(database())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ farmId: null, farmName: null }),
      ]),
    );
  });

  /*
    Measured in production, 2026-08-19: one row sat in "Waiting for your decision" offering
    "Give access" to Provo Farms for a handset that had held a LIVE authorization for Provo
    Farms since the day before. Nothing was ever going to settle it — the request was opened
    AFTER the authorization, so the settle-on-redemption path had already run and moved on.

    The queue asked the wrong question. `settled_at is null` means "nobody has closed this
    ticket"; what the operator needs is "does this person still need access?" — and a farmer who
    can already publish for the farm they are asking about does not. So the answer comes from
    the authorization, which is the fact that actually decides it.

    Scoped to the SAME farm, not to the handset: a farmer authorized for one farm asking to be
    set up for a second is a real request, and dropping it would strand her.
  */
  it("drops a request from the queue when the asker can already publish for that farm", async () => {
    const phone = "+12065550199";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})
      returning id
    `;
    const contactId = contacts[0]?.id as string;

    // Access FIRST, exactly as production had it: the authorization predates the request, so
    // no later redemption can settle the row.
    await sql()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contactId}, ${new Date(now.getTime() + 31_000)},
        ${new Date(now.getTime() + 31_000)})
    `;

    // The request row as PRODUCTION holds it: open, bound to an invitation naming the farm.
    // Written directly because `openFarmerOnboardingRequest` refuses to bind an invitation for
    // a contact that already has access — which is exactly why this row could only ever be
    // created in the order production created it, and why nothing later settles it.
    const invitationRows = await sql()`
      insert into farmer_invitations (seller_id, token_hash, channel,
        created_by_administrator_id, created_at, expires_at)
      values (${farmId}, ${randomUUID().replaceAll("-", "").repeat(2)}, 'sms', ${administratorId},
        ${new Date(now.getTime() + 32_000)},
        ${new Date(now.getTime() + 32_000 + 7 * 24 * 60 * 60 * 1000)})
      returning id
    `;
    await sql()`
      insert into farmer_onboarding_requests (contact_hash, requested_at, invitation_id)
      values (${phoneHash}, ${new Date(now.getTime() + 32_000)},
        ${invitationRows[0]?.id as string})
    `;

    const queue = await listOpenFarmerOnboardingRequests(database());
    expect(
      queue.some((row) => row.senderMask.endsWith("0199")),
      "a farmer who can already publish for this farm is not waiting on a decision",
    ).toBe(false);
  });

  it("keeps a request from someone authorized for a DIFFERENT farm", async () => {
    // The other half of the rule, and the one that makes the test above falsifiable: a blanket
    // "has any authorization" filter would pass the case above and silently strand a farmer
    // asking to be set up for her second farm.
    const phone = "+12065550200";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})
      returning id
    `;
    const contactId = contacts[0]?.id as string;

    // Authorized for `farmId`, asking about `otherSellerId`.
    await sql()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${farmId}, ${contactId}, ${new Date(now.getTime() + 41_000)},
        ${new Date(now.getTime() + 41_000)})
    `;

    const invitationRows = await sql()`
      insert into farmer_invitations (seller_id, token_hash, channel,
        created_by_administrator_id, created_at, expires_at)
      values (${otherSellerId}, ${randomUUID().replaceAll("-", "").repeat(2)}, 'sms', ${administratorId},
        ${new Date(now.getTime() + 42_000)},
        ${new Date(now.getTime() + 42_000 + 7 * 24 * 60 * 60 * 1000)})
      returning id
    `;
    await sql()`
      insert into farmer_onboarding_requests (contact_hash, requested_at, invitation_id)
      values (${phoneHash}, ${new Date(now.getTime() + 42_000)},
        ${invitationRows[0]?.id as string})
    `;

    const queue = await listOpenFarmerOnboardingRequests(database());
    expect(
      queue.some((row) => row.senderMask.endsWith("0200")),
      "asking about a farm she cannot publish for is a real request",
    ).toBe(true);
  });

  it("keeps a request from someone whose access to that farm was revoked", async () => {
    // A revoked authorization is not access. Reading the row without its `revoked_at` would
    // drop a farmer VIGA had deliberately cut off and who is now asking to be let back in.
    const phone = "+12065550201";
    const phoneHash = hashPhone(phone, "test-phone-salt");
    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})
      returning id
    `;
    const contactId = contacts[0]?.id as string;

    await sql()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at,
        authorized_at, revoked_at)
      values (${farmId}, ${contactId}, ${new Date(now.getTime() + 51_000)},
        ${new Date(now.getTime() + 51_000)}, ${new Date(now.getTime() + 52_000)})
    `;

    const invitationRows = await sql()`
      insert into farmer_invitations (seller_id, token_hash, channel,
        created_by_administrator_id, created_at, expires_at)
      values (${farmId}, ${randomUUID().replaceAll("-", "").repeat(2)}, 'sms', ${administratorId},
        ${new Date(now.getTime() + 53_000)},
        ${new Date(now.getTime() + 53_000 + 7 * 24 * 60 * 60 * 1000)})
      returning id
    `;
    await sql()`
      insert into farmer_onboarding_requests (contact_hash, requested_at, invitation_id)
      values (${phoneHash}, ${new Date(now.getTime() + 53_000)},
        ${invitationRows[0]?.id as string})
    `;

    const queue = await listOpenFarmerOnboardingRequests(database());
    expect(
      queue.some((row) => row.senderMask.endsWith("0201")),
      "a revoked farmer asking again is waiting on a real decision",
    ).toBe(true);
  });
});
