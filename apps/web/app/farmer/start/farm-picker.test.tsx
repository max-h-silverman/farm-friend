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

    const link = screen.getByRole("link", { name: /Lavender Hill Farm/ });
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
});
