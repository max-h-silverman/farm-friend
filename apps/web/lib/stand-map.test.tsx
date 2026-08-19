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

  it("never shows two sections with the same heading on one card", async () => {
    /*
      Both the modelled-seller roster and the typed-names fallback are headed "Also selling here"
      (max, 2026-08-18 — renamed from "Who sells here"). They are mutually exclusive by
      construction: the roster excludes own-sellers and so renders only when a GUEST exists, and
      the fallback renders only when no guest does. This asserts that, because the two sections
      sharing a heading makes an accidental overlap read as a duplicated card.

      Tian Tian is the real shape being pinned: a modelled guest (Fernhorn Bakery) AND a retained
      typed name (`Fern Horn Bakery`) on the same stand.
    */
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "both-stand",
      farmName: "Tian Tian",
      locationName: "Tian Tian Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "3 Both Way",
      latitude: 47.44,
      longitude: -122.46,
      updated: "updated 1 hour ago",
      confirmedElapsed: "1 hour ago",
      cardRecency: "Last updated 1 hour ago",
      stale: false,
      availability: {},
      alsoSellingHere: ["Fern Horn Bakery"],
      sellers: [
        {
          providerId: "p-own",
          sellerId: "s-own",
          sellerName: "Tian Tian",
          describesOwnStand: true,
          openState: "unknown" as const,
          confirmedItems: [],
          usualItems: [],
        },
        {
          providerId: "p-guest",
          sellerId: "s-guest",
          sellerName: "Fernhorn Bakery",
          describesOwnStand: false,
          openState: "unknown" as const,
          confirmedItems: [],
          usualItems: [],
        },
      ],
      links: [],
      paymentMethods: [],
      items: [{ itemName: "Kale" }],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Tian Tian Stand" }));
    const card = container.querySelector("ul.stands > li.stand")! as HTMLElement;

    const headings = [...card.querySelectorAll("section")].filter(
      (section) => section.getAttribute("aria-label") === "Also selling here",
    );
    expect(headings).toHaveLength(1);
    // The guest is the one named; the typed duplicate spelling stays suppressed.
    expect(within(card).getByText("Fernhorn Bakery")).toBeTruthy();
    expect(within(card).queryByText("Fern Horn Bakery")).toBeNull();
  });

  it("keeps the typed names when the only modelled seller is the stand's own (B-085)", async () => {
    /*
      MORGAN HILL. The fallback suppressed the typed names whenever ANY modelled seller existed,
      and `0042` gave every stand a self-pointer — so one native row hid four real names and
      replaced NONE of them, because a self-pointer never appears as an item credit.

      The rule's own justification is the test: it suppresses typed names because *"a stand whose
      sellers ARE modelled has already named them, on the item lines"*. That is true of a GUEST,
      who gets a credit. It is false of the stand's own seller, who names nobody. So the fallback
      counts guests.

      Morgan Hill's four are decorative rather than operational (max, 2026-08-18): no handset, no
      seller rows, and one `source: 'viga'` revision holding 17 pooled items nobody can attribute.
      Promoting them would have created four identities nobody owns — this is the honest fix.
    */
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "venue-stand",
      farmName: "Morgan Hill",
      locationName: "Morgan Hill Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "1 Community Way",
      latitude: 47.44,
      longitude: -122.46,
      updated: "updated 1 hour ago",
      confirmedElapsed: "1 hour ago",
      cardRecency: "Last updated 1 hour ago",
      stale: false,
      availability: {},
      alsoSellingHere: ["Bywater Flower Farm", "Rozy Dawg Farm"],
      // The ONE modelled seller is the stand itself — `describesOwnStand`, never a credit.
      sellers: [
        {
          providerId: "p-own",
          sellerId: "s-own",
          sellerName: "Morgan Hill",
          describesOwnStand: true,
          openState: "unknown" as const,
          confirmedItems: [],
          usualItems: [],
        },
      ],
      links: [],
      paymentMethods: [],
      items: [{ itemName: "Kale" }],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Morgan Hill Stand" }));
    const card = container.querySelector("ul.stands > li.stand")!;

    expect(within(card as HTMLElement).getByText("Also selling here")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Bywater Flower Farm")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Rozy Dawg Farm")).toBeTruthy();
  });

  it("still suppresses the typed names once a GUEST seller is modelled", async () => {
    /*
      The other half, asserted so the fix cannot become "always show both". A guest IS named on
      the item lines, and printing the typed strings beside her restores the double-naming the
      section exists to end.
    */
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "guest-stand",
      farmName: "Host Farm",
      locationName: "Guest Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "2 Guest Way",
      latitude: 47.44,
      longitude: -122.46,
      updated: "updated 1 hour ago",
      confirmedElapsed: "1 hour ago",
      cardRecency: "Last updated 1 hour ago",
      stale: false,
      availability: {},
      alsoSellingHere: ["Typed Name"],
      sellers: [
        {
          providerId: "p-own",
          sellerId: "s-own",
          sellerName: "Host Farm",
          describesOwnStand: true,
          openState: "unknown" as const,
          confirmedItems: [],
          usualItems: [],
        },
        {
          providerId: "p-guest",
          sellerId: "s-guest",
          sellerName: "Guest Growers",
          describesOwnStand: false,
          openState: "unknown" as const,
          confirmedItems: [],
          usualItems: [],
        },
      ],
      links: [],
      paymentMethods: [],
      items: [{ itemName: "Kale" }],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Guest Stand" }));
    const card = container.querySelector("ul.stands > li.stand")!;

    expect(within(card as HTMLElement).queryByText("Typed Name")).toBeNull();
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
      cardRecency: "Last updated 1 hour ago",
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
      "Note: This map may contain recent inventory updates, but neither VIGA nor individual sellers can guarantee product availability.",
    )).toHaveClass("map-note");
  });

  /*
    The search placeholder is the only instruction a customer gets about what they may type,
    and the field matches BOTH a product and a stand name — nothing else on the page says so.
    Asserted on the rendered attribute, so the shape a customer reads is what is pinned.

    **Only the examples are quoted.** The hint itself is not a quotation, and the quote marks
    exist to mark "eggs" and "flowers" as things you could literally type (max, 2026-08-12).
  */
  it("offers both a product and a stand name as search examples", () => {
    render(<StandMap stands={[]} />);

    const placeholder =
      screen.getByPlaceholderText(/e\.g\./i).getAttribute("placeholder") ?? "";

    expect(placeholder).toContain("“eggs”");
    expect(placeholder).toContain("“flowers”");
    expect(placeholder).toContain("stand name");
    expect(placeholder.endsWith("…")).toBe(true);
    // The hint is not itself wrapped in quotes, and does not end up quoted by a later edit.
    expect(placeholder.startsWith("e.g.")).toBe(true);
    expect(placeholder).not.toMatch(/^["“]/);
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
    // Visit actions lead a market's detail body; inventory and farm-only status do not apply.
    const body = card.querySelector(".stand-detail-body");
    expect(body?.firstElementChild).toHaveClass("detail-action-region");
    expect(body?.querySelector(".detail-action-region")?.firstElementChild).toHaveClass(
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
      cardRecency: "Last updated 1 hour ago",
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

    const finder = screen.getByRole("region", { name: /find a stand/i });
    // The visible "Find a stand" heading became the view toggle (max, 2026-08-18). The section
    // keeps its accessible name, because a region with no name is one a screen reader cannot
    // announce — it just is not a heading any more.
    expect(within(finder).queryByRole("heading", { name: "Find a stand" })).toBeNull();
    expect(
      within(finder).getByRole("searchbox", {
        name: "What they sell, or a farm or stand name",
      }),
    ).toBeTruthy();
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
      cardRecency: "Last updated 1 hour ago",
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
      "Last updated 1 hour ago",
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
    expect(sheet.querySelector(".sheet-address")).toHaveTextContent("9 Orchard Way");
  });

  /*
    AN AGED-OUT CONFIRMATION SHOWS NO STOCK SECTION (max, 2026-08-10).

    The reported defect, pinned at the surface it was seen on. The card printed a bordered "In
    stock" heading over an item list for a confirmation of any age, hedging only in the caption
    beside it — so a customer read "In stock" for produce nobody had touched in months.

    The expired stand arrives here with its recency fields already withheld by
    `listPublicStands`, which is where the age is judged. This test holds the CONSEQUENCE at the
    component: no stock heading, no item chips, and no orphan caption left behind. Asserted on
    the elements rather than on the text, so a change that kept the section and merely blanked
    its words still fails.
  */
  it("keeps the In stock status section for a confirmation that has aged out", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "aged",
      farmName: "Aged Farm",
      locationName: "Aged Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "9 Old Road",
      latitude: 47.44,
      longitude: -122.46,
      // No `updated`, `confirmedElapsed`, `cardRecency` or `stale` — an expired confirmation is
      // indistinguishable from one that never happened by the time it reaches the card.
      availability: {},
      usuallySells: [{ itemName: "flowers" }, { itemName: "honey" }],
      alsoSellingHere: [],
      links: [],
      paymentMethods: [],
      // Still populated: the stand items are real rows. The rule is that nothing renders them
      // as CURRENT STOCK without a date to stand behind.
      items: [{ itemName: "Tulips" }],
    };

    const { container } = render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Aged Stand" }));

    const body = container.querySelector(".stands .stand-detail-body")!;

    // The stale STOCK CLAIM is gone. The In stock section itself legitimately remains — it now
    // carries "Nothing confirmed recently.", which is the honest line and the reason the stand
    // is not simply blanked. What must not survive is the confirmed listing and its chips.
    expect(body.querySelector(".listing-confirmed")).toBeNull();
    expect(body.querySelector(".listing-recency")).toBeNull();
    expect(body.querySelector(".detail-inventory .items")).toBeNull();
    expect(body.querySelector(".detail-inventory")).toHaveTextContent(
      "Nothing confirmed recently.",
    );
    expect(body.querySelector(".detail-inventory h3")).toHaveTextContent("In stock");

    // And the item itself is nowhere on the card as a confirmed chip.
    expect(body.textContent).not.toMatch(/Tulips/);
    expect(body.textContent).not.toMatch(/No recent update/i);

    // The stand is NOT blanked: its specialties still render, in their own voice.
    expect(body.querySelector(".items-usual")).toHaveTextContent("flowers, honey");
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
      cardRecency: "Last updated 2 hours ago",
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

    // The confirmed line is a LIST of chips under an explicit current-stock heading.
    const confirmed = body.querySelector(".listing-confirmed")!;
    const confirmedHeading = body.querySelector(".detail-inventory h3")!;
    expect(confirmedHeading).toHaveTextContent("In stock");
    expect(confirmedHeading).toHaveTextContent(
      "Last updated 2 hours ago",
    );
    // The mockup puts the recency next to the stock heading, before the current items.
    expect(confirmedHeading.compareDocumentPosition(confirmed.querySelector(".items")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(confirmed.querySelectorAll(".items li")).toHaveLength(1);

    // The usual line is a SENTENCE. No list, no chips — nothing countable-looking, and no date.
    const usual = body.querySelector(".listing-usual")!;
    expect(body.querySelector(".detail-usual-offerings h3")).toHaveTextContent(
      "Typical offerings",
    );
    expect(usual.querySelector("li")).toBeNull();
    expect(usual.querySelector(".items-usual")).toHaveTextContent("flowers, honey");
    expect(usual.textContent).not.toMatch(/ago/);

    // Stock leads the card. The address belongs directly beneath the phone-sheet title; the
    // first practical destination after its facts is the action row.
    await user.click(screen.getByRole("button", { name: "Two Voices Stand" }));
    await user.click(
      screen.getByRole("button", { name: "1. Two Voices Stand, Two Voices Farm" }),
    );
    const sheetBody = screen
      .getByRole("dialog", { name: "Two Voices Stand details" })
      .querySelector(".stand-detail-body")!;
    const sections = Array.from(sheetBody.children);
    expect(sections.indexOf(sheetBody.querySelector(".detail-inventory")!)).toBeLessThan(
      sections.indexOf(sheetBody.querySelector(".detail-action-region")!),
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
      cardRecency: "Last updated 6 days ago",
      stale: true,
    };

    const { container } = render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: "Wordy Stand" }));

    // The dated current-stock heading: the age is stated in words, not only colour.
    expect(container.querySelector(".listing-recency")).toHaveTextContent(
      "Last updated 6 days ago",
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
      cardRecency: "Last updated 6 days ago",
    };

    const fresh = render(<StandMap stands={[{ ...base, stale: false }]} />);
    await user.click(screen.getByRole("button", { name: "Aged Stand" }));
    expect(
      fresh.container.querySelector(".listing-recency"),
    ).not.toHaveClass("listing-recency-aged");
    fresh.unmount();

    const stale = render(<StandMap stands={[{ ...base, stale: true }]} />);
    await user.click(screen.getByRole("button", { name: "Aged Stand" }));
    expect(stale.container.querySelector(".listing-recency")).toHaveClass(
      "listing-recency-aged",
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
 * THE PHONE SHEET shares the directory's action list.
 *
 * The stacked-bands work changed the DIRECTORY row's actions, and both surfaces render the
 * same component — so the risk is that the sheet gets a second, divergent action structure.
 * Both destinations are one equal-action row in either presentation.
 */
describe("phone sheet actions", () => {
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

  it("renders the same action list as the expanded directory row", async () => {
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

    const actions = sheet.querySelector(".detail-actions") as HTMLElement;
    expect(actions).toBeTruthy();

    // Both destinations remain reachable from the sheet — the restructure must not have cost
    // the phone a way to get anywhere.
    expect(within(actions).getByRole("link", { name: "Website" })).toBeTruthy();
    expect(within(actions).getByRole("link", { name: "Get directions" })).toBeTruthy();
  });
});

describe("structured links and payment methods (F-061)", () => {
  // `seller_links` and `sales_location_payment_methods` were correctly-shaped tables with NO
  // writer and NO reader. The seeder is now the writer; these assert the reader, because a
  // populated table nothing reads is still invisible to the customer it was for.
  //
  // The card previously recovered a single website by matching a "Website: …" line inside the
  // description prose. Measured over the real corpus, the sellers state 34 links across 24
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

/*
  F-114 C.5 — THE ITEM-FIRST CARD, RENDERED.

  `stand-card.test.ts` proves the sections are decided correctly; this proves the component
  actually draws them. DEVELOPMENT.md §before you ship: bytes prove markup, not CSS, so these
  cases assert STRUCTURE — how many rows an item gets, which line a credit sits on, which lines
  carry a date — and the phone-width and light/dark appearance checks are done in a browser.
*/
describe("item-first stand card (F-114 C.5)", () => {
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

  const sharedStand = (
    overrides: Partial<PublicStandPayload> = {},
  ): PublicStandPayload => ({
    id: "venison-valley",
    farmName: "Venison Valley",
    locationName: "Venison Valley Stand",
    visitability: "visitable",
    offeringType: "produce",
    address: "1 Vashon Hwy",
    latitude: 47.44,
    longitude: -122.46,
    updated: "updated 2 hours ago",
    confirmedElapsed: "2 hours ago",
    cardRecency: "Last updated 2 hours ago",
    stale: false,
    availability: {},
    alsoSellingHere: [],
    links: [],
    paymentMethods: [],
    items: [{ itemName: "eggs" }],
    sellers: [
      {
        providerId: "p-host",
        sellerId: "s-host",
        sellerName: "Venison Valley",
        describesOwnStand: true,
        cardRecency: "Last updated 2 hours ago",
        stale: false,
        openState: "open",
        confirmedItems: [{ itemName: "eggs", priceText: "$8" }],
        usualItems: [],
      },
      {
        providerId: "p-guest",
        sellerId: "s-guest",
        sellerName: "Gracies Greens",
        describesOwnStand: false,
        cardRecency: "Last updated 3 weeks ago",
        stale: true,
        openState: "open",
        confirmedItems: [{ itemName: "eggs", priceText: "$7" }],
        usualItems: [{ itemName: "rhubarb", priceText: "$4 / bunch" }],
      },
    ],
    ...overrides,
  });

  /** Render and open the card, which is where the detail listing lives. */
  const openCard = async (stand: PublicStandPayload): Promise<HTMLElement> => {
    const user = userEvent.setup();
    render(<StandMap stands={[stand]} />);
    await user.click(screen.getByRole("button", { name: stand.locationName }));
    return document.querySelector(".stands .stand") as HTMLElement;
  };

  it("draws one row for an item two sellers carry, with both nested beneath it", async () => {
    const card = await openCard(sharedStand());

    // ONE item group, not two. A card that printed a chip per seller would have two.
    const groups = card.querySelectorAll(".item-group");
    expect(groups).toHaveLength(2); // eggs (confirmed) + rhubarb (usual)
    const eggs = [...groups].find(
      (group) => group.querySelector(".item-name")?.textContent === "eggs",
    )!;
    expect(eggs.querySelectorAll(".item-seller")).toHaveLength(2);
  });

  it("prints each nested seller's own price and own freshness", async () => {
    const card = await openCard(sharedStand());
    const eggs = [...card.querySelectorAll(".item-group")].find(
      (group) => group.querySelector(".item-name")?.textContent === "eggs",
    )!;
    const lines = [...eggs.querySelectorAll(".item-seller")];

    expect(lines.map((line) => line.querySelector(".item-price")?.textContent)).toEqual([
      "$8",
      "$7",
    ]);
    expect(
      lines.map((line) => line.querySelector(".item-seller-recency")?.textContent),
    ).toEqual(["Last updated 2 hours ago", "Last updated 3 weeks ago"]);
  });

  it("leaves the stand's own seller unnamed and credits the hosted one", async () => {
    const card = await openCard(sharedStand());
    const eggs = [...card.querySelectorAll(".item-group")].find(
      (group) => group.querySelector(".item-name")?.textContent === "eggs",
    )!;
    const lines = [...eggs.querySelectorAll(".item-seller")];

    // No element at all for the stand's own line — not an empty one. A rendered empty span
    // would leave a gap in the row and would mean a name could be put back into it.
    expect(lines[0]!.querySelector(".item-seller-name")).toBeNull();
    expect(lines[1]!.querySelector(".item-seller-name")?.textContent).toBe("Gracies Greens");
  });

  it("marks a stale seller line without marking the fresh one", async () => {
    const card = await openCard(sharedStand());
    const eggs = [...card.querySelectorAll(".item-group")].find(
      (group) => group.querySelector(".item-name")?.textContent === "eggs",
    )!;
    const recencies = [...eggs.querySelectorAll(".item-seller-recency")];

    expect(recencies[0]).not.toHaveClass("item-seller-recency-aged");
    expect(recencies[1]).toHaveClass("item-seller-recency-aged");
  });

  it("gives a usual line no date at all", async () => {
    // The rule §customer behavior states and `groupProviderItems` enforces: a hosted seller is
    // public on standing claims alone, and a date beside one reads as a confirmation nobody
    // made. The seller HAS a `cardRecency` in the fixture, so a component that passed it
    // through would print it here.
    const card = await openCard(sharedStand());
    const rhubarb = [...card.querySelectorAll(".item-group")].find(
      (group) => group.querySelector(".item-name")?.textContent === "rhubarb",
    )!;

    expect(rhubarb.querySelector(".item-seller-recency")).toBeNull();
    expect(rhubarb.querySelector(".item-price")?.textContent).toBe("$4 / bunch");
    expect(rhubarb.querySelector(".item-seller-name")?.textContent).toBe("Gracies Greens");
  });

  it("falls back to the chip list for a payload with no seller facts", async () => {
    // Every stand the server serves now carries `sellers`. A payload without them is still a
    // valid one, and it must render the listing it has rather than nothing at all.
    const { sellers: _sellers, ...withoutSellers } = sharedStand();
    const card = await openCard(withoutSellers);

    expect(card.querySelectorAll(".item-group")).toHaveLength(0);
    expect(within(card).getByText("eggs")).toBeTruthy();
  });
});

/*
  BROWSE BY SELLER, INSIDE THE LIST (max, 2026-08-18).

  It used to be a link to `/sellers` — a whole separate view, with its own header, its own
  search box and a "back to the farm map" link. Answering "who sells bread?" meant leaving the
  map, and coming back meant losing whatever filters were set.

  Now the two are one list with a tab above it. Stands and sellers are two ways of looking at
  the same island, exactly as the admin console's Stands & Sellers already treats them, so the
  customer switches what the list is ABOUT without leaving the surface the map is on.

  **The map stays, and it stays a map of stands.** A seller has no pin — that is the whole
  reason the seller list exists — so picking one HIGHLIGHTS the stands she sells at. For a
  hosted-only seller those are somebody else's pins, which is precisely the case the pins could
  not express before.
*/
describe("browsing by seller without leaving the map", () => {
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

  const hostStand: PublicStandPayload = {
    id: "morgan-hill",
    farmName: "Morgan Hill",
    locationName: "Morgan Hill Stand",
    visitability: "visitable",
    offeringType: "produce",
    address: "1 Morgan Hill Rd",
    latitude: 47.44,
    longitude: -122.46,
    stale: false,
    availability: {},
    alsoSellingHere: ["Fernhorn Bakery"],
    links: [],
    paymentMethods: [],
    items: [{ itemName: "Kale" }],
  };

  const otherStand: PublicStandPayload = {
    ...hostStand,
    id: "kelsey",
    farmName: "Kelseys Farm",
    locationName: "Kelseys Stand",
    address: "2 Kelsey Rd",
    latitude: 47.46,
    longitude: -122.44,
    alsoSellingHere: [],
    items: [{ itemName: "Eggs" }],
  };

  /** A seller with no stand of her own — the case that has no pin and needs this view. */
  const hostedOnly = {
    sellerId: "fernhorn",
    sellerName: "Fernhorn Bakery",
    ownsAStand: false,
    sellingAt: [
      {
        salesLocationId: "morgan-hill",
        locationName: "Morgan Hill Stand",
        describesOwnStand: false,
        usualItems: [{ itemName: "Sourdough" }],
      },
    ],
  };

  const standOwner = {
    sellerId: "kelseys",
    sellerName: "Kelseys Farm",
    ownsAStand: true,
    sellingAt: [
      {
        salesLocationId: "kelsey",
        locationName: "Kelseys Stand",
        describesOwnStand: true,
        usualItems: [{ itemName: "Eggs" }],
      },
    ],
  };

  function renderMap() {
    return render(
      <StandMap stands={[hostStand, otherStand]} sellers={[hostedOnly, standOwner]} />,
    );
  }

  it("offers Stands and Sellers as tabs, with Stands the default", () => {
    renderMap();

    const stands = screen.getByRole("tab", { name: "View stands" });
    const sellers = screen.getByRole("tab", { name: "View sellers" });

    // Stands is the default: the map is a map of stands, and the seller list is the second view.
    expect(stands).toHaveAttribute("aria-selected", "true");
    expect(sellers).toHaveAttribute("aria-selected", "false");
  });

  it("no longer navigates away to a separate seller page", () => {
    renderMap();

    // The old door. Its absence is the point of the change — a link here took the customer off
    // the map and lost whatever filters they had set.
    expect(screen.queryByRole("link", { name: /browse by seller/i })).toBeNull();
  });

  it("swaps the list to sellers, the map staying put", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();

    expect(screen.getByRole("heading", { name: "Morgan Hill Stand" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    expect(screen.getByText("Fernhorn Bakery")).toBeInTheDocument();
    // The stand cards are gone from the list...
    expect(screen.queryByRole("heading", { name: "Morgan Hill Stand" })).toBeNull();
    // ...and the map is still there, still carrying both pins.
    expect(container.querySelectorAll(".pin-shape, .pin-market-shape").length).toBe(2);
  });

  it("lists a hosted-only seller, who has no pin of her own", async () => {
    const user = userEvent.setup();
    renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    // The case the whole seller view exists for: she owns no stand, so the map alone could
    // never have shown her.
    expect(screen.getByText("Fernhorn Bakery")).toBeInTheDocument();
  });

  it("highlights the stands a chosen seller sells at, including a host's", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    await user.click(screen.getByRole("button", { name: /fernhorn bakery/i }));

    // Her host's pin, not her own — she has none.
    const highlighted = container.querySelectorAll("[data-seller-highlighted='true']");
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.getAttribute("data-stand-id")).toBe("morgan-hill");
  });

  it("highlights only that seller's stands, never every pin", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));
    const sellerList = container.querySelector(".seller-browse")!;
    await user.click(within(sellerList as HTMLElement).getByRole("button", { name: /kelseys farm/i }));

    const highlighted = container.querySelectorAll("[data-seller-highlighted='true']");
    // A highlight that lit every pin would look like working and answer nothing.
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.getAttribute("data-stand-id")).toBe("kelsey");
  });

  it("drops the highlight when the tab goes back to stands", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));
    await user.click(screen.getByRole("button", { name: /fernhorn bakery/i }));
    expect(container.querySelectorAll("[data-seller-highlighted='true']")).toHaveLength(1);

    await user.click(screen.getByRole("tab", { name: "View stands" }));

    // A highlight left behind would mark pins for a seller nobody is looking at any more.
    expect(container.querySelectorAll("[data-seller-highlighted='true']")).toHaveLength(0);
    expect(container.querySelectorAll(".pin-seller-dimmed")).toHaveLength(0);
  });

  it("forgets the chosen seller, rather than re-lighting her on return", async () => {
    /*
      The clearing the tab switch does, asserted where it is observable.

      Leaving the tab already blanks the highlight, because the stand list is not the seller
      list — so the case that proves the CLEARING is coming BACK. A seller still selected
      would re-light pins the customer never re-chose, and the card would show as pressed
      under a list they had left.
    */
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));
    await user.click(screen.getByRole("button", { name: /fernhorn bakery/i }));

    await user.click(screen.getByRole("tab", { name: "View stands" }));
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    expect(container.querySelectorAll("[data-seller-highlighted='true']")).toHaveLength(0);
    // The card is collapsed again too — it is the stand card's own expand state now.
    expect(screen.getByRole("button", { name: /fernhorn bakery/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("filters sellers by name and by what they sell", async () => {
    const user = userEvent.setup();
    renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    const search = screen.getByRole("searchbox", {
      name: /what they sell, or a farm or stand name/i,
    });
    await user.clear(search);
    await user.type(search, "sourdough");

    // Matched on an item, not a name — the seller search's own rule.
    expect(screen.getByText("Fernhorn Bakery")).toBeInTheDocument();
    expect(screen.queryByText("Kelseys Farm")).toBeNull();
  });

  it("says so when no seller matches, rather than falling back to everyone", async () => {
    const user = userEvent.setup();
    renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    const search = screen.getByRole("searchbox", {
      name: /what they sell, or a farm or stand name/i,
    });
    await user.clear(search);
    await user.type(search, "zzzznothing");

    expect(screen.queryByText("Fernhorn Bakery")).toBeNull();
    expect(screen.queryByText("Kelseys Farm")).toBeNull();
    expect(screen.getByText(/no seller matches/i)).toBeInTheDocument();
  });

  it("still works when no seller data is supplied at all", () => {
    // The map is embedded on VIGA's Squarespace page and must not depend on the second read.
    render(<StandMap stands={[hostStand]} />);

    expect(screen.getByRole("heading", { name: "Morgan Hill Stand" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "View sellers" })).toBeNull();
  });

  /*
    THE TOGGLE IS THE LABEL (max, 2026-08-18).

    "Find a stand" sat as a heading with the tabs beside it, which said the same thing twice:
    the heading named the list and the tab named it again. The toggle takes the heading's place
    and its words say what you are looking at — "View farm stands" / "View sellers".
  */
  it("puts the toggle where the heading was, naming both views", () => {
    renderMap();

    expect(screen.getByRole("tab", { name: "View stands" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "View sellers" })).toBeInTheDocument();
    // The heading it replaces is gone, not merely hidden behind it.
    expect(screen.queryByRole("heading", { name: "Find a stand" })).toBeNull();
  });

  /*
    ONE CARD LIST, TWO SUBJECTS (max, 2026-08-18).

    The seller list was its own markup — a different card, a different heading level, a
    different way of showing what someone sells. Two card vocabularies on one surface means a
    customer switching tabs re-learns the list, and every future card change has two homes.

    So a seller renders in the STAND card's shape: the same `<li class="stand">`, the same
    heading button, the same expand-on-tap. Only the metadata differs, because that is the
    only thing that genuinely does.
  */
  it("renders sellers in the stand card's own shape", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    // The same list and the same card element the stands use.
    const cards = container.querySelectorAll("ul.stands > li.stand");
    expect(cards).toHaveLength(2);
    // And the same heading treatment: a seller's name is an <h2>, exactly as a stand's is.
    expect(screen.getByRole("heading", { name: "Fernhorn Bakery" })).toBeInTheDocument();
  });

  it("expands a seller card in place, the way a stand card expands", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    const toggle = screen.getByRole("button", { name: /fernhorn bakery/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    /*
      SHE SELLS AT ONE STAND HERE, so the card opens that STAND's own detail body rather than a
      list of one row pointing at it — the rule the F-118 revision added. What she brings is on
      that body, credited to her, with the stand's own hours and directions around it.
    */
    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    expect(card.querySelector(".stand-detail-body")).toBeInTheDocument();
    expect(within(card).getByText(/morgan hill/i)).toBeInTheDocument();
  });

  it("carries the seller's own metadata, not a stand's", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    const card = container.querySelector("ul.stands > li.stand")!;
    // A SELLER HAS NO PIN OF HER OWN, so the card carries no pin number — the one piece of
    // stand chrome that would be a lie on it.
    expect(card.querySelector(".stand-number")).toBeNull();
    // What she carries instead is her own summary: whether she is open right now.
    expect(card.querySelector(".seller-open-state")).toBeInTheDocument();
  });

  /*
    THE CARD RECLAIMS THE COLUMNS THE PIN CHROME OWNED (max, 2026-08-18).

    `.stand` and `.stand-head` are both grids whose FIRST column is stand chrome — the poster
    dots and the pin number. A seller has neither, so the card inherited two empty gutters and
    the name was laid out in a 1.65rem column, wrapping one word per line.

    Asserted as a CLASS on the card, because jsdom computes no grid: the class is what the
    stylesheet keys the corrected columns off, so it is the honest thing to hold to account.
    What it produces is a layout question, checked in a browser.
  */
  it("marks itself as a card with no pin chrome, so the name gets the full width", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    const card = container.querySelector("ul.stands > li.stand")!;
    expect(card).toHaveClass("stand-no-pin");
    expect(card.querySelector(".stand-head")).toHaveClass("stand-head-no-pin");
  });

  /*
    WHAT A SELLER CARD SAYS AT REST.

    A stand card answers "what is here, and is it open?" without being opened. A seller card
    was answering nothing — a bare name. It carries the same KINDS of fact the stand card does,
    in the same places, drawn from what a seller actually has:

      - where she sells, as the line under the name (the stand card's farm line)
      - whether she is a host's guest or runs her own stand, as a summary chip
      - what she usually brings, so the card is useful before it is expanded
  */
  it("says where she sells and what she brings, without being opened", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.click(screen.getByRole("tab", { name: "View sellers" }));

    const card = container.querySelector("ul.stands > li.stand")! as HTMLElement;

    // Collapsed — this is what the card says before anyone touches it.
    expect(within(card).getByRole("button", { name: /fernhorn bakery/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    /*
      WHAT THE CARD SAYS AT REST, since the 2026-08-18 revision: whether she is open right now.
      Derived from her STANDS, because a seller has no hours of her own — she has places, and
      each place has them.

      This fixture's stands state no hours, so the honest answer is that we do not know —
      NOT "Closed", which is reserved for out of season or outside stated hours (B-083).
    */
    expect(card.querySelector(".seller-open-state")).toHaveTextContent("Hours unknown");
  });

  /*
    OWN-VERSUS-GUEST MOVED OFF THE COLLAPSED CARD (max, 2026-08-18).

    The card used to carry an "Own stand" / "Guest seller" chip. The redesign replaced that row
    with the two facts a customer deciding where to drive actually uses — how many of her stands
    are open, and how long she runs. Whether she owns a stand is still stated where it
    distinguishes something: on the expanded card's stand ROWS, and only when she has both kinds
    (see "labels a row's relation only on a card that mixes own and guest stands").
  */

  it("keeps the section announceable once its heading is gone", () => {
    renderMap();

    // A region with no accessible name is one a screen reader cannot announce, so the name
    // survives the heading that used to carry it.
    expect(screen.getByRole("region", { name: /find a stand/i })).toBeInTheDocument();
  });

  it("shows the toggle even when there are no sellers to switch to", () => {
    /*
      It is the list's LABEL now, not just a switch. With the old tabs, no sellers meant no
      control at all — which would leave the header with nothing naming it.
    */
    render(<StandMap stands={[hostStand]} />);

    expect(screen.getByRole("tab", { name: "View stands" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "View stands" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Nothing to switch TO, so the seller half is absent rather than offering an empty list.
    expect(screen.queryByRole("tab", { name: "View sellers" })).toBeNull();
  });
});

/*
  F-118 — THE TWO LISTS BECOME ONE TWO-WAY VIEW.

  Stands and sellers are many-to-many, and before this the relationship was legible from
  neither side: a stand with three sellers looked like a stand with one until it was opened,
  a seller at three stands named them in a sentence that went nowhere, and a pin tapped while
  the seller list was showing selected a STAND — the other list's subject — so the map stopped
  answering the question the customer was asking.

  Every assertion below is about the RELATIONSHIP being both visible and followable. The graph
  itself is `stand-seller-graph.test.ts`; these hold the surface to account for rendering it.
*/
describe("crossing between stands and sellers", () => {
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

  /** A stand hosting two sellers besides its owner — the case a card must declare at rest. */
  const busyStand: PublicStandPayload = {
    id: "morgan-hill",
    farmName: "Morgan Hill",
    locationName: "Morgan Hill Stand",
    visitability: "visitable",
    offeringType: "produce",
    address: "1 Morgan Hill Rd",
    latitude: 47.44,
    longitude: -122.46,
    stale: false,
    availability: {},
    alsoSellingHere: ["Fernhorn Bakery", "Island Apiary"],
    links: [],
    paymentMethods: [],
    items: [{ itemName: "Kale" }],
    sellers: [
      {
        providerId: "p-morgan",
        sellerId: "morgan",
        sellerName: "Morgan Hill",
        describesOwnStand: true,
        openState: "open",
        confirmedItems: [{ itemName: "Kale" }],
        usualItems: [],
      },
      {
        providerId: "p-fernhorn",
        sellerId: "fernhorn",
        sellerName: "Fernhorn Bakery",
        describesOwnStand: false,
        openState: "open",
        confirmedItems: [],
        usualItems: [{ itemName: "Sourdough" }],
      },
      {
        providerId: "p-apiary",
        sellerId: "apiary",
        sellerName: "Island Apiary",
        describesOwnStand: false,
        openState: "open",
        confirmedItems: [],
        usualItems: [{ itemName: "Honey" }],
      },
    ],
  };

  /** A stand with only its owner — the case that must NOT gain a seller count. */
  const soloStand: PublicStandPayload = {
    ...busyStand,
    id: "kelsey",
    farmName: "Kelseys Farm",
    locationName: "Kelseys Stand",
    address: "2 Kelsey Rd",
    latitude: 47.46,
    longitude: -122.44,
    alsoSellingHere: [],
    items: [{ itemName: "Eggs" }],
    sellers: [
      {
        providerId: "p-kelsey",
        sellerId: "kelseys",
        sellerName: "Kelseys Farm",
        describesOwnStand: true,
        openState: "open",
        confirmedItems: [{ itemName: "Eggs" }],
        usualItems: [],
      },
      {
        providerId: "p-fernhorn-2",
        sellerId: "fernhorn",
        sellerName: "Fernhorn Bakery",
        describesOwnStand: false,
        openState: "open",
        confirmedItems: [],
        usualItems: [{ itemName: "Sourdough" }],
      },
    ],
  };

  /** Hosted-only, at TWO stands — the case with no pin of her own and two destinations. */
  const fernhorn = {
    sellerId: "fernhorn",
    sellerName: "Fernhorn Bakery",
    description: "A wood-fired bakery on the north end.",
    ownsAStand: false,
    sellingAt: [
      {
        salesLocationId: "morgan-hill",
        locationName: "Morgan Hill Stand",
        describesOwnStand: false,
        usualItems: [{ itemName: "Sourdough" }, { itemName: "Baguettes" }],
      },
      {
        salesLocationId: "kelsey",
        locationName: "Kelseys Stand",
        describesOwnStand: false,
        usualItems: [{ itemName: "Sourdough" }],
      },
    ],
  };

  const kelseys = {
    sellerId: "kelseys",
    sellerName: "Kelseys Farm",
    ownsAStand: true,
    sellingAt: [
      {
        salesLocationId: "kelsey",
        locationName: "Kelseys Stand",
        describesOwnStand: true,
        usualItems: [{ itemName: "Eggs" }],
      },
    ],
  };

  function renderMap() {
    return render(
      <StandMap stands={[busyStand, soloStand]} sellers={[fernhorn, kelseys]} />,
    );
  }

  async function openSellers(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("tab", { name: "View sellers" }));
  }

  /*
    A SELLER'S STANDS ARE DESTINATIONS, NOT A SENTENCE.

    The card used to end on prose — "Selling at Morgan Hill Stand and Kelseys Stand" — which
    names the answer and then leaves the customer to find it. A seller's stands ARE the answer
    to her card's question, so they are rows carrying the stands' own pin numbers, and each is
    a way to get there.
  */
  it("names a seller's stands as rows carrying the stands' own pin numbers", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /fernhorn bakery/i }));

    const rows = card.querySelectorAll(".seller-stand-link");
    expect(rows).toHaveLength(2);
    // The numbers are the STANDS' own, from the same numbering the pins use — the numbering is
    // alphabetical by farm name, so Kelseys Farm is 1 and Morgan Hill is 2.
    const numbers = [...rows].map((row) => row.querySelector(".stand-number-ref")?.textContent);
    expect(numbers).toEqual(["2", "1"]);
  });

  it("lists what she brings TO EACH STAND, rather than one pooled list", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /fernhorn bakery/i }));

    const rows = [...card.querySelectorAll(".seller-stand-link")] as HTMLElement[];
    // Two things at one stand, one at the other. A pooled list would claim both at both.
    expect(rows[0]!.querySelector(".seller-stand-items")).toHaveTextContent("Baguettes");
    expect(rows[1]!.querySelector(".seller-stand-items")).not.toHaveTextContent("Baguettes");
  });

  /*
    A STAND OPENS IN PLACE, ON THE SELLER'S CARD (max, 2026-08-18).

    Tapping one of her stands used to switch the list to View stands and open the card there.
    That answers the question but throws the reader's place away: they were reading about a
    seller, and the surface they were reading vanished. The stand's detail belongs where the
    question was asked, so it expands INSIDE her card — the same expand-in-place the two lists
    already use everywhere else.
  */
  it("expands a stand's detail inside the seller's card, without leaving the list", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /fernhorn bakery/i }));
    await user.click(within(card).getByRole("button", { name: /morgan hill stand/i }));

    // Still the seller list, still her card — with the stand's own body now inside it.
    expect(screen.getByRole("tab", { name: "View sellers" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(card.querySelector(".stand-detail-body")).toBeInTheDocument();
    expect(within(card).getByText("1 Morgan Hill Rd")).toBeInTheDocument();
  });

  it("closes an expanded stand when its own row is tapped again", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /fernhorn bakery/i }));
    const row = within(card).getByRole("button", { name: /morgan hill stand/i });

    await user.click(row);
    expect(card.querySelector(".stand-detail-body")).toBeInTheDocument();

    await user.click(row);

    // Back to the list of her stands — the second tap puts it away, as everywhere else here.
    expect(card.querySelector(".stand-detail-body")).toBeNull();
    expect(card.querySelectorAll(".seller-stand-link")).toHaveLength(2);
  });

  it("shows one stand's detail at a time on a seller's card", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /fernhorn bakery/i }));
    await user.click(within(card).getByRole("button", { name: /morgan hill stand/i }));
    await user.click(within(card).getByRole("button", { name: /kelseys stand/i }));

    // Two open bodies would make one card answer "where is she" twice at once.
    expect(card.querySelectorAll(".stand-detail-body")).toHaveLength(1);
    expect(within(card).getByText("2 Kelsey Rd")).toBeInTheDocument();
  });

  it("forgets an expanded stand when the seller card is closed", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    const toggle = within(card).getByRole("button", { name: /fernhorn bakery/i });
    await user.click(toggle);
    await user.click(within(card).getByRole("button", { name: /morgan hill stand/i }));

    await user.click(toggle);
    await user.click(toggle);

    // Reopening shows her stands, not the one somebody expanded before closing the card.
    expect(card.querySelector(".stand-detail-body")).toBeNull();
  });

  it("marks the seller's own pin while one of her stands is expanded", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /fernhorn bakery/i }));
    await user.click(within(card).getByRole("button", { name: /morgan hill stand/i }));

    // Both her stands stay lit — the reader is still browsing HER, and narrowing the map to the
    // one stand they opened would hide the other place they can buy from her.
    expect(container.querySelectorAll("[data-seller-highlighted='true']")).toHaveLength(2);
  });

  /*
    THE MIRROR FACT, ON THE STAND CARD.

    A stand carrying three sellers looked identical to a stand carrying one until it was
    opened. "Three sellers here" is one of the strongest reasons to choose a stand, so the
    card says it at rest — the same place the seller card says how many stands she sells at.
  */
  it("says how many sellers a stand carries, before it is opened", async () => {
    const { container } = renderMap();

    const cards = [...container.querySelectorAll("li.stand")] as HTMLElement[];
    const busy = cards.find((card) => card.textContent?.includes("Morgan Hill Stand"))!;
    const solo = cards.find((card) => card.textContent?.includes("Kelseys Stand"))!;

    expect(busy.querySelector(".stand-seller-count")).toHaveTextContent("3 sellers");
    // Two sellers is still more than one, so it says so too.
    expect(solo.querySelector(".stand-seller-count")).toHaveTextContent("2 sellers");
  });

  it("says nothing about seller count for a stand carrying only its owner", () => {
    // Badging the normal case adds noise to every card to say nothing — the rule the open-state
    // badge already follows.
    const alone: PublicStandPayload = {
      ...soloStand,
      sellers: [soloStand.sellers![0]!],
    };
    const { container } = render(<StandMap stands={[alone]} sellers={[kelseys]} />);

    expect(container.querySelector(".stand-seller-count")).toBeNull();
  });

  /*
    ONE NAME PER SELLER ON A STAND CARD, AND IT IS THE CROSSING.

    The card names sellers in three places for three reasons, and before this they did not know
    about each other:

      the item credit    "Sourdough — Fernhorn Bakery", from the modelled `sellers`
      the roster         a list of who sells here, also from `sellers`
      `alsoSellingHere`  display strings a stand owner typed, retired as display-only history,
                         with no identity and so no card to cross to

    Rendering all three names most sellers twice and one of them un-crossably. So there is ONE
    name per seller: the item credit IS the link, because it is already where the customer's eye
    is. The roster names only the sellers no item credited — someone at the stand who has
    published nothing — and the typed names appear only for a stand with no modelled sellers at
    all, the one case they still answer anything.
  */
  it("makes the item credit itself the way to that seller's card", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();

    const busy = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Morgan Hill Stand"),
    )! as HTMLElement;
    await user.click(within(busy).getByRole("button", { name: "Morgan Hill Stand" }));

    // Named once on the whole card — as the credit beside the thing she brings.
    expect(within(busy).getAllByText("Fernhorn Bakery")).toHaveLength(1);
    // And that one name is the door.
    expect(
      within(busy).getByRole("button", { name: /go to fernhorn bakery/i }),
    ).toBeInTheDocument();
    // The typed-name fallback stays out of the way entirely.
    expect(busy.querySelector(".stand-participants")).toBeNull();
  });

  it("names a seller who has published nothing, whom no item credits", async () => {
    const user = userEvent.setup();
    const quiet: PublicStandPayload = {
      ...busyStand,
      sellers: [
        busyStand.sellers![0]!,
        // At the stand, publishing nothing. No item can credit her, so without the roster she
        // would be at a stand the card never mentions her at.
        {
          ...busyStand.sellers![1]!,
          confirmedItems: [],
          usualItems: [],
        },
      ],
    };
    const { container } = render(<StandMap stands={[quiet]} sellers={[fernhorn]} />);

    await user.click(screen.getByRole("button", { name: "Morgan Hill Stand" }));

    const roster = container.querySelector(".stand-sellers")!;
    expect(within(roster as HTMLElement).getByText("Fernhorn Bakery")).toBeInTheDocument();
    // The owner is already all over the card — its name, its items — so the roster does not
    // repeat her.
    expect(within(roster as HTMLElement).queryByText("Morgan Hill")).toBeNull();
  });

  /*
    THE POOLED "USUALLY SELLS" LINE IS GONE (max, 2026-08-18).

    It answered "what does she make" on the collapsed card. The redesign's summary row answers
    where and when instead, which is what a customer scanning a list of sellers is deciding on;
    what she makes is on the stand body her card opens, credited to her and dated there.
  */

  it("falls back to the typed names for a stand with no modelled sellers", async () => {
    const user = userEvent.setup();
    const legacy: PublicStandPayload = {
      ...busyStand,
      sellers: undefined,
      alsoSellingHere: ["Island Apiary"],
    };
    const { container } = render(<StandMap stands={[legacy]} sellers={[kelseys]} />);

    await user.click(screen.getByRole("button", { name: "Morgan Hill Stand" }));

    // Still named — a stand whose sellers were never modelled must not go silent about them.
    expect(container.querySelector(".stand-participants")).toHaveTextContent("Island Apiary");
    // But not as a link, because there is no seller record to cross to.
    expect(screen.queryByRole("button", { name: /go to island apiary/i })).toBeNull();
  });

  it("takes a tap on a seller named at a stand to that seller's card", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();

    const busy = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Morgan Hill Stand"),
    )! as HTMLElement;
    await user.click(within(busy).getByRole("button", { name: "Morgan Hill Stand" }));
    await user.click(
      within(busy).getByRole("button", { name: /go to fernhorn bakery/i }),
    );

    expect(screen.getByRole("tab", { name: "View sellers" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "Fernhorn Bakery" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  /*
    THE MAP ANSWERS THE QUESTION THE LIST IS ASKING.

    In seller mode a pin tap used to select a STAND and open the stand card — the other list's
    subject, on a list showing sellers. A customer looking at sellers who taps a pin is asking
    "who sells HERE", so the pin answers with that stand's sellers, and each is a way into the
    list they are already reading.
  */
  it("opens a tooltip naming a stand's sellers when a pin is tapped in seller mode", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    await user.click(container.querySelector("[data-stand-id='morgan-hill']")!);

    const tip = container.querySelector(".marker-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as HTMLElement).getByText("Morgan Hill Stand")).toBeInTheDocument();
    expect(within(tip as HTMLElement).getAllByRole("button", { name: /^Fernhorn Bakery$/ }))
      .toHaveLength(1);
    expect(within(tip as HTMLElement).getByText("Island Apiary")).toBeInTheDocument();
  });

  it("does not open the stand sheet from a pin while sellers are showing", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    await user.click(container.querySelector("[data-stand-id='morgan-hill']")!);

    // The sheet is the STAND list's answer. Raising it over a seller list swaps the subject
    // under the customer, which is what this whole mode exists to stop.
    expect(container.querySelector(".sheet")).toBeNull();
  });

  it("expands a seller in the list when their name is tapped in the tooltip", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);
    await user.click(container.querySelector("[data-stand-id='morgan-hill']")!);

    const tip = container.querySelector(".marker-tip")! as HTMLElement;
    await user.click(within(tip).getByRole("button", { name: /^Fernhorn Bakery$/ }));

    // Selected AND expanded — the same thing a single pin tap does to a stand card.
    expect(screen.getByRole("button", { name: "Fernhorn Bakery" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // And her stands are lit, exactly as choosing her from the list would light them.
    expect(container.querySelectorAll("[data-seller-highlighted='true']")).toHaveLength(2);
  });

  /*
    A SINGLE-SELLER STAND NEEDS NO TOOLTIP (max, 2026-08-18).

    The tooltip exists to disambiguate — "who of the several sellers here did you mean". With
    one seller there is nothing to choose between, and a menu of one is a step that asks the
    customer to confirm what the tap already said. It goes straight to her card, which is what
    the tooltip's one row would have done.
  */
  it("goes straight to the seller when a pin has only one", async () => {
    const user = userEvent.setup();
    const alone: PublicStandPayload = {
      ...busyStand,
      sellers: [busyStand.sellers![1]!],
    };
    const { container } = render(<StandMap stands={[alone]} sellers={[fernhorn]} />);
    await openSellers(user);

    await user.click(container.querySelector("[data-stand-id='morgan-hill']")!);

    expect(container.querySelector(".marker-tip")).toBeNull();
    expect(screen.getByRole("button", { name: "Fernhorn Bakery" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("still opens the tooltip when a pin has several sellers to choose between", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    await user.click(container.querySelector("[data-stand-id='morgan-hill']")!);

    expect(container.querySelector(".marker-tip")).toBeInTheDocument();
  });

  /*
    ONE SEARCH BOX FOR BOTH LISTS (max, 2026-08-18).

    The seller list had its own, on the theory that the two lists search different corpora. In
    the header they read as two search boxes on one screen, and the customer has to work out
    which one the list below is listening to. There is one question — "what am I looking for" —
    so there is one box, and the LIST decides what that word means: a stand by what is out and
    where it is, a seller by her name and what she carries.
  */
  it("filters sellers from the map's own search box", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    // The seller list's own box is gone.
    expect(container.querySelector(".seller-browse-search")).toBeNull();

    await user.type(
      screen.getByRole("searchbox", { name: /what they sell, or a farm or stand name/i }),
      "sourdough",
    );

    // Matched on an item, which is the seller corpus's own rule.
    expect(screen.getByText("Fernhorn Bakery")).toBeInTheDocument();
    expect(screen.queryByText("Kelseys Farm")).toBeNull();
  });

  it("carries one search term across a tab switch rather than two boxes", async () => {
    const user = userEvent.setup();
    renderMap();
    const box = screen.getByRole("searchbox", {
      name: /what they sell, or a farm or stand name/i,
    });
    await user.type(box, "sourdough");
    await openSellers(user);

    // Still the same box, still holding what was typed — one question asked once.
    expect(box).toHaveValue("sourdough");
    expect(screen.getByText("Fernhorn Bakery")).toBeInTheDocument();
  });

  /*
    THE SELLER CARD AT REST (max, 2026-08-18 mockup).

    Name, then one row: how many of her stands are open right now, and how long she runs. Both
    are derived from her STANDS, because a seller has no hours and no season of her own.
  */
  /*
    OPEN OR CLOSED, NOT A FRACTION (max, 2026-08-18).

    "1 of 1 stand open" makes the reader do arithmetic to reach a yes. The question a customer
    scanning this list is asking is "can I buy from her right now", and that has two answers.
    The COUNT is still what decides it — one open stand out of three is Open — but the card
    states the answer rather than the working.
  */
  it("says Open when any stand of hers is open right now", async () => {
    const user = userEvent.setup();
    const openStand: PublicStandPayload = {
      ...busyStand,
      // A season IS required for `openNow` to answer anything but `unknown` — without one there
      // is no honest way to say a stand is trading, which is the rule this card inherits.
      availability: {
        season: { kind: "year_round" },
        days: [0, 1, 2, 3, 4, 5, 6],
        hours: { kind: "all_day" },
      },
    };
    const { container } = render(
      <StandMap stands={[openStand, soloStand]} sellers={[fernhorn]} />,
    );
    await openSellers(user);

    expect(container.querySelector(".seller-open-state")).toHaveTextContent("Open");
  });

  it("says Hours unknown — not Closed — when her stands stated no hours (B-083)", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Kelseys"),
    )!;

    /*
      The fixture states no hours at all. That is NOT a closure: Closed is reserved for a stand
      out of season or outside the hours a farmer stated (max, 2026-08-18). This test previously
      asserted "Closed" and was itself the bug's record — 9 of 34 live seller cards were
      claiming a closure no farmer had made.
    */
    const badge = card.querySelector(".seller-open-state");
    expect(badge).toHaveTextContent("Hours unknown");
    expect(badge).not.toHaveTextContent("Closed");
  });

  it("carries the season badge from the stands she sells at", async () => {
    const user = userEvent.setup();
    const yearRound: PublicStandPayload = {
      ...busyStand,
      availability: { season: { kind: "year_round" } },
    };
    const { container } = render(
      <StandMap stands={[yearRound, soloStand]} sellers={[fernhorn]} />,
    );
    await openSellers(user);

    const card = container.querySelector("li.stand")!;
    expect(card.querySelector(".seller-season")).toHaveTextContent("Year-round");
  });

  it("shows no season badge when no stand of hers stated one that qualifies", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    // The fixture states no season at all — the badge is absent rather than guessed.
    expect(container.querySelector(".seller-season")).toBeNull();
  });

  /*
    A SINGLE-STAND SELLER OPENS THE STAND'S OWN DETAIL (max, 2026-08-18).

    Her card's answer to "where do I find her" has exactly one entry, and a list of one is a
    step that asks the customer to pick the only option. So it skips straight to what they came
    for: the stand's own detail — the same body the stand list renders, with its hours, its
    stock and its directions.
  */
  it("opens the stand's own detail for a seller who sells at one stand", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Kelseys"),
    )! as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /kelseys farm/i }));

    // The stand card's own body, not a list of one row pointing at it.
    expect(card.querySelector(".stand-detail-body")).toBeInTheDocument();
    expect(card.querySelectorAll(".seller-stand-link")).toHaveLength(0);
    // And her pin is lit, exactly as choosing any seller lights her stands.
    expect(container.querySelectorAll("[data-seller-highlighted='true']")).toHaveLength(1);
  });

  it("still offers the list of stands for a seller who sells at several", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /fernhorn bakery/i }));

    // Two stands is a real choice, so the choice is what the card shows.
    expect(card.querySelectorAll(".seller-stand-link")).toHaveLength(2);
    expect(container.querySelectorAll("[data-seller-highlighted='true']")).toHaveLength(2);
  });

  /*
    A SECOND TAP CLOSES THE CARD (max, 2026-08-18).

    The stand list has always worked this way — `select` clears a selection it is given again —
    and the seller list must too, or the only way to put an opened card away is to open a
    different one. Held for BOTH card shapes, because they render different bodies and it was
    the single-stand one (which renders a whole `StandDetailBody`) that broke.
  */
  it("closes a single-stand seller's card when its name is tapped again", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Kelseys"),
    )! as HTMLElement;
    const toggle = within(card).getByRole("button", { name: /kelseys farm/i });

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // And the island comes back — no pin left lit for a card nobody has open.
    expect(container.querySelectorAll("[data-seller-highlighted='true']")).toHaveLength(0);
  });

  it("closes a multi-stand seller's card when its name is tapped again", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    const toggle = within(card).getByRole("button", { name: /fernhorn bakery/i });

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll("[data-seller-highlighted='true']")).toHaveLength(0);
  });

  it("closes an open seller card when the card itself is tapped, not just its name", async () => {
    /*
      THE WHOLE CARD IS THE TARGET, exactly as it is on a stand card. The name is a small
      target on a phone, and a card that only responds to its heading reads as broken to
      someone who tapped the obvious thing — the card.
    */
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const card = [...container.querySelectorAll("li.stand")].find((node) =>
      node.textContent?.includes("Fernhorn"),
    )! as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /fernhorn bakery/i }));

    // A tap on the card's own body, away from any control.
    await user.click(card.querySelector(".seller-summary")!);

    expect(within(card).getByRole("button", { name: /fernhorn bakery/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  /*
    A CHOSEN SELLER'S PINS ARE MARKED THE WAY A CHOSEN STAND'S IS (max, 2026-08-18).

    The map has one visual language for "this is the thing you picked" — the selection halo the
    stand list already draws. The seller highlight was inventing a second one (a thin stroke on
    the pin shape), which meant the same map said "picked" two different ways depending on which
    list happened to be open. One mark, both lists.
  */
  it("draws the map's own selection halo on a chosen seller's stands", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    await user.click(screen.getByRole("button", { name: "Fernhorn Bakery" }));

    // She sells at both stands, so both carry the halo — the same element a selected stand gets.
    expect(container.querySelectorAll(".pin-selection-halo")).toHaveLength(2);
  });

  it("clears the halo when the seller is deselected", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);

    const toggle = screen.getByRole("button", { name: "Fernhorn Bakery" });
    await user.click(toggle);
    await user.click(toggle);

    expect(container.querySelectorAll(".pin-selection-halo")).toHaveLength(0);
  });

  it("still selects the stand from a pin while stands are showing", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();

    await user.click(container.querySelector("[data-stand-id='morgan-hill']")!);

    // The stand list's own behavior is untouched: no tooltip, and the card opens.
    expect(container.querySelector(".marker-tip")).toBeNull();
    expect(screen.getByRole("button", { name: "Morgan Hill Stand" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("closes the tooltip when the seller list is left", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await openSellers(user);
    await user.click(container.querySelector("[data-stand-id='morgan-hill']")!);
    expect(container.querySelector(".marker-tip")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "View stands" }));

    // A tooltip left over the map would name sellers for a list nobody is reading.
    expect(container.querySelector(".marker-tip")).toBeNull();
  });
});
