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
