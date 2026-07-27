import { describe, expect, it } from "vitest";
import {
  consentTransitionFor,
  isProactiveSendPermitted,
  LAUNCH_MESSAGE_CATEGORIES,
  type LaunchConsentRecord,
} from "./consent";
import { parseCommand } from "./commands";

// F-016 — one launch operational SMS program.
//
// These are the pure decisions: which keyword moves consent, and whether a queued
// message may go out. They take no database and no model, so nothing interpretive can
// reach around them.

const active: LaunchConsentRecord = { state: "active", captureSource: "join" };
const stopped: LaunchConsentRecord = { state: "stopped" };

// Spelled out literally rather than derived from the module under test: deriving it
// would make these loops agree with whatever the implementation happens to do. If a
// category is added, this list must be updated deliberately.
const PROACTIVE_CATEGORIES = [
  "inventory_prompt",
  "inventory_confirmation",
  "stock_out_alert",
] as const;


describe("launch-program consent transitions", () => {
  it("maps both registered opt-in keywords onto the one launch program", () => {
    // JOIN and START are not two programs and not two enrollment states: they both
    // establish the single launch consent for a sender with no prior record.
    expect(consentTransitionFor("JOIN", null)).toEqual({
      transition: "start",
      captureSource: "join",
    });
    expect(consentTransitionFor("START", null)).toEqual({
      transition: "start",
      captureSource: "start",
    });
  });

  // B-011 — Farm Friend's consent record must not claim consent the CARRIER will not honour.
  //
  // Telnyx keeps its own opt-out list, independently of ours, and enforces it at the carrier
  // layer: while a number is on it, every send is refused with 409 / code 40300, regardless
  // of the messaging profile's auto-response settings (verified 2026-07-27 by direct probe).
  //
  // `START` is the word that lifts that block. **`JOIN` does not** — it is OUR registered
  // opt-in keyword and carries no meaning to Telnyx's compliance layer. Confirmed by outcome:
  // a `join` four minutes after a `stop` still 409'd, while a `start` between them was
  // accepted. It is a state, not a timing window.
  //
  // So a farmer who texted STOP and later JOIN used to be recorded `active` while the carrier
  // blocked every message: the database and the carrier disagreed about the same person, and
  // `isProactiveSendPermitted` returned true for sends that could never arrive.
  //
  // The rule (max's decision): JOIN establishes consent only for a first-time sender. Once a
  // record exists, only START restores. This CONFORMS our record to the carrier's rather than
  // reconciling after the fact — the two can no longer drift apart, and no provider response
  // is ever allowed to drive a consent transition (Golden Rule #2 stays intact).
  describe("JOIN cannot restore consent once a record exists (B-011)", () => {
    it("establishes consent for a genuine first-time sender", () => {
      expect(consentTransitionFor("JOIN", null)).toEqual({
        transition: "start",
        captureSource: "join",
      });
    });

    it("does NOT restore a stopped sender", () => {
      // THE CENTRAL ASSERTION. Committing `active` here is precisely the divergence: the
      // carrier's block is still in force and every message would 409.
      expect(consentTransitionFor("JOIN", stopped)).toBeNull();
    });

    it("does not re-capture an already-active sender", () => {
      // Not a correctness hazard, but there is nothing to establish and re-writing
      // `captureSource` would falsify the provenance of the original opt-in.
      expect(consentTransitionFor("JOIN", active)).toBeNull();
    });

    it("lets START restore a stopped sender, because the carrier honours it", () => {
      expect(consentTransitionFor("START", stopped)).toEqual({
        transition: "start",
        captureSource: "start",
      });
    });

    it("lets START through for an active sender too", () => {
      // START is the carrier's own keyword; it must never be swallowed by our state. A
      // recipient whose carrier block we cannot see may need it to reach Telnyx regardless
      // of what our record says.
      expect(consentTransitionFor("START", active)).toEqual({
        transition: "start",
        captureSource: "start",
      });
    });

    it("still lets STOP through from every prior state", () => {
      // STOP is global and outranks everything (Golden Rule #2). Narrowing JOIN must not
      // have narrowed the opt-out path.
      expect(consentTransitionFor("STOP", null)).toEqual({ transition: "stop" });
      expect(consentTransitionFor("STOP", active)).toEqual({ transition: "stop" });
      expect(consentTransitionFor("STOP", stopped)).toEqual({ transition: "stop" });
    });

    it("leaves the non-consent keywords unchanged in every state", () => {
      for (const record of [null, active, stopped] as const) {
        expect(consentTransitionFor("HELP", record)).toBeNull();
        expect(consentTransitionFor("INFO", record)).toBeNull();
        expect(consentTransitionFor("FLAG", record)).toBeNull();
      }
    });
  });

  it("maps STOP onto the global opt-out with no capture source", () => {
    expect(consentTransitionFor("STOP", null)).toEqual({ transition: "stop" });
  });

  it("gives HELP, INFO, and FLAG no consent consequence at all", () => {
    // A help request is not an opt-in, and a safety flag is not an opt-out.
    for (const keyword of ["HELP", "INFO", "FLAG"] as const) {
      expect(consentTransitionFor(keyword, null)).toBeNull();
    }
  });

  it("derives its opt-in mapping from what the parser actually accepts", () => {
    // Every keyword the deterministic parser routes as compliance is accounted for
    // here, so a new registered keyword cannot silently have no consent meaning.
    for (const word of ["JOIN", "START", "STOP", "STOPALL", "HELP", "INFO", "FLAG"]) {
      const parsed = parseCommand(word);
      expect(parsed.kind).toBe("compliance");
      if (parsed.kind !== "compliance") continue;
      expect(() => consentTransitionFor(parsed.keyword, null)).not.toThrow();
    }
  });
});

