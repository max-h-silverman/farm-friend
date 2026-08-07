import { describe, expect, it } from "vitest";

import {
  MAX_CODE_ATTEMPTS,
  MAX_CODES_PER_WINDOW,
  ISSUANCE_WINDOW_MINUTES,
  codeIssuanceAllowed,
  hashVerificationCode,
  verifySubmittedCode,
} from "./farm-verification";

const SALT = "test-verification-salt";
const ISSUED = new Date("2026-08-06T12:00:00Z");

describe("hashVerificationCode", () => {
  it("produces a 64-character lowercase hex digest, the shape the CHECK requires", () => {
    // The column's CHECK refuses anything else, so a mismatch here would be a row the database
    // rejects at insert — or worse, a row nothing can ever look up.
    expect(hashVerificationCode("012345", SALT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic under one salt and different under another", () => {
    expect(hashVerificationCode("012345", SALT)).toBe(hashVerificationCode("012345", SALT));
    expect(hashVerificationCode("012345", SALT)).not.toBe(
      hashVerificationCode("012345", "other-salt"),
    );
  });

  it("preserves LEADING ZEROS, which is the defect that would refuse a correct code", () => {
    // `generateVerificationCode` returns a string precisely so `012345` never becomes `12345`.
    // If anything in the hashing path coerced to a number, the farmer's correct code would be
    // refused with no way for them to tell why.
    expect(hashVerificationCode("012345", SALT)).not.toBe(hashVerificationCode("12345", SALT));
    expect(hashVerificationCode("000000", SALT)).not.toBe(hashVerificationCode("0", SALT));
  });
});

describe("verifySubmittedCode", () => {
  const live = {
    codeHash: hashVerificationCode("012345", SALT),
    issuedAt: ISSUED,
    consumedAt: null,
    attemptCount: 0,
  };

  it("accepts the right code on a live record", () => {
    const result = verifySubmittedCode({
      record: live,
      submitted: "012345",
      salt: SALT,
      now: new Date("2026-08-06T12:05:00Z"),
    });
    expect(result.outcome).toBe("verified");
  });

  it("accepts a code the farmer typed with spaces or hyphens", () => {
    // Copy-pasting from mail brings spaces and people group the digits themselves. Refusing
    // those sends a farmer who typed the RIGHT code to the reply button.
    for (const spelling of ["012 345", "012-345", " 012345 ", "01 23 45"]) {
      const result = verifySubmittedCode({
        record: live,
        submitted: spelling,
        salt: SALT,
        now: new Date("2026-08-06T12:05:00Z"),
      });
      expect(result.outcome, spelling).toBe("verified");
    }
  });

  it("refuses a wrong code and reports the attempt so the caller can count it", () => {
    const result = verifySubmittedCode({
      record: live,
      submitted: "999999",
      salt: SALT,
      now: new Date("2026-08-06T12:05:00Z"),
    });
    expect(result.outcome).toBe("wrong_code");
  });

  it("refuses a code that is not six digits at all, without consuming an attempt budget", () => {
    // A farmer who typed four digits made a typo, not a guess. Counting it against the attempt
    // cap would lock out the honest case faster than the attacking one.
    const result = verifySubmittedCode({
      record: live,
      submitted: "12ab",
      salt: SALT,
      now: new Date("2026-08-06T12:05:00Z"),
    });
    expect(result.outcome).toBe("malformed_code");
  });

  it("refuses an EXPIRED code even when the digits are right", () => {
    // 30 minutes after issue is the boundary, and the boundary is expired — the honest
    // direction to round is toward refusing.
    const result = verifySubmittedCode({
      record: live,
      submitted: "012345",
      salt: SALT,
      now: new Date("2026-08-06T12:30:00Z"),
    });
    expect(result.outcome).toBe("expired");
  });

  it("refuses an ALREADY CONSUMED code even when the digits are right", () => {
    // Single-use is the property that stops a code left in an inbox — or in a forwarded mail —
    // from being a standing key to the farm's listing.
    const result = verifySubmittedCode({
      record: { ...live, consumedAt: new Date("2026-08-06T12:02:00Z") },
      submitted: "012345",
      salt: SALT,
      now: new Date("2026-08-06T12:05:00Z"),
    });
    expect(result.outcome).toBe("already_used");
  });

  it("refuses once the attempt cap is reached, even for the RIGHT code", () => {
    // Six digits is a small space; what makes it safe is that guesses are capped. The right
    // code being refused at the cap is deliberate — otherwise an attacker who guesses correctly
    // on the last permitted try still wins, and the cap only rations the failures.
    const result = verifySubmittedCode({
      record: { ...live, attemptCount: MAX_CODE_ATTEMPTS },
      submitted: "012345",
      salt: SALT,
      now: new Date("2026-08-06T12:05:00Z"),
    });
    expect(result.outcome).toBe("too_many_attempts");
  });

  it("still permits the attempt exactly AT the cap boundary minus one", () => {
    const result = verifySubmittedCode({
      record: { ...live, attemptCount: MAX_CODE_ATTEMPTS - 1 },
      submitted: "012345",
      salt: SALT,
      now: new Date("2026-08-06T12:05:00Z"),
    });
    expect(result.outcome).toBe("verified");
  });

  it("checks the attempt cap BEFORE the code, so a capped record is not a guessing oracle", () => {
    // If the wrong-code branch ran first, a capped record would still answer "wrong_code" for a
    // wrong guess and something else for a right one — which is exactly the signal the cap
    // exists to withhold.
    const result = verifySubmittedCode({
      record: { ...live, attemptCount: MAX_CODE_ATTEMPTS },
      submitted: "999999",
      salt: SALT,
      now: new Date("2026-08-06T12:05:00Z"),
    });
    expect(result.outcome).toBe("too_many_attempts");
  });

  it("treats a clock that ran backwards as expired, never as indefinitely valid", () => {
    const result = verifySubmittedCode({
      record: live,
      submitted: "012345",
      salt: SALT,
      now: new Date("2026-08-06T11:00:00Z"),
    });
    expect(result.outcome).toBe("expired");
  });
});

describe("codeIssuanceAllowed", () => {
  it("permits issuance when the farm has asked for nothing recently", () => {
    expect(codeIssuanceAllowed({ recentIssueCount: 0 })).toBe(true);
  });

  it(`refuses once ${MAX_CODES_PER_WINDOW} codes were issued inside the window`, () => {
    // Each issuance sends a REAL email to a REAL farmer. Unrationed, this is both a mail bill
    // and a way to bury one farmer's inbox — and the client-signal throttle cannot see it,
    // because rotating the client signal is free.
    expect(codeIssuanceAllowed({ recentIssueCount: MAX_CODES_PER_WINDOW })).toBe(false);
    expect(codeIssuanceAllowed({ recentIssueCount: MAX_CODES_PER_WINDOW + 5 })).toBe(false);
  });

  it("permits the last issuance below the cap, so the boundary is not off by one", () => {
    expect(codeIssuanceAllowed({ recentIssueCount: MAX_CODES_PER_WINDOW - 1 })).toBe(true);
  });

  it("states a window that is a real duration", () => {
    expect(ISSUANCE_WINDOW_MINUTES).toBeGreaterThan(0);
  });
});
