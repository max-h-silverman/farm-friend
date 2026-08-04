// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StandMap } from "../app/stand-map";
import type { PublicStandPayload } from "./map-view";

afterEach(cleanup);

describe("public participant names", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("shows active names as plain text on both the card and mobile detail sheet", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "shared-stand",
      farmName: "Host Farm",
      locationName: "Shared Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "50 Participant Way",
      latitude: 47.44,
      longitude: -122.46,
      updated: "updated 1 hour ago",
      confirmedElapsed: "1 hour ago",
      stale: false,
      availability: {},
      alsoSellingHere: ["Guest Growers", "Island Apiary"],
      items: [{ itemName: "Kale" }],
    };

    render(<StandMap stands={[stand]} />);

    const card = screen.getByRole("heading", { name: "Shared Stand" }).closest("li")!;
    expect(within(card).queryByText("Also selling here")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Shared Stand" }));
    expect(within(card).getByText("Also selling here")).toBeTruthy();
    expect(within(card).getByText("Guest Growers").closest("a")).toBeNull();
    expect(within(card).getByText("Island Apiary").closest("a")).toBeNull();
    expect(within(card).getByText("Kale").closest(".items")).not.toContainElement(
      within(card).getByText("Guest Growers"),
    );
    await user.click(screen.getByRole("button", { name: "Shared Stand" }));

    await user.click(
      screen.getByRole("button", { name: "1. Shared Stand, Host Farm" }),
    );
    const sheet = screen.getByRole("dialog", { name: "Shared Stand details" });
    expect(within(sheet).getByText("Also selling here")).toBeTruthy();
    expect(within(sheet).getByText("Guest Growers").closest("a")).toBeNull();
    expect(within(sheet).getByText("Island Apiary").closest("a")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "1. Shared Stand, Host Farm" }),
    );
    expect(screen.queryByRole("dialog", { name: "Shared Stand details" })).toBeNull();
  });
});

