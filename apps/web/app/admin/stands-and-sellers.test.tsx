// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StandsAndSellers, type SellerCard, type StandCard } from "./stands-and-sellers";

/*
  F-101 — Stands & Sellers, one destination holding two views.

  THE RULE THIS OWNS (max, 2026-08-17): **the lists are entities, not states.** One row per
  stand, one row per seller, and a participation is never a row in either. A seller at three
  stands is one row in Sellers; a stand with three sellers is one row in Stands. That is what
  keeps a volunteer from having to understand the data model to read the screen.

  The controls themselves live in `SellerParticipation` and are asserted in its own suite. What
  is asserted here is the structure: which entities appear, how many rows they occupy, and that
  switching views changes the subject rather than the data.
*/

const stands: StandCard[] = [
  {
    standId: "stand-1",
    name: "Misty Hollow Stand",
    farmName: "Misty Hollow Farm",
    approved: true,
    retired: false,
    providers: [
      {
        providerId: "p-host-1",
        salesLocationId: "stand-1",
        standName: "Misty Hollow Stand",
        sellerId: "seller-misty",
        sellerName: "Misty Hollow Farm",
        lifecycleState: "active",
        nativeSeller: true,
        ended: false,
      },
      {
        providerId: "p-guest-1",
        salesLocationId: "stand-1",
        standName: "Misty Hollow Stand",
        sellerId: "seller-fern",
        sellerName: "Fernhorn Farm",
        lifecycleState: "active",
        nativeSeller: false,
        ended: false,
      },
    ],
  },
  {
    standId: "stand-2",
    name: "Harbor Stand",
    farmName: "Fernhorn Farm",
    approved: true,
    retired: false,
    providers: [
      {
        providerId: "p-host-2",
        salesLocationId: "stand-2",
        standName: "Harbor Stand",
        sellerId: "seller-fern",
        sellerName: "Fernhorn Farm",
        lifecycleState: "active",
        nativeSeller: true,
        ended: false,
      },
    ],
  },
];

const sellers: SellerCard[] = [
  {
    farmId: "seller-misty",
    name: "Misty Hollow Farm",
    approved: true,
    retired: false,
    isTestFarm: false,
    providers: [stands[0]?.providers[0] as StandCard["providers"][number]],
    access: [
      {
        authorizationId: "auth-1",
        senderMask: "•••• 4821",
        authorizedAt: "2026-06-01T00:00:00.000Z",
        revokedAt: null,
      },
    ],
  },
  {
    farmId: "seller-fern",
    name: "Fernhorn Farm",
    approved: true,
    retired: false,
    isTestFarm: false,
    // Fernhorn sells at her own stand AND at Misty Hollow's — two arrangements, ONE row.
    providers: [
      stands[0]?.providers[1] as StandCard["providers"][number],
      stands[1]?.providers[0] as StandCard["providers"][number],
    ],
    // Revoked, so nobody can publish for her — the state the roster exists to make visible.
    access: [
      {
        authorizationId: "auth-2",
        senderMask: "•••• 7733",
        authorizedAt: "2026-05-01T00:00:00.000Z",
        revokedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
  },
];

/** A seller nobody has approved yet, and one VIGA has taken off the map. */
const unapproved: SellerCard[] = [
  {
    farmId: "seller-sprout",
    name: "Sprout Farm",
    approved: false,
    retired: false,
    isTestFarm: false,
    providers: [],
    access: [],
  },
];

const retiredSeller: SellerCard[] = [
  {
    farmId: "seller-gone",
    name: "Gone Farm",
    approved: true,
    retired: true,
    isTestFarm: false,
    providers: [],
    access: [],
  },
];

function renderPage() {
  return render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);
}

describe("one destination, two views", () => {
  it("opens on the stands view", () => {
    renderPage();

    expect(screen.getByRole("tab", { name: /stands/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /sellers/i })).toHaveAttribute("aria-selected", "false");
  });

  it("switches to the sellers view without leaving the page", async () => {
    renderPage();

    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    expect(screen.getByRole("tab", { name: /sellers/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /stands/i })).toHaveAttribute("aria-selected", "false");
  });
});

describe("the lists are entities, not states", () => {
  it("gives each stand exactly one row", () => {
    renderPage();

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Misty Hollow Stand");
    expect(rows[1]).toHaveTextContent("Harbor Stand");
  });

  it("gives a seller at two stands exactly one row", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Fernhorn has two arrangements and must still be one row — the count is farms, not
    // relationships, and a volunteer reading "3 sellers" for 2 farms would be misled.
    expect(rows.filter((row) => row.textContent?.includes("Fernhorn Farm"))).toHaveLength(1);
  });

  it("counts entities, never arrangements", async () => {
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent(/2 stands/i);

    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/2 sellers/i);
  });

  it("says how much work is waiting without opening a card", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    // Fernhorn's only authorization is revoked, so one seller has nobody who can update it.
    // The count belongs above the rows it describes — an operator must not have to open every
    // card to discover there is work.
    expect(screen.getByRole("status")).toHaveTextContent(/1 .*nobody who can update/i);
  });
});

