// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListingStep } from "./listing-step";

// F-067 — the listing form on the onboarding page.
//
// The property that matters is THE BRANCH. The database refuses a `visitable` stand without an
// address and a complete coordinate pair, and refuses a `contact_only` one that carries any of
// them (`sales_locations_coherent_visitability`, F-038 / B-024). Inventing an address for a
// farm with no stand to visit puts a pin on the map that sends a customer driving to a place
// with nothing to buy.
//
// So this form must ASK before it can know what to require, and it must never send an address
// or a pin for a farmer who said there is nowhere to visit. Both directions are asserted here,
// because the form is where a farmer would otherwise be stopped by a constraint violation they
// cannot act on.

const TOKEN = "a".repeat(64);

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.body ?? {},
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

/** The body the form posted, parsed. */
function posted(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(call[1].body) as Record<string, unknown>;
}

describe("onboarding listing step", () => {
  it("asks whether there is a stand to visit BEFORE asking where it is", () => {
    // The address field does not exist until the farmer says there is somewhere to go. This
    // is the form's structure rather than a nicety: a farmer who has not answered cannot be
    // asked for an address, because whether one exists is exactly what is unknown.
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    expect(screen.getByText(/can people come to your stand/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/where is it/i)).not.toBeInTheDocument();
  });

  it("asks for an address and a pin once the farmer says people can visit", async () => {
    const user = userEvent.setup();
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/there is a stand to visit/i));

    expect(screen.getByLabelText(/where is it/i)).toBeInTheDocument();
    expect(screen.getByText(/tap the map/i)).toBeInTheDocument();
  });

  it("asks for NEITHER when the farmer says there is nowhere to visit", async () => {
    // The direction that protects customers. A farm with no stand has no address, and the
    // form must not offer to record one — B-024 is a real farmer whose written refusal was
    // overridden by a seeded address.
    const user = userEvent.setup();
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));

    expect(screen.queryByLabelText(/where is it/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/tap the map/i)).not.toBeInTheDocument();
  });

  it("cannot be submitted until the visit question is answered", async () => {
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    expect(screen.getByRole("button", { name: /put my stand on the map/i })).toBeDisabled();
  });

  it("cannot publish a visitable stand with no pin dropped", async () => {
    // The pin is the half a farmer is most likely to skip, because the address feels like
    // enough. Without it the stand cannot be placed on the map, so "visitable" would be a
    // promise the system cannot keep — and the write would be refused by the database.
    const user = userEvent.setup();
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/there is a stand to visit/i));
    await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");

    expect(screen.getByRole("button", { name: /put my stand on the map/i })).toBeDisabled();
  });

  it("sends NO address or pin for a farmer with nowhere to visit", async () => {
    // Even if an address were somehow present in state, a contact-only listing must carry
    // none — the constraint refuses it in that direction too.
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

    const body = posted(fetchMock);
    expect(body.visitability).toBe("contact_only");
    expect(body.publicAddress).toBeUndefined();
    expect(body.latitude).toBeUndefined();
    expect(body.longitude).toBeUndefined();
  });

  it("sends the token in the BODY, never in the URL", async () => {
    // A credential in a query string lands in server logs and browser history by default.
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

    const call = fetchMock.mock.calls[0] as [string, unknown];
    expect(call[0]).toBe("/api/farmer/listing");
    expect(call[0]).not.toContain(TOKEN);
    expect(posted(fetchMock).token).toBe(TOKEN);
  });

  it("keeps the farmer's own words for what they sell", async () => {
    // "tomato", "tomatoes" and "love apple" are three items. Folding them is a produce
    // taxonomy, which no business code may hard-code — the form splits on commas and trims,
    // and does nothing else to the words.
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.type(
      screen.getByLabelText(/what do you usually sell/i),
      "tomato, tomatoes , love apple",
    );
    await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

    expect(posted(fetchMock).items).toEqual(["tomato", "tomatoes", "love apple"]);
  });

  it("drops empty entries from a list rather than sending blanks", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.type(screen.getByLabelText(/how can people pay/i), "cash, , Venmo,");
    await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

    expect(posted(fetchMock).paymentMethods).toEqual(["cash", "Venmo"]);
  });

  it("defaults the stand's name to the farm the invitation named", () => {
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    expect(screen.getByLabelText(/what is your stand called/i)).toHaveValue("Test Farm");
  });

  it("tells the farmer their stand is live, and how to change it", async () => {
    // Publish-on-submit (max, 2026-08-05). The farmer must know the listing is public now
    // rather than pending, or they will wait for a review that never comes.
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/on the map/i);
    expect(screen.getByRole("status")).toHaveTextContent(/SETTINGS/);
  });

  it("explains an off-island pin in words the farmer can act on", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: false, status: 400, body: { error: "off_island" } });
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/off the island/i);
  });

  it("explains a spent invitation rather than reporting a generic failure", async () => {
    const user = userEvent.setup();
    stubFetch({
      ok: false,
      status: 410,
      body: { error: "invitation_unavailable" },
    });
    render(<ListingStep token={TOKEN} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer available/i);
  });
});
