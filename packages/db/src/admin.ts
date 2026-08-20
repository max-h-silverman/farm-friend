import {
  ADMIN_SESSION_TTL_MS,
  isSessionLive,
  maskPhoneSuffix,
  renderStandItemPrice,
  type StandItemPrice,
} from "@farm-friend/core";
import type { Db } from "./index";
import type { Sql, Tx } from "./sql";

// The operator surface's durable writes (F-025a).
//
// Three things live here, and they share one property: authority is re-read from the
// database at the moment of the write, never inherited from something resolved earlier in
// the request. A principal is evidence that a caller was an administrator when the request
// started; only the row read inside the transaction proves they still are.
//
//   - session creation, resolution, and revocation;
//   - farm approval and revocation, recording who acted and when;
//
// Approval is deliberately a SEPARATE act from a farmer completing onboarding (the
// coordinator at a desk does not let an applicant approve themselves), and revocation is
// recorded rather than deleted, because the audit trail is the point.

function driver(db: Db): Sql {
  return db.sql;
}

/**
 * F-125 — two states, because there is no eligibility grant left to withhold.
 *
 * max, 2026-08-20: "there is no 'eligible'. they either take it or they don't." The third
 * state (`not_eligible`) was VIGA's grant, and keeping it would preserve the second mechanism
 * F-125 exists to delete — it is what let five production stands claim acceptance with no
 * grant behind it.
 */
export type FarmBucksStatus = "accepts" | "does_not_accept";

/**
 * Record whether one SELLER takes VIGA Farm Bucks (F-125).
 *
 * Keyed by the seller, not the stand: whoever takes the money decides how, and a seller at
 * three stands states it once. Correcting it here corrects it everywhere she sells, which is
 * the whole point of the move — the old per-stand control let VIGA leave three stands of one
 * farm disagreeing about the same fact.
 */
export async function saveFarmBucksStatus(
  db: Db,
  input: { sellerId: string; administratorId: string; status: FarmBucksStatus; occurredAt: Date },
): Promise<{ status: "saved" | "unknown_seller" | "not_an_administrator" }> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators where id = ${input.administratorId} and revoked_at is null for update
    `;
    if (administrator.length === 0) return { status: "not_an_administrator" as const };

    const seller = await tx`select id from sellers where id = ${input.sellerId} for update`;
    if (seller.length === 0) return { status: "unknown_seller" as const };

    await tx`
      update sellers
      set farm_bucks_accepted = ${input.status === "accepts"},
          updated_at = ${input.occurredAt.toISOString()}
      where id = ${input.sellerId}
    `;
    return { status: "saved" as const };
  });
}

export type SaveStandMetadataResult =
  | { status: "saved" }
  | { status: "unknown_stand" }
  | { status: "invalid_name" }
  /**
   * A visitable stand cannot lose its address or its pin.
   *
   * `sales_locations_coherent_visitability` enforces it, and this status is how an operator
   * hears about it: a constraint violation escaping as a 500 tells them only that something
   * broke. Named separately from `invalid_name` because the fix is different — restore the
   * field, or change the stand's visitability on the farmer's own form.
   */
  | { status: "incomplete_location" }
  | { status: "not_an_administrator" };

/**
 * VIGA corrects one stand's own location facts (F-101).
 *
 * **Deliberately NOT `saveOnboardingListing` with an administrator arm.** That writer replaces
 * the whole listing — payment methods, what the stand usually sells, the farmer's description,
 * her items. An operator fixing a misspelt stand name must not rewrite the farmer's published
 * words on the way past, which is Golden Rule #1: the farmer owns published state.
 *
 * So this names its columns, and what it leaves out it leaves out on purpose. `is_public` is
 * retire/restore's; `farm_bucks_*` is `saveFarmBucksStatus`'s; `visitability`, `offering_type`
 * and the twelve structured availability columns are the farmer's own form's. A second writer
 * over any of them would be two ways to do one thing.
 *
 * The structured season and hours columns stay out for a second reason as well: `coherentSeason`
 * refuses a half-stated season, so they can only be written as one complete statement. Free-text
 * `hours_text` — the farmer's own words about when she is open — carries no such constraint and
 * is the field an operator actually reaches for.
 *
 * Authority is re-read inside the transaction, like every writer in this module: a principal
 * proves the caller was an administrator when the request began, and only the row proves they
 * still are.
 */
export async function saveStandMetadata(
  db: Db,
  input: {
    standId: string;
    administratorId: string;
    name: string;
    publicAddress: string | null;
    addressPublic: boolean;
    latitude: number | null;
    longitude: number | null;
    hoursText: string | null;
    occurredAt: Date;
  },
): Promise<SaveStandMetadataResult> {
  // A nameless stand is unreachable on the map and unnameable in a reply. The column would take
  // an empty string, so the refusal lives here — before the administrator lookup, because it is
  // a fact about the request rather than about who sent it.
  const name = input.name.trim();
  if (name === "") return { status: "invalid_name" };

  const address = input.publicAddress?.trim() ?? null;
  const hoursText = input.hoursText?.trim() ?? null;

  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) return { status: "not_an_administrator" as const };

    const stand = await tx`
      select id, visitability from sales_locations where id = ${input.standId} for update
    `;
    if (stand.length === 0) return { status: "unknown_stand" as const };

    /*
      The database's own rule, asked BEFORE the write so the operator gets a named answer.

      Read from the ROW rather than taken from the request: visitability is the farmer's fact
      and this writer does not touch it, so the stand itself is what says whether an address and
      a pin are required. Duplicating the constraint is deliberate and narrow — the constraint
      remains the enforcement, and this exists only so the refusal has words.
    */
    const visitable = (stand[0] as Record<string, unknown>).visitability === "visitable";
    const cleanAddress = address === "" ? null : address;
    if (
      visitable &&
      (cleanAddress === null || input.latitude === null || input.longitude === null)
    ) {
      return { status: "incomplete_location" as const };
    }

    await tx`
      update sales_locations
      set name = ${name},
          public_address = ${cleanAddress},
          address_public = ${input.addressPublic},
          public_latitude = ${input.latitude},
          public_longitude = ${input.longitude},
          hours_text = ${hoursText === "" ? null : hoursText},
          updated_at = ${input.occurredAt.toISOString()}
      where id = ${input.standId}
    `;

    // Commits with the edit or not at all. VIGA editing a farmer's public-facing facts is
    // exactly the act the trail exists to record.
    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('stand_metadata_edited', ${input.administratorId}, 'stand', ${input.standId},
        ${input.occurredAt.toISOString()})
    `;

    return { status: "saved" as const };
  });
}

