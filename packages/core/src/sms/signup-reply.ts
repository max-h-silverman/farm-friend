import { REGISTERED_OPT_IN_AUTO_RESPONSE } from "./auto-responses";
import {
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  FARMER_SIGNUP_JOIN_INSTRUCTION,
} from "./onboarding-copy";

/** What the SIGNUP write actually did to this sender's consent. */
export interface SignupConsentOutcome {
  /** This SIGNUP established launch-program consent. */
  consentEstablished: boolean;
  /** A consent record existed beforehand — active OR stopped. */
  hadConsent: boolean;
}

/**
 * The bodies a SIGNUP is answered with, in order.
 *
 * Pure, and kept out of the router on purpose: `routing.ts` owns the deterministic ORDER —
 * which handler receives a message — and proves it with a throwing model seam. Which words
 * come back is a separate question with four cases, and deciding it inside the router would
 * make each case reachable only through a SQL stub shaped to produce it.
 *
 * The acknowledgement always leads, because it is the answer to what the farmer actually
 * asked, and it promises nothing (VIGA always approves). What follows it says the true
 * thing about messaging:
 *
 *   - **consent just established** → the carrier-registered opt-in receipt, verbatim. This
 *     is the moment that copy was registered for.
 *   - **no consent basis at all** → the JOIN instruction, or the farmer is authorized into
 *     silence and never hears from Farm Friend again.
 *   - **already consented** → nothing. No instruction is needed, and a second receipt would
 *     claim an agreement that was not made today.
 *
 * The receipt and the instruction are mutually exclusive by construction: they contradict
 * each other, one asserting consent exists and the other that it does not.
 */
export function signupReplyBodies(outcome: SignupConsentOutcome): string[] {
  if (outcome.consentEstablished) {
    return [
      FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
      REGISTERED_OPT_IN_AUTO_RESPONSE,
    ];
  }
  if (outcome.hadConsent) {
    return [FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT];
  }
  return [FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT, FARMER_SIGNUP_JOIN_INSTRUCTION];
}
