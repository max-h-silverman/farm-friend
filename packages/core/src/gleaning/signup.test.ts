import { describe, expect, it } from "vitest";
import { applyGleaningSignup, countGleaningSignups } from "./signup.js";

describe("gleaning signup invariants", () => {
  it("confirms signups until max capacity, then waitlists overflow", () => {
    const first = applyGleaningSignup({
      volunteerMax: 1,
      signups: [],
      personId: "person-1",
    });
    const second = applyGleaningSignup({
      volunteerMax: 1,
      signups: first.signups,
      personId: "person-2",
    });

    expect(first.result).toEqual({ status: "confirmed" });
    expect(second.result).toEqual({ status: "waitlisted", waitlistPosition: 1 });
    expect(countGleaningSignups(second.signups)).toEqual({
      confirmed: 1,
      waitlisted: 1,
      dropped: 0,
    });
  });

  it("is idempotent for an active signup by the same person", () => {
    const first = applyGleaningSignup({
      volunteerMax: 2,
      signups: [],
      personId: "person-1",
    });
    const repeat = applyGleaningSignup({
      volunteerMax: 2,
      signups: first.signups,
      personId: "person-1",
    });

    expect(repeat.signups).toHaveLength(1);
    expect(repeat.result).toEqual({ status: "confirmed", existing: true });
  });
});