export interface CreateAdminSessionInput {
  /** The HASH of the session token. The raw token never reaches this layer. */
  tokenHash: string;
  administratorId: string;
  issuedAt: Date;
  /** Defaults to the core session TTL. */
  expiresAt?: Date;
}

export type CreateAdminSessionResult =
  | { status: "created" }
  | { status: "not_an_administrator" };

/**
 * Persist a session for the fixed administrator after password verification.
 *
 * The caller supplies hashes, never tokens: this module cannot leak a credential it was
 * never given.
 *
 * Authority is re-read in the write transaction. The password is never accepted here and
 * therefore cannot enter Postgres through this boundary.
 */
export async function createAdminSession(
  db: Db,
  input: CreateAdminSessionInput,
): Promise<CreateAdminSessionResult> {
  const expiresAt =
    input.expiresAt ?? new Date(input.issuedAt.getTime() + ADMIN_SESSION_TTL_MS);

  return driver(db).begin(async (tx) => {
    // A session may only be issued to a LIVE administrator. Checking here as well as at
    // login keeps the invariant with the write rather than with one caller.
    //
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const inserted = await tx`
      insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at)
      values (${input.tokenHash}, ${input.administratorId},
        ${input.issuedAt.toISOString()}, ${expiresAt.toISOString()})
      returning id
    `;
    if (inserted.length === 0) throw new Error("admin session insert returned no row");
    return { status: "created" as const };
  });
}

export const ADMIN_LOGIN_CLIENT_LIMIT = 5;
export const ADMIN_LOGIN_ACCOUNT_LIMIT = 20;
export const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface ReserveAdminLoginAttemptInput {
  accountBucketHash: string;
  clientBucketHash: string;
  now: Date;
  clientLimit?: number;
  accountLimit?: number;
  windowMs?: number;
}

export type AdminLoginReservation =
  | { allowed: true; windowExpiresAt: Date }
  | { allowed: false };

async function reserveLoginBucket(
  tx: Tx,
  input: { bucketHash: string; now: Date; windowExpiresAt: Date; limit: number },
): Promise<boolean> {
  const rows = await tx`
    insert into admin_login_failures
      (bucket_hash, failure_count, window_expires_at, updated_at)
    values (${input.bucketHash}, 1, ${input.windowExpiresAt}, ${input.now})
    on conflict (bucket_hash) do update
      set failure_count = case
            when admin_login_failures.window_expires_at <= ${input.now} then 1
            else admin_login_failures.failure_count + 1
          end,
          window_expires_at = case
            when admin_login_failures.window_expires_at <= ${input.now}
              then ${input.windowExpiresAt}
            else admin_login_failures.window_expires_at
          end,
          updated_at = ${input.now}
      where admin_login_failures.window_expires_at <= ${input.now}
         or admin_login_failures.failure_count < ${input.limit}
    returning window_expires_at
  `;
  return rows.length === 1;
}

/**
 * Reserve one failed-login slot before password verification. The shared account row is
 * always claimed before the client row. That stable order plus the account row's unique key
 * serializes every claimant, including a first insert where no row existed to lock.
 */
export async function reserveAdminLoginAttempt(
  db: Db,
  input: ReserveAdminLoginAttemptInput,
): Promise<AdminLoginReservation> {
  const clientLimit = input.clientLimit ?? ADMIN_LOGIN_CLIENT_LIMIT;
  const accountLimit = input.accountLimit ?? ADMIN_LOGIN_ACCOUNT_LIMIT;
  const windowMs = input.windowMs ?? ADMIN_LOGIN_WINDOW_MS;
  if (clientLimit < 1 || accountLimit < 1 || windowMs < 1) {
    throw new Error("admin login throttle limits must be positive");
  }
  const windowExpiresAt = new Date(input.now.getTime() + windowMs);

  return driver(db).begin(async (tx) => {
    const accountAllowed = await reserveLoginBucket(tx, {
      bucketHash: input.accountBucketHash,
      now: input.now,
      windowExpiresAt,
      limit: accountLimit,
    });
    if (!accountAllowed) return { allowed: false as const };

    const clientAllowed = await reserveLoginBucket(tx, {
      bucketHash: input.clientBucketHash,
      now: input.now,
      windowExpiresAt,
      limit: clientLimit,
    });
    if (!clientAllowed) return { allowed: false as const };
    return { allowed: true as const, windowExpiresAt };
  });
}

/** A proven login clears the shared account budget and only that caller's client budget. */
export async function clearAdminLoginFailures(
  db: Db,
  input: { accountBucketHash: string; clientBucketHash: string },
): Promise<{ cleared: number }> {
  const rows = await driver(db)`
    delete from admin_login_failures
    where bucket_hash in (${input.accountBucketHash}, ${input.clientBucketHash})
    returning bucket_hash
  `;
  return { cleared: rows.length };
}

/**
 * Resolve a session token hash into an administrator, or null.
 *
 * This is the server-side identity lookup every protected route depends on. It returns null for
 * every failure — unknown, expired, revoked, or belonging to a revoked administrator —
 * because a route has no use for the distinction and an error message that named it would
 * tell an attacker which tokens exist.
 *
 * The administrator's liveness is checked HERE rather than only at login, so withdrawing an
 * operator's authority takes effect on their next request instead of when their session
 * happens to expire. That is the whole reason a session is a database record and not a
 * signed claim.
 */
