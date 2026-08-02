import { createHash, randomBytes } from "node:crypto";

// Durable admin sessions (F-025a). A session is a DATABASE record, not a signed claim.
//
// The magic link proves *who you are*, once. The session is what makes that durable and
// REVOCABLE: administrator identity is looked up server-side on every
// request, so revoking an administrator takes effect immediately rather than when a
// self-contained token happens to expire.
//
// The browser holds opaque random material; only its hash is stored. That is the same
// discipline the phone hash follows (Golden Rule #5) — the hash is the lookup key, and a
// database read cannot recover a live credential.

/**
 * How long an operator session lasts. This is a standing credential to approve farms, so it
 * expires in a working day; re-authenticating is one email.
 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Mint opaque session material. 32 random bytes — never derived from the administrator. */
export function issueSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The stored lookup key for a session token. Unsalted SHA-256 is right here and wrong for
 * phones: the input is 256 bits of uniform randomness, so there is no candidate set to
 * enumerate, and the lookup must work without a configured secret.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The liveness-relevant projection of a session record. */
export interface SessionLifetime {
  expiresAt: Date;
  revokedAt: Date | null;
}

/** True iff the session is unrevoked and still inside its window at `now`. */
export function isSessionLive(session: SessionLifetime, now: Date): boolean {
  if (session.revokedAt !== null && now.getTime() >= session.revokedAt.getTime()) {
    return false;
  }
  return now.getTime() < session.expiresAt.getTime();
}
