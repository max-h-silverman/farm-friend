import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitMergedItemName } from "./merged-item-name";

/*
  Found on a handset 2026-08-13: asking for "eggs" returned Morgan Hill Community Farm Stand with
  `May have: salad mix, pickling cucumbers, squash, variety of herbs, green beans, duck eggs,
  chicken eggs, flowers, swiss chard` — the stand's whole offerings list stored as ONE item.

  Measured against production the same day: exactly one `stand_items` row in the corpus has this
  shape, no other row contains a comma, and no row over 40 characters lacks one. So this rule
  exists to DETECT the shape safely, not to parse arbitrary prose — everything it cannot prove is
  a list, it declines.
*/

describe("splitting a stand_items name that holds a list", () => {
  it("splits the real production row into its nine items", () => {
    expect(
      splitMergedItemName(
        "salad mix, pickling cucumbers, squash, variety of herbs, green beans, duck eggs, " +
          "chicken eggs, flowers, swiss chard",
      ),
    ).toEqual([
      "salad mix",
      "pickling cucumbers",
      "squash",
      "variety of herbs",
      "green beans",
      "duck eggs",
      "chicken eggs",
      "flowers",
      "swiss chard",
    ]);
  });

  it("declines an ordinary item name", () => {
    // Every other row in the corpus. `null` means "not a list", which the caller skips entirely.
    for (const name of ["cucumbers", "duck eggs", "baby lettuce mix", "Cherry Tomatoes"]) {
      expect(splitMergedItemName(name)).toBeNull();
    }
  });

  it("declines a name whose comma is part of the item, not a separator", () => {
    // A single trailing fragment is not a list of two things. Requiring several parts keeps this
    // from inventing items out of punctuation.
    expect(splitMergedItemName("eggs, dozen")).toBeNull();
  });

  it("requires at least three parts before believing it is a list", () => {
    expect(splitMergedItemName("kale, chard")).toBeNull();
    expect(splitMergedItemName("kale, chard, beets")).toEqual(["kale", "chard", "beets"]);
  });

  it("drops empty fragments from stray or doubled commas", () => {
    expect(splitMergedItemName("kale, , chard, beets,")).toEqual(["kale", "chard", "beets"]);
  });

  it("trims surrounding whitespace on every part", () => {
    expect(splitMergedItemName("  kale ,chard  ,  beets ")).toEqual(["kale", "chard", "beets"]);
  });

  it("declines a part long enough to be prose rather than an item", () => {
    // A guard against splitting a sentence into "items". Real item names are short; the longest
    // legitimate one in the corpus is 23 characters.
    expect(
      splitMergedItemName(
        "we grow a lot of things here, please come by on a Saturday afternoon, " +
          "and bring exact change because there is no card reader",
      ),
    ).toBeNull();
  });

  it("declines an empty or whitespace-only name", () => {
    expect(splitMergedItemName("")).toBeNull();
    expect(splitMergedItemName("   ")).toBeNull();
  });

  it("is idempotent — a split part is never itself splittable", () => {
    const parts = splitMergedItemName("kale, chard, beets");
    expect(parts).not.toBeNull();
    for (const part of parts ?? []) {
      expect(splitMergedItemName(part)).toBeNull();
    }
  });

  it("holds no farm or food vocabulary in its EXECUTABLE source", () => {
    /*
      The same rule the stand-name matcher lives under: this compares SHAPE, and a crop word in a
      branch here would be policy hiding in a parser.

      **Anchored to executable code, not to the whole file.** An earlier version stripped comments
      first and then searched the remainder — which passed with `eggs` planted in the source,
      because the strip removed the very text the assertion looked for. Sabotage caught it. The
      file's prose legitimately NAMES the failure it was written for, so the comments cannot be
      searched; what must stay clean is the code that runs.
    */
    const code = executableSource();
    // Prove the extraction actually sees the code before trusting an empty result: a search that
    // cannot match comes back clean against text sitting right there.
    expect(code).toContain("MINIMUM_PARTS");
    expect(code).toContain("splitMergedItemName");

    for (const word of ["egg", "kale", "cucumber", "squash", "chard", "flower", "produce"]) {
      expect(code.toLowerCase()).not.toContain(word);
    }
  });
});

/**
 * The rule's source with comments and imports removed — i.e. only what executes.
 *
 * Comments are stripped because this file's own prose names the crop words the defect involved;
 * searching them would make the assertion unfailable in the other direction.
 */
function executableSource(): string {
  const path = fileURLToPath(new URL("./merged-item-name.ts", import.meta.url));
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^import .*$/gm, "");
}
