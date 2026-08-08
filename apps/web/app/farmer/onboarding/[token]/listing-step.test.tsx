// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ISLAND_VIEWBOX } from "@farm-friend/core/island-projection";
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

/**
 * A fetch stub for the listing POST, which also answers the ADDRESS LOOKUP.
 *
 * F-088 made every farm placed, so submitting anything now requires an address that RESOLVED
 * — including a farm with no stand to visit. The lookup therefore has to succeed in every test
 * that reaches submit, not only the ones about geocoding.
 *
 * The lookup answer is fixed and the listing answer is the caller's, so a test that cares about
 * the response body still controls the only response it is asserting on.
 */
function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("address-lookup")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "found",
          latitude: 47.4471,
          longitude: -122.4594,
        }),
      };
    }
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 400),
      json: async () => response.body ?? {},
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

/**
 * Give the form a resolved address — the precondition for submitting ANY farm since F-088.
 *
 * Every farm is placed now, so a test that wants to reach submit has to type an address and
 * look it up first. Factored out so the requirement is stated once rather than copied into
 * every test that only cares about what happens after.
 */
async function placeStand(
  user: ReturnType<typeof userEvent.setup>,
  address = "12345 Vashon Highway SW",
): Promise<void> {
  await user.type(screen.getByLabelText(/your farm address/i), address);
  await user.click(screen.getByRole("button", { name: /^save$/i }));
  await screen.findByText(/found it/i);
}

/**
 * Submit the form, clearing the phone confirmation when the INVITED door raises one.
 *
 * The invited door asks for a phone and confirms it before posting (max 2026-08-07), so a test
 * that only clicked Submit would assert against a request that was never made. Factored out so
 * the two-step submission is stated once rather than copied into every test that just wants to
 * reach the network.
 *
 * The other two doors ask for no phone and post immediately; the `queryByRole` keeps this one
 * helper correct for all three rather than needing a per-door variant.
 */
async function submitListing(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const phoneField = screen.queryByLabelText(/your phone number/i);
  if (phoneField !== null && (phoneField as HTMLInputElement).value === "") {
    await user.type(phoneField, "2065550143");
  }
  await user.click(screen.getByRole("button", { name: /submit|save changes/i }));
  const dialog = screen.queryByRole("dialog");
  if (dialog !== null) {
    await user.click(
      within(dialog).getByRole("button", { name: /yes, that is my number/i }),
    );
  }
}

/** A saved listing, as an already-onboarded farmer's editor is prefilled from. */
const EDIT_DEFAULTS = {
  standName: "Existing Stand",
  visitability: "contact_only" as const,
  publicAddress: null,
  addressPublic: true,
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
/**
 * The body of the LISTING post, found by its endpoint rather than by position.
 *
 * It used to read `calls[0]`, which held while the listing was the only request the form ever
 * made. Since F-088 every farm must resolve an address first, so `calls[0]` is the geocoding
 * lookup and a positional read returns the wrong body — silently, as `undefined` fields that
 * look like the form failing to send anything.
 */
function posted(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    (entry) => !String((entry as [string, unknown])[0]).includes("address-lookup"),
  ) as [string, { body: string }] | undefined;
  if (call === undefined) throw new Error("the form posted no listing");
  return JSON.parse(call[1].body) as Record<string, unknown>;
}

