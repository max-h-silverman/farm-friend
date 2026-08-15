import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPhone } from "@farm-friend/core";
import {
  createDb,
  inviteSellerToStand,
  openFarmerOnboardingRequest,
  recordFarmerInvitationPendingPhone,
  recordFarmerInvitationSmsAgreement,
  type Db,
  type Sql,
} from "./index";

/*
  F-114 Phase C.1 (invitation) — THE INVITED SELLER FINISHING, AND GOING LIVE.

  This is the far half of `hosting.integration.test.ts`. Kelsey has forwarded a link; Zoe opens it,
  fills the same onboarding form a stand owner fills, and texts a bare `START`. That one message
  must do everything at once, or none of it:

    - establish her consent,
    - authorize her for Gracie's Greens,
    - approve that seller so it may publish,
    - and ACTIVATE the pending relationship at Kelsey's stand.

  **All four commit together.** The invitation is spent by the redemption, so a crash between any
  two of them would leave Zoe holding a link that can never be redeemed again, in a state nothing
  reports — the exact silent dead end F-067 closed for the ordinary farmer, reintroduced one step
  later. That is why acceptance lives inside the redemption transaction rather than in a writer
  beside it.

  ## What acceptance records, and what it must not

  `approval_source` comes from WHO ISSUED the invitation, and nowhere else:

    - Kelsey issued it → `host`, naming her authorization. §hosting and approval lifecycle: an
      already approved stand owner may vouch, producing a visible-but-revocable state.
    - VIGA issued it  → `viga`, naming nobody. VIGA's own approval names no farmer.

  **`host_may_update_stock` stays off.** An invitation that silently conferred stock rights would
  make acceptance mean more than it says — §hosting and approval lifecycle forbids exactly that:
  *acceptance never grants more access than the explicit scopes attached to the relationship.* Zoe
  specifically does not want Kelsey stating her stock; a baker who drops off at dawn might. It is
  the seller's later choice, never a consequence of saying yes.

  **Nothing routes through the host and the host is not notified.** VIGA's ask was *"we want Zoe to
  be able to give her inventory without telling Kelsey"*, and that is satisfied structurally: Zoe
  is authorized in her own right, on her own phone, against her own provider row.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

/** A fixture salt. The hash is the only lookup key (Golden Rule #5); its value is arbitrary. */
const SALT = "hosting-acceptance-fixture-salt";

