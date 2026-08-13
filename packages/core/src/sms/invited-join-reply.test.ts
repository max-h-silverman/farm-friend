import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { JOIN_OPT_IN_AUTO_RESPONSE } from "./auto-responses";
import { FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT } from "./onboarding-copy";
import { invitedJoinReplyBodies } from "./invited-join-reply";

// What a COMPLETED farmer redemption is answered with, as a pure function of what the write did.
//
// Kept out of `routing.ts` deliberately. The router owns the deterministic ORDER — which handler
// gets the message — and `routing.test.ts` proves that with a throwing model seam. Which words
// come back is a different question, and answering it inside the router would make each case
// reachable only through a SQL stub shaped to produce it.
//
// ## The scope this function actually has (B-043)
//
// It used to carry four cases, three of which no caller could reach. `routing.ts` invokes it at
// ONE site, guarded by `onboarded`, passing the literal `authorized: true` — so the branches for
// an unauthorized redemption were dead code, and `FARMER_JOIN_INSTRUCTION` could not reach a
// handset at all. The un-ticked farmer is answered by the router's own `awaitingCoordinator`
// branch, which sends the acknowledgement alone.
//
// The rule the surviving cases encode: **say the true thing about messaging.** A farmer set up on
// the spot is not waiting for a review, so the acknowledgement's promises are false for them and
// it is dropped. The carrier-registered receipt rides along only when THIS message established
// consent, which is the moment that copy was approved for.

const SOURCE = new URL("./invited-join-reply.ts", import.meta.url);

describe("completed-redemption reply bodies", () => {
  it("sends the carrier receipt when this redemption established consent", () => {
    // Verbatim from `auto-responses.ts`, which is transcribed from live Telnyx console state and
    // pinned bidirectionally. A paraphrase here would make live traffic differ from what the
    // carrier approved for an opt-in confirmation.
    const bodies = invitedJoinReplyBodies({
      consentEstablished: true,
      hadConsent: false,
      authorized: true,
    });

    expect(bodies).toEqual([JOIN_OPT_IN_AUTO_RESPONSE]);
  });

  it("says nothing when the farmer already had a consent record", () => {
    // A second receipt would claim an agreement that was not made today.
    const bodies = invitedJoinReplyBodies({
      consentEstablished: false,
      hadConsent: true,
      authorized: true,
    });

    expect(bodies).toEqual([]);
  });

  it("never promises a VIGA review, because this farmer was set up on the spot", () => {
    /*
      F-067 — the acknowledgement makes three claims ("VIGA has your request", "they will review
      it", "they will text you when your farm is ready") that are all false for a farmer already
      authorized, and it would arrive in the same breath as the "your farm is ready" notification
      the same transaction queues. A farmer reading both learns the system contradicts itself.
    */
    for (const consentEstablished of [true, false]) {
      for (const hadConsent of [true, false]) {
        const bodies = invitedJoinReplyBodies({
          consentEstablished,
          hadConsent,
          authorized: true,
        });
        expect(bodies).not.toContain(FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT);
      }
    }
  });

  it("never repeats a body, so no reply is sent twice", () => {
    for (const consentEstablished of [true, false]) {
      for (const hadConsent of [true, false]) {
        const bodies = invitedJoinReplyBodies({
          consentEstablished,
          hadConsent,
          authorized: true,
        });
        expect(new Set(bodies).size).toBe(bodies.length);
      }
    }
  });

  it("carries no branch for an unauthorized redemption, which no caller can reach", () => {
    /*
      THE DELETION, asserted so it cannot quietly return (B-043).

      `routing.ts` has one call site, guarded by `onboarded` and passing a literal
      `authorized: true`. Everything this function used to do for an UNauthorized redemption was
      unreachable — including telling a farmer to "reply START", copy that could not be
      delivered and that named the wrong word besides.

      Anchored to the SOURCE rather than to behaviour, because dead code has no behaviour to
      assert. Comments and imports are stripped first: this file's own header discusses the
      removed constant by name, and a naive search would match the explanation.
    */
    const stripped = readFileSync(SOURCE, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/^\s*import[^;]*;/gm, "");

    expect(stripped).not.toContain("FARMER_JOIN_INSTRUCTION");
    // The acknowledgement is the router's to send on the awaiting-coordinator path, not this
    // function's — it has no reachable case that owes one.
    expect(stripped).not.toContain("FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT");
  });
});
