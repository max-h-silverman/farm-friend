import {
  ISSUANCE_WINDOW_MINUTES,
  codeIssuanceAllowed,
  generateVerificationCode,
  hashEmail,
  hashFarmerLinkToken,
  hashVerificationCode,
  issueFarmerLinkToken,
  verificationExpiryFor,
  type VerificationRecord,
} from "@farm-friend/core";

import type { Db } from "./index";

// F-079 — the verification store.
//
// The durable half of the emailed code: issuing one, reading the live one back, counting
// failures against it, and consuming it exactly once. The DECISION about whether a submitted
// code opens a listing is not here — it lives in `packages/core/src/auth/farm-verification.ts`,
// pure and clock-injected. This module only reads and writes.
//
// **The database is the arbiter throughout, never a read-then-write in application code.**
// Issuance leans on the partial unique index, and consumption on a conditional UPDATE's
// `returning`. Both are races that occur in practice: a farmer double-taps "send it", or their
// mail client prefetches the page.

/** The one address column is never read here. Every lookup and every write uses a hash. */
export interface VerifiableFarmQuery {
  farmId: string;
  email: string;
  salt: string;
}

/**
 * Whether this address is on file FOR THIS FARM.
 *
 * **Scoped to the farm, and that scope is the cross-farm guarantee.** `0024`'s unique index is
 * deliberately per-farm rather than global, because a couple farming two plots from one inbox
 * is a real thing — so the index does not stop one farm's address verifying another. This
 * query does, by never asking a question broader than "this address, this farm".
 *
 * The submitted address is hashed before it reaches the predicate, so a raw address never
 * appears in a query log (Golden Rule #5).
 */
export async function findVerifiableFarmByEmail(
  db: Db,
  query: VerifiableFarmQuery,
): Promise<boolean> {
  const rows = (await db.sql`
    select 1 as present from farm_emails
    where farm_id = ${query.farmId} and email_hash = ${hashEmail(query.email, query.salt)}
    limit 1
  `) as unknown as Array<{ present: number }>;

  return rows.length > 0;
}

export interface IssueVerificationInput {
  farmId: string;
  /** Hashed here; the raw value reaches nothing below this call. */
  email: string;
  /** Salt for the address hash. */
  salt: string;
  /** Salt for the code hash. Separate parameter so the two are never assumed identical. */
  codeSalt: string;
  now: Date;
}

export type IssueVerificationResult =
  /** `code` is the PLAINTEXT, for the send path only. It is never stored and never logged. */
  | { status: "issued"; id: string; code: string }
  /** A live code already exists for this farm. */
  | { status: "already_live" }
  /** The farm's or the address's window budget is spent. */
  | { status: "rate_limited" };

/**
 * Issue a code for a farm.
 *
 * **The throttle is checked from stored rows, not from a client bucket.** Each issuance sends
 * real mail to a real farmer, so an attacker rotating their client signal must not be able to
 * bury one inbox. Both limits the item requires — per farm and per address — are the same rule
 * (`codeIssuanceAllowed`) applied to two counts, rather than two mechanisms.
 *
 * **`on conflict do nothing` is the concurrency arbiter.** A `select` for an existing live code
 * followed by an `insert` cannot serialize a row that does not exist yet: two simultaneous
 * requests both read nothing and both insert. The partial unique index
 * `farm_email_verifications_one_live_per_farm` decides, and an empty `returning` means the
 * other request won — which is reported as `already_live`, not as an error.
 */
export async function issueVerificationCode(
  db: Db,
  input: IssueVerificationInput,
): Promise<IssueVerificationResult> {
  const emailHash = hashEmail(input.email, input.salt);

  const counts = await countRecentIssuances(db, {
    farmId: input.farmId,
    emailHash,
    now: input.now,
  });
  if (
    !codeIssuanceAllowed({ recentIssueCount: counts.farmCount }) ||
    !codeIssuanceAllowed({ recentIssueCount: counts.emailCount })
  ) {
    return { status: "rate_limited" };
  }

  const code = generateVerificationCode();
  const rows = (await db.sql`
    insert into farm_email_verifications
      (farm_id, email_hash, code_hash, issued_at, expires_at)
    values (
      ${input.farmId},
      ${emailHash},
      ${hashVerificationCode(code, input.codeSalt)},
      ${input.now.toISOString()},
      ${verificationExpiryFor(input.now).toISOString()}
    )
    on conflict do nothing
    returning id
  `) as unknown as Array<{ id: string }>;

  // Empty means the partial unique index refused: a live code already exists for this farm.
  if (rows.length === 0) return { status: "already_live" };

  return { status: "issued", id: rows[0]!.id, code };
}

/**
 * Count issuances inside the throttle window, for the farm and for the address.
 *
 * Both counts come from one query so they describe the same instant — computing them
 * separately would let a row land between the two and make the pair inconsistent.
 */
export async function countRecentIssuances(
  db: Db,
  input: { farmId: string; emailHash: string; now: Date },
): Promise<{ farmCount: number; emailCount: number }> {
  const since = new Date(
    input.now.getTime() - ISSUANCE_WINDOW_MINUTES * 60_000,
  ).toISOString();

  const rows = (await db.sql`
    select
      count(*) filter (where farm_id = ${input.farmId})::int as farm_count,
      count(*) filter (where email_hash = ${input.emailHash})::int as email_count
    from farm_email_verifications
    where issued_at >= ${since}
      and (farm_id = ${input.farmId} or email_hash = ${input.emailHash})
  `) as unknown as Array<{ farm_count: number; email_count: number }>;

  return {
    farmCount: rows[0]?.farm_count ?? 0,
    emailCount: rows[0]?.email_count ?? 0,
  };
}

