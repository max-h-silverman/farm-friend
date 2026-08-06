// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StandForm } from "./stand-form";

const CURRENT = [
  { entryId: "e1", itemName: "Eggs", quantity: 12, unit: "dozen" },
  { entryId: "e2", itemName: "Kale" },
];

describe("StandForm", () => {
  it("keeps a daily availability update focused on one primary task", () => {
    render(<StandForm token="private-token" currentEntries={[]} />);

    expect(screen.getByLabelText("What changed at your stand today?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview update" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Also selling here" })).not.toBeInTheDocument();
  });

  // A farmer cannot reason about "what changed" without seeing what is there now. Worse,
  // they cannot tell whether typing "eggs and bok choy" ADDS to their listing or REPLACES
  // it — and those differ by whether kale survives. Showing the listing makes the question
  // answerable on the page instead of after the fact in a confirmation.
  it("shows what the stand is currently listing", () => {
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    expect(screen.getByText(/Eggs/)).toBeVisible();
    expect(screen.getByText(/Kale/)).toBeVisible();
  });

  it("says that unmentioned items stay, so the farmer knows this adds rather than replaces", () => {
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    // The system's actual rule (omission preserves) stated where the farmer types, not
    // buried in a confirmation they reach afterwards.
    expect(screen.getByText(/stays? on your listing|will stay|unless you say/i)).toBeVisible();
  });

  it("tells a farmer with nothing listed that this is their first update", () => {
    render(<StandForm token="private-token" currentEntries={[]} />);

    // An empty listing must not render an empty "currently showing" box, which reads as
    // a loading failure rather than as a stand that has published nothing yet.
    expect(screen.getByText(/nothing listed|no items/i)).toBeVisible();
  });
});
