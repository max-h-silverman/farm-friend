import { createHmac } from "node:crypto";

import { CODE_TTL_MINUTES, isCodeExpired, normalizeSubmittedCode } from "./email-verification";

// F-079 — deciding whether a submitted code opens a farm's listing.
//
// PURE, and clock-injected. Everything here is a decision about a record the caller already
// read; nothing reaches a database or a mail server. That is what makes every branch below
// testable at its boundary, including the ones that only occur under attack.
//
// ## The model never reaches any of this
//
// Verification is a deterministic code path start to finish. There is no seam here a model
// could be handed and no prose for one to interpret — which is the property that has to hold,
// because this decides who may publish onto VIGA's public map (Golden Rule #3 and #6).

/**
 * Wrong guesses permitted against one issued code.
 *
 * Six digits is one in a million per guess, which sounds ample and is not: unrationed, a
 * million requests is an afternoon. The cap is what makes a short, human-typable code safe, so
 * it is part of the credential's design rather than a courtesy.
 *
 * Five is chosen against the honest case, not the attacking one — a farmer reading digits off a
 * phone screen mistypes once or twice, never five times. At the cap they request a new code,
 * which is one tap and costs them nothing.
 */
export const MAX_CODE_ATTEMPTS = 5;

/** How far back the issuance throttle counts. */
export const ISSUANCE_WINDOW_MINUTES = 60;

/**
 * Codes that may be issued for one farm — or to one address — inside the window.
 *
 * Each issuance sends REAL MAIL to a REAL farmer. Unrationed this is two problems at once: a
 * mail bill, and a way to bury one farmer's inbox in codes they did not ask for.
 *
 * **The coarse client throttle cannot do this job.** `createPublicActionThrottle` rations by a
 * client bucket, so rotating the signal is free and one farm's inbox is still reachable. This
 * limit is counted from the stored rows instead, which is why it holds across containers,
 * across restarts, and against a caller who changes address.
 */
export const MAX_CODES_PER_WINDOW = 3;

/**
 * HMAC-SHA256 of a verification code. The stored form; the code itself lives only in the
 * farmer's inbox.
 *
 * Takes the code as a STRING and hashes it as one, so `012345` and `12345` are different
 * credentials. A number anywhere in this path would silently drop the leading zero and refuse a
 * farmer who typed exactly the right digits.
 *
 * Returns lowercase hex, the shape `seller_email_verifications_code_hash_is_digest` requires — a
 * mismatch would be a row the database refuses, or one nothing can ever match.
 */
export function hashVerificationCode(code: string, salt: string): string {
  return createHmac("sha256", salt).update(code).digest("hex");
}

/** The stored fields a verification decision reads. Deliberately not the whole row. */
export interface VerificationRecord {
  codeHash: string;
  issuedAt: Date;
  /** NULL means still live. Set once, on redemption. */
  consumedAt: Date | null;
  attemptCount: number;
}

export type VerificationOutcome =
  | { outcome: "verified" }
  /** The digits were wrong. The caller counts this against the cap. */
  | { outcome: "wrong_code" }
  /** Not six digits at all — a typo, not a guess. Never counted against the cap. */
  | { outcome: "malformed_code" }
  | { outcome: "expired" }
  | { outcome: "already_used" }
  | { outcome: "too_many_attempts" };

export interface VerifySubmittedCodeInput {
  record: VerificationRecord;
  submitted: string;
  salt: string;
  now: Date;
}

/**
 * Decide whether a submitted code opens the farm's listing.
 *
 * **The order of these branches is the security property, not a style choice.**
 *
 * The attempt cap is checked FIRST. If the wrong-code comparison ran ahead of it, a record that
 * had already exhausted its budget would still answer `wrong_code` for a bad guess and
 * something else for a good one — which is precisely the signal the cap exists to withhold. A
 * capped record must be uninformative regardless of what was typed.
 *
 * A malformed submission is separated from a wrong one so the caller can decline to count it.
 * A farmer who typed four digits made a typo; charging that against a five-attempt budget locks
 * out the honest case faster than the attacking one.
 */
export function verifySubmittedCode(input: VerifySubmittedCodeInput): VerificationOutcome {
  const { record, salt, now } = input;

  // FIRST. A capped record answers the same thing no matter what was submitted.
  if (record.attemptCount >= MAX_CODE_ATTEMPTS) return { outcome: "too_many_attempts" };

  // Single-use. A code sitting in an inbox — or in a forwarded mail — is not a standing key.
  if (record.consumedAt !== null) return { outcome: "already_used" };

  // Expiry before the comparison, so a stale record never verifies. `isCodeExpired` also
  // treats a backwards clock as expired: a clock that ran backwards must never produce a code
  // that is valid indefinitely.
  if (isCodeExpired(record.issuedAt, now)) return { outcome: "expired" };

  const normalized = normalizeSubmittedCode(input.submitted);
  if (normalized === null) return { outcome: "malformed_code" };

  if (hashVerificationCode(normalized, salt) !== record.codeHash) {
    return { outcome: "wrong_code" };
  }

  return { outcome: "verified" };
}

/**
 * Whether another code may be issued, given how many went out inside the window.
 *
 * Separated from the count itself so the rule is testable without a database, and so the
 * caller can apply the SAME rule to the farm and to the address — the two limits the item
 * requires, one mechanism rather than two.
 */
export function codeIssuanceAllowed(input: { recentIssueCount: number }): boolean {
  return input.recentIssueCount < MAX_CODES_PER_WINDOW;
}

/** When a code issued now should expire. One statement of the window, shared with the email. */
export function verificationExpiryFor(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + CODE_TTL_MINUTES * 60_000);
}