export interface ResolvedAdministrator {
  administratorId: string;
  email: string;
}

export async function resolveAdminSession(
  db: Db,
  input: { tokenHash: string; now: Date },
): Promise<ResolvedAdministrator | null> {
  const rows = await driver(db)`
    select session.expires_at, session.revoked_at,
      administrator.id as administrator_id, administrator.email
    from admin_sessions as session
    join administrators as administrator
      on administrator.id = session.administrator_id
    where session.token_hash = ${input.tokenHash}
      and administrator.revoked_at is null
  `;
  const row = rows[0];
  if (row === undefined) return null;

  const live = isSessionLive(
    {
      expiresAt: new Date(row.expires_at as string),
      revokedAt:
        row.revoked_at === null ? null : new Date(row.revoked_at as string),
    },
    input.now,
  );
  if (!live) return null;

  return {
    administratorId: row.administrator_id as string,
    email: row.email as string,
  };
}

/** End a session immediately. Idempotent: revoking an already-revoked session is a no-op. */
export async function revokeAdminSession(
  db: Db,
  input: { tokenHash: string; occurredAt: Date },
): Promise<{ status: "revoked" | "not_found" }> {
  const rows = await driver(db)`
    update admin_sessions
    set revoked_at = ${input.occurredAt.toISOString()}
    where token_hash = ${input.tokenHash} and revoked_at is null
    returning id
  `;
  return { status: rows.length > 0 ? "revoked" : "not_found" };
}

export interface FarmApprovalInput {
  farmId: string;
  administratorId: string;
  occurredAt: Date;
}

export type ApproveFarmResult =
  | { status: "approved"; approvalId: string }
  | { status: "already_approved" }
  | { status: "not_an_administrator" }
  | { status: "unknown_farm" };

/**
 * Approve a farm for publication, recording which administrator acted and when.
 *
 * This is the write nothing in the product could previously perform: publication refuses
 * with `not_approved` unless a live `seller_approvals` row exists, and until this existed the
 * only way to create one was hand-written SQL.
 *
 * The administrator's authority is re-read inside the transaction. A principal resolved at
 * the start of the request proves they were an administrator then; the row proves they are
 * one now, and a revocation that committed in between must win.
 */
export async function approveFarm(
  db: Db,
  input: FarmApprovalInput,
): Promise<ApproveFarmResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const farm = await tx`select id from sellers where id = ${input.farmId}`;
    if (farm.length === 0) return { status: "unknown_farm" as const };

    // The row is locked so two concurrent approvals cannot both see "unapproved" and race
    // the partial unique index into an error instead of an honest answer.
    const existing = await tx`
      select id from seller_approvals
      where seller_id = ${input.farmId} and revoked_at is null
      for update
    `;
    if (existing.length > 0) return { status: "already_approved" as const };

    const inserted = await tx`
      insert into seller_approvals (seller_id, administrator_id, approved_at)
      values (${input.farmId}, ${input.administratorId},
        ${input.occurredAt.toISOString()})
      returning id
    `;
    const approvalId = inserted[0]?.id as string;

    // The audit event commits with the approval or not at all: an approval whose actor was
    // not recorded is exactly the thing the audit trail exists to prevent.
    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('farm_approved', ${input.administratorId}, 'farm', ${input.farmId},
        ${input.occurredAt.toISOString()})
    `;

    return { status: "approved" as const, approvalId };
  });
}

export type RevokeFarmApprovalResult =
  | { status: "revoked" }
  | { status: "not_approved" }
  | { status: "not_an_administrator" };

/**
 * Withdraw a farm's approval. Subsequent publication refuses, because
 * `confirmInventoryPublication` re-reads approval while holding its locks.
 *
 * The approval row is UPDATED, never deleted: `inventory_revisions` references the approval
 * each publication was made under, and erasing it would erase the answer to "who authorized
 * what was published, and when."
 */
export async function revokeFarmApproval(
  db: Db,
  input: FarmApprovalInput,
): Promise<RevokeFarmApprovalResult> {
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
      update seller_approvals
      set revoked_at = ${input.occurredAt.toISOString()}
      where seller_id = ${input.farmId} and revoked_at is null
      returning id
    `;
    if (revoked.length === 0) return { status: "not_approved" as const };

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('farm_approval_revoked', ${input.administratorId}, 'farm', ${input.farmId},
        ${input.occurredAt.toISOString()})
    `;

    return { status: "revoked" as const };
  });
}

export interface StandRetirementInput {
  salesLocationId: string;
  administratorId: string;
  occurredAt: Date;
}

export type RetireStandResult =
  | { status: "retired" }
  | { status: "already_retired" }
  | { status: "not_an_administrator" }
  | { status: "unknown_stand" };

/**
 * Take a stand down: off the map, off the SMS answers, and closed to new publication.
 *
 * **This is what "delete a stand" means here** (F-071, max's choice between erasing and
 * taking down). It is not a softened deletion — it is the only correct one:
 *
 *   - `sales_locations` is referenced `on delete restrict` by `inventory_revisions`,
 *     `inventory_entries`, `stand_items` and `stock_out_reports`, so a hard DELETE fails at
 *     the constraint for any stand that has ever published.
 *   - Erasing published revisions would erase the answer to "what did this stand say it had,
 *     and when" — which is exactly what the audit trail exists to keep (Golden Rule #1).
 *
 * The effect that makes it real is NOT here: `confirmInventoryPublication` re-reads
 * `retired_at` while holding its locks, the same way it re-reads authority and approval. A
 * caller cannot skip it, and a retirement racing an in-flight confirmation resolves at the
 * lock rather than by whichever request arrived first.
 *
 * The administrator's authority is re-read inside the transaction. A principal resolved at
 * the start of a request proves they were an administrator then; the row proves they are one
 * now, and a revocation that committed in between must win.
 */
export async function retireStand(
  db: Db,
  input: StandRetirementInput,
): Promise<RetireStandResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    // Locked so two concurrent retirements cannot both see "live" and write two audit events
    // for one decision.
    const stand = await tx`
      select id, retired_at from sales_locations
      where id = ${input.salesLocationId}
      for update
    `;
    if (stand.length === 0) return { status: "unknown_stand" as const };
    // Idempotent, and it keeps the FIRST retirement's timestamp. Moving it would falsify when
    // the stand actually came down, which is the one fact the record is for.
    if (stand[0]?.retired_at !== null) return { status: "already_retired" as const };

    await tx`
      update sales_locations
      set retired_at = ${input.occurredAt.toISOString()},
          retired_by_administrator_id = ${input.administratorId},
          updated_at = ${input.occurredAt.toISOString()}
      where id = ${input.salesLocationId}
    `;

    // The audit event commits with the retirement or not at all: a stand taken down with no
    // record of who did it is exactly what the audit trail exists to prevent.
    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('stand_retired', ${input.administratorId}, 'sales_location',
        ${input.salesLocationId}, ${input.occurredAt.toISOString()})
    `;

    return { status: "retired" as const };
  });
}

