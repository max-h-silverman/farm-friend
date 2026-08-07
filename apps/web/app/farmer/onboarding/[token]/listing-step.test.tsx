// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
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
const FARM_ID = "11111111-1111-4111-8111-111111111111";

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

/** A saved listing, as an already-onboarded farmer's editor is prefilled from. */
const EDIT_DEFAULTS = {
  standName: "Existing Stand",
  visitability: "contact_only" as const,
  publicAddress: null,
  latitude: null,
  longitude: null,
  hoursText: null,
  // A farmer who stated nothing about their season, hours or restocking. Every column is
  // nullable because "not stated" is a real and common answer, distinct from any value.
  availability: {
    seasonKind: null,
    seasonStartMonth: null,
    seasonStartDay: null,
    seasonEndMonth: null,
    seasonEndDay: null,
    seasonNames: null,
    openHoursKind: null,
    openFromMinutes: null,
    openUntilMinutes: null,
    openDays: null,
    stockingCadence: null,
    stockingDays: null,
  },
  paymentMethods: [],
  items: [],
  description: null,
};

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
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    expect(screen.getByText(/can people come to your stand/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/where is it/i)).not.toBeInTheDocument();
  });

  it("asks for an address and offers to look it up once the farmer says people can visit", async () => {
    const user = userEvent.setup();
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/there is a stand to visit/i));

    expect(screen.getByLabelText(/where is it/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /find this address/i })).toBeInTheDocument();
  });

  it("asks for NEITHER when the farmer says there is nowhere to visit", async () => {
    // The direction that protects customers. A farm with no stand has no address, and the
    // form must not offer to record one — B-024 is a real farmer whose written refusal was
    // overridden by a seeded address.
    const user = userEvent.setup();
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));

    expect(screen.queryByLabelText(/where is it/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /find this address/i }),
    ).not.toBeInTheDocument();
  });

  it("cannot be submitted until the visit question is answered", async () => {
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
  });

  it("cannot publish a visitable stand whose address was never looked up", async () => {
    // A typed address alone is not a location. Without a coordinate the stand cannot be
    // placed on the map, so "visitable" would be a promise the system cannot keep — and the
    // write would be refused by the database.
    const user = userEvent.setup();
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/there is a stand to visit/i));
    await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");

    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
  });

  it("sends NO address or pin for a farmer with nowhere to visit", async () => {
    // Even if an address were somehow present in state, a contact-only listing must carry
    // none — the constraint refuses it in that direction too.
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /submit/i }));

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
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /submit/i }));

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
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.type(
      screen.getByLabelText(/what do you usually sell/i),
      "tomato, tomatoes , love apple",
    );
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(posted(fetchMock).items).toEqual(["tomato", "tomatoes", "love apple"]);
  });

  it("drops empty entries from a list rather than sending blanks", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs, , rhubarb,");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(posted(fetchMock).items).toEqual(["eggs", "rhubarb"]);
  });

  describe("the farm's own paragraph", () => {
    // `farms.description` renders on the public card under "Additional information" and had NO
    // farmer-facing writer at all, so VIGA's seeded prose stayed welded under every listing a
    // farmer published — contradicting the fields above it and editable by nobody.

    it("offers the stored paragraph for editing rather than a blank box", async () => {
      // THE MIGRATION CASE. A farm arriving through F-079's door already has prose on its card.
      // A blank box here publishes a listing that silently drops the farm's own words.
      render(
        <ListingStep
          credential={{ kind: "grandfathered", farmId: FARM_ID }}
          farmName="Test Farm"
          description={"We put a sign at the bottom of the driveway."}
        />,
      );

      expect(screen.getByLabelText(/anything else people should know/i)).toHaveValue(
        "We put a sign at the bottom of the driveway.",
      );
    });

    it("posts the paragraph the farmer typed", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.type(
        screen.getByLabelText(/anything else people should know/i),
        "Certified organic. Goats on site.",
      );
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(posted(fetchMock).description).toBe("Certified organic. Goats on site.");
    });

    it("posts an EMPTY paragraph when the farmer clears the box", async () => {
      // The farmer owns published state. Someone who deletes VIGA's stale paragraph must end up
      // with no paragraph — a form that omitted the field when blank would leave the old text
      // in place and lie about what it published.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(
        <ListingStep
          credential={{ kind: "grandfathered", farmId: FARM_ID }}
          farmName="Test Farm"
          description={"Stale VIGA prose."}
        />,
      );

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.clear(screen.getByLabelText(/anything else people should know/i));
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body).toHaveProperty("description");
      expect(body.description).toBe("");
    });
  });

  it("defaults the stand's name to the farm the invitation named", () => {
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    expect(screen.getByLabelText(/what is your stand called/i)).toHaveValue("Test Farm");
  });

  it("tells the farmer their stand is live, and how to change it", async () => {
    // Publish-on-submit (max, 2026-08-05). The farmer must know the listing is public now
    // rather than pending, or they will wait for a review that never comes.
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/on the map/i);
    // "How do I change this later?" is answered by SETTINGS — but during ONBOARDING the
    // farmer still has one action left, and a later-editing instruction competes with it.
    // The page states SETTINGS under "What happens next"; the confirmation points at the
    // text message instead. An already-onboarded farmer editing their listing, who has no
    // next step, does get SETTINGS here — asserted below.
    expect(screen.getByRole("status")).toHaveTextContent(/last step/i);
  });

  it("tells an already-onboarded farmer how to change things later, with no text to send", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(
      <ListingStep credential={{ kind: "stand_link", token: TOKEN }} farmName="Test Farm" />,
    );

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /submit/i }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/SETTINGS/);
    // No SIGNUP hand-off exists on this path; promising a "last step" would be a lie.
    expect(status).not.toHaveTextContent(/last step/i);
  });

  // The save used to REPLACE the whole form with a single sentence. Everything the farmer
  // had typed vanished, the page reflowed, and the phone-verification card below jumped up
  // into view — which reads as being thrown onto a different screen. It is not a navigation
  // and must not feel like one: what was saved stays readable, and the farmer keeps a way
  // back into it.
  it("keeps what was saved visible and correctable instead of collapsing the form", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/on the map/i);
    // The farmer's own answer is still on screen, not swapped for a receipt.
    expect(screen.getByText("Test Farm")).toBeInTheDocument();
    // And there is a way back in — a saved listing is not a locked one.
    expect(screen.getByRole("button", { name: /change/i })).toBeInTheDocument();
  });

  it("names the next step rather than leaving the farmer to find it", async () => {
    // The SIGNUP card was always below the fold; the collapse merely scrolled it into view
    // unannounced. Saving must SAY that a text is next, so the hand-off is expected.
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /submit/i }));

    // Anchored to the hand-off sentence itself, not the word "text" — "texting SETTINGS"
    // appears in the non-onboarding copy and would satisfy a looser match forever.
    expect(await screen.findByRole("status")).toHaveTextContent(/last step/i);
  });

  it("reopens the form with the farmer's answers intact", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /submit/i }));
    await user.click(await screen.findByRole("button", { name: /change/i }));

    // Reopening is not a fresh form: a farmer correcting one field must not retype the rest.
    expect(screen.getByLabelText(/what is your stand called/i)).toHaveValue("Test Farm");
  });

  // The farm name is public on the map beside the stand and was previously unchangeable by
  // anyone. An editing farmer gets a field for it; an onboarding farmer does not, because
  // the invitation just named their farm and a second name box beside the stand-name box is
  // the confusion, not the fix.
  describe("the farm's name", () => {
    it("offers an editing farmer a field for their farm's name", () => {
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Two Sisters Farm"
          defaults={{ ...EDIT_DEFAULTS, standName: "The Red Shed" }}
        />,
      );

      // Prefilled from the FARM, not from the stand — they are different records.
      expect(screen.getByLabelText(/farm.*called|name of your farm/i)).toHaveValue(
        "Two Sisters Farm",
      );
      expect(screen.getByLabelText(/what is your stand called/i)).toHaveValue("The Red Shed");
    });

    it("does not ask an onboarding farmer to name their farm twice", () => {
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      expect(screen.queryByLabelText(/farm.*called|name of your farm/i)).not.toBeInTheDocument();
    });

    it("sends the farm name with the listing when it is edited", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Two Sisters Farm"
          defaults={{ ...EDIT_DEFAULTS, standName: "The Red Shed" }}
        />,
      );

      const farmField = screen.getByLabelText(/farm.*called|name of your farm/i);
      await user.clear(farmField);
      await user.type(farmField, "Misty Hollow Farm");
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body.farmName).toBe("Misty Hollow Farm");
      expect(body.standName).toBe("The Red Shed");
    });
  });

  it("explains an off-island pin in words the farmer can act on", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: false, status: 400, body: { error: "off_island" } });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/off the island/i);
  });

  it("explains a spent invitation rather than reporting a generic failure", async () => {
    const user = userEvent.setup();
    stubFetch({
      ok: false,
      status: 410,
      body: { error: "invitation_unavailable" },
    });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer available/i);
  });

  // ── F-069: payments as a closed set ───────────────────────────────────────────────────
  describe("F-069 payment methods", () => {
    it("offers the closed set as CHECKBOXES rather than a text box", async () => {
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      for (const method of ["Cash", "Check", "Venmo", "PayPal", "Zelle"]) {
        expect(screen.getByRole("checkbox", { name: method })).toBeInTheDocument();
      }
    });

    it("does NOT offer VIGA Farm Bucks, which only VIGA can grant", async () => {
      // Acceptance is gated on an eligibility with its own admin workflow and an
      // `acceptanceRequiresEligibility` constraint. A farmer ticking a box would be asserting
      // a VIGA decision about themselves.
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      expect(screen.queryByText(/farm bucks/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/VIGA bucks/i)).not.toBeInTheDocument();
    });

    it("sends the checked methods, canonically spelled", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.click(screen.getByRole("checkbox", { name: "Venmo" }));
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(posted(fetchMock).paymentMethods).toEqual(["Cash", "Venmo"]);
    });

    it("unchecking a method removes it", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.click(screen.getByRole("checkbox", { name: "Venmo" }));
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(posted(fetchMock).paymentMethods).toEqual(["Venmo"]);
    });

    it("keeps a free-text method alongside the checked ones", async () => {
      // The closed set must not lose a real fact a farmer states.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.type(screen.getByLabelText(/anything else you take/i), "trade for eggs");
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(posted(fetchMock).paymentMethods).toEqual(["Cash", "trade for eggs"]);
    });
  });

  // ── F-069: structured season / hours / stocking ───────────────────────────────────────
  describe("F-069 structured availability", () => {
    it("sends NOTHING stated when the farmer answers none of it", async () => {
      // "Rather not say" must stay a real answer: NULL and "open all year" are different facts.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body.seasonKind).toBeNull();
      expect(body.openHoursKind).toBeNull();
      expect(body.stockingCadence).toBeNull();
      expect(body.openDays).toBeNull();
    });

    it("offers dawn and dusk as real answers, not as clock times", async () => {
      // Dusk on Vashon moves ~6 hours across the season, so no fixed pair of hours is
      // equivalent. This is why the schema has the value at all.
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      const select = screen.getByLabelText(/when are you usually open/i);
      expect(select).toHaveTextContent(/dawn to dusk/i);
      expect(select).toHaveTextContent(/until dusk/i);
    });

    it("keeps a stored 'daylight_hours' on an edit rather than silently dropping it", async () => {
      // The form no longer OFFERS `daylight_hours`, but 31 seeded farms already store it. An
      // edit form that could not hold a retired value would blank a farmer's stated hours the
      // moment they opened it to change something else — B-037's failure exactly.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...EDIT_DEFAULTS,
            availability: { ...EDIT_DEFAULTS.availability, openHoursKind: "daylight_hours" as const },
          }}
        />,
      );

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));
      expect(posted(fetchMock).openHoursKind).toBe("daylight_hours");
    });

    it("offers ONE way to say 'while it is light', not two", async () => {
      // `dawn_to_dusk` and `daylight_hours` are answered identically by `open-now` — same
      // open/closed verdict, same sunrise and sunset. Offering both asks a farmer to choose
      // between two phrasings of one fact, and splits the stored data on a distinction no
      // customer can see. The ENUM keeps both, because rows already hold `daylight_hours`;
      // only the form stops offering the second.
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      const select = screen.getByLabelText(/when are you usually open/i);
      expect(select).not.toHaveTextContent(/daylight hours/i);
      expect(
        within(select as HTMLElement).queryByRole("option", { name: /daylight hours/i }),
      ).toBeNull();
    });

    it("sends a clockless hours kind with NO clock times", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "dawn_to_dusk",
      );
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body.openHoursKind).toBe("dawn_to_dusk");
      expect(body.openFromMinutes).toBeUndefined();
      expect(body.openUntilMinutes).toBeUndefined();
    });

    it("asks for clock times only when the farmer chooses set hours", async () => {
      const user = userEvent.setup();
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      expect(screen.queryByLabelText(/opens at/i)).not.toBeInTheDocument();
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );
      expect(screen.getByLabelText(/opens at/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/until/i)).toBeInTheDocument();
    });

    it("converts a clock time to minutes since midnight", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );
      await user.selectOptions(screen.getByLabelText(/opens at/i), "08:30");
      await user.selectOptions(screen.getByLabelText(/until/i), "18:00");
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body.openFromMinutes).toBe(510);
      expect(body.openUntilMinutes).toBe(1080);
    });

    it("sends midnight as 0 rather than dropping it", async () => {
      // 0 is a real minute of day. Anything treating it as absent makes the row incoherent.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );
      await user.selectOptions(screen.getByLabelText(/opens at/i), "00:00");
      await user.selectOptions(screen.getByLabelText(/until/i), "12:00");
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(posted(fetchMock).openFromMinutes).toBe(0);
    });

    it("sends a date range as month and day numbers", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when is your stand open in the year/i),
        "date_range",
      );
      // Targeted by id: both date rows have a "day" field, so the label alone is ambiguous.
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.selectOptions(document.querySelector("#season-start-day")!, "1");
      await user.selectOptions(document.querySelector("#season-end-month")!, "11");
      await user.selectOptions(document.querySelector("#season-end-day")!, "30");
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body.seasonKind).toBe("date_range");
      expect(body.seasonStartMonth).toBe(3);
      expect(body.seasonStartDay).toBe(1);
      expect(body.seasonEndMonth).toBe(11);
      expect(body.seasonEndDay).toBe(30);
    });

    /**
     * Nothing here should require typing. A farmer stands at their stand on a phone: a number
     * box invites "31st", "1 " and a stray keystroke, and a native time input is a fiddly
     * three-part control. Both are now dropdowns, and these assert the LISTS — the values a
     * farmer can actually reach — not merely that a select exists.
     */
    it("offers the day of the month as choices rather than a number to type", async () => {
      const user = userEvent.setup();
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);
      await user.selectOptions(
        screen.getByLabelText(/when is your stand open in the year/i),
        "date_range",
      );

      const day = document.querySelector("#season-start-day") as HTMLSelectElement;
      expect(day.tagName).toBe("SELECT");
      // A blank placeholder plus 31 days, before a month narrows it.
      expect(day.querySelectorAll("option")).toHaveLength(32);
    });

    it("offers only the days the chosen month actually has", async () => {
      // February must still reach 29: the season is a recurring month/day with NO year, so a
      // stand opening on the 29th in leap years has to be stateable.
      const user = userEvent.setup();
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);
      await user.selectOptions(
        screen.getByLabelText(/when is your stand open in the year/i),
        "date_range",
      );

      await user.selectOptions(document.querySelector("#season-start-month")!, "2");
      const feb = document.querySelector("#season-start-day") as HTMLSelectElement;
      expect(feb.querySelectorAll("option")).toHaveLength(30);

      await user.selectOptions(document.querySelector("#season-start-month")!, "4");
      const april = document.querySelector("#season-start-day") as HTMLSelectElement;
      expect(april.querySelectorAll("option")).toHaveLength(31);
    });

    it("drops a day the newly chosen month does not have", async () => {
      // The trap this closes: pick March 31, switch to April, and 31 would otherwise stay
      // selected in state and be SAVED as an April date that does not exist.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when is your stand open in the year/i),
        "date_range",
      );
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.selectOptions(document.querySelector("#season-start-day")!, "31");
      await user.selectOptions(document.querySelector("#season-start-month")!, "4");

      expect((document.querySelector("#season-start-day") as HTMLSelectElement).value).toBe("");

      await user.click(screen.getByRole("button", { name: /submit/i }));
      const body = posted(fetchMock);
      expect(body.seasonStartMonth).toBe(4);
      // Explicitly null — "no day stated" — rather than the stale 31, which would have been
      // saved as an April date that does not exist.
      expect(body.seasonStartDay).toBeNull();
    });

    it("keeps a day the newly chosen month still has", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when is your stand open in the year/i),
        "date_range",
      );
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.selectOptions(document.querySelector("#season-start-day")!, "15");
      await user.selectOptions(document.querySelector("#season-start-month")!, "4");

      await user.click(screen.getByRole("button", { name: /submit/i }));
      const body = posted(fetchMock);
      expect(body.seasonStartDay).toBe(15);
    });

    it("offers opening and closing times as half-hour choices, midnight to midnight", async () => {
      const user = userEvent.setup();
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );

      const from = document.querySelector("#open-from") as HTMLSelectElement;
      expect(from.tagName).toBe("SELECT");
      // 48 half-hour slots across the day, plus the blank placeholder.
      expect(from.querySelectorAll("option")).toHaveLength(49);

      const values = [...from.querySelectorAll("option")].map((o) => o.value);
      expect(values).toContain("00:00");
      expect(values).toContain("08:30");
      expect(values).toContain("23:30");
    });

    it("still sends times as minutes since midnight", async () => {
      // The stored contract is unchanged by the control swap: the option VALUES are the same
      // "HH:MM" strings the time input produced, so `minutesOfDay` keeps working.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );
      await user.selectOptions(document.querySelector("#open-from")!, "08:30");
      await user.selectOptions(document.querySelector("#open-until")!, "17:00");
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body.openFromMinutes).toBe(510);
      expect(body.openUntilMinutes).toBe(1020);
    });

    it("STOPS sending season dates when the farmer switches to year-round", async () => {
      // The ordinary correction. Stale dates would make the row violate `coherentSeason` and
      // the farmer would be refused over a field the form no longer shows them.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      const season = screen.getByLabelText(/when is your stand open in the year/i);
      await user.selectOptions(season, "date_range");
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.selectOptions(document.querySelector("#season-start-day")!, "1");
      await user.selectOptions(season, "year_round");
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body.seasonKind).toBe("year_round");
      expect(body.seasonStartMonth).toBeUndefined();
      expect(body.seasonStartDay).toBeUndefined();
    });

    it("sends the days the farmer ticked, in weekday order", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      // Ticked out of order, to prove the order sent is the weekday order and not the click
      // order — the column is a set, and a reader showing "Sat, Wed" would read as wrong.
      await user.click(screen.getByRole("checkbox", { name: "Sat" }));
      await user.click(screen.getByRole("checkbox", { name: "Wed" }));
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(posted(fetchMock).openDays).toEqual([3, 6]);
    });

    it("asks which days only when restocking is on certain days", async () => {
      const user = userEvent.setup();
      stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(screen.getByLabelText(/how often do you restock/i), "daily");
      expect(screen.queryByText(/which days do you restock/i)).not.toBeInTheDocument();

      await user.selectOptions(
        screen.getByLabelText(/how often do you restock/i),
        "specific_days",
      );
      expect(screen.getByText(/which days do you restock/i)).toBeInTheDocument();
    });

    it("sends no stocking days for a cadence that carries none", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(screen.getByLabelText(/how often do you restock/i), "variable");
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body.stockingCadence).toBe("variable");
      expect(body.stockingDays).toBeUndefined();
    });

    it("keeps hoursText as the farmer's own words beside the structured hours", async () => {
      // "Weekends when available" carries a caveat no day set can hold, and the map would be
      // more confident than the farmer if it were dropped.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "dawn_to_dusk",
      );
      await user.type(
        screen.getByLabelText(/anything else about your hours/i),
        "Weekends when available",
      );
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = posted(fetchMock);
      expect(body.openHoursKind).toBe("dawn_to_dusk");
      expect(body.hoursText).toBe("Weekends when available");
    });

    it("explains an incoherent availability refusal in actionable words", async () => {
      const user = userEvent.setup();
      stubFetch({
        ok: false,
        status: 400,
        body: { error: "incoherent_availability" },
      });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/season, hours, or restocking/i);
    });
  });

  // ── F-077: the geocoded address is the ONLY coordinate source ──────────────────────────
  //
  // F-069 made the lookup a suggestion the farmer confirmed by tapping the island map. max
  // retired that (2026-08-06): the typed address is now the sole source of a coordinate, and
  // an address that will not resolve is REFUSED rather than fudged onto a tapped point.
  //
  // What that trades away, deliberately: a stand at the road rather than at the mailing
  // address can no longer be nudged. What it buys is that no published coordinate is ever
  // something other than the address printed beside it.
  //
  // The map SURVIVES as a read-only display of the geocoded point. Removing it entirely would
  // publish a coordinate the farmer can neither see nor sanity-check.
  describe("F-077 geocode-only placement", () => {
    /** A fetch stub that answers the lookup and the listing POST differently. */
    function stubRoutes(lookupBody: unknown, lookupOk = true) {
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).includes("address-lookup")) {
          return {
            ok: lookupOk,
            status: lookupOk ? 200 : 500,
            json: async () => lookupBody,
          };
        }
        return { ok: true, status: 200, json: async () => ({ status: "saved" }) };
      }) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock as unknown as ReturnType<typeof vi.fn>;
    }

    /** The body of the call to a given endpoint. */
    function bodyFor(
      fetchMock: ReturnType<typeof vi.fn>,
      fragment: string,
    ): Record<string, unknown> {
      const call = fetchMock.mock.calls.find((entry) =>
        String((entry as [string, unknown])[0]).includes(fragment),
      ) as [string, { body: string }] | undefined;
      if (call === undefined) throw new Error(`no call to ${fragment}`);
      return JSON.parse(call[1].body) as Record<string, unknown>;
    }

    it("sends the address and the TOKEN to the lookup, in the body", async () => {
      const user = userEvent.setup();
      const fetchMock = stubRoutes({
        status: "found",
        latitude: 47.4471,
        longitude: -122.4594,
      });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      const body = bodyFor(fetchMock, "address-lookup");
      expect(body.token).toBe(TOKEN);
      expect(body.address).toBe("12345 Vashon Highway SW");
    });

    it("publishes the geocoded coordinate with NO confirmation step", async () => {
      // F-077 — the lookup is now the answer, not a suggestion. A found address is
      // immediately publishable; there is no second click between looking up and saving.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({
        status: "found",
        latitude: 47.4471,
        longitude: -122.4594,
      });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      await screen.findByText(/found it/i);
      expect(
        screen.queryByRole("button", { name: /that spot looks right/i }),
      ).not.toBeInTheDocument();

      const publish = screen.getByRole("button", { name: /submit/i });
      expect(publish).toBeEnabled();
      await user.click(publish);

      const body = bodyFor(fetchMock, "/api/farmer/listing");
      expect(body.latitude).toBeCloseTo(47.4471, 6);
      expect(body.longitude).toBeCloseTo(-122.4594, 6);
    });

    it("REFUSES to publish a visitable stand whose address never resolved", async () => {
      // The core of F-077. Before this, every lookup failure degraded to tapping the map, so
      // a stand always reached the map somehow. Now an unresolvable address stops the
      // publication instead of being approximated.
      const user = userEvent.setup();
      stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "nowhere at all");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      await screen.findByRole("status");
      expect(
        screen.getByRole("button", { name: /submit/i }),
      ).toBeDisabled();
    });

    it("asks the farmer to correct the address when the ADDRESS is the problem", async () => {
      // The two failures the farmer can actually act on: the geocoder found nothing, or found
      // something off the island. Both mean the typed address needs fixing.
      for (const body of [{ status: "no_result" }, { status: "off_island" }]) {
        const user = userEvent.setup();
        stubRoutes(body);
        render(
          <ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />,
        );

        await user.click(screen.getByLabelText(/there is a stand to visit/i));
        await user.type(screen.getByLabelText(/where is it/i), "somewhere");
        await user.click(screen.getByRole("button", { name: /find this address/i }));

        const note = await screen.findByRole("status");
        expect(note).toHaveTextContent(/check the address/i);
        // The retired copy offered "tap the map to show where your stand is", which now
        // describes an interaction that does not exist. Asserted absent, or this passes on
        // the old sentence forever.
        expect(note).not.toHaveTextContent(/tap the map/i);
        expect(
          screen.getByRole("button", { name: /submit/i }),
        ).toBeDisabled();
        document.body.innerHTML = "";
      }
    });

    it("does NOT blame the farmer's address when the GEOCODER is unconfigured", async () => {
      // A different failure with a different owner. `not_configured` is Farm Friend unable to
      // look anything up — telling the farmer to check an address that may be perfectly
      // correct sends them editing a field that was never the problem, and they would never
      // succeed however many times they tried.
      //
      // This is the case DEVELOPMENT.md's geocoder exemption used to cover by degrading to a
      // tap. With no tap left, an unconfigured geocoder genuinely means no visitable stand can
      // be created, so the form has to say so plainly rather than imply a fixable mistake.
      const user = userEvent.setup();
      stubRoutes({ status: "not_configured" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      const note = await screen.findByRole("status");
      expect(note).toHaveTextContent(/unavailable/i);
      expect(note).toHaveTextContent(/VIGA/);
      expect(note).not.toHaveTextContent(/check the address/i);
      expect(note).not.toHaveTextContent(/tap the map/i);
      expect(
        screen.getByRole("button", { name: /submit/i }),
      ).toBeDisabled();
    });

    it("refuses when the lookup itself throws, rather than publishing unplaced", async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (String(url).includes("address-lookup")) throw new Error("network down");
          return { ok: true, status: 200, json: async () => ({ status: "saved" }) };
        }) as unknown as typeof fetch,
      );
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      expect(await screen.findByRole("status")).toHaveTextContent(/check the address|correct/i);
      expect(
        screen.getByRole("button", { name: /submit/i }),
      ).toBeDisabled();
    });

    it("a THROWN lookup discards a stored coordinate too, on an edit form", async () => {
      // The network-failure twin of the test below. The two refusal paths — a status the
      // geocoder returned, and the fetch throwing — clear the pin independently, so each
      // needs its own proof: a sabotage removing `setPin(null)` from the catch branch alone
      // left every other test in this file green.
      const user = userEvent.setup();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (String(url).includes("address-lookup")) throw new Error("network down");
          return { ok: true, status: 200, json: async () => ({ status: "saved" }) };
        }) as unknown as typeof fetch,
      );

      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...EDIT_DEFAULTS,
            visitability: "visitable" as const,
            publicAddress: "12345 Vashon Highway SW",
            latitude: 47.4471,
            longitude: -122.4594,
          }}
        />,
      );

      expect(
        screen.getByRole("button", { name: /submit|save changes/i }),
      ).toBeEnabled();

      await user.click(screen.getByRole("button", { name: /find this address/i }));
      await screen.findByRole("status");

      expect(
        screen.getByRole("button", { name: /submit|save changes/i }),
      ).toBeDisabled();
    });

    it("EDITING THE ADDRESS CLEARS THE PIN, so A's coordinate cannot publish under B", async () => {
      // The sharp edge F-077 creates. With no tap and no confirm gate, a farmer who looks up
      // address A and then edits the text to address B would otherwise publish A's coordinate
      // labelled as B — a customer sent to the wrong place with nothing to show anything was
      // wrong. This bug did not exist under F-069, because a tap re-confirmed.
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      const addressField = screen.getByLabelText(/where is it/i);
      await user.type(addressField, "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      await screen.findByText(/found it/i);
      expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled();

      // The farmer changes their mind about the address.
      await user.type(addressField, " Unit B");

      expect(
        screen.getByRole("button", { name: /submit/i }),
      ).toBeDisabled();
      expect(screen.queryByText(/found it/i)).not.toBeInTheDocument();
    });

    it("a FAILED lookup discards a STORED coordinate, on an edit form", async () => {
      // The one path where the refusal branch's own pin-clearing is load-bearing.
      //
      // `changeAddress` covers the farmer who retypes: the pin is gone before the second
      // lookup runs. It does NOT cover an EDIT form, where the pin arrives from the saved
      // listing and the address is never touched. A returning farmer who presses "find this
      // address" and gets a failure would otherwise keep a coordinate the geocoder has just
      // said it cannot confirm, and publish it as though it had.
      //
      // Verified reachable by sabotage: removing `setPin(null)` from the refusal branch
      // leaves every other test in this file green.
      const user = userEvent.setup();
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).includes("address-lookup")) {
          return { ok: true, status: 200, json: async () => ({ status: "no_result" }) };
        }
        return { ok: true, status: 200, json: async () => ({ status: "saved" }) };
      }) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);

      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...EDIT_DEFAULTS,
            visitability: "visitable" as const,
            publicAddress: "12345 Vashon Highway SW",
            latitude: 47.4471,
            longitude: -122.4594,
          }}
        />,
      );

      // Arrives publishable, on the stored coordinate.
      expect(
        screen.getByRole("button", { name: /submit|save changes/i }),
      ).toBeEnabled();

      // The farmer re-runs the lookup without editing anything, and it fails.
      await user.click(screen.getByRole("button", { name: /find this address/i }));
      await screen.findByRole("status");

      expect(
        screen.getByRole("button", { name: /submit|save changes/i }),
      ).toBeDisabled();
      expect(screen.queryByText(/found it/i)).not.toBeInTheDocument();
    });

    it("shows the geocoded point on a map the farmer cannot tap", async () => {
      // The map stays as a read-only DISPLAY. Publishing a coordinate the farmer can neither
      // see nor sanity-check would be worse than the lookup being wrong, because nothing on
      // screen would show it. But it is no longer an input: there is no placement to make.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({
        status: "found",
        latitude: 47.4471,
        longitude: -122.4594,
      });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));
      await screen.findByText(/found it/i);

      const map = screen.getByRole("img", { name: /map of vashon/i });
      expect(map).toBeInTheDocument();
      // No instruction to tap, and nothing telling the farmer one would do anything.
      expect(map.getAttribute("aria-label") ?? "").not.toMatch(/tap/i);
      expect(screen.queryByText(/tap the map/i)).not.toBeInTheDocument();

      // A tap MOVES NOTHING. Asserted against the published coordinate rather than against a
      // call count, because the geocoded value is the thing that must survive: a tap handler
      // that overwrote the pin would reintroduce exactly the coordinate-vs-address divergence
      // F-077 removes, and would do it without any extra fetch to count.
      map.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 400, height: 600 }) as DOMRect;
      await user.click(map);
      await user.click(screen.getByRole("button", { name: /submit/i }));

      const body = bodyFor(fetchMock, "/api/farmer/listing");
      expect(body.latitude).toBeCloseTo(47.4471, 6);
      expect(body.longitude).toBeCloseTo(-122.4594, 6);
    });

    it("does not look up a blank address", async () => {
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));

      expect(screen.getByRole("button", { name: /find this address/i })).toBeDisabled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("the lookup button does NOT submit the form", async () => {
      // A bare button inside a form submits by default, which would try to publish the listing
      // on a lookup — with no pin, and a refusal the farmer did not ask for.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      const listingCalls = fetchMock.mock.calls.filter((entry) =>
        String((entry as [string, unknown])[0]).includes("/api/farmer/listing"),
      );
      expect(listingCalls).toHaveLength(0);
    });
  });

  // ── F-072 / F-073: the same form through three doors ────────────────────────────────────
  //
  // One component, parameterized by credential. These assert the two things that would break
  // silently if the doors drifted: where a submission GOES, and — for an edit — that the form
  // arrives holding the farmer's current listing.

  describe("the credential decides where the listing goes", () => {
    it("posts an invited farmer's listing with its TOKEN", async () => {
      const fetchMock = stubFetch({ ok: true });
      const user = userEvent.setup();
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver, or people arrange/i));
      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      const call = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(call[0]).toBe("/api/farmer/listing");
      expect(JSON.parse(call[1].body).token).toBe(TOKEN);
    });

    it("posts a GRANDFATHERED farmer's listing with its farm id, to its own endpoint", async () => {
      const fetchMock = stubFetch({ ok: true });
      const user = userEvent.setup();
      render(
        <ListingStep
          credential={{ kind: "grandfathered", farmId: FARM_ID }}
          farmName="Test Farm"
        />,
      );

      await user.click(screen.getByLabelText(/I deliver, or people arrange/i));
      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      const call = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(call[0]).toBe("/api/farmer/grandfathered-listing");
      const body = JSON.parse(call[1].body) as Record<string, unknown>;
      expect(body.farmId).toBe(FARM_ID);
      expect(body.token).toBeUndefined();
    });

    it("posts an EDIT to the edit endpoint with the stand link token", async () => {
      const fetchMock = stubFetch({ ok: true });
      const user = userEvent.setup();
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={EDIT_DEFAULTS}
        />,
      );

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      const call = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(call[0]).toBe("/api/farmer/listing-edit");
      expect(JSON.parse(call[1].body).token).toBe(TOKEN);
    });
  });

  describe("an edit form arrives holding the current listing", () => {
    // B-037 — this fixture carried only the eight fields `ListingDefaults` happened to have,
    // so "field for field" below proved the round trip for what it knew about and was SILENT
    // on the twelve availability columns the writer sets unconditionally. Widening it is what
    // makes the existing test fail on its own name.
    const DEFAULTS = {
      standName: "Existing Stand",
      visitability: "visitable" as const,
      publicAddress: "12345 Vashon Highway SW",
      latitude: 47.4471,
      longitude: -122.4594,
      hoursText: "Dawn to dusk",
      paymentMethods: ["Cash", "Goats"],
      items: ["Eggs", "Flowers"],
      availability: {
        seasonKind: "date_range" as const,
        seasonStartMonth: 3,
        seasonStartDay: 1,
        seasonEndMonth: 11,
        seasonEndDay: 30,
        seasonNames: null,
        openHoursKind: "clock_range" as const,
        openFromMinutes: 510,
        openUntilMinutes: 1080,
        openDays: [0, 6],
        stockingCadence: "specific_days" as const,
        stockingDays: [2, 5],
      },
      description: null,
    };

    function renderEdit() {
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={DEFAULTS}
        />,
      );
    }

    it("shows the stand's current answers rather than an empty form", () => {
      // THE destructive case. The writer replaces the whole listing, so a farmer who opened
      // this to change their hours would erase their address, payments and items by omission
      // if the form came up blank.
      renderEdit();

      expect(screen.getByLabelText(/what is your stand called/i)).toHaveValue("Existing Stand");
      expect(screen.getByLabelText(/where is it/i)).toHaveValue("12345 Vashon Highway SW");
    });

    it("splits stored payment methods across the checkboxes and the free-text tail", () => {
      // "Cash" is an offered option; "Goats" is not. Putting a known method in the tail would
      // re-save it as free text and undo F-069's closed set.
      renderEdit();

      expect(screen.getByLabelText("Cash")).toBeChecked();
      expect(screen.getByLabelText("Anything else you take?")).toHaveValue("Goats");
    });

    it("arrives PUBLISHABLE, so an edit is not a forced re-lookup", async () => {
      // A stand already on the map has a coordinate, and it is already the farmer's answer.
      // Requiring a fresh lookup before they could save an unrelated change would make every
      // edit a re-placement — and would strand any farmer whose address no longer resolves.
      //
      // The old assertion here checked for the ABSENCE of "tap the map to place", copy that
      // F-077 deleted everywhere. It would have passed forever while proving nothing.
      const fetchMock = stubFetch({ ok: true });
      const user = userEvent.setup();
      renderEdit();

      const publish = screen.getByRole("button", { name: /submit|save changes/i });
      expect(publish).toBeEnabled();
      await user.click(publish);

      const body = posted(fetchMock);
      expect(body.latitude).toBe(47.4471);
      expect(body.longitude).toBe(-122.4594);
    });

    it("RESAVES an untouched edit form unchanged, field for field", async () => {
      // The round trip that proves prefill is complete: open the form, change nothing, save,
      // and the body must carry back everything that was there. A field the form forgot to
      // prefill shows up here as a silent deletion.
      const fetchMock = stubFetch({ ok: true });
      const user = userEvent.setup();
      renderEdit();

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      const body = posted(fetchMock);
      expect(body.standName).toBe("Existing Stand");
      expect(body.visitability).toBe("visitable");
      expect(body.publicAddress).toBe("12345 Vashon Highway SW");
      expect(body.latitude).toBe(47.4471);
      expect(body.longitude).toBe(-122.4594);
      expect(body.hoursText).toBe("Dawn to dusk");
      expect(body.paymentMethods).toEqual(["Cash", "Goats"]);
      expect(body.items).toEqual(["Eggs", "Flowers"]);
      // B-037 — the twelve the writer sets unconditionally. `updateStand` names every
      // availability column in one statement, so anything absent here is written NULL: a
      // farmer who came to change their hours loses their season and restocking silently.
      expect(body.seasonKind).toBe("date_range");
      expect(body.seasonStartMonth).toBe(3);
      expect(body.seasonStartDay).toBe(1);
      expect(body.seasonEndMonth).toBe(11);
      expect(body.seasonEndDay).toBe(30);
      expect(body.openHoursKind).toBe("clock_range");
      expect(body.openFromMinutes).toBe(510);
      expect(body.openUntilMinutes).toBe(1080);
      expect(body.openDays).toEqual([0, 6]);
      expect(body.stockingCadence).toBe("specific_days");
      expect(body.stockingDays).toEqual([2, 5]);
    });

    it("shows the stand's current season, hours and restocking rather than blank selects", () => {
      // The visible half of B-037. A farmer looking at blank selects reads them as facts
      // Farm Friend never had, and has no way to know a save is about to erase them.
      renderEdit();

      expect(screen.getByLabelText(/when is your stand open in the year/i)).toHaveValue(
        "date_range",
      );
      expect(screen.getByLabelText(/when are you usually open/i)).toHaveValue("clock_range");
      expect(screen.getByLabelText(/how often do you restock/i)).toHaveValue("specific_days");

      // The date fields the chosen season kind reveals. Blank ones here would be sent as
      // NULL under `date_range`, which `sales_locations_coherent_season` refuses outright —
      // so the farmer's own save would start failing on a form they had not touched.
      expect(screen.getByLabelText(/^opens$/i)).toHaveValue("3");
      expect(screen.getByLabelText(/^closes$/i)).toHaveValue("11");

      // Scoped by fieldset. The two day-sets are independent facts with the same seven
      // labels, and asserting "Sun" globally would let a restocking day satisfy an
      // assertion about opening days.
      const openDays = screen.getByRole("group", { name: /which days are you open/i });
      const restockDays = screen.getByRole("group", { name: /which days do you restock/i });
      expect(within(openDays).getByLabelText("Sun")).toBeChecked();
      expect(within(openDays).getByLabelText("Sat")).toBeChecked();
      expect(within(openDays).getByLabelText("Mon")).not.toBeChecked();
      expect(within(restockDays).getByLabelText("Tue")).toBeChecked();
      expect(within(restockDays).getByLabelText("Fri")).toBeChecked();
      expect(within(restockDays).getByLabelText("Sun")).not.toBeChecked();
    });

    it("renders minutes-since-midnight back as a clock value, MIDNIGHT INCLUDED", () => {
      // The read direction needs the same care `minutesOfDay` already takes on the write
      // direction. 0 is midnight — a real, stated time — so a truthiness check would render
      // it as "not stated" and the next save would drop it.
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...DEFAULTS,
            availability: {
              ...DEFAULTS.availability,
              openFromMinutes: 0,
              openUntilMinutes: 510,
            },
          }}
        />,
      );

      expect(screen.getByLabelText(/opens at/i)).toHaveValue("00:00");
      expect(screen.getByLabelText(/until/i)).toHaveValue("08:30");
    });

    it("carries a NAMED season back rather than the date fields", async () => {
      // The season kinds are mutually exclusive in the database
      // (`sales_locations_coherent_season`), so prefilling has to restore the right ONE. A
      // form that restored dates under `named_season` would be refused by the constraint.
      const fetchMock = stubFetch({ ok: true });
      const user = userEvent.setup();
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...DEFAULTS,
            availability: {
              ...DEFAULTS.availability,
              seasonKind: "named_season" as const,
              seasonStartMonth: null,
              seasonStartDay: null,
              seasonEndMonth: null,
              seasonEndDay: null,
              seasonNames: ["summer", "apple season"],
            },
          }}
        />,
      );

      expect(screen.getByLabelText(/which seasons/i)).toHaveValue("summer, apple season");

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      const body = posted(fetchMock);
      expect(body.seasonKind).toBe("named_season");
      expect(body.seasonNames).toEqual(["summer", "apple season"]);
      expect(body.seasonStartMonth).toBeUndefined();
      expect(body.seasonEndMonth).toBeUndefined();
    });
  });
});
