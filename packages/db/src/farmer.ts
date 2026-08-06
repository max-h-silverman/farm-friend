import {
  FARMER_AUTHORIZED_NOTIFICATION,
  farmerLinkUrl,
  hashFarmerLinkToken,
  hashFarmerInviteToken,
  issueFarmerLinkToken,
  issueFarmerInviteToken,
  maskPhoneSuffix,
} from "@farm-friend/core";
import type { Db } from "./index";
import type { Sql, Tx } from "./sql";
import { applyConsentTransitionIn, queueOutbox } from "./transactions";
import { visibleFarms } from "./test-farms";

// Farmer onboarding's durable writes (F-040).
//
// `farmer_authorizations` has existed since the clean launch with NO WRITER outside test
// fixtures. Publishing demands one, so a real farmer who texted an update resolved to no
// authorization, fell through to the CUSTOMER branch, and nothing reported why — behind a
// fully green suite, because every publication test inserted the row it was proving.
//
// This module is that writer, plus the two records around it. It follows `admin.ts` exactly,
// because it is the same kind of act and must not become a second way to do one thing:
// authority is re-read inside the transaction rather than inherited from the request, the
// acting administrator is recorded, revocation is an UPDATE rather than a delete, and the
// audit event commits with the decision or not at all.
//
// ## What is deliberately NOT here
//
// **Nothing a farmer can reach writes authority.** `openFarmerOnboardingRequest` is the one
// function on this page reachable from an unauthenticated inbound SMS, and it writes only a
// request. A plain SIGNUP names no farm; an invited SIGNUP carries only an administrator-created
// opaque invitation reference, which suggests the farm to VIGA but cannot grant it. Every other
// write below demands an `administratorId` that was resolved from a session and is re-read here
// under lock. VIGA always approves — a phone proves possession of a phone, not ownership of a
// farm.

function driver(db: Db): Sql {
  return db.sql;
}

const FARMER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type FarmerInviteChannel = "sms" | "email";

export type CreateFarmerInvitationResult =
  | { status: "created"; token: string; farmName: string | null; channel: FarmerInviteChannel }
  | { status: "not_an_administrator" }
  | { status: "unknown_farm" }
  | { status: "invalid_farm_name" };

/**
 * Create a one-use onboarding link for an administrator to share.
 *
 * The invitation may name an EXISTING farm (`farmId`) or create a NEW one (`newFarmName`),
 * never both — two different farms for one invitation is an ambiguous instruction, and
 * guessing which was meant would bind the farmer to the wrong farm.
 *
 * **Naming the farm here is what makes self-serve onboarding reachable for a new farmer**
 * (F-067). The invitation is the authorization decision, and an invitation naming no farm
 * grants nothing — it leaves the farmer in the queue this work exists to remove. Creating the
 * farm at invite time is the coordinator making that decision once, where they already are.
 */
export async function createFarmerInvitation(
  db: Db,
  input: {
    farmId?: string | null;
    /** Create and bind a new farm under this name. Mutually exclusive with `farmId`. */
    newFarmName?: string;
    channel: FarmerInviteChannel;
    administratorId: string;
    occurredAt: Date;
  },
): Promise<CreateFarmerInvitationResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) return { status: "not_an_administrator" as const };

    // Trimmed before every test below, so padding decides nothing: `"  "` is blank, and a
    // padded real name is stored clean rather than reaching the public map with its
    // whitespace. `farms_name_not_blank` is the database's backstop; answering here means the
    // operator gets a result instead of a constraint violation, and no invitation is minted
    // pointing at a farm that was never created.
    const newFarmName = input.newFarmName?.trim();
    const requestedFarmId = input.farmId ?? null;
    if (newFarmName !== undefined) {
      if (newFarmName === "" || requestedFarmId !== null) {
        return { status: "invalid_farm_name" as const };
      }
      const createdFarm = await tx`
        insert into farms (name) values (${newFarmName}) returning id, name
      `;
      return finishFarmerInvitation(tx, {
        farmId: createdFarm[0]?.id as string,
        farmName: createdFarm[0]?.name as string,
        channel: input.channel,
        administratorId: input.administratorId,
        occurredAt: input.occurredAt,
      });
    }

    const farmId = requestedFarmId;
    const farms =
      farmId === null
        ? []
        : await tx`select id, name from farms where id = ${farmId}`;
    const farmName = (farms[0]?.name as string | undefined) ?? null;
    if (farmId !== null && farmName === null) return { status: "unknown_farm" as const };

    return finishFarmerInvitation(tx, {
      farmId,
      farmName,
      channel: input.channel,
      administratorId: input.administratorId,
      occurredAt: input.occurredAt,
    });
  }) as Promise<CreateFarmerInvitationResult>;
}

/**
 * Mint the token and write the invitation once the farm is settled, whichever way it was
 * chosen. One writer, so an invitation naming a new farm and one naming an existing farm
 * cannot drift apart in expiry, audit, or token handling.
 */
async function finishFarmerInvitation(
  tx: Tx,
  input: {
    farmId: string | null;
    farmName: string | null;
    channel: FarmerInviteChannel;
    administratorId: string;
    occurredAt: Date;
  },
): Promise<CreateFarmerInvitationResult> {
  const token = issueFarmerInviteToken();
  const inserted = await tx`
    insert into farmer_invitations (
      farm_id, token_hash, channel, created_by_administrator_id,
      created_at, expires_at
    ) values (
      ${input.farmId}, ${hashFarmerInviteToken(token)}, ${input.channel},
      ${input.administratorId}, ${input.occurredAt.toISOString()},
      ${new Date(input.occurredAt.getTime() + FARMER_INVITE_TTL_MS).toISOString()}
    )
    returning id
  `;
  const invitationId = inserted[0]?.id as string;
  await tx`
    insert into audit_events (
      action, actor_administrator_id, subject_type, subject_id, occurred_at
    ) values (
      'farmer_invitation_created', ${input.administratorId},
      'farmer_invitation', ${invitationId}, ${input.occurredAt.toISOString()}
    )
  `;

  return {
    status: "created" as const,
    token,
    farmName: input.farmName,
    channel: input.channel,
  };
}

export type FarmerInvitationLookup =
  | {
      status: "active";
      invitationId: string;
      farmId: string | null;
      farmName: string | null;
      channel: FarmerInviteChannel;
    }
  | { status: "invalid" };

/** Resolve an invitation without exposing its token or any recipient identity. */
export async function loadFarmerInvitation(
  db: Db,
  token: string,
  now: Date,
): Promise<FarmerInvitationLookup> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { status: "invalid" };
  const rows = await driver(db)`
    select invitation.id, invitation.farm_id, farm.name as farm_name, invitation.channel
    from farmer_invitations as invitation
    left join farms as farm on farm.id = invitation.farm_id
    where invitation.token_hash = ${hashFarmerInviteToken(token)}
      and invitation.redeemed_at is null
      and invitation.expires_at > ${now.toISOString()}
  `;
  const row = rows[0];
  if (row === undefined) return { status: "invalid" };
  return {
    status: "active",
    invitationId: row.id as string,
    farmId: (row.farm_id as string | null) ?? null,
    farmName: (row.farm_name as string | null) ?? null,
    channel: row.channel as FarmerInviteChannel,
  };
}

