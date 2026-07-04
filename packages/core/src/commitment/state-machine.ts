import type { Clock } from "../clock";
import type { CommitmentToken } from "../sms/commands";

// The generic commitment state machine (docs/ARCHITECTURE.md §commitment state machine).
//
// One mechanism, TWO consumers — designed generically so it isn't over-fit to publish:
//   1. publish / activation confirm  — YES commits a pre-seeded or extracted inventory draft
//   2. gleaning signup               — YES/NO signs up / declines within an opportunity
//
// Invariants enforced here (Golden Rule #2, tested):
//   - a token with NO pending context does NOT commit;
//   - a pending confirmation commits the RIGHT action EXACTLY ONCE;
//   - a pending confirmation EXPIRES (a stale YES can never commit an old action).

/** The kind of action a pending confirmation will commit when accepted. */
export type PendingKind = "publish" | "activation" | "gleaning_signup";

export interface PendingConfirmation<Payload = unknown> {
  kind: PendingKind;
  payload: Payload;
  expiresAt: Date;
  /** Set once the confirmation has been consumed — guards exactly-once. */
  consumedAt?: Date;
}

export type CommitOutcome<Payload> =
  | { status: "committed"; kind: PendingKind; payload: Payload }
  | { status: "declined"; kind: PendingKind }
  | { status: "no_pending" } // token arrived with no pending context → does NOT commit
  | { status: "expired" } // pending existed but its window closed → GC, does NOT commit
  | { status: "already_consumed" }; // exactly-once guard: a second YES is a no-op

/**
 * Apply a commitment token against the current pending confirmation (or absence of one).
 * Pure: returns the outcome AND the next pending state so the caller persists it. The caller
 * (a flow) decides what to DO with a "committed" outcome — this machine only governs whether a
 * commit is legitimate, exactly once, within the expiry window.
 */
export function applyCommitment<Payload>(
  token: CommitmentToken,
  pending: PendingConfirmation<Payload> | null,
  clock: Clock,
): { outcome: CommitOutcome<Payload>; nextPending: PendingConfirmation<Payload> | null } {
  // No pending context: a YES/OUT/NO/IGNORE must NOT commit anything.
  if (!pending) {
    return { outcome: { status: "no_pending" }, nextPending: null };
  }

  // Exactly-once: a confirmation already consumed cannot commit again.
  if (pending.consumedAt) {
    return { outcome: { status: "already_consumed" }, nextPending: pending };
  }

  // Expiry: a stale pending is GC'd and commits nothing.
  if (clock.now() >= pending.expiresAt) {
    return { outcome: { status: "expired" }, nextPending: null };
  }

  const affirmative = token === "YES" || token === "OUT";
  if (affirmative) {
    const consumed: PendingConfirmation<Payload> = { ...pending, consumedAt: clock.now() };
    return {
      outcome: { status: "committed", kind: pending.kind, payload: pending.payload },
      nextPending: consumed,
    };
  }

  // NO / IGNORE: decline, clear the pending (nothing commits).
  return { outcome: { status: "declined", kind: pending.kind }, nextPending: null };
}

/** Construct a pending confirmation that expires `ttlMs` from now. */
export function createPending<Payload>(
  kind: PendingKind,
  payload: Payload,
  clock: Clock,
  ttlMs: number,
): PendingConfirmation<Payload> {
  return { kind, payload, expiresAt: new Date(clock.now().getTime() + ttlMs) };
}
