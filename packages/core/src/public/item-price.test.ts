import { describe, expect, it } from "vitest";

import {
  renderStandItemPrice,
  standItemPriceNeedsUnit,
  type StandItemPrice,
} from "./item-price.js";

/**
 * F-092 — the ONE place a structured price becomes a sentence.
 *
 * Every customer surface renders through this: the map card, the admin export, an SMS answer. A
 * second renderer anywhere is how two stands come to print the same price differently, which is
 * the whole reason the parts are stored rather than the farmer's typing.
 */
describe("rendering a stand item's price", () => {
  const per = (over: Partial<StandItemPrice> = {}): StandItemPrice => ({
    amount: "6.00",
    quantity: "1.00",
    unit: "dozen",
    basis: "per",
    ...over,
  });

  it("renders a unit price as amount over unit", () => {
    expect(renderStandItemPrice(per())).toBe("$6 / dozen");
  });

  it("renders a bundle as the count, the unit, then the amount", () => {
    // The other sentence the same four fields make. `for` is what a farmer means by "3 lb for
    // $5" — the count is part of what is bought, where in `per` it is always one.
    expect(
      renderStandItemPrice({
        amount: "5.00",
        quantity: "3.00",
        unit: "lb",
        basis: "for",
      }),
    ).toBe("3 lb for $5");
  });

  it("drops a trailing .00 but keeps real cents", () => {
    // "$6.00 / dozen" is how a hand-lettered sign does NOT read. Cents appear when a farmer
    // states them and vanish when they do not, which is the difference between a price and a
    // number formatted by a machine.
    expect(renderStandItemPrice(per({ amount: "6.00" }))).toBe("$6 / dozen");
    expect(renderStandItemPrice(per({ amount: "6.50" }))).toBe("$6.50 / dozen");
    expect(renderStandItemPrice(per({ amount: "6.05" }))).toBe("$6.05 / dozen");
  });

  it("says FREE rather than $0", () => {
    // max's call (2026-08-08): free is an amount of zero. "$0 / dozen" is a price a machine
    // wrote; "Free" is what the farmer means by it, and the distinction is worth the branch
    // because giving food away is a thing island stands actually do.
    expect(renderStandItemPrice(per({ amount: "0.00" }))).toBe("Free");
    expect(
      renderStandItemPrice({
        amount: "0",
        quantity: "3.00",
        unit: "lb",
        basis: "for",
      }),
    ).toBe("Free");
  });

  it("drops a quantity of one from a bundle, which is a unit price wearing the wrong word", () => {
    // "1 lb for $5" and "$5 / lb" are the same claim. Rendering the first would let two stands
    // print one fact two ways purely because of which control the farmer touched.
    expect(
      renderStandItemPrice({
        amount: "5.00",
        quantity: "1.00",
        unit: "lb",
        basis: "for",
      }),
    ).toBe("$5 / lb");
  });

  it("keeps a fractional quantity, which a half-flat or half-pound needs", () => {
    expect(
      renderStandItemPrice({
        amount: "4.00",
        quantity: "0.50",
        unit: "lb",
        basis: "for",
      }),
    ).toBe("0.5 lb for $4");
  });

  it("returns null when the price is not stated, so a caller renders NOTHING", () => {
    // Not "" and not "—". The caller decides what an absent price looks like in its own layout,
    // and a renderer inventing a dash would put one on every unpriced item on the map.
    expect(renderStandItemPrice(null)).toBeNull();
    expect(renderStandItemPrice(undefined)).toBeNull();
  });

  it("returns null when any REQUIRED part is missing, rather than printing half a price", () => {
    // The database refuses this shape (`stand_items_price_complete`), so reaching here means a
    // caller built the object by hand. Printing "$6 /" would be worse than printing nothing.
    // The unit is absent from this list deliberately — see the bundle cases below (B-041).
    for (const missing of ["amount", "quantity", "basis"] as const) {
      const partial = { ...per(), [missing]: null };
      expect(renderStandItemPrice(partial as unknown as StandItemPrice)).toBeNull();
    }
  });

  // ── B-041: a bundle does not need a unit; a unit price does ─────────────────────────────
  //
  // "$5 for 3" is the whole price a corn stand letters on its sign — the unit is the cob, and
  // inventing a word for it reads worse than saying nothing. "$6 / " is not a sentence, so the
  // two bases genuinely differ. `standItemPriceNeedsUnit` is that rule, stated once.

  it("states the unit rule for each basis in ONE place", () => {
    // The predicate every other layer imports: the database CHECK, both boundary parsers and
    // this renderer. Four copies of an asymmetry is how three of them come to disagree.
    expect(standItemPriceNeedsUnit("per")).toBe(true);
    expect(standItemPriceNeedsUnit("for")).toBe(false);
  });

  it("renders a bundle with no unit as the count and the amount", () => {
    for (const unit of ["", "  \t ", null, undefined] as const) {
      expect(
        renderStandItemPrice({
          amount: "5.00",
          quantity: "3.00",
          unit,
          basis: "for",
        } as unknown as StandItemPrice),
      ).toBe("$5 for 3");
    }
  });

  it("renders a unitless bundle of one as EACH", () => {
    // max's call (2026-08-08). "$5" alone leaves the reader asking "for what?"; the item's own
    // name is right beside it, so "each" is the word that finishes the sentence.
    expect(
      renderStandItemPrice({
        amount: "5.00",
        quantity: "1.00",
        unit: "",
        basis: "for",
      } as unknown as StandItemPrice),
    ).toBe("$5 each");
  });

  it("still refuses a unit price with no unit, which would render as a dangling slash", () => {
    expect(renderStandItemPrice(per({ unit: "" }))).toBeNull();
    expect(renderStandItemPrice(per({ unit: "  \t " }))).toBeNull();
    expect(
      renderStandItemPrice({ ...per(), unit: null } as unknown as StandItemPrice),
    ).toBeNull();
  });

  it("keeps FREE ahead of the unit rule, so a free bundle needs no unit either", () => {
    expect(
      renderStandItemPrice({
        amount: "0",
        quantity: "3.00",
        unit: "",
        basis: "for",
      } as unknown as StandItemPrice),
    ).toBe("Free");
  });

  it("refuses an unparseable amount rather than printing NaN", () => {
    // `numeric` arrives from the driver as a STRING, so a bad value is a real possibility and
    // `Number("")` is 0 — which would silently print "Free" for a broken row.
    expect(renderStandItemPrice(per({ amount: "" }))).toBeNull();
    expect(renderStandItemPrice(per({ amount: "six" }))).toBeNull();
    expect(renderStandItemPrice(per({ quantity: "" }))).toBeNull();
  });

  it("trims the farmer's own unit rather than printing their stray spaces", () => {
    expect(renderStandItemPrice(per({ unit: "  dozen " }))).toBe("$6 / dozen");
  });
});
