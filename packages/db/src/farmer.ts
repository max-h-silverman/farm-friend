import {
  hashFarmerLinkToken,
  issueFarmerLinkToken,
  maskPhoneSuffix,
} from "@farm-friend/core";
import type { Db } from "./index";
import type { Sql } from "./sql";

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
// function on this page reachable from an unauthenticated inbound SMS, and it writes to a
// table with no grant column. Every other write below demands an `administratorId` that was
// resolved from a session and is re-read here under lock. VIGA always approves — a phone
// proves possession of a phone, not ownership of a farm.

function driver(db: Db): Sql {
  return db.sql;
}

export interface AuthorizeFarmerInput {
  farmId: string;
  /** The farmer's phone hash. The raw number never reaches this layer. */
  contactHash: string;
  administratorId: string;
  occurredAt: Date;
}

export type AuthorizeFarmerResult =
  | { status: "authorized"; authorizationId: string }
  | { status: "already_authorized" }
  | { status: "not_an_administrator" }
  | { status: "unknown_farm" }
  | { status: "unknown_contact" };

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
 * If the farmer had an open onboarding request, it is SETTLED in the same transaction. The
 * queue would otherwise keep showing an ask that has already been answered, and an operator
 * would work it twice.
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

    const contact = await tx`
      select id from contacts where phone_hash = ${input.contactHash}
    `;
    const contactId = contact[0]?.id as string | undefined;
    if (contactId === undefined) return { status: "unknown_contact" as const };

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
      where contact_hash = ${input.contactHash} and settled_at is null
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('farmer_authorized', ${input.administratorId}, 'farmer_authorization',
        ${authorizationId}, ${input.occurredAt.toISOString()})
    `;

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
  | { status: "opened"; requestId: string }
  | { status: "already_open" };

/**
 * Record that a farmer asked to be set up. **Grants nothing.**
 *
 * This is the one function in this module reachable from an unauthenticated inbound SMS, and
 * everything about it is shaped for that: it writes to a table with no grant column, stores
 * no message text, and names no farm — the farmer does not get to choose which farm they are
 * claiming, VIGA decides that when they act.
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
  input: { contactHash: string; occurredAt: Date },
): Promise<OpenOnboardingRequestResult> {
  const inserted = await driver(db)`
    insert into farmer_onboarding_requests (contact_hash, requested_at)
    values (${input.contactHash}, ${input.occurredAt.toISOString()})
    on conflict (contact_hash) where settled_at is null do nothing
    returning id
  `;
  const requestId = inserted[0]?.id as string | undefined;
  return requestId === undefined
    ? { status: "already_open" }
    : { status: "opened", requestId };
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
  input: { authorizationId: string; occurredAt: Date },
): Promise<IssueFarmerLinkResult> {
  return driver(db).begin(async (tx) => {
    const authorization = await tx`
      select id from farmer_authorizations
      where id = ${input.authorizationId} and revoked_at is null
      for update
    `;
    if (authorization.length === 0) {
      return { status: "not_authorized" as const };
    }

    await tx`
      update farmer_links
      set revoked_at = ${input.occurredAt.toISOString()}
      where authorization_id = ${input.authorizationId} and revoked_at is null
    `;

    const token = issueFarmerLinkToken();
    await tx`
      insert into farmer_links (token_hash, authorization_id, issued_at)
      values (
        ${hashFarmerLinkToken(token)}, ${input.authorizationId},
        ${input.occurredAt.toISOString()}
      )
    `;

    return { status: "issued" as const, token };
  }) as Promise<IssueFarmerLinkResult>;
}

/**
 * Who a standing link speaks for — the ONE stand it may propose a listing on.
 *
 * This is the farmer-side `resolvePrincipal`, and it carries the same load-bearing property:
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
 * A farm with several sales locations resolves to none, rather than guessing. Which stand a
 * listing lands on decides whose shelf a customer drives to, so code asks rather than picking
 * — the same rule the SMS farmer branch already follows.
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
      location.id as sales_location_id,
      count(location.id) over () as location_count
    from farmer_links as link
    join farmer_authorizations as auth
      on auth.id = link.authorization_id
    join contacts as contact on contact.id = auth.contact_id
    join sales_locations as location on location.farm_id = auth.farm_id
    where link.token_hash = ${input.tokenHash}
      and link.revoked_at is null
      and auth.revoked_at is null
    order by location.id asc
  `;

  const row = rows[0];
  if (row === undefined) return null;
  // Several stands on one farm: ask rather than guess. Returning the first would silently
  // publish to a stand the farmer did not mean.
  if (Number(row.location_count) !== 1) return null;

  return {
    authorizationId: row.authorization_id as string,
    farmId: row.farm_id as string,
    salesLocationId: row.sales_location_id as string,
    senderHash: row.phone_hash as string,
  };
}

export interface FarmerAuthorizationRow {
  authorizationId: string;
  farmId: string;
  farmName: string;
  /** The last four digits, already masked. Never the number, never the hash. */
  senderMask: string;
  authorizedAt: Date;
  revokedAt: Date | null;
  /** Whether a live standing link exists. Never the link itself. */
  hasLiveLink: boolean;
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
      exists (
        select 1 from farmer_links as link
        where link.authorization_id = auth.id and link.revoked_at is null
      ) as has_live_link
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
    hasLiveLink: row.has_live_link === true,
  }));
}

export interface FarmerOnboardingRequestRow {
  requestId: string;
  senderMask: string;
  requestedAt: Date;
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
      request.requested_at
    from farmer_onboarding_requests as request
    join contacts as contact on contact.phone_hash = request.contact_hash
    where request.settled_at is null
    order by request.requested_at
  `;

  return rows.map((row) => ({
    requestId: row.id as string,
    senderMask: maskPhoneSuffix((row.sender_last_four as string | null) ?? null),
    requestedAt: new Date(row.requested_at as string),
  }));
}
