import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "../clock";

// Email magic-link auth (framework-agnostic core). A magic link carries a signed, expiring
// token; the web layer emails it and verifies it on the callback. The signature + expiry are
// code-enforced — never trusted from the client. See docs/RUNBOOK.md.

export interface MagicToken {
  email: string;
  issuedAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function unb64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Issue a signed magic-link token valid for `ttlMs`. */
export function issueMagicToken(
  email: string,
  secret: string,
  clock: Clock,
  ttlMs: number,
): string {
  const now = clock.now().getTime();
  const claims: MagicToken = { email, issuedAt: now, expiresAt: now + ttlMs };
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export type VerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/** Verify a magic-link token: signature first (constant-time), then expiry. */
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
  if (clock.now().getTime() >= claims.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, email: claims.email };
}
