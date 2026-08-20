import { describe, expect, it } from "vitest";

import { resolvePaymentMethods } from "./payment-resolution";

/*
  F-125 — payment is a fact about the SELLER, and a stand may only NARROW it.

  These tests are the whole contract. The direction is the point: a host can remove a method
  the seller otherwise takes (the motivating case is a hosted seller whose host cannot handle
  cash), and cannot invent one she does not. "Cannot add" is not enforced by a check inside
  this function — it is unrepresentable, because the override names EXCLUSIONS rather than a
  second independent list. A test that asserted "adding is refused" would be describing a
  guard that should not need to exist.
*/
describe("resolvePaymentMethods", () => {
  it("returns what the seller states when the stand excludes nothing", () => {
    expect(
      resolvePaymentMethods({
        sellerMethods: ["Cash", "Check", "Venmo"],
        excludedAtStand: [],
      }),
    ).toEqual(["Cash", "Check", "Venmo"]);
  });

  it("removes a method the stand excludes", () => {
    expect(
      resolvePaymentMethods({
        sellerMethods: ["Cash", "Check", "Venmo"],
        excludedAtStand: ["Cash"],
      }),
    ).toEqual(["Check", "Venmo"]);
  });

  it("ignores an exclusion for a method the seller never stated", () => {
    // The host removing something she does not take is a no-op, not an error and NOT a way to
    // make the list longer. This is the "cannot add" property, stated as a value.
    expect(
      resolvePaymentMethods({
        sellerMethods: ["Cash", "Check"],
        excludedAtStand: ["Zelle"],
      }),
    ).toEqual(["Cash", "Check"]);
  });

  it("can narrow all the way to nothing", () => {
    // A stand where the seller can take no payment at all is a real answer, not a bug. The
    // surfaces render "no stated method"; they must not fall back to the seller's full list.
    expect(
      resolvePaymentMethods({
        sellerMethods: ["Cash"],
        excludedAtStand: ["Cash"],
      }),
    ).toEqual([]);
  });

  it("preserves the seller's stated order rather than sorting", () => {
    // `FARMER_SELECTABLE_PAYMENT_METHODS` is ordered as a farmer expects to read it (the two
    // every unattended stand takes, then the phone apps, then cards). Sorting here would
    // alphabetize that into "Cash, Check, Credit card, Venmo" and lose the intent.
    expect(
      resolvePaymentMethods({
        sellerMethods: ["Cash", "Venmo", "Check"],
        excludedAtStand: [],
      }),
    ).toEqual(["Cash", "Venmo", "Check"]);
  });

  it("matches an exclusion case-insensitively", () => {
    // Both sides pass through `canonicalPaymentMethods` before storage, so a case difference
    // should not be reachable. Folding anyway means a legacy or hand-written row cannot leave
    // a host's exclusion silently doing nothing — the failure mode is a customer told they can
    // pay a way the host cannot actually accept.
    expect(
      resolvePaymentMethods({
        sellerMethods: ["Cash", "Venmo"],
        excludedAtStand: ["venmo"],
      }),
    ).toEqual(["Cash"]);
  });

  it("de-duplicates a method the seller somehow states twice", () => {
    expect(
      resolvePaymentMethods({
        sellerMethods: ["Cash", "Cash", "Check"],
        excludedAtStand: [],
      }),
    ).toEqual(["Cash", "Check"]);
  });
});
