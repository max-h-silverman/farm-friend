import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_SMS_WELCOME,
  FARMER_AUTHORIZED_NOTIFICATION,
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  FARMER_SIGNUP_JOIN_INSTRUCTION,
  renderFarmerLinkMessage,
} from "./onboarding-copy";

// F-040 — the two things Farm Friend says to a farmer during onboarding, plus the link text.
//
// These are ORDINARY code-rendered copy, not registered carrier auto-responses. The
// distinction is load-bearing and `auto-responses.ts` states it: the three registered bodies
// are transcribed from live Telnyx console state and pinned character-for-character, so
// anything that drifts into that block silently claims carrier registration it does not have.
// The assertions below are what keep these three out of it.

const registeredFieldValues = resolve(
  __dirname,
  "../../../../docs/TELNYX_10DLC_FIELD_VALUES.txt",
);

describe("farmer onboarding copy", () => {
  it("gives a newly joined customer a usable introduction without exposing farmer controls", () => {
    expect(CUSTOMER_SMS_WELCOME.toLowerCase()).toContain("ask what is available");
    for (const keyword of ["MAP", "HELP", "STOP"]) {
      expect(CUSTOMER_SMS_WELCOME).toContain(keyword);
    }
    for (const farmerOnly of ["SIGNUP", "LINK", "STAND", "SETTINGS", "SAME", "YES", "NO"]) {
      expect(CUSTOMER_SMS_WELCOME).not.toContain(farmerOnly);
    }
  });

  it("acknowledges a request without promising authorization", () => {
    // A request grants nothing — VIGA always approves — so the acknowledgement must not read
    // as a yes. A farmer told "you're set up" who then cannot publish has been lied to by
    // the system, and will not try again.
    const body = FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT;
    expect(body).toContain("VIGA");
    // No language that claims the outcome.
    expect(body.toLowerCase()).not.toContain("you're set up");
    expect(body.toLowerCase()).not.toContain("you are set up");
    expect(body.toLowerCase()).not.toContain("approved");
    // The opt-out is always reachable.
    expect(body).toContain("STOP");
  });

  it("tells an authorized farmer they can update by text or open their private web form", () => {
    // The reason this message exists: a farmer approved on Tuesday otherwise has no idea
    // until they guess.
    const body = FARMER_AUTHORIZED_NOTIFICATION;
    expect(body).toContain("VIGA");
    expect(body).toContain("STOP");
    // It must actually tell them what to do next — an announcement with no instruction
    // leaves the farmer exactly where they were.
    expect(body).toContain("LINK");
    expect(body.length).toBeGreaterThan(40);
  });

  it("tells a farmer with no consent basis the one word that establishes it", () => {
    // The dead end this closes: SIGNUP alone establishes no consent, so the "your farm is
    // ready" text is suppressed and the farmer is never told. When the web agreement is not
    // available to lean on — a bare SIGNUP, or an invitation whose box was never ticked —
    // this is the only route left, and it must name the word that works.
    const body = FARMER_SIGNUP_JOIN_INSTRUCTION;
    expect(body).toContain("JOIN");
    expect(body).toContain("STOP");
    // First-time enrollment is JOIN's job; START is for returning after an opt-out (B-011)
    // and naming both here would ask a farmer to choose between them.
    expect(body).not.toContain("START");
    // It must not claim the request itself did anything about messaging.
    expect(body.toLowerCase()).not.toContain("you are subscribed");
    expect(body.toLowerCase()).not.toContain("you have agreed");
  });

  it("renders a link message carrying the link and nothing invented", () => {
    const link = "https://farmfriend.example/stand/" + "a".repeat(64);
    const body = renderFarmerLinkMessage(link);
    expect(body).toContain(link);
    expect(body).toContain("STOP");
  });

  it("never claims a link expires, because it does not", () => {
    // max chose a link that never expires until revoked. Copy promising a window would be
    // false, and would teach farmers to re-request links they do not need.
    const link = "https://farmfriend.example/stand/" + "b".repeat(64);
    const body = renderFarmerLinkMessage(link).toLowerCase();
    for (const claim of ["expires", "expire", "minutes", "hours", "24"]) {
      expect(body).not.toContain(claim);
    }
  });

  it("keeps all three OUT of the registered auto-response block", () => {
    // The tripwire. `auto-responses.test.ts` pins the registered bodies to this file in both
    // directions; if one of these were transcribed in, it would become carrier-registered
    // copy that nobody registered.
    const registered = readFileSync(registeredFieldValues, "utf8");
    for (const body of [
      FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
      FARMER_AUTHORIZED_NOTIFICATION,
      FARMER_SIGNUP_JOIN_INSTRUCTION,
    ]) {
      expect(registered).not.toContain(body);
    }
  });

  // The one-segment assertion lives in `packages/sms/src/onboarding-segments.test.ts`,
  // beside the estimator that can actually measure it. `core` declares no workspace
  // dependencies (the architecture tripwire enforces it), so it cannot import one here —
  // and a hand-rolled `.length <= 160` in this file would be a second, wrong answer to a
  // question the real estimator already answers: a curly quote forces UCS-2 and drops the
  // budget to 70, which a character count cannot see.
});
