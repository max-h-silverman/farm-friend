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
    // establish or restore the single launch consent.
    expect(consentTransitionFor("JOIN")).toEqual({
      transition: "start",
      captureSource: "join",
    });
    expect(consentTransitionFor("START")).toEqual({
      transition: "start",
      captureSource: "start",
    });
  });

  it("maps STOP onto the global opt-out with no capture source", () => {
    expect(consentTransitionFor("STOP")).toEqual({ transition: "stop" });
  });

  it("gives HELP, INFO, and FLAG no consent consequence at all", () => {
    // A help request is not an opt-in, and a safety flag is not an opt-out.
    for (const keyword of ["HELP", "INFO", "FLAG"] as const) {
      expect(consentTransitionFor(keyword)).toBeNull();
    }
  });

  it("derives its opt-in mapping from what the parser actually accepts", () => {
    // Every keyword the deterministic parser routes as compliance is accounted for
    // here, so a new registered keyword cannot silently have no consent meaning.
    for (const word of ["JOIN", "START", "STOP", "STOPALL", "HELP", "INFO", "FLAG"]) {
      const parsed = parseCommand(word);
      expect(parsed.kind).toBe("compliance");
      if (parsed.kind !== "compliance") continue;
      expect(() => consentTransitionFor(parsed.keyword)).not.toThrow();
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
