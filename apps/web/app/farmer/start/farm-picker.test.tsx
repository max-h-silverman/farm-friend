// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { FarmPicker } from "./farm-picker";

const FARMS = [
  { farmId: "farm-a", farmName: "Lavender Hill Farm", onboarded: false },
  { farmId: "farm-b", farmName: "Holmestead", onboarded: true },
];

describe("FarmPicker", () => {
  it("links a claimable farm UNDER the secret base path", async () => {
    // F-079 — the onward link has to carry the secret, or the farmer's very next step 404s.
    // Building it from a passed base path rather than a hard-coded `/farmer/start/` is what
    // keeps one picker serving the door instead of a second near-identical component.
    render(<FarmPicker farms={FARMS} basePath="/farmer/start/the-secret" />);
    await userEvent.selectOptions(screen.getByLabelText("Your farm"), "farm-a");

    // Anchored to the HREF, not the link's wording: carrying the secret is the guarantee,
    // while the label is copy that is expected to change.
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/farmer/start/the-secret/farm-a");
  });

  it("offers the email step for a farm that is already set up", async () => {
    render(<FarmPicker farms={FARMS} basePath="/farmer/start/the-secret" />);
    await userEvent.selectOptions(screen.getByLabelText("Your farm"), "farm-b");

    // An already-onboarded farmer wants their existing update link, not a second setup.
    expect(screen.getByText(/already on Farm Friend/)).toBeTruthy();
  });

  it("shows nothing onward until a farm is picked", () => {
    render(<FarmPicker farms={FARMS} basePath="/farmer/start/the-secret" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  // The onward control is a LINK, not a button calling `window.location`. Both navigate, but
  // only a link supports cmd-click, middle-click, "open in new tab", and a visible target in
  // the status bar — and this is a farmer on a phone who may want to keep the list open.
  it("navigates with a real link so the browser's own affordances work", async () => {
    render(<FarmPicker farms={FARMS} basePath="/farmer/start/the-secret" />);
    await userEvent.selectOptions(screen.getByLabelText("Your farm"), "farm-a");

    // The onward control must be the link, and there must be no button standing in for it.
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/farmer/start/the-secret/farm-a",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("tells the farmer where they are in the flow", () => {
    // The two steps live on different URLs, so without this the second screen reads as an
    // unrelated page rather than the next step of the same task.
    render(<FarmPicker farms={FARMS} basePath="/farmer/start/the-secret" />);
    expect(screen.getByText(/Step 1 of 2/i)).toBeTruthy();
  });
});
