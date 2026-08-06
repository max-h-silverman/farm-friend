// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StandForm } from "./stand-form";

const CURRENT = [
  { entryId: "e1", itemName: "Eggs", quantity: 12, unit: "dozen" },
  { entryId: "e2", itemName: "Kale" },
];

describe("StandForm", () => {
  it("keeps a daily availability update focused on one primary task", () => {
    render(<StandForm token="private-token" currentEntries={[]} />);

    // The primary task is now editing the listing directly. Free text remains, as the
    // escape hatch for what chips cannot say, and is labelled as the alternative it is.
    expect(screen.getByLabelText(/add something/i)).toBeVisible();
    expect(screen.getByLabelText(/in your own words/i)).toBeVisible();
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

  it("leaves untouched items visibly untouched, rather than explaining that it will", async () => {
    // This replaces a sentence that TOLD the farmer omission preserves. With the listing
    // directly editable the rule is shown instead of stated: removing one chip marks that
    // chip and nothing else, so "does this add or replace?" is not a question the screen
    // raises. Copy explaining a rule is weaker than an interface that embodies it.
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    await user.click(screen.getByRole("button", { name: /remove kale/i }));

    // Eggs was never touched and still offers its own remove control, unmarked.
    expect(screen.getByRole("button", { name: /remove eggs/i })).toBeVisible();
  });

  it("tells a farmer with nothing listed that this is their first update", () => {
    render(<StandForm token="private-token" currentEntries={[]} />);

    // An empty listing must not render an empty "currently showing" box, which reads as
    // a loading failure rather than as a stand that has published nothing yet.
    expect(screen.getByText(/nothing listed|no items/i)).toBeVisible();
  });

  // A stand listing is a SET OF SHORT STRINGS, so direct manipulation beats composing a
  // sentence about it. Removing an item is one tap, not "sold out of kale" typed out. The
  // chips post the typed edit shape directly — no model call — and still reach the same
  // confirmation gate, so nothing about who may publish changes.
  describe("editing by chip", () => {
    function stubFetch(body: unknown) {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => body,
      })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock as unknown as ReturnType<typeof vi.fn>;
    }

    it("offers a remove control on each listed item", () => {
      render(<StandForm token="private-token" currentEntries={CURRENT} />);

      expect(screen.getByRole("button", { name: /remove eggs/i })).toBeVisible();
      expect(screen.getByRole("button", { name: /remove kale/i })).toBeVisible();
    });

    it("posts a structured removal rather than a sentence for the model to re-parse", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({
        outcome: "proposed",
        proposalId: "p1",
        confirmationText: "Your stand will show:\n- Eggs (12 dozen)\nTaking off: Kale.",
      });
      render(<StandForm token="private-token" currentEntries={CURRENT} />);

      await user.click(screen.getByRole("button", { name: /remove kale/i }));
      await user.click(screen.getByRole("button", { name: "Preview update" }));

      const body = JSON.parse(
        (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      // The three arrays only. `kind` is supplied by the server's parser, which is what
      // decides the shape is an edit — a client-declared kind would be a client deciding it.
      expect(body.edit).toEqual({
        additions: [],
        changes: [],
        removals: [{ entryId: "e2" }],
      });
      // The free-text field is not also sent: two descriptions of one change is refused.
      expect(body.text).toBeUndefined();
    });

    it("marks a removed item without publishing anything yet", async () => {
      const user = userEvent.setup();
      stubFetch({});
      render(<StandForm token="private-token" currentEntries={CURRENT} />);

      await user.click(screen.getByRole("button", { name: /remove kale/i }));

      // Struck through and undoable — the tap is an edit in progress, not a publication.
      expect(screen.getByRole("button", { name: /undo|keep kale/i })).toBeVisible();
    });

    it("lets a farmer undo a removal before previewing", async () => {
      const user = userEvent.setup();
      stubFetch({});
      render(<StandForm token="private-token" currentEntries={CURRENT} />);

      await user.click(screen.getByRole("button", { name: /remove kale/i }));
      await user.click(screen.getByRole("button", { name: /undo|keep kale/i }));

      expect(screen.getByRole("button", { name: /remove kale/i })).toBeVisible();
    });

    it("adds a new item as a structured addition", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({
        outcome: "proposed",
        proposalId: "p1",
        confirmationText: "Your stand will show:\n- Eggs\n- Kale\n- Plum jam",
      });
      render(<StandForm token="private-token" currentEntries={CURRENT} />);

      await user.type(screen.getByLabelText(/add something/i), "Plum jam");
      await user.click(screen.getByRole("button", { name: /^add$/i }));
      await user.click(screen.getByRole("button", { name: "Preview update" }));

      const body = JSON.parse(
        (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.edit).toMatchObject({
        additions: [{ itemName: "Plum jam" }],
        removals: [],
      });
    });

    it("marks the committing control explicitly, not by document position", async () => {
      // The stylesheet filled `button:first-of-type` green, written when this screen had one
      // button. Once the listing became editable the first button on the page was a chip's
      // ×, so the control that TAKES AN ITEM OFF rendered as the one that publishes. Class
      // names are asserted because that is what the CSS selects on; position is not intent.
      const user = userEvent.setup();
      stubFetch({
        outcome: "proposed",
        proposalId: "p1",
        confirmationText: "Your stand will show:\n- Eggs (12 dozen)",
      });
      render(<StandForm token="private-token" currentEntries={CURRENT} />);

      expect(screen.getByRole("button", { name: /remove kale/i })).toHaveClass(
        "farmer-chip-action",
      );

      await user.click(screen.getByRole("button", { name: /remove kale/i }));
      await user.click(screen.getByRole("button", { name: "Preview update" }));

      expect(
        await screen.findByRole("button", { name: /confirm and publish/i }),
      ).toHaveClass("farmer-form-affirmative");
    });

    it("cannot preview when nothing has been changed", () => {
      render(<StandForm token="private-token" currentEntries={CURRENT} />);

      // An edit that changes nothing would open a proposal whose only effect is to restate
      // the current listing as freshly confirmed.
      expect(screen.getByRole("button", { name: "Preview update" })).toBeDisabled();
    });
  });
});
