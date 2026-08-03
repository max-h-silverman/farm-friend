// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import MapLoading from "../app/loading";

afterEach(cleanup);

describe("public map loading state", () => {
  it("fills the embed with a visible, accessible loading indicator", () => {
    const { container } = render(<MapLoading />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading farm map");
    expect(container.querySelector(".map-loading-spinner")).toBeTruthy();
    expect(container.querySelector(".map-loading")).toHaveClass("map-loading");
  });
});
