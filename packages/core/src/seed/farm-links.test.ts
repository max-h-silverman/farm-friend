import { describe, expect, it } from "vitest";
import { parseFarmLinks, parsePaymentMethods } from "./farm-links";

// F-061 — links and payment methods, measured against the real corpus before being written.
//
// Every input below is a REAL cell from VIGA's two exports (2026-08-04), not an invented shape.
// The audit counted "41 link lines, 22 payment lines" without saying which file they were in;
// measuring first found that payments exist ONLY in the map transcription — the profile form has
// no payment question at all — and that the link cells are far messier than a count suggests.

describe("parseFarmLinks", () => {
  describe("what a farmer actually typed", () => {
    it("adds a scheme to a naked domain, which is how most farmers answered", () => {
      // `farm_links_absolute_http_url` requires ^https?://, so a naked domain is REFUSED by
      // Postgres. Storing these unchanged would mean silently losing most of the corpus.
      expect(parseFarmLinks({ website: "www.aeggys.com" })).toEqual([
        { label: "Website", url: "https://www.aeggys.com" },
      ]);
      expect(parseFarmLinks({ website: "Altarosafarm.com" })).toEqual([
        { label: "Website", url: "https://Altarosafarm.com" },
      ]);
      expect(parseFarmLinks({ website: "tiantian.farm" })).toEqual([
        { label: "Website", url: "https://tiantian.farm" },
      ]);
    });

    it("keeps an absolute URL exactly as given", () => {
      expect(
        parseFarmLinks({ website: "https://fruitsdesvignesfarmstand-102554.square.site/" }),
      ).toEqual([
        { label: "Website", url: "https://fruitsdesvignesfarmstand-102554.square.site/" },
      ]);
    });

    it("treats 'None', 'Nope', and 'na' as no link at all (max, 2026-08-04)", () => {
      // Three real answers. A farmer saying they have no website must not publish a card
      // linking to a site called "Nope".
      expect(parseFarmLinks({ website: "None", socialMedia: "None" })).toEqual([]);
      expect(parseFarmLinks({ website: "Nope", socialMedia: "Nope" })).toEqual([]);
      expect(parseFarmLinks({ website: "na" })).toEqual([]);
      expect(parseFarmLinks({ website: "n/a" })).toEqual([]);
      expect(parseFarmLinks({ website: "  " })).toEqual([]);
    });

    it("resolves a bare @handle to the platform its label names", () => {
      // "@aeggysfarm" is not a URL and cannot be stored as one. The LABEL carries the platform,
      // so the handle resolves against it rather than being guessed from the string.
      expect(parseFarmLinks({ socialMedia: "Instagram: @aeggysfarm" })).toEqual([
        { label: "Instagram", url: "https://instagram.com/aeggysfarm" },
      ]);
      expect(parseFarmLinks({ socialMedia: "Insta: @altarosafarm" })).toEqual([
        { label: "Instagram", url: "https://instagram.com/altarosafarm" },
      ]);
      expect(parseFarmLinks({ socialMedia: "Facebook: facebook.com/NarwhalFarm" })).toEqual([
        { label: "Facebook", url: "https://facebook.com/NarwhalFarm" },
      ]);
    });

    it("refuses a bare handle with no platform, rather than guessing one", () => {
      // "@farmstad.com" and "@NarwhalFarm" appear in the SOCIAL cell with no platform named.
      // Guessing Instagram would publish a link that may not exist. Nothing is stored.
      expect(parseFarmLinks({ socialMedia: "@farmstad.com" })).toEqual([]);
      expect(parseFarmLinks({ socialMedia: "@NarwhalFarm" })).toEqual([]);
    });

    it("refuses free text that names no destination", () => {
      // Vashon Garlic's social cell reads "vashon garlic" — a name, not a link.
      expect(parseFarmLinks({ socialMedia: "vashon garlic" })).toEqual([]);
      expect(parseFarmLinks({ socialMedia: "Facebook: Lavender Hill Farm" })).toEqual([]);
    });

    it("reads several links out of one cell", () => {
      // Real cells carry two links joined by "and", ";", or ",".
      expect(
        parseFarmLinks({ website: "seedrain.org and gardencyclesllc.com" }),
      ).toEqual([
        { label: "Website", url: "https://seedrain.org" },
        { label: "Website", url: "https://gardencyclesllc.com" },
      ]);
      expect(
        parseFarmLinks({
          socialMedia:
            "Instagram: @vashongarlic; Facebook: https://www.facebook.com/vashongarlic",
        }),
      ).toEqual([
        { label: "Instagram", url: "https://instagram.com/vashongarlic" },
        { label: "Facebook", url: "https://www.facebook.com/vashongarlic" },
      ]);
    });

    it("labels a scheme-carrying social link by its platform, not 'Website'", () => {
      expect(
        parseFarmLinks({ socialMedia: "https://www.instagram.com/ostarafarmandflowers/" }),
      ).toEqual([
        { label: "Instagram", url: "https://www.instagram.com/ostarafarmandflowers/" },
      ]);
      expect(
        parseFarmLinks({
          socialMedia: "https://www.facebook.com/share/186pfGqKXg/?mibextid=wwXIfr",
        }),
      ).toEqual([
        { label: "Facebook", url: "https://www.facebook.com/share/186pfGqKXg/?mibextid=wwXIfr" },
      ]);
    });

    it("never emits the same URL twice, however many cells name it", () => {
      // `farm_links_farm_url_unique` refuses a duplicate, which would abort the whole seed
      // transaction rather than skipping one row.
      expect(
        parseFarmLinks({
          website: "www.pacificcrest.org",
          socialMedia: "Website: www.pacificcrest.org",
        }),
      ).toEqual([{ label: "Website", url: "https://www.pacificcrest.org" }]);
    });

    it("produces only URLs Postgres will accept", () => {
      // The constraint, restated as a test. Anything this function emits must satisfy it, or
      // the seed aborts mid-transaction on real data.
      const absolute = /^https?:\/\/[^\s]+$/;
      const messy = [
        "www.aeggys.com", "Www.florahillfarm.com", "seedrain.org and gardencyclesllc.com",
        "Instagram: @aeggysfarm", "instagram.com/greenearsgarden", "None", "Nope", "na",
        "vashon garlic", "@farmstad.com", "https://northbourne.farm/",
      ];
      for (const cell of messy) {
        for (const link of parseFarmLinks({ website: cell, socialMedia: cell })) {
          expect(link.url, `from cell: ${cell}`).toMatch(absolute);
          expect(link.label.trim(), `from cell: ${cell}`).not.toBe("");
        }
      }
    });
  });

  describe("the farmer's own answer outranks the transcription (max, 2026-08-04)", () => {
    it("drops a map link when the farm submitted its own website answer", () => {
      // THE REAL DEFECT THIS EXISTS FOR. The map export lists
      // "Website: www.handpickedhomestead.com" under PLUM FOREST FARM — one farm's site typed
      // onto another farm's row, exactly the manual-transcription error Farm Friend removes.
      // Plum Forest's own form answer is plumforestfarm.com, so preferring the farmer's answer
      // fixes this case and every one like it without naming any farm in code.
      expect(
        parseFarmLinks({
          website: "plumforestfarm.com",
          socialMedia: "@plumforestfarm (instagram)",
          mapLinkLines: ["Website: www.handpickedhomestead.com"],
        }).map((link) => link.url),
      ).not.toContain("https://www.handpickedhomestead.com");
    });

    it("falls back to the map's links for a farm that submitted no form", () => {
      // The 4 map-only stands have no form row at all. Their links are the only ones that exist.
      expect(
        parseFarmLinks({
          mapLinkLines: [
            "Website: https://www.vigavashon.org/market",
            "Instagram: https://www.instagram.com/vashon_farmersmarket/",
          ],
        }),
      ).toEqual([
        { label: "Website", url: "https://www.vigavashon.org/market" },
        { label: "Instagram", url: "https://www.instagram.com/vashon_farmersmarket/" },
      ]);
    });
  });
});

