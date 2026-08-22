// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminShell, SignedOutAdmin } from "../app/admin/admin-shell";
import { FarmerQueue } from "../app/admin/farmers/farmer-queue";
import { StandDetails } from "../app/admin/stand-list";
import { UserList } from "../app/admin/user-list";
import { StandForm } from "../app/stand/[token]/stand-form";
import { SettingsForm } from "../app/stand/[token]/settings/settings-form";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response(status: number, payload: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("the shared administrator shell", () => {
  it("navigates by what VIGA actually does: the farms, the people, the inbox", () => {
    render(
      <AdminShell currentPath="/admin/stands">
        <p>Stands</p>
      </AdminShell>,
    );

    // F-101 (max, 2026-08-17). VIGA's whole job is four verbs — view and edit stands and
    // sellers, invite new stands or sellers — so Stands & Sellers is ONE destination holding
    // two views, and everything else an operator does happens inside a detail view rather
    // than on a screen of its own.
    expect(
      screen.getAllByRole("link", { name: /^(stands & sellers|sms users|alerts)$/i }),
    ).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Stands & Sellers" })).toHaveAttribute(
      "href",
      "/admin/stands",
    );
    expect(screen.getByRole("link", { name: "SMS Users" })).toHaveAttribute("href", "/admin/users");
    expect(screen.getByRole("link", { name: "Alerts" })).toHaveAttribute("href", "/admin/messages");

    // Alerts is LAST, and Stands & Sellers first: the order is the order of the work.
    const labels = screen
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(labels).toEqual(["Stands & Sellers", "SMS Users", "Alerts"]);

    // No Home tab (max, 2026-08-10). A desk whose only content was counts pointing at the
    // other tabs made every task two clicks; the counts moved to the tabs that own the work.
    expect(screen.queryByRole("link", { name: /^home$/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /volunteer desk/i })).toBeNull();
    // The merged destinations stay gone.
    expect(screen.queryByRole("link", { name: "Customer reports" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Stock reports" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Farmers" })).toBeNull();
    // F-101 — "Farms" is GONE, not renamed. A farm is no longer a destination.
    expect(screen.queryByRole("link", { name: /^farms$/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /^messages$/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /^users$/i })).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByRole("navigation")).toContainElement(
      screen.getByRole("button", { name: "Sign out" }),
    );
  });

  it("identifies the current workflow and signs out through the durable endpoint", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const signedOut = vi.fn();

    render(
      <AdminShell
        currentPath="/admin/messages"
        fetcher={fetcher}
        onSignedOut={signedOut}
      >
        <p>Queue</p>
      </AdminShell>,
    );

    expect(screen.getByRole("link", { name: "Alerts" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("heading", { name: /volunteer desk|home/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(fetcher).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(signedOut).toHaveBeenCalledOnce();
  });

  it("renders one generic signed-out recovery state with no membership clue", () => {
    render(<SignedOutAdmin />);

    expect(screen.getByRole("heading", { name: "Farm Friend admin" })).toBeTruthy();
    expect(screen.queryByText(/session may have expired/i)).toBeNull();
    expect(screen.queryByText("VIGA operations")).toBeNull();
    expect(document.body.textContent).not.toMatch(/recognized|provisioned|authorized address/i);
  });

  it("shows the sign-in FIELDS rather than a link to them (max 2026-08-08)", () => {
    // An operator hitting a protected page while signed out met "Sign in required" and a link
    // — one click before the only thing they could do. The password box is the whole screen's
    // purpose, so it is what the screen shows.
    render(<SignedOutAdmin />);

    expect(screen.getByLabelText(/password/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy();
    // And no interstitial left behind — a link beside the form would be two ways to do one
    // thing, with the slower one first.
    expect(screen.queryByRole("link", { name: /go to sign in/i })).toBeNull();
  });

  it("posts natively, so the recovery path survives without JavaScript", () => {
    // The signed-out screen is now the sign-in screen, and it inherits that property rather
    // than being a JS-only copy of it: an operator locked out with a broken bundle can still
    // get in. Anchored to the form's own attributes, which is what the browser acts on.
    const { container } = render(<SignedOutAdmin />);

    const form = container.querySelector("form.admin-login");
    expect(form).not.toBeNull();
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/auth/login");
  });
});

describe("the stand list", () => {
  it("keeps the scan view to stand, status, open state, and approval, then reveals metadata on demand", async () => {
    const user = userEvent.setup();
    render(
      <StandDetails
        stands={[
          {
            standId: "stand-1",
            farmId: "farm-of-stand-1",
            name: "North Stand",
            farmName: "Example Farm",
            status: "Public",
            openState: "Open now",
            approved: true,
            retired: false,
            retiredWithFarm: false,
            farmBucksStatus: "does_not_accept",
            metadata: { name: "Stand", publicAddress: null, addressPublic: true, latitude: null, longitude: null, hoursText: null },
            sections: [
              {
                title: "Availability",
                items: [
                  ["Current items", "Eggs, flowers"],
                  ["Last confirmed", "Today"],
                ],
              },
              {
                title: "Visit",
                items: [
                  ["Address", "123 Farm Lane"],
                  ["Hours", "Daily, 9am–5pm"],
                ],
              },
            ],
          },
        ]}
      />,
    );

    // The identity, its states, and the FACTS are all on screen at rest (max, 2026-08-17).
    // An operator arrives to read something, so the card answers before it asks anything.
    expect(screen.getByText("North Stand")).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
    expect(screen.getByText("Open now")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Availability" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Visit" })).toBeTruthy();
    expect(screen.getByText("123 Farm Lane")).toBeTruthy();
    expect(screen.getByText("Eggs, flowers")).toBeTruthy();

    // No form is, until a verb asks for one.
    expect(screen.queryByRole("combobox", { name: "Farm Bucks decision" })).toBeNull();
    expect(screen.queryByLabelText("Stand name")).toBeNull();

    await user.click(screen.getByRole("button", { name: /more for North Stand/i }));
    await user.click(screen.getByRole("menuitem", { name: /farm bucks/i }));

    expect(screen.getByRole("combobox", { name: "Farm Bucks decision" })).toHaveValue(
      "does_not_accept",
    );
  });

  it("records a Farm Bucks decision when the volunteer selects it", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => response(200));
    vi.stubGlobal("fetch", fetcher);
    render(
      <StandDetails
        stands={[{
          standId: "stand-farm-bucks",
          farmId: "farm-of-stand-farm-bucks",
          name: "North Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "does_not_accept",
          metadata: { name: "Stand", publicAddress: null, addressPublic: true, latitude: null, longitude: null, hoursText: null },
          sections: [{ title: "Payment accepted", items: [["Farm Bucks", "Not accepted"]] }],
        }, {
          // F-125 — a SECOND stand of the same farm. The decision is the seller's, so this
          // row has to move with the one the operator actually touched; leaving it behind is
          // the per-stand disagreement the move deletes.
          standId: "stand-farm-bucks-south",
          farmId: "farm-of-stand-farm-bucks",
          name: "South Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "does_not_accept",
          metadata: { name: "Stand", publicAddress: null, addressPublic: true, latitude: null, longitude: null, hoursText: null },
          sections: [{ title: "Payment accepted", items: [["Farm Bucks", "Not accepted"]] }],
        }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /more for North Stand/i }));
    await user.click(screen.getByRole("menuitem", { name: /farm bucks/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Farm Bucks decision" }), "accepts");

    // F-125 — keyed by the SELLER, so one answer covers every stand she sells at.
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/stands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sellerId: "farm-of-stand-farm-bucks", farmBucksStatus: "accepts" }),
      }),
    );
    // BOTH stands of the farm now read as accepted — the propagation, asserted as a count so
    // it cannot pass on the touched row alone.
    expect(screen.getAllByText("Accepted")).toHaveLength(2);
    expect(screen.queryByText("Not accepted")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Farm Bucks decision" })).toBeNull();
  });

  // An operator looking to DELETE a farm could not find this. The control does exactly what
  // deleting should do — the stand leaves the map and all farmer surfaces, nothing published
  // is destroyed, and it can be put back — so the capability existed and read as missing.
  //
  // The verb now lives in the stand's menu, and the CONFIRMATION is where the vocabulary has
  // to land: it is the screen an operator reads before committing, and it must say what the
  // effect is in the words they arrived with rather than only "take off the map".
  it("names removing a stand in the words an operator looks for", async () => {
    render(
      <StandDetails
        stands={[{
          standId: "stand-vocab",
          farmId: "farm-of-stand-vocab",
          name: "North Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "does_not_accept",
          metadata: { name: "Stand", publicAddress: null, addressPublic: true, latitude: null, longitude: null, hoursText: null },
          sections: [{ title: "Visit", items: [["Address", "123 Farm Lane"]] }],
        }]}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /more for North Stand/i }));
    await user.click(screen.getByRole("menuitem", { name: /take off the map/i }));

    // Anchored to what the confirmation SAYS THE EFFECT IS, not to nearby vocabulary: the
    // operator is about to commit, and this is the sentence that has to be true and findable.
    expect(
      screen.getByText(/customers will stop seeing it/i),
    ).toBeTruthy();
  });

  it("takes a stand off the map only after the operator confirms it (F-071)", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => response(200, { status: "retired" }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <StandDetails
        stands={[{
          standId: "stand-retire",
          farmId: "farm-of-stand-retire",
          name: "North Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "does_not_accept",
          metadata: { name: "Stand", publicAddress: null, addressPublic: true, latitude: null, longitude: null, hoursText: null },
          sections: [{ title: "Visit", items: [["Address", "123 Farm Lane"]] }],
        }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /more for North Stand/i }));
    await user.click(screen.getByRole("menuitem", { name: "Take off the map" }));

    // The first click asks rather than acts. Retirement is reversible, but it removes a farm
    // from the island's only guide — a misplaced click should not be enough to do it.
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByText(/take North Stand off the map/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Yes, take it off the map" }));

    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/stands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ standId: "stand-retire", action: "retire" }),
      }),
    );
    // The row reports the new state without a reload, and offers the way back.
    expect(screen.getByText("Off the map")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /more for North Stand/i }));
    expect(screen.getByRole("menuitem", { name: "Put back on the map" })).toBeTruthy();
  });

  it("puts a retired stand back with one click, no confirmation (F-071)", async () => {
    // Restoring is not destructive, so it does not ask. The confirmation exists for the
    // direction that removes a farm from the map, not for the one that undoes it.
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => response(200, { status: "restored" }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <StandDetails
        stands={[{
          standId: "stand-restore",
          farmId: "farm-of-stand-restore",
          name: "South Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: true,
          retiredWithFarm: false,
          farmBucksStatus: "does_not_accept",
          metadata: { name: "Stand", publicAddress: null, addressPublic: true, latitude: null, longitude: null, hoursText: null },
          sections: [{ title: "Visit", items: [["Address", "9 Farm Lane"]] }],
        }]}
      />,
    );

    expect(screen.getByText("Off the map")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /more for South Stand/i }));
    await user.click(screen.getByRole("menuitem", { name: "Put back on the map" }));

    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/stands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ standId: "stand-restore", action: "restore" }),
      }),
    );
    await user.click(screen.getByRole("button", { name: /more for South Stand/i }));
    expect(screen.getByRole("menuitem", { name: "Take off the map" })).toBeTruthy();
  });

  it("says so when a retirement does not go through, rather than showing it as done", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => response(409, { status: "already_retired" }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <StandDetails
        stands={[{
          standId: "stand-fail",
          farmId: "farm-of-stand-fail",
          name: "West Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "does_not_accept",
          metadata: { name: "Stand", publicAddress: null, addressPublic: true, latitude: null, longitude: null, hoursText: null },
          sections: [{ title: "Visit", items: [["Address", "3 Farm Lane"]] }],
        }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /more for West Stand/i }));
    await user.click(screen.getByRole("menuitem", { name: "Take off the map" }));
    await user.click(screen.getByRole("button", { name: "Yes, take it off the map" }));

    // An operator who believes a stand is off the map when it is still being served is worse
    // off than one who sees an error.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Off the map")).toBeNull();
    await user.click(screen.getByRole("button", { name: /more for West Stand/i }));
    expect(screen.getByRole("menuitem", { name: "Take off the map" })).toBeTruthy();
  });
});