export type RecordInvitationAgreementResult =
  | { status: "agreed" }
  | { status: "invalid" };

/**
 * Record that the invited farmer accepted the SMS agreement on the onboarding page.
 *
 * **This grants nothing and sends nothing.** It stamps provenance: the agreement was shown
 * on this invitation's page and accepted at this time. Consent itself is established only
 * when `SIGNUP <token>` arrives from a handset, because a tick on a web page says nothing
 * about who holds the phone that will receive the messages. Anyone with the link can reach
 * this, which is exactly why it may not be the consent write.
 *
 * **Stamping is idempotent and keeps the FIRST time.** A farmer who reloads and ticks again
 * has not agreed twice, and moving the timestamp would falsify the provenance the consent
 * record points back at — hence `agreed_to_sms_at is null` in the predicate rather than an
 * unconditional set. A repeat tick still reports `agreed`, because it is the honest answer
 * to "is this invitation agreed?" and the page has nothing different to say.
 *
 * An expired or already-redeemed invitation is refused with the same uniform `invalid` the
 * page already renders for a dead link, so this endpoint discloses nothing a visitor could
 * not already learn by loading the page.
 */
export async function recordFarmerInvitationSmsAgreement(
  db: Db,
  input: { token: string; occurredAt: Date },
): Promise<RecordInvitationAgreementResult> {
  if (!/^[0-9a-f]{64}$/.test(input.token)) return { status: "invalid" };
  const updated = await driver(db)`
    update farmer_invitations
    set agreed_to_sms_at = ${input.occurredAt.toISOString()}
    where token_hash = ${hashFarmerInviteToken(input.token)}
      and redeemed_at is null
      and expires_at > ${input.occurredAt.toISOString()}
      and agreed_to_sms_at is null
    returning id
  `;
  if (updated.length > 0) return { status: "agreed" };

  // No row updated is ambiguous: already agreed (fine), or expired/redeemed/unknown (not).
  // Re-read to answer honestly rather than reporting a failure for a farmer who simply
  // ticked twice.
  const existing = await driver(db)`
    select id from farmer_invitations
    where token_hash = ${hashFarmerInviteToken(input.token)}
      and redeemed_at is null
      and expires_at > ${input.occurredAt.toISOString()}
      and agreed_to_sms_at is not null
  `;
  return existing.length > 0 ? { status: "agreed" } : { status: "invalid" };
}

export interface AuthorizeFarmerInput {
  farmId: string;
  /** The opaque open request VIGA is answering. */
  requestId: string;
  administratorId: string;
  occurredAt: Date;
}

export type AuthorizeFarmerResult =
  | { status: "authorized"; authorizationId: string }
  | { status: "already_authorized" }
  | { status: "not_an_administrator" }
  | { status: "unknown_farm" }
  | { status: "unknown_request" }
  | { status: "farm_mismatch" };

/**
 * Authorize a farmer to publish for a farm, recording which administrator acted.
 *
 * This is the write that closes the chain from "a farmer texts us" to "that farmer can
 * publish". Before it, the only authorizations in existence were fixtures'.
 *
 * **`phone_verified_at` is the moment VIGA acts, and that is honest rather than convenient.**
 * The schema requires verification to precede authorization, and what verifies the phone here
 * is that the farmer texted from it — possession demonstrated to the system, then a human
 * deciding the person behind it runs the farm. There is no separate verification step to
 * record, and inventing an earlier timestamp would claim a check nobody performed.
 *
 * The exact onboarding request VIGA answered is SETTLED in the same transaction. The queue
 * would otherwise keep showing an ask that has already been answered, and an operator would
 * work it twice.
 */
export async function authorizeFarmer(
  db: Db,
  input: AuthorizeFarmerInput,
): Promise<AuthorizeFarmerResult> {
  return driver(db).begin(async (tx) => {
    // Re-read under lock: a principal resolved at the start of the request proves they were
    // an administrator then; this proves they are one now.
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const farm = await tx`select id from farms where id = ${input.farmId}`;
    if (farm.length === 0) return { status: "unknown_farm" as const };

    const requests = await tx`
      select request.contact_hash, contact.id as contact_id,
        invitation.farm_id as invitation_farm_id
      from farmer_onboarding_requests as request
      join contacts as contact on contact.phone_hash = request.contact_hash
      left join farmer_invitations as invitation on invitation.id = request.invitation_id
      where request.id = ${input.requestId} and request.settled_at is null
      for update of request, contact
    `;
    const request = requests[0];
    if (request === undefined) return { status: "unknown_request" as const };
    const contactId = request.contact_id as string;
    const contactHash = request.contact_hash as string;
    const invitationFarmId = (request.invitation_farm_id as string | null | undefined) ?? null;
    if (invitationFarmId !== null && invitationFarmId !== input.farmId) {
      return { status: "farm_mismatch" as const };
    }

    // Locked so two concurrent authorizations cannot both see "none" and race the partial
    // unique index into an error instead of an honest answer.
    const existing = await tx`
      select id from farmer_authorizations
      where farm_id = ${input.farmId} and contact_id = ${contactId}
        and revoked_at is null
      for update
    `;
    if (existing.length > 0) return { status: "already_authorized" as const };

    const inserted = await tx`
      insert into farmer_authorizations (
        farm_id, contact_id, phone_verified_at, authorized_at
      )
      values (
        ${input.farmId}, ${contactId}, ${input.occurredAt.toISOString()},
        ${input.occurredAt.toISOString()}
      )
      returning id
    `;
    const authorizationId = inserted[0]?.id as string;

    // Settle the ask this answers, if there was one. Scoped to the OPEN request for this
    // contact, so a farmer who asked, was set up, and asked again later keeps both records.
    await tx`
      update farmer_onboarding_requests
      set settled_at = ${input.occurredAt.toISOString()},
          settled_by_administrator_id = ${input.administratorId},
          authorization_id = ${authorizationId}
      where id = ${input.requestId} and settled_at is null
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('farmer_authorized', ${input.administratorId}, 'farmer_authorization',
        ${authorizationId}, ${input.occurredAt.toISOString()})
    `;

    // Tell the farmer, in the same transaction (max's decision). A farmer authorized on
    // Tuesday otherwise has no idea until they guess, and splitting this out would leave a
    // window in which someone is authorized and uninformed — or told they are set up when
    // the authorization was rolled back.
    //
    // **Approval is not consent, and this is where that stays true.** The category is
    // proactive, so `authorizeDispatch` re-reads the recipient's consent at the claim and
    // SUPPRESSES this message for a farmer who never texted JOIN/START. Queuing is
    // unconditional; sending is not. Nothing here may shortcut that — a `required_reply`
    // category would deliver it to someone who never opted in, which is precisely the
    // bypass the design forbids.
    await queueOutbox(tx, {
      logicalKey: `farmer-authorized-${authorizationId}`,
      recipientHash: contactHash,
      messageCategory: "inventory_prompt",
      body: FARMER_AUTHORIZED_NOTIFICATION,
      now: input.occurredAt,
    });

    return { status: "authorized" as const, authorizationId };
  }) as Promise<AuthorizeFarmerResult>;
}