describe("farm-map poster treatment", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("explains the interactive map's inventory recency and availability limits", () => {
    render(<StandMap stands={[]} />);

    expect(screen.getByText(
      "Note: This map may contain recent inventory updates, but neither VIGA nor individual farms can guarantee product availability.",
    )).toHaveClass("map-note");
  });

  it("shows the save-contact action with a decorative add-contact icon", () => {
    render(<StandMap stands={[]} />);

    const link = screen.getByRole("link", { name: "Save Farm Friend Contact" });
    expect(link.querySelector(".contact-card-icon")).toHaveAttribute("aria-hidden", "true");
    expect(link.closest("footer")).toHaveClass("contact-card-footer");
  });

  it("carries the VIGA Farm Map mark and explains the poster-status dots in words", () => {
    const stand: PublicStandPayload = {
      id: "year-round-stand",
      farmName: "Evergreen Farm",
      locationName: "Evergreen Farm Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "1 Orchard Way",
      latitude: 47.44,
      longitude: -122.46,
      farmBucksAccepted: false,
      availability: {
        season: { kind: "year_round" },
      },
      alsoSellingHere: [],
      items: [],
    };

    render(<StandMap stands={[stand]} />);

    expect(screen.getByAltText("VIGA Farm Map")).toBeTruthy();
    expect(screen.getByAltText("Vashon Island Growers Association")).toBeTruthy();
    // Scoped to the DIRECTORY key. "Year-round" is also a map-legend entry, and an unscoped
    // text query would pass on either one — including if this key disappeared entirely.
    const directoryKey = screen.getByLabelText("Farm map key");
    expect(within(directoryKey).getAllByText("Doesn't take VIGA Bucks")).toHaveLength(1);
    expect(within(directoryKey).getAllByText("Year-round")).toHaveLength(1);
    expect(within(directoryKey).getAllByText("Thru late November")).toHaveLength(1);

    const card = screen.getByRole("heading", { name: "Evergreen Farm Stand" }).closest("li")!;
    expect(within(card).queryByText("Doesn't take VIGA Bucks")).toBeNull();
    expect(within(card).queryByText("Year-round")).toBeNull();
    expect(card.querySelectorAll(".poster-dot")).toHaveLength(2);
    expect(within(card).getByText("1)", { exact: true })).toBeTruthy();
    expect(
      card.querySelector(".poster-indicators")!.compareDocumentPosition(
        card.querySelector("h2")!,
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(card.querySelector(".poster-indicators")!.parentElement).toBe(card);
    expect(card.querySelector(".stand-content")!.parentElement).toBe(card);
  });

  it("shows the public source description and links when a stand is expanded", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "details-stand",
      farmName: "Peak Moon Nursery",
      locationName: "Peak Moon Nursery",
      visitability: "visitable",
      offeringType: "produce",
      address: "300’ north of 28815 Vashon Hwy SW",
      latitude: 47.44,
      longitude: -122.46,
      description:
        "Facebook: www.facebook.com/people/Peak-Moon-Nursery\n" +
        "Instagram: instagram.com/peak_moon_nursery\n" +
        "Stocking Days: Every few days as stock runs low\n" +
        "At Peak Moon, we share diversity in our crops.",
      availability: {},
      alsoSellingHere: [],
      items: [],
    };

    render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "1. Peak Moon Nursery, Peak Moon Nursery" }));

    const card = document.querySelector(".stands .stand") as HTMLElement;
    expect(within(card).getByText("Additional information")).toBeTruthy();
    expect(within(card).getByText(/Stocking Days: Every few days/)).toBeTruthy();
    expect(within(card).getByRole("link", { name: "www.facebook.com/people/Peak-Moon-Nursery" })).toHaveAttribute(
      "href",
      "https://www.facebook.com/people/Peak-Moon-Nursery",
    );
    expect(within(card).getByRole("link", { name: "instagram.com/peak_moon_nursery" })).toHaveAttribute(
      "href",
      "https://instagram.com/peak_moon_nursery",
    );
  });

  it("keeps the full marker key available behind a compact phone disclosure", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={[]} />);

    const disclosure = screen.getByText("Map key").closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    await user.click(screen.getByText("Map key"));
    expect(disclosure).toHaveAttribute("open");
    const legend = screen.getByRole("list", { name: "Map marker key" });
    const island = container.querySelector("figure.island");
    expect(legend.closest("figure")).toBe(island);
    expect(within(legend).getByText("Seasonal")).toBeTruthy();
    expect(within(legend).getByText("Year-round")).toBeTruthy();
    expect(within(legend).getByText("Flowers-only")).toBeTruthy();
    expect(within(legend).getByText("Farm, no stand")).toBeTruthy();
    expect(within(legend).getByText("VIGA Farmers Market")).toBeTruthy();
  });

  it("renders the flower marker as a flower glyph rather than a regular pin", () => {
    const stand: PublicStandPayload = {
      id: "flower-stand",
      farmName: "Flower Farm",
      locationName: "Flower Farm Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "1 Flower Way",
      latitude: 47.44,
      longitude: -122.46,
      farmBucksAccepted: false,
      availability: {},
      usuallySells: ["fresh flowers", "lavender"],
      alsoSellingHere: [],
      items: [],
    };

    render(<StandMap stands={[stand]} />);

    const marker = screen.getByRole("button", { name: "1. Flower Farm Stand, Flower Farm" });
    expect(marker).toHaveClass("pin-flower-only");
    expect(marker.querySelector(".pin-flower-glyph")).toBeTruthy();
    expect(marker.querySelector(".pin-shape")).toBeNull();
  });

  it("lists stands in ascending poster-number order by default", () => {
    const stands: PublicStandPayload[] = [
      {
        id: "cedar",
        farmName: "Cedar Farm",
        locationName: "Cedar Stand",
        visitability: "visitable",
        offeringType: "produce",
        address: "3 Cedar Way",
        latitude: 47.44,
        longitude: -122.46,
        availability: {},
        alsoSellingHere: [],
        items: [],
      },
      {
        id: "apple",
        farmName: "Apple Farm",
        locationName: "Apple Stand",
        visitability: "visitable",
        offeringType: "produce",
        address: "1 Apple Way",
        latitude: 47.45,
        longitude: -122.46,
        availability: {},
        alsoSellingHere: [],
        items: [],
      },
      {
        id: "birch",
        farmName: "Birch Farm",
        locationName: "Birch Stand",
        visitability: "visitable",
        offeringType: "produce",
        address: "2 Birch Way",
        latitude: 47.46,
        longitude: -122.46,
        availability: {},
        alsoSellingHere: [],
        items: [],
      },
    ];

    const { container } = render(<StandMap stands={stands} />);
    expect([...container.querySelectorAll(".stands h2")].map((heading) => heading.textContent)).toEqual([
      "Apple Stand",
      "Birch Stand",
      "Cedar Stand",
    ]);
  });

  it("places the indicator legend above the stand listings", () => {
    const stand: PublicStandPayload = {
      id: "legend-position-stand",
      farmName: "Evergreen Farm",
      locationName: "Evergreen Farm Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "1 Orchard Way",
      latitude: 47.44,
      longitude: -122.46,
      availability: {},
      alsoSellingHere: [],
      items: [],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    const legend = screen.getByLabelText("Farm map key");
    const listColumn = container.querySelector(".list-column");
    const stands = container.querySelector(".stands");

    expect(legend.parentElement).toBe(listColumn);
    expect(legend.compareDocumentPosition(stands!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("uses the VIGA marker language and highlights the selected icon", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "market-stand",
      farmName: "Vashon Farmers Market",
      locationName: "Vashon Farmers Market",
      locationKind: "farmers_market",
      visitability: "visitable",
      offeringType: "produce",
      address: "1 Market Way",
      latitude: 47.44,
      longitude: -122.46,
      description:
        "Saturdays, 10am–2pm\nEarly May through the end of September\n" +
        "Website: https://www.vigavashon.org/market",
      availability: {
        season: { kind: "date_range", startMonth: 5, startDay: 1, endMonth: 9, endDay: 30 },
        hours: { kind: "clock_range", fromMinutes: 600, untilMinutes: 840 },
        days: [6],
      },
      alsoSellingHere: [],
      items: [],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    const marker = screen.getByRole("button", {
      name: "1. Vashon Farmers Market, Vashon Farmers Market",
    });

    expect(marker).toHaveClass("pin-farmers-market");
    expect(marker.querySelector(".pin-market-shape")).toBeTruthy();
    expect(marker).toHaveAttribute("aria-pressed", "false");

    await user.click(marker);

    expect(marker).toHaveAttribute("aria-pressed", "true");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "instant",
    });
    expect(marker.querySelector(".pin-selection-halo")).toBeTruthy();
    expect(container.querySelector(".pin-label-layer text")).toHaveTextContent(
      "Vashon Farmers Market",
    );

    const pinLayer = container.querySelector(".pin-layer")!;
    const labelLayer = container.querySelector(".pin-label-layer")!;
    expect(pinLayer.compareDocumentPosition(labelLayer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    const card = container.querySelector(".stands .stand") as HTMLElement;
    expect(within(card).getByText("Market schedule and information")).toBeTruthy();
    expect(within(card).getByText(/Early May through the end of September/)).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Website" })).toHaveAttribute(
      "href",
      "https://www.vigavashon.org/market",
    );
    expect(within(card).getByRole("link", { name: "Directions to market" })).toBeTruthy();
    expect(within(card).queryByText(/No listing yet|this stand hasn’t been updated/)).toBeNull();
    expect(within(card).queryByText("Plan your visit")).toBeNull();
    expect(card.querySelector(".detail-inventory")).toBeNull();
    expect(card.querySelector(".farm")).toBeNull();
    expect(card.querySelector(".stand-detail-body")?.firstElementChild).toHaveClass(
      "detail-actions",
    );
  });

  it("keeps the directory compact until its own entry is selected", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "compact-stand",
      farmName: "Compact Farm",
      locationName: "Compact Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "1 Orchard Way",
      latitude: 47.44,
      longitude: -122.46,
      availability: {},
      alsoSellingHere: [],
      items: [{ itemName: "Carrots" }],
    };

    render(<StandMap stands={[stand]} />);

    const toggle = screen.getByRole("button", { name: "Compact Stand" });
    const card = toggle.closest("li")!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(card);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows destination basics in every directory record and defers the rest until selection", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "scannable-stand",
      farmName: "Scannable Farm",
      locationName: "Scannable Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "34 Orchard Road",
      latitude: 47.44,
      longitude: -122.46,
      description: "Website: https://scannable.example\nOpen every Saturday.",
      updated: "updated 1 hour ago",
      confirmedElapsed: "1 hour ago",
      stale: false,
      availability: {},
      alsoSellingHere: [],
      items: [{ itemName: "Carrots" }],
    };

    render(<StandMap stands={[stand]} />);

    const record = screen.getByRole("heading", { name: "Scannable Stand" }).closest("li")!;
    expect(within(record).getByText("34 Orchard Road")).toHaveClass("stand-summary-address");
    // The website belongs to the expanded detail, not the collapsed row. A directory scanned by
    // eye wants the fewest lines that identify a stand; the link is one tap away and was
    // rendered TWICE while it sat here, since the detail body carries its own.
    expect(within(record).queryByRole("link", { name: "Website" })).toBeNull();
    expect(within(record).queryByText("Carrots")).toBeNull();
    expect(within(record).queryByText("Open every Saturday.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Scannable Stand" }));

    expect(within(record).getByText("Carrots")).toBeTruthy();
    expect(within(record).getByText("Open every Saturday.")).toBeTruthy();
    expect(within(record).getAllByText("34 Orchard Road")).toHaveLength(1);
    expect(within(record).getAllByRole("link", { name: "Website" })).toHaveLength(1);
  });

  it("offers VIGA Bucks and flower-only filters and applies them together", async () => {
    const user = userEvent.setup();
    const stands: PublicStandPayload[] = [
      {
        id: "eligible",
        farmName: "Bouquet Farm",
        locationName: "Bouquet Stand",
        visitability: "visitable",
        offeringType: "produce",
        address: "1 Flower Way",
        latitude: 47.44,
        longitude: -122.46,
        farmBucksAccepted: true,
        availability: {},
        usuallySells: ["cut flowers"],
        alsoSellingHere: [],
        items: [],
      },
      {
        id: "produce",
        farmName: "Produce Farm",
        locationName: "Produce Stand",
        visitability: "visitable",
        offeringType: "produce",
        address: "2 Produce Way",
        latitude: 47.45,
        longitude: -122.46,
        farmBucksAccepted: true,
        availability: {},
        usuallySells: ["vegetables"],
        alsoSellingHere: [],
        items: [],
      },
    ];

    render(<StandMap stands={stands} />);
    await user.click(screen.getByRole("button", { name: "Filters" }));

    const filterPanel = screen.getByRole("group", { name: "Filter stands" });
    const bucks = within(filterPanel).getByRole("button", { name: "Accepts VIGA Bucks" });
    const flowers = within(filterPanel).getByRole("button", { name: "Flowers only" });

    await user.click(bucks);
    await user.click(flowers);

    expect(bucks).toHaveAttribute("aria-pressed", "true");
    expect(flowers).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Bouquet Stand" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Produce Stand" })).toBeNull();
  });

  it("keeps the finder compact while exposing active filter state", async () => {
    const user = userEvent.setup();
    const stands: PublicStandPayload[] = [
      {
        id: "open",
        farmName: "Open Farm",
        locationName: "Open Stand",
        visitability: "visitable",
        offeringType: "produce",
        address: "1 Open Way",
        latitude: 47.44,
        longitude: -122.46,
        farmBucksAccepted: true,
        availability: {},
        usuallySells: ["flowers"],
        alsoSellingHere: [],
        items: [],
      },
      {
        id: "produce",
        farmName: "Produce Farm",
        locationName: "Produce Stand",
        visitability: "visitable",
        offeringType: "produce",
        address: "2 Produce Way",
        latitude: 47.45,
        longitude: -122.46,
        farmBucksAccepted: false,
        availability: {},
        usuallySells: ["vegetables"],
        alsoSellingHere: [],
        items: [],
      },
    ];

    render(<StandMap stands={stands} />);

    const finder = screen.getByRole("region", { name: "Find a stand" });
    expect(within(finder).getByRole("heading", { name: "Find a stand" })).toBeTruthy();
    expect(within(finder).getByRole("searchbox", { name: "What they sell" })).toBeTruthy();
    expect(within(finder).getByRole("button", { name: "Near me" })).toBeTruthy();
    expect(within(finder).getByRole("button", { name: "Filters" })).toBeTruthy();
    expect(within(finder).queryByLabelText("Active filters")).toBeNull();
    expect(within(finder).queryByRole("button", { name: "Open now" })).toBeNull();
    expect(within(finder).queryByRole("button", { name: "Confirmed recently" })).toBeNull();
    expect(within(finder).queryByRole("combobox", { name: "Season" })).toBeNull();
    expect(within(finder).getByText("2 stands shown")).toHaveAttribute("aria-live", "polite");

    await user.click(within(finder).getByRole("button", { name: "Filters" }));

    const panel = within(finder).getByRole("group", { name: "Filter stands" });
    const availability = within(panel).getByRole("group", { name: "Availability" });
    expect(within(availability).getByRole("button", { name: "Open now" })).toBeTruthy();
    expect(within(availability).getByRole("button", { name: "Confirmed recently" })).toBeTruthy();
    const details = within(panel).getByRole("group", { name: "Stand details" });
    expect(within(details).queryByRole("button", { name: "Has a stand to visit" })).toBeNull();
    expect(within(details).getByRole("button", { name: "Accepts VIGA Bucks" })).toBeTruthy();
    expect(within(details).getByRole("button", { name: "Flowers only" })).toBeTruthy();
    expect(within(panel).queryByText("Listing trust")).toBeNull();
    expect(within(panel).getByRole("combobox", { name: "Season" })).toBeTruthy();

    await user.click(within(panel).getByRole("button", { name: "Flowers only" }));

    expect(within(finder).getByText("1 of 2 stands shown")).toBeTruthy();
    expect(finder.querySelector(".active-filter-token")).toBeNull();
    expect(within(finder).getByRole("button", { name: "Filters, 1 active" })).toBeTruthy();
    const clearAll = within(finder).getByRole("button", { name: "Clear all" });
    expect(clearAll.closest(".filter-panel-season")).toBeTruthy();
    await user.click(clearAll);
    expect(within(finder).getByText("2 stands shown")).toBeTruthy();
    expect(within(finder).getByRole("group", { name: "Filter stands" })).toBeTruthy();
    expect(within(finder).queryByLabelText("Active filters")).toBeNull();
  });

  it("uses the same structured detail hierarchy in the expanded row and map sheet", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "hierarchy",
      farmName: "Hierarchy Farm",
      locationName: "Hierarchy Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "9 Orchard Way",
      latitude: 47.44,
      longitude: -122.46,
      updated: "updated 1 hour ago",
      confirmedElapsed: "1 hour ago",
      stale: false,
      farmBucksAccepted: true,
      availability: {},
      usuallySells: ["flowers"],
      alsoSellingHere: [],
      items: [{ itemName: "Tulips", quantity: 6, unit: "bunches", priceText: "$12" }],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Hierarchy Stand" }));

    const rowDetails = container.querySelector(".stands .stand-detail-body")!;
    expect(rowDetails.querySelector(".detail-inventory")).toHaveTextContent(
      "Confirmed 1 hour ago",
    );
    expect(rowDetails.querySelector(".detail-inventory")).toHaveTextContent("6 bunches");
    expect(rowDetails.querySelector(".detail-inventory")).toHaveTextContent("$12");
    expect(within(container.querySelector(".stands .stand") as HTMLElement).getByText(
      "9 Orchard Way",
    )).toHaveClass("stand-summary-address");

    await user.click(screen.getByRole("button", { name: "Hierarchy Stand" }));
    await user.click(
      screen.getByRole("button", { name: "1. Hierarchy Stand, Hierarchy Farm" }),
    );
    const sheet = screen.getByRole("dialog", { name: "Hierarchy Stand details" });
    expect(sheet.querySelector(".stand-detail-body .detail-inventory")).toHaveTextContent(
      "6 bunches",
    );
    expect(sheet.querySelector(".stand-detail-body .detail-visit")).toHaveTextContent(
      "9 Orchard Way",
    );
  });
});

