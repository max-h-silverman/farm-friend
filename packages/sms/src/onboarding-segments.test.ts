import { describe, expect, it } from "vitest";
import {
  CUSTOMER_WELCOME,
  renderContactCardOffer,
  renderFarmerAuthorizedNotification,
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  FARMER_JOIN_INSTRUCTION,
  issueFarmerLinkToken,
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

  it("keeps the setup message within three segments, example and link included", () => {
    // This message does the most work of any we send: it names the channel, SHOWS how to phrase
    // an update, carries the private link, and names the recovery word. Measured against the
    // production host with a REAL minted token, which is what a farmer actually receives.
    //
    // **Three, and the history is worth keeping straight.** F-097 got this to two by shortening
    // the token and stripping the scaffolding around the URL; max then spent that budget
    // deliberately (2026-08-09) on a worked example — "we're out of eggs, replenished kale and
    // added radishes" — because stating the interface without demonstrating it left a farmer
    // guessing at a format that does not exist. The example is the most valuable line in the
    // message, so the segment goes to it rather than the bound forcing the copy.
    //
    // What this still catches is a FOURTH segment, and the blank lines are the likely cause:
    // each paragraph break costs a character in a message already near its ceiling.
    const link = `https://farm-friend-web-p5mfxfp5za-uw.a.run.app/stand/${issueFarmerLinkToken()}`;
    // The two-stand form is the longer one — it carries the extra STAND paragraph.
    const estimate = estimateSmsSegments(
      renderFarmerAuthorizedNotification(link, { standCount: 2 }),
    );
    expect(estimate.encoding).toBe("GSM-7");
    expect(estimate.segmentCount).toBeLessThanOrEqual(3);
  });

  it("costs a one-stand farmer less than a two-stand one", () => {
    // The STAND paragraph is real cost, imposed only on farmers who can act on it. Asserted as
    // a comparison rather than a fixed number, so it keeps holding as the copy changes.
    const link = `https://farm-friend-web-p5mfxfp5za-uw.a.run.app/stand/${issueFarmerLinkToken()}`;
    const one = renderFarmerAuthorizedNotification(link, { standCount: 1 });
    const two = renderFarmerAuthorizedNotification(link, { standCount: 2 });
    expect(one.length).toBeLessThan(two.length);
  });

  it("still fits the farmer whose link predates the shortened token", () => {
    // The 35 links live in production when F-097 landed are 64 hex, and `LINK` re-mints rather
    // than reformatting — so a farmer can hold an old-style link for as long as they never ask
    // for a new one. That message is longer, and it is still a message we send.
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
    // Asserted against the LONGEST link a farmer can hold rather than a short fixture: the
    // 64-hex tokens minted before F-097 are still live in production threads, and `LINK` is
    // exactly the message a farmer sends when the old one is lost.
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