export interface RevokeFarmerAuthorizationInput {
  authorizationId: string;
  administratorId: string;
  occurredAt: Date;
}

export type RevokeFarmerAuthorizationResult =
  | { status: "revoked" }
  | { status: "not_authorized" }
  | { status: "not_an_administrator" };

/**
 * Withdraw a farmer's authority.
 *
 * **This is the only safety net the standing link has**, so it does two things in one
 * transaction: it revokes the authorization, and it revokes every live link pointing at it.
 * The link revocation is belt-and-braces rather than load-bearing — `resolveFarmerLink`
 * re-reads the authorization on every request, so a link whose authorization is revoked
 * already resolves to nothing. Marking the rows too means the operator queue tells the truth
 * about what is live, instead of showing a link that is dead in fact but open in the table.
 *
 * The authorization row is UPDATED, never deleted: `inventory_revisions` references the
 * authorization each publication was made under, and erasing it would erase the answer to
 * "who published this, and under whose authority".
 *
 * Subsequent publication refuses because `confirmInventoryPublication` re-reads authority
 * while holding its locks — the same shape as `revokeFarmApproval`.
 */
export async function revokeFarmerAuthorization(
  db: Db,
  input: RevokeFarmerAuthorizationInput,
): Promise<RevokeFarmerAuthorizationResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const revoked = await tx`
      update farmer_authorizations
      set revoked_at = ${input.occurredAt.toISOString()}
      where id = ${input.authorizationId} and revoked_at is null
      returning id
    `;
    if (revoked.length === 0) return { status: "not_authorized" as const };

    await tx`
      update farmer_links
      set revoked_at = ${input.occurredAt.toISOString()}
      where authorization_id = ${input.authorizationId} and revoked_at is null
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('farmer_authorization_revoked', ${input.administratorId},
        'farmer_authorization', ${input.authorizationId},
        ${input.occurredAt.toISOString()})
    `;

    return { status: "revoked" as const };
  }) as Promise<RevokeFarmerAuthorizationResult>;
}

export type OpenOnboardingRequestResult =
  | {
      status: "opened";
      requestId: string;
      /**
       * True when THIS request established launch-program SMS consent — an invited SIGNUP
       * whose agreement box was ticked, from a sender with no consent record yet.
       *
       * False covers three different senders who all need the same thing said to them or
       * not: a bare uninvited SIGNUP, an invitation nobody ticked, and someone who already
       * had a record (active or stopped). The caller distinguishes the last of those with
       * `hadConsentRecord`, because a farmer who already consented must not be told to
       * text JOIN.
       */
      consentEstablished: boolean;
      /** Whether a consent record existed BEFORE this request, whatever its state. */
      hadConsentRecord: boolean;
      /**
       * The authorization this redemption granted (F-067), or null when it granted none.
       *
       * Null covers every path that still needs a human: a bare uninvited SIGNUP, an
       * invitation naming no farm yet, an untickd agreement, and a farmer already authorized
       * for that farm. In each the onboarding request stays open for VIGA.
       */
      authorizationId: string | null;
    }
  | { status: "already_open" }
  | { status: "invalid_invitation" };

/**
 * Record that a farmer asked to be set up. **Grants nothing.**
 *
 * This is the one function in this module reachable from an unauthenticated inbound SMS, and
 * everything about it is shaped for that: it writes to a table with no grant column, stores no
 * message text, and a plain SIGNUP names no farm. An invited SIGNUP may carry an opaque
 * administrator-created reference, so VIGA can see the farm the invitation named without the
 * farmer getting to choose or authorize it.
 *
 * **The one-open-request rule is enforced by the unique index, not by a read.** A farmer who
 * texts the keyword five times because nothing visibly happened sends a burst, and two
 * concurrent inserts would both observe "none open" before either wrote. `select … for
 * update` cannot rescue it — it locks rows that EXIST, and the first request has no row to
 * lock (the same reasoning B-011 and GL-004 needed). So the exclusion lives in `on conflict
 * do nothing returning id`, where the EMPTY result IS the signal that another request won.
 */
