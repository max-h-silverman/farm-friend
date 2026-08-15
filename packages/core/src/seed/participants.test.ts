import { describe, expect, it } from "vitest";
import { parseHostedParticipants } from "./participants";

// F-064 — host sellers stated in VIGA's records.
//
// A stand often hosts other sellers: a bakery, a neighbour's eggs, another grower's flowers.
// The public card already renders an "Also selling here" section and the admin table an "Other
// sellers here" row, but `sales_location_participants` seeded empty, so both were dead. The map
// states these as prose ("Hosting: Kareli Farm") and the weekly form asks it as its own column.
//
// These become `source = 'viga'` rows carrying no authorization: VIGA's records are not a
// farmer's confirmation, and the database CHECK enforces that split.
//
// Every fixture below is a REAL 2026 string from one of the two exports (measured 2026-08-07).

describe("parseHostedParticipants", () => {
  it("reads a single hosted farm from the map's prose", () => {
    expect(parseHostedParticipants("Hosting: Kareli Farm")).toEqual(["Kareli Farm"]);
  });

  it("reads a comma list, including the trailing 'and' the farmers write", () => {
    expect(
      parseHostedParticipants("Bay Laurel Farm, Kings Arms Farm, and Bywater Flower Farm"),
    ).toEqual(["Bay Laurel Farm", "Kings Arms Farm", "Bywater Flower Farm"]);
  });

  it("reads the label written without its colon", () => {
    // Two of the seven real map lines omit it: "Hosting Glass on Vashon".
    expect(parseHostedParticipants("Hosting Glass on Vashon")).toEqual(["Glass on Vashon"]);
  });

  it("keeps a name containing a period, which is not a sentence break", () => {
    expect(parseHostedParticipants("Hosting: Fernhorn Bakery, Vashon Island Honey Co.")).toEqual([
      "Fernhorn Bakery",
      "Vashon Island Honey Co.",
    ]);
  });

  it("keeps the farmer's own curly apostrophe in a display name", () => {
    // Stored verbatim: this is public display text the farmer chose, not a match key.
    expect(parseHostedParticipants("King’s Arms Farm, Faith’s Eggs")).toEqual([
      "King’s Arms Farm",
      "Faith’s Eggs",
    ]);
  });

  describe("what is NOT a hosted farm", () => {
    it("reads a bare label with nothing after it as no sellers", () => {
      // A real map line is exactly "Hosting:" — the volunteer left it blank. Publishing an
      // empty-string participant would render a blank bullet under "Also selling here".
      expect(parseHostedParticipants("Hosting:")).toEqual([]);
    });

    it("reads the form's non-answers as no sellers", () => {
      // "No" and "N/A" answer the question rather than name a seller. Published verbatim they
      // would put a farm called "No" on a customer's card.
      expect(parseHostedParticipants("No")).toEqual([]);
      expect(parseHostedParticipants("no")).toEqual([]);
      expect(parseHostedParticipants("N/A")).toEqual([]);
      expect(parseHostedParticipants("")).toEqual([]);
      expect(parseHostedParticipants("none")).toEqual([]);
    });

    it("refuses prose that describes sellers without naming one", () => {
      // Bart's Cart's real answer. There is no name here to publish, and splitting it on commas
      // would invent sellers called "These are usually interesting flowering perennials".
      expect(
        parseHostedParticipants(
          "A second growers plants are being introduced weekly. These are usually interesting flowering perennials",
        ),
      ).toEqual([]);
    });

    it("drops a URL glued to a name, keeping the name", () => {
      // "Rainy Day Bakes :  www.instagram.com/rainydaybakesvashon/" — a link is not a seller
      // name, and the card has its own place for links.
      expect(
        parseHostedParticipants("Rainy Day Bakes :  www.instagram.com/rainydaybakesvashon/"),
      ).toEqual(["Rainy Day Bakes"]);
    });

    it("keeps a parenthetical qualifier out of the name", () => {
      // "Handpicked Homestead (flowers)" — the farm is the seller; what they sell is not part
      // of what they are called.
      expect(parseHostedParticipants("Handpicked Homestead (flowers)")).toEqual([
        "Handpicked Homestead",
      ]);
    });

    it("does not treat a long prose clause as a name", () => {
      // A guard against the general shape rather than one corpus string: a seller name is
      // short. This keeps an unforeseen sentence out of the public card.
      expect(
        parseHostedParticipants(
          "We sometimes have a neighbour bring eggs down on the weekend when they have extra",
        ),
      ).toEqual([]);
    });
  });

  it("collapses duplicates a farmer stated twice, keeping the first spelling", () => {
    expect(parseHostedParticipants("Fernhorn Bakery, fernhorn bakery")).toEqual([
      "Fernhorn Bakery",
    ]);
  });
});