// The wide layout puts the map beside the directory, and the MAP is what moves when a stand is
// selected — from a card or from a pin. These assert the rule at the component seam; the
// arithmetic that decides how far it moves has its own boundary tests in `map-follow.test.ts`.
describe("wide-screen map follow", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  const stand: PublicStandPayload = {
    id: "follow-stand",
    farmName: "Follow Farm",
    locationName: "Follow Stand",
    locationKind: "farm_stand",
    visitability: "visitable",
    offeringType: "produce",
    address: "5 Follow Lane",
    latitude: 47.45,
    longitude: -122.46,
    description: "Eggs and jam",
    availability: {
      season: { kind: "date_range", startMonth: 1, startDay: 1, endMonth: 12, endDay: 31 },
      hours: { kind: "clock_range", fromMinutes: 480, untilMinutes: 1080 },
      days: [0, 1, 2, 3, 4, 5, 6],
    },
    alsoSellingHere: [],
    items: [],
  };

  /** Three stands, so "first in the list" is a real position rather than the only one. */
  const trio: PublicStandPayload[] = ["Alpha", "Bravo", "Charlie"].map((word, index) => ({
    ...stand,
    id: `stand-${word.toLowerCase()}`,
    farmName: `${word} Farm`,
    locationName: `${word} Stand`,
    address: `${index + 1} ${word} Way`,
    latitude: 47.44 + index * 0.01,
    longitude: -122.46 + index * 0.01,
  }));

  it("hoists the selected card to the top of the list when a pin is tapped", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={trio} />);

    const namesBefore = [...container.querySelectorAll(".stands .stand h2")].map(
      (h) => h.textContent,
    );
    expect(namesBefore).toEqual(["Alpha Stand", "Bravo Stand", "Charlie Stand"]);

    // The LAST stand, so a hoist is unmistakable — it has to cross the whole list.
    await user.click(
      screen.getByRole("button", { name: "3. Charlie Stand, Charlie Farm" }),
    );

    // A pin tap asks "what is this stand?", and the answer is the expanded card. Rather than
    // scrolling the page to reach it — which dragged the map out of view — the card comes to
    // the top of the directory, where it sits beside the map that produced it.
    const namesAfter = [...container.querySelectorAll(".stands .stand h2")].map(
      (h) => h.textContent,
    );
    expect(namesAfter).toEqual(["Charlie Stand", "Alpha Stand", "Bravo Stand"]);
    expect(container.querySelector(".stands .stand")).toHaveClass("stand-selected");

    // The page IS scrolled — but to the layout, not to the card. That distinction is the whole
    // fix: scrolling to the card chased it down the column and dragged the map off screen,
    // whereas the card has already been hoisted to the layout's top, so this lands on a fixed
    // position holding both. Asserted in its own test above.
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("returns the map to the top so it lands beside the hoisted card", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={trio} />);
    const column = container.querySelector(".map-column") as HTMLElement;

    // Leave the map somewhere other than the top, as a previous card tap would have.
    column.style.transform = "translateY(400px)";

    await user.click(
      screen.getByRole("button", { name: "3. Charlie Stand, Charlie Farm" }),
    );

    // The map is repositioned to meet the hoisted card rather than left where a previous card
    // tap parked it.
    //
    // NOTE ON WHAT THIS PROVES. jsdom reports every element as zero-sized, so the offset here
    // computes to 0 whatever the geometry would really be — this asserts that the map WAS
    // repositioned, not that it landed in the right place. Where it lands is decided by
    // `mapFollowOffset`, whose viewport cases are tested against real numbers in
    // `map-follow.test.ts`.
    expect(column.style.transform).toBe("");
  });

  it("leaves the list order alone when the selection came from a card", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={trio} />);

    await user.click(screen.getByRole("button", { name: "Charlie Stand" }));

    // A card tap is answered by the MAP moving. Reordering the directory as well would pull the
    // row out from under the finger that just tapped it, and move both surfaces at once.
    const names = [...container.querySelectorAll(".stands .stand h2")].map((h) => h.textContent);
    expect(names).toEqual(["Alpha Stand", "Bravo Stand", "Charlie Stand"]);
    expect(container.querySelector(".stands .stand")).not.toHaveClass("stand-selected");
  });

  it("lifts the hoisted card level with the map by demoting the list preamble", async () => {
    const user = userEvent.setup();
    const stale = trio.map((s) => ({ ...s, stale: true, updated: "updated 9 days ago" }));
    const { container } = render(<StandMap stands={stale} />);

    const column = container.querySelector(".list-column") as HTMLElement;
    expect(column).not.toHaveClass("list-column-hoisted");

    await user.click(
      screen.getByRole("button", { name: "3. Charlie Stand, Charlie Farm" }),
    );

    // The map is the FIRST child of its column, so the two columns' tops are the same y. The
    // stand list is not first in its own column — a stale summary and the marker key sit above
    // it — so a hoisted card lands that far below the map's top edge. Demoting both blocks
    // below the list puts the card at the column's top, level with the map.
    //
    // Done in CSS rather than by measuring: the columns are grid siblings, so this is a layout
    // fact and needs no geometry. That is what makes it survive inside VIGA's iframe, where
    // there is no viewport to measure against.
    expect(column).toHaveClass("list-column-hoisted");

    // The preamble is REORDERED, never removed — the stale warning is a standing obligation of
    // the product and must not disappear because a customer tapped a pin.
    expect(within(column).getByRole("note")).toBeTruthy();
    expect(within(column).getByLabelText("Farm map key")).toBeTruthy();
  });

  it("brings the aligned pair into view when a pin is tapped", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={trio} />);
    const layout = container.querySelector(".layout") as HTMLElement;

    await user.click(
      screen.getByRole("button", { name: "3. Charlie Stand, Charlie Farm" }),
    );

    // The hoist aligns the card with the map, but alignment alone does not put them ON SCREEN:
    // a customer who has scrolled down a long directory has both correctly lined up hundreds of
    // pixels above the fold, and sees neither. Measured in a real browser at scrollY 880: map
    // top -580, card top -564 — aligned, invisible.
    //
    // Scrolling to the LAYOUT is what makes this safe. Earlier versions scrolled to the card
    // wherever it happened to sit, which dragged the map out of view; here the card has already
    // been moved to the layout's top, so this is a scroll to a fixed known position where both
    // are visible together.
    expect(layout.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("restores the list preamble when the selection is dismissed", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={trio} />);
    const column = container.querySelector(".list-column") as HTMLElement;
    const marker = screen.getByRole("button", { name: "3. Charlie Stand, Charlie Farm" });

    await user.click(marker);
    await user.click(marker);

    expect(column).not.toHaveClass("list-column-hoisted");
  });

  it("does not demote the preamble for a selection made from a card", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={trio} />);

    await user.click(screen.getByRole("button", { name: "Charlie Stand" }));

    // A card tap does not hoist, so there is nothing at the column's top to line up with the
    // map, and moving the key and the stale warning would be motion for no reason.
    expect(container.querySelector(".list-column")).not.toHaveClass("list-column-hoisted");
  });

  it("keeps the poster number with its own farm when a card is hoisted", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={trio} />);

    await user.click(
      screen.getByRole("button", { name: "3. Charlie Stand, Charlie Farm" }),
    );

    // Hoisting moves a card, it does not RENUMBER. Charlie is 3 wherever it sits — the poster
    // numbers are keyed to the farm precisely so a number never means a different farm from
    // one tap to the next, and a reordering that renumbered would break that.
    const first = container.querySelector(".stands .stand") as HTMLElement;
    expect(within(first).getByText("3)", { exact: true })).toBeTruthy();
    expect(within(first).getByRole("heading", { name: "Charlie Stand" })).toBeTruthy();
  });

  it("restores the original order when the selection is dismissed", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={trio} />);
    const marker = screen.getByRole("button", { name: "3. Charlie Stand, Charlie Farm" });

    await user.click(marker);
    await user.click(marker);

    const names = [...container.querySelectorAll(".stands .stand h2")].map((h) => h.textContent);
    expect(names).toEqual(["Alpha Stand", "Bravo Stand", "Charlie Stand"]);
  });

  it("does not slide the map when the selection came from a pin", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={[stand]} />);
    const column = container.querySelector(".map-column") as HTMLElement;

    await user.click(
      screen.getByRole("button", { name: "1. Follow Stand, Follow Farm" }),
    );

    // The map sliding on a pin tap is what carried it out of the visible area on a long list:
    // the customer's eyes are already ON the map, so moving it is motion with nothing to gain.
    expect(column.style.transform).toBe("");
  });

  it("keeps the phone's map correction when the wide layout does not apply", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    const user = userEvent.setup();
    render(<StandMap stands={[stand]} />);

    await user.click(
      screen.getByRole("button", { name: "1. Follow Stand, Follow Farm" }),
    );

    // The phone answer is the detail sheet over an anchored map, and it is untouched by this.
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "instant",
    });
  });
});
