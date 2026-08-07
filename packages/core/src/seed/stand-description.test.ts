import { describe, expect, it } from "vitest";
import { buildStandDescription, refusesPublicAddress } from "./stand-description";

// F-061 — the public description, rebuilt from the profile form's own columns.
//
// THE DEFECT THIS REPLACES was one line in the seeder:
//
//   const publicDescription = mapDescription || [ ...form fields... ].join("\n");
//
// Whenever a map row existed (27 of 35 stands) the transcription's prose won and the form's
// clean columns were discarded FOR DISPLAY while still being parsed for structured fields. That
// is what put "Hours not listed" beside prose reading "Open: Year Round" — the badge read the
// (empty) structured column, the prose came from the map. Two statements, one card.
//
// So the description now carries only what NO structured column already holds. Hours, season,
// stocking, links, payments, and Farm Bucks each have their own home and their own renderer; a
// description that repeats them is how the two get to disagree.

describe("buildStandDescription", () => {
  describe("the farm's own voice is preserved", () => {
    it("keeps the general information and extra notes a farmer wrote", () => {
      // The audit disconfirmed "the description is mostly duplication". The remainder is real
      // content — a land acknowledgement, WSDA licensing, "we place a sign at the bottom of the
      // driveway" — and deriving it away would delete the farm's voice from the map.
      expect(
        buildStandDescription({
          generalInformation: "Certified organic vegetables, cut flowers, and pastured eggs.",
          extraNotes: "We place a sign at the bottom of the driveway when the stand is open.",
        }),
      ).toBe(
        "Certified organic vegetables, cut flowers, and pastured eggs.\n" +
          "We place a sign at the bottom of the driveway when the stand is open.",
      );
    });

    it("returns nothing when the farm wrote no prose of its own", () => {
      // An empty description is honest. The card still shows hours, season, and links from
      // their own columns; inventing a sentence to fill the space would be writing for a farm.
      expect(buildStandDescription({})).toBeUndefined();
      expect(buildStandDescription({ generalInformation: "   " })).toBeUndefined();
    });
  });

  describe("facts that have their own column never appear in the prose", () => {
    it("drops a line that only restates the hours", () => {
      // `Open Hours & Days` is its own column for 29 of 31 farms and renders as its own field.
      // Repeating it here is what produced the on-screen contradiction.
      expect(
        buildStandDescription({
          generalInformation: "Open: Year Round\nDaily 9am - 6pm\nEggs, honey, and jam.",
          openHoursText: "Daily 9am - 6pm",
          openSeasonText: "Year Round",
        }),
      ).toBe("Eggs, honey, and jam.");
    });

    it("drops a line that only restates a link, which farm_links now holds", () => {
      expect(
        buildStandDescription({
          generalInformation: "Website: www.example.com\nInstagram: @example\nLamb and wool.",
          website: "www.example.com",
          socialMedia: "@example",
        }),
      ).toBe("Lamb and wool.");
    });

    it("drops an 'Accepts …' line, which payment methods now hold", () => {
      expect(
        buildStandDescription({
          generalInformation: "Accepts Cash, Check, Venmo, VIGA Farm Bucks\nPlant starts.",
        }),
      ).toBe("Plant starts.");
    });

    it("drops a dated stock update, which is a confirmation and not a description", () => {
      // "5/26/2026 Update: salad, kale" already has a consumer in `extractStockUpdate`. Left in
      // the prose it printed a date directly beneath the card's "Nothing confirmed recently".
      expect(
        buildStandDescription({
          generalInformation: "5/26/2026 Update: salad, kale\nA small no-spray garden stand.",
        }),
      ).toBe("A small no-spray garden stand.");
    });

    it("keeps a sentence that MENTIONS a structured fact while saying more", () => {
      // The rule is "this line adds nothing", not "this line contains the word hours". A
      // sentence carrying real information survives even when it names a structured fact.
      expect(
        buildStandDescription({
          generalInformation:
            "We are open year round, but the greenhouse closes in January for repairs.",
          openSeasonText: "Year Round",
        }),
      ).toBe("We are open year round, but the greenhouse closes in January for repairs.");
    });
  });

  describe("a stand with no form row still gets a description", () => {
    it("falls back to the map prose for a map-only farm", () => {
      // 4 of 35 stands submitted no form at all. The transcription is the ONLY text they have,
      // so retiring `mapDescription ||` must not leave them blank.
      expect(
        buildStandDescription({
          mapDescription:
            "Specializes in organic heirloom herbs, berries, roots and vegetables.\n" +
            "Open only by appointment",
        }),
      ).toBe(
        "Specializes in organic heirloom herbs, berries, roots and vegetables.\n" +
          "Open only by appointment",
      );
    });

    it("still strips structured lines out of the map prose", () => {
      expect(
        buildStandDescription({
          mapDescription:
            "Website: https://example.org\nAccepts Cash, Check, Venmo\nEggs and vegetables.",
        }),
      ).toBe("Eggs and vegetables.");
    });

    it("drops a dated update written with a TWO-digit year", () => {
      // Alta Rosa's real row reads "7/9/25 update: Has Silvan berries, salad mix, eggs." — the
      // sheet is hand-typed, so the year is written both ways. A four-digit-only pattern left
      // this one dated line printing beneath the card's own "Nothing confirmed recently", which
      // is the exact contradiction F-061 exists to remove.
      expect(
        buildStandDescription({
          mapDescription: "7/9/25 update: Has Silvan berries, salad mix, eggs.\nA small stand.",
        }),
      ).toBe("A small stand.");
    });

    it("drops the leading contact name and bare address the transcription opens with", () => {
      // Real map rows begin with the farmer's name and street address as their own lines —
      // "Milo" / "12919 SW Cemetery Rd", "Sarah Herridge" / "15324 Vermontville Road SW".
      // The address has its own column and renders as a destination link; the name is a person,
      // not a description, and printing it reads as though the stand is called that.
      expect(
        buildStandDescription({
          mapDescription: "Milo\n12919 SW Cemetery Rd\nFlowers and plant starts.",
        }),
      ).toBe("Flowers and plant starts.");
      expect(
        buildStandDescription({
          mapDescription:
            "Lisa and Chris Hasselman\n10515 SW 140th St, Vashon, WA 98070\nVegetables, eggs",
        }),
      ).toBe("Vegetables, eggs");
    });

    it("drops a sentinel non-answer the transcription copied verbatim", () => {
      // Vashon Garlic's row carries a line reading "Nope!" — a farmer's answer to some question,
      // transcribed as description text. It is not a description of anything.
      expect(
        buildStandDescription({ mapDescription: "Fresh Flowers\nNope!" }),
      ).toBe("Fresh Flowers");
    });

    it("never prints the same line twice", () => {
      // Forest Garden Farm's row states "WSDA and Real Organic Certified" twice.
      expect(
        buildStandDescription({
          mapDescription: "WSDA and Real Organic Certified\nEggs\nWSDA and Real Organic Certified",
        }),
      ).toBe("WSDA and Real Organic Certified\nEggs");
    });

    it("prefers the farmer's own words when BOTH sources exist", () => {
      // The whole point of F-061. The map prose is a hand-typed derivative; the form is the
      // farm speaking for itself.
      expect(
        buildStandDescription({
          generalInformation: "Cut flowers and dahlia tubers.",
          mapDescription: "Flowers. WA, WA 98070",
        }),
      ).toBe("Cut flowers and dahlia tubers.");
    });
  });

  // Measured against the REAL production corpus on 2026-08-07 — all 34 farms carrying a
  // description, read from `neondb`. The existing rules removed 53% of the text and left 26
  // lines that are still pure restatement. Every fixture below is a real line, copied verbatim,
  // because these labels were invisible to fixtures invented from the doc's description.
  describe("labels the first pass missed, measured on the real corpus", () => {
    it("drops a 'Generally Offers:' line, which stand_items now holds", () => {
      // THE BIGGEST ONE — 13 of 34 farms. It duplicates the exact field the onboarding form
      // asks a farmer to fill in, so a farmer who types their items sees their own list AND
      // VIGA's older one on the same card, free to disagree. Tian Tian's live card shows
      // "Usually sells: gailan, bok choy, perilla, a choy" directly above prose repeating them.
      expect(
        buildStandDescription({
          mapDescription:
            "Generally Offers: Plant Starts, Vegetables, Fruits, Flowers and Baked Goods\n" +
            "A small roadside stand.",
        }),
      ).toBe("A small roadside stand.");
    });

    it("drops 'Generally Offers' however the sheet punctuated it", () => {
      // Hand-typed, so the separator is inconsistent across the corpus: a colon, a semicolon
      // (Sherman Creek), no colon at all (Useful Bear), and lowercase 'offers' (Littlest Bird,
      // Peach Tree Hill). Matching only "Generally Offers:" leaves four farms' lines printing.
      for (const line of [
        "Generally Offers: Fresh Cut Flowers",
        "Generally offers: Year round eggs, frozen lamb and pork.",
        "Generally Offers; Fresh flowers and eggs",
        "Generally Offers:Advice and services for invasive plant control",
        "Generally offers Vegetables, fruit, flowers as well as jam, jelly and syrups",
      ]) {
        expect(buildStandDescription({ mapDescription: `${line}\nEggs.` })).toBe("Eggs.");
      }
    });

    it("drops a 'Hosting' line, with or without its colon", () => {
      // 7 farms. Who else sells at this stand is a real fact and a genuinely useful one, but it
      // is a LIST OF OTHER FARMS pasted into one farm's prose — it belongs in a field of its
      // own, not in the farm's voice. Until it has one, printing it here attributes another
      // farm's goods to this listing with no way to keep the two in step.
      expect(
        buildStandDescription({
          mapDescription: "Hosting: Fernhorn Bakery, Vashon Island Honey Co.\nPlant starts.",
        }),
      ).toBe("Plant starts.");
      expect(
        buildStandDescription({ mapDescription: "Hosting Fern Horn Bakery\nPlant starts." }),
      ).toBe("Plant starts.");
      // Forest Garden Farm's row carries the bare label with nothing after it.
      expect(buildStandDescription({ mapDescription: "Hosting:\nPlant starts." })).toBe(
        "Plant starts.",
      );
    });

    it("drops the dated-update spellings the first pattern missed", () => {
      // Plum Forest writes "4/21/2026: Update:" — a colon after the DATE as well as after the
      // word, which the anchored pattern refused. Northbourne writes "7/9/2025 No Update.",
      // which is a dated non-answer: still a confirmation line, still not a description.
      expect(
        buildStandDescription({
          mapDescription: "4/21/2026: Update: eggs, spinach, kale, pac choi\nA small stand.",
        }),
      ).toBe("A small stand.");
      expect(
        buildStandDescription({
          mapDescription: "7/9/2025 No Update. (generally has produce and berries.)\nEggs.",
        }),
      ).toBe("Eggs.");
    });

    it("drops a dated update whose MONTH is missing from the stored text", () => {
      // Found by the production dry run, not by reading: Venison Valley's row literally begins
      // "/22/2026 Update:" — the month is gone, lost upstream in whatever hand-editing produced
      // the sheet. The anchored pattern needs a leading month digit, so this one line survived
      // every rule and printed as prose beneath the card's own "Nothing confirmed recently".
      //
      // Matched by the SHAPE that remains — a slash-led partial date followed by "Update" —
      // rather than by repairing the date, which would be inventing a month nobody wrote.
      expect(
        buildStandDescription({ mapDescription: "/22/2026 Update:\nEggs and milk." }),
      ).toBe("Eggs and milk.");
    });

    it("does not mistake ordinary prose containing a slash for a dated update", () => {
      // The guard on the rule above. "open 9/5" or "salad w/ herbs" must survive — the pattern
      // earns its narrowness by requiring the word "update" after the partial date.
      expect(
        buildStandDescription({ mapDescription: "We are open Tue/Thu and sell salad w/ herbs." }),
      ).toBe("We are open Tue/Thu and sell salad w/ herbs.");
    });

    it("drops an 'Open …' line written without its colon", () => {
      // Green Ears and Plum Forest both write the hours as a bare "Open …" line. The labelled
      // form was covered; the unlabelled one printed beside "Hours not listed".
      expect(
        buildStandDescription({ mapDescription: "Open Thursday - Sunday / 9am - Dusk\nEggs." }),
      ).toBe("Eggs.");
      expect(
        buildStandDescription({ mapDescription: "Open year round, everyday 9am-8pm\nEggs." }),
      ).toBe("Eggs.");
    });

    it("KEEPS a sentence that opens with 'Open' and then says something real", () => {
      // The guard on all of the above. Breathing Meadows writes "Open only by appointment – We
      // have a place for learning about herbs how to use them for food and medicine" — the
      // opening words restate the hours, the rest is the only thing that farm says about itself.
      // A pattern that swallowed the whole line would delete a farm's entire voice.
      expect(
        buildStandDescription({
          mapDescription:
            "Open only by appointment – We have a place for learning about herbs how to " +
            "use them for food and medicine",
        }),
      ).toBe(
        "Open only by appointment – We have a place for learning about herbs how to " +
          "use them for food and medicine",
      );
    });

    it("KEEPS a labelled line WHOLE when it carries more than a list", () => {
      // THE CORRECTION THAT MEASUREMENT FORCED. A first attempt dropped every `Generally
      // Offers`/`Stocking Days`/`Hosting` line outright; re-measured against the real corpus it
      // emptied NINE farms rather than one, because for those farms every line is labelled —
      // and 10 lines across the corpus carry a tail no column holds.
      //
      // Tian Tian's line is half restatement ("Specializing in Asian vegetables, including
      // gailan, bok choy") and half real ("Not certified, but following organic practices").
      // Pacific Crest's stocking line ends "Best selection on those days by late afternoon".
      // No punctuation rule separates the halves, so the line survives whole and the FARMER
      // decides — deleting it here is the quieter failure this file exists to avoid.
      expect(
        buildStandDescription({
          mapDescription:
            "Generally Offers: Specializing in Asian vegetables, including gailan, bok choy, " +
            "perilla, a choy, and more. Not certified, but following organic practices.",
        }),
      ).toBe(
        "Generally Offers: Specializing in Asian vegetables, including gailan, bok choy, " +
          "perilla, a choy, and more. Not certified, but following organic practices.",
      );

      // Pacific Crest Farm, verbatim — the sentence break after the column's own answer.
      expect(
        buildStandDescription({
          mapDescription:
            "Stocking Days: Stocking daily. Harvest days are Tuesday and Friday. Best " +
            "selection on those days by late afternoon.",
        }),
      ).toBe(
        "Stocking Days: Stocking daily. Harvest days are Tuesday and Friday. Best " +
          "selection on those days by late afternoon.",
      );
    });

    it("keeps a SHORT labelled line that still carries a second sentence", () => {
      // ISOLATES THE SENTENCE-BREAK RULE. Both fixtures above are long enough that the length
      // check alone would keep them, so disabling the sentence-break branch left every test
      // green — a sabotage proved it. Flora Hill's real line is under the length limit and
      // survives ONLY because of the break: "Everyday" is the column, "Flavors change on
      // Friday" is not, and nothing else in the suite would notice it being deleted.
      expect(
        buildStandDescription({ mapDescription: "Stocking days: Everyday. Flavors change on Friday" }),
      ).toBe("Stocking days: Everyday. Flavors change on Friday");
    });

    it("still drops a SHORT labelled line that is only a list", () => {
      // The other side of the same rule — without this, "keep anything with a period" would
      // pass the test above while silently keeping every restatement in the corpus.
      expect(
        buildStandDescription({ mapDescription: "Stocking Days: generally daily\nEggs." }),
      ).toBe("Eggs.");
      expect(
        buildStandDescription({ mapDescription: "Hosting: Kareli Farm\nEggs." }),
      ).toBe("Eggs.");
    });

    it("returns nothing when EVERY line a farm has is structured", () => {
      // Twisting Tree Farm, verbatim. Every line it holds has a column of its own, so the
      // honest result is no description at all — the card still carries hours, stocking,
      // payments and its dated update from their own fields. Recorded as a deliberate outcome
      // rather than a surprise, because it is the one farm the cleanup empties completely.
      expect(
        buildStandDescription({
          mapDescription:
            "Milo\n12919 SW Cemetery Rd \nInstagram: @twistingtreefarm\n\n" +
            "Open: Summer 11am-6pm\n\nStocking Days: Open on weekends\n\n" +
            "6/30/2026 Update: Carrots, zucchini, potatoes, beets and birdhouse gourds\n \n" +
            "Accepts: Cash, checks, and VIGA bucks",
        }),
      ).toBeUndefined();
    });
  });
});

