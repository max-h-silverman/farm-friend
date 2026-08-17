import { describe, expect, it } from "vitest";
import {
  creditSeller,
  groupProviderItems,
  type CreditableListing,
  type ProviderItemFacts,
} from "./seller-credit";

/*
  F-114 Phase C.5 — the labelling rule and item-first grouping, stated once.

  Two rules live here, and both had readers before they had a home:

  1. **Who gets credited.** `describesOwnStand` — the SELF-POINTER — decides, and nothing else
     may. Three readers already implemented this separately (the SMS target menu, the farmer
     settings screen, the reminder schedule list) and the public cards are the fourth. They
     agreed by habit; here they agree by construction.

  2. **Each item once, its providers nested beneath it.** The stand card's shape. Before C.5 the
     card printed one flat list per stand, which after Phase B multiplies into three duplicate
     `Tomatoes` rows the moment two sellers both carry tomatoes.

  The separator is a PARAMETER rather than a constant, and that is not indecision. SMS is
  GSM-7-bound and an em-dash re-encodes the whole body to UCS-2, halving the segment capacity
  (`reply-encoding.test.ts`); the web card has no such constraint and reads better with one. The
  RULE is what must not differ between channels, and the rule is which listings get a name.
*/

const listing = (
  sellerName: string,
  describesOwnStand: boolean,
): CreditableListing => ({ locationName: "Morgan Hill Stand", sellerName, describesOwnStand });

describe("creditSeller", () => {
  it("renders the stand's own listing unlabelled", () => {
    expect(creditSeller(listing("Morgan Hill Farm", true), " — ")).toBe(
      "Morgan Hill Stand",
    );
  });

  it("credits every other seller by name", () => {
    expect(creditSeller(listing("Tian Tian", false), " — ")).toBe(
      "Morgan Hill Stand — Tian Tian",
    );
  });

  /*
    THE DEFECT THIS RULE EXISTS TO PREVENT (§suppression follows a pointer).

    A name match would suppress a genuine hosted seller whose name resembles the stand's, and
    would credit a stand's own goods by name whenever the two strings differ. Both are real in
    the corpus: "Morgan Hill Farm" runs "Morgan Hill Stand", and a hosted "Hill Farm" at a "Hill
    Farm Stand" is exactly the collision a looser rule erases.

    These two cases are the ONLY thing that could catch a reader that switched to comparing
    strings — every other case in this file passes either way.
  */
  it("credits a hosted seller whose name matches the stand's", () => {
    expect(
      creditSeller(
        { locationName: "Hill Farm Stand", sellerName: "Hill Farm", describesOwnStand: false },
        " — ",
      ),
    ).toBe("Hill Farm Stand — Hill Farm");
  });

  it("suppresses the stand's own seller even when the two names differ", () => {
    expect(
      creditSeller(
        {
          locationName: "Morgan Hill Stand",
          sellerName: "Morgan Hill Farm",
          describesOwnStand: true,
        },
        " — ",
      ),
    ).toBe("Morgan Hill Stand");
  });

  it("uses the separator it is given, so SMS stays GSM-7", () => {
    expect(creditSeller(listing("Tian Tian", false), " - ")).toBe(
      "Morgan Hill Stand - Tian Tian",
    );
  });
});

const provider = (
  sellerName: string,
  describesOwnStand: boolean,
  items: ProviderItemFacts["items"],
  overrides: Partial<ProviderItemFacts> = {},
): ProviderItemFacts => ({
  providerId: `provider-${sellerName}`,
  sellerId: `seller-${sellerName}`,
  sellerName,
  describesOwnStand,
  items,
  ...overrides,
});

const confirmed = (itemName: string, priceText?: string) => ({
  itemName,
  register: "confirmed" as const,
  ...(priceText === undefined ? {} : { priceText }),
});

const usual = (itemName: string, priceText?: string) => ({
  itemName,
  register: "usual" as const,
  ...(priceText === undefined ? {} : { priceText }),
});