export type RestoreStandResult =
  | { status: "restored" }
  | { status: "not_retired" }
  | { status: "not_an_administrator" }
  | { status: "unknown_stand" };

/**
 * Put a retired stand back. This is what makes retirement safe to reach for: an operator who
 * takes down the wrong stand fixes it themselves rather than asking for a database repair.
 *
 * Clears the actor alongside the timestamp — `sales_locations_coherent_retirement` requires
 * the two to move together, and a stand that is not retired was retired by nobody.
 */
export async function restoreStand(
  db: Db,
  input: StandRetirementInput,
): Promise<RestoreStandResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const stand = await tx`
      select id, retired_at from sales_locations
      where id = ${input.salesLocationId}
      for update
    `;
    if (stand.length === 0) return { status: "unknown_stand" as const };
    if (stand[0]?.retired_at === null) return { status: "not_retired" as const };

    await tx`
      update sales_locations
      set retired_at = null, retired_by_administrator_id = null,
          updated_at = ${input.occurredAt.toISOString()}
      where id = ${input.salesLocationId}
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('stand_restored', ${input.administratorId}, 'sales_location',
        ${input.salesLocationId}, ${input.occurredAt.toISOString()})
    `;

    return { status: "restored" as const };
  });
}

export interface FarmRetirementInput {
  farmId: string;
  administratorId: string;
  occurredAt: Date;
}

export type RetireFarmResult =
  | { status: "retired" }
  | { status: "already_retired" }
  | { status: "not_an_administrator" }
  | { status: "unknown_farm" };

/**
 * Take a whole farm down: off the map, off the SMS answers, and closed to new publication.
 *
 * **This is what "delete a farm" means here** — max's choice, and the same one he made for
 * stands in F-071. It is not a softened deletion, it is the only correct one:
 *
 *   - `sellers` is referenced `on delete restrict` by `sales_locations`,
 *     `farmer_authorizations`, `seller_approvals`, `farmer_invitations` and more, so a hard
 *     DELETE fails at the constraint for any farm that has ever been used.
 *   - Erasing it would erase what its stands published and when — exactly what the audit
 *     trail exists to keep (Golden Rule #1).
 *
 * **A farm take-down deliberately does NOT write each stand's own `retired_at`.** Every
 * reader treats a stand under a retired farm as off the map, but the stand's own column
 * stays untouched, so restoring the farm can put back exactly the stands the farm was
 * holding down — and a stand retired on its own beforehand stays retired. Writing through
 * to the stands would collapse two independent decisions into one and make restore guess.
 *
 * The administrator's authority is re-read inside the transaction: a principal resolved at
 * the start of a request proves they were an administrator then; the row proves they are one
 * now, and a revocation that committed in between must win.
 */