describe("a stand shows who sells there", () => {
  it("names the other sellers once a stand is shared", async () => {
    renderPage();

    await userEvent.click(screen.getByText("Misty Hollow Stand"));
    const card = screen.getByRole("group", { name: /Misty Hollow Stand/i });

    expect(within(card).getByRole("switch", { name: /Misty Hollow Farm/i })).toBeInTheDocument();
    expect(within(card).getByRole("switch", { name: /Fernhorn Farm/i })).toBeInTheDocument();
  });

  it("shows a solo stand as open rather than as a list of one", async () => {
    renderPage();

    await userEvent.click(screen.getByText("Harbor Stand"));
    const card = screen.getByRole("group", { name: /Harbor Stand/i });

    expect(within(card).getByRole("switch", { name: /stand is open/i })).toBeInTheDocument();
    expect(within(card).queryByRole("list")).not.toBeInTheDocument();
  });
});

describe("a seller shows where she sells", () => {
  it("lists both stands for a seller who sells at two", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    await userEvent.click(screen.getByText("Fernhorn Farm"));
    const card = screen.getByRole("group", { name: /Fernhorn Farm/i });

    expect(within(card).getByRole("switch", { name: /Misty Hollow Stand/i })).toBeInTheDocument();
    expect(within(card).getByRole("switch", { name: /Harbor Stand/i })).toBeInTheDocument();
  });

  it("shows a seller at one stand as a plain fact", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    await userEvent.click(screen.getByText("Misty Hollow Farm"));
    const card = screen.getByRole("group", { name: /Misty Hollow Farm/i });

    expect(within(card).queryByRole("list")).not.toBeInTheDocument();
    // The stand framing belongs to the stands view only; here the subject is the arrangement.
    expect(within(card).queryByText(/stand is (open|closed)/i)).not.toBeInTheDocument();
  });

  it("shows who can update the seller's listing, masked", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    await userEvent.click(screen.getByText("Misty Hollow Farm"));
    const card = screen.getByRole("group", { name: /Misty Hollow Farm/i });

    // Who may publish for a farm is part of viewing that farm (max, 2026-08-17). It has no
    // screen of its own, so if it is not here it is nowhere — and `/api/admin/farmers` and
    // its revoke control become dead surface.
    expect(within(card).getByText(/•••• 4821/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /revoke .*4821/i })).toBeInTheDocument();
    // A phone number never reaches the browser: the server masks at the query boundary.
    expect(card.textContent).not.toMatch(/\d{3}-?\d{3}-?\d{4}/);
  });

  it("says so plainly when nobody can update the seller's listing", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    await userEvent.click(screen.getByText("Fernhorn Farm"));
    const card = screen.getByRole("group", { name: /Fernhorn Farm/i });

    expect(within(card).getByText(/nobody can update/i)).toBeInTheDocument();
  });
});

/*
  The controls that used to live on the old farm card, which no page rendered any more. They
  are here because VIGA's job is to view and edit sellers (max, 2026-08-17) — each is a thing
  an operator does while looking at a seller, not a screen of its own.

  Each asserts the WIRE — the request that actually goes out — because that is what a migration
  between components can silently break while the button still renders.
*/
async function openSeller(name: string): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));
  await userEvent.click(screen.getByText(name));
  return screen.getByRole("group", { name: new RegExp(name, "i") });
}