export async function openFarmerOnboardingRequest(
  db: Db,
  input: {
    contactHash: string;
    occurredAt: Date;
    invitationToken?: string;
    /** The inbound event this request came from, recorded as the consent evidence. */
    providerEventId?: string;
  },
): Promise<OpenOnboardingRequestResult> {
  const invitationToken = input.invitationToken;
  if (invitationToken !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(invitationToken)) {
      return { status: "invalid_invitation" };
    }
    return driver(db).begin(async (tx) => {
      const invitations = await tx`
        select id, agreed_to_sms_at, farm_id, created_by_administrator_id
        from farmer_invitations
        where token_hash = ${hashFarmerInviteToken(invitationToken)}
          and redeemed_at is null
          and expires_at > ${input.occurredAt.toISOString()}
        for update
      `;
      const invitationId = invitations[0]?.id as string | undefined;
      if (invitationId === undefined) return { status: "invalid_invitation" as const };
      const agreedToSmsAt =
        (invitations[0]?.agreed_to_sms_at as Date | null | undefined) ?? null;
      const invitationFarmId = (invitations[0]?.farm_id as string | null | undefined) ?? null;
      const invitedByAdministratorId = invitations[0]?.created_by_administrator_id as string;

      const inserted = await tx`
        insert into farmer_onboarding_requests (contact_hash, invitation_id, requested_at)
        values (${input.contactHash}, ${invitationId}, ${input.occurredAt.toISOString()})
        on conflict (contact_hash) where settled_at is null do nothing
        returning id
      `;
      const requestId = inserted[0]?.id as string | undefined;
      if (requestId === undefined) return { status: "already_open" as const };

      await tx`
        update farmer_invitations
        set redeemed_at = ${input.occurredAt.toISOString()}
        where id = ${invitationId} and redeemed_at is null
      `;

      // The consent write, IN THIS TRANSACTION. It cannot be a follow-up call: the
      // invitation is now spent, so a crash between the two would leave the farmer
      // un-consented with no retry — the second SIGNUP finds a redeemed invitation and the
      // "your farm is ready" text stays suppressed forever. That is the exact silent dead
      // end this work exists to close.
      //
      // `firstTimeOnly` is what makes onboarding safe as an opt-in path. It refuses when
      // ANY record exists, so a farmer who already texted JOIN keeps one unchanged record,
      // and a person who texted STOP is never silently re-enrolled by filling in a web
      // form. Both are decided inside `applyConsentTransitionIn`'s own lock, by the same
      // rules JOIN gets — this function states no consent rule of its own.
      //
      // Read BEFORE the write. Afterwards every consenting sender looks like one who
      // already had a record, and the reply would drop the opt-in receipt it owes them.
      const hadConsentRecord = await hasConsentRecord(tx, input.contactHash);
      const consent =
        agreedToSmsAt === null
          ? null
          : await applyConsentTransitionIn(tx, {
              recipientHash: input.contactHash,
              transition: "start",
              occurredAt: input.occurredAt,
              providerEventId: input.providerEventId ?? `onboarding-${requestId}`,
              captureSource: "farmer_onboarding",
              firstTimeOnly: true,
            });

      // F-067 — THE INVITATION IS THE AUTHORIZATION DECISION, so redeeming it sets the farmer
      // up. A coordinator chose this farm and sent the link to this person; the queue click
      // that used to follow re-approved a decision already made, which is why the code it
      // replaces could say "VIGA always approves".
      //
      // The gate is the same evidence consent rides on: an invitation that names a farm, whose
      // agreement was ticked, redeemed from the handset. Each part is load-bearing —
      //   - no farm named (a new-farm invitation, or a bare SIGNUP) → nothing to authorize, so
      //     the request stays open for VIGA. That path is still a human's.
      //   - no tick → no informed opt-in, and authorizing here would set someone up for
      //     messages they never agreed to.
      // Both fall through to the queue rather than failing, which is what keeps the uninvited
      // path exactly as ungranted as it has always been.
      //
      // In THIS transaction, for the reason the consent write above already gives: the
      // invitation is now spent, so a crash between the two would leave a farmer consented,
      // unauthorized, and holding a token that can never be redeemed again.
      const authorizationId =
        invitationFarmId === null || agreedToSmsAt === null
          ? null
          : await authorizeInvitedFarmerIn(tx, {
              farmId: invitationFarmId,
              contactHash: input.contactHash,
              requestId,
              invitedByAdministratorId,
              occurredAt: input.occurredAt,
            });

      return {
        status: "opened" as const,
        requestId,
        consentEstablished: consent?.applied === true,
        hadConsentRecord,
        authorizationId,
      };
    }) as Promise<OpenOnboardingRequestResult>;
  }

  const inserted = await driver(db)`
    insert into farmer_onboarding_requests (contact_hash, requested_at)
    values (${input.contactHash}, ${input.occurredAt.toISOString()})
    on conflict (contact_hash) where settled_at is null do nothing
    returning id
  `;
  const requestId = inserted[0]?.id as string | undefined;
  // An uninvited SIGNUP establishes no consent and never has. There is no web page in that
  // path to have shown an agreement on, so there is nothing an opt-in could rest on.
  return requestId === undefined
    ? { status: "already_open" }
    : {
        status: "opened",
        requestId,
        consentEstablished: false,
        hadConsentRecord: await hasConsentRecord(driver(db), input.contactHash),
        // An uninvited SIGNUP names no farm and carries no decision — this is the path that
        // must stay VIGA's, since anyone with the number can reach it.
        authorizationId: null,
      };
}

/**
 * Set an invited farmer up for the farm their invitation named, inside the redemption
 * transaction. Returns the new authorization, or null when one already existed.
 *
 * **This is `authorizeFarmer` minus the administrator, and deliberately nothing else.** The
 * same row, the same uniqueness rule, the same settle of the open request, the same
 * notification. What differs is who is recorded as having acted: the audit event names the
 * FARMER's contact hash rather than an operator, because attributing a self-serve setup to a
 * coordinator who never clicked anything would put a false claim in the audit trail.
 *
 * `phone_verified_at` is this same moment, and the schema requires it to precede
 * authorization. What verifies the phone is that the redemption arrived from it — the whole
 * evidentiary basis of the invited path.
 */
async function authorizeInvitedFarmerIn(
  tx: Tx,
  input: {
    farmId: string;
    contactHash: string;
    requestId: string;
    /** The administrator who minted the invitation — the approval's honest actor. */
    invitedByAdministratorId: string;
    occurredAt: Date;
  },
): Promise<string | null> {
  const contacts = await tx`
    select id from contacts where phone_hash = ${input.contactHash}
  `;
  const contactId = contacts[0]?.id as string | undefined;
  // The webhook writes the contact at ingress before routing, so this is unreachable in the
  // SMS path. Returning null rather than throwing keeps a caller that reaches it any other
  // way from losing the consent and redemption this transaction already did.
  if (contactId === undefined) return null;

  // Locked for the reason `authorizeFarmer` states: two concurrent redemptions must not both
  // see "none" and race the partial unique index into an error.
  const existing = await tx`
    select id from farmer_authorizations
    where farm_id = ${input.farmId} and contact_id = ${contactId}
      and revoked_at is null
    for update
  `;
  if (existing.length > 0) return null;

  const inserted = await tx`
    insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
    values (
      ${input.farmId}, ${contactId}, ${input.occurredAt.toISOString()},
      ${input.occurredAt.toISOString()}
    )
    returning id
  `;
  const authorizationId = inserted[0]?.id as string;

  // APPROVE THE FARM TOO. Authorization and approval are two independent gates —
  // `confirmProposal` checks `farmer_authorizations`, then `farm_approvals`, and returns
  // `not_approved` when the second is missing. Granting only the first would leave the farmer
  // authorized, texted "your farm is ready", and refused on their very first update: the same
  // silent dead end this feature closes, moved one step later.
  //
  // The approval names the administrator who CREATED THE INVITATION, which is honest rather
  // than convenient. That is the person who decided this farm participates, at the moment they
  // minted a one-use link naming it — the same decision the authorization inherits.
  //
  // THE INDEX IS THE ARBITER, not a preceding read. `farm_approvals_one_current_per_farm` is a
  // PARTIAL unique index, and `select … for update` cannot serialize a row that does not exist
  // yet — two concurrent redemptions for one farm would both observe "unapproved" and the second
  // insert would raise. `on conflict do nothing` makes an already-approved farm a no-op instead,
  // which is the same first-insert-race reasoning B-011 and F-050 needed.
  await tx`
    insert into farm_approvals (farm_id, administrator_id, approved_at)
    values (
      ${input.farmId}, ${input.invitedByAdministratorId},
      ${input.occurredAt.toISOString()}
    )
    on conflict (farm_id) where revoked_at is null do nothing
  `;

  // Settle the ask this answers. Without it the queue would keep showing a request that has
  // already been granted, and an operator would work it twice.
  await tx`
    update farmer_onboarding_requests
    set settled_at = ${input.occurredAt.toISOString()},
        authorization_id = ${authorizationId}
    where id = ${input.requestId} and settled_at is null
  `;

  await tx`
    insert into audit_events (action, actor_contact_hash, subject_type, subject_id,
      occurred_at)
    values ('farmer_authorized', ${input.contactHash}, 'farmer_authorization',
      ${authorizationId}, ${input.occurredAt.toISOString()})
  `;

  // The same notification VIGA's click used to queue. Still an `inventory_prompt` — a
  // proactive category — so `authorizeDispatch` re-reads consent at the claim and suppresses
  // it for anyone who never opted in. Authorization is not consent, and this path must not
  // become the exception that pretends otherwise.
  await queueOutbox(tx, {
    logicalKey: `farmer-authorized-${authorizationId}`,
    recipientHash: input.contactHash,
    messageCategory: "inventory_prompt",
    body: FARMER_AUTHORIZED_NOTIFICATION,
    now: input.occurredAt,
  });

  return authorizationId;
}

