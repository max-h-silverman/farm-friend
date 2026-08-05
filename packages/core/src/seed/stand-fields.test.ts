import { describe, expect, it } from "vitest";
import {
  extractStandFields,
  extractStockUpdate,
  parseFarmBucksPolicy,
} from "./stand-fields";

// B-002 — pulling the labelled facts out of a stand's description.
//
// Every case below is a REAL string from VIGA's 31-stand export, and several are defects a
// looser extractor actually produced when first run over the corpus. Measuring against the
// corpus rather than arguing from the code is what surfaced them (CLAUDE.md standing rules).

describe("extracting labelled availability facts", () => {
  it("reads a stated Open: line", () => {
    const fields = extractStandFields("Open: March to December\nStocking Days: Daily");
    expect(fields.openText).toBe("March to December");
    expect(fields.stockingText).toBe("Daily");
  });

  it("does NOT treat 'OPEN has: eggs' as hours — it is an inventory note", () => {
    // 3 Brothers Outpost. A loose /open[^:\n]*:?/ matched this and would have fed "has: eggs"
    // to the season parser, producing an unparsed flag for a stand that simply states no
    // season at all. The label must be `Open` or `Open:`, not "open" anywhere in a line.
    const fields = extractStandFields("OPEN has: eggs");
    expect(fields.openText).toBeUndefined();
  });

  it("stops an Open: line at the next labelled field", () => {
    // Plum Forest Farm: "Open year round, everyday 9am-8pm" is immediately followed by
    // "Stocking Days: ...". A greedy read swallowed the stocking line into the hours text.
    const fields = extractStandFields(
      "Open year round, everyday 9am-8pm\n\nStocking Days: we stock everyday and harvest tuesday and friday",
    );
    expect(fields.openText).toBe("year round, everyday 9am-8pm");
    expect(fields.openText).not.toContain("Stocking");
    expect(fields.stockingText).toBe(
      "we stock everyday and harvest tuesday and friday",
    );
  });

  it("collects EVERY Open: line so a contradiction is visible, not silently resolved", () => {
    // Green Ears states two different opening times in one description. The seeder must be
    // able to SEE both to raise a flag; an extractor returning only the first would hide the
    // contradiction and publish one arbitrary reading as fact.
    const fields = extractStandFields(
      "Open: April - July Thursday - Sunday / 10AM - Dusk\nStocking Days: Thursday - Sunday\nOpen Thursday - Sunday / 9am - Dusk",
    );
    expect(fields.openTexts).toHaveLength(2);
    expect(fields.openTexts[0]).toContain("10AM");
    expect(fields.openTexts[1]).toContain("9am");
  });

  it("detects a closure note, which contradicts any stated hours", () => {
    // Green Ears' most recent note reads "Closed". This is why the stand seeds with zero
    // inventory and a flag rather than open hours presented as current.
    const fields = extractStandFields(
      "Open: April - July Thursday - Sunday / 10AM - Dusk\n7/9/2026 Update: Closed",
    );
    expect(fields.closureNote).toBeDefined();
    expect(fields.closureNote).toContain("Closed");
  });

  it("treats 'Open only by appointment' as hours, not as a closure", () => {
    // Breathing Meadows Farm. `by_appointment` is a first-class open-hours value.
    const fields = extractStandFields(
      "Open only by appointment – We have a place for learning about herbs",
    );
    expect(fields.openText).toContain("by appointment");
    expect(fields.closureNote).toBeUndefined();
  });

  it("accepts the 'Stocking days:' casing variants the corpus actually uses", () => {
    expect(extractStandFields("Stocking days: variable").stockingText).toBe("variable");
    expect(extractStandFields("Stocking Days: Daily").stockingText).toBe("Daily");
    expect(extractStandFields(" Stocking Days: Friday").stockingText).toBe("Friday");
  });

  it("returns nothing rather than guessing when no label is present", () => {
    // Forest Garden Farm and Open Gate state no Open: line at all. That is `not_stated` — a
    // fact — and must never become an invented season.
    const fields = extractStandFields("Vegetables, fruit, flowers, eggs");
    expect(fields.openText).toBeUndefined();
    expect(fields.stockingText).toBeUndefined();
    expect(fields.closureNote).toBeUndefined();
  });
});

