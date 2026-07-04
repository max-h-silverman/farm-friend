import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock";
import { issueMagicToken, verifyMagicToken } from "./magic-link";

describe("magic-link auth", () => {
  const secret = "test-secret";
  const t0 = new Date("2026-07-04T12:00:00Z");

  it("issues a token that verifies back to the email", () => {
    const clock = new FixedClock(t0);
    const token = issueMagicToken("farmer@vashon.org", secret, clock, 15 * 60_000);
    const result = verifyMagicToken(token, secret, clock);
    expect(result).toEqual({ ok: true, email: "farmer@vashon.org" });
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
});
