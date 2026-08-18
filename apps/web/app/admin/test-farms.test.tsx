// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestFarms } from "./test-farms";

/*
  F-100's finding, fixed in F-101 — THE ROW THAT SHOWED THE TYPO.

  A newly added phone rendered from what the OPERATOR TYPED, keyed `pending-<phone>`. Any number
  that normalizes differently from how it was typed therefore showed the wrong last four until
  the page was reloaded: "(206) 555-0139 x4" listed `139x4`'s tail rather than the canonical
  number's, and an operator checking their work against the list was checking it against their
  own typing.

  The route already computed the canonical last four — it normalizes before hashing, precisely so
  the suffix comes from the canonical form — and already had the real row id from the writer. It
  simply did not send either back. So this is a display defect with the correct values one layer
  away, not a missing capability.

  **The hash stays out of the response.** It is the lookup key (Golden Rule #5), and echoing it
  to a browser is how a key reaches a log or a screenshot. The id and the masked last four are
  not the key and are what the list actually renders.
*/

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("F-101 the test-phone list renders the SERVER's row", () => {
  it("shows the canonical last four, not the operator's typing", async () => {
    const fetchMock = vi.fn(async () =>
      // What the route sends now: the writer's real id and the last four taken from the
      // NORMALIZED number.
      Response.json({ status: "added", id: "row-real", lastFour: "0139" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<TestFarms sellers={[]} phones={[]} />);

    // Typed with punctuation and an extension, so the typed tail and the canonical tail differ.
    await userEvent.type(screen.getByLabelText(/phone number/i), "(206) 555-0139 x4");
    await userEvent.click(screen.getByRole("button", { name: /add/i }));

    // The canonical suffix, and NOT the typed one — asserted as both a presence and an absence,
    // because a row rendered from the typing would satisfy neither on its own.
    expect(await screen.findByText(/0139/)).toBeVisible();
    expect(screen.queryByText(/139x4|39x4/)).toBeNull();
  });

  it("keys the new row by the real id, so removing it names a row the server knows", async () => {
    /*
      The second half of the same defect. A `pending-<phone>` key is not an id: the remove
      control sends it, and the server has no such row — so the operator's next act on a number
      they just added quietly did nothing until a reload.
    */
    const fetchMock = vi.fn(async () =>
      Response.json({ status: "added", id: "row-real", lastFour: "0139" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<TestFarms sellers={[]} phones={[]} />);

    await userEvent.type(screen.getByLabelText(/phone number/i), "2065550139");
    await userEvent.click(screen.getByRole("button", { name: /add/i }));
    await screen.findByText(/0139/);

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => Response.json({ status: "removed" }));
    await userEvent.click(screen.getByRole("button", { name: /remove/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/test-farm-phones",
      expect.objectContaining({
        body: JSON.stringify({ action: "remove", id: "row-real" }),
      }),
    );
  });
});
