import {
  ADMIN_SESSION_TTL_MS,
  isSessionLive,
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
 * with `not_approved` unless a live `farm_approvals` row exists, and until this existed the
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

    const farm = await tx`select id from farms where id = ${input.farmId}`;
    if (farm.length === 0) return { status: "unknown_farm" as const };

    // The row is locked so two concurrent approvals cannot both see "unapproved" and race
    // the partial unique index into an error instead of an honest answer.
    const existing = await tx`
      select id from farm_approvals
      where farm_id = ${input.farmId} and revoked_at is null
      for update
    `;
    if (existing.length > 0) return { status: "already_approved" as const };

    const inserted = await tx`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
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
      update farm_approvals
      set revoked_at = ${input.occurredAt.toISOString()}
      where farm_id = ${input.farmId} and revoked_at is null
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

export interface AdminFarmRow {
  farmId: string;
  name: string;
  approved: boolean;
  approvedAt: Date | null;
  approvedByEmail: string | null;
}

/**
 * The approval queue: every farm with its current approval state.
 *
 * Deliberately returns no phone number, hashed or otherwise — approving a farm needs the
 * farm and who approved it, and nothing here needs a contact (Golden Rule #5: the admin
 * surface carries the minimum it can do its job with).
 */
export async function listFarmsForApproval(db: Db): Promise<AdminFarmRow[]> {
  const rows = await driver(db)`
    select farm.id, farm.name, approval.approved_at, administrator.email
    from farms as farm
    left join farm_approvals as approval
      on approval.farm_id = farm.id and approval.revoked_at is null
    left join administrators as administrator
      on administrator.id = approval.administrator_id
    order by farm.name
  `;
  return rows.map((row) => ({
    farmId: row.id as string,
    name: row.name as string,
    approved: row.approved_at !== null,
    approvedAt:
      row.approved_at === null ? null : new Date(row.approved_at as string),
    approvedByEmail: (row.email as string | null) ?? null,
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
