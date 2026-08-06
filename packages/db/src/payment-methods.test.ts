import { describe, expect, it } from "vitest";
import {
  canonicalPaymentMethods,
  FARMER_SELECTABLE_PAYMENT_METHODS,
  VIGA_FARM_BUCKS,
} from "./payment-methods";

// F-068 — payment methods as a CLOSED SET plus a free-text tail.
//
// The gap this closes: the onboarding form asked "How can people pay?" as one comma-separated
// text box into an unconstrained `method text` column. So "venmo", "Venmo", "VENMO ONLY" and
// "venmo/cash" all became distinct values, and a filter over them could not work — which is
// precisely why VIGA's existing map fails ("free-form largely unfilterable text", CLAUDE.md).
//
// Payments are the one listing field that IS a genuinely closed set: the real map corpus states
// them as `Accepts Cash, Check, Venmo, VIGA Farm Bucks`, and the listing audit calls them
// "mechanical". That makes canonicalization here CORRECT, where the same move on produce would
// be a taxonomy this codebase forbids.
//
// ## Why a free-text tail still exists
//
// A closed set that silently drops what it does not recognize would lose a real fact — a farmer
// who takes Zelle would submit it and see it vanish. Unrecognized methods are KEPT as the
// farmer's own words; only the known set is folded to one spelling.

describe("canonicalPaymentMethods — the closed set", () => {
  it("folds spelling and case variants of a known method to ONE value", () => {
    // The whole point: these must not become four rows a filter cannot join.
    expect(canonicalPaymentMethods(["venmo"])).toEqual(["Venmo"]);
    expect(canonicalPaymentMethods(["Venmo"])).toEqual(["Venmo"]);
    expect(canonicalPaymentMethods(["VENMO"])).toEqual(["Venmo"]);
    expect(canonicalPaymentMethods(["  venmo  "])).toEqual(["Venmo"]);
  });

  it("folds duplicate spellings of the same method into one entry", () => {
    expect(canonicalPaymentMethods(["cash", "Cash", "CASH"])).toEqual(["Cash"]);
  });

  it("canonicalizes every method in the farmer-selectable set", () => {
    // Anchored to exact values rather than to "is non-empty": a canonicalizer that returned the
    // input unchanged would satisfy a shape assertion and fold nothing.
    expect(canonicalPaymentMethods(["cash"])).toEqual(["Cash"]);
    expect(canonicalPaymentMethods(["check"])).toEqual(["Check"]);
    expect(canonicalPaymentMethods(["cheque"])).toEqual(["Check"]);
    expect(canonicalPaymentMethods(["credit card"])).toEqual(["Credit card"]);
    expect(canonicalPaymentMethods(["paypal"])).toEqual(["PayPal"]);
    expect(canonicalPaymentMethods(["cashapp"])).toEqual(["Cash App"]);
    expect(canonicalPaymentMethods(["cash app"])).toEqual(["Cash App"]);
    expect(canonicalPaymentMethods(["zelle"])).toEqual(["Zelle"]);
  });

  it("recognizes VIGA Farm Bucks by its several spellings", () => {
    // VIGA's own map writes "VIGA Farm Bucks"; farmers shorten it constantly.
    expect(canonicalPaymentMethods(["viga farm bucks"])).toEqual([VIGA_FARM_BUCKS]);
    expect(canonicalPaymentMethods(["farm bucks"])).toEqual([VIGA_FARM_BUCKS]);
    expect(canonicalPaymentMethods(["VIGA bucks"])).toEqual([VIGA_FARM_BUCKS]);
    expect(VIGA_FARM_BUCKS).toBe("VIGA Farm Bucks");
  });

  it("keeps the farmer's stated ORDER for recognized methods", () => {
    expect(canonicalPaymentMethods(["Venmo", "cash"])).toEqual(["Venmo", "Cash"]);
    expect(canonicalPaymentMethods(["cash", "Venmo"])).toEqual(["Cash", "Venmo"]);
  });
});

