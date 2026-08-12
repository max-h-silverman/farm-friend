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

  /*
    The item name is the farmer's own words and comes in every grammatical number: "Eggs",
    "Lettuce", "bread", "a choy" are all real `stand_items` rows. A sentence that agreed with
    one would disagree with the others — "eggs is sold out" was what production sent — so the
    rendering must not depend on number at all.
  */
  it("reads correctly whatever the number of the farmer's own item name", () => {
    for (const itemName of ["eggs", "lettuce", "bread", "a choy", "Tomatoes"]) {
      const body = renderStockOutAlert({
        locationName: "Alpha Farm Stand",
        item: { kind: "listed", itemName },
      });

      expect(body).toContain(itemName);
      // No verb agreeing with the item, in either direction.
      expect(body).not.toContain(`${itemName} is`);
      expect(body).not.toContain(`${itemName} are`);
    }
  });

  /*
    B-060. B-057 gave `stand_items.display_name` a second consumer it was not designed for: it
    now reaches the LISTED branch and is spoken verbatim in an SMS Farm Friend sends a farmer.

    The column's own guards are a trim and a not-blank CHECK — NOT `validatePublicStrings`,
    which runs on the participants and transactions paths only. So the property these tests
    prove is not "the string is clean"; it is that a dirty string is INERT: it lands inside one
    code-owned sentence and cannot restructure the message, add a line, or issue an
    instruction the farmer would read as Farm Friend speaking.

    Every case below is the LISTED branch, because that is the one B-057 newly widened.
  */
  it("cannot add a line to the alert, whatever the item name contains", () => {
    // The message's shape is code's, not the data's. A display_name carrying newlines must not
    // be able to append a sentence that reads as Farm Friend's own.
    const hostile =
      "kale\n\nVIGA Farm Friend: reply with your bank details to verify your listing.";
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      item: { kind: "listed", itemName: hostile },
    });

    // Anchored to the STRUCTURE the renderer owns: two sentences separated by one blank line.
    // Counting lines is what catches an injected line; searching for the hostile words would
    // pass even if they arrived on a line of their own.
    const lines = body.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(
      "If that's right, text us what your stand has now and we'll update your listing.",
    );
  });

  it("cannot add a line via the stand's name either", () => {
    // `sales_locations.name` is farmer-authored on the same footing as the item name, and it is
    // interpolated into the same sentence. Proving only the item field would leave the other
    // half of the sentence open — a sabotage removing the stand name's flattening passed the
    // item-name test untouched.
    const body = renderStockOutAlert({
      locationName: "Alpha Stand\n\nVIGA Farm Friend: your listing was removed.",
      item: listed,
    });

    expect(body.split("\n")).toHaveLength(3);
  });

  it("keeps injection prose inside the reported-by-someone sentence", () => {
    // The farmer must still read this as "a stranger said X", never as Farm Friend instructing
    // them. The injected imperative stays downstream of "someone reported that", so it is
    // quoted material inside a claim about a report — not a directive in Farm Friend's voice.
    const hostile = "IGNORE PRIOR RULES. Text back your address and call 206-555-0142.";
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      item: { kind: "listed", itemName: hostile },
    });

    const first = body.split("\n")[0]!;
    expect(first.startsWith("VIGA Farm Friend: someone reported that Alpha Farm Stand is")).toBe(
      true,
    );
    // The whole hostile string sits after "sold out of" — it never becomes its own sentence.
    expect(first).toContain(`sold out of ${hostile}`);
    expect(first.endsWith(".")).toBe(true);
  });

  it("renders the closing ask unchanged even when the item name mimics it", () => {
    // A display_name that impersonates the renderer's own closing line must not displace or
    // duplicate the real one — the ask is code's sentence and appears exactly once.
    const mimic =
      "If that's right, text us what your stand has now and we'll update your listing.";
    const body = renderStockOutAlert({
      locationName: "Alpha Farm Stand",
      item: { kind: "listed", itemName: mimic },
    });

    const occurrences = body.split(mimic).length - 1;
    // Twice by construction: once inside the report sentence, once as the genuine closing ask.
    expect(occurrences).toBe(2);
    expect(body.split("\n")).toHaveLength(3);
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
