import {
  ADMIN_SESSION_TTL_MS,
  isSessionLive,
  type Principal,
  type Role,
} from "@farm-friend/core";
import type postgres from "postgres";
import type { Db } from "./index";

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

type Sql = ReturnType<typeof postgres>;

function driver(db: Db): Sql {
  return db.sql;
}

/**
 * The roles an administrator record confers. This is a CONSTANT, not a query, and that is
 * the enforcement of Golden Rule #1: the farmer owns published state, so no operator role
 * may ever confer the ability to act as a farm's owner. There is one administrator level at
 * launch, so there is nothing to look up — and a list that cannot vary cannot be widened by
 * a bad row, a join, or a future column.
 *
 * `admin` already implies `staff` through `hasRole`; stating both here would be a second
 * way to say one thing.
 */
const ADMINISTRATOR_ROLES: readonly Role[] = ["admin"];

export interface CreateAdminSessionInput {
  /** The HASH of the session token. The raw token never reaches this layer. */
  tokenHash: string;
  administratorId: string;
  issuedAt: Date;
  /** Defaults to the core session TTL. */
  expiresAt?: Date;
  /**
   * The HASH of the magic link this session is being minted from, if there was one
   * (GL-004). Supplying it CONSUMES that link: the insert carries a unique index, so a
   * second session for the same link is refused by the database rather than by a rule
   * anyone has to remember. Absent for a session that came from no link — bootstrap and
   * test paths — which stay unconstrained because NULLs are distinct in a unique index.
   */
  magicNonceHash?: string;
}

export type CreateAdminSessionResult =
  | { status: "created" }
  | { status: "not_an_administrator" }
  | { status: "link_already_used" };

/**
 * Persist a session for an administrator who has just proven their identity, consuming the
 * magic link that proved it.
 *
 * The caller supplies hashes, never tokens: this module cannot leak a credential it was
 * never given.
 *
 * **The single-use arbiter is the unique index, reached through this one insert.** The
 * tempting shape — look up whether the nonce has been used, then insert — is two acts, and
 * two concurrent callbacks both observe "unused" before either writes. A `select … for
 * update` does not rescue it either: `for update` locks rows that EXIST, and the first use
 * of a link has no row to lock (the same reasoning B-011 needed). So the exclusion lives in
 * `on conflict … do nothing returning id`, where the EMPTY result IS the signal that
 * another use won the race. Without `returning`, winner and loser are indistinguishable.
 *
 * Order matters: authority is re-read BEFORE the link is spent, so a revoked operator's link
 * is refused without being burned. A stranger replaying links against revoked administrators
 * therefore cannot destroy credentials they do not hold.
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
    // Deliberately NOT `for update`. Nothing here mutates the administrator, and locking it
    // would serialize every concurrent use of one operator's link upstream of the index that
    // is supposed to decide — which would make the race test unfalsifiable while proving
    // nothing about single use (the F-037 lesson).
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const inserted = await tx`
      insert into admin_sessions (token_hash, administrator_id, issued_at, expires_at,
        magic_nonce_hash)
      values (${input.tokenHash}, ${input.administratorId},
        ${input.issuedAt.toISOString()}, ${expiresAt.toISOString()},
        ${input.magicNonceHash ?? null})
      on conflict (magic_nonce_hash) do nothing
      returning id
    `;
    if (inserted.length === 0) {
      // The link had already been spent. Nothing was written, and the session minted by
      // whoever used it first is untouched — a refused replay must not sign an operator out.
      return { status: "link_already_used" as const };
    }
    return { status: "created" as const };
  });
}

/**
 * Resolve a session token hash into a principal, or null.
 *
 * This is the server-side role lookup every protected route depends on. It returns null for
 * every failure — unknown, expired, revoked, or belonging to a revoked administrator —
 * because a route has no use for the distinction and an error message that named it would
 * tell an attacker which tokens exist.
 *
 * The administrator's liveness is checked HERE rather than only at login, so withdrawing an
 * operator's authority takes effect on their next request instead of when their session
 * happens to expire. That is the whole reason a session is a database record and not a
 * signed claim.
 */
export async function resolveAdminSession(
  db: Db,
  input: { tokenHash: string; now: Date },
): Promise<Principal | null> {
  const rows = await driver(db)`
    select session.expires_at, session.revoked_at, administrator.email
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
    personId: row.email as string,
    roles: [...ADMINISTRATOR_ROLES],
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