export async function retireFarm(
  db: Db,
  input: FarmRetirementInput,
): Promise<RetireFarmResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    // Locked so two concurrent take-downs cannot both see "live" and write two audit events
    // for one decision.
    const farm = await tx`
      select id, retired_at from sellers where id = ${input.farmId} for update
    `;
    if (farm.length === 0) return { status: "unknown_farm" as const };
    // Idempotent, and it keeps the FIRST take-down's timestamp. Moving it would falsify when
    // the farm actually came down, which is the one fact the record is for.
    if (farm[0]?.retired_at !== null) return { status: "already_retired" as const };

    await tx`
      update sellers
      set retired_at = ${input.occurredAt.toISOString()},
          retired_by_administrator_id = ${input.administratorId},
          updated_at = ${input.occurredAt.toISOString()}
      where id = ${input.farmId}
    `;

    // The audit event commits with the take-down or not at all: a farm taken down with no
    // record of who did it is exactly what the audit trail exists to prevent.
    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('farm_retired', ${input.administratorId}, 'farm', ${input.farmId},
        ${input.occurredAt.toISOString()})
    `;

    return { status: "retired" as const };
  });
}

export type RestoreFarmResult =
  | { status: "restored" }
  | { status: "not_retired" }
  | { status: "not_an_administrator" }
  | { status: "unknown_farm" };

/**
 * Put a retired farm back. This is what makes a take-down safe to reach for: an operator who
 * removes the wrong farm fixes it themselves rather than asking for a database repair.
 *
 * Clears the actor alongside the timestamp — `sellers_coherent_retirement` requires the two to
 * move together, and a farm that is not retired was retired by nobody. Stands that carry
 * their own retirement stay retired, because this never wrote them in the first place.
 */
export async function restoreFarm(
  db: Db,
  input: FarmRetirementInput,
): Promise<RestoreFarmResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const farm = await tx`
      select id, retired_at from sellers where id = ${input.farmId} for update
    `;
    if (farm.length === 0) return { status: "unknown_farm" as const };
    if (farm[0]?.retired_at === null) return { status: "not_retired" as const };

    await tx`
      update sellers
      set retired_at = null, retired_by_administrator_id = null,
          updated_at = ${input.occurredAt.toISOString()}
      where id = ${input.farmId}
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('farm_restored', ${input.administratorId}, 'farm', ${input.farmId},
        ${input.occurredAt.toISOString()})
    `;

    return { status: "restored" as const };
  });
}

export interface SaveFarmDetailsInput {
  farmId: string;
  administratorId: string;
  name: string;
  description: string | null;
  occurredAt: Date;
}

export type SaveFarmDetailsResult =
  | { status: "saved" }
  | { status: "invalid_name" }
  | { status: "not_an_administrator" }
  | { status: "unknown_farm" };

/**
 * Correct a farm's own identity — its name and description.
 *
 * **This is a farm record, NOT a listing.** What a stand has, when it is open, and what it
 * costs all belong to the farmer (Golden Rule #1) and are not reachable from here. A farm's
 * name is VIGA's own roster entry: it arrives from a spreadsheet import, it is what an
 * operator reads out on the phone, and correcting a typo in it was previously possible only
 * with hand-written SQL.
 *
 * The blank-name check is here rather than left to `sellers_name_not_blank` because a
 * constraint violation surfaces as a thrown error, and a route cannot turn that into a
 * sentence an operator can act on. The constraint still stands behind it as the guarantee.
 */
export async function saveFarmDetails(
  db: Db,
  input: SaveFarmDetailsInput,
): Promise<SaveFarmDetailsResult> {
  const name = input.name.trim();
  if (name === "") return { status: "invalid_name" };
  const description =
    input.description === null || input.description.trim() === ""
      ? null
      : input.description.trim();

  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const farm = await tx`
      select id from sellers where id = ${input.farmId} for update
    `;
    if (farm.length === 0) return { status: "unknown_farm" as const };

    await tx`
      update sellers
      set name = ${name}, description = ${description},
          updated_at = ${input.occurredAt.toISOString()}
      where id = ${input.farmId}
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('farm_details_saved', ${input.administratorId}, 'farm', ${input.farmId},
        ${input.occurredAt.toISOString()})
    `;

    return { status: "saved" as const };
  });
}

export interface AdminFarmRow {
  farmId: string;
  name: string;
  description: string | null;
  approved: boolean;
  approvedAt: Date | null;
  approvedByEmail: string | null;
  /** F-074 — VIGA marked this farm as fake, so customers never see it. */
  isTestFarm: boolean;
  /** In the trash — absent from the working roster, restorable from the trash view (F-122). */
  trashed: boolean;
  /** VIGA took this whole farm down. Its stands are off the map with it. */
  retired: boolean;
  retiredAt: Date | null;
}

/**
 * The approval queue: every farm with its current approval state.
 *
 * Deliberately returns no phone number, hashed or otherwise — approving a farm needs the
 * farm and who approved it, and nothing here needs a contact (Golden Rule #5: the admin
 * surface carries the minimum it can do its job with).
 */
/**
 * Which roster to read: the farms an operator works, or the trash (F-122).
 *
 * **The two partition the list rather than overlapping.** A trashed farm is absent from the
 * ordinary roster — that is what trashing MEANS — and present in the trash, which is where its
 * restore control lives. One parameter rather than a second reader, so the two listings cannot
 * drift into disagreeing about which farms exist.
 */
export interface RosterScope {
  /** Read the trash instead of the working roster. */
  trashed?: boolean;
}

export async function listFarmsForApproval(
  db: Db,
  scope: RosterScope = {},
): Promise<AdminFarmRow[]> {
  const wantTrashed = scope.trashed === true;
  const rows = await driver(db)`
    select farm.id, farm.name, farm.description, farm.test_seller_at, farm.retired_at,
      farm.trashed_at, approval.approved_at, administrator.email
    from sellers as farm
    left join seller_approvals as approval
      on approval.seller_id = farm.id and approval.revoked_at is null
    left join administrators as administrator
      on administrator.id = approval.administrator_id
    -- The trash and the working roster partition the farms between them. Stated as one
    -- condition over one column so neither listing can be widened without narrowing the other.
    where farm.trashed_at is ${wantTrashed ? driver(db)`not null` : driver(db)`null`}
    -- A retired farm is still LISTED here, the same way a retired stand is: this is where an
    -- operator undoes a take-down, so hiding it would strand the only control that reverses it.
    order by (farm.retired_at is not null), farm.name
  `;
  return rows.map((row) => ({
    farmId: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    approved: row.approved_at !== null,
    approvedAt:
      row.approved_at === null ? null : new Date(row.approved_at as string),
    approvedByEmail: (row.email as string | null) ?? null,
    retired: row.retired_at !== null,
    retiredAt: row.retired_at === null ? null : new Date(row.retired_at as string),
    // F-074 — the ADMIN surface is the one place a test farm is never hidden. An operator
    // managing the flag has to be able to see which sellers carry it, and this reader is already
    // behind the session guard.
    isTestFarm: row.test_seller_at !== null,
    trashed: row.trashed_at !== null,
  }));
}

/**
 * The administrator's stand index. This deliberately carries stand and farm facts only:
 * it never joins contacts or farmer authorization records, so the dashboard cannot turn
 * into a profile of everyone who has texted Farm Friend.
 */
export interface AdminStandRow {
  standId: string;
  name: string;
  /**
   * The owning farm's id (F-125). Carried because payment is the SELLER's fact now, so the
   * console's Farm Bucks control has to save against her rather than against this stand.
   */
  farmId: string;
  farmName: string;
  kind: string;
  timezone: string;
  visitability: "visitable" | "contact_only";
  offeringType: string;
  publicAddress: string | null;
  /**
   * F-088 — whether customers see the address. VIGA sees it either way.
   *
   * Admin reads the RAW address regardless, because support work needs it: answering "where is
   * this farm?" on the phone is exactly the job this screen exists for. The flag travels beside
   * it so the screen can say the address is withheld from the public rather than implying it is
   * on the map.
   */
  addressPublic: boolean;
  publicLatitude: number | null;
  publicLongitude: number | null;
  hoursText: string | null;
  seasonKind: string | null;
  seasonStartMonth: number | null;
  seasonStartDay: number | null;
  seasonEndMonth: number | null;
  seasonEndDay: number | null;
  seasonNames: string[] | null;
  openHoursKind: string | null;
  openFromMinutes: number | null;
  openUntilMinutes: number | null;
  openDays: number[] | null;
  stockingCadence: string | null;
  stockingDays: number[] | null;
  isPublic: boolean;
  /**
   * F-071 — this stand is off the map. True when VIGA retired the stand itself OR took its
   * whole farm down; `retiredWithFarm` says which, because the control that reverses it
   * differs.
   */
  retired: boolean;
  /** The STAND's own retirement moment. Null for a stand down only because its farm is. */
  retiredAt: Date | null;
  /**
   * Off the map only because its FARM is down, with no retirement of its own.
   *
   * The operator screen needs the difference: "put this stand back" is the wrong control for
   * a stand nobody retired, and offering it would appear to do nothing.
   */
  retiredWithFarm: boolean;
  /** In the trash — absent from the working roster, restorable from the trash view (F-122). */
  trashed: boolean;
  /**
   * In the trash only because its FARM is. The operator's next move differs: this stand has no
   * trashing of its own to undo, and the control that brings it back is on the farm.
   */
  trashedWithFarm: boolean;
  /** F-125 — the SELLER's answer, shown on her stand's card. Two states, no grant. */
  farmBucksAccepted: boolean;
  approved: boolean;
  approvedAt: Date | null;
  publishedAt: Date | null;
  closureResult: "close" | "reopen" | null;
  closureKind: "temporary" | "seasonal" | null;
  closureStartsOn: string | null;
  closureClosedThrough: string | null;
  usualOfferings: string[];
  participantNames: string[];
  currentItems: Array<{
    itemName: string;
    quantity: number | null;
    unit: string | null;
    priceText: string | null;
    approximation: string | null;
  }>;
}

/**
 * Every stand and the operator-relevant facts that describe its current state.
 *
 * `scope.trashed` reads the TRASH instead of the working roster (F-122). The two partition the
 * stands between them — a trashed stand is absent here, which is what trashing means, and
 * present there, which is where its restore control lives.
 *
 * **A stand under a trashed FARM is in the trash too**, the same way it is off the map when its
 * farm is: trashing a farm deliberately never writes each stand's own column, so restoring the
 * farm puts back exactly the stands it was holding. The condition is therefore the stand's own
 * trashing OR its farm's, matching how `retired` is already derived below.
 */
export async function listStandsForAdministration(
  db: Db,
  scope: RosterScope = {},
): Promise<AdminStandRow[]> {
  const wantTrashed = scope.trashed === true;
  const trashCondition = wantTrashed
    ? "(location.trashed_at is not null or farm.trashed_at is not null)"
    : "(location.trashed_at is null and farm.trashed_at is null)";
  // `.unsafe` rather than a tagged template, because this query now composes the shared
  // current-inventory join as SQL TEXT. In a tagged template an interpolation becomes a bind
  // PARAMETER, which would send the join clause as a string value and fail at parse — the same
  // reason `listClaimableFarms` composes `visibleFarms` this way. The statement takes no
  // parameters of its own, so nothing here becomes injectable by the change.
  const rows = await driver(db).unsafe(`
    select
      location.id as stand_id,
      location.name as stand_name,
      farm.name as farm_name,
      location.kind,
      location.timezone,
      location.visitability,
      location.offering_type,
      location.public_address,
      location.address_public,
      location.public_latitude,
      location.public_longitude,
      location.hours_text,
      location.season_kind,
      location.season_start_month,
      location.season_start_day,
      location.season_end_month,
      location.season_end_day,
      location.season_names,
      location.open_hours_kind,
      location.open_from_minutes,
      location.open_until_minutes,
      location.open_days,
      location.stocking_cadence,
      location.stocking_days,
      location.is_public,
      location.retired_at,
      location.trashed_at,
      farm.trashed_at as farm_trashed_at,
      -- A farm take-down carries its stands down with it WITHOUT writing their own
      -- retired_at (see retireFarm), so "is this stand off the map?" is the farm's state OR
      -- the stand's. Reading only the stand's column would show an operator a live stand
      -- under a farm they just took down.
      farm.retired_at as farm_retired_at,
      -- F-125 — read off the owning farm, because payment is hers rather than the stand's.
      farm.id as farm_id,
      farm.farm_bucks_accepted,
      approval.approved_at,
      -- The FRESHEST live confirmation at this stand (F-114 C.5), across every seller. The
      -- operator's question is "how current is this stand", and the honest answer is the most
      -- recent thing anyone here vouched for — the same rule the public card's heading uses.
      -- Null for a stand nobody has published at, exactly as the removed LEFT join left it.
      (select max(revision.published_at) from inventory_revisions revision
       where revision.sales_location_id = location.id and revision.is_current
      ) as published_at,
      closure.result as closure_result,
      closure.closure_kind as closure_kind,
      closure.starts_on::text as closure_starts_on,
      closure.closed_through::text as closure_closed_through,
      -- F-066 — the standing state of a stand item. Only usually_carried rows are a claim
      -- that the stand usually has the thing.
      --
      -- F-092 — the price travels as ITS PARTS and is rendered in TypeScript by
      -- renderStandItemPrice, the same function every other surface calls. It used to be
      -- concatenated here in SQL, which was fine for a free-text column and would now be a
      -- SECOND renderer: the moment two places turn parts into a sentence they start to
      -- disagree, and an operator reading support copy that differs from the farmer's own
      -- screen is exactly the confusion this avoids.
      --
      -- NOT gated on prices_public, deliberately, and for the same reason the address is not:
      -- VIGA support needs to see what the farmer entered even when it is hidden from
      -- customers. The gate belongs on customer surfaces, and this is not one.
      coalesce(
        (select jsonb_agg(jsonb_build_object(
           'name', offering.display_name,
           'price', case
             when offering.price_amount is null then null
             else jsonb_build_object(
               'amount', offering.price_amount::text,
               'quantity', offering.price_quantity::text,
               'unit', offering.price_unit,
               'basis', offering.price_basis
             )
           end
         ) order by offering.sort_order, offering.display_name)
         from stand_items offering
         where offering.sales_location_id = location.id and offering.usually_carried),
        '[]'::jsonb
      ) as usual_offerings,
      coalesce(
        (select array_agg(participant.display_name order by lower(participant.display_name),
          participant.display_name, participant.id)
         from sales_location_participants participant
         where participant.sales_location_id = location.id and participant.retired_at is null),
        array[]::text[]
      ) as participant_names,
      /*
        EVERY LIVE SELLER'S CURRENT ITEMS AT THIS STAND (F-114 C.5).

        The roster is one row per STAND, and after Phase B a stand has several sellers each
        publishing their own current revision. Correlated on the LOCATION rather than on one
        revision, so the operator sees the whole table rather than whichever seller's revision
        the join happened to surface.

        Ordered by provider first so one seller's items stay together, which is how they read
        on the shelf. The operator's screen deliberately does NOT attribute them: this is the
        roster of what is out, and whose goods are whose is the stand's own detail view.
      */
      coalesce(
        (select jsonb_agg(jsonb_build_object(
          'itemName', entry.item_name,
          'quantity', entry.quantity,
          'unit', entry.unit,
          'priceText', entry.price_text,
          'approximation', entry.approximation
        ) order by revision.provider_id, entry.sort_order, entry.id)
         from inventory_revisions revision
         join inventory_entries entry on entry.inventory_revision_id = revision.id
         where revision.sales_location_id = location.id and revision.is_current),
        '[]'::jsonb
      ) as current_items
    from sales_locations location
    join sellers farm on farm.id = location.own_seller_id
    left join seller_approvals approval
      on approval.seller_id = farm.id and approval.revoked_at is null
    /*
      THE REVISION JOIN IS GONE (F-114 C.5), and its removal is the fix.

      B-074 shared currentInventoryJoin here so the currency rule had one home. After Phase B
      that join matches one row per SELLER, so a two-seller stand appeared in the operator's
      roster TWICE, each row carrying only half the inventory — measured against a real database
      before this was changed. A stand listed twice with split stock is a screen that invents
      work for VIGA.

      Nothing else read the join's alias: the recency below and the items above are both
      correlated subqueries over the location, which is the grain this query has always had.
      A stand with no confirmation is still listed, exactly as the LEFT join made it — the
      subqueries simply return nothing for it.
    */
    left join closure_revisions closure
      on closure.sales_location_id = location.id and closure.is_current
    -- The trash and the working roster partition the stands between them. Interpolated from
    -- this function's own literals, never from caller input, so nothing here is injectable.
    where ${trashCondition}
    -- A retired stand is still LISTED here, deliberately: this queue is where an operator
    -- restores one, and a stand that vanished from the only surface that can bring it back
    -- would make retirement irreversible in practice. Sorted after the live ones so the
    -- working list is not interrupted by stands nobody is serving.
    order by (location.retired_at is not null or farm.retired_at is not null),
      location.name, location.id
  `);

  return rows.map((row) => ({
    standId: row.stand_id as string,
    name: row.stand_name as string,
    farmId: row.farm_id as string,
    farmName: row.farm_name as string,
    kind: row.kind as string,
    timezone: row.timezone as string,
    visitability: row.visitability as AdminStandRow["visitability"],
    offeringType: row.offering_type as string,
    publicAddress: (row.public_address as string | null) ?? null,
    addressPublic: row.address_public !== false,
    publicLatitude: row.public_latitude === null ? null : Number(row.public_latitude),
    publicLongitude: row.public_longitude === null ? null : Number(row.public_longitude),
    hoursText: (row.hours_text as string | null) ?? null,
    seasonKind: (row.season_kind as string | null) ?? null,
    seasonStartMonth:
      row.season_start_month === null ? null : Number(row.season_start_month),
    seasonStartDay: row.season_start_day === null ? null : Number(row.season_start_day),
    seasonEndMonth: row.season_end_month === null ? null : Number(row.season_end_month),
    seasonEndDay: row.season_end_day === null ? null : Number(row.season_end_day),
    seasonNames: (row.season_names as string[] | null) ?? null,
    openHoursKind: (row.open_hours_kind as string | null) ?? null,
    openFromMinutes:
      row.open_from_minutes === null ? null : Number(row.open_from_minutes),
    openUntilMinutes:
      row.open_until_minutes === null ? null : Number(row.open_until_minutes),
    openDays: (row.open_days as number[] | null) ?? null,
    stockingCadence: (row.stocking_cadence as string | null) ?? null,
    stockingDays: (row.stocking_days as number[] | null) ?? null,
    isPublic: row.is_public as boolean,
    // Off the map for either reason. `retiredAt` stays the STAND's own moment: a stand down
    // only because its farm is down has no retirement date of its own, and inventing one
    // would tell an operator this stand was retired when nobody ever retired it.
    retired: row.retired_at !== null || row.farm_retired_at !== null,
    retiredAt: row.retired_at === null ? null : new Date(row.retired_at as string),
    retiredWithFarm: row.retired_at === null && row.farm_retired_at !== null,
    trashed: row.trashed_at !== null || row.farm_trashed_at !== null,
    trashedWithFarm: row.trashed_at === null && row.farm_trashed_at !== null,
    farmBucksAccepted: row.farm_bucks_accepted as boolean,
    approved: row.approved_at !== null,
    approvedAt: row.approved_at === null ? null : new Date(row.approved_at as string),
    publishedAt: row.published_at === null ? null : new Date(row.published_at as string),
    closureResult: (row.closure_result as AdminStandRow["closureResult"]) ?? null,
    closureKind: (row.closure_kind as AdminStandRow["closureKind"]) ?? null,
    closureStartsOn: (row.closure_starts_on as string | null) ?? null,
    closureClosedThrough: (row.closure_closed_through as string | null) ?? null,
    // F-092 — rendered HERE, through the one renderer, rather than concatenated in SQL. An
    // unpriced item is its bare name; a priced one carries the same sentence a customer sees.
    usualOfferings: (
      (row.usual_offerings as
        | { name: string; price: StandItemPrice | null }[]
        | null) ?? []
    ).map((offering) => {
      const price = renderStandItemPrice(offering.price);
      return price === null ? offering.name : `${offering.name} ${price}`;
    }),
    participantNames: (row.participant_names as string[] | null) ?? [],
    currentItems: (row.current_items as AdminStandRow["currentItems"]) ?? [],
  }));
}

/**
 * One seller's live participation at one stand, as the admin Stands and Sellers views need it
 * (F-101).
 *
 * **This is an ARRANGEMENT, not a name.** `AdminStandRow.participantNames` also answers "who
 * sells here", but from `sales_location_participants` — display strings a stand owner typed,
 * with no identity and no lifecycle. Those two reads must not be conflated on a screen that
 * renders a control per row: a typed name has no row to pause, so a toggle beside one would
 * act on nothing. Both views render their controls from THIS read alone.
 *
 * One row per live arrangement, so the same relationship is returned once and appears under
 * the stand on one view and under the seller on the other.
 */
export interface AdminStandProviderRow {
  /** What `setProviderParticipation` acts on. Without it a control has no argument. */
  providerId: string;
  salesLocationId: string;
  standName: string;
  sellerId: string;
  sellerName: string;
  /** `active` or `paused` — what the pause/resume toggle reflects. */
  lifecycleState: "active" | "paused";
  /**
   * This seller owns the stand.
   *
   * The views need it for presentation, not authority: the singular case renders as a plain
   * fact rather than a one-item list, and on a stand whose only arrangement is its native
   * seller the toggle reads as the stand being open or closed.
   */
  nativeSeller: boolean;
  /** Always false today — ended arrangements are not returned. Present so the field is honest. */
  ended: boolean;
}

/**
 * Every live arrangement, for the admin Stands and Sellers views.
 *
 * **`pending` and ended rows are excluded**, and both for the same reason: the lists are
 * entities, and neither an unanswered invitation nor a finished relationship is one. It also
 * matches what `setProviderParticipation` will do if asked — both answer `provider_not_live` —
 * so the views never render a control that could only be refused.
 */
export async function listStandProvidersForAdministration(
  db: Db,
): Promise<AdminStandProviderRow[]> {
  const rows = await driver(db)`
    select
      provider.id as provider_id,
      provider.sales_location_id,
      location.name as stand_name,
      provider.seller_id,
      seller.name as seller_name,
      provider.lifecycle_state,
      provider.seller_id = location.own_seller_id as native_seller
    from stand_providers provider
    join sales_locations location on location.id = provider.sales_location_id
    join sellers seller on seller.id = provider.seller_id
    where provider.ended_at is null
      and provider.lifecycle_state in ('active', 'paused')
    order by lower(location.name), location.id,
      -- The stand's own seller first: on a shared stand it is the row the others are guests of.
      (provider.seller_id = location.own_seller_id) desc,
      lower(seller.name), provider.id
  `;

  return rows.map((row) => ({
    providerId: row.provider_id as string,
    salesLocationId: row.sales_location_id as string,
    standName: row.stand_name as string,
    sellerId: row.seller_id as string,
    sellerName: row.seller_name as string,
    lifecycleState: row.lifecycle_state as "active" | "paused",
    nativeSeller: row.native_seller as boolean,
    ended: false,
  }));
}

export interface AdminUserRow {
  userId: string;
  senderMask: string;
  isFarmer: boolean;
  sellers: string[];
}

/**
 * The smallest useful user directory: every SMS contact, its current farmer status, and the
 * sellers it may publish for. Full numbers, contact hashes, message text, and timestamps are
 * intentionally absent, so this remains a filterable access view rather than a profile.
 */
export async function listUsersForAdministration(db: Db): Promise<AdminUserRow[]> {
  const rows = await driver(db)`
    select
      contact.id as contact_id,
      right(contact.phone_e164, 4) as sender_last_four,
      exists (
        select 1 from farmer_authorizations farmer_authorization
        where farmer_authorization.contact_id = contact.id
          and farmer_authorization.revoked_at is null
      ) as is_farmer,
      coalesce(
        (select array_agg(farm.name order by farm.name, farm.id)
         from farmer_authorizations farmer_authorization
         join sellers farm on farm.id = farmer_authorization.seller_id
         where farmer_authorization.contact_id = contact.id
           and farmer_authorization.revoked_at is null),
        array[]::text[]
      ) as sellers
    from contacts contact
    order by contact.id
  `;
  return rows.map((row) => ({
    userId: row.contact_id as string,
    senderMask: maskPhoneSuffix((row.sender_last_four as string | null) ?? null),
    isFarmer: row.is_farmer as boolean,
    sellers: (row.sellers as string[] | null) ?? [],
  }));
}

/** Look up a live administrator by the email a verified login proved. */
export async function findAdministratorByEmail(
  db: Db,
  email: string,
): Promise<{ administratorId: string; email: string } | null> {
  // Lowercased to match the stored form; the database check constraint guarantees every
  // stored address is already lowercase, so this is the only normalization needed.
  const normalized = email.trim().toLowerCase();
  const rows = await driver(db)`
    select id, email from administrators
    where email = ${normalized} and revoked_at is null
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return { administratorId: row.id as string, email: row.email as string };
}
