import { describe, expect, it, vi } from "vitest";
import { runFlagAlertPass, type FlagAlertPassDeps } from "./flag-alert-pass";

/** The send seam's exact shape, so `mock.calls` is typed and assertions read the real fields. */
type Send = NonNullable<FlagAlertPassDeps["send"]>;
const sendMock = (impl: Send) => vi.fn<Parameters<Send>, ReturnType<Send>>(impl);

/*
  F-123 — VIGA is emailed when a FLAG or an issue report arrives.

  This suite owns the PASS: what it sends, what it never sends, and what it does when the mail
  server refuses. The once-only claim is the database's guarantee and is proven under real
  contention in `packages/db/src/flag-alerts.integration.test.ts`.

  The properties, each because of a specific way this could go wrong:

    - **A failed send releases the claim.** Otherwise one mail-server hiccup silently drops a
      safety alert forever, which is exactly the failure the feature exists to prevent.
    - **A refused flag does not stop the rest.** One bad address must not strand every other
      alert behind it.
    - **The email carries no phone material and no message text** (Golden Rule #5).
    - **Email unconfigured is not an error.** F-078 made an unconfigured deployment supported;
      the pass must no-op rather than throw, and must NOT claim flags it cannot send.
*/

function deps(overrides: Partial<FlagAlertPassDeps> = {}): FlagAlertPassDeps {
  return {
    db: {} as FlagAlertPassDeps["db"],
    clock: { now: () => new Date("2026-08-19T12:00:00Z") },
    recipient: "farmfriend@vigavashon.org",
    consoleUrl: "https://farmfriend.vigavashon.org/admin/messages",
    claim: vi.fn(async () => []),
    markAlerted: vi.fn(async () => {}),
    releaseClaim: vi.fn(async () => {}),
    send: sendMock(async () => ({ outcome: "accepted", providerMessageId: "m-1" })),
    ...overrides,
  };
}

const flag = (flagId: string, reasonCode = "sender_flagged") => ({
  flagId,
  senderMask: "(•••) •••-4320",
  reasonCode,
  createdAt: new Date("2026-08-19T11:59:00Z"),
});

