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
    expect(within(card).getByText("Also selling here")).toBeTruthy();
    expect(within(card).getByText("Guest Growers").closest("a")).toBeNull();
    expect(within(card).getByText("Island Apiary").closest("a")).toBeNull();
    expect(within(card).getByText("Kale").closest(".items")).not.toContainElement(
      within(card).getByText("Guest Growers"),
    );

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
      "Note: This interactive map may contain recent inventory updates, but neither VIGA nor individual farmers can guarantee product availability.",
    )).toHaveClass("map-note");
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
    expect(screen.getAllByText("Does not accept VIGA Bucks")).toHaveLength(1);
    expect(screen.getAllByText("Open year-round")).toHaveLength(1);

    const card = screen.getByRole("heading", { name: "Evergreen Farm Stand" }).closest("li")!;
    expect(within(card).queryByText("Does not accept VIGA Bucks")).toBeNull();
    expect(within(card).queryByText("Open year-round")).toBeNull();
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

  it("explains every marker category, including the no-farm-stand category", () => {
    render(<StandMap stands={[]} />);

    const legend = screen.getByRole("list", { name: "Map marker key" });
    expect(within(legend).getByText("Seasonal farm stand")).toBeTruthy();
    expect(within(legend).getByText("Year-round farm stand")).toBeTruthy();
    expect(within(legend).getByText("Flower-only stand; does not accept VIGA Bucks")).toBeTruthy();
    expect(within(legend).getByText("Farm listed with no farm stand to visit")).toBeTruthy();
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
      availability: {},
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
    expect(marker.querySelector(".pin-selection-halo")).toBeTruthy();
    expect(container.querySelector(".pin-label-layer text")).toHaveTextContent(
      "Vashon Farmers Market",
    );

    const pinLayer = container.querySelector(".pin-layer")!;
    const labelLayer = container.querySelector(".pin-label-layer")!;
    expect(pinLayer.compareDocumentPosition(labelLayer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
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
});
