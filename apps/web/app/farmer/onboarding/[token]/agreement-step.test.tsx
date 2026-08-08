// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgreementStep } from "./agreement-step";

// The consent step on the onboarding page.
//
// This is the launch blocker's user-facing half. The property that matters is an ORDER: the
// farmer cannot reach the prepared JOIN text until they have ticked the agreement AND the
// server has recorded it. If the text were reachable first, a farmer could send the JOIN
// with `agreed_to_sms_at` still null, establish no consent, and land back in the silent dead
// end — with the invitation now spent and no way to try again.
//
// The disclosures are asserted here rather than trusted to review because they are what the
// carrier-registered opt-in receipt claims was shown. If the page does not say message
// frequency, that rates apply, and how to stop, the receipt the farmer then receives is
// describing an agreement they were never shown.

const TOKEN = "a".repeat(64);
const JOIN_URL = `sms:+12065551234?body=JOIN%20${TOKEN}`;

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function stubFetch(response: { ok: boolean; status: number }) {
  const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(
    async () => response as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("onboarding agreement step", () => {
  it("states message frequency, that rates apply, and how to stop", () => {
    render(<AgreementStep token={TOKEN} joinUrl={JOIN_URL} />);

    const agreement = screen.getByTestId("sms-agreement");
    expect(agreement).toHaveTextContent(/frequency|freq/i);
    expect(agreement).toHaveTextContent(/rates/i);
    expect(agreement).toHaveTextContent(/STOP/);
    expect(agreement).toHaveTextContent(/HELP/);
  });

  it("does not offer the prepared text until the farmer agrees", () => {
    render(<AgreementStep token={TOKEN} joinUrl={JOIN_URL} />);

    expect(screen.queryByRole("link", { name: /text start/i })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("records the agreement and only THEN reveals the prepared text", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });
    render(<AgreementStep token={TOKEN} joinUrl={JOIN_URL} />);

    await userEvent.click(screen.getByRole("checkbox"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/farmer/onboarding",
      expect.objectContaining({ method: "POST" }),
    );
    // The token travels in the JSON BODY, never a query string — a credential in a URL is
    // written to server logs and browser history by default.
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ token: TOKEN });

    const link = await screen.findByRole("link", { name: /text start/i });
    expect(link).toHaveAttribute("href", JOIN_URL);
  });

  it("keeps the prepared text hidden when the server refuses", async () => {
    // A dead invitation. Revealing the text anyway would send the farmer to a redemption that
    // cannot be redeemed, and they would have no idea why nothing happened.
    stubFetch({ ok: false, status: 410 });
    render(<AgreementStep token={TOKEN} joinUrl={JOIN_URL} />);

    await userEvent.click(screen.getByRole("checkbox"));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByRole("link", { name: /text start/i })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("keeps the prepared text hidden when the request fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    render(<AgreementStep token={TOKEN} joinUrl={JOIN_URL} />);

    await userEvent.click(screen.getByRole("checkbox"));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByRole("link", { name: /text start/i })).not.toBeInTheDocument();
  });

  it("un-ticking hides the prepared text again", async () => {
    // The tick is the farmer's statement of agreement, so the page must not keep acting on
    // it after they withdraw it. The stamp already recorded is provenance of what was shown
    // and accepted; nothing has been sent, and no consent exists until they text.
    stubFetch({ ok: true, status: 200 });
    render(<AgreementStep token={TOKEN} joinUrl={JOIN_URL} />);

    await userEvent.click(screen.getByRole("checkbox"));
    expect(await screen.findByRole("link", { name: /text start/i })).toBeVisible();

    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByRole("link", { name: /text start/i })).not.toBeInTheDocument();
  });

  it("does not fire a second request while the first is in flight", async () => {
    // Double-submit guard. Two rapid ticks must not become two writes.
    let release: (() => void) | undefined;
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          release = () => resolve({ ok: true, status: 200 } as Response);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AgreementStep token={TOKEN} joinUrl={JOIN_URL} />);

    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("checkbox"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    release?.();
  });

  it("shows the typed-out instruction when no prepared link can be built", async () => {
    // `TELNYX_FROM_NUMBER` unset. The farmer still needs a way through, so the page tells
    // them what to type rather than rendering a dead affordance.
    stubFetch({ ok: true, status: 200 });
    render(<AgreementStep token={TOKEN} joinUrl={null} />);

    await userEvent.click(screen.getByRole("checkbox"));

    // The word alone, with NO token: that grammar is gone (max 2026-08-07), and printing it
    // would tell the farmer to send a message the parser now treats as free text.
    const instruction = await screen.findByText(/text/i, {
      selector: ".farmer-onboarding-instruction",
    });
    expect(instruction).toHaveTextContent(/START/);
    expect(instruction.textContent ?? "").not.toMatch(/[0-9a-f]{64}/i);
    expect(screen.queryByRole("link", { name: /text start/i })).not.toBeInTheDocument();
  });
});
