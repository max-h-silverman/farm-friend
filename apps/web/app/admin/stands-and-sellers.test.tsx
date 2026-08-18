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
    // Plain text beside the view switch (max, 2026-08-17), not an alert: how many rows there
    // are is a label for the list, and announcing it as a status made a standing fact behave
    // like news.
    expect(screen.getByTestId("entity-count")).toHaveTextContent(/2 stands/i);

    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));
    expect(screen.getByTestId("entity-count")).toHaveTextContent(/2 sellers/i);
  });

  it("says how much work is waiting without opening a card", async () => {
    // Approval is work waiting on VIGA, so it is still counted. Having no owner is NOT —
    // see the unclaimed suite below.
    render(<StandsAndSellers stands={[]} sellers={unapproved} fetcher={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    expect(screen.getByRole("status")).toHaveTextContent(/1 waiting for approval/i);
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

  it("marks a seller with no owner as unclaimed, and raises no alert about it", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    // max, 2026-08-17: a farm nobody has claimed is a STATE of the record, not work waiting.
    // Most farms start this way, so alerting on it made the alert line permanent furniture
    // and taught the operator to skip the row where a real one would appear.
    const row = screen
      .getAllByRole("listitem")
      .find((entry) => entry.textContent?.includes("Fernhorn Farm"));
    expect(row).toHaveTextContent(/unclaimed/i);

    // And it is a plain state chip, never the amber "this needs you" one.
    const chip = within(row as HTMLElement).getByText(/unclaimed/i).closest(".admin-chip");
    expect(chip).not.toBeNull();
    expect((chip as HTMLElement).className).not.toContain("admin-chip--attention");

    // Nothing above the rows says anything about it — no count, no alert.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("entity-count")).not.toHaveTextContent(/update|unclaimed|nobody/i);
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

/**
 * Reach one of the card's verbs the way an operator does: open the Actions menu, choose the
 * item. Every verb moved behind that one door, so a test that still pressed a bare button
 * would be asserting a surface the console no longer has.
 */
async function choose(card: HTMLElement, item: RegExp): Promise<void> {
  await userEvent.click(within(card).getByRole("button", { name: /^actions$/i }));
  await userEvent.click(within(card).getByRole("menuitem", { name: item }));
}

function ok(payload: unknown = {}) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
}

describe("approving a seller", () => {
  it("approves through the sellers route", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={unapproved} fetcher={fetcher} />);

    const card = await openSeller("Sprout Farm");
    await choose(card, /^approve$/i);

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
    await choose(card, /remove approval/i);

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "revoke" });
  });
});

describe("taking a seller off the map", () => {
  it("asks before removing, and sends nothing until confirmed", async () => {
    const fetcher = vi.fn();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await choose(card, /take off the map/i);

    expect(fetcher).not.toHaveBeenCalled();
    expect(within(card).getByText(/customers no longer see/i)).toBeInTheDocument();
  });

  it("retires once confirmed", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await choose(card, /take off the map/i);
    await userEvent.click(within(card).getByRole("button", { name: /^remove$/i }));

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "retire" });
  });

  it("puts a retired seller back with one click, no confirmation", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={retiredSeller} fetcher={fetcher} />);

    const card = await openSeller("Gone Farm");
    await choose(card, /put back on the map/i);

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "restore" });
  });
});

describe("the setup link", () => {
  it("mints a link and shows it on the card that made it", async () => {
    const fetcher = ok({ link: "https://ff.example/farmer/start/abc123" });
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Fernhorn Farm");
    await choose(card, /setup link/i);

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
    await userEvent.click(within(card).getByRole("button", { name: /^actions$/i }));
    expect(within(card).queryByRole("menuitem", { name: /setup link/i })).not.toBeInTheDocument();
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
    await choose(card, /mark as a test farm/i);

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "mark_test" });
  });
});

