import { describe, expect, it } from "vitest";
import { renderStockOutAlert } from "./stock-out-alert";

// The farmer-facing half of a customer's stock-out report (F-104). Every word here is
// code-rendered from typed facts: the report reaches the farmer as a PROMPT to check their
// listing, never as a customer's sentence quoted at them.

const listed = { kind: "listed", itemName: "Kale" } as const;

describe("stock-out alert copy", () => {
  it("names the stand and the farmer's own item name", () => {
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      item: listed,
    });

    expect(body).toContain("Alpha Farm Stand");
    expect(body).toContain("Kale");
  });

  it("asks the farmer to send an update rather than opening a new commitment", () => {
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      item: listed,
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
      item: listed,
    });

    // Golden Rule #1: a customer's word is a signal, not a change to the farmer's listing.
    // The farmer is told someone SAID it, and remains the one who decides what is true.
    expect(body.toLowerCase()).toMatch(/someone|a customer|reported|told us|let us know/);
  });

  it("carries nothing identifying about the reporter", () => {
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      item: listed,
    });

    // Golden Rule #5: the reporter is an anonymous stranger and stays one.
    expect(body).not.toMatch(/\d{3}[\s.-]?\d{4}/);
  });

  /**
   * The type has no field for unlisted item text, so this is the runtime half of a guarantee
   * the compiler already enforces: an unlisted report still produces a usable alert, and the
   * model's description of the item is simply not in it.
   *
   * Sabotage check: give the unlisted branch an `itemName` and interpolate it, and the
   * integration suite's hostile-prose test fails.
   */
  it("still alerts on an unlisted item without speaking the model's text", () => {
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      item: { kind: "unlisted" },
    });

    // The farmer learns the stand and the ask — enough to act on.
    expect(body).toContain("Alpha Farm Stand");
    expect(body).toContain("sold out");
    expect(body.toLowerCase()).toContain("text us what your stand has now");
  });
});
