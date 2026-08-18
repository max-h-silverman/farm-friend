// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StandDetails, type AdminStandCard } from "./stand-list";

/*
  F-114 Phase C.1 — VIGA'S INVITE BUTTON.

  `invite_seller` has been live on `POST /api/admin/stands` since the invitation merged, and
  SURFACES.md recorded the gap plainly: no button called it, so the one door VIGA had was an
  authenticated request typed by hand. This is that button.

  **On the STAND, not on the farm.** A hosting relationship binds a seller to one stand, and a
  farm with two stands would otherwise present one control that had to ask which — a question the
  operator has already answered by being inside a stand's card.

  What is asserted here is the SHAPE and the WIRE: the request the button sends, the link it shows
  back, and the refusals it reports honestly. The writer's own rules — who may invite, what a name
  may say, one relationship per seller — are the db suite's, and restating them would be a second
  statement that can drift.
*/

const stand: AdminStandCard = {
  standId: "stand-1",
  name: "Venison Valley Stand",
  farmName: "Venison Valley",
  status: "Listed",
  openState: "Open today",
  approved: true,
  retired: false,
  retiredWithFarm: false,
  farmBucksStatus: "not_eligible",
  metadata: {
    name: "Venison Valley Stand",
    publicAddress: "1 Wrong Road",
    addressPublic: true,
    latitude: 47.4473,
    longitude: -122.459,
    hoursText: "Dawn to dusk",
  },
  sections: [],
};

/** The one control this suite is about, inside the one stand's disclosure. */
function inviteBox(): HTMLElement {
  return screen.getByRole("group", { name: /invite a seller to Venison Valley Stand/i });
}

/**
 * Reach one of the stand's verbs the way an operator does: its own menu, then the item. The
 * card no longer carries a second disclosure — the card that opened it already answered
 * "which stand", so opening the same stand twice was chrome.
 */
async function choose(item: RegExp): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: /more for Venison Valley Stand/i }));
  await userEvent.click(screen.getByRole("menuitem", { name: item }));
}

/** The details editor, which the F-101 cases work inside. */
async function openStand(): Promise<void> {
  await choose(/edit details/i);
}

/** The invitation panel, which the F-114 cases work inside. */
async function openInvite(): Promise<void> {
  await choose(/invite a seller/i);
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // A clipboard the test owns, so the copy-on-mint behaviour is observable rather than
  // silently unavailable under jsdom.
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
});