describe("extracting VIGA Bucks policy", () => {
  it("recognizes acceptance stated in a listing", () => {
    expect(parseFarmBucksPolicy("Accepts cash, Venmo, VIGA Farm Bucks")).toEqual({
      accepted: true,
      eligible: true,
    });
    expect(parseFarmBucksPolicy("Accepts all forms of payment, including farm bucks")).toEqual({
      accepted: true,
      eligible: true,
    });
  });

  it("recognizes a stated refusal", () => {
    expect(parseFarmBucksPolicy("Flower-only stand — cannot accept VIGA Bucks")).toEqual({
      accepted: false,
      eligible: true,
    });
  });

  it("leaves missing or contradictory policy unknown", () => {
    expect(parseFarmBucksPolicy("Cash and Venmo only")).toBeUndefined();
    expect(
      parseFarmBucksPolicy("Accepts VIGA Bucks; later note says does not accept VIGA Bucks"),
    ).toBeUndefined();
  });
});

describe("extracting a dated stock update", () => {
  // VIGA's sheet carries lines like "5/26/2026 Update: Salad, spinach, kale". The corpus
  // already reads the CLOSURE form of this ("7/9/2026 Update: Closed") as a closure note; this
  // is the same shape carrying items instead, and nothing consumed it. Left as prose it printed
  // a date directly beneath the card's own "Nothing confirmed recently", which is the
  // contradiction this parse exists to remove.

  it("reads the date and the items from a dated update line", () => {
    const update = extractStockUpdate(
      "Open: March-November.\n5/26/2026 Update: Salad, spinach, kale, radish",
    );
    expect(update?.statedOn).toEqual(new Date(Date.UTC(2026, 4, 26)));
    expect(update?.items).toEqual(["Salad", "spinach", "kale", "radish"]);
  });

  it("splits a trailing 'and' item, which the corpus writes as a sentence", () => {
    const update = extractStockUpdate(
      "5/26/2026 Update: microgreens, pea shoots, herbs, plant starts and flowers",
    );
    expect(update?.items).toEqual([
      "microgreens", "pea shoots", "herbs", "plant starts", "flowers",
    ]);
  });

  it("takes the LAST dated update when a description carries several", () => {
    // Descriptions accumulate notes over a season. The most recent is the only one that could
    // describe what is there now; an earlier one is history.
    const update = extractStockUpdate(
      "4/2/2026 Update: rhubarb\n5/26/2026 Update: salad, kale",
    );
    expect(update?.statedOn).toEqual(new Date(Date.UTC(2026, 4, 26)));
    expect(update?.items).toEqual(["salad", "kale"]);
  });

  it("returns nothing for a dated CLOSURE, which is not a stock statement", () => {
    // "7/9/2026 Update: Closed" already has a consumer — `closureNote` — and reading it as an
    // inventory of one item called "Closed" would publish a closed stand as stocked.
    expect(extractStockUpdate("7/9/2026 Update: Closed")).toBeUndefined();
  });

  it("returns nothing when an update line states no items", () => {
    expect(extractStockUpdate("5/26/2026 Update:")).toBeUndefined();
    expect(extractStockUpdate("Open: March-November. 7 days a week.")).toBeUndefined();
  });

  it("refuses an impossible date rather than rolling it into the next month", () => {
    // `new Date(2026, 1, 31)` silently becomes 3 March. A date the sheet states wrongly must
    // not become a confident confirmation on a day nobody wrote down.
    expect(extractStockUpdate("2/31/2026 Update: kale")).toBeUndefined();
    expect(extractStockUpdate("13/1/2026 Update: kale")).toBeUndefined();
  });
});
