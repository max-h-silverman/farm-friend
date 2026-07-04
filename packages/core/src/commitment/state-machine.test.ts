import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock";
import { applyCommitment, createPending } from "./state-machine";

describe("generic commitment state machine (Golden Rule #2, two consumers)", () => {
  const t0 = new Date("2026-07-04T12:00:00Z");

  it("a token with NO pending context does not commit (non-contextual YES/OUT)", () => {
    const clock = new FixedClock(t0);
    for (const tok of ["YES", "OUT"] as const) {
      const { outcome } = applyCommitment(tok, null, clock);
      expect(outcome.status).toBe("no_pending");
    }
  });

  it("commits the RIGHT pending action exactly once", () => {
    const clock = new FixedClock(t0);
    const pending = createPending("publish", { snapshotId: "s1" }, clock, 60_000);

    const first = applyCommitment("YES", pending, clock);
    expect(first.outcome.status).toBe("committed");
    if (first.outcome.status === "committed") {
      expect(first.outcome.kind).toBe("publish");
      expect(first.outcome.payload).toEqual({ snapshotId: "s1" });
    }

    // A second YES against the now-consumed pending must be a no-op (exactly-once).
    const second = applyCommitment("YES", first.nextPending, clock);
    expect(second.outcome.status).toBe("already_consumed");
  });

  it("a pending confirmation expires — a stale YES never commits an old action", () => {
    const clock = new FixedClock(t0);
    const pending = createPending("activation", { standId: "st1" }, clock, 60_000);
    clock.advanceMs(60_001); // past expiry
    const { outcome, nextPending } = applyCommitment("YES", pending, clock);
    expect(outcome.status).toBe("expired");
    expect(nextPending).toBeNull(); // GC'd
  });

  it("serves BOTH consumers — gleaning signup uses the same machine", () => {
    const clock = new FixedClock(t0);
    const pending = createPending("gleaning_signup", { opportunityId: "o1" }, clock, 60_000);
    const { outcome } = applyCommitment("YES", pending, clock);
    expect(outcome.status).toBe("committed");
    if (outcome.status === "committed") expect(outcome.kind).toBe("gleaning_signup");
  });

  it("NO / IGNORE declines and clears the pending (nothing commits)", () => {
    const clock = new FixedClock(t0);
    const pending = createPending("publish", { snapshotId: "s1" }, clock, 60_000);
    const { outcome, nextPending } = applyCommitment("NO", pending, clock);
    expect(outcome.status).toBe("declined");
    expect(nextPending).toBeNull();
  });
});
