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
  recordFarmerInvitationPendingPhone,
  recordFarmerInvitationPendingStock,
  recordFarmerInvitationSmsAgreement,
  type Db,
  type Sql,
} from "./index";

// Web onboarding establishes SMS consent — the launch blocker this suite exists to pin.
//
// Before this, the standard invited path dead-ended in silence: a farmer completed
// onboarding, VIGA approved, and `FARMER_AUTHORIZED_NOTIFICATION` — a proactive
// `inventory_prompt` — was correctly SUPPRESSED at the dispatch claim because a bare request
// established no consent. The farmer was authorized, never told, and had no reason to
// believe the system worked. Nothing in the invitation, the page, or the reply asked them
// to text JOIN; the word appeared only in code comments.
//
// The fix is not a new consent writer. The farmer ticks an agreement on the invitation
// page (that stamps `agreed_to_sms_at`), and the INBOUND `JOIN <token>` from their phone
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
   * an agreed invited JOIN sets the farmer up during redemption, so the notification is
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

  describe("an invited JOIN carrying an agreed invitation", () => {
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

    it("APPROVES the farm too, so the farmer's first publish is not refused", async () => {
      // F-067 — authorization and approval are two INDEPENDENT gates. `confirmProposal` checks
      // `farmer_authorizations` and then `farm_approvals`, and returns `not_approved` when the
      // second is missing. Setting a farmer up without approving their farm leaves them
      // authorized, texted "your farm is ready", and refused on their first update — the exact
      // silent dead end this feature exists to close, moved one step later.
      //
      // The approval names the administrator who CREATED THE INVITATION, which is honest rather
      // than convenient: that is the person who decided this farm participates, at the moment
      // they minted a one-use link for it.
      const contactHash = await contact("g1");
      const farmId = await farmWithStand(`Approved ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });

      await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });

      const approvals = await sql()`
        select administrator_id from farm_approvals
        where farm_id = ${farmId} and revoked_at is null
      `;
      expect(approvals.length).toBe(1);
      expect(approvals[0]?.administrator_id).toBe(administratorId);
    });

    it("does not approve a farm that was already approved", async () => {
      // `farm_approvals_one_current_per_farm` is a partial unique index, so a second live row is
      // an error rather than a no-op. A farmer invited to an already-participating farm must not
      // turn a redemption into a constraint violation.
      const contactHash = await contact("g2");
      const farmId = await farmWithStand(`Reapproved ${randomUUID()}`);
      await sql()`
        insert into farm_approvals (farm_id, administrator_id, approved_at)
        values (${farmId}, ${administratorId}, ${at(0).toISOString()})
      `;
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });

      expect(opened.status).toBe("opened");
      const approvals = await sql()`
        select id from farm_approvals where farm_id = ${farmId} and revoked_at is null
      `;
      expect(approvals.length).toBe(1);
    });

    it("does not approve any farm when the agreement was never ticked", async () => {
      // Approval rides on the same evidence authorization does. An untickd invitation still
      // waits for VIGA, and must not quietly publish the farm in the meantime.
      const contactHash = await contact("g3");
      const farmId = await farmWithStand(`Unapproved ${randomUUID()}`);
      const token = await invitation(farmId);

      await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(2),
        invitationToken: token,
        providerEventId: `evt-${randomUUID()}`,
      });

      const approvals = await sql()`
        select id from farm_approvals where farm_id = ${farmId} and revoked_at is null
      `;
      expect(approvals.length).toBe(0);
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

    it("does NOT authorize a request carrying no invitation", async () => {
      // A request with no invitation names no farm and carries no decision, so it can never
      // authorize anyone.
      //
      // F-080 removed the SMS route to this branch — there is no bare keyword any more, so
      // nobody with the number can reach it. It is KEPT because it is the admin path's only
      // source of `farmer_onboarding_requests` rows, which `authorizeFarmer` requires. The
      // property is the same either way: no invitation, no authorization.
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

    it("establishes no consent for a request with no invitation", async () => {
      // A request with no invitation has no agreement to rest on — no web page showed one —
      // so it must stay exactly as silent about consent as it always was. Reachable only by
      // the admin path since F-080; the rule is unchanged.
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

    it("a repeated redemption creates one request and one consent record", async () => {
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

  // ── The phone-matched path: a bare START completes onboarding (max 2026-08-07) ───────────
  //
  // `JOIN <token>` is gone. It made the farmer hand-copy 64 hex characters into a text
  // message, where one transcription slip failed silently — the token matched no invitation
  // and nothing could say why. The farm identity moved to a phone stated on the onboarding
  // form, so the message the farmer sends is the one word the carrier itself defines.
  //
  // **The invitation is still the credential.** It reaches only the person VIGA sent the link
  // to; the phone says which handset to expect. That distinction is what the wrong-number
  // tests below pin down.
  //
  // Every sender hash here comes from `contact()` — a REAL contacts row. Fabricated digests
  // cannot be used: `farmer_onboarding_requests.contact_hash` and
  // `consent_transition_watermarks.recipient_hash` both carry a foreign key to `contacts`, so
  // an invented hash fails on the insert rather than on the property under test.
  describe("a bare START from the stated phone completes onboarding", () => {
    it("establishes consent and AUTHORIZES the farmer, with no token in the message", async () => {
      // The whole replacement, end to end: the form states the phone, START arrives from it,
      // the farmer is set up. Nothing the farmer typed into a text message is involved.
      const senderHash = await contact("e1");
      const farmId = await farmWithStand(`Phone ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });
      const recorded = await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551001",
        phoneHash: senderHash,
        occurredAt: at(1),
      });
      expect(recorded.status).toBe("recorded");

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });

      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;
      expect(opened.consentEstablished).toBe(true);
      // Set up for the farm the INVITATION named — never a farm the phone chose.
      expect(opened.authorizationId).not.toBeNull();
      expect(await authorizeAndClaim({ contactHash: senderHash, farmId })).toBe("authorized");
    });

    it("records the raw number and the hash TOGETHER", async () => {
      // Golden Rule #5's shape, read back from the row. The coherence constraint makes a
      // half-written pair impossible, so this asserts the pair the writer actually stores.
      const senderHash = await contact("e2");
      const token = await invitation(await farmWithStand(`Shape ${randomUUID()}`));
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551002",
        phoneHash: senderHash,
        occurredAt: at(1),
      });

      const rows = await sql()`
        select pending_phone_e164, pending_phone_hash from farmer_invitations
        where token_hash = ${hashFarmerInviteToken(token)}
      `;
      expect(rows[0]?.pending_phone_e164).toBe("+12065551002");
      expect(rows[0]?.pending_phone_hash).toBe(senderHash);
    });

    it("lets a farmer CORRECT a mistyped number before they text", async () => {
      // The recovery that makes a typo survivable. Unlike the agreement stamp — provenance of
      // a disclosure, which keeps its first value — this must be overwritable, or a farmer who
      // mistyped is stranded waiting for a text from a handset they do not hold.
      const wrong = await contact("e3");
      const right = await contact("e4");
      const token = await invitation(await farmWithStand(`Fix ${randomUUID()}`));
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551003",
        phoneHash: wrong,
        occurredAt: at(1),
      });
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551004",
        phoneHash: right,
        occurredAt: at(2),
      });

      const rows = await sql()`
        select pending_phone_e164, pending_phone_hash from farmer_invitations
        where token_hash = ${hashFarmerInviteToken(token)}
      `;
      expect(rows[0]?.pending_phone_e164).toBe("+12065551004");
      expect(rows[0]?.pending_phone_hash).toBe(right);
    });

    it("ENROLLS a returning farmer whose phone had texted STOP", async () => {
      // **The case that inverts if `firstTimeOnly` is left true, and the reason this path sets
      // it differently from the token path.**
      //
      // START is the carrier's OWN keyword and the only word that clears its opt-out list, so
      // it is precisely the word a returning farmer sends — someone who by definition already
      // has a record. `firstTimeOnly` refuses whenever any record exists, so keeping it here
      // would refuse consent for exactly the sender START exists to restore: invitation spent,
      // consent left `stopped`, farmer never told, and nothing reporting it.
      //
      // The safety `firstTimeOnly` protected is not lost. It stopped a WEB FORM silently
      // re-enrolling an opted-out person, and it still does — a form tick writes no consent at
      // all. What enrolls here is an inbound message from the handset, which is the one thing
      // that legitimately clears a stop.
      const senderHash = await contact("e5");
      const farmId = await farmWithStand(`Returning ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551005",
        phoneHash: senderHash,
        occurredAt: at(1),
      });

      // They opted out at some point in the past, as a customer.
      await applyConsentTransition(database(), {
        recipientHash: senderHash,
        transition: "stop",
        occurredAt: at(0),
        providerEventId: `evt-${randomUUID()}`,
      });

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });

      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;
      // The assertion that fails if `firstTimeOnly` is restored on this path.
      expect(opened.consentEstablished).toBe(true);
      expect((await consentRow(senderHash))?.state).toBe("active");
      // Provenance says START, because START is what arrived and what lifted the carrier block.
      expect((await consentRow(senderHash))?.capture_source).toBe("start");
      expect(await authorizeAndClaim({ contactHash: senderHash, farmId })).toBe("authorized");
    });

    it("matches NOTHING for a phone no invitation states", async () => {
      // The mistyped-number direction. It grants nothing and leaves the invitation unredeemed
      // and retryable — the failure direction to want, because the farmer can fix the number
      // and text again.
      const stated = await contact("e6");
      const other = await contact("e7");
      const token = await invitation(await farmWithStand(`Miss ${randomUUID()}`));
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551006",
        phoneHash: stated,
        occurredAt: at(1),
      });

      // START arrives from a DIFFERENT handset than the one stated.
      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: other,
        occurredAt: at(2),
        pendingPhoneHash: other,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("invalid_invitation");

      // The invitation is still spendable, which is what makes the typo recoverable.
      const rows = await sql()`
        select redeemed_at from farmer_invitations
        where token_hash = ${hashFarmerInviteToken(token)}
      `;
      expect(rows[0]?.redeemed_at).toBeNull();
    });

    it("does NOT match an invitation that was already redeemed", async () => {
      // A spent invitation is history. Without the `redeemed_at is null` predicate a second
      // START from the same handset would re-run the whole redemption.
      const senderHash = await contact("e8");
      const farmId = await farmWithStand(`Spent ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551008",
        phoneHash: senderHash,
        occurredAt: at(1),
      });

      const first = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(first.status).toBe("opened");

      const second = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(3),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(second.status).toBe("invalid_invitation");

      const consents = await sql()`
        select count(*)::int as n from sms_consents where recipient_hash = ${senderHash}
      `;
      expect(consents[0]?.n).toBe(1);
    });

    it("does NOT authorize when the agreement was never ticked", async () => {
      // The tick gate is unchanged by the new credential. No disclosure accepted means no
      // informed opt-in, so the request falls through to VIGA rather than setting anyone up.
      const senderHash = await contact("e9");
      const farmId = await farmWithStand(`NoTick ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551009",
        phoneHash: senderHash,
        occurredAt: at(1),
      });

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });

      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;
      expect(opened.authorizationId).toBeNull();
      expect(opened.consentEstablished).toBe(false);
    });

    it("REFUSES when both a token and a phone hash are given", async () => {
      // Two ways to name one invitation, so exactly one may be supplied. Guessing which the
      // caller meant would turn a routing bug into what looks like the farmer's bad input.
      const senderHash = await contact("ea");
      const token = await invitation(await farmWithStand(`Both ${randomUUID()}`));

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        invitationToken: token,
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("invalid_invitation");
    });

    it("refuses to store a number that is not normalized E.164", async () => {
      // The boundary normalizes; this refuses what reaches it unnormalized rather than letting
      // the database raise, which would surface to the farmer as "that did not save".
      const senderHash = await contact("eb");
      const token = await invitation(await farmWithStand(`Raw ${randomUUID()}`));

      for (const bad of ["2065551010", "(206) 555-1010", "+442065551010"]) {
        const result = await recordFarmerInvitationPendingPhone(database(), {
          token,
          phoneE164: bad,
          phoneHash: senderHash,
          occurredAt: at(1),
        });
        expect(result.status).toBe("invalid");
      }

      const rows = await sql()`
        select pending_phone_e164 from farmer_invitations
        where token_hash = ${hashFarmerInviteToken(token)}
      `;
      expect(rows[0]?.pending_phone_e164).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────
  // F-090 — today's stock, stated on the onboarding form and HELD until START.
  //
  // max's call (2026-08-08), after being shown what publishing at submit would mean: a
  // dated public claim standing behind a phone nobody has proved yet. The farmer types
  // today's stock during onboarding; it becomes a real, attributed confirmation only when
  // the inbound START proves who holds the handset.
  //
  // The two halves are asserted separately and both matter. "It publishes eventually" is
  // worthless if it was already public; "it is not public yet" is worthless if it never
  // lands. Each test below owns one of those.
  describe("stock stated at onboarding publishes on START, never before", () => {
    /** An invitation with an agreement, a stated phone, and today's stock held on it. */
    async function invitationHoldingStock(input: {
      farmId: string;
      senderHash: string;
      phoneE164: string;
      stock: { itemName: string; priceText?: string }[];
    }): Promise<string> {
      const token = await invitation(input.farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: input.phoneE164,
        phoneHash: input.senderHash,
        occurredAt: at(1),
      });
      const recorded = await recordFarmerInvitationPendingStock(database(), {
        token,
        entries: input.stock,
        occurredAt: at(1),
      });
      expect(recorded.status).toBe("recorded");
      return token;
    }

    /** The stand's CURRENT published revision, as a customer would read it. */
    async function publishedEntries(
      farmId: string,
    ): Promise<{ item_name: string; price_text: string | null }[]> {
      return (await sql()`
        select entry.item_name, entry.price_text
        from inventory_entries entry
        join inventory_revisions revision on revision.id = entry.inventory_revision_id
        join sales_locations location on location.id = revision.sales_location_id
        where location.owner_farm_id = ${farmId} and revision.is_current
        order by entry.sort_order asc
      `) as unknown as { item_name: string; price_text: string | null }[];
    }

    it("publishes NOTHING while the invitation is unredeemed", async () => {
      // The half max chose. Before START there is a farm, a listing, and a stated phone —
      // and no dated claim anywhere, because nobody has proved they hold that phone.
      const senderHash = await contact("f1");
      const farmId = await farmWithStand(`Held ${randomUUID()}`);
      await invitationHoldingStock({
        farmId,
        senderHash,
        phoneE164: "+12065551101",
        stock: [{ itemName: "eggs" }],
      });

      expect(await publishedEntries(farmId)).toEqual([]);
      // Not merely "no entries" — no revision at all. A revision with no entries is the
      // stand publicly confirming it is EMPTY, which is the opposite claim.
      const revisions = await sql()`
        select revision.id from inventory_revisions revision
        join sales_locations location on location.id = revision.sales_location_id
        where location.owner_farm_id = ${farmId}
      `;
      expect(revisions).toHaveLength(0);
    });

    it("publishes it as a dated confirmation when START arrives", async () => {
      const senderHash = await contact("f2");
      const farmId = await farmWithStand(`Publish ${randomUUID()}`);
      await invitationHoldingStock({
        farmId,
        senderHash,
        phoneE164: "+12065551102",
        stock: [{ itemName: "eggs", priceText: "$6/dozen" }, { itemName: "kale" }],
      });

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("opened");

      // The VALUES, in the farmer's order, with the price they stated.
      expect(await publishedEntries(farmId)).toEqual([
        { item_name: "eggs", price_text: "$6/dozen" },
        { item_name: "kale", price_text: null },
      ]);
    });

    it("attributes the revision to the farmer the START just authorized", async () => {
      // The whole reason it waits. A dated claim names who stands behind it, and this one
      // names the authorization minted by the message that proved the handset — not the
      // invitation, and not VIGA.
      const senderHash = await contact("f3");
      const farmId = await farmWithStand(`Attribute ${randomUUID()}`);
      await invitationHoldingStock({
        farmId,
        senderHash,
        phoneE164: "+12065551103",
        stock: [{ itemName: "eggs" }],
      });

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });
      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;

      const revisions = await sql()`
        select revision.source, revision.published_by_authorization_id,
               revision.proposal_id, revision.farm_approval_id
        from inventory_revisions revision
        join sales_locations location on location.id = revision.sales_location_id
        where location.owner_farm_id = ${farmId} and revision.is_current
      `;
      expect(revisions).toHaveLength(1);
      /*
        `web` — the third provenance, and each of these three assertions is the reason it
        exists rather than a reuse of one of the other two.

        NOT `viga`: a farmer stated this and their START proved the handset, so crediting
        VIGA would misattribute a farmer's own claim.

        NOT `sms`: no prompt went out and no YES came back, so there is no proposal — and
        `proposal_id` being NULL is asserted rather than left unmentioned, because that
        absence IS the honest difference. Recording this as `sms` would have required
        inventing a consumed token and a consumption event for a message nobody sent.

        As strong as `sms` on the two keys that answer "who stands behind this": a real
        authorization, and a farm VIGA approved.
      */
      expect(revisions[0]!.source).toBe("web");
      expect(revisions[0]!.proposal_id).toBeNull();
      expect(revisions[0]!.published_by_authorization_id).toBe(opened.authorizationId);
      expect(revisions[0]!.farm_approval_id).not.toBeNull();
    });

    it("spends the held stock exactly once, so a second START cannot republish it", async () => {
      // The invitation is spent by the first redemption, so this is really asserting that
      // the stock rides the invitation rather than living somewhere a retry could re-read.
      const senderHash = await contact("f4");
      const farmId = await farmWithStand(`Once ${randomUUID()}`);
      await invitationHoldingStock({
        farmId,
        senderHash,
        phoneE164: "+12065551104",
        stock: [{ itemName: "eggs" }],
      });

      await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });
      await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(3),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });

      const revisions = await sql()`
        select revision.id from inventory_revisions revision
        join sales_locations location on location.id = revision.sales_location_id
        where location.owner_farm_id = ${farmId}
      `;
      expect(revisions).toHaveLength(1);
    });

    it("redeems normally when the farmer stated no stock at all", async () => {
      // Skipping the question is a real and common answer, and must not cost the farmer
      // their redemption. No stock, no revision, still authorized.
      const senderHash = await contact("f5");
      const farmId = await farmWithStand(`Silent ${randomUUID()}`);
      const token = await invitation(farmId);
      await recordFarmerInvitationSmsAgreement(database(), { token, occurredAt: at(1) });
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551105",
        phoneHash: senderHash,
        occurredAt: at(1),
      });

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });

      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") return;
      expect(opened.authorizationId).not.toBeNull();
      expect(await publishedEntries(farmId)).toEqual([]);
    });

    it("REFUSES a 'web' revision that names a proposal or no authorization", async () => {
      // The constraint, tested as a constraint rather than through the writer that respects
      // it. `web` means "the farmer stated it, no confirmation exchange happened" — so a row
      // carrying a proposal is claiming an exchange that did not occur, and one with no
      // authorization is a dated public claim signed by nobody. Both must be structurally
      // impossible, not merely absent from the current writer.
      const senderHash = await contact("f7");
      const farmId = await farmWithStand(`Constraint ${randomUUID()}`);
      await invitationHoldingStock({
        farmId,
        senderHash,
        phoneE164: "+12065551107",
        stock: [{ itemName: "eggs" }],
      });
      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: senderHash,
        occurredAt: at(2),
        pendingPhoneHash: senderHash,
        providerEventId: `evt-${randomUUID()}`,
      });
      if (opened.status !== "opened") throw new Error(opened.status);

      const locations = await sql()`
        select id from sales_locations where owner_farm_id = ${farmId}
      `;
      const salesLocationId = locations[0]!.id as string;
      const approvals = await sql()`
        select id from farm_approvals where farm_id = ${farmId} and revoked_at is null
      `;
      const farmApprovalId = approvals[0]!.id as string;

      // No authorization: a claim nobody stands behind.
      await expect(
        sql()`
          insert into inventory_revisions (
            farm_id, sales_location_id, proposal_id, published_by_authorization_id,
            farm_approval_id, source, published_at
          )
          values (
            ${farmId}, ${salesLocationId}, null, null,
            ${farmApprovalId}, 'web', ${at(3)}
          )
        `,
      ).rejects.toThrow(/inventory_revisions_source_keys_coherent/);

      // No approval: published for a farm VIGA never approved.
      await expect(
        sql()`
          insert into inventory_revisions (
            farm_id, sales_location_id, proposal_id, published_by_authorization_id,
            farm_approval_id, source, published_at
          )
          values (
            ${farmId}, ${salesLocationId}, null, ${opened.authorizationId},
            null, 'web', ${at(3)}
          )
        `,
      ).rejects.toThrow(/inventory_revisions_source_keys_coherent/);
    });

    it("REFUSES to hold an empty list rather than storing a claim of emptiness", async () => {
      // "The farmer said nothing" and "the farmer said the stand is empty" are opposite
      // facts, and an empty array would publish the second. The column's CHECK refuses it;
      // the writer refuses it first, so the caller gets an answer rather than a violation.
      const senderHash = await contact("f6");
      const token = await invitation(await farmWithStand(`Empty ${randomUUID()}`));
      await recordFarmerInvitationPendingPhone(database(), {
        token,
        phoneE164: "+12065551106",
        phoneHash: senderHash,
        occurredAt: at(1),
      });

      const recorded = await recordFarmerInvitationPendingStock(database(), {
        token,
        entries: [],
        occurredAt: at(1),
      });

      expect(recorded.status).toBe("invalid");
      const rows = await sql()`
        select pending_stock from farmer_invitations
        where token_hash = ${hashFarmerInviteToken(token)}
      `;
      expect(rows[0]?.pending_stock).toBeNull();
    });
  });
});