describe("onboarding listing step", () => {
  it("asks WHERE the farm is before asking whether people can visit (F-088)", () => {
    // The order inverted, and the reason it could. The address used to sit BEHIND the visit
    // question because the database refused to store one for a farm with no stand — asking
    // first would have collected a value it then discarded.
    //
    // Since max reopened that (2026-08-07) every farm is placed, so the address is asked of
    // everyone and the visit question narrows what an already-placed farm SHOWS.
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    // Both present from the start, with no answer needed to reveal the address.
    expect(screen.getByLabelText(/your farm address/i)).toBeInTheDocument();
    expect(screen.getByText(/can people come to your stand/i)).toBeInTheDocument();

    // ...and the address comes FIRST in the document, which is the ordering claim itself.
    const address = screen.getByLabelText(/your farm address/i);
    const visit = screen.getByText(/can people come to your stand/i);
    expect(
      address.compareDocumentPosition(visit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("still asks for an address when the farmer has NO stand to visit (F-088)", async () => {
    // The direction that changed. A delivery-only farm is now placed like any other: it gets a
    // pin, its own "Farm, no stand" marker, and a card saying there is nothing to visit — what
    // it does not get is a directions link (asserted in the map-view suite).
    //
    // B-024's protection did not go away, it MOVED: a farmer who says people cannot visit is
    // never rendered as a destination. That is now a rendering rule rather than a missing row.
    const user = userEvent.setup();
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));

    expect(screen.getByLabelText(/your farm address/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^save$/i }),
    ).toBeInTheDocument();
  });

  it("SENDS the address and pin for a farmer with nowhere to visit (F-088)", async () => {
    // The inverse of what this asserted before. A contact-only listing used to carry no
    // location at all, because `coherentVisitability` refused one; now it carries a full one
    // and `visitability` alone tells the map not to invite the drive.
    //
    // This is the assertion that would catch a silent regression to the old stripping: the
    // farmer typed an address, and dropping it here would discard a fact they gave us while
    // the form showed no sign of having done so.
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
    await submitListing(user);

    const body = posted(fetchMock);
    expect(body.visitability).toBe("contact_only");
    expect(body.publicAddress).toBe("12345 Vashon Highway SW");
    expect(body.latitude).toBeCloseTo(47.4471, 6);
    expect(body.longitude).toBeCloseTo(-122.4594, 6);
  });

  it("sends the token in the BODY, never in the URL", async () => {
    // A credential in a query string lands in server logs and browser history by default.
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
    await submitListing(user);

    // Not `calls[0]` — that is the address lookup since F-088. Found by endpoint instead.
    const call = fetchMock.mock.calls.find(
      (entry) => !String((entry as [string, unknown])[0]).includes("address-lookup"),
    ) as [string, unknown];
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
    await placeStand(user);
    await user.type(
      screen.getByLabelText(/what do you usually sell/i),
      "tomato, tomatoes , love apple",
    );
    await submitListing(user);

    expect(posted(fetchMock).items).toEqual(["tomato", "tomatoes", "love apple"]);
  });

  it("drops empty entries from a list rather than sending blanks", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
    await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs, , rhubarb,");
    await submitListing(user);

    expect(posted(fetchMock).items).toEqual(["eggs", "rhubarb"]);
  });

  describe("finishing setup by text", () => {
    // THE STEP VIGA USED TO PERFORM. The migration door's page said "contact VIGA and they
    // will finish setting you up", which is a coordinator doing by hand what the farmer can
    // do themselves in one text.
    //
    // The direction is forced and is NOT a preference: `isProactiveSendPermitted` allows an
    // un-consented send only for `required_reply`, the carrier-required answer to the
    // recipient's OWN message, and `authorizeDispatch` suppresses everything else for a number
    // with no consent row. So Farm Friend cannot text the farmer first. They text us, and that
    // inbound message is both the possession proof and the opt-in.

    it("tells a migrating farmer the exact word to text, and to which number", async () => {
      const user = userEvent.setup();
      stubFetch({ ok: true });
      render(
        <ListingStep
          credential={{ kind: "grandfathered", farmId: FARM_ID }}
          farmName="Test Farm"
          smsNumber="+12065550000"
        />,
      );

      await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
      await submitListing(user);

      const next = await screen.findByRole("status");
      // START, never JOIN or CONFIRM. Only START clears the carrier's own opt-out list, so a
      // farmer who ever texted STOP is restored by this word and by no other — verified live
      // 2026-07-27, when a JOIN four minutes after a STOP was still refused 409.
      expect(next.textContent).toContain("START");
      expect(next.textContent).toContain("+12065550000");
    });

    it("does NOT promise that VIGA will finish setting them up", async () => {
      // The copy this replaces. A farmer told to wait for a coordinator waits for a step
      // nobody performs, which is the silent dead end this work exists to close.
      const user = userEvent.setup();
      stubFetch({ ok: true });
      render(
        <ListingStep
          credential={{ kind: "grandfathered", farmId: FARM_ID }}
          farmName="Test Farm"
          smsNumber="+12065550000"
        />,
      );

      await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
      await submitListing(user);

      const next = await screen.findByRole("status");
      expect(next.textContent?.toLowerCase()).not.toContain("contact viga");
      expect(next.textContent?.toLowerCase()).not.toContain("finish setting you up");
    });
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
    await placeStand(user);
      await user.type(
        screen.getByLabelText(/anything else people should know/i),
        "Certified organic. Goats on site.",
      );
      await submitListing(user);

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
    await placeStand(user);
      await user.clear(screen.getByLabelText(/anything else people should know/i));
      await submitListing(user);

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
    await placeStand(user);
    await submitListing(user);

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
    await placeStand(user);
    await submitListing(user);

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
    await placeStand(user);
    await submitListing(user);

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
    await placeStand(user);
    await submitListing(user);

    // Anchored to the hand-off sentence itself, not the word "text" — "texting SETTINGS"
    // appears in the non-onboarding copy and would satisfy a looser match forever.
    expect(await screen.findByRole("status")).toHaveTextContent(/last step/i);
  });

  it("reopens the form with the farmer's answers intact", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
    await submitListing(user);
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
      await placeStand(user);
      await submitListing(user);

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
    await placeStand(user);
    await submitListing(user);

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
    await placeStand(user);
    await submitListing(user);

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
    await placeStand(user);
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.click(screen.getByRole("checkbox", { name: "Venmo" }));
      await submitListing(user);

      expect(posted(fetchMock).paymentMethods).toEqual(["Cash", "Venmo"]);
    });

    it("unchecking a method removes it", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.click(screen.getByRole("checkbox", { name: "Venmo" }));
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await submitListing(user);

      expect(posted(fetchMock).paymentMethods).toEqual(["Venmo"]);
    });

    it("keeps a free-text method alongside the checked ones", async () => {
      // The closed set must not lose a real fact a farmer states.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
      await user.click(screen.getByRole("checkbox", { name: "Cash" }));
      await user.type(screen.getByLabelText(/anything else you take/i), "trade for eggs");
      await submitListing(user);

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
    await placeStand(user);
      await submitListing(user);

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

      await placeStand(user);
      await submitListing(user);
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
    await placeStand(user);
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "dawn_to_dusk",
      );
      await submitListing(user);

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
    await placeStand(user);
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );
      await user.selectOptions(screen.getByLabelText(/opens at/i), "08:30");
      await user.selectOptions(screen.getByLabelText(/until/i), "18:00");
      await submitListing(user);

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
    await placeStand(user);
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );
      await user.selectOptions(screen.getByLabelText(/opens at/i), "00:00");
      await user.selectOptions(screen.getByLabelText(/until/i), "12:00");
      await submitListing(user);

      expect(posted(fetchMock).openFromMinutes).toBe(0);
    });

    it("sends a date range as month and day numbers", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
      await user.selectOptions(
        screen.getByLabelText(/when is your stand open in the year/i),
        "date_range",
      );
      // Targeted by id: both date rows have a "day" field, so the label alone is ambiguous.
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.selectOptions(document.querySelector("#season-start-day")!, "1");
      await user.selectOptions(document.querySelector("#season-end-month")!, "11");
      await user.selectOptions(document.querySelector("#season-end-day")!, "30");
      await submitListing(user);

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
    await placeStand(user);
      await user.selectOptions(
        screen.getByLabelText(/when is your stand open in the year/i),
        "date_range",
      );
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.selectOptions(document.querySelector("#season-start-day")!, "31");
      await user.selectOptions(document.querySelector("#season-start-month")!, "4");

      expect((document.querySelector("#season-start-day") as HTMLSelectElement).value).toBe("");

      await submitListing(user);
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
    await placeStand(user);
      await user.selectOptions(
        screen.getByLabelText(/when is your stand open in the year/i),
        "date_range",
      );
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.selectOptions(document.querySelector("#season-start-day")!, "15");
      await user.selectOptions(document.querySelector("#season-start-month")!, "4");

      await submitListing(user);
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
    await placeStand(user);
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "clock_range",
      );
      await user.selectOptions(document.querySelector("#open-from")!, "08:30");
      await user.selectOptions(document.querySelector("#open-until")!, "17:00");
      await submitListing(user);

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
    await placeStand(user);
      const season = screen.getByLabelText(/when is your stand open in the year/i);
      await user.selectOptions(season, "date_range");
      await user.selectOptions(document.querySelector("#season-start-month")!, "3");
      await user.selectOptions(document.querySelector("#season-start-day")!, "1");
      await user.selectOptions(season, "year_round");
      await submitListing(user);

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
    await placeStand(user);
      // Ticked out of order, to prove the order sent is the weekday order and not the click
      // order — the column is a set, and a reader showing "Sat, Wed" would read as wrong.
      await user.click(screen.getByRole("checkbox", { name: "Sat" }));
      await user.click(screen.getByRole("checkbox", { name: "Wed" }));
      await submitListing(user);

      expect(posted(fetchMock).openDays).toEqual([3, 6]);
    });

    it("asks which days only when restocking is on certain days", async () => {
      const user = userEvent.setup();
      stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver/i));
    await placeStand(user);
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
    await placeStand(user);
      await user.selectOptions(screen.getByLabelText(/how often do you restock/i), "variable");
      await submitListing(user);

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
    await placeStand(user);
      await user.selectOptions(
        screen.getByLabelText(/when are you usually open/i),
        "dawn_to_dusk",
      );
      await user.type(
        screen.getByLabelText(/anything else about your hours/i),
        "Weekends when available",
      );
      await submitListing(user);

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
    await placeStand(user);
      await submitListing(user);

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
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

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
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await screen.findByText(/found it/i);
      expect(
        screen.queryByRole("button", { name: /that spot looks right/i }),
      ).not.toBeInTheDocument();

      // Filled in because this test is about the ADDRESS having no confirmation step. The
      // phone's own gate is asserted in the phone suite below, and leaving it blank here would
      // fail this test for an unrelated reason.
      await user.type(screen.getByLabelText(/your phone number/i), "2065550143");
      const publish = screen.getByRole("button", { name: /submit/i });
      expect(publish).toBeEnabled();
      await submitListing(user);

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
      await user.type(screen.getByLabelText(/your farm address/i), "nowhere at all");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

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
        await user.type(screen.getByLabelText(/your farm address/i), "somewhere");
        await user.click(screen.getByRole("button", { name: /^save$/i }));

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
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

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
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

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
            addressPublic: true,
            latitude: 47.4471,
            longitude: -122.4594,
          }}
        />,
      );

      expect(
        screen.getByRole("button", { name: /submit|save changes/i }),
      ).toBeEnabled();

      await user.click(screen.getByRole("button", { name: /^save$/i }));
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
      const addressField = screen.getByLabelText(/your farm address/i);
      await user.type(addressField, "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await screen.findByText(/found it/i);
      // Filled in so enabled/disabled below tracks the PIN alone. Without it the button stays
      // disabled for want of a phone and the test would pass for the wrong reason.
      await user.type(screen.getByLabelText(/your phone number/i), "2065550143");
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
            addressPublic: true,
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
      await user.click(screen.getByRole("button", { name: /^save$/i }));
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
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));
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
      await submitListing(user);

      const body = bodyFor(fetchMock, "/api/farmer/listing");
      expect(body.latitude).toBeCloseTo(47.4471, 6);
      expect(body.longitude).toBeCloseTo(-122.4594, 6);
    });

    it("does not look up a blank address", async () => {
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));

      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("the lookup button does NOT submit the form", async () => {
      // A bare button inside a form submits by default, which would try to publish the listing
      // on a lookup — with no pin, and a refusal the farmer did not ask for.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      const listingCalls = fetchMock.mock.calls.filter((entry) =>
        String((entry as [string, unknown])[0]).includes("/api/farmer/listing"),
      );
      expect(listingCalls).toHaveLength(0);
    });

    // ── The map is PRESENT from the moment the address is asked for ───────────────────────
    //
    // It used to render only once a lookup succeeded, so a found address made a large block
    // materialise mid-form and shove every field below it down the page — on a phone, the
    // farmer's thumb ends up somewhere other than where it was aimed.
    //
    // Rendering it always turns that into a swap inside a box whose size never changes: the
    // island is there from the start, faint and pinless, and the pin lights up in place.
    // These assert the property by ABSENCE OF CHANGE — the map is found before any lookup —
    // because "it appeared at the right time" is exactly the bug being fixed.

    // ── F-088: hiding the address without hiding the stand ────────────────────────────────
    //
    // A separate question from visitability, and offered separately. The stand stays on the
    // map with its pin; only the printed address and the directions link go away.

    it("sends the farmer's choice to hide their address", async () => {
      const user = userEvent.setup();
      const fetchMock = stubRoutes({
        status: "found",
        latitude: 47.4471,
        longitude: -122.4594,
      });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await screen.findByText(/found it/i);

      await user.click(screen.getByLabelText(/don.t show my address/i));
      await submitListing(user);

      const body = bodyFor(fetchMock, "/api/farmer/listing");
      // The address is still SENT — hiding is a display choice, and the database still
      // requires an address for a visitable stand.
      expect(body.publicAddress).toBe("12345 Vashon Highway SW");
      expect(body.addressPublic).toBe(false);
    });

    it("defaults to showing the address when the farmer says nothing", async () => {
      const user = userEvent.setup();
      const fetchMock = stubRoutes({
        status: "found",
        latitude: 47.4471,
        longitude: -122.4594,
      });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await screen.findByText(/found it/i);
      await submitListing(user);

      expect(bodyFor(fetchMock, "/api/farmer/listing").addressPublic).toBe(true);
    });

    it("does NOT republish a hidden address when an edit changes something else", async () => {
      // B-037's exact failure shape, on the newest column. `saveOnboardingListing` writes
      // `address_public` on every save, so an edit form that arrived with the box unticked
      // would quietly put the farmer's street address back on the public map — nothing shown,
      // nothing failing, and the one thing they asked to keep private undone.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...EDIT_DEFAULTS,
            visitability: "visitable",
            publicAddress: "12345 Vashon Highway SW",
            addressPublic: false,
            latitude: 47.4471,
            longitude: -122.4594,
          }}
        />,
      );

      // The box arrives ticked, reflecting what is stored.
      expect(screen.getByLabelText(/don.t show my address/i)).toBeChecked();

      // An edit to an unrelated field, then save.
      await user.type(screen.getByLabelText(/anything else about your hours/i), "Weekends");
      await submitListing(user);

      expect(bodyFor(fetchMock, "/api/farmer/listing-edit").addressPublic).toBe(false);
    });

    // ── The address block's own copy and controls (max 2026-08-07) ─────────────────────────
    //
    // Presentation, but presentation a farmer acts on: the label was a bare "Where is it?"
    // with the guidance hidden in a placeholder, the control that resolves it showed only a
    // map-pin glyph, and the privacy choice sat below the map — far enough from the address
    // it governs that it read as a separate topic.

    it("labels the address field and puts the guidance in its placeholder", () => {
      // The label states the FIELD; "Enter your farm address" is the instruction, and an
      // instruction belongs where a farmer is about to type rather than in a heading.
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      const field = screen.getByLabelText(/your farm address/i);
      expect(field).toHaveAttribute("placeholder", "Enter your farm address");
      // The old question is GONE, not merely supplemented — two ways to ask one thing is the
      // duplication this removed.
      expect(screen.queryByText(/where is it\?/i)).toBeNull();
    });

    it("names the lookup control SAVE in words, not as an icon", async () => {
      // A pin glyph asked the farmer to infer what it did. The control commits the address
      // they typed, so it says so — and it must still be a real button rather than an
      // `aria-label` on something shaped like an icon.
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      const save = screen.getByRole("button", { name: /^save$/i });
      // Anchored to the VISIBLE text, which is the whole change. An icon carrying
      // `aria-label="Save"` would satisfy a name-only query and show the farmer a glyph.
      expect(save).toHaveTextContent(/^save$/i);
      expect(save.querySelector("svg")).toBeNull();
      // Still a button, so it cannot publish the listing by default submission.
      expect(save).toHaveAttribute("type", "button");
    });

    it("prefixes the free-text helper placeholders with 'e.g.'", () => {
      // Every one of these was a bare example a farmer could read as a required format —
      // "12345 Vashon Highway SW" looks like the address it wants, not like a sample.
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      for (const label of [
        /anything else about your hours/i,
        /anything else you take/i,
        /what do you usually sell/i,
      ]) {
        const placeholder = screen.getByLabelText(label).getAttribute("placeholder") ?? "";
        expect(placeholder).toMatch(/^e\.g\. /);
      }
    });

    it("puts the address-privacy choice directly BELOW the address field, above the map", async () => {
      // Item 8. The choice governs the address, so it sits with it. It used to render after
      // the map, where the intervening block made it read as being about the map instead.
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      const field = screen.getByLabelText(/your farm address/i);
      const choice = screen.getByLabelText(/don.t show my address/i);
      const map = screen.getByRole("img", { name: /vashon and maury/i });

      // address → privacy choice → map, asserted as two orderings rather than one, so a
      // change that moved the choice past the map cannot pass on the first alone.
      expect(
        field.compareDocumentPosition(choice) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        choice.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("says the address shows BY DEFAULT, and still states the consequence of hiding it", async () => {
      // The wording max asked for: "by default" is what tells a farmer the current state is a
      // default they may change, rather than a fact about their listing they cannot.
      const user = userEvent.setup();
      stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      expect(screen.getByText(/by default/i)).toBeInTheDocument();

      // Ticking it still explains what remains visible — the pin stays, and saying so is what
      // stops this being mistaken for "hide my farm".
      await user.click(screen.getByLabelText(/don.t show my address/i));
      expect(screen.getByText(/still shows on the map/i)).toBeInTheDocument();
    });

    it("says 'in the live listing' rather than 'to customers'", () => {
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      expect(
        screen.getByLabelText(/don.t show my address in the live listing/i),
      ).toBeInTheDocument();
    });

    it("shows the island BEFORE any lookup, so nothing appears mid-form", async () => {
      const user = userEvent.setup();
      stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));

      // Present the instant the address question is on screen, with no address typed and no
      // lookup performed.
      expect(screen.getByRole("img", { name: /vashon and maury/i })).toBeInTheDocument();
    });

    it("keeps the SAME map element through a lookup rather than mounting a new one", async () => {
      // The anti-thrash guarantee, anchored to element IDENTITY. A map that unmounted and
      // remounted would satisfy a mere "is it present" check while still collapsing the box
      // and re-shoving the form — so this holds the node and asserts it is the same one.
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      const before = screen.getByRole("img", { name: /vashon and maury/i });

      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await screen.findByText(/found it/i);

      expect(screen.getByRole("img", { name: /vashon and maury/i })).toBe(before);
    });

    it("draws the found-location dot LARGE relative to the frame it sits in", async () => {
      // Item 3 — the dot was too small to read as "here is your stand" on a phone.
      //
      // Asserted as a FRACTION OF THE SETTLED FRAME, never as a raw `r`. The radius is scaled
      // by the frame width on purpose (see `ZOOM_FRACTION`), so a bare number would pass while
      // the dot appeared at any size at all, and would have to be rewritten every time the
      // zoom changed. The fraction is what a farmer's eye actually receives.
      stubReducedMotion();
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      const { container } = render(
        <ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />,
      );

      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await screen.findByText(/found it/i);

      const map = container.querySelector(".farmer-listing-map")!;
      const frameWidth = Number(map.getAttribute("viewBox")!.split(/\s+/)[2]);
      const radius = Number(container.querySelector(".farmer-listing-pin")!.getAttribute("r"));

      // Comfortably visible: at least a twentieth of the visible width across.
      expect(radius / frameWidth).toBeGreaterThan(0.025);
      // ...and not so large it covers the coastline it is meant to be checked against.
      expect(radius / frameWidth).toBeLessThan(0.12);
    });

    it("draws NO pin until an address resolves, and one afterwards", async () => {
      // The map being always-present must not imply a placed stand. A pin before a resolved
      // address would be a coordinate the farmer never chose.
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      const { container } = render(
        <ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />,
      );

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      expect(container.querySelector(".farmer-listing-pin")).toBeNull();

      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await screen.findByText(/found it/i);

      expect(container.querySelector(".farmer-listing-pin")).not.toBeNull();
    });

    /**
     * Make the component take its REDUCED-MOTION path.
     *
     * jsdom ships no `matchMedia` at all, so without this the hook falls through to the
     * animated branch and the frame is mid-travel whenever an assertion reads it. Stubbing it
     * to "reduce" is not a way of dodging the animation — it is the path a real farmer with
     * that preference gets, and it must land on exactly the same settled frame. The travel
     * itself is a visual enhancement on top of this.
     */
    function stubReducedMotion(): void {
      vi.stubGlobal(
        "matchMedia",
        (query: string) => ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      );
    }

    it("ZOOMS toward the stand on a resolved address, and back out when cleared", async () => {
      stubReducedMotion();
      // The whole island is the starting frame because the coarse check — "is this the right
      // end of the island?" — needs the coastline. On a resolved address the view travels to
      // the stand's neighbourhood, which is itself the confirmation.
      //
      // Anchored to the viewBox VALUE, not merely to the attribute existing: a zoom that
      // never moved would satisfy any check that only asked whether a viewBox was set.
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      const { container } = render(
        <ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />,
      );

      await user.click(screen.getByLabelText(/there is a stand to visit/i));
      const map = container.querySelector(".farmer-listing-map")!;
      const whole = map.getAttribute("viewBox");
      // The starting frame is the entire island, at its full drawing width.
      expect(whole).toBe(`0 0 ${ISLAND_VIEWBOX.width} ${ISLAND_VIEWBOX.height}`);

      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await screen.findByText(/found it/i);

      // The frame TRAVELS rather than snapping, so this waits for it to settle. The wait is
      // the animation being real: an implementation that jumped straight to the target would
      // satisfy it on the first poll, and one that never moved would time out here.
      const zoomed = map.getAttribute("viewBox")!;
      expect(zoomed).not.toBe(whole);
      // Narrower than the whole island — an actual zoom IN, not merely a different frame.
      const zoomedWidth = Number(zoomed.split(/\s+/)[2]);
      expect(zoomedWidth).toBeLessThan(ISLAND_VIEWBOX.width);
      // ...and still wide enough that the coastline stays in frame. A pin alone on a blank
      // field cannot be sanity-checked, which is the only reason the map exists.
      expect(zoomedWidth).toBeGreaterThan(ISLAND_VIEWBOX.width * 0.2);

      // Editing the address discards the coordinate (F-077), so the frame must return to the
      // whole island rather than staying zoomed on a point that no longer applies.
      await user.type(screen.getByLabelText(/your farm address/i), "9");
      await waitFor(() => {
        expect(map.getAttribute("viewBox")).toBe(whole);
      });
    });
    // ── The phone that completes onboarding, and its confirm step (max 2026-08-07) ───────────
    //
    // `JOIN <token>` is gone: it asked the farmer to hand-copy 64 hex characters into a text
    // message, and every slip failed silently. The farmer states the phone here instead, then
    // texts a bare START from it.
    //
    // **The confirm modal exists because a mistyped number is otherwise invisible.** The farmer
    // would text START from their real phone, match nothing, and wait — with nothing on screen
    // wrong. Reading the number back is the only check available before the message is sent.
    describe("the phone a farmer will text from", () => {
      it("asks for the phone, and names the number to text on the form", async () => {
        render(
          <ListingStep
            credential={{ kind: "invitation", token: TOKEN }}
            farmName="Test Farm"
            smsNumber="+12065550000"
          />,
        );

        expect(screen.getByLabelText(/your (mobile |cell )?phone/i)).toBeInTheDocument();
        // The instruction says the word and the number, so a farmer knows what is coming before
        // they submit rather than discovering it afterwards.
        //
        // Asserted against the note's own element rather than with a text matcher: `START` and
        // the number sit inside `<strong>`, so a whole-string matcher never sees them as one
        // text node.
        const note = screen.getByLabelText(/your phone number/i).parentElement!;
        expect(note).toHaveTextContent(/text START/i);
        expect(note).toHaveTextContent(/\+12065550000/);
      });

      it("does NOT ask for a phone on the EDIT door", () => {
        // An already-onboarded farmer has a verified handset. Asking again would invite them to
        // change it here, which this form has no power to do.
        render(
          <ListingStep
            credential={{ kind: "stand_link", token: TOKEN }}
            farmName="Test Farm"
            defaults={EDIT_DEFAULTS}
          />,
        );

        expect(screen.queryByLabelText(/your (mobile |cell )?phone/i)).toBeNull();
      });

      it("CONFIRMS the number before submitting, and sends nothing until confirmed", async () => {
        // The modal is a gate, not a notice. Submitting must not reach the network until the
        // farmer has read the number back.
        const user = userEvent.setup();
        const fetchMock = stubRoutes({
          status: "found",
          latitude: 47.4471,
          longitude: -122.4594,
        });
        render(
          <ListingStep
            credential={{ kind: "invitation", token: TOKEN }}
            farmName="Test Farm"
            smsNumber="+12065550000"
          />,
        );

        await user.click(screen.getByLabelText(/there is a stand to visit/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "2065550143");
        await user.click(screen.getByRole("button", { name: /submit/i }));

        // The modal is up, showing the number back, and NOTHING was posted.
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveTextContent(/206/);
        expect(
          fetchMock.mock.calls.filter((entry) =>
            String((entry as [string, unknown])[0]).includes("/api/farmer/listing"),
          ),
        ).toHaveLength(0);

        // Confirming posts it, with the number the farmer typed.
        await user.click(within(dialog).getByRole("button", { name: /yes|confirm|correct/i }));
        await waitFor(() => {
          expect(bodyFor(fetchMock, "/api/farmer/listing").phone).toBe("2065550143");
        });
      });

      it("lets the farmer go BACK from the modal to fix the number", async () => {
        // The recovery the modal exists for. Dismissing it must return them to the form with
        // what they typed intact, not discard the whole submission.
        const user = userEvent.setup();
        const fetchMock = stubRoutes({
          status: "found",
          latitude: 47.4471,
          longitude: -122.4594,
        });
        render(
          <ListingStep
            credential={{ kind: "invitation", token: TOKEN }}
            farmName="Test Farm"
            smsNumber="+12065550000"
          />,
        );

        await user.click(screen.getByLabelText(/there is a stand to visit/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "2065550143");
        await user.click(screen.getByRole("button", { name: /submit/i }));

        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: /back|change|fix/i }));

        // Back on the form, nothing posted, and the number still there to correct.
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByLabelText(/your (mobile |cell )?phone/i)).toHaveValue("2065550143");
        expect(
          fetchMock.mock.calls.filter((entry) =>
            String((entry as [string, unknown])[0]).includes("/api/farmer/listing"),
          ),
        ).toHaveLength(0);
      });

      it("REFUSES to submit without a phone on the invited door", async () => {
        // The phone is what ties the handset to the farm, so an invited farmer without one has
        // no way to finish. Better to block here than to publish a listing they cannot complete.
        const user = userEvent.setup();
        stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
        render(
          <ListingStep
            credential={{ kind: "invitation", token: TOKEN }}
            farmName="Test Farm"
            smsNumber="+12065550000"
          />,
        );

        await user.click(screen.getByLabelText(/there is a stand to visit/i));
        await placeStand(user);

        expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
      });

      it("shows the number to text AFTER saving, with the word START", async () => {
        // The hand-off. START is the only word that clears the carrier's own opt-out list, so it
        // is the only honest instruction for a phone whose history we cannot see.
        const user = userEvent.setup();
        stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
        render(
          <ListingStep
            credential={{ kind: "invitation", token: TOKEN }}
            farmName="Test Farm"
            smsNumber="+12065550000"
          />,
        );

        await user.click(screen.getByLabelText(/there is a stand to visit/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "2065550143");
        await user.click(screen.getByRole("button", { name: /submit/i }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: /yes|confirm|correct/i }));

        const saved = await screen.findByText(/text/i, { selector: ".farmer-listing-saved-next" });
        expect(saved).toHaveTextContent(/START/);
        expect(saved).toHaveTextContent(/\+12065550000/);
        // No 64-character token anywhere — that grammar is gone.
        expect(saved.textContent ?? "").not.toMatch(/[0-9a-f]{64}/i);
      });

      it("tells the farmer their number is not a phone, before any modal", async () => {
        // Caught on the form rather than by the server, so the farmer fixes it in place instead
        // of getting a refusal after a round trip.
        const user = userEvent.setup();
        stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
        render(
          <ListingStep
            credential={{ kind: "invitation", token: TOKEN }}
            farmName="Test Farm"
            smsNumber="+12065550000"
          />,
        );

        await user.click(screen.getByLabelText(/there is a stand to visit/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "555");

        expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
        expect(screen.queryByRole("dialog")).toBeNull();
      });
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
      await placeStand(user);
      await submitListing(user);

      const call = fetchMock.mock.calls.find(
        (entry) => !String((entry as [string, unknown])[0]).includes("address-lookup"),
      ) as [string, { body: string }];
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
      await placeStand(user);
      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      const call = fetchMock.mock.calls.find(
        (entry) => !String((entry as [string, unknown])[0]).includes("address-lookup"),
      ) as [string, { body: string }];
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

      await placeStand(user);
      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      const call = fetchMock.mock.calls.find(
        (entry) => !String((entry as [string, unknown])[0]).includes("address-lookup"),
      ) as [string, { body: string }];
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
      addressPublic: true,
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
      expect(screen.getByLabelText(/your farm address/i)).toHaveValue("12345 Vashon Highway SW");
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