describe("editing a seller's details", () => {
  it("saves a corrected name and description", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await choose(card, /edit details/i);

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

/*
  THE CARD'S SHAPE (max, 2026-08-17).

  A card at rest is an identity, its states, and one way in. Everything an operator can do
  *about* the record hangs off the header's Actions menu, and everything they can do about one
  of its parts hangs off that part's own menu. The failure this replaces is the wrapping row of
  five to seven buttons under every open card, where "Approve" and "Take off the map" carried
  the same visual weight as the name of the farm.

  Asserted here rather than in the menu's own suite, because what matters is not that a menu
  works — it is that *these* actions are behind *this* card's menu, and that a state chip never
  becomes a control.
*/
describe("the card's actions live in one menu", () => {
  /*
    THE MENU BELONGS TO AN OPEN CARD (max, 2026-08-17).

    A closed row is a thing to read: a name, a subtitle, its states. The Actions button on
    every one of thirty closed rows put a control beside each name that could not act on
    anything the operator was looking at, and gave a list meant for scanning thirty tap
    targets. Opening the card is how you say "this one" — so the verbs arrive with the body
    they act on.
  */
  it("offers no Actions menu on a closed card", async () => {
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    // Every seller is listed and every one of them is shut.
    expect(screen.getByText("Misty Hollow Farm")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^actions$/i })).toBeNull();
  });

  it("brings the menu back when the card is opened", async () => {
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);

    const card = await openSeller("Misty Hollow Farm");

    expect(within(card).getByRole("button", { name: /^actions$/i })).toBeInTheDocument();
  });

  it("takes the menu away again when the card is closed", async () => {
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);

    await openSeller("Misty Hollow Farm");
    // The same press that opened it shuts it again.
    await userEvent.click(screen.getByText("Misty Hollow Farm"));

    expect(screen.queryByRole("button", { name: /^actions$/i })).toBeNull();
  });

  it("shows no seller controls until the Actions menu is opened", async () => {
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);

    const card = await openSeller("Misty Hollow Farm");

    expect(within(card).queryByRole("button", { name: /edit details/i })).toBeNull();
    expect(within(card).queryByRole("button", { name: /take off the map/i })).toBeNull();
    expect(within(card).getByRole("button", { name: /^actions$/i })).toBeInTheDocument();
  });

  it("offers the whole seller vocabulary behind that one menu", async () => {
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);

    const card = await openSeller("Fernhorn Farm");
    await userEvent.click(within(card).getByRole("button", { name: /^actions$/i }));

    for (const label of [
      /edit details/i,
      /^approve$|remove approval/i,
      /setup link/i,
      /test farm/i,
      /take off the map/i,
    ]) {
      expect(within(card).getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("keeps a state chip a fact, never a button", async () => {
    render(<StandsAndSellers stands={stands} sellers={unapproved} fetcher={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    // The chip says what is true of the record. The operator acts through the menu, so a chip
    // that could be pressed would be a second, undiscoverable way to do the same thing.
    const card = screen.getByRole("group", { name: /sprout farm/i });
    const chip = within(card).getByText(/waiting for approval/i);
    expect(chip.closest("button")).toBeNull();
  });
});

describe("a stand row inside a seller card", () => {
  it("lists each stand with its own menu rather than a nested form", async () => {
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);

    const card = await openSeller("Fernhorn Farm");
    const stands_ = within(card).getByRole("group", { name: /stands/i });

    // Two arrangements, two rows, each naming the stand and carrying its own way in.
    expect(
      within(stands_).getByRole("button", { name: /selling at Misty Hollow Stand/i }),
    ).toBeInTheDocument();
    expect(
      within(stands_).getByRole("button", { name: /selling at Harbor Stand/i }),
    ).toBeInTheDocument();
  });

  it("puts Remove behind the row's own menu, still asking before it acts", async () => {
    const fetcher = vi.fn();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Fernhorn Farm");
    await userEvent.click(
      within(card).getByRole("button", { name: /selling at Harbor Stand/i }),
    );
    await userEvent.click(within(card).getByRole("menuitem", { name: /remove/i }));

    expect(fetcher).not.toHaveBeenCalled();
    expect(within(card).getByText(/cannot be undone/i)).toBeInTheDocument();
  });
});

/*
  ONE IDENTITY PER CARD (max, 2026-08-17).

  On the Stands view the card header IS the stand — its name, its chips, its way in. The stand's
  own detail block used to restate all three inside the body, which left two controls with the
  same accessible name on one card and a screen reader with no way to tell them apart. The body
  carries the stand's facts and its verbs; the head carries who it is.
*/
describe("a stand card names the stand once", () => {
  it("gives the card exactly one way into the stand's verbs", async () => {
    const withDetails: StandCard[] = [
      {
        ...(stands[1] as StandCard),
        details: {
          standId: "stand-2",
          name: "Harbor Stand",
          farmName: "Fernhorn Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "not_eligible",
          metadata: {
            name: "Harbor Stand",
            publicAddress: "9 Harbor Rd",
            addressPublic: true,
            latitude: 47.4,
            longitude: -122.4,
            hoursText: "Dawn to dusk",
          },
          sections: [{ title: "Where", items: [["Address", "9 Harbor Rd"]] }],
        },
      },
    ];
    render(<StandsAndSellers stands={withDetails} sellers={sellers} fetcher={vi.fn()} />);
    await userEvent.click(screen.getByText("Harbor Stand"));

    const card = screen.getByRole("group", { name: /harbor stand/i });
    expect(within(card).getAllByRole("button", { name: /more for harbor stand/i })).toHaveLength(1);
    // And the name is written once: the head says who this is, the body says what is true of it.
    expect(within(card).getAllByText("Harbor Stand")).toHaveLength(1);
  });
});
