import { describe, expect, it } from "vitest";
import { relatedCategoryLabel, sortMatchesByExactness } from "./exactness";

/*
  B-086 — the real reply that produced this file.

  "who has kale?" expanded to eleven values and printed them all as equals, so a stand listing
  "vegetables" read as an answer about kale. The expansion itself is correct and F-045 requires
  it; what was wrong is presenting a category as though it were the thing.

  Every fixture below is a value from the PRODUCTION catalog, measured 2026-08-18.
*/

describe("sorting matched values by whether they answer the question", () => {
  it("splits the real kale expansion into the one that answers and the rest", () => {
    const { exact, related } = sortMatchesByExactness("who has kale?", [
      "kale",
      "bok choy",
      "Baby bok choy",
      "a choy",
      "leafy greens",
      "greens",
      "salad greens",
      "veggies",
      "vegetables",
      "seasonal vegetables",
      "produce",
    ]);

    expect(exact).toEqual(["kale"]);
    expect(related).toHaveLength(10);
    expect(related).toContain("vegetables");
    expect(related).toContain("bok choy");
  });

  it("keeps every spelling of the asked-for item exact", () => {
    // Both answer a kale question; `kale florets` is kale, not a category containing it.
    const { exact, related } = sortMatchesByExactness("who has kale?", [
      "Kale",
      "kale florets",
      "leafy greens",
    ]);
    expect(exact).toEqual(["Kale", "kale florets"]);
    expect(related).toEqual(["leafy greens"]);
  });

  it("matches whole words, so eggs never makes eggplant exact", () => {
    /*
      THE SUBSTRING TRAP, from the real corpus. `eggs` appears inside `Asian eggplant`, and a
      substring test would promote an aubergine to an answer about eggs.
    */
    const { exact, related } = sortMatchesByExactness("who has eggs?", [
      "Eggs",
      "duck eggs",
      "chicken eggs",
      "Asian eggplant",
    ]);
    expect(exact).toEqual(["Eggs", "duck eggs", "chicken eggs"]);
    expect(related).toEqual(["Asian eggplant"]);
  });

  it("does not find one value inside another as a SUBSTRING", () => {
    /*
      `a choy` is a substring of `bok choy`, and whole-word matching is what stops a naive
      `includes` from mixing them up on the character level.

      KNOWN LIMIT, asserted rather than hidden: a question for "a choy" also treats `bok choy`
      as exact, because stripping question grammar removes the article `a` and leaves only
      `choy` — which both vegetables genuinely contain. Distinguishing them needs to know that
      `a` is part of a vegetable's name rather than an article, which is a food vocabulary in a
      behavioural branch, and the project allows exactly one of those (`map-view.ts` §the flower
      vocabulary exception).

      The consequence is mild and the right way round: a customer asking for a choy sees bok choy
      listed as an exact answer rather than under "Other stands with". Both are choy; neither is
      a category claim. INVERT WHEN a second food vocabulary is ever justified.
    */
    const { exact } = sortMatchesByExactness("who has a choy?", ["bok choy", "a choy"]);
    expect(exact).toContain("a choy");
    expect(exact).toContain("bok choy");

    /*
      What whole-word matching DOES buy, on the same corpus. Asked alongside a real egg value,
      so the "nothing exact means everything is exact" rule is not what answers — that rule is
      correct and would mask this.
    */
    const eggs = sortMatchesByExactness("who has eggs?", ["Eggs", "Asian eggplant"]);
    expect(eggs.exact).toEqual(["Eggs"]);
    expect(eggs.related).toEqual(["Asian eggplant"]);
  });

  it("treats singular and plural as one word", () => {
    // The corpus holds both spellings of most items; a customer types whichever they think of.
    expect(sortMatchesByExactness("who has egg?", ["Eggs"]).exact).toEqual(["Eggs"]);
    expect(sortMatchesByExactness("who has eggs?", ["Egg"]).exact).toEqual(["Egg"]);
  });

  it("ignores question grammar, so 'has' cannot make a value exact", () => {
    const { exact, related } = sortMatchesByExactness("who has some flowers today?", [
      "flowers",
      "produce",
    ]);
    expect(exact).toEqual(["flowers"]);
    expect(related).toEqual(["produce"]);
  });

  /*
    THE CASE THAT MUST NOT SPLIT. A customer asking for a category typed no word that appears in
    any result, and filing every stand under "Other stands with…" would be a worse answer than
    the one this replaces. F-045's whole point is that this question works.
  */
  it("calls everything exact when the customer asked for a category", () => {
    const { exact, related } = sortMatchesByExactness("who has leafy greens?", [
      "butter lettuce",
      "chard",
    ]);
    expect(exact).toEqual(["butter lettuce", "chard"]);
    expect(related).toEqual([]);
  });

  it("calls everything exact when the message contributes no product word", () => {
    const { exact, related } = sortMatchesByExactness("who has any?", ["kale"]);
    expect(exact).toEqual(["kale"]);
    expect(related).toEqual([]);
  });

  it("preserves the caller's order within each group", () => {
    const { exact, related } = sortMatchesByExactness("kale", [
      "leafy greens",
      "kale",
      "greens",
      "kale florets",
    ]);
    expect(exact).toEqual(["kale", "kale florets"]);
    expect(related).toEqual(["leafy greens", "greens"]);
  });
});

describe("naming the related group", () => {
  it("labels it with the broadest value the matcher chose", () => {
    // Shortest wins: a category name is shorter than the things filed under it.
    expect(
      relatedCategoryLabel(["salad greens", "greens", "seasonal vegetables"]),
    ).toBe("greens");
  });

  it("has no label when nothing is related", () => {
    expect(relatedCategoryLabel([])).toBeUndefined();
  });

  it("never invents a word that is not a matched catalog value", () => {
    /*
      The label comes from the values themselves. Inventing one would be a food vocabulary in a
      behavioural branch, which this project permits exactly once and not here.
    */
    const label = relatedCategoryLabel(["bok choy", "vegetables"]);
    expect(["bok choy", "vegetables"]).toContain(label);
  });
});
