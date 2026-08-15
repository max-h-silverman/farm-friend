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
    select 1 as present from seller_emails
    where seller_id = ${query.farmId} and email_hash = ${hashEmail(query.email, query.salt)}
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
  /**
   * A concurrent request won the race and issued the live code for this farm.
   *
   * No longer returned for the farmer's own earlier code — that is SUPERSEDED (see below).
   * This is now only the genuine simultaneous-request case.
   */
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
 * `seller_email_verifications_one_live_per_farm` decides, and an empty `returning` means the
 * other request won — which is reported as `already_live`, not as an error.
 *
 * **A code the farmer never used is SUPERSEDED, not a wall** (max, 2026-08-09). The index is
 * partial on `consumed_at IS NULL`, so an UNUSED code held the farm's only slot until it was
 * consumed — and expiry does not release it. A farmer whose first mail never arrived was
 * refused for the next thirty minutes while the route answered "sent", with nothing on screen
 * to escape it. Production hit exactly this.
 *
 * Superseding retires the farm's own live row inside this transaction, so the invariant is
 * unchanged — still exactly one live code, and the old one stops opening the listing the
 * moment the new one exists. What changes is which request wins: the farmer's newest intent,
 * rather than her abandoned first attempt.
 *
 * The retired row is KEPT, marked consumed. It is the record that a code was issued and never
 * used, which is what an operator reads when a farmer reports this. Deleting it would erase
 * the only evidence of the failure being diagnosed.
 *
 * The rate limit above is what still bounds this: superseding is not a way to send unlimited
 * mail, because the window budget is counted from issued rows and is checked first.
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

  return db.sql.begin(async (tx) => {
    /*
      Retire only a code this farmer has ALREADY BEEN SENT — never one issued microseconds ago
      by a request still in flight.

      This guard is the WHOLE arbiter, and a farm-level `for update` lock was tried here and
      deleted: with the timestamp comparison in place the lock changed nothing (removing it
      again leaves all 25 tests green), so it was a line claiming to protect something it did
      not. `issued_at < now` is what separates a RETRY from a RACE. Eight simultaneous requests share
      one instant, so none of them can retire another's code and exactly one wins on the index —
      the guarantee the eight-claimant test states. A farmer coming back later carries a later
      instant, so her request supersedes the code she never received.

      Strict `<`, never `<=`: with equal timestamps the comparison must be FALSE, or the race
      collapses back into all-succeed.
    */
    await tx`
      update seller_email_verifications
      set consumed_at = ${input.now.toISOString()}
      where seller_id = ${input.farmId}
        and consumed_at is null
        and issued_at < ${input.now.toISOString()}
    `;

    const rows = (await tx`
      insert into seller_email_verifications
        (seller_id, email_hash, code_hash, issued_at, expires_at)
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

    // Still empty: a CONCURRENT request inserted between the retire and this insert. The index
    // decided, and the other request's code is the live one — which is what the farmer will be
    // sent, so this is not an error.
    if (rows.length === 0) return { status: "already_live" as const };

    return { status: "issued" as const, id: rows[0]!.id, code };
  });
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
      count(*) filter (where seller_id = ${input.farmId})::int as farm_count,
      count(*) filter (where email_hash = ${input.emailHash})::int as email_count
    from seller_email_verifications
    where issued_at >= ${since}
      and (seller_id = ${input.farmId} or email_hash = ${input.emailHash})
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
    from seller_email_verifications
    where seller_id = ${input.farmId} and consumed_at is null
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
    update seller_email_verifications
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
    update seller_email_verifications
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
    update seller_email_verifications
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
    select seller_id from seller_email_verifications
    where grant_hash = ${hashFarmerLinkToken(input.token)}
      and grant_expires_at > ${input.now.toISOString()}
    limit 1
  `) as unknown as Array<{ seller_id: string }>;

  const farmId = rows[0]?.seller_id;
  return farmId === undefined ? null : { farmId };
}

/** The farm's name, for the email body. Named in the first sentence so a code has context. */
export async function readFarmName(db: Db, farmId: string): Promise<string | null> {
  const rows = (await db.sql`
    select name from sellers where id = ${farmId} limit 1
  `) as unknown as Array<{ name: string }>;

  return rows[0]?.name ?? null;
}
