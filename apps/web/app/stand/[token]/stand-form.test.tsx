// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StandForm } from "./stand-form";

const CURRENT = [
  { entryId: "e1", itemName: "Eggs", quantity: 12, unit: "dozen", priceText: "$6 / dozen" },
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

    expect(screen.getByRole("group", { name: /stock today/i })).toBeVisible();
    expect(screen.queryByLabelText(/in your own words/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/text|sms/i)).not.toBeInTheDocument();
    expect(screen.getByText(/doesn.t change what your stand usually sells/i)).toBeVisible();
    expect(screen.queryByText(/this is a dated stock update/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Item name")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add" })).toBeVisible();
  });

  it("uses onboarding's one price switch and removes visible prices when it is off", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      outcome: "proposed",
      proposalId: "p1",
      confirmationText: "Your stand will show:\n- Eggs (12 dozen)\n- Kale",
    });
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    const prices = screen.getByRole("switch", { name: "Add prices" });
    expect(prices).toBeChecked();
    expect(screen.getByLabelText("Price for Eggs")).toHaveValue("6");
    await user.selectOptions(screen.getByLabelText("Price basis for Eggs"), "for");
    expect(screen.getByLabelText("How many Eggs")).toBeVisible();

    await user.click(prices);

    expect(prices).not.toBeChecked();
    expect(screen.queryByLabelText("Price for Eggs")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Price basis for Eggs")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("How many Eggs")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Unit for Eggs")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Update" }));
    const body = JSON.parse(
      (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({
      token: "private-token",
      action: "propose",
      edit: {
        additions: [],
        changes: [{ entryId: "e1", priceText: null }],
        removals: [],
      },
    });
  });

  it("keeps price controls hidden by default when today's stock has no prices", async () => {
    const user = userEvent.setup();
    render(<StandForm token="private-token" currentEntries={[{ entryId: "e2", itemName: "Kale" }]} />);

    const prices = screen.getByRole("switch", { name: "Add prices" });
    expect(prices).not.toBeChecked();
    expect(screen.queryByLabelText("Price for Kale")).not.toBeInTheDocument();

    await user.click(prices);
    expect(screen.getByLabelText("Price for Kale")).toBeVisible();
  });

  it("shows the exact pending-or-published base the next edit targets", () => {
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    expect(screen.getByText("Eggs")).toBeVisible();
    expect(screen.getByText("Kale")).toBeVisible();
  });

  it("uses onboarding's literal price amount, per-or-for, quantity, and unit controls", async () => {
    const user = userEvent.setup();
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    expect(screen.getByRole("switch", { name: "Eggs in stock" })).toBeChecked();
    expect(screen.getByLabelText("Price for Eggs")).toHaveValue("6");
    expect(screen.getByLabelText("Price basis for Eggs")).toHaveValue("per");
    expect(screen.queryByLabelText("How many Eggs")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Unit for Eggs")).toHaveValue("dozen");
    expect(screen.getByLabelText("Unit for Eggs")).toHaveRole("combobox");
    expect(screen.getByText("Eggs").closest(".farmer-listing-item")).toContainElement(
      screen.getByLabelText("Price basis for Eggs").closest(".farmer-listing-item-pricing"),
    );

    await user.selectOptions(screen.getByLabelText("Price basis for Eggs"), "for");
    expect(screen.getByLabelText("How many Eggs")).toHaveValue("1");

    await user.type(screen.getByLabelText("Item name"), "Plum jam");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByRole("switch", { name: "Plum jam in stock" })).toBeChecked();
    expect(screen.getByLabelText("Price basis for Plum jam")).toHaveValue("per");
    expect(screen.queryByLabelText("How many Plum jam")).not.toBeInTheDocument();
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

    await user.clear(screen.getByLabelText("Price for Eggs"));
    await user.type(screen.getByLabelText("Price for Eggs"), "5");
    await user.click(screen.getByRole("switch", { name: "Kale in stock" }));
    await user.type(screen.getByLabelText("Item name"), "Plum jam");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.selectOptions(screen.getByLabelText("Price basis for Plum jam"), "for");
    await user.clear(screen.getByLabelText("How many Plum jam"));
    await user.type(screen.getByLabelText("How many Plum jam"), "3");
    await user.selectOptions(screen.getByLabelText("Unit for Plum jam"), "jar");
    await user.type(screen.getByLabelText("Price for Plum jam"), "8");
    await user.click(screen.getByRole("button", { name: "Update" }));

    const body = JSON.parse(
      (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({
      token: "private-token",
      action: "propose",
      edit: {
        additions: [{ itemName: "Plum jam", priceText: "3 jar for $8" }],
        changes: [{ entryId: "e1", priceText: "$5 / dozen" }],
        removals: [{ entryId: "e2" }],
      },
    });
    expect(body.text).toBeUndefined();
  });

  it("does not open a proposal for an unchanged or fully reverted editor", async () => {
    const user = userEvent.setup();
    render(<StandForm token="private-token" currentEntries={CURRENT} />);
    const preview = screen.getByRole("button", { name: "Update" });

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
      confirmationText: "Your stand will show:\n- Eggs (12 dozen, $7 / dozen)\n- Kale",
    });
    render(<StandForm token="private-token" currentEntries={CURRENT} />);

    await user.clear(screen.getByLabelText("Price for Eggs"));
    await user.type(screen.getByLabelText("Price for Eggs"), "7");
    await user.click(screen.getByRole("button", { name: "Update" }));

    expect(await screen.findByRole("region", { name: "Exact publication preview" })).toHaveTextContent(
      "Eggs (12 dozen, $7 / dozen)",
    );
    expect(screen.getByText("Exact preview — nothing has changed yet.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Confirm and publish" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