describe("hosted-seller acceptance through onboarding (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let administratorId = "";
  let hostSellerId = "";
  let hostStandId = "";
  let hostAuthorizationId = "";

  const now = new Date("2026-08-15T18:00:00.000Z");
  const later = new Date(now.getTime() + 60 * 60 * 1000);
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  /** A distinct handset per case, so no two redemptions contend for one invitation. */
  let phoneSeed = 2000;
  const nextPhone = (): string => `+120655${String(phoneSeed++).padStart(5, "0")}`;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_hostaccept_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
      insert into sellers (name) values ('Venison Valley') returning id
    `;
    hostSellerId = sellers[0]?.id as string;

    const stands = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Venison Valley Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        'Venison Valley Road, Vashon WA', 47.4473, -122.4590
      ) returning id
    `;
    hostStandId = stands[0]?.id as string;

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

    // `seller_approvals` for the host, so the vouch is a claim an APPROVED owner makes.
    await sql()`
      insert into seller_approvals (seller_id, administrator_id, approved_at)
      values (${hostSellerId}, ${administratorId}, ${now})
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

  /**
   * The invited seller's whole journey up to the moment before `START`: they open the link, tick
   * the SMS agreement, and state the handset the setup message must arrive from. Exactly the
   * calls the onboarding form already makes for a stand owner — which is the point.
   */
  const onboardTo = async (
    invite: { token: string; sellerId: string; standProviderId: string },
  ): Promise<{ phoneE164: string; phoneHash: string }> => {
    const phoneE164 = nextPhone();
    const agreed = await recordFarmerInvitationSmsAgreement(database(), {
      token: invite.token,
      occurredAt: now,
    });
    expect(agreed.status).toBe("agreed");
    const recorded = await recordFarmerInvitationPendingPhone(database(), {
      token: invite.token,
      phoneE164,
      phoneHash: hashPhone(phoneE164, SALT),
      occurredAt: now,
    });
    expect(recorded.status).toBe("recorded");
    return { phoneE164, phoneHash: hashPhone(phoneE164, SALT) };
  };

  /** The bare `START` from the invited seller's own handset. */
  const textStart = async (phoneE164: string): Promise<unknown> => {
    const phoneHash = hashPhone(phoneE164, SALT);
    // The webhook writes the contact at ingress before routing, so the redemption always finds
    // one. Written here for the same reason, rather than left to the writer to invent.
    await sql()`
      insert into contacts (phone_e164, phone_hash)
      values (${phoneE164}, ${phoneHash})
      on conflict (phone_hash) do nothing
    `;
    return openFarmerOnboardingRequest(database(), {
      contactHash: phoneHash,
      occurredAt: later,
      pendingPhoneHash: phoneHash,
      publicBaseUrl: "https://farmfriend.vigavashon.org",
    });
  };

  const providerRow = async (
    standProviderId: string,
  ): Promise<Record<string, unknown>> => {
    const rows = await sql()`
      select * from stand_providers where id = ${standProviderId}
    `;
    return rows[0] as Record<string, unknown>;
  };

  const invited = async (
    name: string,
    issuer: "host" | "viga",
  ): Promise<{ token: string; sellerId: string; standProviderId: string }> => {
    const result = await inviteSellerToStand(database(), {
      salesLocationId: hostStandId,
      newSellerName: name,
      ...(issuer === "host"
        ? { invitedByAuthorizationId: hostAuthorizationId }
        : { administratorId }),
      occurredAt: now,
    });
    if (result.status !== "invited") throw new Error(`invite failed: ${result.status}`);
    return {
      token: result.token,
      sellerId: result.sellerId,
      standProviderId: result.standProviderId,
    };
  };

  describe("the stand owner's vouch", () => {
    it("goes live on the invited seller's own START, with no VIGA step", async () => {
      // The Venison Valley case, completed. Zoe texts one word and is selling at Kelsey's stand.
      const invite = await invited("Gracies Greens", "host");
      const before = await providerRow(invite.standProviderId);
      expect(before.lifecycle_state).toBe("pending");

      const { phoneE164 } = await onboardTo(invite);
      const redeemed = await textStart(phoneE164);
      expect(redeemed).toMatchObject({ status: "opened" });

      const after = await providerRow(invite.standProviderId);
      expect(after).toMatchObject({
        lifecycle_state: "active",
        approval_source: "host",
        approved_by_authorization_id: hostAuthorizationId,
      });
      expect(after.accepted_at).not.toBeNull();
      expect(after.approved_at).not.toBeNull();
    });

    it("authorizes the invited seller for their OWN seller, not the host's", async () => {
      // "Without telling Kelsey", structurally. Zoe's authorization names Gracie's Greens; it
      // says nothing about Venison Valley, so her updates cannot reach Kelsey's goods and
      // Kelsey's cannot reach hers.
      const invite = await invited("Separate Greens", "host");
      const { phoneE164, phoneHash } = await onboardTo(invite);
      await textStart(phoneE164);

      const rows = await sql()`
        select a.seller_id, a.sales_location_id
        from farmer_authorizations a
        join contacts c on c.id = a.contact_id
        where c.phone_hash = ${phoneHash} and a.revoked_at is null
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        seller_id: invite.sellerId,
        sales_location_id: null,
      });
    });

    it("leaves the host stock right OFF", async () => {
      // Acceptance never grants more access than the explicit scopes attached to the
      // relationship. Zoe said yes to selling there, not to Kelsey stating her stock.
      const invite = await invited("Unshared Greens", "host");
      const { phoneE164 } = await onboardTo(invite);
      await textStart(phoneE164);
      expect(await providerRow(invite.standProviderId)).toMatchObject({
        host_may_update_stock: false,
      });
    });

    it("approves the seller so it may actually publish", async () => {
      // Authorization and approval are two independent gates, and granting only the first leaves
      // the farmer authorized, told they are set up, and refused on their very first update.
      const invite = await invited("Publishable Greens", "host");
      const { phoneE164 } = await onboardTo(invite);
      await textStart(phoneE164);
      const rows = await sql()`
        select count(*)::int as total from seller_approvals
        where seller_id = ${invite.sellerId} and revoked_at is null
      `;
      expect(rows[0]?.total).toBe(1);
    });

    it("does not notify the host", async () => {
      // §customer behavior: the host communicates with their sellers directly. A queued message
      // to Kelsey would also be the one thing VIGA explicitly asked against.
      const invite = await invited("Quiet Greens", "host");
      const { phoneE164 } = await onboardTo(invite);
      await textStart(phoneE164);
      const rows = await sql()`
        select count(*)::int as total from outbox_work o
        join contacts c on c.phone_hash = o.recipient_hash
        join farmer_authorizations a on a.contact_id = c.id
        where a.id = ${hostAuthorizationId}
      `;
      expect(rows[0]?.total).toBe(0);
    });
  });

  describe("VIGA's door", () => {
    it("records VIGA as the approver and names no farmer", async () => {
      const invite = await invited("Coordinator Greens", "viga");
      const { phoneE164 } = await onboardTo(invite);
      await textStart(phoneE164);
      expect(await providerRow(invite.standProviderId)).toMatchObject({
        lifecycle_state: "active",
        approval_source: "viga",
        approved_by_authorization_id: null,
      });
    });
  });

  describe("what acceptance refuses to do", () => {
    it("leaves the relationship pending when the seller never ticked the agreement", async () => {
      // No tick means no informed opt-in, and the ordinary redemption already refuses to
      // authorize on that basis. Activating the relationship anyway would publish a seller who
      // agreed to nothing — acceptance must be as gated as the authorization it rides on.
      const invite = await invited("Unagreed Greens", "host");
      const phoneE164 = nextPhone();
      const recorded = await recordFarmerInvitationPendingPhone(database(), {
        token: invite.token,
        phoneE164,
        phoneHash: hashPhone(phoneE164, SALT),
        occurredAt: now,
      });
      expect(recorded.status).toBe("recorded");
      await textStart(phoneE164);

      expect(await providerRow(invite.standProviderId)).toMatchObject({
        lifecycle_state: "pending",
      });
    });

    it("leaves an ordinary farmer's onboarding untouched", async () => {
      // The regression that matters most: this tranche threads a new step through the redemption
      // every farmer uses. A stand owner's own onboarding must behave exactly as it did, and an
      // invitation with no relationship bound must activate nothing.
      const created = await sql()`
        insert into sellers (name) values ('Ordinary Farm') returning id
      `;
      const sellerId = created[0]?.id as string;
      const token = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
      await sql()`
        insert into farmer_invitations (
          seller_id, token_hash, channel, created_by_administrator_id, created_at, expires_at
        ) values (
          ${sellerId}, ${createHash("sha256").update(token).digest("hex")}, 'sms',
          ${administratorId}, ${now}, ${new Date(now.getTime() + 86_400_000)}
        )
      `;
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: now });
      const phoneE164 = nextPhone();
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164,
        phoneHash: hashPhone(phoneE164, SALT),
        occurredAt: now,
      });
      const result = await textStart(phoneE164);
      expect(result).toMatchObject({ status: "opened" });

      const authorizations = await sql()`
        select count(*)::int as total from farmer_authorizations
        where seller_id = ${sellerId} and revoked_at is null
      `;
      expect(authorizations[0]?.total).toBe(1);
    });
  });
});