export interface LiveVerification extends VerificationRecord {
  id: string;
  emailHash: string;
}

/**
 * The farm's live (unconsumed) verification, if there is one.
 *
 * Returns the record the pure decision function needs and nothing more — no raw address, and
 * never the code, which exists only as a hash and only in the farmer's inbox.
 *
 * Expiry is NOT filtered here: an expired-but-unconsumed row must still be returned, so the
 * decision can answer `expired` rather than the caller reporting "no code was ever sent" to a
 * farmer who is holding one.
 */
export async function readLiveVerification(
  db: Db,
  input: { farmId: string },
): Promise<LiveVerification | null> {
  const rows = (await db.sql`
    select id, email_hash, code_hash, issued_at, consumed_at, attempt_count
    from farm_email_verifications
    where farm_id = ${input.farmId} and consumed_at is null
    limit 1
  `) as unknown as Array<{
    id: string;
    email_hash: string;
    code_hash: string;
    issued_at: string | Date;
    consumed_at: string | Date | null;
    attempt_count: number;
  }>;

  const row = rows[0];
  if (row === undefined) return null;

  return {
    id: row.id,
    emailHash: row.email_hash,
    codeHash: row.code_hash,
    issuedAt: new Date(row.issued_at),
    consumedAt: row.consumed_at === null ? null : new Date(row.consumed_at),
    attemptCount: row.attempt_count,
  };
}

/** Count one wrong guess against a code. The cap is what makes six digits safe. */
export async function recordFailedAttempt(db: Db, input: { id: string }): Promise<void> {
  // Incremented IN THE DATABASE rather than read-modify-written, so simultaneous guesses each
  // count. A read-then-write would let concurrent attempts overwrite one another and quietly
  // widen the budget — which is the whole defence against a six-digit space.
  await db.sql`
    update farm_email_verifications
    set attempt_count = attempt_count + 1
    where id = ${input.id}
  `;
}

/**
 * Consume a code, exactly once.
 *
 * **The `consumed_at is null` predicate is what makes this single-use**, not the read that
 * preceded it. Two simultaneous redemptions of one code both see a live row; the conditional
 * UPDATE lets exactly one of them match, and `returning` reports which. `true` means this call
 * is the one that committed.
 */
export async function consumeVerification(
  db: Db,
  input: { id: string; now: Date },
): Promise<boolean> {
  const rows = (await db.sql`
    update farm_email_verifications
    set consumed_at = ${input.now.toISOString()}
    where id = ${input.id} and consumed_at is null
    returning id
  `) as unknown as Array<{ id: string }>;

  return rows.length > 0;
}

/**
 * Consume a code AND mint its publish grant, in one statement.
 *
 * **One statement, not two, and that is the point.** Consuming and granting are the same
 * commitment: a consume that succeeded while the grant write failed would spend the farmer's
 * only code and hand them nothing, with no way to ask for another until the record aged out.
 * The conditional UPDATE makes both effects atomic and still decides the race — exactly one
 * caller matches `consumed_at is null`, and `returning` tells that caller it won.
 *
 * Returns the RAW grant token once, for the cookie. Only its hash is stored.
 */
export async function consumeAndGrant(
  db: Db,
  input: { id: string; now: Date; grantTtlMs: number },
): Promise<string | null> {
  const token = issueFarmerLinkToken();
  const grantExpiresAt = new Date(input.now.getTime() + input.grantTtlMs);

  const rows = (await db.sql`
    update farm_email_verifications
    set consumed_at = ${input.now.toISOString()},
        grant_hash = ${hashFarmerLinkToken(token)},
        grant_expires_at = ${grantExpiresAt.toISOString()}
    where id = ${input.id} and consumed_at is null
    returning id
  `) as unknown as Array<{ id: string }>;

  return rows.length > 0 ? token : null;
}

/**
 * Resolve a publish grant to the farm it may publish for, or null.
 *
 * **Re-read on EVERY request, never trusted from the cookie**, which is the same rule
 * `resolveFarmerLink` follows: the token carries no claims at all, so which farm it opens and
 * whether it still works are database facts. Expiry is compared here rather than assumed from
 * the cookie's `Max-Age`, because a browser is free to keep sending an expired cookie.
 */
export async function resolvePublishGrant(
  db: Db,
  input: { token: string; now: Date },
): Promise<{ farmId: string } | null> {
  const rows = (await db.sql`
    select farm_id from farm_email_verifications
    where grant_hash = ${hashFarmerLinkToken(input.token)}
      and grant_expires_at > ${input.now.toISOString()}
    limit 1
  `) as unknown as Array<{ farm_id: string }>;

  const farmId = rows[0]?.farm_id;
  return farmId === undefined ? null : { farmId };
}

/** The farm's name, for the email body. Named in the first sentence so a code has context. */
export async function readFarmName(db: Db, farmId: string): Promise<string | null> {
  const rows = (await db.sql`
    select name from farms where id = ${farmId} limit 1
  `) as unknown as Array<{ name: string }>;

  return rows[0]?.name ?? null;
}