describe("groupProviderItems", () => {
  it("shows an item once with every supporting provider nested beneath it", () => {
    const grouped = groupProviderItems([
      provider("Morgan Hill Farm", true, [confirmed("eggs", "$8")]),
      provider("Tian Tian", false, [confirmed("eggs", "$7")]),
      provider("Cascade Bakery", false, [confirmed("eggs", "$9")]),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.itemName).toBe("eggs");
    expect(grouped[0]!.providers.map((p) => p.sellerName)).toEqual([
      "Morgan Hill Farm",
      "Tian Tian",
      "Cascade Bakery",
    ]);
    // Each provider keeps its OWN price. The collision §customer behavior names is resolved by
    // nesting, never by a range and never by suppressing the price.
    expect(grouped[0]!.providers.map((p) => p.priceText)).toEqual(["$8", "$7", "$9"]);
  });

  it("does not merge two items that differ only in case or surrounding space", () => {
    // The vocabulary is already reconciled upstream by the stand_items join, so a difference
    // that survives to here is a REAL difference between two sellers' own words. Folding it
    // would print one seller's spelling over another's.
    const grouped = groupProviderItems([
      provider("A", true, [confirmed("Eggs")]),
      provider("B", false, [confirmed("eggs")]),
    ]);
    expect(grouped.map((g) => g.itemName)).toEqual(["Eggs", "eggs"]);
  });

  it("keeps the confirmed and usual registers apart for the same item name", () => {
    // §customer behavior: unknown, usual and current are NEVER collapsed. One seller confirming
    // eggs today and another merely usually carrying them are two different claims, and a
    // reader that merged them would date a standing claim by someone else's confirmation.
    const grouped = groupProviderItems([
      provider("A", true, [confirmed("eggs")]),
      provider("B", false, [usual("eggs")]),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped.map((g) => [g.itemName, g.register])).toEqual([
      ["eggs", "confirmed"],
      ["eggs", "usual"],
    ]);
  });

  it("orders confirmed groups before usual ones", () => {
    const grouped = groupProviderItems([
      provider("A", true, [usual("jam"), confirmed("eggs")]),
    ]);
    expect(grouped.map((g) => g.register)).toEqual(["confirmed", "usual"]);
  });

  it("carries each provider's own freshness onto its nested line", () => {
    const grouped = groupProviderItems([
      provider("A", true, [confirmed("eggs")], { cardRecency: "Last updated 2 hours ago" }),
      provider("B", false, [confirmed("eggs")], { cardRecency: "Last updated 3 weeks ago" }),
    ]);
    expect(grouped[0]!.providers.map((p) => p.cardRecency)).toEqual([
      "Last updated 2 hours ago",
      "Last updated 3 weeks ago",
    ]);
  });

  /*
    A USUAL LINE CARRIES NO TIMESTAMP, EVER (§customer behavior, and the rule
    `standListingLines` has held since F-042).

    A hosted seller is public on approval, on standing claims alone — so this is the FIRST thing
    a customer sees about them, and a date beside it would read as a confirmation nobody made.
    The grouper drops recency on a usual line rather than trusting each renderer to omit it.
  */
  it("drops recency from a usual line even when the provider has one", () => {
    const grouped = groupProviderItems([
      provider("A", false, [usual("bread")], { cardRecency: "Last updated 2 hours ago" }),
    ]);
    expect(grouped[0]!.providers[0]!.cardRecency).toBeUndefined();
  });

  it("returns nothing for a provider with no items at all", () => {
    expect(groupProviderItems([provider("A", true, [])])).toEqual([]);
  });

  it("preserves the first-seen order of item names", () => {
    const grouped = groupProviderItems([
      provider("A", true, [confirmed("tomatoes"), confirmed("eggs")]),
      provider("B", false, [confirmed("eggs"), confirmed("apples")]),
    ]);
    expect(grouped.map((g) => g.itemName)).toEqual(["tomatoes", "eggs", "apples"]);
  });

  it("credits the nested provider by the self-pointer, not by comparing names", () => {
    const grouped = groupProviderItems([
      provider("Morgan Hill Farm", true, [confirmed("eggs")]),
      provider("Tian Tian", false, [confirmed("eggs")]),
    ]);
    expect(grouped[0]!.providers.map((p) => p.describesOwnStand)).toEqual([true, false]);
  });
});
