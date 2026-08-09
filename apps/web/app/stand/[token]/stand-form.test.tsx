// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StandForm } from "./stand-form";

const CURRENT = [
  { entryId: "e1", itemName: "Eggs", quantity: 12, unit: "dozen", priceText: "$6" },
  { entryId: "e2", itemName: "Kale" },
];

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe("StandForm", () => {
  it("presents one direct dated-stock editor with no prose or SMS proxy", () => {
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    expect(screen.getByRole("group", { name: /what is in stock today/i })).toBeVisible();
    expect(screen.queryByLabelText(/in your own words/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/text|sms/i)).not.toBeInTheDocument();
    expect(screen.getByText(/does not change what your stand usually sells/i)).toBeVisible();
  });

  it("shows the exact pending-or-published base the next edit targets", () => {
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    expect(screen.getByText("Eggs")).toBeVisible();
    expect(screen.getByText("Kale")).toBeVisible();
  });

  it("gives existing and newly added items the same stock, quantity, unit, and price controls", async () => {
    const user = userEvent.setup();
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    expect(screen.getByRole("switch", { name: "Eggs in stock" })).toBeChecked();
    expect(screen.getByLabelText("Quantity for Eggs")).toHaveValue("12");
    expect(screen.getByLabelText("Unit for Eggs")).toHaveValue("dozen");
    expect(screen.getByLabelText("Price for Eggs")).toHaveValue("$6");

    await user.type(screen.getByLabelText(/add an in-stock item/i), "Plum jam");
    await user.click(screen.getByRole("button", { name: "Add item" }));

    expect(screen.getByRole("switch", { name: "Plum jam in stock" })).toBeChecked();
    expect(screen.getByLabelText("Quantity for Plum jam")).toHaveValue("");
    expect(screen.getByLabelText("Unit for Plum jam")).toHaveValue("");
    expect(screen.getByLabelText("Price for Plum jam")).toHaveValue("");
  });

  it("emits additions, removals, and field changes as one structured edit", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      outcome: "proposed",
      proposalId: "p1",
      confirmationText:
        "Your stand will show:\n- Eggs (6 dozen, $5)\n- Plum jam (3 jars, $8)\nTaking off: Kale.",
    });
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    await user.clear(screen.getByLabelText("Quantity for Eggs"));
    await user.type(screen.getByLabelText("Quantity for Eggs"), "6");
    await user.clear(screen.getByLabelText("Price for Eggs"));
    await user.type(screen.getByLabelText("Price for Eggs"), "$5");
    await user.click(screen.getByRole("switch", { name: "Kale in stock" }));
    await user.type(screen.getByLabelText(/add an in-stock item/i), "Plum jam");
    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.type(screen.getByLabelText("Quantity for Plum jam"), "3");
    await user.type(screen.getByLabelText("Unit for Plum jam"), "jars");
    await user.type(screen.getByLabelText("Price for Plum jam"), "$8");
    await user.click(screen.getByRole("button", { name: "Preview update" }));

    const body = JSON.parse(
      (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({
      token: "private-token",
      action: "propose",
      edit: {
        additions: [{ itemName: "Plum jam", quantity: 3, unit: "jars", priceText: "$8" }],
        changes: [{ entryId: "e1", quantity: 6, priceText: "$5" }],
        removals: [{ entryId: "e2" }],
      },
    });
    expect(body.text).toBeUndefined();
  });

  it("does not open a proposal for an unchanged or fully reverted editor", async () => {
    const user = userEvent.setup();
    render(<StandForm token="private-token" currentEntries={CURRENT} />);
    const preview = screen.getByRole("button", { name: "Preview update" });

    expect(preview).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Kale in stock" }));
    expect(preview).toBeEnabled();
    await user.click(screen.getByRole("switch", { name: "Kale in stock" }));
    expect(preview).toBeDisabled();
  });

  it("keeps exact preview and explicit confirmation as the only publish boundary", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      outcome: "proposed",
      proposalId: "p1",
      confirmationText: "Your stand will show:\n- Eggs (6 dozen, $6)\n- Kale",
    });
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    await user.clear(screen.getByLabelText("Quantity for Eggs"));
    await user.type(screen.getByLabelText("Quantity for Eggs"), "6");
    await user.click(screen.getByRole("button", { name: "Preview update" }));

    expect(await screen.findByRole("region", { name: "Exact publication preview" })).toHaveTextContent(
      "Eggs (6 dozen, $6)",
    );
    expect(screen.getByText("Nothing has changed yet.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Confirm and publish" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
