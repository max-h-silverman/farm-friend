// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
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

describe("the adapting label", () => {
  it("reads as the stand being open when its only seller is its own", () => {
    renderStand([host]);

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAccessibleName(/stand is open/i);
    expect(toggle).toBeChecked();
    // The seller's name is not the subject on a solo stand — the stand is.
    expect(toggle).not.toHaveAccessibleName(/Misty Hollow Farm/i);
  });

  it("reads as the stand being closed when its only seller is paused", () => {
    renderStand([{ ...host, lifecycleState: "paused" }]);

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAccessibleName(/stand is closed/i);
    expect(toggle).not.toBeChecked();
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

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer sells here/i);
    // The toggle must not show the state the failed request asked for.
    expect(screen.getByRole("switch", { name: /Fernhorn Farm/i })).toBeChecked();
  });
});

describe("Remove", () => {
  it("asks before ending, and sends nothing until confirmed", async () => {
    const fetcher = vi.fn();
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("button", { name: /remove Fernhorn Farm/i }));

    expect(fetcher).not.toHaveBeenCalled();
    // The copy has to say it cannot be undone, because it cannot.
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("ends the arrangement once confirmed", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "changed", ended: true }), { status: 200 }),
    );
    renderStand([host, guest], fetcher);

    await userEvent.click(screen.getByRole("button", { name: /remove Fernhorn Farm/i }));
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

    await userEvent.click(screen.getByRole("button", { name: /remove Fernhorn Farm/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    // The lists are entities; an ended relationship is not one. With the guest gone the stand
    // is back to its solo shape — plain fact, no list.
    expect(await screen.findByRole("switch", { name: /stand is open/i })).toBeInTheDocument();
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
