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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("farmer reminder settings", () => {
  it("shows unscheduled and paused stands as explicit per-stand states", () => {
    render(<SettingsForm token="private-token" locations={locations} />);
    expect(screen.getAllByLabelText("Reminder schedule")).toHaveLength(2);
    expect(screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }))
      .toHaveValue("");
    expect(screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-b" }))
      .toHaveValue("paused");
    expect(screen.getByText(/Pausing reminders does not change your SMS consent/)).toBeVisible();
  });

  it("shows loading and then the saved stand name for a successful cadence write", async () => {
    let release = () => {};
    const response = new Promise<Response>((resolve) => {
      release = () => resolve(new Response("{}", { status: 200 }));
    });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" locations={locations} />);

    await user.selectOptions(screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }), "weekly");
    await user.click(screen.getAllByRole("button", { name: "Save reminder" })[0]!);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    release();
    expect(await screen.findByText("Saved reminder schedule for Orchard Stand.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/api/farmer/settings", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        token: "private-token",
        salesLocationId: "stand-a",
        cadence: "weekly",
      }),
    }));
  });

  it("explains a revoked link without claiming the schedule changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" locations={locations} />);
    await user.selectOptions(screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }), "every_2_days");
    await user.click(screen.getAllByRole("button", { name: "Save reminder" })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This link is no longer active. Your reminder schedule is unchanged.",
    );
    expect(screen.getByRole("link", { name: "How to get a new link" })).toBeVisible();
  });

  it("shows a recoverable error without claiming the schedule changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" locations={locations} />);
    await user.selectOptions(screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }), "every_2_weeks");
    await user.click(screen.getAllByRole("button", { name: "Save reminder" })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That did not go through. Your reminder schedule is unchanged — try again.",
    );
  });
});
