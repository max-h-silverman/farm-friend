import { createPublicActionThrottle, SystemClock } from "@farm-friend/core";
import { describe, expect, it, vi } from "vitest";

import {
  handleVerificationRequestPost,
  handleVerificationSubmitPost,
  type VerificationRequestDeps,
  type VerificationSubmitDeps,
} from "./farmer-verification";

const FARM_ID = "11111111-2222-3333-4444-555555555555";
const SALT = "boundary-test-salt";

function post(body: unknown): Request {
  return new Request("https://example.test/api/farmer/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function requestDeps(overrides: Partial<VerificationRequestDeps> = {}): VerificationRequestDeps {
  return {
    db: {} as never,
    clock: new SystemClock(),
    throttle: createPublicActionThrottle({
      clock: new SystemClock(),
      limit: 100,
      windowMs: 60_000,
    }),
    emailSalt: SALT,
    codeSalt: SALT,
    clientSignalSalt: SALT,
    findVerifiableFarm: vi.fn(async () => true),
    issueCode: vi.fn(async () => ({ status: "issued" as const, id: "v1", code: "012345" })),
    sendCode: vi.fn(async () => ({ outcome: "accepted" as const })),
    ...overrides,
  };
}

describe("requesting a code — the uniform response", () => {
  it("answers `sent` for an address that IS on file", async () => {
    const response = await handleVerificationRequestPost(
      requestDeps(),
      post({ farmId: FARM_ID, email: "cathy@example.com" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "sent" });
  });

  it("answers IDENTICALLY for an address that is NOT on file", async () => {
    // THE acceptance criterion. A different answer here would tell anyone who asks which
    // address VIGA holds for a farm — the same discipline as phone-step's "if that number is
    // on file". The farmer learns the truth from their inbox, not from this response.
    const deps = requestDeps({ findVerifiableFarm: vi.fn(async () => false) });
    const response = await handleVerificationRequestPost(
      deps,
      post({ farmId: FARM_ID, email: "stranger@example.com" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "sent" });
  });

  it("sends NOTHING when the address is not on file, despite the identical answer", async () => {
    // The response is uniform; the EFFECT must not be. Mailing a stranger who guessed an
    // address would be both a leak and a way to use Farm Friend to send mail.
    const sendCode = vi.fn(async () => ({ outcome: "accepted" as const }));
    const deps = requestDeps({
      findVerifiableFarm: vi.fn(async () => false),
      issueCode: vi.fn(async () => {
        throw new Error("must not issue a code for an address that is not on file");
      }),
      sendCode,
    });
    await handleVerificationRequestPost(deps, post({ farmId: FARM_ID, email: "x@example.com" }));
    expect(sendCode).not.toHaveBeenCalled();
  });

  it("answers identically when the farm already has a live code", async () => {
    // Otherwise "already_live" is an oracle for whether someone else is mid-verification.
    const deps = requestDeps({
      issueCode: vi.fn(async () => ({ status: "already_live" as const })),
    });
    const response = await handleVerificationRequestPost(
      deps,
      post({ farmId: FARM_ID, email: "cathy@example.com" }),
    );
    expect(await response.json()).toEqual({ status: "sent" });
  });

  it("answers identically when the per-farm budget is spent", async () => {
    const deps = requestDeps({
      issueCode: vi.fn(async () => ({ status: "rate_limited" as const })),
    });
    const response = await handleVerificationRequestPost(
      deps,
      post({ farmId: FARM_ID, email: "cathy@example.com" }),
    );
    expect(await response.json()).toEqual({ status: "sent" });
  });

  it("answers identically when the relay REFUSES the message", async () => {
    // A farmer cannot act on "the relay rejected it" and an attacker learns from it that the
    // address was real enough to attempt. Operators see the failure in the send log.
    const deps = requestDeps({
      sendCode: vi.fn(async () => ({
        outcome: "definitive_rejection" as const,
        errorCode: "550",
      })),
    });
    const response = await handleVerificationRequestPost(
      deps,
      post({ farmId: FARM_ID, email: "cathy@example.com" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "sent" });
  });

  it("refuses a malformed farm id before any lookup", async () => {
    const findVerifiableFarm = vi.fn(async () => true);
    const response = await handleVerificationRequestPost(
      requestDeps({ findVerifiableFarm }),
      post({ farmId: "not-a-uuid", email: "cathy@example.com" }),
    );
    expect(response.status).toBe(400);
    expect(findVerifiableFarm).not.toHaveBeenCalled();
  });

  it("refuses a malformed address as a bad request, which discloses nothing", async () => {
    // Telling someone "that is not an email address" reveals nothing about who is on file, and
    // the alternative is a farmer with a typo waiting forever for mail that cannot arrive.
    const response = await handleVerificationRequestPost(
      requestDeps(),
      post({ farmId: FARM_ID, email: "not an address" }),
    );
    expect(response.status).toBe(400);
  });

  it("bounds the address length before hashing", async () => {
    const response = await handleVerificationRequestPost(
      requestDeps(),
      post({ farmId: FARM_ID, email: `${"a".repeat(400)}@example.com` }),
    );
    expect(response.status).toBe(400);
  });

  it("throttles by client signal BEFORE issuing, so a refused request costs nothing", async () => {
    const issueCode = vi.fn(async () => ({
      status: "issued" as const,
      id: "v1",
      code: "012345",
    }));
    const deps = requestDeps({
      throttle: createPublicActionThrottle({
        clock: new SystemClock(),
        limit: 1,
        windowMs: 60_000,
      }),
      issueCode,
    });
    await handleVerificationRequestPost(deps, post({ farmId: FARM_ID, email: "a@example.com" }));
    const second = await handleVerificationRequestPost(
      deps,
      post({ farmId: FARM_ID, email: "a@example.com" }),
    );
    expect(second.status).toBe(429);
    expect(issueCode).toHaveBeenCalledTimes(1);
  });

  it("never puts the submitted address in the response body", async () => {
    const response = await handleVerificationRequestPost(
      requestDeps(),
      post({ farmId: FARM_ID, email: "cathy@example.com" }),
    );
    expect(JSON.stringify(await response.json())).not.toContain("cathy@example.com");
  });

  it("never puts the CODE in the response body", async () => {
    // The code reaches the farmer's inbox and nowhere else. In the response it would make the
    // whole mechanism decorative.
    const response = await handleVerificationRequestPost(
      requestDeps(),
      post({ farmId: FARM_ID, email: "cathy@example.com" }),
    );
    expect(JSON.stringify(await response.json())).not.toContain("012345");
  });
});

describe("submitting a code", () => {
  function submitDeps(overrides: Partial<VerificationSubmitDeps> = {}): VerificationSubmitDeps {
    return {
      db: {} as never,
      clock: { now: () => new Date("2026-08-06T12:05:00Z") } as never,
      throttle: createPublicActionThrottle({
        clock: new SystemClock(),
        limit: 100,
        windowMs: 60_000,
      }),
      codeSalt: SALT,
      clientSignalSalt: SALT,
      readLive: vi.fn(async () => ({
        id: "v1",
        emailHash: "a".repeat(64),
        codeHash: "unused",
        issuedAt: new Date("2026-08-06T12:00:00Z"),
        consumedAt: null,
        attemptCount: 0,
      })),
      decide: vi.fn(() => ({ outcome: "verified" as const })),
      consumeAndGrant: vi.fn(async () => "grant-token"),
      recordFailure: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it("grants publish rights on a verified code", async () => {
    const onGranted = vi.fn();
    const response = await handleVerificationSubmitPost(
      submitDeps({ onGranted }),
      post({ farmId: FARM_ID, code: "012345" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "verified" });
    expect(onGranted).toHaveBeenCalledWith("grant-token");
  });

  it("never puts the grant token in the response BODY", async () => {
    // The grant is an HttpOnly cookie. In the body it would be readable by script, which is
    // the whole thing HttpOnly exists to prevent.
    const response = await handleVerificationSubmitPost(
      submitDeps(),
      post({ farmId: FARM_ID, code: "012345" }),
    );
    expect(JSON.stringify(await response.json())).not.toContain("grant-token");
  });

  it("grants NOTHING when the consume loses the race", async () => {
    // Two simultaneous redemptions: exactly one commits, and the loser must not be handed
    // rights on a code someone else already spent. A null return IS the loss.
    const onGranted = vi.fn();
    const response = await handleVerificationSubmitPost(
      submitDeps({ consumeAndGrant: vi.fn(async () => null), onGranted }),
      post({ farmId: FARM_ID, code: "012345" }),
    );
    expect(onGranted).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });

  it("does not consume the code when the decision refused", async () => {
    // A wrong guess must leave the code live — otherwise one bad attempt burns the farmer's
    // code and they cannot ask for another until the record ages out.
    const consumeAndGrant = vi.fn(async () => "grant-token");
    await handleVerificationSubmitPost(
      submitDeps({
        decide: vi.fn(() => ({ outcome: "wrong_code" as const })),
        consumeAndGrant,
      }),
      post({ farmId: FARM_ID, code: "999999" }),
    );
    expect(consumeAndGrant).not.toHaveBeenCalled();
  });

  it("counts a wrong code against the attempt budget", async () => {
    const recordFailure = vi.fn(async () => undefined);
    const response = await handleVerificationSubmitPost(
      submitDeps({
        decide: vi.fn(() => ({ outcome: "wrong_code" as const })),
        recordFailure,
      }),
      post({ farmId: FARM_ID, code: "999999" }),
    );
    expect(recordFailure).toHaveBeenCalledWith(expect.anything(), { id: "v1" });
    expect(response.status).toBe(400);
  });

  it("does NOT count a malformed code against the budget", async () => {
    // A typo is not a guess. Charging it would lock out the honest farmer faster than the
    // attacking one.
    const recordFailure = vi.fn(async () => undefined);
    await handleVerificationSubmitPost(
      submitDeps({
        decide: vi.fn(() => ({ outcome: "malformed_code" as const })),
        recordFailure,
      }),
      post({ farmId: FARM_ID, code: "12" }),
    );
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("answers uniformly for every refusal, so nothing is a guessing oracle", async () => {
    // Wrong / expired / used / capped / no-code-at-all must be indistinguishable. Any
    // distinction tells an attacker whether they are close.
    const bodies: string[] = [];
    for (const outcome of [
      "wrong_code",
      "expired",
      "already_used",
      "too_many_attempts",
    ] as const) {
      const response = await handleVerificationSubmitPost(
        submitDeps({ decide: vi.fn(() => ({ outcome })) }),
        post({ farmId: FARM_ID, code: "999999" }),
      );
      expect(response.status).toBe(400);
      bodies.push(JSON.stringify(await response.json()));
    }
    // And the case where no code was ever issued for this farm.
    const none = await handleVerificationSubmitPost(
      submitDeps({ readLive: vi.fn(async () => null) }),
      post({ farmId: FARM_ID, code: "999999" }),
    );
    expect(none.status).toBe(400);
    bodies.push(JSON.stringify(await none.json()));

    expect(new Set(bodies).size).toBe(1);
  });

  it("refuses a malformed farm id before reading anything", async () => {
    const readLive = vi.fn(async () => null);
    const response = await handleVerificationSubmitPost(
      submitDeps({ readLive }),
      post({ farmId: "nope", code: "012345" }),
    );
    expect(response.status).toBe(400);
    expect(readLive).not.toHaveBeenCalled();
  });

  it("throttles submissions, so the digit space cannot be ground down across records", async () => {
    // The per-record cap stops guessing at one code; this stops someone cycling records.
    const deps = submitDeps({
      throttle: createPublicActionThrottle({
        clock: new SystemClock(),
        limit: 1,
        windowMs: 60_000,
      }),
      decide: vi.fn(() => ({ outcome: "wrong_code" as const })),
    });
    await handleVerificationSubmitPost(deps, post({ farmId: FARM_ID, code: "111111" }));
    const second = await handleVerificationSubmitPost(
      deps,
      post({ farmId: FARM_ID, code: "222222" }),
    );
    expect(second.status).toBe(429);
  });
});
describe("a send that fails is REPORTED, not swallowed (B-026)", () => {
  /*
    THE PRODUCTION BLINDNESS THIS FIXES (max, 2026-08-09).

    A farmer reported never receiving her code. The endpoint answers a uniform "sent" by design
    — that is what stops it revealing which addresses are on file — and `createEmailSender`'s
    `logger` is OPTIONAL and was never wired. So every outcome, accepted and failed alike, was
    discarded: three separate investigations of the same incident had no evidence to read, and
    the only way to tell a delivered code from a dropped one was to ask the farmer.

    The uniform RESPONSE is unchanged. What changes is that the server records what happened.
  */
  it("records a failed send with its error code", async () => {
    const logged: unknown[] = [];
    const sendCode = vi.fn(async () => ({
      outcome: "ambiguous" as const,
      errorCode: "ETIMEDOUT",
    }));

    const response = await handleVerificationRequestPost(
      requestDeps({ sendCode, logSend: (entry) => logged.push(entry) }),
      post({ farmId: FARM_ID, email: "cathy@example.com" }),
    );

    // The farmer still sees the uniform answer — the response must not change.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "sent" });

    // But the server knows.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ outcome: "ambiguous", errorCode: "ETIMEDOUT" });
  });

  it("records an accepted send too, so silence means the code never got that far", async () => {
    // Logging only failures would make an absent line ambiguous: no send, or a send that
    // worked? The success line is what makes the failure line's absence meaningful.
    const logged: unknown[] = [];
    const sendCode = vi.fn(async () => ({ outcome: "accepted" as const }));

    await handleVerificationRequestPost(
      requestDeps({ sendCode, logSend: (entry) => logged.push(entry) }),
      post({ farmId: FARM_ID, email: "cathy@example.com" }),
    );

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ outcome: "accepted" });
  });

  it("never puts the farmer's address in the log", async () => {
    // Golden Rule #5: the hash is the only lookup/log key. An address in a log line is the
    // rich personal record the privacy posture refuses.
    const logged: unknown[] = [];
    await handleVerificationRequestPost(
      requestDeps({
        sendCode: vi.fn(async () => ({ outcome: "ambiguous" as const, errorCode: "ECONNRESET" })),
        logSend: (entry) => logged.push(entry),
      }),
      post({ farmId: FARM_ID, email: "cathy@example.com" }),
    );

    expect(JSON.stringify(logged)).not.toContain("cathy@example.com");
    expect(JSON.stringify(logged)).not.toContain("cathy");
  });
});