function ok(payload: unknown = {}) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
}

describe("approving a seller", () => {
  it("approves through the sellers route", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={unapproved} fetcher={fetcher} />);

    const card = await openSeller("Sprout Farm");
    await userEvent.click(within(card).getByRole("button", { name: /^approve$/i }));

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/sellers");
    expect(JSON.parse(init.body as string)).toMatchObject({
      farmId: "seller-sprout",
      action: "approve",
    });
    expect(await within(card).findByText(/can publish updates/i)).toBeInTheDocument();
  });

  it("removes approval from an approved seller", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await userEvent.click(within(card).getByRole("button", { name: /remove approval/i }));

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "revoke" });
  });
});

describe("taking a seller off the map", () => {
  it("asks before removing, and sends nothing until confirmed", async () => {
    const fetcher = vi.fn();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await userEvent.click(within(card).getByRole("button", { name: /take off the map/i }));

    expect(fetcher).not.toHaveBeenCalled();
    expect(within(card).getByText(/customers no longer see/i)).toBeInTheDocument();
  });

  it("retires once confirmed", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await userEvent.click(within(card).getByRole("button", { name: /take off the map/i }));
    await userEvent.click(within(card).getByRole("button", { name: /^remove$/i }));

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "retire" });
  });

  it("puts a retired seller back with one click, no confirmation", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={retiredSeller} fetcher={fetcher} />);

    const card = await openSeller("Gone Farm");
    await userEvent.click(within(card).getByRole("button", { name: /put back on the map/i }));

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "restore" });
  });
});

describe("the setup link", () => {
  it("mints a link and shows it on the card that made it", async () => {
    const fetcher = ok({ link: "https://ff.example/farmer/start/abc123" });
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Fernhorn Farm");
    await userEvent.click(within(card).getByRole("button", { name: /setup link/i }));

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/farmers");
    expect(JSON.parse(init.body as string)).toMatchObject({
      action: "create_invite",
      farmId: "seller-fern",
      channel: "sms",
    });
    // Shown ON THIS CARD: it is never re-readable from the server, so a link that appeared
    // somewhere else on the page would be a credential the operator could lose track of.
    expect(await within(card).findByText(/ff\.example\/farmer\/start\/abc123/)).toBeInTheDocument();
    // The lifetime belongs in the label — "link" alone is what made the two links
    // indistinguishable to a volunteer.
    expect(within(card).getByText(/7 days/i)).toBeInTheDocument();
  });
});

describe("the setup link is offered only where it solves something", () => {
  it("offers no setup link to a seller who already has someone who can update it", async () => {
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);

    // Misty Hollow has a live authorization. The button would invite the operator to solve a
    // problem this farm does not have.
    const card = await openSeller("Misty Hollow Farm");
    expect(within(card).queryByRole("button", { name: /setup link/i })).not.toBeInTheDocument();
  });

  it("says an earlier link cannot be looked up, so nobody waits for one", async () => {
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);

    const card = await openSeller("Fernhorn Farm");
    // The operator must not be left thinking the old link can be recovered — it cannot, and
    // the copy has to say so rather than letting them assume otherwise.
    expect(within(card).getByText(/cannot be looked up/i)).toBeInTheDocument();
  });
});

describe("test farms", () => {
  it("marks a seller as a test farm", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await userEvent.click(within(card).getByRole("button", { name: /mark as a test farm/i }));

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "mark_test" });
  });
});

describe("editing a seller's details", () => {
  it("saves a corrected name and description", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await userEvent.click(within(card).getByRole("button", { name: /edit details/i }));

    const name = within(card).getByLabelText(/farm name/i);
    await userEvent.clear(name);
    await userEvent.type(name, "Misty Hollow Farmstead");
    await userEvent.click(within(card).getByRole("button", { name: /^save$/i }));

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      action: "save_details",
      name: "Misty Hollow Farmstead",
    });
  });
});
