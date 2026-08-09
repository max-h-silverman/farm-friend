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
      links: [],
      paymentMethods: [],
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

  /*
    B-039 — A STAND THAT STATED ITS DAYS MUST NOT READ "Hours not listed".

    Provo Farms answers VIGA's "Open Hours & Days" question with "All days". That is a real
    schedule, and the card rendered "Hours not listed" beside it for months because the only
    column anything read was the TIME of day. 13 of 35 stands were in this state and 9 of them
    had stated something.

    `openNow` is right to answer `unknown` here — without clock times nothing can say whether
    the stand is open at this minute — so the fix is in what the CARD says, not in that answer.
    It says the days it actually knows.
  */
  it("says which days a stand is open instead of 'Hours not listed'", async () => {
    const user = userEvent.setup();
    const base: PublicStandPayload = {
      id: "days",
      farmName: "Provo Farms",
      locationName: "Provo Farms",
      visitability: "visitable",
      offeringType: "produce",
      address: "20171 87th Ave SW",
      latitude: 47.4233,
      longitude: -122.4455,
      farmBucksAccepted: true,
      availability: { season: { kind: "year_round" }, days: [0, 1, 2, 3, 4, 5, 6] },
      alsoSellingHere: [],
      links: [],
      paymentMethods: [],
      items: [],
    };

    const { container, unmount } = render(<StandMap stands={[base]} />);
    await user.click(screen.getByRole("button", { name: "Provo Farms" }));
    expect(container.textContent).not.toContain("Hours not listed");
    expect(container.textContent).toContain("Open daily");
    unmount();

    // A partial week states the days themselves rather than a blanket word.
    const weekend = render(
      <StandMap stands={[{ ...base, id: "wk", availability: { ...base.availability, days: [0, 6] } }]} />,
    );
    await user.click(screen.getByRole("button", { name: "Provo Farms" }));
    expect(weekend.container.textContent).not.toContain("Hours not listed");
    expect(weekend.container.textContent).toContain("Sun");
    weekend.unmount();

    // And a stand that genuinely stated NOTHING still says so — the honest case survives.
    const silent = render(
      <StandMap stands={[{ ...base, id: "quiet", availability: { season: { kind: "year_round" } } }]} />,
    );
    await user.click(screen.getByRole("button", { name: "Provo Farms" }));
    expect(silent.container.textContent).toContain("Hours not listed");
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
    links: [],
    paymentMethods: [],
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

  it("keeps the no-stand red indicator on the map and off the listing card", () => {
    const stand: PublicStandPayload = {
      id: "contact-only-farm",
      farmName: "Delivery Farm",
      locationName: "Delivery Farm",
      visitability: "contact_only",
      offeringType: "produce",
      farmBucksAccepted: true,
      availability: {},
      alsoSellingHere: [],
      links: [],
      paymentMethods: [],
      items: [],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    const card = screen.getByRole("heading", { name: "Delivery Farm" }).closest("li")!;

    expect(within(card).getByText("No farm stand to visit")).toBeVisible();
    expect(card.querySelector(".poster-indicator-contact-only")).toBeNull();
    expect(container.querySelector(".marker-legend-contact-only")).not.toBeNull();
  });

  it("shows the stand's stated schedule and restocking details when expanded", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "scheduled-stand",
      farmName: "Scheduled Farm",
      locationName: "Scheduled Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "10 Calendar Lane",
      latitude: 47.44,
      longitude: -122.46,
      farmBucksAccepted: true,
      availability: {
        season: {
          kind: "date_range",
          startMonth: 5,
          startDay: 1,
          endMonth: 10,
          endDay: 31,
        },
        hours: { kind: "clock_range", fromMinutes: 600, untilMinutes: 1080 },
        days: [0, 6],
        hoursText: "Weekends when available",
        stockingCadence: "specific_days",
        stockingDays: [2, 5],
      },
      alsoSellingHere: [],
      links: [],
      paymentMethods: [],
      items: [],
    };

    render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Scheduled Stand" }));
    const card = document.querySelector(".stands .stand") as HTMLElement;
    const schedule = within(card).getByRole("region", { name: "Stand schedule" });

    expect(within(schedule).getByText("May 1–October 31")).toBeVisible();
    expect(within(schedule).getByText("10 AM–6 PM")).toBeVisible();
    expect(within(schedule).getByText("Sunday, Saturday")).toBeVisible();
    expect(within(schedule).getByText("Weekends when available")).toBeVisible();
    expect(within(schedule).getByText("Tuesday, Friday")).toBeVisible();
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
    links: [],
    paymentMethods: [],
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
      usuallySells: [{ itemName: "fresh flowers" }, { itemName: "lavender" }],
      alsoSellingHere: [],
    links: [],
    paymentMethods: [],
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
    links: [],
    paymentMethods: [],
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
    links: [],
    paymentMethods: [],
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
    links: [],
    paymentMethods: [],
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
    links: [],
    paymentMethods: [],
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
        "Saturdays, 10am–2pm\nEarly May through the end of September",
      availability: {
        season: { kind: "date_range", startMonth: 5, startDay: 1, endMonth: 9, endDay: 30 },
        hours: { kind: "clock_range", fromMinutes: 600, untilMinutes: 840 },
        days: [6],
      },
      alsoSellingHere: [],
    links: [{ label: "Website", url: "https://www.vigavashon.org/market" }],
    paymentMethods: [],
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
    // The actions lead the detail body — inside `.detail-aside`, which groups them with the
    // status badges so the pair is placed as one block rather than as separate grid rows.
    const body = card.querySelector(".stand-detail-body");
    expect(body?.firstElementChild).toHaveClass("detail-aside");
    expect(body?.querySelector(".detail-aside")?.firstElementChild).toHaveClass(
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
    links: [],
    paymentMethods: [],
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
      description: "Open every Saturday.",
      updated: "updated 1 hour ago",
      confirmedElapsed: "1 hour ago",
      stale: false,
      availability: {},
      alsoSellingHere: [],
    links: [{ label: "Website", url: "https://scannable.example" }],
    paymentMethods: [],
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
        usuallySells: [{ itemName: "cut flowers" }],
        alsoSellingHere: [],
    links: [],
    paymentMethods: [],
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
        usuallySells: [{ itemName: "vegetables" }],
        alsoSellingHere: [],
    links: [],
    paymentMethods: [],
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
        usuallySells: [{ itemName: "flowers" }],
        alsoSellingHere: [],
    links: [],
    paymentMethods: [],
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
        usuallySells: [{ itemName: "vegetables" }],
        alsoSellingHere: [],
    links: [],
    paymentMethods: [],
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
      usuallySells: [{ itemName: "flowers" }],
      alsoSellingHere: [],
    links: [],
    paymentMethods: [],
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

  /*
    THE TWO VOICES, asserted as STRUCTURE rather than as styling (max, 2026-08-06).

    A confirmation and a specialty must not be able to read as the same kind of claim. The card
    says so by giving them different SHAPES — the confirmation is a list of chips, the specialty
    is a sentence — and that difference is what this test holds. It asserts the elements, not the
    CSS: a rule that repainted `.items-usual` back into chips would be caught by the eye, but a
    markup change that rendered specialties as `<li>` again is the regression that would slip
    through review, because it looks correct in the diff.
  */
  it("gives a confirmation and a specialty different shapes, and leads the card with stock", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "voices",
      farmName: "Two Voices Farm",
      locationName: "Two Voices Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "11 Split Road",
      latitude: 47.44,
      longitude: -122.46,
      updated: "updated 2 hours ago",
      confirmedElapsed: "2 hours ago",
      stale: false,
      availability: {},
      usuallySells: [{ itemName: "flowers" }, { itemName: "honey" }],
      alsoSellingHere: [],
      links: [],
      paymentMethods: [],
      items: [{ itemName: "Tulips" }],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Two Voices Stand" }));

    const body = container.querySelector(".stands .stand-detail-body")!;

    // The confirmed line is a LIST of chips, dated by its own label.
    const confirmed = body.querySelector(".listing-confirmed")!;
    expect(confirmed.querySelector(".listing-label")).toHaveTextContent("Confirmed 2 hours ago");
    expect(confirmed.querySelectorAll(".items li")).toHaveLength(1);

    // The usual line is a SENTENCE. No list, no chips — nothing countable-looking, and no date.
    const usual = body.querySelector(".listing-usual")!;
    expect(usual.querySelector("li")).toBeNull();
    expect(usual.querySelector(".items-usual")).toHaveTextContent("flowers, honey");
    expect(usual.textContent).not.toMatch(/ago/);

    // Stock leads the card. Asserted on the phone SHEET, which is the surface that renders both
    // sections: the expanded directory row suppresses "Plan your visit" because its address is
    // already in the collapsed summary above.
    await user.click(screen.getByRole("button", { name: "Two Voices Stand" }));
    await user.click(
      screen.getByRole("button", { name: "1. Two Voices Stand, Two Voices Farm" }),
    );
    const sheetBody = screen
      .getByRole("dialog", { name: "Two Voices Stand details" })
      .querySelector(".stand-detail-body")!;
    const sections = Array.from(sheetBody.children);
    expect(sections.indexOf(sheetBody.querySelector(".detail-inventory")!)).toBeLessThan(
      sections.indexOf(sheetBody.querySelector(".detail-visit")!),
    );
  });

  /*
    STALENESS IS NEVER SIGNALLED BY COLOUR ALONE (globals.css, top).

    Colour fails for a colourblind customer and in bright sun, so the rule is that WORDS always
    carry it too. This asserts the words, and it exists because nothing did: the card once had a
    third signal, a "May be out of date" line, and removing it broke no test at all. A guarantee
    with no test is a guarantee that leaves silently.

    Asserted as TEXT a customer can read, deliberately — not as a class name or an element. A
    version of this that queried a class would pass against an empty span.

    NARROWED (max, 2026-08-08): the "Needs confirmation" label, the amber left border, and the
    "N listings need a recent confirmation" summary were all removed. The dated line is now the
    whole of the word signal, which makes this test's job larger rather than smaller — it is the
    only thing left standing between a stale stand and a card that looks fresh.
  */
  it("says staleness in words, not only in colour", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "words",
      farmName: "Wordy Farm",
      locationName: "Wordy Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "5 Plain Road",
      latitude: 47.44,
      longitude: -122.46,
      availability: {},
      alsoSellingHere: [],
      links: [],
      paymentMethods: [],
      items: [{ itemName: "Apples" }],
      updated: "updated 6 days ago",
      confirmedElapsed: "6 days ago",
      stale: true,
    };

    const { container } = render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Wordy Stand" }));

    // The dated label above the items: the age stated in words, which is now the only
    // non-colour signal a stale stand carries.
    expect(container.querySelector(".listing-label-confirmed")).toHaveTextContent(
      "Confirmed 6 days ago",
    );

    // The removed signals must stay removed: each was the same fact told a second time, and a
    // reader reinstating one would be re-adding the noise this deletion set out to remove.
    expect(container.textContent).not.toContain("Needs confirmation");
    expect(container.textContent).not.toContain("need a recent confirmation");
    expect(container.querySelector(".stale-summary")).toBeNull();
    expect(container.querySelector(".stand-stale")).toBeNull();

    // A fresh stand states its own date rather than a warning.
    const fresh = render(<StandMap stands={[{ ...stand, id: "fresh", stale: false }]} />);
    expect(fresh.container.textContent).not.toContain("Needs confirmation");
  });

  /*
    A STALE CARD MUST NOT CONTRADICT ITSELF (max, 2026-08-06).

    The confirmed label is green — the colour this map uses for "a farmer vouched for this". On a
    stand the card is otherwise flagging as needing confirmation, green says trust this about the
    very fact the rest of the card doubts, which is the honesty failure the recency design exists
    to prevent. Past the staleness window the timestamp goes amber.

    This label is also now one of the two WORD-based staleness signals (see globals.css), so it
    carries an accessibility guarantee and not only a visual one.
  */
  it("does not colour the confirmation as certain once the stand is stale", async () => {
    const user = userEvent.setup();
    const base: PublicStandPayload = {
      id: "aged",
      farmName: "Aged Farm",
      locationName: "Aged Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "3 Old Lane",
      latitude: 47.44,
      longitude: -122.46,
      availability: {},
      alsoSellingHere: [],
      links: [],
      paymentMethods: [],
      items: [{ itemName: "Apples" }],
      updated: "updated 6 days ago",
      confirmedElapsed: "6 days ago",
    };

    const fresh = render(<StandMap stands={[{ ...base, stale: false }]} />);
    await user.click(screen.getByRole("button", { name: "Aged Stand" }));
    expect(
      fresh.container.querySelector(".listing-label-confirmed"),
    ).not.toHaveClass("listing-label-aged");
    fresh.unmount();

    const stale = render(<StandMap stands={[{ ...base, stale: true }]} />);
    await user.click(screen.getByRole("button", { name: "Aged Stand" }));
    expect(stale.container.querySelector(".listing-label-confirmed")).toHaveClass(
      "listing-label-aged",
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
    links: [],
    paymentMethods: [],
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
    // stand list is not first in its own column — the marker key sits above it — so a hoisted
    // card lands that far below the map's top edge. Demoting the key below the list puts the
    // card at the column's top, level with the map.
    //
    // Done in CSS rather than by measuring: the columns are grid siblings, so this is a layout
    // fact and needs no geometry. That is what makes it survive inside VIGA's iframe, where
    // there is no viewport to measure against.
    expect(column).toHaveClass("list-column-hoisted");

    // The preamble is REORDERED, never removed: a customer tapping a pin must not lose the key
    // that explains what the map's own markers mean.
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

/**
 * The expanded directory row's ACTION ROW (the design pass).
 *
 * The defect this locks out was visible on the deployed map: "Website" and "Get directions"
 * rendered as the single word "WebsiteGet directions". `.detail-actions` was a bare `<div>`
 * with no layout of its own, so two inline links sat with nothing between them — two distinct
 * destinations reading as one. The row is now a flex row with a gap, and the two links are
 * separated in the MARKUP as well, so the accessible names stay distinct even unstyled.
 */
describe("expanded stand actions", () => {
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

  const stand: PublicStandPayload = {
    id: "action-stand",
    farmName: "Action Farm",
    locationName: "Action Stand",
    visitability: "visitable",
    offeringType: "produce",
    address: "23720 Example Rd SW",
    latitude: 47.44,
    longitude: -122.46,
    availability: {},
    alsoSellingHere: [],
    paymentMethods: [],
    items: [],
    usuallySells: [{ itemName: "plant starts" }, { itemName: "vegetables" }],
    farmBucksAccepted: true,
    description: "Open: dawn to dusk.",
    links: [{ label: "Website", url: "https://example.invalid/farm" }],
  };

  it("renders the website and directions as two separate action links", async () => {
    const user = userEvent.setup();
    const { container } = render(<StandMap stands={[stand]} />);

    await user.click(
      screen.getByRole("button", { name: "Action Stand" }),
    );

    const actions = container.querySelector(".detail-actions") as HTMLElement;
    expect(actions).toBeTruthy();

    const website = within(actions).getByRole("link", { name: "Website" });
    const directions = within(actions).getByRole("link", { name: "Get directions" });

    // THE REGRESSION ITSELF, asserted on STRUCTURE rather than on the row's concatenated text.
    // The defect was two bare anchors as adjacent inline siblings, with nothing — no element
    // boundary, no whitespace — between them. Note that a text assertion cannot express this
    // fix: the separation is a flex gap, and `textContent` is identical with and without it.
    // What actually changed is that each action is now its own list item.
    expect(actions.tagName).toBe("UL");
    for (const link of [directions, website]) {
      expect(link.parentElement?.tagName).toBe("LI");
      expect(link.parentElement?.parentElement).toBe(actions);
    }
    // Distinct items, so neither can collapse into the other's line box.
    expect(directions.parentElement).not.toBe(website.parentElement);

    // Directions leads: it is the act the card exists to enable, and the website is secondary.
    expect(
      directions.parentElement!.compareDocumentPosition(website.parentElement!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

/**
 * THE PHONE SHEET keeps its own visit section.
 *
 * The stacked-bands work changed the DIRECTORY row's actions, and both surfaces render the
 * same component — so the risk is that the restructure leaked into the sheet, which places its
 * website and directions inside `.detail-visit` instead. That branch is selected by
 * `showDestination`, and this pins the split: the sheet gets the visit section and NOT the
 * directory's action list, with both destinations still reachable.
 */
describe("phone sheet visit section", () => {
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

  it("renders the visit section, not the directory action list, on the sheet", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "sheet-stand",
      farmName: "Sheet Farm",
      locationName: "Sheet Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "23720 Example Rd SW",
      latitude: 47.44,
      longitude: -122.46,
      availability: {},
      alsoSellingHere: [],
    paymentMethods: [],
      items: [],
      usuallySells: [{ itemName: "plant starts" }],
      farmBucksAccepted: true,
      description: "Open: dawn to dusk.",
      links: [{ label: "Website", url: "https://example.invalid/farm" }],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Sheet Stand" }));

    const sheet = container.querySelector(".sheet") as HTMLElement;
    expect(sheet).toBeTruthy();

    // The sheet's own arrangement: a visit section, and none of the directory's action list.
    expect(sheet.querySelector(".detail-visit")).toBeTruthy();
    expect(sheet.querySelector(".detail-actions")).toBeNull();

    // Both destinations remain reachable from the sheet — the restructure must not have cost
    // the phone a way to get anywhere.
    const visit = sheet.querySelector(".detail-visit") as HTMLElement;
    expect(within(visit).getByRole("link", { name: "Website" })).toBeTruthy();
    expect(within(visit).getByRole("link", { name: "Get directions" })).toBeTruthy();
  });
});

describe("structured links and payment methods (F-061)", () => {
  // `farm_links` and `sales_location_payment_methods` were correctly-shaped tables with NO
  // writer and NO reader. The seeder is now the writer; these assert the reader, because a
  // populated table nothing reads is still invisible to the customer it was for.
  //
  // The card previously recovered a single website by matching a "Website: …" line inside the
  // description prose. Measured over the real corpus, the farms state 34 links across 24
  // stands — Instagram and Facebook among them — and that regex could surface only the subset
  // written as a labelled "Website:" line. Every other link a farm listed was silently dropped.

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

  const stand = (overrides: Partial<PublicStandPayload> = {}): PublicStandPayload => ({
    id: "links-stand",
    farmName: "Linked Farm",
    locationName: "Linked Stand",
    visitability: "visitable",
    offeringType: "produce",
    address: "1 Link Way",
    latitude: 47.44,
    longitude: -122.46,
    availability: {},
    alsoSellingHere: [],
    links: [],
    paymentMethods: [],
    items: [],
    ...overrides,
  });

  it("renders EVERY link the farm stated, not just a website", async () => {
    const user = userEvent.setup();
    render(
      <StandMap
        stands={[
          stand({
            links: [
              { label: "Website", url: "https://example.invalid/farm" },
              { label: "Instagram", url: "https://instagram.com/linkedfarm" },
              { label: "Facebook", url: "https://facebook.com/linkedfarm" },
            ],
          }),
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Linked Stand" }));

    const card = document.querySelector(".stands .stand") as HTMLElement;
    // Each label is its own action, carrying its own href. The old scrape produced one anchor
    // reading "Website" whatever the farm had listed.
    expect(within(card).getByRole("link", { name: "Website" })).toHaveAttribute(
      "href",
      "https://example.invalid/farm",
    );
    expect(within(card).getByRole("link", { name: "Instagram" })).toHaveAttribute(
      "href",
      "https://instagram.com/linkedfarm",
    );
    expect(within(card).getByRole("link", { name: "Facebook" })).toHaveAttribute(
      "href",
      "https://facebook.com/linkedfarm",
    );
  });

  it("renders no link action at all for a farm that stated none", async () => {
    const user = userEvent.setup();
    render(<StandMap stands={[stand({ links: [] })]} />);
    await user.click(screen.getByRole("button", { name: "Linked Stand" }));

    const card = document.querySelector(".stands .stand") as HTMLElement;
    expect(within(card).queryByRole("link", { name: "Website" })).toBeNull();
    expect(within(card).queryByRole("link", { name: "Instagram" })).toBeNull();
  });

  it("shows the stand's other payment methods", async () => {
    const user = userEvent.setup();
    render(
      <StandMap stands={[stand({ paymentMethods: ["Cash", "Check", "Venmo"] })]} />,
    );
    await user.click(screen.getByRole("button", { name: "Linked Stand" }));

    const card = document.querySelector(".stands .stand") as HTMLElement;
    expect(within(card).getByText("Also accepts Cash, Check, Venmo")).toBeTruthy();
  });

  it("never repeats VIGA Bucks among the payment methods", async () => {
    // Farm Bucks has its own column, its own badge, and its own filter. If the parser ever let
    // it into this list the card would state the same fact twice, in two voices that can drift
    // apart — the seeder writes `farmBucksAccepted` from a different source line than this list.
    const user = userEvent.setup();
    render(
      <StandMap
        stands={[
          stand({ farmBucksAccepted: true, paymentMethods: ["Cash", "Venmo"] }),
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Linked Stand" }));

    const card = document.querySelector(".stands .stand") as HTMLElement;
    expect(within(card).getByText("Accepts VIGA Bucks")).toBeTruthy();
    expect(within(card).getByText("Also accepts Cash, Venmo")).toBeTruthy();
    expect(within(card).queryByText(/Also accepts.*VIGA/)).toBeNull();
  });

  it("says nothing about payment for a stand with no stated methods", async () => {
    const user = userEvent.setup();
    render(<StandMap stands={[stand({ paymentMethods: [] })]} />);
    await user.click(screen.getByRole("button", { name: "Linked Stand" }));

    const card = document.querySelector(".stands .stand") as HTMLElement;
    expect(within(card).queryByText(/Also accepts/)).toBeNull();
  });
});
