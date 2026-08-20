import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { publicListingDetails } from "./public-listing-details";

describe("public listing source details", () => {
  it("keeps public links and prose while stripping direct contact details", () => {
    expect(
      publicListingDetails({
        standName: "Peak Moon Nursery",
        sourceText:
          "Email: grower@example.com\nPhone: 206-555-1212\nInstagram: instagram.com/peak_moon_nursery\nAccepts VIGA Farm Bucks",
      }),
    ).toEqual({
      description:
        "Instagram: instagram.com/peak_moon_nursery\nAccepts VIGA Farm Bucks",
      // F-125 — acceptance alone. `toEqual` is exact, so this also proves no eligibility
      // field survives beside it.
      farmBucksAccepted: true,
    });
  });

  it("does not turn missing payment policy into refusal", () => {
    expect(
      publicListingDetails({
        standName: "A stand",
        sourceText: "Open seasonally\nCash and Venmo",
      }),
    ).toEqual({ description: "Open seasonally\nCash and Venmo" });
  });

  it("reads the VIGA payment annotation when it is attached to the source name", () => {
    expect(
      publicListingDetails({
        standName: "Sweet Alyssum Farm *does not accept VIGA Bucks*",
        sourceText: "Fresh cut flowers",
      }),
    ).toEqual({
      description: "Fresh cut flowers",
      // F-125 — a reviewed REFUSAL still reads as a refusal. `toEqual` rather than
      // `toMatchObject`: the loose form would pass even if an eligibility field came back.
      farmBucksAccepted: false,
    });
  });

  it("keeps the farmers market's reviewed May-through-September schedule in source data", () => {
    const source = JSON.parse(
      readFileSync(resolve(process.cwd(), "maps/offerings-proposals.json"), "utf8"),
    ) as { standName: string; sourceText: string }[];
    const market = source.find((entry) => entry.standName === "Vashon Island Farmers Market");

    expect(market).toBeDefined();
    expect(market!.sourceText).toContain("Saturdays 10am - 2pm");
    expect(market!.sourceText).toContain("Early May - September 30");
    expect(market!.sourceText).not.toMatch(/October/);
  });
});
