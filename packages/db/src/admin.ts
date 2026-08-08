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

export type FarmBucksStatus = "accepts" | "does_not_accept" | "not_eligible";

/**
 * Record VIGA's reviewed payment status for one stand. The existing pair of columns carries
 * all three honest states: eligible + accepted, eligible + not accepted, or not eligible.
 */
export async function saveFarmBucksStatus(
  db: Db,
  input: { standId: string; administratorId: string; status: FarmBucksStatus; occurredAt: Date },
): Promise<{ status: "saved" | "unknown_stand" | "not_an_administrator" }> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators where id = ${input.administratorId} and revoked_at is null for update
    `;
    if (administrator.length === 0) return { status: "not_an_administrator" as const };

    const stand = await tx`select id from sales_locations where id = ${input.standId} for update`;
    if (stand.length === 0) return { status: "unknown_stand" as const };

    const eligible = input.status !== "not_eligible";
    const accepted = input.status === "accepts";
    await tx`
      update sales_locations
      set farm_bucks_eligible = ${eligible}, farm_bucks_accepted = ${accepted}, updated_at = ${input.occurredAt.toISOString()}
      where id = ${input.standId}
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

export interface AdminFarmRow {
  farmId: string;
  name: string;
  approved: boolean;
  approvedAt: Date | null;
  approvedByEmail: string | null;
  /** F-074 — VIGA marked this farm as fake, so customers never see it. */
  isTestFarm: boolean;
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
    select farm.id, farm.name, farm.test_farm_at, approval.approved_at,
      administrator.email
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
    // F-074 — the ADMIN surface is the one place a test farm is never hidden. An operator
    // managing the flag has to be able to see which farms carry it, and this reader is already
    // behind the session guard.
    isTestFarm: row.test_farm_at !== null,
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
  /** F-071 — VIGA has taken this stand down. It keeps every record it published. */
  retired: boolean;
  retiredAt: Date | null;
  farmBucksAccepted: boolean;
  farmBucksEligible: boolean;
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

/** Every stand and the operator-relevant facts that describe its current state. */
export async function listStandsForAdministration(db: Db): Promise<AdminStandRow[]> {
  const rows = await driver(db)`
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
      location.farm_bucks_accepted,
      location.farm_bucks_eligible,
      approval.approved_at,
      inventory.published_at,
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
      coalesce(
        (select jsonb_agg(jsonb_build_object(
          'itemName', entry.item_name,
          'quantity', entry.quantity,
          'unit', entry.unit,
          'priceText', entry.price_text,
          'approximation', entry.approximation
        ) order by entry.sort_order, entry.id)
         from inventory_entries entry
         where entry.inventory_revision_id = inventory.id),
        '[]'::jsonb
      ) as current_items
    from sales_locations location
    join farms farm on farm.id = location.owner_farm_id
    left join farm_approvals approval
      on approval.farm_id = farm.id and approval.revoked_at is null
    left join inventory_revisions inventory
      on inventory.sales_location_id = location.id and inventory.is_current
    left join closure_revisions closure
      on closure.sales_location_id = location.id and closure.is_current
    -- A retired stand is still LISTED here, deliberately: this queue is where an operator
    -- restores one, and a stand that vanished from the only surface that can bring it back
    -- would make retirement irreversible in practice. Sorted after the live ones so the
    -- working list is not interrupted by stands nobody is serving.
    order by (location.retired_at is not null), location.name, location.id
  `;

  return rows.map((row) => ({
    standId: row.stand_id as string,
    name: row.stand_name as string,
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
    retired: row.retired_at !== null,
    retiredAt: row.retired_at === null ? null : new Date(row.retired_at as string),
    farmBucksAccepted: row.farm_bucks_accepted as boolean,
    farmBucksEligible: row.farm_bucks_eligible as boolean,
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

export interface AdminUserRow {
  userId: string;
  senderMask: string;
  isFarmer: boolean;
  farms: string[];
}

/**
 * The smallest useful user directory: every SMS contact, its current farmer status, and the
 * farms it may publish for. Full numbers, contact hashes, message text, and timestamps are
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
         join farms farm on farm.id = farmer_authorization.farm_id
         where farmer_authorization.contact_id = contact.id
           and farmer_authorization.revoked_at is null),
        array[]::text[]
      ) as farms
    from contacts contact
    order by contact.id
  `;
  return rows.map((row) => ({
    userId: row.contact_id as string,
    senderMask: maskPhoneSuffix((row.sender_last_four as string | null) ?? null),
    isFarmer: row.is_farmer as boolean,
    farms: (row.farms as string[] | null) ?? [],
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
