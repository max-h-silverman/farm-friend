// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { StandTabs } from "./stand-tabs";

// F-090 — the farmer's own stand page as TABS.
//
// max's call (2026-08-08): a farmer coming back should jump straight to the thing they came
// for, rather than being marched through a wizard. Onboarding is linear because it happens
// once; editing is not.
//
// **This replaces two links below the status form.** `/stand/[token]/listing` and
// `/stand/[token]/settings` were separate pages reached by a nav headed "Change your stand's
// details", which put the two most common return errands one navigation away from the screen
// the farmer landed on. The tabs are that nav, and the pages it pointed at are the panels.
//
// What is asserted here is the SHAPE, not the fields: each panel's contents have their own
// suites (`stand-form`, `listing-step`, `settings-form`), and restating them here would be a
// second statement of the same fact that can drift.

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the farmer's stand page as tabs (F-090)", () => {
  function renderTabs() {
    render(
      <StandTabs
        statusPanel={<p>status panel</p>}
        detailsPanel={<p>details panel</p>}
      />,
    );
  }

  it("opens on the status tab, because that is what a farmer comes back to do", () => {
    // Reporting today's stock is the recurring errand; changing an address is the rare one.
    // The landing tab is the product decision this asserts.
    renderTabs();

    expect(screen.getByText("status panel")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Stock today" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows the details panel when that tab is chosen", async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole("tab", { name: "Details & settings" }));

    expect(screen.getByText("details panel")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Details & settings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps the hidden panel MOUNTED, so a half-typed update survives a tab switch", async () => {
    // The same rule the wizard's steps follow, and for a sharper reason here: a farmer who
    // types half an update, checks their hours on the other tab, and comes back must find
    // their work. Unmounting would silently discard it.
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole("tab", { name: "Details & settings" }));

    // Present in the document, not visible — two different facts, and only one is safe.
    expect(screen.getByText("status panel")).toBeInTheDocument();
    expect(screen.getByText("status panel")).not.toBeVisible();
  });

  it("marks each panel as the tab's own region, for a screen reader", () => {
    // `role="tabpanel"` with `aria-labelledby` is what makes this a tab set rather than two
    // divs that happen to toggle. Without it a screen reader announces no relationship
    // between the control and what it reveals.
    renderTabs();

    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(panels).toHaveLength(2);
    for (const panel of panels) {
      expect(panel).toHaveAttribute("aria-labelledby");
    }
  });
});