/** Whether this sender has any launch consent record at all, active or stopped. */
async function hasConsentRecord(sql: Sql | Tx, contactHash: string): Promise<boolean> {
  const rows = await sql`
    select 1 from sms_consents where recipient_hash = ${contactHash}
  `;
  return rows.length > 0;
}

export type IssueFarmerLinkResult =
  | { status: "issued"; token: string }
  | { status: "not_authorized" };

/**
 * Mint the farmer's standing link, replacing any previous one.
 *
 * **Re-issuing REVOKES the previous link in the same transaction.** That is the "I lost my
 * phone" case, and leaving the old link live would defeat the point of asking for a new one.
 * The partial unique index enforces one live link per authorization, so this is the database's
 * rule rather than this function's promise.
 *
 * The raw token is returned to the caller ONCE and never stored — only its hash reaches the
 * table. Nothing can read a farmer's live link back out of the database, including the
 * operator queue, which reports only whether one exists.
 *
 * Refuses outright for a revoked or unknown authorization: a link is a pointer to authority,
 * so minting one for authority that does not exist would create a key to nothing that an
 * operator could mistake for access.
 */
export async function issueFarmerLink(
  db: Db,
  input: {
    authorizationId: string;
    salesLocationId: string;
    occurredAt: Date;
  },
): Promise<IssueFarmerLinkResult> {
  return driver(db).begin(async (tx) => {
    const issued = await issueFarmerLinkIn(tx, input);
    return issued === null
      ? { status: "not_authorized" as const }
      : { status: "issued" as const, token: issued.token };
  }) as Promise<IssueFarmerLinkResult>;
}

/**
 * Mint a farmer link inside a caller's transaction. `null` means not authorized.
 *
 * Extracted so F-073's web request can issue a link and queue the text that carries it in ONE
 * transaction — a link written but never sent is a credential the farmer cannot use and cannot
 * ask for again without revoking. One issuer, so the SMS and web doors cannot drift in how they
 * revoke, what they record, or which stand a link names.
 */
async function issueFarmerLinkIn(
  tx: Tx,
  input: {
    authorizationId: string;
    salesLocationId: string;
    occurredAt: Date;
  },
): Promise<{ token: string; linkId: string } | null> {
  // Publication lock order: location before authorization. Link issuance names no sender
  // state or proposal, so these are the first two shared resources it can touch.
  const locations = await tx`
    select id, owner_farm_id from sales_locations
    where id = ${input.salesLocationId}
    for update
  `;
  const ownerFarmId = locations[0]?.owner_farm_id as string | undefined;
  if (ownerFarmId === undefined) return null;

  const authorization = await tx`
    select id, farm_id from farmer_authorizations
    where id = ${input.authorizationId}
      and farm_id = ${ownerFarmId}
      and revoked_at is null
    for update
  `;
  if (authorization.length === 0) return null;

  await tx`
    update farmer_links
    set revoked_at = ${input.occurredAt.toISOString()}
    where authorization_id = ${input.authorizationId} and revoked_at is null
  `;

  const token = issueFarmerLinkToken();
  const inserted = await tx`
    insert into farmer_links (
      token_hash, authorization_id, owner_farm_id, sales_location_id, issued_at
    )
    values (
      ${hashFarmerLinkToken(token)}, ${input.authorizationId}, ${ownerFarmId},
      ${input.salesLocationId},
      ${input.occurredAt.toISOString()}
    )
    returning id
  `;

  return { token, linkId: inserted[0]?.id as string };
}

/**
 * Who a standing link speaks for — the ONE stand it may propose a listing on.
 *
 * This resolves the credential directly, and it carries the same load-bearing property:
 * **the lookup is per-request, so revocation is immediate.** Nothing about the answer is
 * cached, signed, or carried in the link, so there is no state that could keep saying "valid"
 * after the authority behind it was withdrawn. Both `revoked_at` columns are checked here,
 * every time.
 *
 * The projection is deliberately minimal, and that minimality is the blast radius. It returns
 * ONE farm, ONE sales location, and the farmer's own hash — so a leaked link has nothing to
 * name but the stand it was issued for. There is no farm list, no other farmer's data, no
 * customer data, and no way to widen it from the request: the token selects a row, and the row
 * selects the farm.
 *
 * The link itself names the one exact stand. Which stand a listing lands on decides whose shelf
 * a customer drives to, so resolution never guesses from the farm's other locations.
 */
export interface ResolvedFarmerLink {
  authorizationId: string;
  farmId: string;
  salesLocationId: string;
  /** The farmer's phone hash — the sender identity the proposal is keyed to. */
  senderHash: string;
}

export async function resolveFarmerLink(
  db: Db,
  input: { tokenHash: string },
): Promise<ResolvedFarmerLink | null> {
  const rows = await driver(db)`
    select
      auth.id as authorization_id,
      auth.farm_id,
      contact.phone_hash,
      location.id as sales_location_id
    from farmer_links as link
    join farmer_authorizations as auth
      on auth.id = link.authorization_id
    join contacts as contact on contact.id = auth.contact_id
    join sales_locations as location
      on location.id = link.sales_location_id
      and location.owner_farm_id = link.owner_farm_id
      and link.owner_farm_id = auth.farm_id
    where link.token_hash = ${input.tokenHash}
      and link.revoked_at is null
      and auth.revoked_at is null
  `;

  const row = rows[0];
  if (row === undefined) return null;
  return {
    authorizationId: row.authorization_id as string,
    farmId: row.farm_id as string,
    salesLocationId: row.sales_location_id as string,
    senderHash: row.phone_hash as string,
  };
}

