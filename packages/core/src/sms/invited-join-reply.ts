import { JOIN_OPT_IN_AUTO_RESPONSE } from "./auto-responses";

/** What a completed farmer redemption did to this sender's consent. */
export interface InvitedJoinConsentOutcome {
  /** This redemption established launch-program consent. */
  consentEstablished: boolean;
  /** A consent record existed beforehand — active OR stopped. */
  hadConsent: boolean;
  /**
   * This redemption set the farmer up (F-067) — an agreed invitation naming a farm, redeemed
   * from the handset. When true there is no VIGA review to wait for, and the same
   * transaction has already queued the "your farm is ready" notification.
   *
   * The router only calls this function when it is true; see the note below.
   */
  authorized?: boolean;
}

/**
 * The bodies a COMPLETED farmer redemption is answered with.
 *
 * Pure, and kept out of the router on purpose: `routing.ts` owns the deterministic ORDER —
 * which handler receives a message — and proves it with a throwing model seam. Which words
 * come back is a separate question, and deciding it inside the router would make each case
 * reachable only through a SQL stub shaped to produce it.
 *
 * A farmer set up on the spot is NOT waiting on VIGA, so the acknowledgement's three claims
 * ("VIGA has your request", "they will review it", "they will text you when your farm is
 * ready") are all false for them and it is not sent. The same transaction queues
 * `FARMER_AUTHORIZED_NOTIFICATION`, which says the farm is ready and what to do about it.
 *
 * What remains is one question — did THIS message establish consent? If so the
 * carrier-registered receipt is owed, verbatim, because that is the moment the copy was
 * approved for. If the sender already had a record, a second receipt would claim an agreement
 * that was not made today, so nothing is said about messaging at all.
 *
 * ## Why this function is smaller than it was (B-043)
 *
 * It used to answer four cases. `routing.ts` calls it at ONE site, guarded by `onboarded` and
 * passing a literal `authorized: true`, so the three branches for an unauthorized redemption
 * were unreachable — among them the one that told a farmer to "reply START", copy that could
 * never be delivered and that named the wrong word after `VIGA` became the onboarding keyword.
 *
 * The farmer those branches were written for is answered by the router's own
 * `awaitingCoordinator` case, which sends the acknowledgement alone: they are waiting on a
 * person, and no keyword they can send changes that (max, 2026-08-12).
 */
export function invitedJoinReplyBodies(outcome: InvitedJoinConsentOutcome): string[] {
  return outcome.consentEstablished ? [JOIN_OPT_IN_AUTO_RESPONSE] : [];
}
