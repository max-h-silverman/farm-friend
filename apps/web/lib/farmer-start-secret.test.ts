import { describe, expect, it } from "vitest";

import {
  MINIMUM_SECRET_LENGTH,
  farmerStartSecretMatches,
  resolveFarmerStartSecret,
} from "./farmer-start-secret";

const VALID = "a".repeat(MINIMUM_SECRET_LENGTH);

describe("resolveFarmerStartSecret", () => {
  it("resolves a configured secret of sufficient length", () => {
    expect(resolveFarmerStartSecret({ FARMER_START_SECRET: VALID })).toBe(VALID);
  });

  it("returns null when the variable is absent, so the door does not exist", () => {
    // Absent is a SUPPORTED deployment, exactly like GEOCODING_API_KEY and SMTP: with nothing
    // set, the migration door is simply closed and every other surface runs. That is why this
    // returns null rather than throwing — a throw here would take the page down with a 500,
    // which tells a prober the route exists.
    expect(resolveFarmerStartSecret({})).toBeNull();
  });

  it("treats an empty or whitespace value as absent, not as a secret", () => {
    // The dangerous middle. A deployment that sets the variable to "" would otherwise have a
    // door whose secret is the empty string, which every request matches.
    for (const blank of ["", "   ", "\t", "\n", " \t\r\n "]) {
      expect(resolveFarmerStartSecret({ FARMER_START_SECRET: blank }), JSON.stringify(blank))
        .toBeNull();
    }
  });

  it(`refuses a secret shorter than ${MINIMUM_SECRET_LENGTH} characters`, () => {
    // This is the one property of the secret the suite can actually prove. The value is the
    // whole credential and it lands in browser history and access logs, so a short one is
    // guessable and must not be deployable at all.
    expect(resolveFarmerStartSecret({ FARMER_START_SECRET: "a".repeat(MINIMUM_SECRET_LENGTH - 1) }))
      .toBeNull();
  });

  it("accepts exactly the minimum length, so the boundary is not off by one", () => {
    expect(resolveFarmerStartSecret({ FARMER_START_SECRET: VALID })).toBe(VALID);
  });

  it("trims surrounding whitespace before measuring length", () => {
    // A secret pasted into a Terraform variable arrives with a trailing newline more often
    // than not. Measuring the untrimmed value would accept a 31-character secret padded to 32.
    const padded = ` ${"b".repeat(MINIMUM_SECRET_LENGTH)} \n`;
    expect(resolveFarmerStartSecret({ FARMER_START_SECRET: padded })).toBe(
      "b".repeat(MINIMUM_SECRET_LENGTH),
    );
    expect(
      resolveFarmerStartSecret({
        FARMER_START_SECRET: `  ${"b".repeat(MINIMUM_SECRET_LENGTH - 1)}  `,
      }),
    ).toBeNull();
  });
});

describe("the secret door's uniform refusal", () => {
  it("cannot distinguish 'not configured' from 'wrong secret'", () => {
    // THE acceptance criterion this whole module exists for. A different response for
    // "not configured" tells a prober that the door exists and is merely switched off, which
    // is the one fact the obscurity depends on hiding.
    //
    // Asserted against the real matcher rather than by inspecting the pages, so it holds for
    // every caller.
    expect(farmerStartSecretMatches({}, VALID)).toBe(false);
    expect(farmerStartSecretMatches({ FARMER_START_SECRET: VALID }, "wrong-but-long-enough-xxxxxxxx"))
      .toBe(false);
    expect(farmerStartSecretMatches({ FARMER_START_SECRET: VALID }, VALID)).toBe(true);
  });

  it("refuses a supplied value of a different length without throwing", () => {
    // `timingSafeEqual` throws on length-mismatched buffers, so the length guard is not an
    // optimization — without it, a probe of the wrong length produces a 500 while a probe of
    // the right length produces a 404, which is an oracle for the secret's LENGTH.
    expect(farmerStartSecretMatches({ FARMER_START_SECRET: VALID }, "short")).toBe(false);
    expect(farmerStartSecretMatches({ FARMER_START_SECRET: VALID }, "x".repeat(200))).toBe(false);
  });

  it("refuses an empty supplied value against a configured secret", () => {
    expect(farmerStartSecretMatches({ FARMER_START_SECRET: VALID }, "")).toBe(false);
  });
});