/**
 * Open the confirmation window for a proposal the farmer is looking at on the web (F-040).
 *
 * **Why this exists at all.** `activateAcceptedPrompt` starts the window when Telnyx accepts
 * the prompt, and that is exactly right for SMS: a `YES` that predates its own prompt must
 * not commit, because the farmer may be answering a message they have not seen. On the web
 * there is no carrier and no prompt — the farmer is reading the snapshot in the same session
 * — so waiting for a provider acceptance that will never arrive would leave the gate
 * reporting `not_activated` forever and the web path unable to publish anything.
 *
 * **What it deliberately does NOT do: weaken the gate.** It opens the window and nothing
 * else. Every other check `confirmInventoryPublication` performs still runs, under its own
 * locks, on the same proposal row: version binding, expiry, base-revision conflict, live
 * farmer authority, live VIGA approval, and exactly-once consumption. This is the one fact
 * that genuinely differs between a carrier round trip and a browser round trip, expressed
 * once rather than by relaxing a condition somewhere else.
 *
 * Guards mirror `activateAcceptedPrompt`: it matches only an `open` proposal, and copies
 * `activated_version` from `proposal_version` **in SQL**, so a concurrent revision cannot be
 * confirmed under a version it already superseded.
 */
export async function activateWebProposal(
  db: Db,
  input: {
    proposalId: string;
    senderHash: string;
    /** The snapshot the farmer is being shown, so the SMS record says what they saw. */
    confirmationText: string;
    at: Date;
  },
): Promise<void> {
  await driver(db).begin(async (tx) => {
    // The activation record needs a message it activated FROM. That is not bookkeeping the
    // schema demands for its own sake: `activation_coherent` exists so a proposal cannot be
    // committable without a prompt the farmer was actually shown, and inventing a NULL
    // outbox id to satisfy the shape would hollow that out.
    //
    // So the web path queues a REAL message — the same confirmation the SMS path sends. The
    // farmer gets a record of what they published on the channel they already trust, which
    // is worth having on its own: a browser tab is not a receipt. Consent still gates
    // delivery at the dispatch claim, so a farmer with no consent record simply does not
    // receive it, and the proposal is still activated and confirmable on the page.
    const prompt = await tx`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at,
        available_at, created_at
      )
      values (
        ${`web-proposal-${input.proposalId}`}, ${input.senderHash},
        'inventory_confirmation', ${input.confirmationText},
        ${new Date(input.at.getTime() + WEB_BODY_TTL_MS).toISOString()},
        ${input.at.toISOString()}, ${input.at.toISOString()}
      )
      on conflict (logical_key) do update set logical_key = excluded.logical_key
      returning id
    `;

    // `activated_version` is copied from `proposal_version` IN SQL, so a concurrent revision
    // cannot be confirmed under a version it already superseded — the same reasoning
    // `activateAcceptedPrompt` documents.
    await tx`
      update inventory_publication_proposals
      set activation_outbox_id = ${prompt[0]?.id as string},
          activated_version = proposal_version,
          activated_at = ${input.at.toISOString()},
          expires_at = ${new Date(
            input.at.getTime() + WEB_CONFIRMATION_WINDOW_MS,
          ).toISOString()},
          updated_at = ${input.at.toISOString()}
      where id = ${input.proposalId}
        and sender_hash = ${input.senderHash}
        and state = 'open'
    `;
  });
}

/** Retention window for the queued confirmation body. Matches the SMS path's. */
const WEB_BODY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a web confirmation stays live once the snapshot is shown.
 *
 * Shorter than the SMS window (12 hours) on purpose. That one is generous because a farmer
 * may be in a field and read the text hours later; here they are looking at the page. A
 * window that outlives the sitting is a proposal that can be confirmed by whoever finds the
 * browser open, which is a different risk from the one the SMS window is sized for.
 */
export const WEB_CONFIRMATION_WINDOW_MS = 60 * 60 * 1000;

export interface FarmerAuthorizationRow {
  authorizationId: string;
  farmId: string;
  farmName: string;
  /** The last four digits, already masked. Never the number, never the hash. */
  senderMask: string;
  authorizedAt: Date;
  revokedAt: Date | null;
  stands: Array<{ salesLocationId: string; name: string }>;
  /** Whether a live standing link exists. Never the link itself. */
  hasLiveLink: boolean;
  liveLinkStand: { salesLocationId: string; name: string } | null;
}

/**
 * Every farmer's access, live and withdrawn — the "VIGA can SEE every farmer's access" half
 * of the safety net.
 *
 * Revoked rows are included on purpose: a queue showing only live access cannot answer "who
 * did we revoke, and when", which is the first question asked after a lost phone.
 *
 * **Phones are masked at the QUERY** (`right(phone_e164, 4)`), so the full number is never
 * materialized in application memory — the same discipline `review.ts` follows, and the same
 * `maskPhoneSuffix` renderer, rather than a second way to show a phone.
 *
 * `hasLiveLink` is a BOOLEAN, never the token or its hash. The operator learns that a farmer
 * has a working link; the queue never becomes a place to read a standing credential off a
 * screen.
 */
export async function listFarmerAuthorizations(
  db: Db,
): Promise<FarmerAuthorizationRow[]> {
  const rows = await driver(db)`
    select
      auth.id,
      auth.farm_id,
      farm.name as farm_name,
      right(contact.phone_e164, 4) as sender_last_four,
      auth.authorized_at,
      auth.revoked_at,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('salesLocationId', location.id, 'name', location.name)
          order by location.name, location.id
        )
        from sales_locations as location
        where location.owner_farm_id = auth.farm_id
      ), '[]'::jsonb) as stands,
      (
        select jsonb_build_object(
          'salesLocationId', location.id, 'name', location.name
        )
        from farmer_links as link
        join sales_locations as location
          on location.id = link.sales_location_id
          and location.owner_farm_id = link.owner_farm_id
        where link.authorization_id = auth.id
          and link.owner_farm_id = auth.farm_id
          and link.revoked_at is null
        limit 1
      ) as live_link_stand
    from farmer_authorizations as auth
    join farms as farm on farm.id = auth.farm_id
    join contacts as contact on contact.id = auth.contact_id
    order by farm.name, auth.authorized_at
  `;

  return rows.map((row) => ({
    authorizationId: row.id as string,
    farmId: row.farm_id as string,
    farmName: row.farm_name as string,
    senderMask: maskPhoneSuffix((row.sender_last_four as string | null) ?? null),
    authorizedAt: new Date(row.authorized_at as string),
    revokedAt:
      row.revoked_at === null ? null : new Date(row.revoked_at as string),
    stands: row.stands as Array<{ salesLocationId: string; name: string }>,
    hasLiveLink: row.live_link_stand !== null,
    liveLinkStand: row.live_link_stand as {
      salesLocationId: string;
      name: string;
    } | null,
  }));
}

export interface FarmAwaitingOnboardingRow {
  farmId: string;
  farmName: string;
  /**
   * The newest invitation's state, or `none` when no one has ever invited this farm.
   * `open` means a link is out there and still works; `expired` means it has lapsed.
   */
  invitationState: "none" | "open" | "expired";
  /** When the newest invitation stops working. NULL when there is no invitation. */
  invitationExpiresAt: Date | null;
}

