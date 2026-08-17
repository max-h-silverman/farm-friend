import { describe, expect, it } from "vitest";
import {
  ORIGIN_LIMITATION_STATEMENT,
  parseCommand,
  RECIPE_SCOPE_STATEMENT,
} from "@farm-friend/core";
import { estimateSmsSegments } from "@farm-friend/sms";
import {
  CHITCHAT_REPLY,
  CLASSIFIER_UNAVAILABLE_REPLY,
  PAUSED_REOPENING_PROMPT,
  PROPOSAL_CONFIRMATION_PROMPT,
  SYSTEM_INQUIRY_REPLY,
  UNCLEAR_REQUEST_REPLY,
  VIGA_BUCKS_INQUIRY_REPLY,
} from "./free-text";

/*
  NO CODE-OWNED REPLY MAY FORCE UCS-2 (max, 2026-08-14).

  A single non-GSM-7 character re-encodes the WHOLE message, and the capacity per segment
  falls from 153 septets to 67 code units. It is not a length effect and it is not
  proportional: the chitchat reply carried one plant emoji and cost two segments for 73
  characters of text that fits comfortably in one.

  This is asserted over every constant reply rather than over the one that was wrong, because
  the failure is invisible by inspection — the emoji renders fine everywhere it is read, and
  only the carrier bill and this test can see it. A decorative character added to any of these
  in future fails here.

  Rendered replies (listings, pages) are not covered here: their cost depends on farmer data,
  and `packages/sms/src/result-page-segments.test.ts` owns that ceiling.
*/
describe("code-owned replies stay in the cheap SMS encoding", () => {
  const replies: Record<string, string> = {
    CHITCHAT_REPLY,
    CLASSIFIER_UNAVAILABLE_REPLY,
    SYSTEM_INQUIRY_REPLY,
    UNCLEAR_REQUEST_REPLY,
    VIGA_BUCKS_INQUIRY_REPLY,
    PROPOSAL_CONFIRMATION_PROMPT,
    PAUSED_REOPENING_PROMPT,
    RECIPE_SCOPE_STATEMENT,
    ORIGIN_LIMITATION_STATEMENT,
  };

  for (const [name, body] of Object.entries(replies)) {
    it(`${name} encodes as GSM-7`, () => {
      expect(estimateSmsSegments(body).encoding).toBe("GSM-7");
    });
  }

  it("keeps the greeting to a single billed segment", () => {
    // The reason the encoding matters, stated as the outcome a customer's carrier bills for.
    expect(estimateSmsSegments(CHITCHAT_REPLY).segmentCount).toBe(1);
  });
});

describe.each([
  ["the proposal prompt", PROPOSAL_CONFIRMATION_PROMPT],
  // F-114 C.4 — the paused listing's prompt carries the SAME gate, so it is swept the same
  // way. It deliberately quotes YES and NO rather than introducing a re-opening keyword
  // (max, 2026-08-16); this is what proves those two still route.
  ["the paused re-opening prompt", PAUSED_REOPENING_PROMPT],
])("%s only names words the router accepts", (_name, prompt) => {
  /*
    Copy that instructs a farmer to reply with a word the parser does not route is worse than
    no instruction: it produces a confident action that silently does nothing. So the words
    quoted in the prompt are checked against `parseCommand` itself rather than against a
    second list of what we believe it accepts.
  */
  const quoted = prompt.match(/\b[A-Z]{2,}\b/g) ?? [];

  it("quotes at least one word, so the check below cannot pass vacuously", () => {
    expect(quoted.length).toBeGreaterThan(0);
  });

  for (const word of quoted) {
    it(`routes ${word} as a commitment token`, () => {
      expect(parseCommand(word)).toMatchObject({ kind: "commitment" });
    });
  }
});
