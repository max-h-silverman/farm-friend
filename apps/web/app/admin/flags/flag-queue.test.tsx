// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FlagQueue, type FlagRow } from "./flag-queue";

afterEach(cleanup);

/*
  B-091 — a reporter who asked to hear back, and the console's obligation to them.

  Two things have to be true at once, and they pull against each other: a coordinator must be
  able to WRITE to the address, and the console must not PRINT it (Golden Rule #5 — raw
  personal data is masked in admin). The resolution is a masked label inside a mail link: the
  operator clicks and their mail client holds the address, while the page itself shows only
  the mask. These tests pin both halves, because either alone is the wrong product.
*/

const baseRow: FlagRow = {
  flagId: "flag-1",
  senderMask: "•••• 0142",
  reasonCode: "issue_reported",
  status: "open",
  dispositionCode: null,
  disposedByEmail: null,
  disposedAt: null,
  createdAt: new Date("2026-08-19T12:00:00Z").toISOString(),
  reporterEmail: null,
  reporterEmailMask: "(no email on file)",
  hasReadableThread: true,
};

describe("a reporter's reply address in the flag queue", () => {
  it("offers a way to write to a reporter who left an address", () => {
    render(
      <FlagQueue
        flags={[
          {
            ...baseRow,
            reporterEmail: "cathy@example.com",
            reporterEmailMask: "c•••@example.com",
          },
        ]}
      />,
    );

    const link = screen.getByRole("link", { name: "c•••@example.com" });
    // The address reaches the mail client, which is the only reason it was collected.
    expect(link).toHaveAttribute("href", "mailto:cathy@example.com");
  });

  it("never prints the raw address as page text", () => {
    const { container } = render(
      <FlagQueue
        flags={[
          {
            ...baseRow,
            reporterEmail: "cathy@example.com",
            reporterEmailMask: "c•••@example.com",
          },
        ]}
      />,
    );

    /*
      Asserted against `textContent`, not against the markup: the address is REQUIRED to appear
      in the href, so a source-wide search would fail for the wrong reason. What must not
      happen is a coordinator's screenshot carrying a customer's address, and text is what a
      screenshot captures.
    */
    expect(container.textContent).not.toContain("cathy@example.com");
    expect(container.textContent).toContain("c•••@example.com");
  });

  it("says nothing at all when no address was left", () => {
    // Most reporters will not leave one, and a permanent "(no email on file)" on every flag is
    // noise on a screen whose whole job is to be scanned.
    render(<FlagQueue flags={[baseRow]} />);

    expect(screen.queryByText(/asked for a reply/i)).toBeNull();
    expect(screen.queryByText("(no email on file)")).toBeNull();
  });
});
