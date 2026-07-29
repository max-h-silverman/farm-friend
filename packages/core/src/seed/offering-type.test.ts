import { describe, expect, it } from "vitest";
import { classifyOfferingType } from "./offering-type";

// F-038 — what a farm sells, inferred at SEED TIME from the farmer's own words.
//
// Two cases in the corpus are not produce stands, and both said so themselves:
//   Seedrain.org / Garden Cycles — "Advice and services for invasive plant control"
//   Open Gate Lamb and Grazing   — "Send an email to order meat", delivery only
//
// No farm name appears in this classifier or its tests as a behavioural branch. The fixtures are
// the farmers' own sentences, and a farm renaming itself must not change how it is classified.

describe("classifyOfferingType", () => {
  it("classifies a farm selling advice and labour as services", () => {
    expect(
      classifyOfferingType({
        generalInformation: "Advice and services for invasive plant control",
      }),
    ).toBe("services");

    // The same fact stated differently. A single phrasing would make this a lookup for one farm.
    expect(
      classifyOfferingType({ generalInformation: "Garden design consulting" }),
    ).toBe("services");
  });

  it("classifies a farm you must order from in advance as by_order", () => {
    expect(
      classifyOfferingType({
        generalInformation:
          "100% forage fed New Zealand style lamb. Born and raised on Vashon pasture.",
        extraNotes: "Send an email to order meat, hire the flock, or receive newsletters",
        stockingText:
          "USDA cuts available through the year, whole and half shares reservations open a month before butcher",
      }),
    ).toBe("by_order");
  });

  it("leaves an ordinary stand as produce", () => {
    // The default must hold for the other 30 farms. A classifier that reaches for a special
    // case too eagerly mislabels the corpus in the direction nobody checks.
    expect(
      classifyOfferingType({
        generalInformation: "Vegetables, fruit, flowers, eggs",
        stockingText: "Everyday, but mostly on Tuesdays and Saturdays",
      }),
    ).toBe("produce");

    expect(classifyOfferingType({})).toBe("produce");

    // Mentioning an order in passing does not make a farm by-order — plenty of stands take
    // special requests alongside an ordinary self-serve stand.
    expect(
      classifyOfferingType({
        generalInformation: "Self-serve stand. Bulk orders welcome, just ask!",
      }),
    ).toBe("produce");
  });

  it("prefers services over by_order when a farm states both", () => {
    // A service business that also takes bookings is still a service business. Fixing the
    // precedence here means it is stated once, rather than depending on evaluation order.
    expect(
      classifyOfferingType({
        generalInformation: "Advice and services for invasive plant control",
        extraNotes: "Email to order a consultation",
      }),
    ).toBe("services");
  });
});
