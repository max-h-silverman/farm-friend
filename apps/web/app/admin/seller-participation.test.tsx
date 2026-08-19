// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SellerParticipation, type ParticipationRow } from "./seller-participation";

/*
  F-101 — the pause/resume toggle and Remove, on both admin views.

  THE RULES THIS OWNS (max, 2026-08-17). The whole aim is that a VIGA volunteer never has to
  understand the data model to run the system, and every assertion here is one presentation
  consequence of that:

    - **The singular case is not a list.** One arrangement renders as a plain fact with its
      control, with no list chrome. This is a rendering rule, not a data one.
    - **On a solo native-seller stand the toggle reads as the stand being open or closed**,
      because on that stand that is its true effect. The moment a second seller exists the
      framing becomes a per-seller list, and the label must NEVER say "closed" while another
      seller is still live there — the failure the adapting label exists to prevent.
    - **Remove is terminal and asks first.** There is no restore; returning is a fresh
      invitation. A confirmation stands between a misclick and a real seller's listing.

  The authority rules themselves are the seam's and the route's, asserted there. What is
  asserted here is the shape, the wire, and the copy.
*/

const host: ParticipationRow = {
  providerId: "provider-host",
  salesLocationId: "stand-1",
  standName: "Misty Hollow Stand",
  sellerId: "seller-host",
  sellerName: "Misty Hollow Farm",
  lifecycleState: "active",
  nativeSeller: true,
  ended: false,
};

const guest: ParticipationRow = {
  providerId: "provider-guest",
  salesLocationId: "stand-1",
  standName: "Misty Hollow Stand",
  sellerId: "seller-guest",
  sellerName: "Fernhorn Farm",
  lifecycleState: "active",
  nativeSeller: false,
  ended: false,
};

