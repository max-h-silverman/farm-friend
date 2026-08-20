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

/** The one-line summary on a card's closed row: its live state and its count. */
function summaryFor(name: string): string {
  const row = screen.getByRole("group", { name }).querySelector(".admin-row-summary");
  if (row === null) throw new Error(`no summary on the card for ${name}`);
  return row.textContent ?? "";
}

/** The stand's own details, which is where its controls (trash included) actually live. */
const standDetails = {
  standId: "stand-1",
  farmId: "farm-of-stand-1",
  name: "Misty Hollow Stand",
  farmName: "Misty Hollow Farm",
  status: "On the map",
  openState: "Open now",
  approved: true,
  retired: false,
  retiredWithFarm: false,
  farmBucksStatus: "accepts" as const,
  metadata: {
    name: "Misty Hollow Stand",
    publicAddress: null,
    addressPublic: false,
    latitude: null,
    longitude: null,
    hoursText: null,
  },
  sections: [],
};

/** A stand and a seller that are in the trash, for the Trash section's own suite. */
const trashedStands: StandCard[] = [
  {
    standId: "stand-trashed",
    name: "Old Roadside Stand",
    farmName: "Misty Hollow Farm",
    approved: true,
    retired: true,
    providers: [],
  },
];

const trashedSellers: SellerCard[] = [
  {
    farmId: "seller-trashed",
    name: "Departed Farm",
    approved: true,
    retired: true,
    isTestFarm: false,
    providers: [],
    access: [],
  },
];

