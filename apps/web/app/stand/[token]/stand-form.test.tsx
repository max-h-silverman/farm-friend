// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StandForm } from "./stand-form";

describe("StandForm", () => {
  it("keeps a daily availability update focused on one primary task", () => {
    render(<StandForm token="private-token" />);

    expect(screen.getByLabelText("What changed at your stand today?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview update" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Also selling here" })).not.toBeInTheDocument();
  });
});
