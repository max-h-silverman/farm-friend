import { describe, expect, it } from "vitest";
import {
  CONSENT_INVITATION_REPLY,
  requiresConsentBeforeAnswering,
} from "./consent-invitation";
import { parseCommand, REGISTERED_OPT_IN_KEYWORDS, REGISTERED_OPT_OUT_KEYWORDS, REGISTERED_HELP_KEYWORDS } from "./commands";

/*
  F-121 — A SENDER WITH NO CONSENT IS INVITED, NOT SERVED (max, 2026-08-18).

  Farm Friend answers nothing substantive until the sender has agreed to receive texts. The
  ONLY messages that still work are the carrier-registered compliance keywords, because those
  are how a person opts in, opts out, or asks for help — gating any of them would either break
  an opt-out or make opting in impossible.

  Everything else gates: MAP, YES/NO, LINK/STAND/SETTINGS, MORE, a stand menu number, and all
  free text. A stand answer, a stock-out report, a farmer's publish confirmation — none of them
  happen for a sender with no consent record.
*/
describe("who is exempt from the consent gate", () => {
  it("exempts every carrier-registered compliance keyword", () => {
    const registered = [
      ...REGISTERED_OPT_OUT_KEYWORDS,
      ...REGISTERED_OPT_IN_KEYWORDS,
      ...REGISTERED_HELP_KEYWORDS,
    ];
    for (const keyword of registered) {
      const parsed = parseCommand(keyword);
      expect(parsed.kind, `${keyword} must parse as compliance`).toBe("compliance");
    }
  });

  /*
    THE TWO THAT MUST NOT BE FORGOTTEN.

    `VIGA` is how an invited farmer completes onboarding, from a handset that by definition has
    no consent row yet. Gating it would mean no farmer could ever onboard: they would be told to
    reply JOIN, and JOIN cannot complete onboarding.

    A `STOP` synonym must always reach the opt-out writer. Gating one would leave a person who
    texted UNSUBSCRIBE still enrolled while being told to JOIN — the exact inversion of what
    they asked for.
  */
  it("keeps the farmer onboarding keyword and every STOP synonym reachable", () => {
    expect(parseCommand("VIGA").kind).toBe("compliance");
    for (const word of ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
      expect(parseCommand(word), `${word} must stay an opt-out`).toMatchObject({
        kind: "compliance",
        keyword: "STOP",
        global: true,
      });
    }
  });

  it("gates MAP, which is a service rather than a consent control", () => {
    // Named explicitly because it is the one max called out: a consentless sender who texts
    // MAP must be invited, not handed the map.
    expect(parseCommand("MAP").kind).not.toBe("compliance");
  });

  it("gates the product and farmer keywords, and free text", () => {
    for (const body of ["YES", "NO", "LINK", "STAND", "SETTINGS", "MORE", "3", "who has eggs?", "hello"]) {
      expect(parseCommand(body).kind, `${body} must not be exempt`).not.toBe("compliance");
    }
  });
});

describe("when the gate applies", () => {
  it("gates a sender who has never opted in", () => {
    expect(requiresConsentBeforeAnswering(null)).toBe(true);
  });

  it("lets an active sender through", () => {
    expect(requiresConsentBeforeAnswering({ state: "active" })).toBe(false);
  });

  /*
    A STOPPED SENDER IS GATED BUT NEVER INVITED. They opted out; dispatch suppresses their
    reply anyway, and queuing an opt-in pitch at someone who said STOP is what STOP exists to
    end. `routeInboundMessage` queues nothing for them — this predicate only says "do not
    answer".
  */
  it("gates a sender who opted out", () => {
    expect(requiresConsentBeforeAnswering({ state: "stopped" })).toBe(true);
  });
});

describe("the invitation copy", () => {
  it("names JOIN and says what agreeing means", () => {
    expect(CONSENT_INVITATION_REPLY).toMatch(/JOIN/);
    expect(CONSENT_INVITATION_REPLY).toMatch(/agree/i);
    expect(CONSENT_INVITATION_REPLY).toMatch(/VIGA Farm Friend/);
  });

  it("claims nothing about what the sender has already done", () => {
    // It must never imply their message opted them in — it did not.
    expect(CONSENT_INVITATION_REPLY).not.toMatch(/you (have|are) (now )?(joined|agreed|enrolled|subscribed)/i);
  });

  it("stays within one SMS segment", () => {
    expect(CONSENT_INVITATION_REPLY.length).toBeLessThanOrEqual(160);
  });
});
