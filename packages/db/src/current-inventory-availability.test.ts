import type { OpenNowAnswer, OpenState } from "@farm-friend/core";
import { describe, expect, it } from "vitest";
import { intersectAvailability } from "./current-inventory";

/*
  B-074 / F-114 Phase A — the stand/provider availability intersection.

  The contract's requirement (§facts and authority): availability is an INTERSECTION, never a
  union. A provider may be closed while the stand is open; a provider can never be open while the
  stand is closed. It is computed once, here, because two surfaces computing it separately is the
  map-and-SMS disagreement this whole refactor exists to end.

  ## Why `unknown` is the interesting case

  `openNow` returns a three-state answer on purpose, and `unknown` is a first-class one: 5 of 34
  production stands state no season and 12 state no hours, so a boolean would have to call those
  "closed" — asserting the farmer said shut when the farmer said nothing.

  That makes `unknown` the case an intersection is most likely to get wrong. A naive "both must
  be open" rule silently converts an unstated stand schedule into a closed provider, which is the
  exact failure the three-state design exists to prevent. So `unknown` on the stand side PERMITS,
  and the tests below pin that in both directions.
*/

const answer = (state: OpenState, extra: Partial<OpenNowAnswer> = {}): OpenNowAnswer => ({
  state,
  ...extra,
});

/** Every state the stand side can present. Exhaustive, so a new one cannot be forgotten. */
const ALL_STATES: readonly OpenState[] = [
  "open",
  "farmer_closed",
  "closed",
  "closed_today",
  "out_of_season",
  "by_appointment",
  "unknown",
];

/** The stand states that leave the provider's own answer standing. */
const PERMITTING: readonly OpenState[] = ["open", "unknown", "by_appointment"];

describe("B-074 stand/provider availability intersection", () => {
  it("passes the stand's answer through when there is no provider", () => {
    // Phase A's only real case: no provider column exists, so every caller passes undefined and
    // must get the stand's own answer back untouched — including its sun times.
    for (const state of ALL_STATES) {
      const stand = answer(state, { sunsetMinutes: 1271, sunriseMinutes: 330 });
      expect(intersectAvailability({ stand })).toEqual(stand);
    }
  });

  it("lets a closed provider be closed inside an open stand", () => {
    // The real case the contract names: a hosted seller who takes only cash and locks their box
    // before the stand shuts.
    const result = intersectAvailability({
      stand: answer("open"),
      provider: answer("closed"),
    });
    expect(result.state).toBe("closed");
  });

  it("never lets a provider be open while its stand is not", () => {
    // A closed stand is LOCKED. No one's goods are buyable there, whatever the provider's own
    // schedule says. This is the one-directional half of the rule and the one that would send a
    // customer to a locked box if it were wrong.
    for (const standState of ALL_STATES) {
      if (PERMITTING.includes(standState)) continue;
      const result = intersectAvailability({
        stand: answer(standState),
        provider: answer("open"),
      });
      expect(result.state).not.toBe("open");
      expect(result.state).toBe(standState);
    }
  });

  it("does not convert an unstated stand schedule into a closed provider", () => {
    // `unknown` means the farmer stated nothing. Treating it as an exclusion would hide a
    // provider that genuinely said it is open — silence read as a claim, which the whole
    // open-now design refuses.
    const result = intersectAvailability({
      stand: answer("unknown"),
      provider: answer("open"),
    });
    expect(result.state).toBe("open");
  });

  it("leaves a provider unknown rather than shut when neither stated anything", () => {
    const result = intersectAvailability({
      stand: answer("unknown"),
      provider: answer("unknown"),
    });
    expect(result.state).toBe("unknown");
  });

  it("keeps by_appointment from either side as an answer, never as a closure", () => {
    // `by_appointment` is a complete answer about HOW to visit, not a failure to state hours.
    // A stand that is by-appointment does not close a provider that stated real hours, and a
    // by-appointment provider inside an open stand stays by-appointment.
    expect(
      intersectAvailability({
        stand: answer("by_appointment"),
        provider: answer("open"),
      }).state,
    ).toBe("open");
    expect(
      intersectAvailability({
        stand: answer("open"),
        provider: answer("by_appointment"),
      }).state,
    ).toBe("by_appointment");
  });

  it("carries the sun times of whichever answer decided the result", () => {
    // The sun times are the arithmetic that DECIDED a state (core/public/open-now.ts). A caller
    // labelling "open until sunset" must be handed the sunset that made the decision, not a
    // different one, or the label and the filtering drift apart.
    const providerDecided = intersectAvailability({
      stand: answer("open", { sunsetMinutes: 1271 }),
      provider: answer("closed", { sunsetMinutes: 1180 }),
    });
    expect(providerDecided.sunsetMinutes).toBe(1180);

    const standDecided = intersectAvailability({
      stand: answer("out_of_season", { sunsetMinutes: 1271 }),
      provider: answer("open", { sunsetMinutes: 1180 }),
    });
    expect(standDecided.sunsetMinutes).toBe(1271);
  });

  it("is exhaustive over every pair of states", () => {
    // No pair may throw, and every result must be one of the two inputs' states — the
    // intersection selects an answer, it never invents one.
    for (const standState of ALL_STATES) {
      for (const providerState of ALL_STATES) {
        const result = intersectAvailability({
          stand: answer(standState),
          provider: answer(providerState),
        });
        expect([standState, providerState]).toContain(result.state);
        // And the invariant that matters: open only survives when BOTH permit it.
        if (result.state === "open") {
          expect(PERMITTING).toContain(standState);
          expect(providerState).toBe("open");
        }
      }
    }
  });
});
