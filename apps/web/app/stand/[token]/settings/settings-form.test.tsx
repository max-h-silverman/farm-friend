// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsForm } from "./settings-form";

const locations: Parameters<typeof SettingsForm>[0]["locations"] = [
  { salesLocationId: "stand-a", locationName: "Orchard Stand", selected: true, cadence: null },
  { salesLocationId: "stand-b", locationName: "Harbor Stand", selected: false, cadence: "paused" as const },
];

/** The common case on Vashon: one stand, so no stand to choose between. */
const oneStand: Parameters<typeof SettingsForm>[0]["locations"] = [
  { salesLocationId: "stand-a", locationName: "Orchard Stand", selected: true, cadence: "weekly" as const },
];

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("farmer reminder settings", () => {
  it("keeps seller names with stand setup rather than the daily-update form", () => {
    render(
      <SettingsForm
        token="private-token"
        locations={locations}
        participantNamesByLocation={{ "stand-a": ["Neighbor Farm"] }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Also selling here" })).toBeVisible();
    expect(screen.getByLabelText("Seller names")).toHaveValue("Neighbor Farm");
  });

  it("asks nothing about a default stand when there is only one", () => {
    // F-097 (max, 2026-08-08). A radio group with a single radio is a question with one
    // answer. `STAND` already says "if you have more than one"; this is that rule on the web.
    render(<SettingsForm token="private-token" locations={oneStand} />);

    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(/which stand your texts are about/i)).not.toBeInTheDocument();
    // The reminder schedule is still offered — it is per-stand, not a choice BETWEEN stands.
    expect(screen.getByLabelText("Reminder schedule")).toBeVisible();
    // And it does not label the one stand by name, which would be telling the farmer apart
    // from nobody.
    expect(screen.queryByRole("heading", { name: "Orchard Stand" })).not.toBeInTheDocument();
  });

  it("offers the default-stand choice as soon as there are two", () => {
    render(<SettingsForm token="private-token" locations={locations} />);
    expect(screen.getByRole("radio", { name: "Orchard Stand" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Harbor Stand" })).toBeVisible();
  });

  it("saves the whole panel with ONE button, and never says Submit", async () => {
    // The panel had three save buttons — one per writer — for what a farmer reads as one
    // screen, and one of them said "Submit", which is onboarding's word.
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" locations={oneStand} />);

    expect(screen.queryByRole("button", { name: /submit/i })).not.toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("Save settings");

    // Nothing changed yet, so there is nothing to save.
    expect(buttons[0]).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Reminder schedule"), "every_2_days");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  });

  it("writes only what the farmer actually changed", async () => {
    // With one button covering three writers, sending all of them every time would file a
    // participant audit event claiming the seller list was edited whenever a farmer touched
    // their reminder schedule.
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <SettingsForm
        token="private-token"
        locations={oneStand}
        participantNamesByLocation={{ "stand-a": ["Neighbor Farm"] }}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Reminder schedule"), "every_2_days");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("Settings saved.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/farmer/settings",
      expect.objectContaining({
        body: JSON.stringify({
          token: "private-token",
          salesLocationId: "stand-a",
          cadence: "every_2_days",
        }),
      }),
    );
  });

  it("saves a seller-name edit through the participant writer, and nothing else", async () => {
    const fetchMock = vi.fn(async () => Response.json({ activeDisplayNames: ["Neighbor Farm"] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" locations={oneStand} />);

    await user.type(screen.getByLabelText("Seller names"), "Neighbor Farm");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("Settings saved.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/farmer/stand",
      expect.objectContaining({
        body: JSON.stringify({
          token: "private-token",
          action: "save_participants",
          participantNames: ["Neighbor Farm"],
        }),
      }),
    );
  });

  it("loads the newly selected stand's seller names after its default changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ locationName: "Harbor Stand" })),
    );
    const user = userEvent.setup();
    render(
      <SettingsForm
        token="private-token"
        locations={locations}
        participantNamesByLocation={{
          "stand-a": ["Neighbor Farm"],
          "stand-b": ["Harbor Apiary"],
        }}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Harbor Stand" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByLabelText("Seller names")).toHaveValue("Harbor Apiary");
  });

  it("shows unscheduled and paused stands as explicit per-stand states", () => {
    render(<SettingsForm token="private-token" locations={locations} />);
    expect(screen.getAllByLabelText("Reminder schedule")).toHaveLength(2);
    expect(screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }))
      .toHaveValue("");
    expect(screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-b" }))
      .toHaveValue("paused");
    expect(screen.getByText(/Pausing reminders does not stop your other texts/)).toBeVisible();
  });

  it("explains a revoked link without claiming the schedule changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" locations={locations} />);
    await user.selectOptions(
      screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }),
      "every_2_days",
    );
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This link is no longer active. Your reminder schedule is unchanged.",
    );
    expect(screen.getByRole("link", { name: "How to get a new link" })).toBeVisible();
  });

  it("shows a recoverable error without claiming the schedule changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" locations={locations} />);
    await user.selectOptions(
      screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }),
      "every_2_weeks",
    );
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That did not go through. Your reminder schedule is unchanged — try again.",
    );
  });

  it("does not report success when one of several writes fails", async () => {
    // The lie this prevents: "Settings saved." over a screen where the cadence took and the
    // seller names did not. A partial save must read as a failure, not a success.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" locations={oneStand} />);

    await user.selectOptions(screen.getByLabelText("Reminder schedule"), "every_2_days");
    await user.type(screen.getByLabelText("Seller names"), "Neighbor Farm");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByText("Settings saved.")).not.toBeInTheDocument();
  });
});
