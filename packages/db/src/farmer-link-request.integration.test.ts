import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hashFarmerInviteToken,
  hashFarmerLinkToken,
  hashPhone,
} from "@farm-friend/core";
import {
  createDb,
  createFarmerInvitation,
  openFarmerOnboardingRequest,
  requestFarmerStandLink,
  revokeFarmerAuthorization,
  type Db,
  type Sql,
} from "./index";

// F-073 — an already-onboarded farmer asks for their own update link from the web.
//
// They arrive at the public picker, select a farm that already has a farmer, and enter the
// number they onboarded with. If it matches, Farm Friend texts them their stand link.
//
// **The match is a HASH comparison and the link goes out by SMS, and both are the point.** The
// number is never read back and never returned to the browser — the caller learns nothing about
// whether it matched, because the ANSWER travels to the handset instead of to the screen. That
// is what stops this page being a way to ask "is 206-555-0143 a farmer?" about any number on
// the island.
//
// So the result type here deliberately does NOT distinguish a match from a miss. This file
// proves the effects differ (a text is queued, or nothing is) while the answer does not.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("farmer stand-link request (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let administratorId = "";

  // Clock-derived, never a date literal (B-003 tripwire).
  const now = new Date(Date.now() - 60 * 60 * 1000);
  const later = (ms: number) => new Date(now.getTime() + ms);
  const sql = () => client as Sql;
  const database = () => db as Db;
  const SALT = "test-salt";

  async function farm(name: string): Promise<string> {
    const rows = await sql()`insert into farms (name) values (${name}) returning id`;
    return rows[0]?.id as string;
  }

  /** Give the farm a stand, since a link is issued against a sales location. */
  async function stand(farmId: string, name: string): Promise<string> {
    const rows = await sql()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type, is_public,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles', 'contact_only', 'produce',
        true, false, false
      )
      returning id
    `;
    return rows[0]?.id as string;
  }

  /** Onboard a farmer through the real self-serve chain, as in F-072's tests. */
  async function onboardFarmer(farmId: string, phone: string): Promise<void> {
    const invitation = await createFarmerInvitation(database(), {
      farmId,
      channel: "sms",
      administratorId,
      occurredAt: now,
    });
    if (invitation.status !== "created") throw new Error(invitation.status);
    const contactHash = hashPhone(phone, SALT);
    await sql()`
      insert into contacts (phone_e164, phone_hash) values (${phone}, ${contactHash})
      on conflict (phone_hash) do nothing
    `;
    await sql()`
      update farmer_invitations set agreed_to_sms_at = ${later(1000).toISOString()}
      where token_hash = ${hashFarmerInviteToken(invitation.token)}
    `;
    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash,
      occurredAt: later(2000),
      invitationToken: invitation.token,
      publicBaseUrl: "https://farmfriend.test",
    });
    if (opened.status !== "opened" || opened.authorizationId === null) {
      throw new Error("fixture did not authorize; the self-serve chain changed");
    }
  }

  /**
   * The LINK messages queued for a recipient, which is how a sent link is observed.
   *
   * Scoped to this feature's own logical key on purpose: onboarding a farmer queues its own
   * "your farm is ready" text, so counting every message for the number would assert against
   * the fixture rather than against what this function did.
   */
  async function queuedFor(phone: string): Promise<Array<Record<string, unknown>>> {
    return sql()`
      select logical_key, message_category, body from outbox_work
      where recipient_hash = ${hashPhone(phone, SALT)}
        and logical_key like 'farmer-web-link-%'
    ` as unknown as Promise<Array<Record<string, unknown>>>;
  }

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_link_request_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
    db = createDb(url.toString());
    const admins = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${now.toISOString()}) returning id
    `;
    administratorId = admins[0]?.id as string;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    await client?.end();
    if (adminClient) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end();
    }
  });

  it("queues a stand link for a farmer whose phone matches the farm", async () => {
    const phone = "+12065551201";
    const farmId = await farm("Link Farm");
    await stand(farmId, "Link Farm Stand");
    await onboardFarmer(farmId, phone);

    const result = await requestFarmerStandLink(database(), {
      farmId,
      contactHash: hashPhone(phone, SALT),
      occurredAt: later(20_000),
      publicBaseUrl: "https://farmfriend.example",
    });

    expect(result).toEqual({ status: "accepted" });
    const queued = await queuedFor(phone);
    expect(queued).toHaveLength(1);
    // A private credential, so it rides the same category the SMS LINK flow uses.
    expect(queued[0]?.message_category).toBe("inventory_prompt");
    // The message actually CARRIES the link. Asserted against the token that was issued, so a
    // body that dropped the URL or carried the wrong one fails here rather than passing as
    // "a message was queued".
    const links = await sql()`
      select farmer_link.token_hash from farmer_links as farmer_link
      join farmer_authorizations as auth on auth.id = farmer_link.authorization_id
      where auth.farm_id = ${farmId} and farmer_link.revoked_at is null
    `;
    expect(links).toHaveLength(1);
    const body = queued[0]?.body as string;
    const url = body.match(/https:\/\/farmfriend\.example\/stand\/([0-9a-f]+)/);
    expect(url).not.toBeNull();
    expect(hashFarmerLinkToken(url?.[1] as string)).toBe(links[0]?.token_hash);
    // And never the raw number.
    expect(body).not.toContain(phone);
  });

  it("issues a REAL link that resolves to the farmer's stand", async () => {
    const phone = "+12065551202";
    const farmId = await farm("Resolvable Link Farm");
    const salesLocationId = await stand(farmId, "Resolvable Stand");
    await onboardFarmer(farmId, phone);

    await requestFarmerStandLink(database(), {
      farmId,
      contactHash: hashPhone(phone, SALT),
      occurredAt: later(20_000),
      publicBaseUrl: "https://farmfriend.example",
    });

    // Verified by EFFECT: a live link row exists for this stand, rather than trusting that the
    // call reported success.
    const links = await sql()`
      select farmer_link.sales_location_id
      from farmer_links as farmer_link
      join farmer_authorizations as auth on auth.id = farmer_link.authorization_id
      where auth.farm_id = ${farmId} and farmer_link.revoked_at is null
    `;
    expect(links).toHaveLength(1);
    expect(links[0]?.sales_location_id).toBe(salesLocationId);
  });

  it("queues NOTHING for a number that is not a farmer on that farm", async () => {
    const farmerPhone = "+12065551203";
    const strangerPhone = "+12065551204";
    const farmId = await farm("Guarded Link Farm");
    await stand(farmId, "Guarded Stand");
    await onboardFarmer(farmId, farmerPhone);
    await sql()`
      insert into contacts (phone_e164, phone_hash)
      values (${strangerPhone}, ${hashPhone(strangerPhone, SALT)})
      on conflict (phone_hash) do nothing
    `;

    const result = await requestFarmerStandLink(database(), {
      farmId,
      contactHash: hashPhone(strangerPhone, SALT),
      occurredAt: later(20_000),
      publicBaseUrl: "https://farmfriend.example",
    });

    // THE SAME ANSWER as a match. The difference is the effect, never the response — this is
    // what stops the endpoint being an oracle for which numbers are farmers.
    expect(result).toEqual({ status: "accepted" });
    expect(await queuedFor(strangerPhone)).toHaveLength(0);
  });

  it("queues nothing for a farmer of a DIFFERENT farm", async () => {
    const phone = "+12065551205";
    const theirFarm = await farm("Their Own Farm");
    const otherFarm = await farm("Someone Elses Farm");
    await stand(theirFarm, "Their Stand");
    await stand(otherFarm, "Other Stand");
    await onboardFarmer(theirFarm, phone);

    // A real farmer, but not of this farm. Being a farmer somewhere must not open every farm.
    const result = await requestFarmerStandLink(database(), {
      farmId: otherFarm,
      contactHash: hashPhone(phone, SALT),
      occurredAt: later(20_000),
      publicBaseUrl: "https://farmfriend.example",
    });

    expect(result).toEqual({ status: "accepted" });
    expect(await queuedFor(phone)).toHaveLength(0);
  });

  it("queues nothing once the farmer's authorization is revoked", async () => {
    const phone = "+12065551206";
    const farmId = await farm("Revoked Link Farm");
    await stand(farmId, "Revoked Stand");
    await onboardFarmer(farmId, phone);

    const authorizations = await sql()`
      select id from farmer_authorizations where farm_id = ${farmId} and revoked_at is null
    `;
    await revokeFarmerAuthorization(database(), {
      authorizationId: authorizations[0]?.id as string,
      administratorId,
      occurredAt: later(10_000),
    });

    const result = await requestFarmerStandLink(database(), {
      farmId,
      contactHash: hashPhone(phone, SALT),
      occurredAt: later(20_000),
      publicBaseUrl: "https://farmfriend.example",
    });

    expect(result).toEqual({ status: "accepted" });
    expect(await queuedFor(phone)).toHaveLength(0);
  });

  it("queues nothing for an unknown farm", async () => {
    const phone = "+12065551207";
    await sql()`
      insert into contacts (phone_e164, phone_hash)
      values (${phone}, ${hashPhone(phone, SALT)})
      on conflict (phone_hash) do nothing
    `;

    const result = await requestFarmerStandLink(database(), {
      farmId: randomUUID(),
      contactHash: hashPhone(phone, SALT),
      occurredAt: later(20_000),
      publicBaseUrl: "https://farmfriend.example",
    });

    expect(result).toEqual({ status: "accepted" });
    expect(await queuedFor(phone)).toHaveLength(0);
  });

  it("never returns the link, the token, or the phone number", async () => {
    const phone = "+12065551208";
    const farmId = await farm("Silent Link Farm");
    await stand(farmId, "Silent Stand");
    await onboardFarmer(farmId, phone);

    const result = await requestFarmerStandLink(database(), {
      farmId,
      contactHash: hashPhone(phone, SALT),
      occurredAt: later(20_000),
      publicBaseUrl: "https://farmfriend.example",
    });

    // The whole result, not a spot check: the link reaches the handset and nowhere else.
    expect(Object.keys(result)).toEqual(["status"]);
    expect(JSON.stringify(result)).not.toContain(phone);
  });
});