/**
 * Every farm nobody can currently publish for (F-071).
 *
 * max asked to see the onboarding link for a farm that has not finished onboarding, "in case
 * they lose it". The link itself is **not recoverable** — `farmer_invitations` stores only
 * `token_hash` and the token is returned exactly once — so what an operator needs is this list
 * plus the ability to mint a fresh link, which is the same shape as a password reset.
 *
 * **"Unfinished" is the absence of a LIVE AUTHORIZATION, not an unredeemed invitation.** The
 * two come apart in both directions and each direction matters: VIGA can authorize a farmer
 * straight from the queue with no invitation involved (that farm is finished, and keying on
 * redemption would strand it here forever), and a farm whose only farmer was revoked has
 * nobody who can update it again (so it belongs back on this list).
 *
 * An EXPIRED invitation keeps the farm listed rather than dropping it. A farmer who lost their
 * link usually notices after it lapsed, so hiding those would hide exactly the farms an
 * operator came here to find.
 *
 * Carries no token, no hash, and no phone number — an operator needs the farm and the state,
 * and nothing here needs a contact (Golden Rule #5).
 */
export async function listFarmsAwaitingOnboarding(
  db: Db,
  now: Date,
): Promise<FarmAwaitingOnboardingRow[]> {
  const rows = await driver(db)`
    select
      farm.id,
      farm.name,
      -- A correlated subquery rather than a join, so a farm re-invited three times stays ONE
      -- row. A join would multiply the farm by its invitations, and the state shown would be
      -- whichever row the reader happened to reach first.
      (
        select invitation.expires_at
        from farmer_invitations as invitation
        where invitation.farm_id = farm.id
        order by invitation.created_at desc, invitation.id desc
        limit 1
      ) as invitation_expires_at
    from farms as farm
    where not exists (
      select 1 from farmer_authorizations as auth
      where auth.farm_id = farm.id and auth.revoked_at is null
    )
    order by farm.name, farm.id
  `;

  return rows.map((row) => {
    const expiresAt =
      row.invitation_expires_at === null
        ? null
        : new Date(row.invitation_expires_at as string);
    return {
      farmId: row.id as string,
      farmName: row.name as string,
      invitationState:
        expiresAt === null ? "none" : expiresAt > now ? "open" : "expired",
      invitationExpiresAt: expiresAt,
    };
  });
}

// ── F-072: the grandfathered onboarding door ──────────────────────────────────────────────
//
// VIGA's Google form is replaced by one global link with a farm dropdown and NO invitation
// behind it (max, 2026-08-06). There is no phone roster to verify a claimant against — VIGA
// never supplied one — so the honour system is the whole claim, and the only thing keeping the
// door narrow is WHICH farms it can reach.
//
// **"Claimable" is the same predicate F-071's operator list uses**: a farm nobody can currently
// publish for, which is the ABSENCE OF A LIVE AUTHORIZATION — never an unredeemed invitation.
// Stated once, below, and shared by the public list and the resolver so the convenience and the
// guarantee cannot drift apart. Keying on invitations instead would strand a farm VIGA
// authorized straight from the queue and miss a farm whose only farmer was revoked.

/**
 * The claimable predicate, written ONCE.
 *
 * Inlined into both readers rather than duplicated: the dropdown is a convenience and the
 * resolver is the guarantee, and two copies of this rule is exactly how a farm ends up
 * omitted from the list but still claimable by anyone who posts its id.
 */
/**
 * A farm id's shape, checked before it reaches a query.
 *
 * Postgres raises on a malformed uuid rather than returning no rows, so a public endpoint
 * handed junk would 500 instead of answering. Checked here so every caller gets the same
 * refusal without restating the rule.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_LIVE_FARMER = (alias: string) => `
  not exists (
    select 1 from farmer_authorizations as auth
    where auth.farm_id = ${alias}.id and auth.revoked_at is null
  )
`;

export interface ClaimableFarmRow {
  farmId: string;
  farmName: string;
}

/**
 * Every farm a grandfathered farmer may claim, for the PUBLIC dropdown (F-072).
 *
 * Carries the farm and nothing else. This is the one farm reader reachable with no credential
 * at all, so it exposes no invitation state, no token, no hash, and no contact — an operator
 * needs that context and an anonymous visitor does not (Golden Rule #5).
 *
 * A farm being unclaimed is not a secret: participation is already public on the map, and max
 * confirmed (2026-08-06) the page may say plainly that a farm is already set up.
 */
export async function listClaimableFarms(
  db: Db,
  scope: { includeTestFarms: boolean } = { includeTestFarms: false },
): Promise<ClaimableFarmRow[]> {
  const rows = await driver(db).unsafe(`
    select farm.id, farm.name
    from farms as farm
    where ${NO_LIVE_FARMER("farm")}
      and ${visibleFarms("farm", scope.includeTestFarms)}
    order by farm.name, farm.id
  `);
  return rows.map((row) => ({
    farmId: row.id as string,
    farmName: row.name as string,
  }));
}

export interface SelfServiceFarmRow {
  farmId: string;
  farmName: string;
  /** True when someone can already publish for this farm, so it may not be claimed. */
  onboarded: boolean;
}

/**
 * Every farm, for the public picker (F-072 / F-073), saying which already have a farmer.
 *
 * The picker needs BOTH kinds because it routes rather than merely offering: a farmer whose
 * farm is already set up must be told so and sent to the update path, not left thinking their
 * farm is missing. `listClaimableFarms` is the same rule with the onboarded ones dropped, and
 * an integration test asserts the two cannot disagree.
 *
 * That a farm is set up is not a secret — participation is already public on the map, and max
 * confirmed (2026-08-06) the page may say so plainly. It still carries the farm and nothing
 * else: no invitation state, no token, no hash, no contact (Golden Rule #5).
 */
export async function listFarmsForSelfService(
  db: Db,
  scope: { includeTestFarms: boolean } = { includeTestFarms: false },
): Promise<SelfServiceFarmRow[]> {
  const rows = await driver(db).unsafe(`
    select farm.id, farm.name, not ${NO_LIVE_FARMER("farm")} as onboarded
    from farms as farm
    where ${visibleFarms("farm", scope.includeTestFarms)}
    order by farm.name, farm.id
  `);
  return rows.map((row) => ({
    farmId: row.id as string,
    farmName: row.name as string,
    onboarded: row.onboarded as boolean,
  }));
}

export type ClaimGrandfatheredFarmResult =
  | { status: "claimable"; farmId: string; farmName: string }
  | { status: "already_onboarded" }
  | { status: "unknown_farm" };