describe("the flag alert pass", () => {
  it("emails the configured recipient once per new flag", async () => {
    const send = sendMock(async () => ({ outcome: "accepted", providerMessageId: "m-1" }));
    const markAlerted = vi.fn(async () => {});
    const d = deps({
      claim: vi.fn(async () => [flag("flag-1"), flag("flag-2", "issue_reported")]),
      send,
      markAlerted,
    });

    const result = await runFlagAlertPass(d);

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every((call) => call[0]?.toEmail === "farmfriend@vigavashon.org")).toBe(
      true,
    );
    expect(markAlerted).toHaveBeenCalledTimes(2);
  });

  it("says which kind of alert arrived, in words rather than in a reason code", async () => {
    // `sender_flagged` and `issue_reported` are storage vocabulary. A volunteer reading an
    // inbox on a phone needs the subject to say what happened.
    const send = sendMock(async () => ({ outcome: "accepted", providerMessageId: "m-1" }));
    await runFlagAlertPass(deps({ claim: vi.fn(async () => [flag("flag-1")]), send }));
    const first = send.mock.calls[0]?.[0];
    expect(first?.subject).not.toMatch(/sender_flagged/);
    expect(first?.subject.toLowerCase()).toContain("flag");

    const issueSend = sendMock(async () => ({ outcome: "accepted", providerMessageId: "m-1" }));
    await runFlagAlertPass(
      deps({ claim: vi.fn(async () => [flag("flag-2", "issue_reported")]), send: issueSend }),
    );
    const second = issueSend.mock.calls[0]?.[0];
    expect(second?.subject).not.toMatch(/issue_reported/);
    expect(second?.subject.toLowerCase()).toContain("issue");
  });

  it("carries no phone number, no hash, and no message text", async () => {
    const send = sendMock(async () => ({ outcome: "accepted", providerMessageId: "m-1" }));
    await runFlagAlertPass(deps({ claim: vi.fn(async () => [flag("flag-1")]), send }));

    const serialized = JSON.stringify(send.mock.calls[0]?.[0]);
    expect(serialized, "Golden Rule #5: no raw number").not.toMatch(/\+1\d{10}/);
    expect(serialized, "Golden Rule #5: no hash").not.toMatch(/[0-9a-f]{64}/);
    // The mask is what an operator reads, and it is the only sender material permitted.
    expect(serialized).toContain("4320");
  });

  it("links to the console rather than restating the message", async () => {
    const send = sendMock(async () => ({ outcome: "accepted", providerMessageId: "m-1" }));
    await runFlagAlertPass(deps({ claim: vi.fn(async () => [flag("flag-1")]), send }));
    expect(send.mock.calls[0]?.[0]?.text).toContain(
      "https://farmfriend.vigavashon.org/admin/messages",
    );
  });

  it("releases the claim when the send is refused, so the next pass retries", async () => {
    const releaseClaim = vi.fn(async () => {});
    const markAlerted = vi.fn(async () => {});
    const result = await runFlagAlertPass(
      deps({
        claim: vi.fn(async () => [flag("flag-1")]),
        send: sendMock(async () => ({ outcome: "definitive_rejection", errorCode: "550" })),
        releaseClaim,
        markAlerted,
      }),
    );

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(releaseClaim).toHaveBeenCalledWith(expect.anything(), { flagId: "flag-1" });
    expect(markAlerted, "a refused send must never look delivered").not.toHaveBeenCalled();
  });

  it("releases the claim when the transport throws", async () => {
    // A thrown transport is the same outcome as a refusal and must not escape the pass: an
    // exception here would abort every other scheduled job in the same cron request.
    const releaseClaim = vi.fn(async () => {});
    const result = await runFlagAlertPass(
      deps({
        claim: vi.fn(async () => [flag("flag-1")]),
        send: sendMock(async () => {
          throw new Error("connect ECONNREFUSED");
        }),
        releaseClaim,
      }),
    );

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(releaseClaim).toHaveBeenCalledWith(expect.anything(), { flagId: "flag-1" });
  });

  it("does NOT retry an ambiguous send, which may already have been delivered", async () => {
    /*
      `EmailDispatchOutcome` distinguishes a definitive rejection from an ambiguous one, and the
      distinction is load-bearing here. An ambiguous relay error means the mail may already be on
      its way; releasing the claim would mail VIGA the same alert again on the next pass, and
      again the pass after that, for as long as the relay kept answering ambiguously.

      So the claim STANDS: at most one email per flag. A possible silent miss is the right trade
      for an operator notice against a duplicate every minute.
    */
    const releaseClaim = vi.fn(async () => {});
    const markAlerted = vi.fn(async () => {});
    const result = await runFlagAlertPass(
      deps({
        claim: vi.fn(async () => [flag("flag-1")]),
        send: sendMock(async () => ({ outcome: "ambiguous", errorCode: "timeout" })),
        releaseClaim,
        markAlerted,
      }),
    );

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(
      releaseClaim,
      "an alert that may already have been sent must not be queued again",
    ).not.toHaveBeenCalled();
    expect(markAlerted, "nor may it be recorded as delivered").not.toHaveBeenCalled();
  });

  it("keeps sending the rest when one flag's email is refused", async () => {
    const send = sendMock(async () => ({ outcome: "accepted", providerMessageId: "m-2" }))
      .mockResolvedValueOnce({ outcome: "definitive_rejection", errorCode: "550" });
    const result = await runFlagAlertPass(
      deps({ claim: vi.fn(async () => [flag("flag-1"), flag("flag-2")]), send }),
    );

    expect(result, "one bad address must not strand every other alert").toEqual({
      sent: 1,
      failed: 1,
    });
  });

  it("does nothing, and claims nothing, when email is not configured", async () => {
    // F-078 — an unconfigured deployment is supported. Claiming here would mark flags alerted
    // that were never sent, which is worse than not running at all.
    const claim = vi.fn(async () => []);
    const result = await runFlagAlertPass(deps({ send: null, claim }));

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(claim, "a pass that cannot send must not consume its queue").not.toHaveBeenCalled();
  });

  it("does nothing when no recipient is configured", async () => {
    // The address is configuration, never a literal. Without one there is nowhere to send.
    const claim = vi.fn(async () => []);
    const result = await runFlagAlertPass(deps({ recipient: undefined, claim }));

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(claim).not.toHaveBeenCalled();
  });
});