describe("administrator language", () => {
  it("uses map language and action-first labels in the stand and farmer queues", () => {
    render(
      <>
        <StandDetails
          stands={[
            {
              standId: "stand-language",
              farmId: "farm-of-stand-language",
              name: "North Stand",
              farmName: "Example Farm",
              status: "Shown on map",
              openState: "Open now",
              approved: true,
              retired: false,
              retiredWithFarm: false,
              farmBucksStatus: "does_not_accept",
              metadata: { name: "Stand", publicAddress: null, addressPublic: true, latitude: null, longitude: null, hoursText: null },
              sections: [{ title: "Visit", items: [["Visit in person", "Yes"]] }],
            },
          ]}
        />
        <FarmerQueue
          requests={[]}
          sellers={[]}
        />
      </>,
    );

    expect(screen.getByText("Shown on map")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Invite a farmer to join" })).toBeTruthy();
    // "Open invites" since 2026-08-19 (max): the heading says what the rows ARE, where
    // "Waiting for your decision" described how they were meant to make an operator feel.
    expect(screen.getByRole("heading", { name: "Open invites" })).toBeTruthy();
    // F-100's finding, fixed in F-101: "No requests." was terse beside its neighbours and read
    // as a missing value rather than a settled state.
    expect(screen.getByText(/no invites are open/i)).toBeTruthy();
    expect(screen.getByText("Contact")).toBeTruthy();
    // Who can update a farm is the FARM card's subject now, not this queue's. The same farm
    // appearing in both places under two different headings is what this restructure removed.
    expect(screen.queryByRole("heading", { name: "People with farmer access" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Farm" })).toBeTruthy();
    expect(screen.queryByText("Waiting on you")).toBeNull();
    expect(screen.queryByText("Start here")).toBeNull();
    expect(screen.queryByText("SMS or email")).toBeNull();
    expect(screen.queryByText("Where should we send the invite?")).toBeNull();
    expect(screen.queryByText("Send to a phone")).toBeNull();
    expect(screen.queryByText("Send to an inbox")).toBeNull();
    expect(screen.queryByText("Needs a decision")).toBeNull();
    expect(screen.queryByText("Already approved")).toBeNull();
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.queryByText("2")).toBeNull();
  });
});

describe("the user list", () => {
  it("filters the directory by current farmer status", async () => {
    const user = userEvent.setup();
    render(
      <UserList
        users={[
          { userId: "user-1", senderMask: "(•••) •••-0701", isFarmer: true, sellers: ["Example Farm"] },
          { userId: "user-2", senderMask: "(•••) •••-0702", isFarmer: false, sellers: [] },
        ]}
      />,
    );

    expect(screen.getByText("(•••) •••-0701")).toBeTruthy();
    expect(screen.getByText("(•••) •••-0702")).toBeTruthy();
    expect(screen.queryByText("Browse")).toBeNull();
    expect(screen.queryByText("Filter by the access they have today.")).toBeNull();
    expect(screen.queryAllByText("Masked contact")).toHaveLength(0);

    await user.selectOptions(screen.getByRole("combobox", { name: "Show" }), "farmer");
    expect(screen.getByText("(•••) •••-0701")).toBeTruthy();
    expect(screen.queryByText("(•••) •••-0702")).toBeNull();

    await user.selectOptions(screen.getByRole("combobox", { name: "Show" }), "not_farmer");
    expect(screen.queryByText("(•••) •••-0701")).toBeNull();
    expect(screen.getByText("(•••) •••-0702")).toBeTruthy();
  });

  it("names the two kinds of person plainly, in the pills and the filter alike", () => {
    render(
      <UserList
        users={[
          { userId: "user-1", senderMask: "(•••) •••-0701", isFarmer: true, sellers: ["Example Farm"] },
          { userId: "user-2", senderMask: "(•••) •••-0702", isFarmer: false, sellers: [] },
        ]}
      />,
    );

    expect(screen.getByRole("option", { name: "Farmer" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Regular user" })).toBeTruthy();
    // The pill reads as a description of the person, not as a note about paperwork they
    // still owe us — "no access yet" implied a pending step that does not exist.
    expect(screen.getByText("Farmer", { selector: ".admin-access-pill" })).toBeTruthy();
    expect(screen.getByText("Regular user", { selector: ".admin-access-pill" })).toBeTruthy();
    expect(screen.queryByText("Farmer access")).toBeNull();
    expect(screen.queryByText("No access yet")).toBeNull();
  });
});


describe("the farmer stand form", () => {
  const settingsListings = [
    {
      providerId: "prov-a",
      salesLocationId: "stand-a",
      locationName: "Orchard Stand",
      sellerName: "Own Seller",
      describesOwnStand: true,
      mayPause: true,
      selected: true,
      cadence: null,
    },
  ];

  it("saves the one-name-per-line seller list separately from inventory", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue(
      response(200, {
        status: "saved",
        activeDisplayNames: ["Guest Growers", "Island Apiary"],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<SettingsForm token="private-token" listings={settingsListings} participantNamesByLocation={{ "stand-a": ["Guest Growers"] }} />);

    const names = screen.getByRole("textbox", { name: "Seller names" });
    expect(names).toHaveValue("Guest Growers");
    expect(screen.getByText(/one name per\s+line/i)).toBeTruthy();
    expect(screen.getByText(/give nobody permission/i)).toBeTruthy();
    await user.type(names, "{enter}Island Apiary");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/settings saved/i);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/farmer/stand",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          token: "private-token",
          action: "save_participants",
          participantNames: ["Guest Growers", "Island Apiary"],
        }),
      }),
    );
  });

  it("lets the owner CLEAR the seller list, which is a real edit and must reach the writer", async () => {
    // "Everyone who was selling here has stopped" is a statement the farmer must be able to
    // make, and it is the one edit whose payload is empty — so a form that treated blank as
    // "nothing to save" would leave retired names on the public listing forever.
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue(
      response(200, { status: "saved", activeDisplayNames: [] }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(
      <SettingsForm
        token="private-token"
        listings={settingsListings}
        participantNamesByLocation={{ "stand-a": ["Guest Growers"] }}
      />,
    );

    const names = screen.getByRole("textbox", { name: "Seller names" });
    expect(names).not.toHaveAttribute("placeholder");
    // Untouched, there is nothing to save — the button is not a no-op waiting to be pressed.
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();

    await user.clear(names);
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/settings saved/i);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/farmer/stand",
      expect.objectContaining({
        body: JSON.stringify({
          token: "private-token",
          action: "save_participants",
          participantNames: [],
        }),
      }),
    );
    expect(names).not.toHaveAttribute("placeholder");
  });

  it("keeps seller names unchanged on validation error and shows revocation recovery", async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(409, { message: "Please remove the phone number." }))
      .mockResolvedValueOnce(response(403));
    vi.stubGlobal("fetch", fetcher);
    render(<SettingsForm token="private-token" listings={settingsListings} participantNamesByLocation={{ "stand-a": ["Guest Growers"] }} />);

    const names = screen.getByRole("textbox", { name: "Seller names" });
    await user.type(names, "{enter}Call 206-555-0199");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please remove the phone number.",
    );
    expect(names).toHaveValue("Guest Growers\nCall 206-555-0199");

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/link is no longer active/i);
    expect(screen.getByRole("link", { name: "How to get a new link" })).toHaveAttribute(
      "href",
      "#new-link-help",
    );
  });

  it("publishes on one press and posts the credential in the body every time", async () => {
    // F-097 (max, 2026-08-08) — the preview-and-confirm pair is gone from this surface. It is
    // the right gate for SMS, where code interpreted prose; here the farmer is looking at the
    // rows they typed. `stand-form.test.tsx` owns the one-request assertion; this file keeps
    // the credential-placement guarantee it has always owned.
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue(
      response(200, {
        status: "published",
        currentEntries: [
          { entryId: "e1", itemName: "Winter squash", priceText: "3 item for $4" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    render(<StandForm token="private-token" currentEntries={[]} />);
    await user.type(screen.getByLabelText("Stock today"), "Winter squash");
    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.click(screen.getByRole("switch", { name: "Add prices" }));
    await user.type(screen.getByLabelText("Price for Winter squash"), "4");
    await user.selectOptions(screen.getByLabelText("Price basis for Winter squash"), "for");
    await user.clear(screen.getByLabelText("How many Winter squash"));
    await user.type(screen.getByLabelText("How many Winter squash"), "3");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Your stand is updated");
    // The preview surface must stay gone rather than merely be skipped.
    expect(screen.queryByRole("region", { name: "Exact publication preview" })).toBeNull();
    expect(screen.queryByText("Exact preview — nothing has changed yet.")).toBeNull();

    for (const call of fetcher.mock.calls) {
      expect(call[0]).toBe("/api/farmer/stand");
      expect(JSON.parse((call[1] as RequestInit).body as string)).toHaveProperty(
        "token",
        "private-token",
      );
    }
  });

  it("keeps a failed request unchanged and gives a revoked link a recovery action", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => response(403)));
    render(<StandForm token="private-token" currentEntries={[]} />);

    await user.type(screen.getByLabelText("Stock today"), "eggs");
    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/listing is unchanged/i);
    expect(screen.getByRole("link", { name: "How to get a new link" })).toHaveAttribute(
      "href",
      "#new-link-help",
    );
  });

  it("clears a prior success when the next save fails", async () => {
    // A farmer must never read "Your stand is updated." over a screen whose latest save was
    // refused. The stale success is the lie; the alert alone is not enough.
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(200, {
            status: "published",
            currentEntries: [{ entryId: "e1", itemName: "Kale", priceText: "$3/bunch" }],
          }),
        )
        .mockResolvedValueOnce(response(500, { message: "Could not save the proposal." })),
    );
    render(<StandForm token="private-token" currentEntries={[]} />);

    await user.type(screen.getByLabelText("Stock today"), "Kale");
    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.click(screen.getByRole("switch", { name: "Add prices" }));
    await user.type(screen.getByLabelText("Price for Kale"), "$3/bunch");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your stand is updated");

    await user.clear(screen.getByLabelText("Price for Kale"));
    await user.type(screen.getByLabelText("Price for Kale"), "$4/bunch");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the proposal.");
    expect(screen.queryByText("Your stand is updated.")).toBeNull();
  });
});