/*
  Invites live HERE now (max, 2026-08-19), collapsed at the top of Stands & Sellers.

  Inviting a farmer and the invitations already out are both about a STAND OR SELLER joining the
  roster — the subject of this screen — where the SMS Users tab is about handsets that have
  texted us. "Waiting for your decision" is now "Open invites", which says what the rows ARE
  rather than how they make an operator feel about them.

  **Collapsed, because it is not the daily work.** The roster is what an operator comes here for;
  an invite is occasional. A section that opened by default would push the list an operator came
  to read below the fold every visit.
*/
describe("invites sit at the top of this screen, collapsed", () => {
  const invites = {
    requests: [
      {
        requestId: "request-1",
        senderMask: "(•••) •••-4320",
        requestedAt: new Date("2026-08-13T12:00:00Z").toISOString(),
        farmId: "seller-1",
        farmName: "Misty Hollow Farm",
      },
    ],
    sellers: [{ farmId: "seller-1", name: "Misty Hollow Farm" }],
  };

  function renderWithInvites() {
    return render(
      <StandsAndSellers stands={stands} sellers={sellers} invites={invites} fetcher={vi.fn()} />,
    );
  }

  it("names the section Invites and keeps it shut until asked", () => {
    renderWithInvites();

    const section = screen.getByRole("group", { name: /invites/i });
    expect(
      section.querySelector("details")?.hasAttribute("open") ?? section.hasAttribute("open"),
      "the roster is the daily work; an invite is occasional",
    ).toBe(false);
  });

  it("puts the section above the roster, not below it", () => {
    const { container } = renderWithInvites();

    const section = screen.getByRole("group", { name: /invites/i });
    const tabs = screen.getByRole("tablist", { name: /stands or sellers/i });
    expect(
      section.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
      "an operator reads the section heading before the list it sits above",
    ).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it("opens to reveal both the invite form and the open invites", async () => {
    renderWithInvites();

    await userEvent.click(screen.getByRole("group", { name: /invites/i }).querySelector("summary") as Element);

    expect(screen.getByRole("heading", { name: /invite a farmer/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /open invites/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /waiting for your decision/i }),
      "the old name said how it felt rather than what the rows are",
    ).not.toBeInTheDocument();
  });

  it("renders nothing at all when no invites were supplied", () => {
    // The prop is optional so a screen that does not carry invites — or a test that does not
    // care about them — is not forced to invent an empty one.
    renderPage();
    expect(screen.queryByRole("group", { name: /invites/i })).not.toBeInTheDocument();
  });
});

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

  it("summarises each row as its live state and how many sell there", async () => {
    /*
      F-124 (max, 2026-08-19). ONE summary per card carrying two facts, replacing both the
      chip row and the separate amber attention line — two parallel mechanisms describing the
      same record become one.

      A stand nobody sells at reads `0 sellers`, which is the problem stating itself. That is
      why there is no second label competing for the same space.
    */
    renderPage();
    expect(summaryFor("Misty Hollow Stand")).toMatch(/2 sellers/);
    expect(summaryFor("Harbor Stand")).toMatch(/1 seller\b/);

    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));
    // Fernhorn sells at two stands; the seller's count is the other side of the same relation.
    expect(summaryFor("Fernhorn Farm")).toMatch(/2 stands/);
    expect(summaryFor("Misty Hollow Farm")).toMatch(/1 stand\b/);
  });

  it("counts nobody as zero rather than staying silent", async () => {
    render(<StandsAndSellers stands={[]} sellers={unapproved} fetcher={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    expect(summaryFor("Sprout Farm")).toMatch(/0 stands/);
  });

  it("says a record is off the map instead of its count", async () => {
    // A retired record's live state is the whole answer: how many sell there describes a
    // listing nobody is being shown.
    render(<StandsAndSellers stands={[]} sellers={retiredSeller} fetcher={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    expect(summaryFor("Gone Farm")).toMatch(/off the map/i);
    expect(summaryFor("Gone Farm")).not.toMatch(/\d+ stands?/);
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

  it("shows a solo stand as a plain fact rather than as a list of one", async () => {
    renderPage();

    await userEvent.click(screen.getByText("Harbor Stand"));
    const card = screen.getByRole("group", { name: /Harbor Stand/i });

    // The control names the ARRANGEMENT, never the stand's open-now state (B-084) — that fact
    // belongs to the card's header, which computes it from season and hours.
    expect(within(card).getByRole("switch", { name: /selling here/i })).toBeInTheDocument();
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

    // It REPLACES "Live" in the one summary rather than sitting beside it: a farm nobody can
    // publish for is not live in any useful sense (F-124).
    expect(summaryFor("Fernhorn Farm")).toMatch(/unclaimed/i);
    expect(summaryFor("Fernhorn Farm")).not.toMatch(/live/i);
    // A farm somebody CAN publish for is the mirror, so "Unclaimed" is not simply always shown.
    expect(summaryFor("Misty Hollow Farm")).toMatch(/live/i);

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

/** The same, on the stands view, which is the one the screen opens on. */
async function openStand(name: string): Promise<HTMLElement> {
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

/*
  F-124 — approval and test-farm marking are GONE from the console (max, 2026-08-19).

  Approval is safe to remove because onboarding redemption auto-approves, so the only
  unapproved farm is one VIGA explicitly revoked — and with no toggle, nobody can revoke.
  Publication still refuses with `not_approved`, so the gate itself is untouched.

  Test-farm marking becomes a script-only operation, which max was told and accepted.

  Asserted as the ABSENCE of the controls, and the route suite separately asserts the server
  stopped honouring the actions. A button that merely disappeared while the endpoint kept
  working would not be a removal.
*/
describe("approval and test-farm marking are gone", () => {
  it("offers no approval control, on an approved seller or an unapproved one", async () => {
    for (const roster of [sellers, unapproved]) {
      const { unmount } = render(
        <StandsAndSellers stands={stands} sellers={roster} fetcher={vi.fn()} />,
      );
      const card = await openSeller(roster[0]?.name as string);
      await userEvent.click(within(card).getByRole("button", { name: /^actions$/i }));
      const items = within(card)
        .getAllByRole("menuitem")
        .map((item) => item.textContent ?? "");
      expect(items.join(" | ")).not.toMatch(/approv/i);
      unmount();
    }
  });

  it("offers no test-farm control", async () => {
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={vi.fn()} />);
    const card = await openSeller("Misty Hollow Farm");
    await userEvent.click(within(card).getByRole("button", { name: /^actions$/i }));
    const items = within(card)
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
    expect(items.join(" | ")).not.toMatch(/test farm/i);
  });

  it("never says a seller is waiting for approval", async () => {
    // The summary line and the card body both used to carry it. An operator cannot act on
    // approval any more, so naming it would describe work nobody can do.
    render(<StandsAndSellers stands={[]} sellers={unapproved} fetcher={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    expect(screen.queryByText(/waiting for approval/i)).not.toBeInTheDocument();
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

/*
  F-124 — the trash, and the section that restores from it.

  Trash and off-the-map are two decisions, not two names for one. Off the map is the everyday
  reversible hide: the record is still VIGA's, still in the roster, just not shown to customers.
  Trash means "this should not be in my list at all", so a trashed record leaves the roster
  entirely and is reachable only here.

  **Nothing here destroys anything.** Every revision, report and authorization survives a
  trashing untouched, which is exactly what lets a restore put back the record rather than an
  approximation of it. "Empty the trash" is deliberately not built.
*/
describe("moving a stand or seller to the trash", () => {
  it("asks before trashing, and sends nothing until confirmed", async () => {
    const fetcher = vi.fn();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await choose(card, /move to trash/i);

    expect(fetcher).not.toHaveBeenCalled();
    // The confirmation says what happens AND that it is reversible — the second half is what
    // makes the control safe to reach for.
    const prompt = within(card).getByText(/leaves your list/i);
    expect(prompt).toBeInTheDocument();
    expect(within(card).getByText(/put it back|restore/i)).toBeInTheDocument();
  });

  it("trashes a seller once confirmed", async () => {
    const fetcher = ok();
    render(<StandsAndSellers stands={stands} sellers={sellers} fetcher={fetcher} />);

    const card = await openSeller("Misty Hollow Farm");
    await choose(card, /move to trash/i);
    await userEvent.click(within(card).getByRole("button", { name: /^move to trash$/i }));

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/sellers");
    expect(JSON.parse(init.body as string)).toMatchObject({
      farmId: "seller-misty",
      action: "trash",
    });
  });

  it("trashes a stand through the stands route", async () => {
    /*
      The stand card's controls live in `StandDetails`, which reaches the network through the
      global `fetch` rather than the injected fetcher this screen threads to the seller cards.
      Stubbing the global is what drives the REAL control instead of a second copy of it — and
      the wire is the assertion, because that is what a refactor can silently break while the
      button still renders.
    */
    const fetcher = ok();
    const original = globalThis.fetch;
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      render(
        <StandsAndSellers
          stands={[{ ...(stands[0] as StandCard), details: standDetails }]}
          sellers={sellers}
          fetcher={vi.fn()}
        />,
      );

      const card = await openStand("Misty Hollow Stand");
      await userEvent.click(
        within(card).getByRole("button", { name: /more for Misty Hollow Stand/i }),
      );
      await userEvent.click(within(card).getByRole("menuitem", { name: /move to trash/i }));
      await userEvent.click(within(card).getByRole("button", { name: /^move to trash$/i }));

      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/admin/stands");
      expect(JSON.parse(init.body as string)).toMatchObject({
        standId: "stand-1",
        action: "trash",
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the Trash section", () => {
  function renderWithTrash(fetcher = vi.fn()) {
    return render(
      <StandsAndSellers
        stands={stands}
        sellers={sellers}
        trash={{ stands: trashedStands, sellers: trashedSellers }}
        fetcher={fetcher}
      />,
    );
  }

  it("sits below the roster and stays shut until asked", () => {
    renderWithTrash();
    const trash = screen.getByRole("group", { name: /^trash$/i });
    expect(trash).not.toHaveAttribute("open");

    // Below the roster, where Invites sits above it: the trash is where an operator goes to
    // undo something, not what they came to read.
    const switcher = screen.getByTestId("entity-count");
    expect(
      switcher.compareDocumentPosition(trash) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("counts what is in it without being opened", () => {
    renderWithTrash();
    // One stand and one seller. An operator should not have to open the section to learn
    // whether anything is in there.
    expect(within(screen.getByRole("group", { name: /^trash$/i })).getByText("2")).toBeInTheDocument();
  });

  it("renders nothing at all when the trash is empty", () => {
    render(
      <StandsAndSellers
        stands={stands}
        sellers={sellers}
        trash={{ stands: [], sellers: [] }}
        fetcher={vi.fn()}
      />,
    );
    expect(screen.queryByRole("group", { name: /^trash$/i })).not.toBeInTheDocument();
  });

  it("lists both trashed stands and trashed sellers once opened", async () => {
    renderWithTrash();
    await userEvent.click(screen.getByText(/^trash$/i));

    const trash = screen.getByRole("group", { name: /^trash$/i });
    expect(within(trash).getByText("Old Roadside Stand")).toBeInTheDocument();
    expect(within(trash).getByText("Departed Farm")).toBeInTheDocument();
  });

  it("keeps a trashed record out of the roster it left", async () => {
    // The two partition the records between them. A trashed stand appearing in both would
    // mean trashing had not actually removed it from the operator's list.
    renderWithTrash();
    expect(screen.getByTestId("entity-count")).toHaveTextContent(/2 stands/i);

    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));
    expect(screen.getByTestId("entity-count")).toHaveTextContent(/2 sellers/i);
    expect(screen.queryByRole("group", { name: "Departed Farm" })).not.toBeInTheDocument();
  });

  it("restores a stand with one press, no confirmation", async () => {
    // Restoring puts something BACK. Refusing to make it easy only strands the operator, and
    // the mistake it undoes is the one trashing just made (the same rule as un-retiring).
    const fetcher = ok();
    renderWithTrash(fetcher);
    await userEvent.click(screen.getByText(/^trash$/i));

    const trash = screen.getByRole("group", { name: /^trash$/i });
    await userEvent.click(
      within(trash).getByRole("button", { name: /put back.*Old Roadside Stand/i }),
    );

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/stands");
    expect(JSON.parse(init.body as string)).toMatchObject({
      standId: "stand-trashed",
      action: "restore_from_trash",
    });
  });

  it("restores a seller through the sellers route", async () => {
    const fetcher = ok();
    renderWithTrash(fetcher);
    await userEvent.click(screen.getByText(/^trash$/i));

    const trash = screen.getByRole("group", { name: /^trash$/i });
    await userEvent.click(
      within(trash).getByRole("button", { name: /put back.*Departed Farm/i }),
    );

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/sellers");
    expect(JSON.parse(init.body as string)).toMatchObject({
      farmId: "seller-trashed",
      action: "restore_from_trash",
    });
  });

  it("takes a restored record out of the trash without a reload", async () => {
    const fetcher = ok();
    renderWithTrash(fetcher);
    await userEvent.click(screen.getByText(/^trash$/i));

    const trash = screen.getByRole("group", { name: /^trash$/i });
    await userEvent.click(
      within(trash).getByRole("button", { name: /put back.*Departed Farm/i }),
    );

    expect(await within(trash).findByText(/back in your list/i)).toBeInTheDocument();
    expect(within(trash).queryByText("Departed Farm")).not.toBeInTheDocument();
  });

  it("says so plainly when a restore fails, and keeps the row", async () => {
    // The row staying is the point: a disappeared row would tell the operator the restore
    // worked. Fails loudly rather than silently (Golden Rule: fail loudly).
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "not_trashed" }), { status: 409 }));
    renderWithTrash(fetcher);
    await userEvent.click(screen.getByText(/^trash$/i));

    const trash = screen.getByRole("group", { name: /^trash$/i });
    await userEvent.click(
      within(trash).getByRole("button", { name: /put back.*Departed Farm/i }),
    );

    expect(await within(trash).findByText(/did not go through|could not/i)).toBeInTheDocument();
    expect(within(trash).getByText("Departed Farm")).toBeInTheDocument();
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
      /setup link/i,
      /take off the map/i,
      /move to trash/i,
    ]) {
      expect(within(card).getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("keeps the summary a fact, never a button", async () => {
    render(<StandsAndSellers stands={stands} sellers={unapproved} fetcher={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: /sellers/i }));

    // The summary says what is true of the record. The operator acts through the menu, so a
    // pressable summary would be a second, undiscoverable way to do the same thing.
    const card = screen.getByRole("group", { name: /sprout farm/i });
    const summary = within(card).getByText(/unclaimed/i);
    expect(summary.closest("button")).toBeNull();
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
          farmId: "farm-of-stand-2",
          name: "Harbor Stand",
          farmName: "Fernhorn Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "does_not_accept",
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
