import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFarmerInviteToken } from "@farm-friend/core";
import {
  applyConsentTransition,
  authorizeDispatch,
  authorizeFarmer,
  createDb,
  createFarmerInvitation,
  openFarmerOnboardingRequest,
  recordFarmerInvitationSmsAgreement,
  type Db,
  type Sql,
} from "./index";

// Web onboarding establishes SMS consent — the launch blocker this suite exists to pin.
//
// Before this, the standard invited path dead-ended in silence: a farmer completed
// onboarding, VIGA approved, and `FARMER_AUTHORIZED_NOTIFICATION` — a proactive
// `inventory_prompt` — was correctly SUPPRESSED at the dispatch claim because SIGNUP
// established no consent. The farmer was authorized, never told, and had no reason to
// believe the system worked. Nothing in the invitation, the page, or the reply asked them
// to text JOIN; the word appeared only in code comments.
//
// The fix is not a new consent writer. The farmer ticks an agreement on the invitation
// page (that stamps `agreed_to_sms_at`), and the INBOUND `SIGNUP <token>` from their phone
// is the evidence that turns it into consent — a tick on a web page proves nothing about
// who holds the handset. `openFarmerOnboardingRequest` applies the transition through the
// SAME `applyConsentTransition` rules JOIN uses, inside the redemption transaction.
//
// Every assertion below lands on the DISPATCH CLAIM, not on the queue, for the reason
// `farmer-authorization.integration.test.ts` already states: queuing is unconditional by
// design, so a test that checked "we queued it" would prove nothing about what is sent.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("web onboarding establishes SMS consent (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let administratorId = "";

  // Fixture instants are OFFSETS from a clock-derived anchor, never calendar literals
  // (B-003): a suite whose result depends on the date is not a suite.
  const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
  const sql = () => client as Sql;
  const database = () => db as Db;

  let contactCounter = 0;
  async function contact(label: string): Promise<string> {
    contactCounter += 1;
    const digits = String(2000 + contactCounter);
    const hash = `${label}${contactCounter.toString(16)}`.padStart(64, "0");
    await sql()`
      insert into contacts (phone_e164, phone_hash)
      values (${`+1206555${digits}`}, ${hash})
      on conflict (phone_hash) do nothing
    `;
    return hash;
  }

  /** A farm with one sales location, so authorization has something to authorize. */
  async function farmWithStand(name: string): Promise<string> {
    const farms = await sql()`insert into farms (name) values (${name}) returning id`;
    const farmId = farms[0]?.id as string;
    await sql()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', ${`${name} Stand`}, 'America/Los_Angeles', 'visitable',
        'produce', '1 Vashon Hwy', 47.4, -122.4, false, false
      )
    `;
    return farmId;
  }

  /** An active invitation for `farmId`, returning its raw one-use token. */
  async function invitation(farmId: string | null): Promise<string> {
    const created = await createFarmerInvitation(database(), {
      farmId,
      channel: "sms",
      administratorId,
      occurredAt: at(0),
    });
    if (created.status !== "created") throw new Error(`invitation: ${created.status}`);
    return created.token;
  }

  async function consentRow(
    contactHash: string,
  ): Promise<
    { state: string; capture_source: string | null; captured_at: Date } | undefined
  > {
    const rows = await sql()`
      select state, capture_source, captured_at from sms_consents
      where recipient_hash = ${contactHash}
    `;
    return rows[0] as
      | { state: string; capture_source: string | null; captured_at: Date }
      | undefined;
  }

  /**
   * Report what the dispatch claim decides about the "your farm is ready" text —
   * `authorized` when consent permits the send, `suppressed` when it does not.
   *
   * **The question these tests ask is about CONSENT, not about who authorized.** Since F-067
   * an agreed invited SIGNUP sets the farmer up during redemption, so the notification is
   * usually already queued by the time this runs; only the paths that still need a human
   * (no tick, no farm named) leave an open request for `authorizeFarmer` to settle. This
   * helper covers whichever happened and then claims, so each test keeps proving the thing it
   * was written to prove: that the dispatch gate re-reads consent and suppresses a send to
   * someone who never opted in.
   */
  async function authorizeAndClaim(input: {
    contactHash: string;
    farmId: string;
  }): Promise<string> {
    const requests = await sql()`
      select id from farmer_onboarding_requests
      where contact_hash = ${input.contactHash} and settled_at is null
    `;
    const openRequestId = requests[0]?.id as string | undefined;
    if (openRequestId !== undefined) {
      const authorized = await authorizeFarmer(database(), {
        farmId: input.farmId,
        requestId: openRequestId,
        administratorId,
        occurredAt: at(10),
      });
      if (authorized.status !== "authorized") throw new Error(authorized.status);
    }

    const queued = await sql()`
      select id from outbox_work
      where recipient_hash = ${input.contactHash}
        and logical_key like 'farmer-authorized-%'
    `;
    const outboxWorkId = queued[0]?.id as string | undefined;
    if (outboxWorkId === undefined) {
      throw new Error("no 'your farm is ready' notification was queued");
    }
    const claim = await authorizeDispatch(database(), {
      outboxWorkId,
      now: at(11),
    });
    return claim.status;
  }

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_onboarding_consent_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
      values ('board@vigavashon.org', ${at(0)}) returning id
    `;
    administratorId = administrators[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  describe("stamping the agreement on the invitation", () => {
    it("stamps an active invitation and reports it stamped", async () => {
      const token = await invitation(await farmWithStand(`Agree ${randomUUID()}`));

      const agreed = await recordFarmerInvitationSmsAgreement(database(), {
        token,
        occurredAt: at(1),
      });

      expect(agreed.status).toBe("agreed");
      const rows = await sql()`
        select agreed_to_sms_at from farmer_invitations
        where token_hash = ${hashFarmerInviteToken(token)}
      `;
      expect(rows[0]?.agreed_to_sms_at).not.toBeNull();
    });

    it("is idempotent — a second tick keeps the FIRST agreement time", async () => {
      // A farmer who reloads the page and ticks again has not agreed twice. Moving the
      // timestamp would falsify the provenance the consent record points at.
      const token = await invitation(await farmWithStand(`Retick ${randomUUID()}`));
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(5) });

      const rows = await sql()`
        select agreed_to_sms_at from farmer_invitations
        where token_hash = ${hashFarmerInviteToken(token)}
      `;
      expect((rows[0]?.agreed_to_sms_at as Date).getTime()).toBe(at(1).getTime());
    });

    it("refuses an expired invitation", async () => {
      const token = await invitation(await farmWithStand(`Expired ${randomUUID()}`));
      await sql()`
        update farmer_invitations set expires_at = ${at(2).toISOString()}
        where token_hash = ${hashFarmerInviteToken(token)}
      `;

      const agreed = await recordFarmerInvitationSmsAgreement(database(), {
        token,
        occurredAt: at(3),
      });

      expect(agreed.status).toBe("invalid");
    });

    it("refuses a redeemed invitation", async () => {
      const token = await invitation(await farmWithStand(`Redeemed ${randomUUID()}`));
      await openFarmerOnboardingRequest(database(), {
        contactHash: await contact("c1"),
        occurredAt: at(2),
        invitationToken: token,
      });

      const agreed = await recordFarmerInvitationSmsAgreement(database(), {
        token,
        occurredAt: at(3),
      });

      expect(agreed.status).toBe("invalid");
    });

    it("refuses a token that is not 64 hex characters, touching no row", async () => {
      const agreed = await recordFarmerInvitationSmsAgreement(database(), {
        token: "not-a-token",
        occurredAt: at(1),
      });
      expect(agreed.status).toBe("invalid");
    });
  });

  describe("SIGNUP carrying an agreed invitation", () => {
    it("establishes consent, and the 'your farm is ready' text is DISPATCHED", async () => {
      // The whole point. This is the journey that was silently dead.
      const contactHash = await contact("d1");
      const farmId = await farmWithStand(`Consenting ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;
      expect(opened.consentEstablished).toBe(true);

      // Consent is recorded with its own provenance: this opt-in came from the web
      // onboarding agreement, not from a JOIN or a START.
      const consent = await consentRow(contactHash);
      expect(consent?.state).toBe("active");
      expect(consent?.capture_source).toBe("farmer_onboarding");

      expect(await authorizeAndClaim({ contactHash, farmId })).toBe("authorized");
    });

    it("AUTHORIZES the farmer for the invited farm, with no administrator acting", async () => {
      // F-067 — the invitation IS the authorization decision. A coordinator chose this farm
      // and sent the link to this person; the later queue click re-approved something already
      // decided, which is why the old code could say "VIGA always approves".
      //
      // Asserted as a DATABASE EFFECT — a live `farmer_authorizations` row binding this phone
      // to that farm — because that row, not the queue, is what every publish path resolves
      // through (`resolveFarmerTarget`). A test that only checked the request was settled
      // would pass while the farmer still could not publish anything.
      const contactHash = await contact("f1");
      const farmId = await farmWithStand(`Selfserve ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("opened");

      const authorizations = await sql()`
        select grant_row.id, grant_row.farm_id
        from farmer_authorizations as grant_row
        join contacts on contacts.id = grant_row.contact_id
        where contacts.phone_hash = ${contactHash} and grant_row.revoked_at is null
      `;
      expect(authorizations.length).toBe(1);
      expect(authorizations[0]?.farm_id).toBe(farmId);

      // No human acted, so nothing is left waiting in VIGA's queue.
      const open = await sql()`
        select id from farmer_onboarding_requests
        where contact_hash = ${contactHash} and settled_at is null
      `;
      expect(open.length).toBe(0);
    });

    it("still refuses a settlement that records neither a farmer nor an administrator", async () => {
      // The constraint's job is unchanged: a settled request must say WHO settled it. F-067
      // only widened the acceptable answers from "an administrator" to "an administrator or
      // the authorization a farmer's own redemption granted". A settlement naming neither is
      // still incoherent, and this is what keeps the widening from becoming a hole.
      const contactHash = await contact("f4");
      const requests = await sql()`
        insert into farmer_onboarding_requests (contact_hash, requested_at)
        values (${contactHash}, ${at(2).toISOString()})
        returning id
      `;

      await expect(
        sql()`
          update farmer_onboarding_requests
          set settled_at = ${at(3).toISOString()}
          where id = ${requests[0]?.id as string}
        `,
      ).rejects.toThrow(/coherent_settlement/);
    });

    it("does NOT authorize when the farmer never ticked the agreement", async () => {
      // Authorization rides on the same evidence consent does: an agreed invitation redeemed
      // from the handset. Without the tick there is no informed opt-in, so setting the farmer
      // up would authorize someone into messages they never agreed to receive.
      const contactHash = await contact("f2");
      const farmId = await farmWithStand(`Untickedauth ${randomUUID()}`);
      const token = await invitation(farmId);

      await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });

      const authorizations = await sql()`
        select grant_row.id from farmer_authorizations as grant_row
        join contacts on contacts.id = grant_row.contact_id
        where contacts.phone_hash = ${contactHash} and grant_row.revoked_at is null
      `;
      expect(authorizations.length).toBe(0);
    });

    it("does NOT authorize a bare SIGNUP carrying no invitation", async () => {
      // A stranger texting the keyword names no farm and carries no decision. This is the
      // path that must never become self-serve — it is reachable by anyone with the number.
      const contactHash = await contact("f3");

      await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        providerEventId: `evt-${randomUUID()}`,
      });

      const authorizations = await sql()`
        select grant_row.id from farmer_authorizations as grant_row
        join contacts on contacts.id = grant_row.contact_id
        where contacts.phone_hash = ${contactHash} and grant_row.revoked_at is null
      `;
      expect(authorizations.length).toBe(0);
      // The ask still reaches VIGA: an uninvited request is exactly the case a human owns.
      const open = await sql()`
        select id from farmer_onboarding_requests
        where contact_hash = ${contactHash} and settled_at is null
      `;
      expect(open.length).toBe(1);
    });

    it("establishes NO consent when the box was never ticked", async () => {
      // The invitation alone is not agreement. VIGA creating a link cannot opt a farmer in.
      const contactHash = await contact("d2");
      const farmId = await farmWithStand(`Unticked ${randomUUID()}`);
      const token = await invitation(farmId);

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;
      expect(opened.consentEstablished).toBe(false);

      expect(await consentRow(contactHash)).toBeUndefined();
      expect(await authorizeAndClaim({ contactHash, farmId })).toBe("suppressed");
    });

    it("establishes no consent for a bare SIGNUP with no invitation", async () => {
      // The uninvited path has no web page to show an agreement on, so there is nothing to
      // rely on. It must stay exactly as silent about consent as it always was.
      const contactHash = await contact("d3");

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;
      expect(opened.consentEstablished).toBe(false);
      expect(await consentRow(contactHash)).toBeUndefined();
    });

    it("keeps ONE unchanged record for a sender who already consented", async () => {
      // max's named case: a farmer who already texted JOIN as an ordinary customer, then
      // goes through onboarding. Consent is not collected twice, and the original
      // provenance is not overwritten — `applyConsentTransition`'s first-time rule already
      // enforces this under its lock, so this is a test of existing behavior, not new code.
      const contactHash = await contact("d4");
      const farmId = await farmWithStand(`Already ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });

      await applyConsentTransition(database(), {
        recipientHash: contactHash,
        transition: "start",
        occurredAt: at(0),
        providerEventId: `evt-${randomUUID()}`,
        captureSource: "join",
        firstTimeOnly: true,
      });
      const before = await consentRow(contactHash);

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;
      // Nothing was established — the record already existed.
      expect(opened.consentEstablished).toBe(false);

      const rows = await sql()`
        select count(*)::int as n from sms_consents where recipient_hash = ${contactHash}
      `;
      expect(rows[0]?.n).toBe(1);
      const after = await consentRow(contactHash);
      expect(after?.capture_source).toBe("join");
      expect(after?.captured_at).toStrictEqual(before?.captured_at);

      // And they still hear about the approval, because their consent is active.
      expect(await authorizeAndClaim({ contactHash, farmId })).toBe("authorized");
    });

    it("does NOT re-enroll a sender who texted STOP — the opt-out outranks onboarding", async () => {
      // The failure this guards is silent re-subscription: a person who opted out completes
      // a web form and is quietly put back on the list. `firstTimeOnly` refuses because a
      // record EXISTS, whatever its state — and the carrier's own block would refuse the
      // send regardless (B-011).
      const contactHash = await contact("d5");
      const farmId = await farmWithStand(`Stopped ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });

      await applyConsentTransition(database(), {
        recipientHash: contactHash,
        transition: "stop",
        occurredAt: at(0),
        providerEventId: `evt-${randomUUID()}`,
      });

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;
      expect(opened.consentEstablished).toBe(false);

      expect((await consentRow(contactHash))?.state).toBe("stopped");
      expect(await authorizeAndClaim({ contactHash, farmId })).toBe("suppressed");
    });

    it("redeems the invitation and establishes consent ATOMICALLY", async () => {
      // The two must not be separable. If the invitation could be redeemed without the
      // consent write landing, a retry would get `already_open`, never establish consent,
      // and the farmer would be back in the original silent dead end with no way out.
      const contactHash = await contact("d6");
      const token = await invitation(await farmWithStand(`Atomic ${randomUUID()}`));
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });

      await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });

      const redeemed = await sql()`
        select redeemed_at from farmer_invitations
        where token_hash = ${hashFarmerInviteToken(token)}
      `;
      expect(redeemed[0]?.redeemed_at).not.toBeNull();
      expect((await consentRow(contactHash))?.state).toBe("active");

      // And the watermark moved with it, so a later STOP at a later provider time still
      // wins and an older delayed START cannot undo anything.
      const watermark = await sql()`
        select transition, occurred_at from consent_transition_watermarks
        where recipient_hash = ${contactHash}
      `;
      expect(watermark[0]?.transition).toBe("start");
      expect((watermark[0]?.occurred_at as Date).getTime()).toBe(at(2).getTime());
    });

    it("a repeated SIGNUP creates one request and one consent record", async () => {
      // A farmer who texts twice because nothing visibly happened. The second is refused by
      // the redeemed invitation; neither the request nor the consent row duplicates.
      const contactHash = await contact("d7");
      const token = await invitation(await farmWithStand(`Repeat ${randomUUID()}`));
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });

      await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });
      const second = await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(3),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(second.status).toBe("invalid_invitation");

      const requests = await sql()`
        select count(*)::int as n from farmer_onboarding_requests
        where contact_hash = ${contactHash}
      `;
      expect(requests[0]?.n).toBe(1);
      const consents = await sql()`
        select count(*)::int as n from sms_consents where recipient_hash = ${contactHash}
      `;
      expect(consents[0]?.n).toBe(1);
    });
  });
});
