import { describe, expect, it } from "vitest";
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
      farmBucksAccepted: true,
      farmBucksEligible: true,
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
    ).toMatchObject({
      farmBucksAccepted: false,
      farmBucksEligible: true,
    });
  });
});
