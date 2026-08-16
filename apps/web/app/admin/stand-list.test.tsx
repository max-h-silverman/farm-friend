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
  sections: [],
};

/** The one control this suite is about, inside the one stand's disclosure. */
function inviteBox(): HTMLElement {
  return screen.getByRole("group", { name: /invite a seller to Venison Valley Stand/i });
}

async function openStand(): Promise<void> {
  await userEvent.click(screen.getByText("Venison Valley Stand"));
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
    await openStand();

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
    await openStand();
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
    await openStand();
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
    await openStand();
    const box = inviteBox();
    await userEvent.click(within(box).getByRole("button", { name: /invite/i }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers no invitation for a stand that is off the map", async () => {
    // A retired stand serves no customers, so a seller invited to it would onboard into
    // nothing. The control is absent rather than disabled: there is nothing to reverse here.
    render(<StandDetails stands={[{ ...stand, retired: true }]} />);
    await openStand();
    expect(
      screen.queryByRole("group", { name: /invite a seller/i }),
    ).toBeNull();
  });
});