describe("parsePaymentMethods", () => {
  // Payment methods exist ONLY in the map transcription — the profile form has no payment
  // question (verified against the real header, 2026-08-04). max chose to read them from the
  // map prose rather than leave the table empty at launch.

  it("reads the corpus's most common shape", () => {
    expect(parsePaymentMethods("Accepts Cash, Check, Venmo, VIGA Farm Bucks")).toEqual([
      "Cash", "Check", "Venmo",
    ]);
  });

  it("excludes VIGA Bucks, which is already its own column", () => {
    // `farm_bucks_accepted` and `parseFarmBucksPolicy` own this fact. Recording it here too
    // would state one thing in two places and let them disagree.
    expect(parsePaymentMethods("Accepts VIGA Farm Bucks")).toEqual([]);
    expect(parsePaymentMethods("Accepts VIGA Farm Bucks, cash, checks, and venmo")).toEqual([
      "Cash", "Check", "Venmo",
    ]);
    expect(parsePaymentMethods("Accepts: Cash, checks, and VIGA bucks")).toEqual([
      "Cash", "Check",
    ]);
  });

  it("normalizes spelling and case, so one method is one row", () => {
    // `sales_location_payment_methods_pk` is (location, method), so "Cash" and "cash" would
    // be two rows for one fact, and both would show on the card.
    expect(parsePaymentMethods("Accepts: Accepts cash, checks, Venmo and VIGA Farm Bucks")).toEqual(
      ["Cash", "Check", "Venmo"],
    );
    expect(parsePaymentMethods("Accepts accept cash, check, venmo, cashapp, VIGA bucks")).toEqual(
      ["Cash", "Check", "Venmo", "Cash App"],
    );
    expect(parsePaymentMethods("Accepts: Cash, Check, Venmo, Cash App, VIGA Farm Bucks.")).toEqual(
      ["Cash", "Check", "Venmo", "Cash App"],
    );
  });

  it("reads Zelle, which only two farms mention", () => {
    expect(parsePaymentMethods("Accepts: Venmo, Zelle, Cash and VIGA Farm Bucks")).toEqual([
      "Venmo", "Zelle", "Cash",
    ]);
    expect(parsePaymentMethods("Accepts Cash, Check, Zelle, Venmo, VIGA Farm Bucks")).toEqual([
      "Cash", "Check", "Zelle", "Venmo",
    ]);
  });

  it("returns nothing for a line that names no method it understands", () => {
    // "Accepts VIGA Alternative Currencies" (the farmers market) names no ordinary method.
    // An empty list is honest; inventing "Cash" because most stands take it is not.
    expect(parsePaymentMethods("Accepts VIGA Alternative Currencies")).toEqual([]);
    expect(parsePaymentMethods("Open: Year Round")).toEqual([]);
    expect(parsePaymentMethods("")).toEqual([]);
  });

  it("ignores an unlisted method rather than storing prose as a method", () => {
    // "Prepay available through our website" is a sentence, not a payment method. Storing it
    // would print a sentence in a chip on the card.
    expect(
      parsePaymentMethods(
        "Accepts Cash, Check, Venmo, Prepay available through our website, VIGA Farm Bucks",
      ),
    ).toEqual(["Cash", "Check", "Venmo"]);
  });

  it("never returns a duplicate, so the primary key holds", () => {
    expect(parsePaymentMethods("Accepts cash, Cash, CASH and cash")).toEqual(["Cash"]);
  });
});
