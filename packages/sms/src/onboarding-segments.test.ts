import { describe, expect, it } from "vitest";
import {
  CUSTOMER_SMS_WELCOME,
  FARMER_AUTHORIZED_NOTIFICATION,
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  FARMER_JOIN_INSTRUCTION,
  renderFarmerLinkMessage,
} from "@farm-friend/core";
import { estimateSmsSegments } from "./segments";

// F-040 — what the onboarding messages actually COST a farmer to receive.
//
// This assertion lives here rather than beside the copy because `packages/core` declares no
// workspace dependencies (the architecture tripwire enforces it) and so cannot reach the
// estimator. A `.length <= 160` check in core would have been a second, wrong answer to a
// question this estimator already answers: a curly apostrophe or a typographic dash silently
// forces UCS-2 and drops the budget from 160 to 70 characters, which a character count cannot
// see. That is not hypothetical — an apostrophe typed on a Mac is `'`, not `'`.
//
// The farmers receiving these are on real handsets, some on prepaid plans. A 3-segment
// administrative announcement is a real cost imposed on someone for reading it.

describe("onboarding message segments", () => {
  it("sends each fixed onboarding message as ONE GSM-7 segment", () => {
    for (const body of [
      FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
      FARMER_AUTHORIZED_NOTIFICATION,
      FARMER_JOIN_INSTRUCTION,
      CUSTOMER_SMS_WELCOME,
    ]) {
      const estimate = estimateSmsSegments(body);
      expect(estimate.encoding, body).toBe("GSM-7");
      expect(estimate.segmentCount, body).toBe(1);
    }
  });

  it("keeps the link message within two segments even with a full-length token", () => {
    // The link carries a 64-character token plus the configured origin, so one segment is
    // not achievable and pretending otherwise would be a target nobody could hit. Two is the
    // honest bound, asserted against the LONGEST realistic link rather than a short fixture.
    const link = `https://farm-friend-web-p5mfxfp5za-uw.a.run.app/stand/${"a".repeat(64)}`;
    const estimate = estimateSmsSegments(renderFarmerLinkMessage(link));
    expect(estimate.encoding).toBe("GSM-7");
    expect(estimate.segmentCount).toBeLessThanOrEqual(2);
  });

  it("detects the UCS-2 downgrade this test exists to catch", () => {
    // Proves the check can fail. Without this, a mistake in the assertion above would make
    // it pass forever while measuring nothing — and the failure mode being guarded is
    // exactly one invisible character.
    const withCurlyQuote = "VIGA Farm Friend: You’re all set.";
    expect(estimateSmsSegments(withCurlyQuote).encoding).toBe("UCS-2");
  });
});