describe("proactive send permission", () => {
  it("keeps the literal proactive list exhaustive against the real category list", () => {
    // The guard on the guard: every launch category is either a reply or proactive, so a
    // newly added category cannot quietly escape the loops below.
    const replies = ["required_reply", "inquiry_reply"];
    expect([...PROACTIVE_CATEGORIES, ...replies].sort()).toEqual(
      [...LAUNCH_MESSAGE_CATEGORIES].sort(),
    );
  });

  it("permits every launch message category on the one active consent", () => {
    // The whole point of finding 4: categories are not separate enrollments. One
    // active consent covers all of them.
    for (const category of LAUNCH_MESSAGE_CATEGORIES) {
      expect(
        isProactiveSendPermitted({ consent: active, category }),
      ).toBe(true);
    }
  });

  it("refuses a proactive send when consent was never established", () => {
    // Absent is not permission. A recipient who never opted in has no consent basis,
    // and "not stopped" is not the same as "active".
    for (const category of PROACTIVE_CATEGORIES) {
      expect(
        isProactiveSendPermitted({ consent: null, category }),
      ).toBe(false);
    }
  });

  it("refuses every proactive category after STOP", () => {
    for (const category of PROACTIVE_CATEGORIES) {
      expect(
        isProactiveSendPermitted({ consent: stopped, category }),
      ).toBe(false);
    }
  });

  it("permits a required reply regardless of consent state", () => {
    // The opt-out confirmation and help text are carrier-required responses to the
    // recipient's own message; STOP must not suppress its own acknowledgement.
    expect(
      isProactiveSendPermitted({ consent: stopped, category: "required_reply" }),
    ).toBe(true);
    expect(
      isProactiveSendPermitted({ consent: null, category: "required_reply" }),
    ).toBe(true);
  });

  it("permits a direct inquiry reply without any durable consent", () => {
    // A customer-initiated inquiry earns its own answer and nothing more. This is the
    // permission that must NOT become a subscription.
    expect(
      isProactiveSendPermitted({ consent: null, category: "inquiry_reply" }),
    ).toBe(true);
  });

  it("still refuses an inquiry reply after STOP", () => {
    // STOP is global across all Farm Friend messaging, including a reply the customer
    // would otherwise be owed.
    expect(
      isProactiveSendPermitted({ consent: stopped, category: "inquiry_reply" }),
    ).toBe(false);
  });

  it("has no category that creates or upgrades consent", () => {
    // isProactiveSendPermitted is a pure predicate: there is no argument by which
    // answering a customer could enroll them.
    const before = { ...active };
    for (const category of LAUNCH_MESSAGE_CATEGORIES) {
      isProactiveSendPermitted({ consent: active, category });
    }
    expect(active).toEqual(before);
  });
});