describe("refusesPublicAddress (B-024)", () => {
  // A farmer asked IN WRITING not to publish her address, and production published her home
  // with a map pin anyway. This is F-038's "pin that misdirects a customer" made worse: the
  // coordinate is CORRECT, it is someone's house, and she specifically asked us not to.
  //
  // The refusal is read from the farmer's own words, as a general rule. No farm is named in
  // code — a farmer who writes the same sentence next season is covered by the same mechanism.

  it("reads the real refusal in the corpus", () => {
    expect(
      refusesPublicAddress(
        "I don't have my own farmstand - please add me under Plum Forest's location, " +
          "do not add my address.",
      ),
    ).toBe(true);
  });

  it("reads the other ways a farmer might say it", () => {
    expect(refusesPublicAddress("Please do not publish my address.")).toBe(true);
    expect(refusesPublicAddress("Do not list my address on the map")).toBe(true);
    expect(refusesPublicAddress("please don't share my address")).toBe(true);
    expect(refusesPublicAddress("No address please - it's my home.")).toBe(true);
  });

  it("does not fire on ordinary prose that merely mentions an address", () => {
    // A false positive hides a real, visitable stand from the map — the opposite failure, and
    // just as bad for a farmer who wants customers.
    expect(refusesPublicAddress("Our address is easy to miss, look for the red sign.")).toBe(
      false,
    );
    expect(refusesPublicAddress("The address on the sign is 12345 Vashon Hwy.")).toBe(false);
    expect(refusesPublicAddress("Eggs, honey, and jam.")).toBe(false);
    expect(refusesPublicAddress("")).toBe(false);
  });

  it("does not fire on a refusal about something other than the address", () => {
    expect(refusesPublicAddress("Please do not publish my phone number.")).toBe(false);
    expect(refusesPublicAddress("Do not list my email.")).toBe(false);
  });
});
