import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock";
import { hashMagicNonce, issueMagicToken, verifyMagicToken } from "./magic-link";

describe("magic-link auth", () => {
  const secret = "test-secret";
  const t0 = new Date("2026-07-04T12:00:00Z");

  it("issues a token that verifies back to the email", () => {
    const clock = new FixedClock(t0);
    const token = issueMagicToken("farmer@vashon.org", secret, clock, 15 * 60_000);
    const result = verifyMagicToken(token, secret, clock);
    expect(result).toEqual({
      ok: true,
      email: "farmer@vashon.org",
      nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("rejects a tampered signature", () => {
    const clock = new FixedClock(t0);
    const token = issueMagicToken("a@b.c", secret, clock, 60_000);
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    const result = verifyMagicToken(tampered, secret, clock);
    expect(result.ok).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const clock = new FixedClock(t0);
    const token = issueMagicToken("a@b.c", secret, clock, 60_000);
    expect(verifyMagicToken(token, "other-secret", clock)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects an expired token", () => {
    const clock = new FixedClock(t0);
    const token = issueMagicToken("a@b.c", secret, clock, 60_000);
    clock.advanceMs(60_001);
    expect(verifyMagicToken(token, secret, clock)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed tokens", () => {
    const clock = new FixedClock(t0);
    expect(verifyMagicToken("garbage", secret, clock).ok).toBe(false);
    expect(verifyMagicToken("", secret, clock).ok).toBe(false);
  });

  // GL-004 — the link is a ONE-USE credential, and the thing that makes single use
  // enforceable is that each link carries its own identity. Without it two links for the
  // same administrator issued in the same millisecond are the same string, and "this link
  // has been used" has nothing to key on.

  it("gives every link its own unforgeable identity", () => {
    const clock = new FixedClock(t0);
    const a = issueMagicToken("a@b.c", secret, clock, 60_000);
    const b = issueMagicToken("a@b.c", secret, clock, 60_000);

    // Same address, same instant, same TTL — and still distinct, because the identity is
    // random rather than derived from the claims.
    expect(a).not.toBe(b);

    const verifiedA = verifyMagicToken(a, secret, clock);
    const verifiedB = verifyMagicToken(b, secret, clock);
    expect(verifiedA.ok).toBe(true);
    expect(verifiedB.ok).toBe(true);
    if (!verifiedA.ok || !verifiedB.ok) throw new Error("unreachable");

    expect(verifiedA.nonce).not.toBe(verifiedB.nonce);
    // 32 random bytes hex-encoded: the same bar the session token clears. A short or
    // structured value would be enumerable, and an attacker who can guess a nonce can burn
    // an operator's link before they open it.
    expect(verifiedA.nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it("issues a nonce that never repeats", () => {
    const clock = new FixedClock(t0);
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const verified = verifyMagicToken(
        issueMagicToken("a@b.c", secret, clock, 60_000),
        secret,
        clock,
      );
      if (!verified.ok) throw new Error("unreachable");
      nonces.add(verified.nonce);
    }
    expect(nonces.size).toBe(200);
  });

  it("covers the nonce with the signature", () => {
    // The nonce is what the consume record is keyed on, so a nonce an attacker can swap is
    // a nonce that buys an unlimited number of fresh single uses of one link.
    const clock = new FixedClock(t0);
    const token = issueMagicToken("a@b.c", secret, clock, 60_000);
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(
      Buffer.from(payload as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    claims.nonce = "0".repeat(64);
    const forged = `${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${signature}`;

    expect(verifyMagicToken(forged, secret, clock)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a well-signed token whose nonce is missing or malformed", () => {
    // Fail closed rather than defaulting: a token with no usable identity cannot be
    // consumed exactly once, so it must not authenticate at all. Signed here with the real
    // secret, so only the shape check can refuse it.
    const clock = new FixedClock(t0);
    for (const nonce of [undefined, "", "not-hex", "abc"]) {
      const claims: Record<string, unknown> = {
        email: "a@b.c",
        issuedAt: t0.getTime(),
        expiresAt: t0.getTime() + 60_000,
      };
      if (nonce !== undefined) claims.nonce = nonce;
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = createHmac("sha256", secret).update(payload).digest("base64url");

      expect(verifyMagicToken(`${payload}.${signature}`, secret, clock)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("hashes the nonce deterministically and one-way", () => {
    // What the database stores is the hash, never the nonce — the same discipline the
    // session token follows, so a database read cannot recover a live link.
    const clock = new FixedClock(t0);
    const verified = verifyMagicToken(
      issueMagicToken("a@b.c", secret, clock, 60_000),
      secret,
      clock,
    );
    if (!verified.ok) throw new Error("unreachable");

    expect(hashMagicNonce(verified.nonce)).toBe(hashMagicNonce(verified.nonce));
    expect(hashMagicNonce(verified.nonce)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMagicNonce(verified.nonce)).not.toBe(verified.nonce);

    const other = verifyMagicToken(
      issueMagicToken("a@b.c", secret, clock, 60_000),
      secret,
      clock,
    );
    if (!other.ok) throw new Error("unreachable");
    expect(hashMagicNonce(other.nonce)).not.toBe(hashMagicNonce(verified.nonce));
  });
});
