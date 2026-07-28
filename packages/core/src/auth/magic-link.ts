import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "../clock";

// Email magic-link auth (framework-agnostic core). A magic link carries a signed, expiring
// token; the web layer emails it and verifies it on the callback. The signature + expiry are
// code-enforced — never trusted from the client. See docs/RUNBOOK.md.
//
// **The link is ONE-USE, and this module supplies only half of that (GL-004).** A signature
// is stateless: it says a link is authentic, and it can say so any number of times. Single
// use is therefore not a property a verifier can have — the only thing that can decide "this
// one has already been used" is a durable record, written exactly once.
//
// So the division is: every link carries its own random `nonce`, covered by the signature,
// and the callback records that nonce's HASH under a unique index in the same insert that
// creates the session (`packages/db/src/admin.ts`). The database's unique index is the
// arbiter; the loser of a race gets no row and no session. Nothing here can be relied on for
// single use, and nothing here pretends to be.
//
// The nonce is hashed before storage for the same reason the session token is: the stored
// value is a lookup key, never a credential a database read could recover (Golden Rule #5).

export interface MagicToken {
  email: string;
  issuedAt: number; // epoch ms
  expiresAt: number; // epoch ms
  /**
   * This link's identity — 32 random bytes, hex. Random rather than derived, because two
   * links for one administrator in the same millisecond would otherwise be the same string
   * and consuming one would consume both.
   */
  nonce: string;
}

/** 32 random bytes hex-encoded, the shape the consume record's unique key requires. */
const NONCE_PATTERN = /^[0-9a-f]{64}$/;

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function unb64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * The stored lookup key for a link's nonce. Unsalted SHA-256, exactly as
 * `hashSessionToken` — the input is 256 bits of uniform randomness, so there is no candidate
 * set to enumerate, and the lookup must work without a configured secret.
 */
export function hashMagicNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

/** Issue a signed magic-link token valid for `ttlMs`, with its own single-use identity. */
export function issueMagicToken(
  email: string,
  secret: string,
  clock: Clock,
  ttlMs: number,
): string {
  const now = clock.now().getTime();
  const claims: MagicToken = {
    email,
    issuedAt: now,
    expiresAt: now + ttlMs,
    nonce: randomBytes(32).toString("hex"),
  };
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export type VerifyResult =
  | { ok: true; email: string; nonce: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify a magic-link token: signature first (constant-time), then shape, then expiry.
 *
 * A success returns the link's `nonce` because the caller cannot complete authentication
 * without it — consuming that nonce is what makes the link one-use, and a verifier that
 * returned only the email would leave the caller nothing to consume.
 */
export function verifyMagicToken(token: string, secret: string, clock: Clock): VerifyResult {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const payload = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(payload, secret);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: MagicToken;
  try {
    claims = JSON.parse(unb64url(payload)) as MagicToken;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Fail closed on a nonce that cannot key a consume record. This is reachable only for a
  // token we signed ourselves — a link minted before the nonce existed, or one whose claims
  // were somehow written without it — and such a link cannot be used exactly once, so it
  // must not be usable at all. Defaulting to a placeholder here would give every such link
  // the SAME identity, so the first one opened would consume all of them.
  if (typeof claims.nonce !== "string" || !NONCE_PATTERN.test(claims.nonce)) {
    return { ok: false, reason: "malformed" };
  }

  if (clock.now().getTime() >= claims.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, email: claims.email, nonce: claims.nonce };
}
