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
    await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs, , rhubarb,");
    await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

    expect(posted(fetchMock).items).toEqual(["eggs", "rhubarb"]);
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

  // ── F-069: payments as a closed set ───────────────────────────────────────────────────
  describe("F-069 payment methods", () => {
    it("offers the closed set as CHECKBOXES rather than a text box", async () => {
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      for (const method of ["Cash", "Check", "Venmo", "PayPal", "Zelle"]) {
        expect(screen.getByRole("checkbox", { name: method })).toBeInTheDocument();
      }
    });

    it("does NOT offer VIGA Farm Bucks, which only VIGA can grant", async () => {
      // Acceptance is gated on an eligibility with its own admin workflow and an
      // `acceptanceRequiresEligibility` constraint. A farmer ticking a box would be asserting
      // a VIGA decision about themselves.
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      expect(screen.queryByText(/farm bucks/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/VIGA bucks/i)).not.toBeInTheDocument();
    });

    it("sends the checked methods, canonically spelled", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.click(screen.getByRole("checkbox", { name: "Venmo" }));
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      expect(posted(fetchMock).paymentMethods).toEqual(["Cash", "Venmo"]);
    });

    it("unchecking a method removes it", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.click(screen.getByRole("checkbox", { name: "Venmo" }));
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      expect(posted(fetchMock).paymentMethods).toEqual(["Venmo"]);
    });

    it("keeps a free-text method alongside the checked ones", async () => {
      // The closed set must not lose a real fact a farmer states.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.type(screen.getByLabelText(/anything else you take/i), "trade for eggs");
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      expect(posted(fetchMock).paymentMethods).toEqual(["Cash", "trade for eggs"]);
    });
  });

  // ── F-069: structured season / hours / stocking ───────────────────────────────────────
  describe("F-069 structured availability", () => {
    it("sends NOTHING stated when the farmer answers none of it", async () => {
      // "Rather not say" must stay a real answer: NULL and "open all year" are different facts.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      const body = posted(fetchMock);
      expect(body.seasonKind).toBeNull();
      expect(body.openHoursKind).toBeNull();
      expect(body.stockingCadence).toBeNull();
      expect(body.openDays).toBeNull();
    });

    it("offers dawn and dusk as real answers, not as clock times", async () => {
      // Dusk on Vashon moves ~6 hours across the season, so no fixed pair of hours is
      // equivalent. This is why the schema has the value at all.
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      const select = screen.getByLabelText(/when are you usually open/i);
      expect(select).toHaveTextContent(/dawn to dusk/i);
      expect(select).toHaveTextContent(/until dusk/i);
      expect(select).toHaveTextContent(/daylight hours/i);
    });

    it("sends a clockless hours kind with NO clock times", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "dawn_to_dusk",
      );
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      const body = posted(fetchMock);
      expect(body.openHoursKind).toBe("dawn_to_dusk");
      expect(body.openFromMinutes).toBeUndefined();
      expect(body.openUntilMinutes).toBeUndefined();
    });

    it("asks for clock times only when the farmer chooses set hours", async () => {
      const user = userEvent.setup();
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

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
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );
      await user.type(screen.getByLabelText(/opens at/i), "08:30");
      await user.type(screen.getByLabelText(/until/i), "18:00");
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      const body = posted(fetchMock);
      expect(body.openFromMinutes).toBe(510);
      expect(body.openUntilMinutes).toBe(1080);
    });

    it("sends midnight as 0 rather than dropping it", async () => {
      // 0 is a real minute of day. Anything treating it as absent makes the row incoherent.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );
      await user.type(screen.getByLabelText(/opens at/i), "00:00");
      await user.type(screen.getByLabelText(/until/i), "12:00");
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      expect(posted(fetchMock).openFromMinutes).toBe(0);
    });

    it("sends a date range as month and day numbers", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when is your stand open in the year/i),
        "date_range",
      );
      // Targeted by id: both date rows have a "day" field, so the label alone is ambiguous.
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.type(document.querySelector("#season-start-day")!, "1");
      await user.selectOptions(document.querySelector("#season-end-month")!, "11");
      await user.type(document.querySelector("#season-end-day")!, "30");
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      const body = posted(fetchMock);
      expect(body.seasonKind).toBe("date_range");
      expect(body.seasonStartMonth).toBe(3);
      expect(body.seasonStartDay).toBe(1);
      expect(body.seasonEndMonth).toBe(11);
      expect(body.seasonEndDay).toBe(30);
    });

    it("STOPS sending season dates when the farmer switches to year-round", async () => {
      // The ordinary correction. Stale dates would make the row violate `coherentSeason` and
      // the farmer would be refused over a field the form no longer shows them.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      const season = screen.getByLabelText(/when is your stand open in the year/i);
      await user.selectOptions(season, "date_range");
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.type(document.querySelector("#season-start-day")!, "1");
      await user.selectOptions(season, "year_round");
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      const body = posted(fetchMock);
      expect(body.seasonKind).toBe("year_round");
      expect(body.seasonStartMonth).toBeUndefined();
      expect(body.seasonStartDay).toBeUndefined();
    });

    it("sends the days the farmer ticked, in weekday order", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      // Ticked out of order, to prove the order sent is the weekday order and not the click
      // order — the column is a set, and a reader showing "Sat, Wed" would read as wrong.
      await user.click(screen.getByRole("checkbox", { name: "Sat" }));
      await user.click(screen.getByRole("checkbox", { name: "Wed" }));
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      expect(posted(fetchMock).openDays).toEqual([3, 6]);
    });

    it("asks which days only when restocking is on certain days", async () => {
      const user = userEvent.setup();
      stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

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
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(screen.getByLabelText(/how often do you restock/i), "variable");
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      const body = posted(fetchMock);
      expect(body.stockingCadence).toBe("variable");
      expect(body.stockingDays).toBeUndefined();
    });

    it("keeps hoursText as the farmer's own words beside the structured hours", async () => {
      // "Weekends when available" carries a caveat no day set can hold, and the map would be
      // more confident than the farmer if it were dropped.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "dawn_to_dusk",
      );
      await user.type(
        screen.getByLabelText(/anything else about your hours/i),
        "Weekends when available",
      );
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

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
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/season, hours, or restocking/i);
    });
  });

  // ── F-069: the geocoded DRAFT pin ─────────────────────────────────────────────────────
  //
  // The property under test is that a LOOKUP IS A SUGGESTION. max approved reopening the
  // no-geocoder boundary on the condition that the farmer confirms the spot, because a farm
  // stand is often at the road rather than the mailing address and only the farmer knows.
  describe("F-069 geocoded draft pin", () => {
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
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      const body = bodyFor(fetchMock, "address-lookup");
      expect(body.token).toBe(TOKEN);
      expect(body.address).toBe("12345 Vashon Highway SW");
    });

    it("does NOT let a looked-up pin publish until the farmer confirms it", async () => {
      // THE CONDITION max APPROVED. A suggestion the farmer never looked at must not reach the
      // map: the geocoder can save them work, never decide where their stand is.
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      expect(
        await screen.findByRole("button", { name: /that spot looks right/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /put my stand on the map/i }),
      ).toBeDisabled();
    });

    it("publishes the confirmed coordinate once the farmer accepts it", async () => {
      const user = userEvent.setup();
      const fetchMock = stubRoutes({
        status: "found",
        latitude: 47.4471,
        longitude: -122.4594,
      });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));
      await user.click(
        await screen.findByRole("button", { name: /that spot looks right/i }),
      );
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      const body = bodyFor(fetchMock, "/api/farmer/listing");
      expect(body.latitude).toBeCloseTo(47.4471, 6);
      expect(body.longitude).toBeCloseTo(-122.4594, 6);
    });

    it("asks the farmer to tap the map when the address is off the island", async () => {
      const user = userEvent.setup();
      stubRoutes({ status: "off_island" });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "1234 Pike Street");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      expect(await screen.findByRole("status")).toHaveTextContent(/not on the island|tap the map/i);
      // No pin was offered, so the form still cannot publish.
      expect(
        screen.getByRole("button", { name: /put my stand on the map/i }),
      ).toBeDisabled();
    });

    it("falls back to tapping the map on any lookup failure", async () => {
      for (const body of [{ status: "no_result" }, { status: "not_configured" }]) {
        const user = userEvent.setup();
        stubRoutes(body);
        render(<ListingStep token={TOKEN} farmName="Test Farm" />);

        await user.click(screen.getByLabelText(/there is a stand to visit/i));
        await user.type(screen.getByLabelText(/where is it/i), "somewhere");
        await user.click(screen.getByRole("button", { name: /find this address/i }));

        expect(await screen.findByRole("status")).toHaveTextContent(/tap the map/i);
        expect(
          screen.getByRole("button", { name: /put my stand on the map/i }),
        ).toBeDisabled();
        document.body.innerHTML = "";
      }
    });

    it("a TAP is its own confirmation, needing no second click", async () => {
      // The farmer touching the map is them stating where the stand is. Requiring a further
      // confirmation of their own tap would be friction with no safety value.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");

      const map = screen.getByRole("img", { name: /map of vashon/i });
      // jsdom gives every element a zero-size rect, so the component's guard would reject the
      // tap. Stubbed to a real size, which is what a browser reports.
      map.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 400, height: 600 }) as DOMRect;
      await user.click(map);

      expect(
        screen.getByRole("button", { name: /put my stand on the map/i }),
      ).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: /that spot looks right/i }),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));
      const body = bodyFor(fetchMock, "/api/farmer/listing");
      expect(typeof body.latitude).toBe("number");
      expect(typeof body.longitude).toBe("number");
    });

    it("a tap REPLACES an unconfirmed suggestion", async () => {
      // The farmer disagreeing with the lookup is the case this whole design exists for.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({
        status: "found",
        latitude: 47.4471,
        longitude: -122.4594,
      });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));
      await screen.findByRole("button", { name: /that spot looks right/i });

      const map = screen.getByRole("img", { name: /map of vashon/i });
      map.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 400, height: 600 }) as DOMRect;
      await user.click(map);

      // The confirmation prompt is gone, because the tap already settled it.
      expect(
        screen.queryByRole("button", { name: /that spot looks right/i }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /put my stand on the map/i }));

      const body = bodyFor(fetchMock, "/api/farmer/listing");
      // Not the looked-up coordinate: the farmer's own tap won.
      expect(body.latitude).not.toBeCloseTo(47.4471, 6);
    });

    it("does not look up a blank address", async () => {
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));

      expect(screen.getByRole("button", { name: /find this address/i })).toBeDisabled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("the lookup button does NOT submit the form", async () => {
      // A bare button inside a form submits by default, which would try to publish the listing
      // on a lookup — with no pin, and a refusal the farmer did not ask for.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(<ListingStep token={TOKEN} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/where is it/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /find this address/i }));

      const listingCalls = fetchMock.mock.calls.filter((entry) =>
        String((entry as [string, unknown])[0]).includes("/api/farmer/listing"),
      );
      expect(listingCalls).toHaveLength(0);
    });
  });
});
