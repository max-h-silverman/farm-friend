// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu } from "./action-menu";

/*
  ONE MENU MECHANISM for the whole console.

  A card's Actions button and a row's kebab are the same thing at two sizes, so they are one
  component with a prop rather than two that drift. What this owns:

    - Nothing is reachable until the menu is opened, so a card at rest shows its identity and
      its states, never five buttons competing with the name.
    - Choosing an item closes the menu. A menu that stays open over the result of the thing it
      just did hides the answer the operator pressed for.
    - Escape and a click outside close it WITHOUT running anything — a menu that commits on
      dismissal is a menu that acts on a misclick.
    - A destructive item is marked as such and still needs its own confirmation downstream;
      this only has to render it distinctly and not hide it.
*/

function open(label = "Actions") {
  return userEvent.click(screen.getByRole("button", { name: new RegExp(label, "i") }));
}

describe("ActionMenu", () => {
  it("hides its items until it is opened", async () => {
    render(
      <ActionMenu label="Actions" items={[{ key: "edit", label: "Edit details", onSelect: vi.fn() }]} />,
    );

    expect(screen.queryByRole("menuitem", { name: /edit details/i })).toBeNull();
    expect(screen.getByRole("button", { name: /actions/i })).toHaveAttribute("aria-expanded", "false");

    await open();

    expect(screen.getByRole("menuitem", { name: /edit details/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /actions/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("runs the chosen item once and closes", async () => {
    const onSelect = vi.fn();
    render(<ActionMenu label="Actions" items={[{ key: "edit", label: "Edit details", onSelect }]} />);

    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: /edit details/i }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("closes on Escape without running anything", async () => {
    const onSelect = vi.fn();
    render(<ActionMenu label="Actions" items={[{ key: "edit", label: "Edit details", onSelect }]} />);

    await open();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on a click outside without running anything", async () => {
    const onSelect = vi.fn();
    render(
      <div>
        <p>elsewhere</p>
        <ActionMenu label="Actions" items={[{ key: "edit", label: "Edit details", onSelect }]} />
      </div>,
    );

    await open();
    await userEvent.click(screen.getByText("elsewhere"));

    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks a destructive item so it does not read as one more choice", async () => {
    render(
      <ActionMenu
        label="Actions"
        items={[
          { key: "edit", label: "Edit details", onSelect: vi.fn() },
          { key: "off", label: "Take off the map", danger: true, onSelect: vi.fn() },
        ]}
      />,
    );

    await open();

    expect(screen.getByRole("menuitem", { name: /take off the map/i })).toHaveClass(
      "admin-menu-item--danger",
    );
  });

  it("omits an item the caller did not offer, rather than disabling it", async () => {
    render(
      <ActionMenu
        label="Actions"
        items={[
          { key: "edit", label: "Edit details", onSelect: vi.fn() },
          null,
          { key: "off", label: "Take off the map", onSelect: vi.fn() },
        ]}
      />,
    );

    await open();

    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("names an icon-only trigger for a screen reader", async () => {
    render(
      <ActionMenu
        label="More for Bank Road Gardens"
        compact
        items={[{ key: "edit", label: "Edit details", onSelect: vi.fn() }]}
      />,
    );

    expect(screen.getByRole("button", { name: /more for bank road gardens/i })).toBeInTheDocument();
  });
});

/*
  AN OPEN MENU OUTRANKS THE CARDS BELOW IT (max, 2026-08-17).

  Every card's actions cell is its own stacking context, so an open menu could only ever be
  painted at its OWN card's level — and a card further down the list, painting later, covered
  it. The menu's own `z-index` could not help: it competes inside its parent's context, not
  against the parent's siblings.

  So the open menu marks its wrapper, and the stylesheet raises that one context. Asserted on
  the attribute the CSS actually selects, because jsdom computes no cascade — a test reading
  the painted result here would prove nothing.
*/
describe("an open menu is raised above the cards below it", () => {
  it("marks its wrapper only while open", async () => {
    const { container } = render(
      <ActionMenu label="Actions" items={[{ key: "edit", label: "Edit details", onSelect: vi.fn() }]} />,
    );
    const wrapper = container.querySelector(".admin-menu");

    expect(wrapper).not.toHaveAttribute("data-open");

    await open();
    expect(wrapper).toHaveAttribute("data-open", "true");
  });

  it("drops the mark when it closes, so a shut card stops outranking anything", async () => {
    const { container } = render(
      <ActionMenu label="Actions" items={[{ key: "edit", label: "Edit details", onSelect: vi.fn() }]} />,
    );
    const wrapper = container.querySelector(".admin-menu");

    await open();
    await userEvent.keyboard("{Escape}");

    expect(wrapper).not.toHaveAttribute("data-open");
  });
});
