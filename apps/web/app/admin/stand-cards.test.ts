import type { AdminStandRow } from "@farm-friend/db";
import { describe, expect, it } from "vitest";
import { asStandCards } from "./stand-cards";

/*
  WHICH GROUP HOLDS WHICH FACT (max, 2026-08-17).

  The card promotes "Current items" and "Last confirmed" out of their section and into the
  profile's lead, so the sections that remain have to be coherent WITHOUT them. That makes the
  grouping a real contract rather than an arrangement: a section whose whole meaning was the
  two facts that left is a heading over leftovers, and a fact stated in two groups is the table
  the card stopped being.

  Asserted by VALUE — the label a group holds, not merely that some group exists — because a
  shape assertion passes just as happily when a fact lands in the wrong drawer.
*/

/** A stand with something in every field, so no group is empty by accident. */
const row: AdminStandRow = {
  standId: "stand-1",
  farmId: "farm-of-stand-1",
  name: "Plum Forest Farm Stand",
  farmName: "Plum Forest Farm",
  kind: "farm_stand",
  timezone: "America/Los_Angeles",
  visitability: "visitable",
  offeringType: "produce",
  publicAddress: "12345 Vashon Hwy SW",
  addressPublic: true,
  publicLatitude: 47.4473,
  publicLongitude: -122.459,
  hoursText: "Dawn to dusk, most days",
  seasonKind: "year_round",
  seasonStartMonth: null,
  seasonStartDay: null,
  seasonEndMonth: null,
  seasonEndDay: null,
  seasonNames: null,
  openHoursKind: "dawn_to_dusk",
  openFromMinutes: null,
  openUntilMinutes: null,
  openDays: [1, 4],
  stockingCadence: "a_few_times_a_week",
  stockingDays: [1, 4],
  isPublic: true,
  retired: false,
  retiredAt: null,
  retiredWithFarm: false,
  trashed: false,
  trashedWithFarm: false,
  farmBucksAccepted: true,
  approved: true,
  approvedAt: new Date("2026-05-01T00:00:00Z"),
  publishedAt: new Date("2026-08-16T23:02:11Z"),
  closureResult: null,
  closureKind: null,
  closureStartsOn: null,
  closureClosedThrough: null,
  usualOfferings: ["Eggs", "Flowers"],
  participantNames: ["Gracie's Greens"],
  currentItems: [
    { itemName: "Eggs", quantity: 2, unit: "dozen", priceText: "$8", approximation: null },
  ],
};

/** Every label the card would print, by the group it sits in. */
function grouped(stand: AdminStandRow): Map<string, string[]> {
  const [card] = asStandCards([stand]);
  if (card === undefined) throw new Error("no card");
  return new Map(card.sections.map((s) => [s.title, s.items.map(([label]) => label)]));
}

/** Every label the card would print, anywhere. */
function labels(stand: AdminStandRow): string[] {
  return [...grouped(stand).values()].flat();
}

describe("a stand card's groups", () => {
  it("keeps the two lead facts in the one section marked prominent", () => {
    const [card] = asStandCards([row]);
    const lead = card?.sections.filter((section) => section.prominent === true) ?? [];

    // Exactly one section leads. Two would leave the card's own lead picking between them.
    expect(lead).toHaveLength(1);
    expect(lead[0]?.items.map(([label]) => label)).toEqual(
      expect.arrayContaining(["Current items", "Last confirmed"]),
    );
  });

  it("states each fact once, so no group repeats another", () => {
    const printed = labels(row);

    expect(new Set(printed).size).toBe(printed.length);
  });

  it("does not list who sells here, which the card's own group already answers", () => {
    // "Also selling here" sits directly above these groups on an open card, with the controls
    // that change it. A second, read-only copy of the same names is the card disagreeing
    // with itself the moment an operator pauses someone.
    expect(labels(row)).not.toContain("Other sellers here");
  });

  it("leaves every group with something to say once the lead is taken", () => {
    const groups = grouped(row);

    for (const [title, items] of groups) {
      const remaining = items.filter(
        (label) => label !== "Current items" && label !== "Last confirmed",
      );
      expect(remaining, `${title} has nothing left once the lead is promoted`).not.toHaveLength(0);
    }
  });

  it("files the stand's own settings apart from the farmer's stated hours", () => {
    const groups = grouped(row);

    // What the farmer SAYS about when she is open, versus what VIGA recorded about the stand.
    expect(groups.get("Hours & season")).toContain("Farmer's note about hours");
    expect(groups.get("Hours & season")).toContain("Season");
    expect(groups.get("Visit & listing")).toContain("Address");
  });

  it("puts the Farm Bucks decision where its verb is, not in a drawer of leftovers", () => {
    // The card's menu changes Farm Bucks, so the fact belongs with the stand's own settings
    // rather than under a heading that means "everything else".
    expect(labels(row)).toContain("Farm Bucks");
    expect([...grouped(row).keys()]).not.toContain("Other details");
  });
});