describe("canonicalPaymentMethods — the free-text tail", () => {
  it("KEEPS an unrecognized method as the farmer's own words", () => {
    // Dropping it would lose a real fact. A farmer who takes something VIGA has not thought of
    // must still be able to say so.
    expect(canonicalPaymentMethods(["Bitcoin"])).toEqual(["Bitcoin"]);
    expect(canonicalPaymentMethods(["trade for eggs"])).toEqual(["trade for eggs"]);
  });

  it("keeps unrecognized methods alongside canonicalized ones", () => {
    expect(canonicalPaymentMethods(["venmo", "trade for eggs"])).toEqual([
      "Venmo",
      "trade for eggs",
    ]);
  });

  it("trims an unrecognized method without otherwise rewriting it", () => {
    // Case is NOT folded on the tail: it is the farmer's own words, and this layer has no
    // basis for deciding how they meant to capitalize them.
    expect(canonicalPaymentMethods(["  Trade for Eggs  "])).toEqual(["Trade for Eggs"]);
  });

  it("folds unrecognized entries that differ only by case or padding", () => {
    // Still deduplicated, or a double-submitted box writes the same method twice — the primary
    // key `(sales_location_id, method)` would reject the second insert on an exact match, but
    // "Bitcoin" and "bitcoin" are two different keys and both would land.
    expect(canonicalPaymentMethods(["Bitcoin", "bitcoin"])).toEqual(["Bitcoin"]);
  });
});

describe("canonicalPaymentMethods — blanks and ceilings", () => {
  it("drops blank entries rather than refusing the whole form", () => {
    // A stray comma in the free-text box is a farmer typing, not an error worth blocking a
    // listing over. The column's not-blank CHECK would otherwise fail the submission.
    expect(canonicalPaymentMethods(["cash", "", "   ", "\t"])).toEqual(["Cash"]);
    expect(canonicalPaymentMethods([])).toEqual([]);
    expect(canonicalPaymentMethods(["", " "])).toEqual([]);
  });

  it("never returns a blank string, which the column refuses", () => {
    for (const method of canonicalPaymentMethods(["cash", "", "Bitcoin", "  "])) {
      expect(method.trim()).not.toBe("");
    }
  });
});

describe("FARMER_SELECTABLE_PAYMENT_METHODS", () => {
  it("does NOT include VIGA Farm Bucks", () => {
    // THE ONE THING A FARMER MAY NOT TICK. Farm Bucks is a VIGA ELIGIBILITY fact with its own
    // admin workflow and an `acceptanceRequiresEligibility` constraint — a farmer who checked a
    // box would be asserting an eligibility only VIGA can grant. The form offers the rest;
    // this list is what the form is allowed to render.
    expect(FARMER_SELECTABLE_PAYMENT_METHODS).not.toContain(VIGA_FARM_BUCKS);
    for (const method of FARMER_SELECTABLE_PAYMENT_METHODS) {
      expect(method.toLowerCase()).not.toContain("farm bucks");
      expect(method.toLowerCase()).not.toContain("viga");
    }
  });

  it("offers the methods the real map corpus actually states", () => {
    // Exact membership, so quietly dropping one fails here rather than silently narrowing what
    // a farmer can say.
    expect(FARMER_SELECTABLE_PAYMENT_METHODS).toEqual([
      "Cash",
      "Check",
      "Venmo",
      "PayPal",
      "Cash App",
      "Zelle",
      "Credit card",
    ]);
  });

  it("every offered method is already canonical", () => {
    // If the form renders a label the canonicalizer would rewrite, the stored value and the
    // checked box disagree and the farmer's own selection would not read back as checked.
    for (const method of FARMER_SELECTABLE_PAYMENT_METHODS) {
      expect(canonicalPaymentMethods([method])).toEqual([method]);
    }
    expect(canonicalPaymentMethods([VIGA_FARM_BUCKS])).toEqual([VIGA_FARM_BUCKS]);
  });
});
