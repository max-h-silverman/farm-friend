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
import { StandList } from "../app/admin/stand-list";
import { StandDataQueue } from "../app/admin/stand-data/stand-data-queue";
import { UserList } from "../app/admin/user-list";
import { StandForm } from "../app/stand/[token]/stand-form";

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
  it("uses four plain-language top-level work areas", () => {
    render(
      <AdminShell
        currentPath="/admin"
      >
        <p>Stands</p>
      </AdminShell>,
    );

    expect(
      screen.getAllByRole(
        "link",
        { name: /^(stands|people|needs attention|stock reports)$/i },
      ),
    ).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Stands" })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("link", { name: "People" })).toHaveAttribute(
      "href",
      "/admin/farmers",
    );
    expect(screen.getByRole("link", { name: "Needs attention" })).toHaveAttribute(
      "href",
      "/admin/flags",
    );
    expect(screen.getByRole("link", { name: "Stock reports" })).toHaveAttribute(
      "href",
      "/admin/reports",
    );
    expect(screen.queryByRole("link", { name: "Farm approval" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Stand data" })).toBeNull();
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
        currentPath="/admin/flags"
        fetcher={fetcher}
        onSignedOut={signedOut}
      >
        <p>Queue</p>
      </AdminShell>,
    );

    expect(screen.getByRole("link", { name: "Needs attention" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("heading", { name: "Flag review" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(fetcher).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(signedOut).toHaveBeenCalledOnce();
  });

  it("renders one generic signed-out recovery state with no membership clue", () => {
    render(<SignedOutAdmin />);

    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute(
      "href",
      "/admin/login",
    );
    expect(screen.getByText(/session may have expired/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/recognized|provisioned|authorized address/i);
  });
});

describe("the stand list", () => {
  it("keeps the scan view to stand, status, open state, and approval, then reveals metadata on demand", async () => {
    const user = userEvent.setup();
    render(
      <StandList
        stands={[
          {
            standId: "stand-1",
            name: "North Stand",
            farmName: "Example Farm",
            status: "Public",
            openState: "Open now",
            approved: true,
            metadata: [
              ["Farm", "Example Farm"],
              ["Address", "123 Farm Lane"],
              ["Hours", "Daily, 9am–5pm"],
              ["Offerings", "Eggs, flowers"],
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("North Stand")).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
    expect(screen.getByText("Open now")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.queryByText("123 Farm Lane")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show details for North Stand" }));

    expect(screen.getByText("123 Farm Lane")).toBeTruthy();
    expect(screen.getByText("Eggs, flowers")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide details for North Stand" })).toBeTruthy();
  });
});

describe("administrator language", () => {
  it("uses map language and action-first labels in the stand and farmer queues", () => {
    render(
      <>
        <StandList
          stands={[
            {
              standId: "stand-language",
              name: "North Stand",
              farmName: "Example Farm",
              status: "Shown on map",
              openState: "Open now",
              approved: true,
              metadata: [["Visit in person", "Yes"]],
            },
          ]}
        />
        <FarmerQueue
          requests={[]}
          authorizations={[]}
          farms={[]}
        />
      </>,
    );

    expect(screen.getByText("Shown on map")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Farmers waiting to join" })).toBeTruthy();
    expect(screen.getByText(/no requests right now/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Current farmer access" })).toBeTruthy();
    expect(screen.queryByText("Waiting on you")).toBeNull();
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

    await user.selectOptions(screen.getByRole("combobox", { name: "Show" }), "farmer");
    expect(screen.getByText("(•••) •••-0701")).toBeTruthy();
    expect(screen.queryByText("(•••) •••-0702")).toBeNull();

    await user.selectOptions(screen.getByRole("combobox", { name: "Show" }), "not_farmer");
    expect(screen.queryByText("(•••) •••-0701")).toBeNull();
    expect(screen.getByText("(•••) •••-0702")).toBeTruthy();
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

    await user.click(screen.getByRole("button", { name: "Remove approval" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/session expired/i);
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/admin/login",
    );
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
        authorizations={[
          {
            authorizationId: "authorization-1",
            farmId: "farm-1",
            farmName: "Example Farm",
            senderMask: "(•••) •••-0702",
            authorizedAt: "2026-08-01T10:00:00Z",
            revokedAt: null,
            stands: [
              { salesLocationId: "stand-1", name: "North Stand" },
              { salesLocationId: "stand-2", name: "South Stand" },
            ],
            hasLiveLink: false,
            liveLinkStand: null,
          },
        ]}
        farms={[{ farmId: "farm-1", name: "Example Farm" }]}
      />,
    );

    expect(document.body.textContent).not.toContain("+1206");
    await user.selectOptions(screen.getByRole("combobox", { name: "Which farm do they run?" }), "farm-1");
    await user.click(screen.getByRole("button", { name: "Give access" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/farmer access given/i);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Which stand can this link update?" }),
      "stand-2",
    );
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/admin/farmers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "issue_link",
          authorizationId: "authorization-1",
          salesLocationId: "stand-2",
        }),
      }),
    );
    const copy = await screen.findByRole("button", { name: "Copy private link" });
    await user.click(copy);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://ff.example/stand/private",
    );
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

    expect(screen.getAllByText(/does not change the map/i)).toHaveLength(2);
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
    vi.spyOn(window, "prompt").mockReturnValue("Called the sender");

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
      /your decision is recorded.*map has not changed/i,
    );
    expect(screen.getByText(/resolved: confirmed 9am opening/i)).toBeTruthy();
  });
});

describe("the farmer stand form", () => {
  it("saves the one-name-per-line seller list separately from inventory", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue(
      response(200, {
        status: "saved",
        activeDisplayNames: ["Guest Growers", "Island Apiary"],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(
      <StandForm token="private-token" initialParticipantNames={["Guest Growers"]} />,
    );

    const names = screen.getByRole("textbox", { name: "Also selling here" });
    expect(names).toHaveValue("Guest Growers");
    expect(screen.getByText(/one farm or business name per line/i)).toBeTruthy();
    expect(screen.getByText(/does not give anyone access/i)).toBeTruthy();
    await user.type(names, "{enter}Island Apiary");
    await user.click(screen.getByRole("button", { name: "Save seller names" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/seller names saved/i);
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

  it("lets the owner save an empty seller list explicitly", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(200, { status: "saved", activeDisplayNames: [] }),
      ),
    );
    render(<StandForm token="private-token" initialParticipantNames={[]} />);

    const names = screen.getByRole("textbox", { name: "Also selling here" });
    expect(names).toHaveValue("");
    expect(names).not.toHaveAttribute("placeholder");
    await user.click(screen.getByRole("button", { name: "Save seller names" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/no other sellers are shown/i);
    expect(names).not.toHaveAttribute("placeholder");
  });

  it("keeps seller names unchanged on validation error and shows revocation recovery", async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(409, { message: "Please remove the phone number." }))
      .mockResolvedValueOnce(response(403));
    vi.stubGlobal("fetch", fetcher);
    render(
      <StandForm token="private-token" initialParticipantNames={["Guest Growers"]} />,
    );

    const names = screen.getByRole("textbox", { name: "Also selling here" });
    await user.type(names, "{enter}Call 206-555-0199");
    await user.click(screen.getByRole("button", { name: "Save seller names" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please remove the phone number.",
    );
    expect(names).toHaveValue("Guest Growers\nCall 206-555-0199");

    await user.click(screen.getByRole("button", { name: "Save seller names" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/link is no longer active/i);
    expect(screen.getByRole("link", { name: "How to get a new link" })).toHaveAttribute(
      "href",
      "#new-link-help",
    );
  });

  it("moves through clarification, exact preview, decline, and publication with honest effects", async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(200, { outcome: "clarification", question: "Which kind of squash?" }))
      .mockResolvedValueOnce(
        response(200, {
          outcome: "proposed",
          proposalId: "proposal-1",
          confirmationText: "Winter squash — 3 at $4",
        }),
      )
      .mockResolvedValueOnce(response(200, { outcome: "declined" }))
      .mockResolvedValueOnce(
        response(200, {
          outcome: "proposed",
          proposalId: "proposal-2",
          confirmationText: "Kale — $3/bunch",
        }),
      )
      .mockResolvedValueOnce(response(200, { outcome: "published" }));
    vi.stubGlobal("fetch", fetcher);

    render(<StandForm token="private-token" />);
    const input = screen.getByRole("textbox", { name: "What does your stand have today?" });
    await user.type(input, "squash");
    await user.click(screen.getByRole("button", { name: "Preview update" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Which kind of squash?");
    expect(input).toHaveFocus();

    await user.clear(input);
    await user.type(input, "three winter squash at $4");
    await user.click(screen.getByRole("button", { name: "Preview update" }));
    expect(await screen.findByRole("region", { name: "Exact publication preview" })).toHaveTextContent(
      "Winter squash — 3 at $4",
    );
    expect(screen.getByText("Nothing has changed yet.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Decline this update" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing changed");

    const returnedInput = screen.getByRole("textbox", {
      name: "What does your stand have today?",
    });
    await user.clear(returnedInput);
    await user.type(returnedInput, "kale $3 a bunch");
    await user.click(screen.getByRole("button", { name: "Preview update" }));
    await user.click(await screen.findByRole("button", { name: "Confirm and publish" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your stand is updated");

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
    render(<StandForm token="private-token" />);

    await user.type(
      screen.getByRole("textbox", { name: "What does your stand have today?" }),
      "eggs",
    );
    await user.click(screen.getByRole("button", { name: "Preview update" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/listing is unchanged/i);
    expect(screen.getByRole("link", { name: "How to get a new link" })).toHaveAttribute(
      "href",
      "#new-link-help",
    );
  });

  it("clears a prior terminal status when a new proposal begins and fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(200, {
            outcome: "proposed",
            proposalId: "proposal-1",
            confirmationText: "Kale — $3/bunch",
          }),
        )
        .mockResolvedValueOnce(response(200, { outcome: "published" }))
        .mockResolvedValueOnce(response(500, { message: "Could not save the proposal." })),
    );
    render(<StandForm token="private-token" />);

    const input = screen.getByRole("textbox", {
      name: "What does your stand have today?",
    });
    await user.type(input, "kale $3 a bunch");
    await user.click(screen.getByRole("button", { name: "Preview update" }));
    await user.click(await screen.findByRole("button", { name: "Confirm and publish" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your stand is updated");

    const nextInput = screen.getByRole("textbox", {
      name: "What does your stand have today?",
    });
    await user.type(nextInput, "eggs");
    await user.click(screen.getByRole("button", { name: "Preview update" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the proposal.");
    expect(screen.queryByText("Your stand is updated. Thank you!")).toBeNull();
  });
});
