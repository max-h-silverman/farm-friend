import { describe, expect, it } from "vitest";
import { renderStockOutAlert } from "./stock-out-alert";

// The farmer-facing half of a customer's stock-out report (F-104). Every word here is
// code-rendered from typed facts: the report reaches the farmer as a PROMPT to check their
// listing, never as a customer's sentence quoted at them.

describe("stock-out alert copy", () => {
  it("names the stand and the item a customer reported", () => {
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      itemName: "Kale",
    });

    expect(body).toContain("Alpha Farm Stand");
    expect(body).toContain("Kale");
  });

  it("asks the farmer to send an update rather than opening a new commitment", () => {
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      itemName: "Kale",
    });

    /*
      GL-007's required outcome: the alert creates no separate OUT/IGNORE commitment. A
      farmer's reply enters the ordinary inventory proposal and YES/NO confirmation flow, so
      this message must not teach a token that would need its own parsing, expiry, and
      one-open-confirmation rule. Anchored to the tokens themselves, not to nearby prose.
    */
    expect(body).not.toMatch(/\bOUT\b/);
    expect(body).not.toMatch(/\bIGNORE\b/);
  });

  it("states the report as unconfirmed rather than as fact", () => {
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      itemName: "Kale",
    });

    // Golden Rule #1: a customer's word is a signal, not a change to the farmer's listing.
    // The farmer is told someone SAID it, and remains the one who decides what is true.
    expect(body.toLowerCase()).toMatch(/someone|a customer|reported|told us|let us know/);
  });

  it("carries nothing identifying about the reporter", () => {
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      itemName: "Kale",
    });

    // Golden Rule #5: the reporter is an anonymous stranger and stays one.
    expect(body).not.toMatch(/\d{3}[\s.-]?\d{4}/);
  });

  it("renders an unlisted item the customer named without inventing a listing", () => {
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      itemName: "rhubarb",
    });

    expect(body).toContain("rhubarb");
  });
});