/**
 * Resolve a farm a grandfathered farmer picked, refusing one that already has a farmer.
 *
 * **This is the guarantee, and the dropdown's omission is not.** Anyone can post any farm id
 * to the endpoint above this, so "the list didn't offer it" protects nothing on its own. A
 * farm with a live farmer is refused here, which is what stops a stranger overwriting the
 * public listing of a farm whose farmer already onboarded.
 *
 * It grants no authority. Resolving says only "this farm has no farmer, so its listing may be
 * written through the grandfather door" — publishing INVENTORY still requires an authorization,
 * which still requires a handset. Nothing on this path writes `farmer_authorizations`.
 *
 * **A test farm is deliberately still claimable here** (F-074), even though the picker hides it.
 * That is not the picker's omission failing to be enforced — it is the whole point of a test
 * farm: walking onboarding end to end against real production is what one exists for, and a
 * farm nobody can claim could never be walked. Hiding it from the picker keeps a real farmer
 * from picking a fake farm by accident; it was never a secret, and a farm id is not one either.
 * What a test farm's claim CANNOT do is reach a customer, and that is enforced where it belongs
 * — in the three read sites, not here.
 */
export async function claimGrandfatheredFarm(
  db: Db,
  input: { farmId: string },
): Promise<ClaimGrandfatheredFarmResult> {
  // A malformed id names no farm. Checked before the query because Postgres RAISES on a bad
  // uuid rather than returning no rows, which would turn junk into a 500 on a public endpoint.
  if (!UUID_SHAPE.test(input.farmId)) return { status: "unknown_farm" };

  const rows = await driver(db).unsafe(
    `
      select farm.id, farm.name, ${NO_LIVE_FARMER("farm")} as claimable
      from farms as farm
      where farm.id = $1
    `,
    [input.farmId],
  );
  const row = rows[0];
  if (row === undefined) return { status: "unknown_farm" };
  if (row.claimable !== true) return { status: "already_onboarded" };
  return {
    status: "claimable",
    farmId: row.id as string,
    farmName: row.name as string,
  };
}

/**
 * The one answer this endpoint ever gives (F-073).
 *
 * **There is deliberately no "matched" or "not matched".** The caller is an anonymous web form,
 * and telling it whether a number belongs to a farmer would make the page a way to ask "is this
 * number a farmer?" about every number on the island. The real answer travels to the handset;
 * the screen learns only that the request was taken.
 */
export type RequestFarmerStandLinkResult = { status: "accepted" };

/**
 * Text an already-onboarded farmer their own stand link, from the public picker (F-073).
 *
 * A farmer who follows VIGA's old weekly-status link and picks a farm that already has a farmer
 * needs a way in, and there is no farmer login. They enter the number they onboarded with; if it
 * is a live farmer on that farm, this queues their private link to that handset.
 *
 * **The phone is matched by HASH, never read.** `contacts.phone_hash` is the lookup key and the
 * raw column is touched only by the outbound send path (Golden Rule #5). Nothing here logs,
 * returns, or reads a raw number.
 *
 * **Every failure is silent and identical**: wrong number, a farmer of another farm, a revoked
 * authorization, an unknown farm, a farm with no stand. Each queues nothing and answers
 * `accepted`, so the timing and the response are the same either way.
 *
 * This grants nothing new. It re-sends a credential the farmer already has a right to, exactly
 * as the SMS `LINK` keyword does — and `issueFarmerLink` revokes their previous link, so asking
 * twice does not leave two live credentials.
 */
export async function requestFarmerStandLink(
  db: Db,
  input: {
    farmId: string;
    /** The hash of the number the farmer typed. The raw number never reaches this function. */
    contactHash: string;
    occurredAt: Date;
    publicBaseUrl: string;
  },
): Promise<RequestFarmerStandLinkResult> {
  const accepted = { status: "accepted" as const };
  if (!UUID_SHAPE.test(input.farmId)) return accepted;

  return driver(db).begin(async (tx) => {
    // One query for the whole match: a LIVE authorization on THIS farm held by the contact with
    // THIS hash, and a stand belonging to that same farm. Being a farmer somewhere must not
    // open every farm, so the authorization is joined to the requested farm rather than to the
    // contact alone.
    const matches = await tx`
      select auth.id as authorization_id, location.id as sales_location_id
      from farmer_authorizations as auth
      join contacts as contact on contact.id = auth.contact_id
      join sales_locations as location on location.owner_farm_id = auth.farm_id
      where auth.farm_id = ${input.farmId}
        and contact.phone_hash = ${input.contactHash}
        and auth.revoked_at is null
        and location.retired_at is null
      order by location.name, location.id
      limit 1
    `;
    const match = matches[0];
    if (match === undefined) return accepted;

    const issued = await issueFarmerLinkIn(tx, {
      authorizationId: match.authorization_id as string,
      salesLocationId: match.sales_location_id as string,
      occurredAt: input.occurredAt,
    });
    if (issued === null) return accepted;

    // Queued in the SAME transaction as the issuance: a link written but never sent is a
    // credential the farmer cannot use and cannot ask for again without revoking this one.
    //
    // The category is `inventory_prompt`, matching the SMS LINK flow — proactive, so
    // `authorizeDispatch` re-reads consent at the claim and suppresses this for a farmer who
    // never opted in. Queuing is unconditional; sending is not.
    await queueOutbox(tx, {
      logicalKey: `farmer-web-link-${issued.linkId}`,
      recipientHash: input.contactHash,
      messageCategory: "inventory_prompt",
      body:
        `VIGA Farm Friend: Your private update link - keep it to yourself. ` +
        `${farmerLinkUrl(input.publicBaseUrl, issued.token)} Reply STOP to opt out.`,
      now: input.occurredAt,
    });

    return accepted;
  }) as Promise<RequestFarmerStandLinkResult>;
}

export interface FarmerOnboardingRequestRow {
  requestId: string;
  senderMask: string;
  requestedAt: Date;
  farmId: string | null;
  farmName: string | null;
}

/**
 * The open onboarding queue — farmers who asked and are waiting on VIGA.
 *
 * Only OPEN requests: this is a work queue, and a settled ask is history rather than work.
 * `listFarmerAuthorizations` is where the outcome shows up.
 *
 * Masked at the query, like every other operator surface. A request carries no message text
 * at all, so there is nothing else here to leak.
 */
export async function listOpenFarmerOnboardingRequests(
  db: Db,
): Promise<FarmerOnboardingRequestRow[]> {
  const rows = await driver(db)`
    select
      request.id,
      right(contact.phone_e164, 4) as sender_last_four,
      request.requested_at,
      invitation.farm_id,
      farm.name as farm_name
    from farmer_onboarding_requests as request
    join contacts as contact on contact.phone_hash = request.contact_hash
    left join farmer_invitations as invitation on invitation.id = request.invitation_id
    left join farms as farm on farm.id = invitation.farm_id
    where request.settled_at is null
    order by request.requested_at
  `;

  return rows.map((row) => ({
    requestId: row.id as string,
    senderMask: maskPhoneSuffix((row.sender_last_four as string | null) ?? null),
    requestedAt: new Date(row.requested_at as string),
    farmId: (row.farm_id as string | null) ?? null,
    farmName: (row.farm_name as string | null) ?? null,
  }));
}
