// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminShell, SignedOutAdmin } from "../app/admin/admin-shell";
import { ApprovalQueue } from "../app/admin/approval-queue";
import { FarmerQueue } from "../app/admin/farmers/farmer-queue";
import { FlagQueue } from "../app/admin/flags/flag-queue";
import { ReportQueue } from "../app/admin/reports/report-queue";
import { FarmList, type AdminFarmCard } from "../app/admin/farm-list";
import { StandDetails } from "../app/admin/stand-list";
import { StandDataQueue } from "../app/admin/stand-data/stand-data-queue";
import { UserList } from "../app/admin/user-list";
import { StandForm } from "../app/stand/[token]/stand-form";
import { SettingsForm } from "../app/stand/[token]/settings/settings-form";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A farm nobody can publish for yet — the state the setup-link control exists to resolve. */
const waitingFarm: AdminFarmCard = {
  farmId: "farm-waiting",
  name: "Waiting Farm",
  description: null,
  approved: true,
  approvedAt: "2026-08-01T10:00:00Z",
  approvedByEmail: "board@vigavashon.org",
  isTestFarm: false,
  retired: false,
  invitationState: "expired",
  invitationExpiresAt: "2026-08-02T10:00:00Z",
  access: [],
  stands: [],
};

function response(status: number, payload: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("the shared administrator shell", () => {
  it("navigates by subject: a farm, a message, a person", () => {
    render(
      <AdminShell currentPath="/admin/farms">
        <p>Stands</p>
      </AdminShell>,
    );

    expect(
      screen.getAllByRole("link", { name: /^(farms|messages|users)$/i }),
    ).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Farms" })).toHaveAttribute("href", "/admin/farms");
    expect(screen.getByRole("link", { name: "Messages" })).toHaveAttribute("href", "/admin/messages");
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute("href", "/admin/users");

    // No Home tab (max, 2026-08-10). A desk whose only content was counts pointing at the
    // other tabs made every task two clicks; the counts moved to the tabs that own the work.
    expect(screen.queryByRole("link", { name: /^home$/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /volunteer desk/i })).toBeNull();
    // The merged destinations stay gone.
    expect(screen.queryByRole("link", { name: "Customer reports" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Stock reports" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Farmers" })).toBeNull();
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

    expect(screen.getByRole("link", { name: "Messages" })).toHaveAttribute(
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
            name: "North Stand",
            farmName: "Example Farm",
            status: "Public",
            openState: "Open now",
            approved: true,
            retired: false,
            retiredWithFarm: false,
            farmBucksStatus: "not_eligible",
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

    expect(screen.getByText("North Stand")).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
    expect(screen.getByText("Open now")).toBeTruthy();
    const details = screen.getByText("North Stand").closest("details");
    expect(details).toBeTruthy();
    expect(details).not.toHaveAttribute("open");

    expect(screen.queryByText("Show details")).toBeNull();
    expect(screen.queryByText("Hide details")).toBeNull();
    await user.click(screen.getByText("North Stand"));

    expect(details).toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Availability" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Visit" })).toBeTruthy();
    expect(screen.getByText("123 Farm Lane")).toBeTruthy();
    expect(screen.getByText("Eggs, flowers")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Farm Bucks decision" })).toHaveValue(
      "not_eligible",
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
          name: "North Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "not_eligible",
          sections: [{ title: "Other details", items: [["Farm Bucks", "Not reviewed"]] }],
        }]}
      />,
    );

    await user.click(screen.getByText("North Stand"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Farm Bucks decision" }), "accepts");

    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/stands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ standId: "stand-farm-bucks", farmBucksStatus: "accepts" }),
      }),
    );
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save Farm Bucks decision" })).toBeNull();
  });

  // An operator looking to DELETE a farm could not find this. The control does exactly what
  // deleting should do — the stand leaves the map and all farmer surfaces, nothing published
  // is destroyed, and it can be put back — but it is named "Take off the map", sits last
  // inside a collapsed panel, and never says the word. So the capability existed and read as
  // missing. The section states what it is in the vocabulary an operator arrives with.
  it("names removing a stand in the words an operator looks for", () => {
    render(
      <StandDetails
        stands={[{
          standId: "stand-vocab",
          name: "North Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "not_eligible",
          sections: [{ title: "Visit", items: [["Address", "123 Farm Lane"]] }],
        }]}
      />,
    );

    // Anchored to the SECTION HEADING, which is what someone scanning for "delete" reads —
    // the body copy already contained "Removes this stand", and asserting on that passed
    // while the heading still said only "Take off the map".
    expect(
      screen.getByRole("heading", { name: /remove|delete/i }),
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
          name: "North Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "not_eligible",
          sections: [{ title: "Visit", items: [["Address", "123 Farm Lane"]] }],
        }]}
      />,
    );

    await user.click(screen.getByText("North Stand"));
    await user.click(screen.getByRole("button", { name: "Take off the map" }));

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
    expect(screen.getByRole("button", { name: "Put back on the map" })).toBeTruthy();
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
          name: "South Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: true,
          retiredWithFarm: false,
          farmBucksStatus: "not_eligible",
          sections: [{ title: "Visit", items: [["Address", "9 Farm Lane"]] }],
        }]}
      />,
    );

    expect(screen.getByText("Off the map")).toBeTruthy();
    await user.click(screen.getByText("South Stand"));
    await user.click(screen.getByRole("button", { name: "Put back on the map" }));

    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/stands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ standId: "stand-restore", action: "restore" }),
      }),
    );
    expect(screen.getByRole("button", { name: "Take off the map" })).toBeTruthy();
  });

  it("says so when a retirement does not go through, rather than showing it as done", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => response(409, { status: "already_retired" }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <StandDetails
        stands={[{
          standId: "stand-fail",
          name: "West Stand",
          farmName: "Example Farm",
          status: "Visible to customers",
          openState: "Open now",
          approved: true,
          retired: false,
          retiredWithFarm: false,
          farmBucksStatus: "not_eligible",
          sections: [{ title: "Visit", items: [["Address", "3 Farm Lane"]] }],
        }]}
      />,
    );

    await user.click(screen.getByText("West Stand"));
    await user.click(screen.getByRole("button", { name: "Take off the map" }));
    await user.click(screen.getByRole("button", { name: "Yes, take it off the map" }));

    // An operator who believes a stand is off the map when it is still being served is worse
    // off than one who sees an error.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Off the map")).toBeNull();
    expect(screen.getByRole("button", { name: "Take off the map" })).toBeTruthy();
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
              name: "North Stand",
              farmName: "Example Farm",
              status: "Shown on map",
              openState: "Open now",
              approved: true,
              retired: false,
              retiredWithFarm: false,
              farmBucksStatus: "not_eligible",
              sections: [{ title: "Visit", items: [["Visit in person", "Yes"]] }],
            },
          ]}
        />
        <FarmerQueue
          requests={[]}
          farms={[]}
        />
      </>,
    );

    expect(screen.getByText("Shown on map")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Invite a farmer to join" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Waiting for your decision" })).toBeTruthy();
    expect(screen.getByText("No requests.")).toBeTruthy();
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
          { userId: "user-1", senderMask: "(•••) •••-0701", isFarmer: true, farms: ["Example Farm"] },
          { userId: "user-2", senderMask: "(•••) •••-0702", isFarmer: false, farms: [] },
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
          { userId: "user-1", senderMask: "(•••) •••-0701", isFarmer: true, farms: ["Example Farm"] },
          { userId: "user-2", senderMask: "(•••) •••-0702", isFarmer: false, farms: [] },
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

