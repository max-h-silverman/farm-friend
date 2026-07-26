import { describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_TTL_MS,
  hashSessionToken,
  issueSessionToken,
  isSessionLive,
} from "./session";

// F-025a. A durable admin session is a DATABASE record, not a signed claim. The token the
// browser holds is opaque random material; only its hash is ever stored, so a database read
// cannot recover a live credential. Same discipline as the phone hash (Golden Rule #5): the
// hash is the lookup key.

describe("admin session tokens", () => {
  it("issues opaque high-entropy tokens that never repeat", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i += 1) tokens.add(issueSessionToken());
    expect(tokens.size).toBe(200);
    // 32 random bytes, hex-encoded. Below this a token is guessable, which is the whole
    // security of an opaque bearer credential.
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("hashes deterministically and one-way", () => {
    const token = issueSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    // The hash is not the token: storing it must not store the credential.
    expect(hashSessionToken(token)).not.toBe(token);
  });

  it("gives different tokens different hashes", () => {
    const a = issueSessionToken();
    const b = issueSessionToken();
    expect(hashSessionToken(a)).not.toBe(hashSessionToken(b));
  });

  it("treats a session as live only inside its window and while unrevoked", () => {
    const issuedAt = new Date("2026-07-26T12:00:00.000Z");
    const expiresAt = new Date(issuedAt.getTime() + ADMIN_SESSION_TTL_MS);

    const live = { expiresAt, revokedAt: null };
    expect(isSessionLive(live, issuedAt)).toBe(true);
    expect(isSessionLive(live, new Date(expiresAt.getTime() - 1))).toBe(true);

    // Expiry is exclusive at the boundary: a session is dead the instant it expires.
    expect(isSessionLive(live, expiresAt)).toBe(false);
    expect(isSessionLive(live, new Date(expiresAt.getTime() + 1))).toBe(false);
  });

  it("treats a revoked session as dead even before its expiry", () => {
    const issuedAt = new Date("2026-07-26T12:00:00.000Z");
    const expiresAt = new Date(issuedAt.getTime() + ADMIN_SESSION_TTL_MS);
    const revokedAt = new Date(issuedAt.getTime() + 60_000);

    const revoked = { expiresAt, revokedAt };
    // Before revocation the record was live; after it, it is not — regardless of expiry.
    expect(isSessionLive(revoked, new Date(issuedAt.getTime() + 30_000))).toBe(true);
    expect(isSessionLive(revoked, revokedAt)).toBe(false);
    expect(isSessionLive(revoked, new Date(revokedAt.getTime() + 1))).toBe(false);
  });

  it("bounds the session lifetime", () => {
    // An operator session is a standing credential to approve farms. It expires in a
    // working day, not a month.
    expect(ADMIN_SESSION_TTL_MS).toBeGreaterThan(0);
    expect(ADMIN_SESSION_TTL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
