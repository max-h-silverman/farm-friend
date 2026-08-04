import { describe, expect, it } from "vitest";
import { REGISTERED_OPT_IN_AUTO_RESPONSE } from "./auto-responses";
import {
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  FARMER_SIGNUP_JOIN_INSTRUCTION,
} from "./onboarding-copy";
import { signupReplyBodies } from "./signup-reply";

// What a SIGNUP is answered with, decided as a pure function of what the write actually did.
//
// Kept out of `routing.ts` deliberately. The router owns the deterministic ORDER — which
// handler gets the message — and `routing.test.ts` proves that with a throwing model seam.
// Which words come back is a different question, it has four cases, and answering it inside
// the router would make it reachable only through a SQL stub shaped to produce each one.
//
// The rule the four cases encode: **say the true thing about messaging.** A farmer whose
// consent this SIGNUP established gets the carrier-registered receipt, because that is the
// text the carrier approved for exactly this moment. A farmer with no consent basis is told
// the one word that creates one, because otherwise the approval text is suppressed and they
// are never told anything again. A farmer who already consented is told neither — they need
// no instruction, and a second receipt would claim an agreement that did not happen today.

describe("signup reply bodies", () => {
  it("always leads with the acknowledgement, which promises nothing", () => {
    for (const consentEstablished of [true, false]) {
      for (const hadConsent of [true, false]) {
        const bodies = signupReplyBodies({ consentEstablished, hadConsent });
        expect(bodies[0]).toBe(FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT);
      }
    }
  });

  it("adds the REGISTERED opt-in receipt when this SIGNUP established consent", () => {
    // Verbatim from `auto-responses.ts`, which is transcribed from live Telnyx console
    // state and pinned bidirectionally. A paraphrase here would make live traffic differ
    // from what the carrier approved for an opt-in confirmation.
    const bodies = signupReplyBodies({ consentEstablished: true, hadConsent: false });

    expect(bodies).toEqual([
      FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
      REGISTERED_OPT_IN_AUTO_RESPONSE,
    ]);
    expect(bodies).not.toContain(FARMER_SIGNUP_JOIN_INSTRUCTION);
  });

  it("tells a farmer with NO consent basis to text JOIN", () => {
    // A bare SIGNUP, or an invited one whose agreement box was never ticked. Without this
    // the farmer is authorized in silence: the "your farm is ready" text is a proactive
    // category and the dispatch claim suppresses it forever.
    const bodies = signupReplyBodies({ consentEstablished: false, hadConsent: false });

    expect(bodies).toEqual([
      FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
      FARMER_SIGNUP_JOIN_INSTRUCTION,
    ]);
    expect(bodies).not.toContain(REGISTERED_OPT_IN_AUTO_RESPONSE);
  });

  it("says nothing about messaging to a farmer who already consented", () => {
    // max's named case — someone who texted JOIN as an ordinary customer and later onboards.
    // A JOIN instruction would be wrong (they already did), and a second opt-in receipt
    // would claim an agreement that was not made today. Silence on the subject is the only
    // true option.
    const bodies = signupReplyBodies({ consentEstablished: false, hadConsent: true });

    expect(bodies).toEqual([FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT]);
  });

  it("never sends both the receipt and the JOIN instruction", () => {
    // They contradict each other: one says consent exists, the other says it does not.
    for (const consentEstablished of [true, false]) {
      for (const hadConsent of [true, false]) {
        const bodies = signupReplyBodies({ consentEstablished, hadConsent });
        const both =
          bodies.includes(REGISTERED_OPT_IN_AUTO_RESPONSE) &&
          bodies.includes(FARMER_SIGNUP_JOIN_INSTRUCTION);
        expect(both).toBe(false);
      }
    }
  });

  it("never repeats a body, so no reply is sent twice", () => {
    for (const consentEstablished of [true, false]) {
      for (const hadConsent of [true, false]) {
        const bodies = signupReplyBodies({ consentEstablished, hadConsent });
        expect(new Set(bodies).size).toBe(bodies.length);
      }
    }
  });
});