function renderStand(rows: ParticipationRow[], fetcher = vi.fn()) {
  return render(<SellerParticipation view="stand" rows={rows} fetcher={fetcher} />);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the singular case does not look like a list", () => {
  it("renders a solo native seller as a plain fact, with no list item", () => {
    renderStand([host]);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("renders a list once a second seller sells at the stand", () => {
    renderStand([host, guest]);

    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("the participation label", () => {
  /*
    B-084 — THE CONTROL NAMES THE ARRANGEMENT, NEVER THE STAND'S OPEN-NOW STATE (max, 2026-08-18).

    It used to read "Stand is open" / "Stand is closed" on a solo native seller. That is a
    DIFFERENT FACT from the one the card's own header computes from season and hours, and the two
    contradicted each other in production: Lavender Hill Farm showed "Not open — out of season"
    (season ended 8/1) directly above "Stand is open" (her arrangement is active). Both were
    true; only the labelling made them look like a conflict.

    Participation is whether she is still selling here at all. Open-now is whether you can buy
    today. The header owns the second one because it is the only thing that computes it, so this
    control says nothing about it.

    `paused` rather than "not active": a paused arrangement is REVERSIBLE and still reachable —
    she keeps her reminders and re-opens by texting an update — where an ended one is terminal
    and takes the row with it. A label that blurred the two would flatten a distinction the
    operator acts on.
  */
  it("names the seller and says she is selling, never that the stand is open", () => {
    /*
      B-085 — THE ROW ANSWERS THE HEADING. "Also selling here" followed by a bare "Selling here"
      names nobody: B-084 dropped the seller's name from a solo native row on the grounds that
      it repeated the stand's, and under that heading the row stopped answering the question it
      sits beneath. Every row names its seller, solo or not.
    */
    renderStand([host]);

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAccessibleName(/Misty Hollow Farm/i);
    expect(toggle).toHaveAccessibleName(/selling/i);
    expect(toggle).toBeChecked();
    // The open-now claim stays gone; the header computes that fact, not this control.
    expect(toggle).not.toHaveAccessibleName(/stand is (open|closed)/i);
  });

  it("names the seller on a solo row in the rendered text, not only the label", () => {
    // The visible row, not just the accessible name — the screenshot bug was what a sighted
    // operator read.
    const { container } = renderStand([host]);
    const subject = container.querySelector(".admin-participation-subject");
    expect(subject).toHaveTextContent("Misty Hollow Farm");
  });

  it("says paused and still names her, never that the stand is closed", () => {
    renderStand([{ ...host, lifecycleState: "paused" }]);

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAccessibleName(/paused/i);
    expect(toggle).toHaveAccessibleName(/Misty Hollow Farm/i);
    expect(toggle).not.toBeChecked();
    expect(toggle).not.toHaveAccessibleName(/stand is (open|closed)/i);
  });

  it("makes no open-or-closed claim anywhere in the control, in either state", () => {
    /*
      Asserts the ABSENCE of the wrong behaviour rather than the presence of the right one: a
      future author reaching for "closed" to describe a paused arrangement reintroduces the
      contradiction, and a label test that only checks for "Paused" would not notice.
    */
    for (const state of ["active", "paused"] as const) {
      const { unmount } = renderStand([{ ...host, lifecycleState: state }]);
      expect(screen.queryByText(/stand is (open|closed)/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("never says the stand is closed while another seller is still live there", () => {
    // The native seller is paused, but a guest is still selling: the stand is NOT closed, and
    // saying so would be a lie the volunteer acts on.
    renderStand([{ ...host, lifecycleState: "paused" }, guest]);

    expect(screen.queryByText(/stand is closed/i)).not.toBeInTheDocument();
    const toggles = screen.getAllByRole("switch");
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle).not.toHaveAccessibleName(/stand is (open|closed)/i);
    }
  });

  it("keeps the seller's name on a shared stand, where it distinguishes", () => {
    /*
      The subject survives the rename. On a stand with three sellers, "Paused" alone does not say
      WHOSE arrangement is paused — which is the whole reason the non-solo path names a subject.
    */
    renderStand([host, { ...guest, lifecycleState: "paused" }]);

    expect(
      screen.getByRole("switch", { name: /Misty Hollow Farm.*selling here/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Fernhorn Farm.*paused/i })).toBeInTheDocument();
  });

  it("names each seller once the stand is shared", () => {
    renderStand([host, guest]);

    expect(screen.getByRole("switch", { name: /Misty Hollow Farm/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Fernhorn Farm/i })).toBeInTheDocument();
  });
});

describe("the toggle", () => {
  it("pauses a live arrangement through the participation route", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "changed", lifecycleState: "paused" }), {
        status: 200,
      }),
    );
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("switch", { name: /Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("button", { name: /^pause$/i }));

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/participation");
    expect(JSON.parse(init.body as string)).toEqual({
      providerId: "provider-guest",
      transition: "pause",
    });
  });

  it("resumes a paused arrangement", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "changed", lifecycleState: "active" }), {
        status: 200,
      }),
    );
    renderStand([host, { ...guest, lifecycleState: "paused" }], fetcher);

    await userEvent.click(screen.getByRole("switch", { name: /Fernhorn Farm/i }));

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ transition: "resume" });
  });

  it("reports a refusal in place rather than appearing to have worked", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "provider_not_live" }), { status: 409 }),
    );
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("switch", { name: /Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("button", { name: /^pause$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer sells here/i);
    // The toggle must not show the state the failed request asked for.
    expect(screen.getByRole("switch", { name: /Fernhorn Farm/i })).toBeChecked();
  });
});