describe("VIGA invites a seller to a stand (F-114 Phase C.1)", () => {
  it("posts invite_seller for THIS stand and shows the link once", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          status: "invited",
          sellerName: "Gracies Greens",
          link: `https://farmfriend.test/farmer/onboarding/${"a".repeat(64)}`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<StandDetails stands={[stand]} />);
    await openInvite();

    const box = inviteBox();
    await userEvent.type(
      within(box).getByLabelText(/seller's name/i),
      "Gracies Greens",
    );
    await userEvent.click(within(box).getByRole("button", { name: /invite/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    // The stand comes from the card, never from anything typed. The acting administrator is
    // the SESSION's and is deliberately absent from the body.
    expect(body).toEqual({
      standId: "stand-1",
      action: "invite_seller",
      newSellerName: "Gracies Greens",
    });

    // The link is shown, not merely copied: a clipboard write can fail silently, and the
    // token is minted once — an operator who loses it has to reissue.
    expect(await within(box).findByLabelText("Invitation link")).toHaveValue(
      `https://farmfriend.test/farmer/onboarding/${"a".repeat(64)}`,
    );
  });

  it("says nothing is public yet, because nothing is", async () => {
    // max, 2026-08-15: nothing is public until the seller finishes. An operator who thought the
    // invitation listed someone would answer a farmer's "why can't I see them" wrongly.
    render(<StandDetails stands={[stand]} />);
    await openInvite();
    expect(
      within(inviteBox()).getByText(
        /nobody is listed until they finish|not.*public until/i,
      ),
    ).toBeVisible();
  });

  it("reports a refusal instead of claiming a link was made", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "already_selling_here" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<StandDetails stands={[stand]} />);
    await openInvite();
    const box = inviteBox();
    await userEvent.type(within(box).getByLabelText(/seller's name/i), "Fernhorn Bakery");
    await userEvent.click(within(box).getByRole("button", { name: /invite/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already sell/i);
    expect(within(box).queryByLabelText("Invitation link")).toBeNull();
  });

  it("cannot be pressed with no name", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<StandDetails stands={[stand]} />);
    await openInvite();
    const box = inviteBox();
    await userEvent.click(within(box).getByRole("button", { name: /invite/i }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers no invitation for a stand that is off the map", async () => {
    // A retired stand serves no customers, so a seller invited to it would onboard into
    // nothing. The control is absent rather than disabled: there is nothing to reverse here.
    render(<StandDetails stands={[{ ...stand, retired: true }]} />);
    await userEvent.click(
      screen.getByRole("button", { name: /more for Venison Valley Stand/i }),
    );
    expect(screen.queryByRole("menuitem", { name: /invite a seller/i })).toBeNull();
  });
});

describe("F-101 VIGA corrects a stand's own facts", () => {
  /*
    max settled (2026-08-17) that stand metadata is editable by VIGA as well as by the stand's
    owner. The farmer's half already existed (F-073, `/stand/[token]/listing`); this is the
    operator's, and it is a NARROWER form on purpose.

    What it does NOT offer is the point: no payment methods, no "usually sells", no farmer
    description, no item list, no visitability. Those are the farmer's published words, and
    Golden Rule #1 keeps VIGA's hand off them. The form's fields ARE the seam's columns.
  */

  function editBox(): HTMLElement {
    return screen.getByRole("group", { name: /stand details for Venison Valley Stand/i });
  }

  it("prefills from the stand and saves only the location's own facts", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "saved" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<StandDetails stands={[stand]} />);
    await openStand();

    // Prefilled, and load-bearing: the writer sets every column it names, so a blank form
    // would clear an address the operator never meant to touch.
    const box = editBox();
    expect(within(box).getByLabelText("Stand name")).toHaveValue("Venison Valley Stand");
    expect(within(box).getByLabelText("Address")).toHaveValue("1 Wrong Road");
    expect(within(box).getByLabelText(/hours, in the/i)).toHaveValue("Dawn to dusk");

    await userEvent.clear(within(box).getByLabelText("Stand name"));
    await userEvent.type(within(box).getByLabelText("Stand name"), "Venison Valley Farm Stand");
    await userEvent.click(within(box).getByRole("button", { name: /save stand details/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/stands",
      expect.objectContaining({
        body: JSON.stringify({
          standId: "stand-1",
          action: "save_metadata",
          name: "Venison Valley Farm Stand",
          publicAddress: "1 Wrong Road",
          addressPublic: true,
          latitude: 47.4473,
          longitude: -122.459,
          hoursText: "Dawn to dusk",
        }),
      }),
    );
    expect(await screen.findByText(/stand details saved/i)).toBeVisible();
  });

  it("offers nothing that belongs to the farmer's own listing", () => {
    /*
      GOLDEN RULE #1 at the surface. Asserted as absences on the whole card, because the failure
      this prevents is a field APPEARING — an operator who can retype what a stand usually sells
      is rewriting the farmer's published words from the admin console.
    */
    render(<StandDetails stands={[stand]} />);
    expect(screen.queryByLabelText(/payment methods/i)).toBeNull();
    expect(screen.queryByLabelText(/usually sells/i)).toBeNull();
    expect(screen.queryByLabelText(/description/i)).toBeNull();
    expect(screen.queryByLabelText(/visit in person/i)).toBeNull();
  });

  it("reports a refusal by what the operator must fix, and keeps the typed values", async () => {
    // A named refusal has a next move; "that did not save" does not. The typed values survive
    // so the operator can correct one field rather than retype the form.
    const fetchMock = vi.fn(async () =>
      Response.json({ status: "incomplete_location" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<StandDetails stands={[stand]} />);
    await openStand();

    const box = editBox();
    await userEvent.clear(within(box).getByLabelText("Address"));
    await userEvent.click(within(box).getByRole("button", { name: /save stand details/i }));

    expect(await screen.findByText(/needs an address and a map pin/i)).toBeVisible();
    expect(within(editBox()).getByLabelText("Stand name")).toHaveValue("Venison Valley Stand");
  });
});

/*
  THE STAND CARD'S SHAPE (max, 2026-08-17).

  A stand card opened from Stands & Sellers used to open a SECOND disclosure to reach the same
  stand, then present three always-open forms — the details editor, Farm Bucks, an invitation —
  stacked under the read-only facts. An operator arriving to check whether a stand was on the
  map read a page of form.

  Now: the facts, and one menu holding the verbs. Each verb opens the surface it needs, and
  nothing else is on screen while it is.
*/
describe("the stand card's verbs live behind one menu", () => {
  it("shows no form until a verb is chosen", () => {
    render(<StandDetails stands={[stand]} />);

    expect(screen.queryByLabelText("Stand name")).toBeNull();
    expect(screen.queryByLabelText(/seller's name/i)).toBeNull();
    expect(screen.getByRole("button", { name: /more for Venison Valley Stand/i })).toBeInTheDocument();
  });

  it("opens the details editor from the menu", async () => {
    render(<StandDetails stands={[stand]} />);
    await openStand();

    expect(screen.getByLabelText("Stand name")).toHaveValue("Venison Valley Stand");
  });

  it("shows one surface at a time, so a verb replaces the last one", async () => {
    render(<StandDetails stands={[stand]} />);
    await openStand();
    expect(screen.getByLabelText("Stand name")).toBeInTheDocument();

    await choose(/invite a seller/i);

    // The editor is gone rather than pushed down the page: two open forms is the state that
    // made the old card read as a page of form.
    expect(screen.queryByLabelText("Stand name")).toBeNull();
    expect(screen.getByLabelText(/seller's name/i)).toBeInTheDocument();
  });

  it("keeps the read-only facts visible whatever verb is open", async () => {
    render(<StandDetails stands={[{ ...stand, sections: [{ title: "Where", items: [["Address", "1 Wrong Road"]] }] }]} />);
    await openStand();

    expect(screen.getByText("1 Wrong Road")).toBeInTheDocument();
  });
});
