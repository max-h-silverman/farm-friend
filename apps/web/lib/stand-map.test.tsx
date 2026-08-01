// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StandMap } from "../app/stand-map";
import type { PublicStandPayload } from "./map-view";

afterEach(cleanup);

describe("public participant names", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("shows active names as plain text on both the card and mobile detail sheet", async () => {
    const user = userEvent.setup();
    const stand: PublicStandPayload = {
      id: "shared-stand",
      farmName: "Host Farm",
      locationName: "Shared Stand",
      visitability: "visitable",
      offeringType: "produce",
      address: "50 Participant Way",
      latitude: 47.44,
      longitude: -122.46,
      updated: "updated 1 hour ago",
      confirmedElapsed: "1 hour ago",
      stale: false,
      availability: {},
      alsoSellingHere: ["Guest Growers", "Island Apiary"],
      items: [{ itemName: "Kale" }],
    };

    render(<StandMap stands={[stand]} />);

    const card = screen.getByRole("heading", { name: "Shared Stand" }).closest("li")!;
    expect(within(card).getByText("Also selling here")).toBeTruthy();
    expect(within(card).getByText("Guest Growers").closest("a")).toBeNull();
    expect(within(card).getByText("Island Apiary").closest("a")).toBeNull();
    expect(within(card).getByText("Kale").closest(".items")).not.toContainElement(
      within(card).getByText("Guest Growers"),
    );

    await user.click(
      screen.getByRole("button", { name: "1. Shared Stand, Host Farm" }),
    );
    const sheet = screen.getByRole("dialog", { name: "Shared Stand details" });
    expect(within(sheet).getByText("Also selling here")).toBeTruthy();
    expect(within(sheet).getByText("Guest Growers").closest("a")).toBeNull();
    expect(within(sheet).getByText("Island Apiary").closest("a")).toBeNull();
  });
});