describe("administrator queue interactions", () => {
  it("announces a committed farm approval and exposes sign-in recovery on expiry", async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(403));
    vi.stubGlobal("fetch", fetcher);

    render(
      <ApprovalQueue
        farms={[
          {
            farmId: "farm-1",
            name: "Example Farm",
            approved: false,
            approvedAt: null,
            approvedByEmail: null,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve farm" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Example Farm is approved");

    await user.click(screen.getByText("Approved farms (1)"));
    await user.click(screen.getByRole("button", { name: "Remove approval" }));
    expect(screen.getByText(/existing map listings will stay visible/i)).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Remove approval" })[1]!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/session expired/i);
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/admin/login",
    );
  });

  // F-067 — the empty queue is the NORMAL state now that an invited farmer's redemption
  // approves their farm. An operator seeing "no farms to approve yet" would reasonably wonder
  // what had failed, so the empty state has to say why it is empty. Asserted rather than left
  // to review because it is a claim about how the system behaves, not decoration.
  it("explains that an empty approval queue is expected, not a failure", () => {
    render(
      <ApprovalQueue
        farms={[
          {
            farmId: "farm-1",
            name: "Already Approved Farm",
            approved: true,
            approvedAt: "2026-08-01T10:00:00Z",
            approvedByEmail: "board@vigavashon.org",
          },
        ]}
      />,
    );

    const empty = screen.getByText(/nothing waiting/i);
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(/approved automatically/i);
  });

  it("closes the removal confirmation after approval is removed", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => response(200)));

    render(
      <ApprovalQueue
        farms={[
          {
            farmId: "farm-1",
            name: "Example Farm",
            approved: true,
            approvedAt: "2026-08-01T10:00:00Z",
            approvedByEmail: "admin@example.com",
          },
        ]}
      />,
    );

    await user.click(screen.getByText("Approved farms (1)"));
    await user.click(screen.getByRole("button", { name: "Remove approval" }));
    await user.click(screen.getAllByRole("button", { name: "Remove approval" })[1]!);
    await user.click(screen.getByRole("button", { name: "Approve farm" }));
    await user.click(screen.getByText("Approved farms (1)"));

    expect(screen.queryByText(/existing map listings will stay visible/i)).toBeNull();
  });

  it("authorizes a masked farmer and shows a one-time link as a copyable control", async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200, { link: "https://ff.example/stand/private" }));
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });

    render(
      <FarmerQueue
        requests={[
          { requestId: "request-1", senderMask: "(•••) •••-0701", requestedAt: "2026-08-01T10:00:00Z" },
        ]}
        farms={[{ farmId: "farm-1", name: "Example Farm" }]}
      />,
    );

    expect(document.body.textContent).not.toContain("+1206");
    await user.selectOptions(screen.getByRole("combobox", { name: "Which farm do they run?" }), "farm-1");
    await user.click(screen.getByRole("button", { name: "Give access" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/access given/i);
    // Names where the record now lives. "Reload to see their access record" told the operator
    // to perform a browser action to find something the screen could have named.
    expect(screen.getByRole("status")).toHaveTextContent(/Example Farm/);
    expect(screen.getByRole("status")).toHaveTextContent(/farms tab/i);
    expect(document.body.textContent).not.toContain("+1206");
  });

  it("prepares a farm-specific text invitation without requiring prior SMS enrollment", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValueOnce(
      response(200, {
        status: "created",
        channel: "sms",
        farmName: "Example Farm",
        link: "https://ff.example/farmer/onboarding/invite-token",
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    render(
      <FarmerQueue
        requests={[]}
        farms={[{ farmId: "farm-1", name: "Example Farm" }]}
      />,
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "Farm" }), "farm-1");
    await user.type(screen.getByRole("textbox", { name: "Phone number" }), "(206) 555-0123");
    await user.click(screen.getByRole("button", { name: "Prepare invite" }));

    expect(await screen.findByRole("link", { name: "Open text message" })).toHaveAttribute(
      "href",
      expect.stringContaining("sms:+12065550123?body="),
    );
    await user.click(screen.getByText("See the message we prepared"));
    expect(screen.getByDisplayValue("https://ff.example/farmer/onboarding/invite-token")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/farmers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "create_invite", farmId: "farm-1", channel: "sms" }),
      }),
    );
  });

  // F-067 — a new farm is NAMED at invite time rather than assigned later. The old "New farm —
  // assign later" option minted an invitation naming no farm, which authorizes nothing when
  // redeemed and drops the farmer into the queue this work removes.
  it("names a new farm on the invitation, so redeeming it can set the farmer up", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValueOnce(
      response(200, {
        status: "created",
        channel: "email",
        farmName: "Misty Hollow Farm",
        link: "https://ff.example/farmer/onboarding/new-farm-token",
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    render(
      <FarmerQueue
        requests={[]}
        farms={[{ farmId: "farm-1", name: "Example Farm" }]}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Email" }));
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "farmer@example.com");
    await user.type(
      screen.getByRole("textbox", { name: "New farm name" }),
      "Misty Hollow Farm",
    );
    await user.click(screen.getByRole("button", { name: "Prepare invite" }));

    expect(await screen.findByRole("link", { name: "Open email" })).toHaveAttribute(
      "href",
      expect.stringContaining("mailto:farmer@example.com?"),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/farmers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "create_invite",
          newFarmName: "Misty Hollow Farm",
          channel: "email",
        }),
      }),
    );
  });

  it("refuses to prepare a new-farm invite with no name typed", async () => {
    // Caught before the request, so the operator is told what is missing rather than getting a
    // 400 back. Minting an invitation with no farm is the exact dead end F-067 removes.
    const user = userEvent.setup();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    render(
      <FarmerQueue
        requests={[]}
        farms={[{ farmId: "farm-1", name: "Example Farm" }]}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Email" }));
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "farmer@example.com");
    await user.click(screen.getByRole("button", { name: "Prepare invite" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/name the new farm/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  // The admin surface runs INSIDE VIGA's site as an iframe (`frame-ancestors` in
  // next.config.mjs is what permits it). There, `navigator.clipboard.writeText` is gated by
  // the `clipboard-write` permissions policy: unless the embedding page sets
  // `allow="clipboard-write"` on the iframe, the promise rejects with NotAllowedError even on
  // HTTPS and even from a real user click. VIGA owns that embed code, so the frame cannot fix
  // it from the inside — the copy path has to work without the async Clipboard API.
  //
  // Reported from the live embed: "Copy link" said copy failed every time.
  it("copies the invite link when the embedding page forbids the clipboard API", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        response(200, {
          status: "created",
          channel: "email",
          farmName: "Example Farm",
          link: "https://ff.example/farmer/onboarding/invite-token",
        }),
      ),
    );
    // Exactly what an iframe without `clipboard-write` does.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new DOMException("Write permission denied.", "NotAllowedError");
        }),
      },
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(
      <FarmerQueue
        requests={[]}
        farms={[{ farmId: "farm-1", name: "Example Farm" }]}
      />,
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "Farm" }), "farm-1");
    await user.click(screen.getByRole("radio", { name: "Email" }));
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "f@example.com");
    await user.click(screen.getByRole("button", { name: "Prepare invite" }));

    await user.click(await screen.findByRole("button", { name: "Copy link" }));

    // The fallback ran and the operator is told it worked — not handed the failure notice
    // that sent them off to select the link by hand.
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(await screen.findByText(/copied/i)).toBeVisible();
    expect(screen.queryByText(/Copy failed/i)).not.toBeInTheDocument();
  });

  it("sends a farmer who lost their link a new one, on the card that minted it (F-071)", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValueOnce(
      response(200, {
        status: "created",
        channel: "sms",
        farmName: "Waiting Farm",
        link: "https://ff.example/farmer/onboarding/fresh-token",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });

    render(<FarmList farms={[waitingFarm]} />);

    await user.click(screen.getAllByText("Waiting Farm")[0] as HTMLElement);
    // The operator must not be left thinking the old link can be recovered — it cannot, and
    // the copy has to say so rather than letting them assume otherwise. Scoped to the section
    // that owns the question, since the summary also flags the expiry as a state chip.
    const access = screen.getByLabelText("Who can update Waiting Farm");
    expect(access).toHaveTextContent(/setup link expired/i);
    expect(access).toHaveTextContent(/earlier links cannot be looked up/i);

    await user.click(screen.getByRole("button", { name: "New setup link for Waiting Farm" }));

    // A fresh invitation for the SAME farm, through the mechanism that already exists. No
    // second endpoint, and no attempt to resurrect a token that is stored only as a hash.
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/farmers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "create_invite",
          farmId: "farm-waiting",
          channel: "sms",
        }),
      }),
    );

    // The load-bearing half of this restructure: the link appears on the card whose button
    // was pressed. It used to render in a separate "Invite a farmer" panel further up the
    // page, so an operator pressed a button here and the only copy of an unrecoverable
    // credential appeared somewhere else entirely.
    const reveal = await screen.findByRole("group", { name: "New setup link for Waiting Farm" });
    expect(reveal).toContainElement(
      screen.getByDisplayValue("https://ff.example/farmer/onboarding/fresh-token"),
    );
    expect(
      screen.getByRole("group", { name: "New setup link for Waiting Farm" }),
    ).toHaveTextContent(/only show it once/i);
  });

  it("copies a new setup link without a second press, and says so", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        response(200, { status: "created", channel: "sms", farmName: "Waiting Farm", link: "https://ff.example/x" }),
      ),
    );
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<FarmList farms={[waitingFarm]} />);
    await user.click(screen.getAllByText("Waiting Farm")[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "New setup link for Waiting Farm" }));

    expect(writeText).toHaveBeenCalledWith("https://ff.example/x");
    expect(await screen.findByRole("status")).toHaveTextContent(/copied/i);
  });

  it("says nothing is waiting when a farm already has someone who can update it (F-071)", async () => {
    const user = userEvent.setup();
    render(
      <FarmList
        farms={[
          {
            ...waitingFarm,
            farmId: "farm-covered",
            name: "Covered Farm",
            invitationState: "not_applicable",
            invitationExpiresAt: null,
            access: [
              {
                authorizationId: "auth-1",
                senderMask: "(•••) •••-0701",
                authorizedAt: "2026-08-01T10:00:00Z",
                revokedAt: null,
                stands: [],
                hasLiveLink: false,
                liveLinkStand: null,
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getAllByText("Covered Farm")[0] as HTMLElement);
    expect(screen.getByText(/can update since/i)).toBeTruthy();
    // No setup-link offer for a farm that already has a farmer: the button would invite the
    // operator to solve a problem this farm does not have.
    expect(screen.queryByRole("button", { name: /new setup link/i })).toBeNull();
  });

  it("loads a retained thread honestly and marks the flagged message accessibly", async () => {
    const user = userEvent.setup();
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );

    render(
      <FlagQueue
        flags={[
          {
            flagId: "flag-1",
            senderMask: "(•••) •••-0701",
            reasonCode: "requested_review",
            status: "open",
            dispositionCode: null,
            disposedByEmail: null,
            disposedAt: null,
            createdAt: "2026-08-01T10:00:00Z",
            hasReadableThread: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View thread" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading thread");

    finish(
      response(200, {
        thread: {
          messages: [
            {
              messageId: "message-1",
              receivedAt: "2026-08-01T10:00:00Z",
              body: "Please review this",
              bodyPurged: false,
              isFlagged: true,
            },
          ],
        },
      }),
    );

    expect(await screen.findByLabelText("Flagged message")).toHaveTextContent(
      "Please review this",
    );
    expect(screen.getByText(/older messages can be deleted on their normal schedule/i)).toBeTruthy();
  });

  it("keeps review and resolution actions explicitly separate from public listings", () => {
    render(
      <>
        <ReportQueue
          reports={[
            {
              reportId: "report-1",
              farmName: "Example Farm",
              salesLocationName: "Road stand",
              itemText: "eggs",
              status: "open",
              reviewedByEmail: null,
              reportedAt: "2026-08-01T10:00:00Z",
            },
          ]}
        />
        <StandDataQueue
          flags={[
            {
              flagId: "data-1",
              standName: "Road stand",
              reason: "contradictory_hours",
              sourceText: "Open 8 and open 9",
              resolutionNote: null,
              resolvedByEmail: null,
              createdAt: "2026-08-01T10:00:00Z",
            },
          ]}
        />
      </>,
    );

    // Both queues must state the boundary, in whatever words each uses: recording a decision
    // is not editing a listing (Golden Rule #1). Anchored on the two phrasings that carry
    // that meaning rather than on one exact sentence, so rewording the copy does not silently
    // drop the guarantee — the assertion is that the boundary is SAID, on both queues.
    expect(
      screen.getAllByText(/does not change the map|is the farmer’s, not yours/i),
    ).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /edit listing/i })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Resolution note for Road stand" })).toBeTruthy();
  });

  it("recovers every review queue from an expired session", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => response(403)));

    const { unmount: unmountFlag } = render(
      <FlagQueue
        flags={[
          {
            flagId: "flag-expired",
            senderMask: "(•••) •••-0701",
            reasonCode: "requested_review",
            status: "open",
            dispositionCode: null,
            disposedByEmail: null,
            disposedAt: null,
            createdAt: "2026-08-01T10:00:00Z",
            hasReadableThread: true,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "View thread" }));
    expect(await screen.findByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/admin/login",
    );
    unmountFlag();

    const { unmount: unmountReport } = render(
      <ReportQueue
        reports={[
          {
            reportId: "report-expired",
            farmName: "Example Farm",
            salesLocationName: "Road stand",
            itemText: "eggs",
            status: "open",
            reviewedByEmail: null,
            reportedAt: "2026-08-01T10:00:00Z",
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/admin/login",
    );
    unmountReport();

    render(
      <StandDataQueue
        flags={[
          {
            flagId: "data-expired",
            standName: "Road stand",
            reason: "contradictory_hours",
            sourceText: "Open 8 and open 9",
            resolutionNote: null,
            resolvedByEmail: null,
            createdAt: "2026-08-01T10:00:00Z",
          },
        ]}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Resolution note for Road stand" }),
      "Confirmed with VIGA",
    );
    await user.click(screen.getByRole("button", { name: "Record decision" }));
    expect(await screen.findByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/admin/login",
    );
  });

  it("announces the effects of flag, report, and stand-data decisions", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => response(200)));

    const { unmount: unmountFlag } = render(
      <FlagQueue
        flags={[
          {
            flagId: "flag-action",
            senderMask: "(•••) •••-0701",
            reasonCode: "requested_review",
            status: "open",
            dispositionCode: null,
            disposedByEmail: null,
            disposedAt: null,
            createdAt: "2026-08-01T10:00:00Z",
            hasReadableThread: true,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(screen.getByRole("textbox", { name: "Decision note for (•••) •••-0701" })).toBeTruthy();
    await user.type(
      screen.getByRole("textbox", { name: "Decision note for (•••) •••-0701" }),
      "Called the sender",
    );
    await user.click(screen.getByRole("button", { name: "Save decision" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /older messages can now be deleted on their normal schedule/i,
    );
    expect(screen.getByText(/resolved — called the sender/i)).toBeTruthy();
    unmountFlag();

    const { unmount: unmountReport } = render(
      <ReportQueue
        reports={[
          {
            reportId: "report-action",
            farmName: "Example Farm",
            salesLocationName: "Road stand",
            itemText: "eggs",
            status: "open",
            reviewedByEmail: null,
            reportedAt: "2026-08-01T10:00:00Z",
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /report marked reviewed.*map has not changed/i,
    );
    expect(screen.getByText("Reviewed")).toBeTruthy();
    unmountReport();

    render(
      <StandDataQueue
        flags={[
          {
            flagId: "data-action",
            standName: "Road stand",
            reason: "contradictory_hours",
            sourceText: "Open 8 and open 9",
            resolutionNote: null,
            resolvedByEmail: null,
            createdAt: "2026-08-01T10:00:00Z",
          },
        ]}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Resolution note for Road stand" }),
      "Confirmed 9am opening",
    );
    await user.click(screen.getByRole("button", { name: "Record decision" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /answer recorded.*closed/i,
    );
    expect(screen.getByText(/resolved: confirmed 9am opening/i)).toBeTruthy();
  });
});

describe("the farmer stand form", () => {
  const settingsLocations = [
    { salesLocationId: "stand-a", locationName: "Orchard Stand", selected: true, cadence: null },
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
    render(<SettingsForm token="private-token" locations={settingsLocations} participantNamesByLocation={{ "stand-a": ["Guest Growers"] }} />);

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
        locations={settingsLocations}
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
    render(<SettingsForm token="private-token" locations={settingsLocations} participantNamesByLocation={{ "stand-a": ["Guest Growers"] }} />);

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
