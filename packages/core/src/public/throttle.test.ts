import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock";
import { createPublicActionThrottle } from "./throttle";

// F-019 — the abuse/cost throttle that fronts PUBLIC, UNAUTHENTICATED, MODEL-BACKED handlers.
//
// The thing being protected is a model call made on behalf of an anonymous stranger. The
// throttle is therefore about cost and abuse, NOT about capacity: model-free public lookup
// never reaches it (proven in the route tests), and its budget is deliberately generous
// enough that an ordinary reporter never meets it.

const T0 = new Date("2026-07-25T12:00:00Z");

describe("public model-call throttle", () => {
  it("admits calls up to the configured budget", () => {
    const clock = new FixedClock(new Date(T0));
    const throttle = createPublicActionThrottle({ clock, limit: 3, windowMs: 60_000 });

    expect(throttle.admit("client-a").allowed).toBe(true);
    expect(throttle.admit("client-a").allowed).toBe(true);
    expect(throttle.admit("client-a").allowed).toBe(true);
  });

  it("refuses the call that exceeds the budget", () => {
    const clock = new FixedClock(new Date(T0));
    const throttle = createPublicActionThrottle({ clock, limit: 2, windowMs: 60_000 });

    throttle.admit("client-a");
    throttle.admit("client-a");

    const refused = throttle.admit("client-a");
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("meters each client signal separately", () => {
    const clock = new FixedClock(new Date(T0));
    const throttle = createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 });

    expect(throttle.admit("client-a").allowed).toBe(true);
    expect(throttle.admit("client-a").allowed).toBe(false);
    // One abusive client must not deny service to everyone else behind the same handler.
    expect(throttle.admit("client-b").allowed).toBe(true);
  });

  it("admits again once the window has passed", () => {
    const clock = new FixedClock(new Date(T0));
    const throttle = createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 });

    expect(throttle.admit("client-a").allowed).toBe(true);
    expect(throttle.admit("client-a").allowed).toBe(false);

    clock.advanceMs(60_001);
    expect(throttle.admit("client-a").allowed).toBe(true);
  });

  it("slides the window rather than resetting on a fixed boundary", () => {
    const clock = new FixedClock(new Date(T0));
    const throttle = createPublicActionThrottle({ clock, limit: 2, windowMs: 60_000 });

    throttle.admit("client-a"); // t=0
    clock.advanceMs(50_000);
    throttle.admit("client-a"); // t=50s
    clock.advanceMs(5_000); // t=55s — both still inside the window
    expect(throttle.admit("client-a").allowed).toBe(false);

    clock.advanceMs(6_000); // t=61s — the first call has aged out, the second has not
    expect(throttle.admit("client-a").allowed).toBe(true);
    expect(throttle.admit("client-a").allowed).toBe(false);
  });

  it("reports how long the caller must wait, based on the oldest call in the window", () => {
    const clock = new FixedClock(new Date(T0));
    const throttle = createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 });

    throttle.admit("client-a");
    clock.advanceMs(20_000);

    const refused = throttle.admit("client-a");
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("expected a refusal");
    // 60s window, 20s elapsed → 40s remain.
    expect(refused.retryAfterSeconds).toBe(40);
  });

  it("does not consume budget for a call it refused", () => {
    const clock = new FixedClock(new Date(T0));
    const throttle = createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 });

    throttle.admit("client-a"); // t=0, consumes the only slot
    clock.advanceMs(30_000);
    throttle.admit("client-a"); // refused — must NOT record itself at t=30s
    clock.advanceMs(31_000); // t=61s: the only recorded call has aged out

    expect(throttle.admit("client-a").allowed).toBe(true);
  });

  it("forgets clients whose calls have all aged out", () => {
    const clock = new FixedClock(new Date(T0));
    const throttle = createPublicActionThrottle({ clock, limit: 5, windowMs: 60_000 });

    throttle.admit("client-a");
    throttle.admit("client-b");
    expect(throttle.size()).toBe(2);

    clock.advanceMs(60_001);
    throttle.admit("client-c");

    // An unbounded map keyed by an attacker-supplied signal is itself the cost problem the
    // throttle exists to prevent, so aged-out clients are dropped rather than accumulated.
    expect(throttle.size()).toBe(1);
  });

  it("treats an absent client signal as one shared bucket rather than unlimited", () => {
    const clock = new FixedClock(new Date(T0));
    const throttle = createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 });

    expect(throttle.admit(null).allowed).toBe(true);
    // A missing signal must fail CLOSED: an attacker who can strip the header would
    // otherwise buy unlimited model calls by sending nothing.
    expect(throttle.admit(null).allowed).toBe(false);
  });

  it("rejects a non-positive budget rather than admitting everything", () => {
    const clock = new FixedClock(new Date(T0));
    expect(() => createPublicActionThrottle({ clock, limit: 0, windowMs: 60_000 })).toThrow();
    expect(() => createPublicActionThrottle({ clock, limit: 3, windowMs: 0 })).toThrow();
  });
});