/*
  PAUSING ASKS FIRST (max, 2026-08-18).

  The whole row is the toggle, which makes it a large, easy target — and pausing takes a real
  seller's goods off the island's only guide. A tap that lands by accident should not do that
  silently, so pause now states what it will do and waits.

  RESUME IS NOT GATED, deliberately. It puts something BACK: the mistake it can make is
  undone by the same control, and a confirmation on a harmless act is the kind of chrome an
  operator learns to click past — which is how the one that matters stops being read.
*/
describe("pausing asks before it acts", () => {
  it("sends nothing on the first tap, and says what will happen", async () => {
    const fetcher = vi.fn();
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("switch", { name: /Fernhorn Farm/i }));

    expect(fetcher).not.toHaveBeenCalled();
    // The row still reads as selling: nothing has changed yet.
    expect(screen.getByRole("switch", { name: /Fernhorn Farm/i })).toBeChecked();
    expect(screen.getByRole("group", { name: /pause fernhorn farm/i })).toBeInTheDocument();
  });

  it("pauses once confirmed", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "changed", lifecycleState: "paused" }), {
        status: 200,
      }),
    );
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("switch", { name: /Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("button", { name: /^pause$/i }));

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ transition: "pause" });
  });

  it("leaves the arrangement alone when the operator backs out", async () => {
    const fetcher = vi.fn();
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("switch", { name: /Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("button", { name: /keep selling/i }));

    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: /Fernhorn Farm/i })).toBeChecked();
    // The question is gone, so the row is back to being a row.
    expect(screen.queryByRole("group", { name: /pause fernhorn farm/i })).toBeNull();
  });

  it("does NOT ask to resume — putting something back is not the risky direction", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "changed", lifecycleState: "active" }), {
        status: 200,
      }),
    );
    renderStand([host, { ...guest, lifecycleState: "paused" }], fetcher);

    await userEvent.click(screen.getByRole("switch", { name: /Fernhorn Farm/i }));

    // Straight through on one press.
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ transition: "resume" });
  });

  it("names the stand when one seller IS the stand, and still says pause (B-084)", async () => {
    /*
      The question has to name the act the operator pressed. Since B-084 the toggle says
      "Selling here" in both cases, so the question says PAUSE in both cases — offering to
      "close the stand" here would name a different act AND re-assert the open-now claim the
      label deliberately dropped. What stays different is only the subject: on a solo native
      stand the stand is named, because the seller and the stand are the same entity.
    */
    const fetcher = vi.fn();
    renderStand([host], fetcher);

    await userEvent.click(screen.getByRole("switch", { name: /selling here/i }));

    expect(screen.getByRole("group", { name: /pause misty hollow stand/i })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /close/i })).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Remove", () => {
  it("asks before ending, and sends nothing until confirmed", async () => {
    const fetcher = vi.fn();
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("button", { name: /more for Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /remove Fernhorn Farm/i }));

    expect(fetcher).not.toHaveBeenCalled();
    // The copy has to say it cannot be undone, because it cannot.
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("ends the arrangement once confirmed", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "changed", ended: true }), { status: 200 }),
    );
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("button", { name: /more for Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /remove Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/participation");
    expect(JSON.parse(init.body as string)).toEqual({
      providerId: "provider-guest",
      transition: "end",
    });
  });

  it("drops the removed arrangement from the view", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "changed", ended: true }), { status: 200 }),
    );
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("button", { name: /more for Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /remove Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    // The lists are entities; an ended relationship is not one. With the guest gone the stand
    // is back to its solo shape — plain fact, no list. The remaining row still NAMES its seller
    // (B-085): it sits under "Also selling here" and has to answer that.
    const remaining = await screen.findByRole("switch", { name: /selling here/i });
    expect(remaining).toHaveAccessibleName(/Misty Hollow Farm/i);
    expect(screen.queryByText(/Fernhorn Farm/i)).not.toBeInTheDocument();
  });

  it("offers no restore for something that ended", async () => {
    renderStand([host, { ...guest, lifecycleState: "paused" }]);

    // Paused is reversible and says so; ended is not, and no control may imply otherwise.
    expect(screen.queryByRole("button", { name: /restore|undo|re-add/i })).not.toBeInTheDocument();
  });
});

describe("the seller view", () => {
  const atTwoStands: ParticipationRow[] = [
    { ...guest, providerId: "p-1", salesLocationId: "s-1", standName: "Misty Hollow Stand" },
    { ...guest, providerId: "p-2", salesLocationId: "s-2", standName: "Harbor Stand" },
  ];

  it("lists the stands where the seller is active", () => {
    render(<SellerParticipation view="seller" rows={atTwoStands} fetcher={vi.fn()} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("switch", { name: /Misty Hollow Stand/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Harbor Stand/i })).toBeInTheDocument();
  });

  it("renders a seller at one stand as a plain fact", () => {
    render(
      <SellerParticipation view="seller" rows={[atTwoStands[0] as ParticipationRow]} fetcher={vi.fn()} />,
    );

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Misty Hollow Stand/i })).toBeInTheDocument();
  });

  it("never borrows the stand's open/closed framing", () => {
    // The adapting label belongs to a stand whose only seller is its own. On the seller view
    // the subject is always the arrangement, so the stand framing must not appear.
    render(
      <SellerParticipation view="seller" rows={[atTwoStands[0] as ParticipationRow]} fetcher={vi.fn()} />,
    );

    expect(screen.queryByText(/stand is (open|closed)/i)).not.toBeInTheDocument();
  });
});

/*
  A ROW'S MENU NAMES THE ARRANGEMENT, NOT THE PLACE.

  On a stand whose only seller owns it, the subject and the stand share a name — so a menu
  labelled "More for Bank Road Gardens" was indistinguishable from the stand's own menu sitting
  a few pixels away, and a screen reader offered two identical buttons that did different
  things. The row's menu says what it acts on: this seller's selling here.
*/
describe("the row's menu is distinguishable from the stand's", () => {
  it("names the arrangement rather than repeating the stand's name", () => {
    render(<SellerParticipation view="stand" rows={[host]} fetcher={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /^more for Misty Hollow Farm$/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Misty Hollow Farm.*sell|sell.*Misty Hollow Farm/i }),
    ).toBeInTheDocument();
  });
});
