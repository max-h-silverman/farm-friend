import { describe, expect, it } from "vitest";
import {
  CUSTOMER_WELCOME,
  renderContactCardOffer,
  renderFarmerAuthorizedNotification,
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
    // The SETUP message left this list (F-094): it now carries the farmer's private link, so
    // one segment is out of reach. Its own bound is asserted below — the regression to catch
    // is one segment more than a message honestly needs, not the absence of a ceiling.
    //
    // The customer welcome came BACK to one segment in the same change, having lost the
    // contact-card URL to its own message. It is asserted separately because the estimator
    // also has to confirm the encoding.
    for (const body of [
      FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
      FARMER_JOIN_INSTRUCTION,
    ]) {
      const estimate = estimateSmsSegments(body);
      expect(estimate.encoding, body).toBe("GSM-7");
      expect(estimate.segmentCount, body).toBe(1);
    }
  });

  it("keeps the setup message within three segments, link and keywords included", () => {
    // F-093/F-094 — this message does the most work of any we send: it says the farm is live,
    // carries the private link, names the primary interface, and teaches three keywords the
    // farmer has no other channel for. Measured against the production host with a
    // full-length token, which is what a real farmer receives.
    //
    // Three is the honest ceiling, not an aspiration: two was not reachable without dropping
    // either the link or the keywords, and both are the point of the message. The regression
    // this catches is a FOURTH segment.
    const link = `https://farm-friend-web-p5mfxfp5za-uw.a.run.app/stand/${"a".repeat(64)}`;
    const estimate = estimateSmsSegments(renderFarmerAuthorizedNotification(link));
    expect(estimate.encoding).toBe("GSM-7");
    expect(estimate.segmentCount).toBeLessThanOrEqual(3);
  });

  it("costs the farmer with no stand less, having no link to carry", () => {
    // The fallback branch is a real message a real farmer receives, so it gets a real bound.
    const estimate = estimateSmsSegments(renderFarmerAuthorizedNotification(null));
    expect(estimate.encoding).toBe("GSM-7");
    expect(estimate.segmentCount).toBeLessThanOrEqual(2);
  });

  it("returns the customer welcome to ONE segment, the card having moved out", () => {
    // It held two while it carried the contact-card URL. That link is its own message now
    // (max 2026-08-08), so the welcome is back inside one segment — and this asserts the
    // tighter bound rather than leaving the old ceiling in place, since it rides beside the
    // opt-in receipt on every single JOIN.
    const estimate = estimateSmsSegments(CUSTOMER_WELCOME);
    expect(estimate.encoding).toBe("GSM-7");
    expect(estimate.segmentCount).toBe(1);
  });

  it("keeps the contact-card offer within one segment at the real production host", () => {
    // Measured against the address production actually serves from, not a short fixture: a
    // test using `https://example.com` would pass while the live message ran longer, which is
    // the failure mode this file exists to prevent.
    const estimate = estimateSmsSegments(
      renderContactCardOffer("https://farm-friend-web-p5mfxfp5za-uw.a.run.app"),
    );
    expect(estimate.encoding).toBe("GSM-7");
    expect(estimate.segmentCount).toBe(1);
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
