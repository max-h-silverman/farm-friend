// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { creditSeller, type CreditableListing } from "@farm-friend/core";
import { describeFarmerTarget } from "./farmer-targeting";
import { ReminderSchedules } from "../app/stand/[token]/reminder-schedules";
import { SettingsForm } from "../app/stand/[token]/settings/settings-form";

/*
  F-115 Tranche C — ONE LISTING IS LABELLED ONE WAY.

  `creditSeller` owns the rule and had no production caller: five surfaces decided it
  independently, and the last two were character-identical `listingLabel` copies whose comments
  each claimed an ownership the code did not have — *"so one listing cannot be labelled three
  ways"*, written in the third copy.

  They agreed by habit. Nothing compared them, so nothing would have caught a divergence, and
  the copies are exactly the drift `seller-credit.ts` was extracted to prevent.

  **This file compares the SURFACES, not the helper.** `seller-credit.test.ts` proves the rule;
  a second unit test of the same function proves nothing about whether the SMS menu reaches it.
  So these cases run the real SMS renderer and mount the real React rows.

  **The separator difference is deliberate and stays.** SMS is GSM-7 and one em-dash re-encodes
  the whole body to UCS-2, halving segment capacity; the web has no such constraint. What must
  not differ between channels is WHICH listings get a name, and that is what is asserted here.
*/

const STAND = "Kelseys Stand";

const HOSTED: CreditableListing = {
  locationName: STAND,
  sellerName: "Gracies Greens",
  describesOwnStand: false,
};

const OWN: CreditableListing = {
  locationName: STAND,
  sellerName: "Kelseys Farm",
  describesOwnStand: true,
};

/** The two listings at one stand — the only shape where either screen labels its rows. */
const ROWS = [OWN, HOSTED].map((listing, index) => ({
  providerId: `p${index}`,
  salesLocationId: "s1",
  locationName: listing.locationName,
  sellerName: listing.sellerName,
  describesOwnStand: listing.describesOwnStand,
  selected: index === 0,
  cadence: "weekly" as const,
}));

function smsLabel(listing: CreditableListing): string {
  return describeFarmerTarget({
    providerId: "p",
    salesLocationId: "s1",
    authorizationId: "a1",
    sellerId: "seller",
    locationName: listing.locationName,
    sellerName: listing.sellerName,
    describesOwnStand: listing.describesOwnStand,
    paused: false,
  });
}

describe("one listing, one label, across the surfaces that name it", () => {
  it("labels the reminder rows exactly as creditSeller does", () => {
    render(<ReminderSchedules token="t" listings={ROWS} />);
    expect(
      screen.getAllByRole("heading", { level: 4 }).map((node) => node.textContent),
    ).toEqual([creditSeller(OWN, " — "), creditSeller(HOSTED, " — ")]);
  });

  it("labels the settings choices exactly as creditSeller does", () => {
    render(<SettingsForm token="t" listings={ROWS} />);
    // The hosted row is credited and the stand's own row is not — asserted as two claims,
    // because a renderer that credited everything would satisfy only the first.
    expect(screen.getByLabelText(creditSeller(HOSTED, " — "))).toBeDefined();
    expect(screen.getByLabelText(STAND)).toBeDefined();
  });

  it("names a hosted seller on the SMS menu too, with the GSM-7 separator", () => {
    expect(smsLabel(HOSTED)).toBe(creditSeller(HOSTED, " - "));
    // Asserted on the VALUE as well as the agreement, so a pair agreeing on the wrong answer
    // would still fail.
    expect(smsLabel(HOSTED)).toBe("Kelseys Stand - Gracies Greens");
  });

  it("leaves the stand's own listing bare on every surface", () => {
    // The absence is the claim: a renderer emitting a bare separator would still satisfy an
    // equality against the stand name alone if the seller name were empty.
    expect(smsLabel(OWN)).toBe(STAND);
    expect(smsLabel(OWN)).not.toContain("Kelseys Farm");
    expect(creditSeller(OWN, " — ")).toBe(STAND);
  });

  it("keeps the two separators apart", () => {
    // The one difference that is allowed to exist, pinned so a future tidy-up that unifies
    // them cannot silently double the cost of every farmer menu message.
    expect(creditSeller(HOSTED, " - ")).toBe("Kelseys Stand - Gracies Greens");
    expect(creditSeller(HOSTED, " — ")).toBe("Kelseys Stand — Gracies Greens");
  });
});
