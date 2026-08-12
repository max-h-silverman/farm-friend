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

/*
  The three endpoints that SAVE a listing, matched positively.

  These lookups used to exclude `address-lookup` and take whatever was left, which held only
  while the form made exactly two kinds of request. The SMS agreement POST to
  `/api/farmer/onboarding` broke that: it is neither a lookup nor a listing save, so an
  exclusion filter returned IT and every assertion read the wrong body — reporting the form as
  posting nothing rather than as posting to a third place.

  Naming what is wanted, rather than what is not, is what keeps the next endpoint from doing the
  same. `listing-edit` is matched by the same pattern as `listing`, deliberately: both are
  listing saves and every caller here wants whichever one its door uses.
*/
const LISTING_ENDPOINT_RE = /\/api\/farmer\/(listing|listing-edit|grandfathered-listing)$/;

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
    // The SMS agreement stamp. Answered OK so ticking the box succeeds — an unanswered POST
    // shows the farmer an error and blocks submission, failing every test downstream for a
    // reason unrelated to what it asserts.
    if (String(url).includes("/api/farmer/onboarding")) {
      return { ok: true, status: 200, json: async () => ({ status: "agreed" }) };
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
  await user.click(screen.getByRole("button", { name: /^(save|find on map)$/i }));
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
/**
 * Bring a field into view on a wizard door, wherever its step happens to be.
 *
 * Every field stays MOUNTED behind a `hidden` fieldset, so it is always in the document —
 * which is what makes `getByLabelText` find it and `getByRole` refuse it. A test asserting
 * what the form OFFERS needs it visible, so this steps forward until it is.
 *
 * Written as "advance until visible" rather than "go to step N" deliberately: reordering the
 * steps must not silently strand these tests on the wrong screen, and a field that never
 * becomes visible fails loudly here instead of as a confusing assertion further down.
 */
async function revealField(
  user: ReturnType<typeof userEvent.setup>,
  label: RegExp | string,
): Promise<HTMLElement> {
  for (;;) {
    const field = screen.getByLabelText(label);
    // The enclosing step, or null on the flat door. `hidden` on that fieldset is exactly what
    // hides the field — jsdom computes no layout, so this is the honest check rather than
    // `checkVisibility`, which this jsdom does not implement at all.
    if (field.closest("fieldset[hidden]") === null) return field;
    const next = screen.queryByRole("button", { name: /next/i });
    if (next === null) {
      throw new Error(`no step of this form ever shows ${String(label)}`);
    }
    await user.click(next);
  }
}

/**
 * Walk a wizard to its last step, so a test can reach Submit.
 *
 * Clicks Next until it runs out, rather than a fixed count: a step added later must not
 * silently strand every test that submits. Returns immediately on a door that does not step,
 * which is what lets the shared `submitListing` stay one helper for all three doors.
 */
async function stepToEnd(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  for (;;) {
    const next = screen.queryByRole("button", { name: /next/i });
    if (next === null) return;
    await user.click(next);
  }
}

/**
 * The Submit button, on whichever step shows it.
 *
 * A wizard door reveals Submit only on its last step (F-090) — a farmer must not be able to
 * publish a listing they have not finished describing, because the writer replaces the WHOLE
 * listing and the fields they never reached would be written empty. Tests that assert
 * something ABOUT the button (that it is visible, that a gate redirects it) need it on screen,
 * and should not have to know how many steps there currently are.
 */
async function submitButton(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await stepToEnd(user);
  return screen.getByRole("button", { name: /submit|save changes/i });
}

async function submitListing(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  // F-090 — a WIZARD door shows Submit only on its last step, so reach it first. Done here
  // rather than in every caller: a test about what the form POSTS should not have to know
  // how many steps the form currently has. `stepToEnd` returns immediately on the flat door.
  await stepToEnd(user);
  const phoneField = screen.queryByLabelText(/your phone number/i);
  if (phoneField !== null && (phoneField as HTMLInputElement).value === "") {
    await user.type(phoneField, "2065550143");
  }
  // The invited door also gates Submit on the SMS agreement (max 2026-08-07). Ticking it here
  // keeps every test that merely wants to reach the network from having to know that — the gate
  // itself is asserted on its own, in "REFUSES to submit until the agreement is ticked".
  const agreeBox = screen.queryByLabelText(/I agree to receive texts/i);
  if (agreeBox !== null && !(agreeBox as HTMLInputElement).checked) {
    await user.click(agreeBox);
    await waitFor(() => {
      expect(agreeBox).toBeChecked();
    });
  }
  await user.click(screen.getByRole("button", { name: /submit|save changes/i }));
  const dialog = screen.queryByRole("dialog");
  if (dialog !== null) {
    await user.click(
      within(dialog).getByRole("button", { name: /yes, that is my number/i }),
    );
  }
}

/*
  The two NAME fields, selected by id rather than by label.

  Both labels read "What is your farm called?" (max 2026-08-07), so label text can no longer
  tell them apart — `getByLabelText` matches two elements on the edit door and throws. The ids
  are what actually distinguish them: `farm-name` is the farm's own name, offered only when
  editing, and `stand-name` is the stand's.
*/
const standNameField = (): HTMLInputElement =>
  document.getElementById("stand-name") as HTMLInputElement;
const farmNameField = (): HTMLInputElement | null =>
  document.getElementById("farm-name") as HTMLInputElement | null;

/** A saved listing, as an already-onboarded farmer's editor is prefilled from. */
const EDIT_DEFAULTS = {
  standName: "Existing Stand",
  visitability: "contact_only" as const,
  publicAddress: null,
  addressPublic: true,
  pricesPublic: false,
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
    (entry) => LISTING_ENDPOINT_RE.test(String((entry as [string, unknown])[0])),
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
    expect(screen.getByText(/do you have a farm stand people can visit/i)).toBeInTheDocument();

    // ...and the address comes FIRST in the document, which is the ordering claim itself.
    const address = screen.getByLabelText(/your farm address/i);
    const visit = screen.getByText(/do you have a farm stand people can visit/i);
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

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));

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

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
    await submitListing(user);

    // Not `calls[0]` — that is the address lookup since F-088. Found by endpoint instead.
    const call = fetchMock.mock.calls.find(
      (entry) => LISTING_ENDPOINT_RE.test(String((entry as [string, unknown])[0])),
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

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
    // F-090 — added one row at a time, where this used to be a comma-separated box. The
    // invariant is unchanged and is what this test still guards: three near-identical words
    // stay three items, because folding them would be a produce taxonomy.
    for (const item of ["tomato", "tomatoes", "love apple"]) {
      await user.type(await revealField(user, /what do you usually sell/i), item);
      await user.click(screen.getByRole("button", { name: /add item/i }));
    }
    await submitListing(user);

    expect(posted(fetchMock).items).toEqual([
      { name: "tomato", price: null },
      { name: "tomatoes", price: null },
      { name: "love apple", price: null },
    ]);
  });

  it("drops empty entries from a list rather than sending blanks", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
    /*
      F-090 — the blank is refused at ENTRY now rather than filtered at submit, which is the
      better place for it: the farmer sees immediately that nothing was added.

      The invariant is the same one and still worth guarding. `stand_items` has a not-blank
      CHECK, so a blank reaching the writer is a failed submission the farmer cannot act on;
      here they simply see no row appear.
    */
    const box = await revealField(user, /what do you usually sell/i);
    await user.type(box, "eggs");
    await user.click(screen.getByRole("button", { name: /add item/i }));
    // A stray space, and then nothing at all — neither may become an item.
    await user.type(box, "   ");
    await user.click(screen.getByRole("button", { name: /add item/i }));
    await user.type(box, "rhubarb");
    await user.click(screen.getByRole("button", { name: /add item/i }));
    await submitListing(user);

    expect(posted(fetchMock).items).toEqual([
      { name: "eggs", price: null },
      { name: "rhubarb", price: null },
    ]);
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
      await submitListing(user);

      const next = await screen.findByRole("status");
      // VIGA is the onboarding word, not an overloaded carrier-default command. Telnyx owns
      // its opt-in receipt; Farm Friend matches the same inbound text to this pending form.
      expect(next.textContent).toContain("VIGA");
      expect(next.textContent).toContain("206-555-0000");
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

    expect(standNameField()).toHaveValue("Test Farm");
  });

  it("tells the farmer their stand is live, and how to change it", async () => {
    // Publish-on-submit (max, 2026-08-05). The farmer must know the listing is public now
    // rather than pending, or they will wait for a review that never comes.
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
    await submitListing(user);

    expect(await screen.findByRole("status")).toHaveTextContent(/on the map/i);
    // The farmer's own answer is still on screen, not swapped for a receipt.
    expect(screen.getByText("Test Farm")).toBeInTheDocument();
    // NO WAY BACK IN from here (max, 2026-08-08). The "Change something" button was removed:
    // the farmer's next action is the one text that turns their texting on, and a second
    // control competing with it costs completions. Editing has a real home — the stand page,
    // reached by the link they are about to be sent — so this screen is not a second door
    // onto it.
    expect(screen.queryByRole("button", { name: /change something/i })).not.toBeInTheDocument();
  });

  it("teaches the farmer how to run their stand by text (F-093)", async () => {
    // The gap: STAND and SETTINGS appeared in no farmer-facing copy anywhere, and LINK only as
    // an aside in one SMS. A farmer finished onboarding knowing one word — START — and the
    // rest of the interface was undiscoverable except by guessing.
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
    await submitListing(user);

    const saved = await screen.findByRole("status");
    // Each keyword is its own `<dt>`, so the assertion is made against that element rather
    // than against the card's concatenated text — where `STAND` would also be satisfied by the
    // "Stand" summary label, and a word boundary cannot help because adjacent elements' text
    // runs together with no separator.
    const terms = Array.from(
      saved.querySelectorAll(".farmer-listing-saved-keywords dt"),
      (node) => node.textContent?.trim(),
    );
    expect(terms).toEqual(
      expect.arrayContaining(["LINK", "SETTINGS", "STAND"]) as unknown as string[],
    );
    // The primary interface is not a keyword at all, and a farmer who learns three words and
    // not this one has learned the accessories and missed the product.
    expect(saved).toHaveTextContent(/text what you have/i);
  });

  it("names the next step rather than leaving the farmer to find it", async () => {
    // The SIGNUP card was always below the fold; the collapse merely scrolled it into view
    // unannounced. Saving must SAY that a text is next, so the hand-off is expected.
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
    await submitListing(user);

    // Anchored to the hand-off sentence itself, not the word "text" — "texting SETTINGS"
    // appears in the non-onboarding copy and would satisfy a looser match forever.
    expect(await screen.findByRole("status")).toHaveTextContent(/last step/i);
  });

  it("leaves the saved screen with ONE errand on it", async () => {
    // Replaces "reopens the form with the farmer's answers intact", which exercised the
    // "Change something" button max removed on 2026-08-08. The property that matters now is
    // the opposite one: nothing on this screen competes with texting START.
    const user = userEvent.setup();
    stubFetch({ ok: true });
    render(
      <ListingStep
        credential={{ kind: "invitation", token: TOKEN }}
        farmName="Test Farm"
        smsNumber="+12065550000"
      />,
    );

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
    await submitListing(user);

    const saved = await screen.findByRole("status");
    // The one thing to do is a link that composes the text. Asserted as the ONLY button on
    // the screen, so a control reappearing beside it fails here.
    expect(within(saved).queryAllByRole("button")).toHaveLength(0);
    expect(within(saved).getByRole("link", { name: /206-555-0000/ })).toBeVisible();
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
      expect(farmNameField()!).toHaveValue(
        "Two Sisters Farm",
      );
      expect(standNameField()).toHaveValue("The Red Shed");
    });

    it("does not ask an onboarding farmer to name their farm twice", () => {
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      expect(farmNameField()).not.toBeInTheDocument();
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

      const farmField = farmNameField()!;
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

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

    await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
    await submitListing(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer available/i);
  });

  // ── F-069: payments as a closed set ───────────────────────────────────────────────────
  describe("F-069 payment methods", () => {
    it("offers the closed set as CHECKBOXES rather than a text box", async () => {
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      for (const method of ["Cash", "Check", "Venmo", "PayPal", "Zelle"]) {
        expect(screen.getByLabelText(method)).toBeInTheDocument();
      }
    });

    // Inverted deliberately (max, 2026-08-10). This asserted the OLD rule — VIGA Bucks hidden
    // until VIGA marked the farm eligible — which is exactly the behaviour max reported as the
    // option being missing from onboarding. Eligibility lives on a stand row that does not
    // exist during onboarding, so "ineligible" described every farmer using this form.
    //
    // Acceptance is now the farmer's own claim and publishes on their word; VIGA's eligibility
    // flag survives as its own separate record for the admin surfaces.
    it("lists VIGA Bucks with the other payment choices while preserving its separate saved fact", async () => {
      const user = userEvent.setup();
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      // The toggle lives on the payment step, so walk there exactly as the sibling tests do.
      await revealField(user, "Cash");

      const payments = screen.getByRole("group", { name: "How can people pay?" });
      expect(within(payments).getByRole("checkbox", { name: "VIGA Bucks" })).toBeInTheDocument();
    });

    it("sends the checked methods, canonically spelled", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
      await user.click(await revealField(user, "Cash"));
      await user.click(screen.getByRole("checkbox", { name: "Venmo" }));
      await submitListing(user);

      expect(posted(fetchMock).paymentMethods).toEqual(["Cash", "Venmo"]);
    });

    it("unchecking a method removes it", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
      await user.click(await revealField(user, "Cash"));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
      await user.click(await revealField(user, "Cash"));
      await user.type(screen.getByLabelText(/anything else you accept as payment/i), "trade for eggs");
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
    await placeStand(user);
      // Ticked out of order, to prove the order sent is the weekday order and not the click
      // order — the column is a set, and a reader showing "Sat, Wed" would read as wrong.
      await user.click(await revealField(user, "Sat"));
      await user.click(screen.getByRole("checkbox", { name: "Wed" }));
      await submitListing(user);

      expect(posted(fetchMock).openDays).toEqual([3, 6]);
    });

    it("asks which days only when restocking is on certain days", async () => {
      const user = userEvent.setup();
      stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
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
        // The agreement stamp — see `stubFetch` for why it must be answered.
        if (String(url).includes("/api/farmer/onboarding")) {
          return { ok: true, status: 200, json: async () => ({ status: "agreed" }) };
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
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
      await user.click(screen.getByLabelText(/I agree to receive texts/i));
      const publish = await submitButton(user);
      await waitFor(() => {
        expect(publish).toBeEnabled();
      });
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
      await user.type(screen.getByLabelText(/your farm address/i), "nowhere at all");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await screen.findByRole("status");
      expect(
        await submitButton(user),
      ).toBeEnabled();
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

        await user.click(screen.getByLabelText(/yes . there is a stand/i));
        await user.type(screen.getByLabelText(/your farm address/i), "somewhere");
        await user.click(screen.getByRole("button", { name: /^save$/i }));

        const note = await screen.findByRole("status");
        expect(note).toHaveTextContent(/check the address/i);
        // The retired copy offered "tap the map to show where your stand is", which now
        // describes an interaction that does not exist. Asserted absent, or this passes on
        // the old sentence forever.
        expect(note).not.toHaveTextContent(/tap the map/i);
        expect(
          await submitButton(user),
        ).toBeEnabled();
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      const note = await screen.findByRole("status");
      expect(note).toHaveTextContent(/unavailable/i);
      expect(note).toHaveTextContent(/VIGA/);
      expect(note).not.toHaveTextContent(/check the address/i);
      expect(note).not.toHaveTextContent(/tap the map/i);
      expect(
        await submitButton(user),
      ).toBeEnabled();
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      expect(await screen.findByRole("status")).toHaveTextContent(/check the address|correct/i);
      expect(
        await submitButton(user),
      ).toBeEnabled();
    });

    it("a THROWN lookup leaves an EDITED address unpublishable, on an edit form", async () => {
      // The network-failure twin of the test below, and the edit door's version of it: a
      // returning farmer changes their address, the network is down, and the stand must not
      // publish on the coordinate the OLD address resolved to.
      //
      // It used to press Save on the UNTOUCHED form to reach the same refusal, and to credit
      // the catch branch's own `setPin(null)` for the result. Neither survives max's 2026-08-08
      // call: Save returns a farmer to the missing farm detail, so the only route to a lookup
      // is through an edit — and an edit has already cleared the pin by the time the
      // failure lands. That clearing is now `changeAddress`'s alone, and the branch's
      // defensive copy of it is gone rather than left as a second mechanism for one fact.
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
            pricesPublic: false,
            latitude: 47.4471,
            longitude: -122.4594,
          }}
        />,
      );

      expect(
        screen.getByRole("button", { name: /submit|save changes/i }),
      ).toBeEnabled();

      await user.type(screen.getByLabelText(/your farm address/i), " Suite 2");
      await user.click(screen.getByRole("button", { name: /^find on map$/i }));
      await screen.findByRole("status");

      expect(
        screen.getByRole("button", { name: /submit|save changes/i }),
      ).toBeEnabled();
    });

    it("EDITING THE ADDRESS CLEARS THE PIN, so A's coordinate cannot publish under B", async () => {
      // The sharp edge F-077 creates. With no tap and no confirm gate, a farmer who looks up
      // address A and then edits the text to address B would otherwise publish A's coordinate
      // labelled as B — a customer sent to the wrong place with nothing to show anything was
      // wrong. This bug did not exist under F-069, because a tap re-confirmed.
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
      const addressField = screen.getByLabelText(/your farm address/i);
      await user.type(addressField, "12345 Vashon Highway SW");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await screen.findByText(/found it/i);
      // Filled in so the returned completion guidance tracks the PIN alone. Without it the
      // missing phone would take priority and the test would pass for the wrong reason.
      await user.type(screen.getByLabelText(/your phone number/i), "2065550143");
      await user.click(screen.getByLabelText(/I agree to receive texts/i));
      await submitButton(user);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /submit|save changes/i })).toBeEnabled();
      });

      // The farmer changes their mind about the address.
      await user.type(addressField, " Unit B");

      expect(
        await submitButton(user),
      ).toBeEnabled();
      expect(screen.queryByText(/found it/i)).not.toBeInTheDocument();
    });

    it("a FAILED lookup leaves an EDITED address unpublishable, on an edit form", async () => {
      // The geocoder-refusal twin of the test above, on the edit door: the farmer corrects
      // their address, the geocoder cannot find the correction, and the stand must not publish
      // on the coordinate the previous address resolved to.
      //
      // This test used to be the proof that the refusal branch cleared the pin ITSELF, reached
      // by pressing Save on an untouched form. That press is now impossible and that clearing
      // is now redundant — see the sibling above for the whole of it.
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
            pricesPublic: false,
            latitude: 47.4471,
            longitude: -122.4594,
          }}
        />,
      );

      // Arrives publishable, on the stored coordinate.
      expect(
        screen.getByRole("button", { name: /submit|save changes/i }),
      ).toBeEnabled();

      // The farmer CORRECTS the address, and the lookup of the correction fails.
      await user.type(screen.getByLabelText(/your farm address/i), " Suite 2");
      await user.click(screen.getByRole("button", { name: /^find on map$/i }));
      await screen.findByRole("status");

      expect(
        screen.getByRole("button", { name: /submit|save changes/i }),
      ).toBeEnabled();
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));

      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not look up an address that is only whitespace", async () => {
      // The guard is on the TRIMMED value, so spaces are as blank as nothing typed. Without
      // this, a stray space would light the button up and spend a geocoder call on it.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
      await user.type(screen.getByLabelText(/your farm address/i), "   ");

      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("turns Save OFF once the typed address has been saved, and back ON when it is edited", async () => {
      // Save means "there is something here that is not saved yet". After a successful lookup
      // the text on screen IS the saved address — the coordinate beside it was derived from
      // exactly these characters — so pressing it again would re-spend a geocoder call to
      // arrive at the state already on screen.
      //
      // It re-enables on the first keystroke because that keystroke is what makes the two
      // disagree: `changeAddress` discards the coordinate, so from that moment the field holds
      // an address nothing has resolved.
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
      const field = screen.getByLabelText(/your farm address/i);
      await user.type(field, "12345 Vashon Highway SW");

      // Typed and unsaved: the one state the button is for.
      expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();

      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await screen.findByText(/found it/i);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
      });

      // One more character, and there is again something unsaved to save.
      await user.type(field, "X");
      expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
    });

    it("arrives with Find on map OFF on an edit form, whose address is already saved", async () => {
      // Same rule, reached from the other door. A stand already on the map holds a coordinate
      // that belongs to the address printed beside it, so the form opens in the saved state —
      // nothing to save until the farmer changes something. max confirmed this trade
      // (2026-08-08): a returning farmer cannot re-run the lookup on an address they never
      // touched, which is the price of the button meaning one thing.
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...EDIT_DEFAULTS,
            visitability: "visitable" as const,
            publicAddress: "12345 Vashon Highway SW",
            addressPublic: true,
            pricesPublic: false,
            latitude: 47.4471,
            longitude: -122.4594,
          }}
        />,
      );

      expect(screen.getByRole("button", { name: /^find on map$/i })).toBeDisabled();
    });

    it("re-enables Save when a lookup FAILS, so the farmer can try again", async () => {
      // A refusal leaves the address unsaved, and the farmer's next move is to correct it and
      // press Save again. Keying the button off the coordinate rather than off "a lookup ran"
      // is what makes this fall out: the refusal branch clears the pin, so the button is live
      // again the moment the failure lands — with the text unchanged.
      const user = userEvent.setup();
      stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
      await user.type(screen.getByLabelText(/your farm address/i), "nowhere at all");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await screen.findByRole("status");
      expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
    });

    it("styles Save as the form's primary action, with its own disabled look", async () => {
      // It carries the same class the submit button's rules key off, so the two committing
      // controls are one style rather than two that drift apart. Asserted through the
      // ELEMENT's own classes rather than computed colour: jsdom does not load the stylesheet,
      // so a colour assertion here would pass against no styles at all.
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
      const save = screen.getByRole("button", { name: /^save$/i });
      expect(save).toHaveClass("farmer-listing-primary");

      // And the disabled state is addressable as a state rather than as a second class the
      // component has to remember to add and remove.
      expect(save).toBeDisabled();
      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Highway SW");
      expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
    });

    it("the lookup button does NOT submit the form", async () => {
      // A bare button inside a form submits by default, which would try to publish the listing
      // on a lookup — with no pin, and a refusal the farmer did not ask for.
      const user = userEvent.setup();
      const fetchMock = stubRoutes({ status: "no_result" });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
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
            pricesPublic: false,
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

    it("puts the SMS agreement inside the form, directly above Submit", async () => {
      const user = userEvent.setup();
      // max 2026-08-07. It was a separate card BELOW the whole form, so the page read as two
      // steps and a farmer could submit their listing having never seen the disclosures.
      //
      // Order is the claim: the tick sits after the last field and before the button, which is
      // where a farmer reads it as a condition of submitting rather than as a separate errand.
      render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
          smsNumber="+12065550000"
        />,
      );

      const agree = screen.getByLabelText(/I agree to receive texts/i);
      const submit = await submitButton(user);
      const phone = screen.getByLabelText(/your phone number/i);

      expect(
        phone.compareDocumentPosition(agree) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        agree.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // The four registered disclosures travel with it — they are what the carrier receipt
      // claims the farmer was shown, so they cannot be dropped in the move.
      const block = agree.closest(".farmer-onboarding-agreement")!;
      expect(block).toHaveTextContent(/message frequency varies/i);
      expect(block).toHaveTextContent(/rates may apply/i);
      expect(block).toHaveTextContent(/STOP/);
      expect(block).toHaveTextContent(/HELP/);
    });

    it("REFUSES to submit until the agreement is ticked", async () => {
      // The gate. Without the tick `agreed_to_sms_at` is null, and the redemption authorizes
      // nobody — the farmer would publish a listing and then find that texting START enrolled
      // them for messages while setting up no farm, with nothing saying why.
      const user = userEvent.setup();
      stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
      render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
          smsNumber="+12065550000"
        />,
      );

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
      await placeStand(user);
      await user.type(screen.getByLabelText(/your phone number/i), "2065550143");

      const submit = await submitButton(user);
      expect(submit).toBeEnabled();
      await user.click(submit);
      expect(screen.getByRole("alert")).toHaveTextContent(
        /agree to receive texts from viga farm friend/i,
      );

      await user.click(screen.getByLabelText(/I agree to receive texts/i));
      await submitButton(user);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /submit|save changes/i })).toBeEnabled();
      });
    });

    it("STAMPS the agreement server-side when ticked, before any listing is posted", async () => {
      // The tick is not consent and never was, but it IS provenance: it records that these
      // disclosures were shown and accepted on this invitation. That stamp is what the carrier
      // registration claims we collect, and what gates authorization at redemption.
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

      await user.click(screen.getByLabelText(/I agree to receive texts/i));

      await waitFor(() => {
        const call = fetchMock.mock.calls.find((entry) =>
          String((entry as [string, unknown])[0]).includes("/api/farmer/onboarding"),
        ) as [string, { body: string }] | undefined;
        expect(call).toBeDefined();
        expect(JSON.parse(call![1].body).token).toBe(TOKEN);
      });
    });

    it("does NOT ask for the agreement on the EDIT door", () => {
      // An already-onboarded farmer agreed once, and that stamp is provenance of what they were
      // shown then. Asking again on every edit would collect a second answer to a settled
      // question and invite re-stamping it.
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={EDIT_DEFAULTS}
        />,
      );

      expect(screen.queryByLabelText(/I agree to receive texts/i)).toBeNull();
    });

    it("gives EVERY text field a type the form's own styling rule covers", () => {
      // The defect this pins: the rule was `input[type="text"]` alone, so the `type="tel"` phone
      // field and the paragraph `<textarea>` matched NOTHING and rendered at the browser default
      // — a hairline box at a different height, mid-form, where every sibling was 48px with a
      // 10px radius. Nothing failed; two fields just looked like a different page.
      //
      // Asserted from the RENDERED FIELDS rather than by grepping the stylesheet for a selector.
      // A regex over CSS proves the rule is written, not that it matches anything — and matching
      // nothing is precisely what went wrong. This enumerates what the form actually renders and
      // requires each one to fall inside the covered set, so a future field with an uncovered
      // type fails here rather than looking wrong in a browser.
      const { container } = render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
          smsNumber="+12065550000"
        />,
      );

      // The types `.farmer-listing` styles as a text-entry box. Checkboxes and radios are
      // deliberately absent — they have their own rules and must not get a 48px text box.
      const styled = new Set(["text", "tel", "email"]);
      const textFields = [
        ...container.querySelectorAll<HTMLInputElement>("input"),
      ].filter((field) => !["checkbox", "radio"].includes(field.type));

      // Guard the guard: if this found nothing, the assertion below would pass vacuously.
      expect(textFields.length).toBeGreaterThan(3);
      for (const field of textFields) {
        // `getAttribute`, not `.type` — a missing attribute reads as "text" through the DOM
        // property, which would hide a bare `<input>` the CSS covers only via `:not([type])`.
        const declared = field.getAttribute("type");
        expect(
          declared === null || styled.has(declared),
          `${field.id || field.name} has type="${declared}", which the styling rule misses`,
        ).toBe(true);
      }

      // And the paragraph box, which is a textarea rather than an input.
      expect(container.querySelector("textarea")).not.toBeNull();
    });

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

    it("names the onboarding address save in words, not as an icon", async () => {
      // A pin glyph asked the farmer to infer what it did, so the control says what it does
      // and must stay a real button rather than an `aria-label` on something icon-shaped.
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      const save = screen.getByRole("button", { name: /^save$/i });
      // Anchored to the VISIBLE text, which is the whole change. An icon carrying
      // `aria-label` would satisfy a name-only query and show the farmer a glyph.
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
        /anything else you accept as payment/i,
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));

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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
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

      await user.click(screen.getByLabelText(/yes . there is a stand/i));
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
        expect(note).toHaveTextContent(/text VIGA/i);
        // Formatted for READING, with the country code dropped: `206-555-0000`, not
        // `+12065550000`. E.164 is a dialing format and belongs in the `sms:` href, not on
        // screen where a farmer is checking it against their keypad.
        expect(note).toHaveTextContent(/206-555-0000/);
        expect(note.textContent ?? "").not.toContain("+1");
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

        await user.click(screen.getByLabelText(/yes . there is a stand/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "2065550143");
        // The agreement gates Submit; its own gate is asserted separately.
        await user.click(screen.getByLabelText(/I agree to receive texts/i));
        await submitButton(user);
        await waitFor(() => {
          expect(screen.getByRole("button", { name: /submit|save changes/i })).toBeEnabled();
        });
        await user.click(await submitButton(user));

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

        await user.click(screen.getByLabelText(/yes . there is a stand/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "2065550143");
        // The agreement gates Submit; its own gate is asserted separately.
        await user.click(screen.getByLabelText(/I agree to receive texts/i));
        await submitButton(user);
        await waitFor(() => {
          expect(screen.getByRole("button", { name: /submit|save changes/i })).toBeEnabled();
        });
        await user.click(await submitButton(user));

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

      it("CONFIRMS the number and nothing else — the instructions moved to the landing screen", async () => {
        // max's call (2026-08-08). The modal's one job is reading the number back; a mistyped
        // phone is the only error on this form with no feedback anywhere. Telling the farmer
        // what to text WHILE asking them to check digits gives them two things to do at the
        // moment they can only act on one, and the instruction is repeated on the screen they
        // land on straight afterwards.
        const user = userEvent.setup();
        stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
        render(
          <ListingStep
            credential={{ kind: "invitation", token: TOKEN }}
            farmName="Test Farm"
            smsNumber="+12065550000"
          />,
        );

        await user.click(screen.getByLabelText(/yes . there is a stand/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "2065550143");
        await user.click(screen.getByLabelText(/I agree to receive texts/i));
        await user.click(await submitButton(user));

        const dialog = await screen.findByRole("dialog");
        // The number itself is still read back — that is the whole reason this exists.
        expect(dialog).toHaveTextContent("2065550143");
        // But the errand is not stated here.
        expect(dialog).not.toHaveTextContent(/START/i);
        expect(dialog).not.toHaveTextContent(/206-555-0000/);
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

        await user.click(screen.getByLabelText(/yes . there is a stand/i));
        await placeStand(user);

        const submit = await submitButton(user);
        expect(submit).toBeEnabled();
        await user.click(submit);
        expect(screen.getByRole("alert")).toHaveTextContent(/enter a valid phone number/i);
      });

      it("shows the number to text AFTER saving, with the word VIGA", async () => {
        // The hand-off. VIGA is the farmer-facing word Telnyx recognizes as the onboarding opt-in.
        const user = userEvent.setup();
        stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
        render(
          <ListingStep
            credential={{ kind: "invitation", token: TOKEN }}
            farmName="Test Farm"
            smsNumber="+12065550000"
          />,
        );

        await user.click(screen.getByLabelText(/yes . there is a stand/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "2065550143");
        // The agreement gates Submit; its own gate is asserted separately.
        await user.click(screen.getByLabelText(/I agree to receive texts/i));
        await submitButton(user);
        await waitFor(() => {
          expect(screen.getByRole("button", { name: /submit|save changes/i })).toBeEnabled();
        });
        await user.click(await submitButton(user));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: /yes|confirm|correct/i }));

        // The word and the number live in the REMINDER, directly under the headline rather
        // than below the summary — and since max 2026-08-08 that reminder is a BLOCK holding
        // both the instruction and the reason it must be that handset, so the whole block is
        // queried rather than a single paragraph inside it.
        const saved = await screen.findByRole("status");
        const reminder = saved.querySelector(".farmer-listing-saved-reminder");
        expect(reminder).not.toBeNull();
        // Scoped to the reminder, not the whole card: the keyword reference below it also
        // contains the word "text", and asserting against the card would let the instruction
        // disappear entirely while this still passed.
        expect(reminder).toHaveTextContent(/VIGA/);
        // Formatted for READING: `206-555-0000`, never the E.164 the `sms:` href carries.
        expect(reminder).toHaveTextContent(/206-555-0000/);
        expect(reminder?.textContent ?? "").not.toContain("+1");
        // No 64-character token anywhere — that grammar is gone.
        expect(saved.textContent ?? "").not.toMatch(/[0-9a-f]{64}/i);
        // The tap-to-text link survives the move: on a phone this composes the message.
        expect(reminder?.querySelector("a")?.getAttribute("href") ?? "").toContain("+12065550000");
      });

      it("lands on a confirmation that leads with LIVE and carries the VIGA reminder", async () => {
        // max's call (2026-08-08): the modal just confirms, and this screen is where the farmer
        // is told what is left. It has to say both halves — the good news and the errand — or a
        // farmer who reads "live on the map" stops there and never texts, which is the one step
        // that turns on messaging for them.
        const user = userEvent.setup();
        stubRoutes({ status: "found", latitude: 47.4471, longitude: -122.4594 });
        render(
          <ListingStep
            credential={{ kind: "invitation", token: TOKEN }}
            farmName="Test Farm"
            smsNumber="+12065550000"
          />,
        );

        await user.click(screen.getByLabelText(/yes . there is a stand/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "2065550143");
        await user.click(screen.getByLabelText(/I agree to receive texts/i));
        await user.click(await submitButton(user));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: /yes|confirm|correct/i }));

        const banner = await screen.findByRole("status");
        expect(banner).toHaveTextContent(/live on the map/i);
        // The errand, on the same screen — with the word and the number. Anchored to the
        // reminder BLOCK and to "last step" rather than to a phrase: the exact wording is copy
        // and has already changed once, but a screen that stops naming a remaining step is the
        // regression this guards.
        const reminder = banner.querySelector<HTMLElement>(".farmer-listing-saved-reminder");
        expect(reminder).toHaveTextContent(/last step/i);
        expect(reminder).toHaveTextContent(/VIGA/);
        expect(reminder).toHaveTextContent(/206-555-0000/);
        // Both halves of the one errand live together now (max 2026-08-08) — the instruction
        // and why it must be that handset — rather than split across the summary list.
        expect(reminder).toHaveTextContent(/phone you will send stand updates from/i);
        if (reminder === null) throw new Error("missing onboarding reminder");
        expect(within(reminder).getByRole("separator")).toBeInTheDocument();
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

        await user.click(screen.getByLabelText(/yes . there is a stand/i));
        await placeStand(user);
        await user.type(screen.getByLabelText(/your (mobile |cell )?phone/i), "555");

        const submit = await submitButton(user);
        expect(submit).toBeEnabled();
        await user.click(submit);
        expect(screen.getByRole("alert")).toHaveTextContent(/enter a valid phone number/i);
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
      await placeStand(user);
      await submitListing(user);

      const call = fetchMock.mock.calls.find(
        (entry) => LISTING_ENDPOINT_RE.test(String((entry as [string, unknown])[0])),
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

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
      await placeStand(user);
      // The grandfathered door is a wizard too (F-090), so Submit is on its last step.
      await submitListing(user);

      const call = fetchMock.mock.calls.find(
        (entry) => LISTING_ENDPOINT_RE.test(String((entry as [string, unknown])[0])),
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
        (entry) => LISTING_ENDPOINT_RE.test(String((entry as [string, unknown])[0])),
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
      pricesPublic: false,
      latitude: 47.4471,
      longitude: -122.4594,
      hoursText: "Dawn to dusk",
      paymentMethods: ["Cash", "Goats"],
      items: [{ name: "Eggs", price: null }, { name: "Flowers", price: null }],
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
      farmBucksEligible: true,
      farmBucksAccepted: false,
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

      expect(standNameField()).toHaveValue("Existing Stand");
      expect(screen.getByLabelText(/your farm address/i)).toHaveValue("12345 Vashon Highway SW");
    });

    it("splits stored payment methods across the checkboxes and the free-text tail", () => {
      // "Cash" is an offered option; "Goats" is not. Putting a known method in the tail would
      // re-save it as free text and undo F-069's closed set.
      renderEdit();

      expect(screen.getByLabelText("Cash")).toBeChecked();
      expect(screen.getByLabelText("Anything else you accept as payment?")).toHaveValue("Goats");
    });

    it("lets an eligible farmer state that they accept VIGA Bucks", async () => {
      const fetchMock = stubFetch({ ok: true });
      const user = userEvent.setup();
      renderEdit();

      const vigaBucks = screen.getByRole("checkbox", { name: "VIGA Bucks" });
      expect(vigaBucks).not.toBeChecked();
      await user.click(vigaBucks);
      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      expect(posted(fetchMock).farmBucksAccepted).toBe(true);
    });

    it("offers VIGA Bucks to a farm VIGA has NOT marked eligible", async () => {
      // max, 2026-08-10 — max reported the option missing from onboarding, and this is why:
      // the control was gated on `defaults.farmBucksEligible`, a VIGA flag stored on the stand
      // row. A farmer onboarding a new farm has no stand row yet, so the flag could never be
      // true and the option could never appear for the farmer the form exists for.
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...DEFAULTS, farmBucksEligible: false }}
        />,
      );

      expect(
        screen.getByRole("checkbox", { name: "VIGA Bucks" }),
      ).toBeInTheDocument();
    });

    it("offers VIGA Bucks on a brand-new listing with no defaults at all", async () => {
      // The true onboarding case: no stand, no defaults, nothing for eligibility to live on.
      const user = userEvent.setup();
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
        />,
      );

      const vigaBucks = screen.getByRole("checkbox", { name: "VIGA Bucks" });
      expect(vigaBucks).not.toBeChecked();
      await user.click(vigaBucks);
      expect(vigaBucks).toBeChecked();
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
      expect(body.farmBucksAccepted).toBe(false);
      expect(body.paymentMethods).toEqual(["Cash", "Goats"]);
      // F-090 — items round-trip as name/price pairs. Still the same B-037 guarantee this
      // test was written for: what the form was given is exactly what it sends back.
      expect(body.items).toEqual([
        { name: "Eggs", price: null },
        { name: "Flowers", price: null },
      ]);
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

  // ───────────────────────────────────────────────────────────────────────────────────────
  // F-090 — one form, two presentations.
  //
  // max asked for a WIZARD when onboarding and TABS when editing (2026-08-08). A farmer
  // setting up is doing it once, linearly, and should not face every field at once; a
  // farmer coming back wants to jump straight to the thing they came for.
  //
  // **The fields, the writer, and every rule stay shared.** Forking the component per door
  // is how two doors start publishing different shapes onto the same map — the reason
  // `ListingCredential` is a prop rather than three components. This is presentation over
  // one form, which is also why every field stays MOUNTED: an unmounted step would drop
  // the farmer's state on every Back, and the whole-listing writer would then erase by
  // omission whatever they could not see (B-037's shape).
  describe("stepping through onboarding as a wizard (F-090)", () => {
    it("shows one step at a time, starting with the farm", async () => {
      render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
        />,
      );

      // The address is on the first step, visible.
      expect(screen.getByLabelText(/your farm address/i)).toBeVisible();
      // A later step's field is present in the document — so its state survives — but not
      // shown. Asserted as "not visible" rather than "not in the document", because those
      // are different facts and only one of them is safe here.
      expect(screen.getByLabelText(/what do you usually sell/i)).not.toBeVisible();
    });

    it("carries values across Back and Next without losing them", async () => {
      // The property that makes stepping safe. A wizard that unmounts its steps would send
      // a listing missing everything the farmer could not currently see.
      const user = userEvent.setup();
      render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
        />,
      );

      await user.type(screen.getByLabelText(/your farm address/i), "12345 Vashon Hwy");
      await user.click(screen.getByRole("button", { name: /next/i }));
      await user.click(screen.getByRole("button", { name: /back/i }));

      expect(screen.getByLabelText(/your farm address/i)).toHaveValue("12345 Vashon Hwy");
    });

    it("keeps Submit active and shows every missing field at the form top", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
        />,
      );

      // Next is intentionally permissive: a farmer can review every section before deciding
      // what to enter. Submit must therefore explain and reveal the first missing requirement,
      // rather than silently disabling itself for a field on an earlier hidden page.
      await stepToEnd(user);
      const submit = screen.getByRole("button", { name: "Submit" });
      expect(submit).toBeEnabled();

      await user.click(submit);

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/finish these before submitting/i);
      expect(alert).toHaveTextContent(/enter your farm address/i);
      expect(alert).toHaveTextContent(/choose whether people can visit/i);
      expect(alert).not.toHaveTextContent(/enter a valid phone number/i);
      expect(alert).not.toHaveTextContent(/agree to receive texts/i);
      expect(screen.getByText("Step 1 of 4")).toBeVisible();
      const address = screen.getByLabelText(/your farm address/i);
      expect(address).toBeVisible();
      expect(alert.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      await user.type(address, "12345 Vashon Hwy");
      expect(alert).toHaveTextContent(/find your farm on the map/i);
      expect(screen.getByLabelText(/your phone number/i)).not.toBeVisible();

      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByText("Step 4 of 4")).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(/enter a valid phone number/i);
      expect(screen.getByRole("alert")).toHaveTextContent(/agree to receive texts/i);
      expect(screen.getByRole("alert")).not.toHaveTextContent(/find your farm on the map/i);
      expect(
        fetchMock.mock.calls.filter((entry) =>
          String((entry as [string, unknown])[0]).includes("/api/farmer/listing"),
        ),
      ).toHaveLength(0);
    });

    it("submits the WHOLE listing, including steps left at their defaults", async () => {
      // The B-037 guarantee restated for the wizard. A farmer who walks to the last step
      // without touching the middle ones must still publish every field — the writer
      // replaces the whole listing, so a field the form failed to send is a field deleted.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
        />,
      );

      await placeStand(user);
      await user.click(screen.getByLabelText(/yes — there is a stand/i));
      await stepToEnd(user);
      await submitListing(user);

      const body = posted(fetchMock);
      // Fields from three different steps, all present in one request.
      expect(body.publicAddress).toBe("12345 Vashon Highway SW");
      expect(body.visitability).toBe("visitable");
      expect(body).toHaveProperty("paymentMethods");
      expect(body).toHaveProperty("items");
    });

    it("does NOT step the edit door — every field is reachable at once", async () => {
      // The other half of max's call. An editing farmer came for one field and must not be
      // marched through five screens to reach it.
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={EDIT_DEFAULTS}
        />,
      );

      expect(screen.queryByRole("button", { name: /next/i })).toBeNull();
    });
  });

  describe("prices on the usual mix (F-090)", () => {
    /*
      A PLACED listing, because submitting requires a resolved pin (F-077/F-088) and the
      shared `EDIT_DEFAULTS` is deliberately a contact-only farm with none. Spread from it so
      this stays the whole-listing shape B-037 requires rather than a hand-picked subset.
    */
    const PLACED = {
      ...EDIT_DEFAULTS,
      visitability: "visitable" as const,
      publicAddress: "12345 Vashon Highway SW",
      latitude: 47.4471,
      longitude: -122.4594,
    };

    it("sends the price a farmer typed beside its own item", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs");
      await user.click(screen.getByRole("button", { name: /add item/i }));

      // F-092 — the price line only exists once the section's switch is on. That switch is the
      // farmer's decision to price anything at all, so it comes before any per-item amount.
      await user.click(screen.getByRole("switch", { name: /add prices/i }));
      await user.type(screen.getByLabelText(/^price for eggs$/i), "6");
      await user.selectOptions(screen.getByLabelText(/unit for eggs/i), "dozen");

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      // The PAIR, not merely that a price was sent — a form that attached the price to the
      // wrong item would satisfy any assertion that only checked presence. And all four parts,
      // because three of four is the shape the database refuses.
      expect(posted(fetchMock).items).toEqual([
        {
          name: "eggs",
          price: { amount: "6", quantity: "1", unit: "dozen", basis: "per" },
        },
      ]);
    });

    it("sends a BUNDLE price when the farmer says 'for' rather than 'per'", async () => {
      // The other sentence the same four controls make. The quantity box appears only with
      // `for`, because a unit price's count is always one — asking every farmer for a number
      // they will leave at 1 is a control earning nothing.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "tomatoes");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.click(screen.getByRole("switch", { name: /add prices/i }));

      // No quantity box until the basis says there is a bundle to count.
      expect(screen.queryByLabelText(/how many tomatoes/i)).not.toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText(/price basis for tomatoes/i), "for");

      await user.type(screen.getByLabelText(/^price for tomatoes$/i), "5");
      const quantity = screen.getByLabelText(/how many tomatoes/i);
      await user.clear(quantity);
      await user.type(quantity, "3");
      await user.selectOptions(screen.getByLabelText(/unit for tomatoes/i), "lb");

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      expect(posted(fetchMock).items).toEqual([
        {
          name: "tomatoes",
          price: { amount: "5", quantity: "3", unit: "lb", basis: "for" },
        },
      ]);
    });

    it("sends NO price while the section's switch is off, however filled the boxes were", async () => {
      // max's call (2026-08-08): hidden means hidden. A farmer who set prices and then switched
      // the feature off has said "do not show these" — so they must not reach the database, and
      // therefore cannot reach a customer. The values stay on screen, which is what makes the
      // switch reversible rather than destructive.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.click(screen.getByRole("switch", { name: /add prices/i }));
      await user.type(screen.getByLabelText(/^price for eggs$/i), "6");
      await user.selectOptions(screen.getByLabelText(/unit for eggs/i), "dozen");

      // The farmer changes their mind about showing prices at all.
      await user.click(screen.getByRole("switch", { name: /add prices/i }));
      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      const body = posted(fetchMock);
      expect(body.items).toEqual([{ name: "eggs", price: null }]);
      // And the stand itself records the choice, so the next edit does not switch it back on.
      expect(body.pricesPublic).toBe(false);
    });

    it("KEEPS what was typed when the switch goes off and on again", async () => {
      // The switch disables a feature; it does not clear a farmer's work. Retyping four fields
      // per item because they toggled something to see what it did would be a punishment for
      // exploring the form.
      const user = userEvent.setup();
      stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.click(screen.getByRole("switch", { name: /add prices/i }));
      await user.type(screen.getByLabelText(/^price for eggs$/i), "6");
      await user.selectOptions(screen.getByLabelText(/unit for eggs/i), "dozen");

      await user.click(screen.getByRole("switch", { name: /add prices/i }));
      expect(screen.queryByLabelText(/^price for eggs$/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole("switch", { name: /add prices/i }));
      expect(screen.getByLabelText(/^price for eggs$/i)).toHaveValue("6");
      expect(screen.getByLabelText(/unit for eggs/i)).toHaveValue("dozen");
    });

    it("refuses letters in the money box rather than sending them", async () => {
      // Filtered on the way IN, so the box cannot hold something it will not submit. A farmer
      // who types a letter sees it not appear, which is quieter than an error under the field.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.click(screen.getByRole("switch", { name: /add prices/i }));

      const amount = screen.getByLabelText(/^price for eggs$/i);
      await user.type(amount, "6a.5x0");
      expect(amount).toHaveValue("6.50");

      // And the decimal keypad is what a phone should raise for it.
      expect(amount).toHaveAttribute("inputmode", "decimal");

      await user.selectOptions(screen.getByLabelText(/unit for eggs/i), "lb");
      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));
      expect(posted(fetchMock).items).toEqual([
        {
          name: "eggs",
          price: { amount: "6.50", quantity: "1", unit: "lb", basis: "per" },
        },
      ]);
    });

    it("sends no price for an amount with no unit, rather than half of one", async () => {
      // Half a price is not a price. The database refuses the shape outright, so the form must
      // resolve it to "not stated" rather than posting something that will be rejected.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.click(screen.getByRole("switch", { name: /add prices/i }));
      await user.type(screen.getByLabelText(/^price for eggs$/i), "6");

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));
      expect(posted(fetchMock).items).toEqual([{ name: "eggs", price: null }]);
    });

    // ── B-040: "other" is a choice about this unit, not a mode the row cannot leave ──────────

    it("gives the unit MENU back after choosing other, which is what B-040 could not do", async () => {
      // The defect: the control was picked by asking whether the row's value was in the
      // suggestion list, and "other" stored a sentinel space so the answer stayed no forever.
      // Nothing the farmer typed could be in the list either, so the box never closed.
      const user = userEvent.setup();
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.click(screen.getByRole("switch", { name: /add prices/i }));

      // Into the box: the menu is replaced, as intended.
      await user.selectOptions(screen.getByLabelText(/unit for eggs/i), "__other__");
      expect(screen.getByLabelText(/unit for eggs/i).tagName).toBe("INPUT");
      await user.type(screen.getByLabelText(/unit for eggs/i), "half-flat");

      // And back out again. This is the assertion the bug failed.
      await user.click(screen.getByRole("button", { name: /use the unit menu for eggs/i }));
      expect(screen.getByLabelText(/unit for eggs/i).tagName).toBe("SELECT");
    });

    it("keeps a farmer's OWN unit in the box on an edit, not a menu that cannot show it", async () => {
      // The property the old value-sniffing achieved and which the mode must not lose: a stored
      // unit that is not one of the suggestions has to arrive in the free-text control.
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...PLACED,
            pricesPublic: true,
            items: [
              {
                name: "Firewood",
                price: { amount: "300", quantity: "1.00", unit: "cord", basis: "per" },
              },
            ],
          }}
        />,
      );

      const unit = screen.getByLabelText(/unit for Firewood/i);
      expect(unit.tagName).toBe("INPUT");
      expect(unit).toHaveValue("cord");
    });

    it("still refuses to submit a half-chosen unit, which the sentinel used to guarantee", async () => {
      // The sentinel space was load-bearing: `rowPrice` trimmed it back to "" so choosing
      // "other" and typing nothing could not submit. Whatever replaces it must keep that, and
      // `per` is the basis that requires a unit at all (B-041).
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "eggs");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.click(screen.getByRole("switch", { name: /add prices/i }));
      await user.type(screen.getByLabelText(/^price for eggs$/i), "6");
      await user.selectOptions(screen.getByLabelText(/unit for eggs/i), "__other__");
      // Typed nothing, and typing only spaces must be the same fact.
      await user.type(screen.getByLabelText(/unit for eggs/i), "   ");

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));
      expect(posted(fetchMock).items).toEqual([{ name: "eggs", price: null }]);
    });

    it("starts a newly added item IN STOCK on the onboarding door", async () => {
      // max's call (2026-08-08). A farmer listing their stand for the first time is describing
      // what is on the table as they type it, so "in stock" is the answer they already mean —
      // and an item they have to switch ON is one they will leave off by omission.
      //
      // Onboarding only: `asksForCurrentStock` gates the control itself, so the edit door has
      // no toggle to default. A dated claim still needs their START to publish.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
          smsNumber="+12068645326"
        />,
      );

      // The item control lives on the wizard's "what you sell" step; `revealField` walks there.
      await user.type(await revealField(user, /what do you usually sell/i), "eggs");
      await user.click(screen.getByRole("button", { name: /add item/i }));

      expect(screen.getByRole("switch", { name: /eggs in stock/i })).toHaveAttribute(
        "aria-checked",
        "true",
      );

      // And it TRAVELS: the claim reaches the boundary as today's stock without the farmer
      // having touched the toggle at all, which is the half a rendered switch cannot prove.
      await submitListing(user);

      expect(posted(fetchMock).currentStock).toEqual([{ itemName: "eggs" }]);
    });

    // ── B-041: a bundle needs no unit ────────────────────────────────────────────────────────

    it("submits a bundle with NO unit, which is a complete price for corn", async () => {
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "corn");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.click(screen.getByRole("switch", { name: /add prices/i }));
      await user.type(screen.getByLabelText(/^price for corn$/i), "5");
      await user.selectOptions(screen.getByLabelText(/price basis for corn/i), "for");
      await user.clear(screen.getByLabelText(/how many corn/i));
      await user.type(screen.getByLabelText(/how many corn/i), "3");
      // The unit is left alone entirely — the whole point.

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));
      expect(posted(fetchMock).items).toEqual([
        { name: "corn", price: { amount: "5", quantity: "3", unit: null, basis: "for" } },
      ]);
    });

    it("names the no-unit choice ITEM, and stores no unit for it", async () => {
      // max's call (2026-08-08). "unit" as the resting label asked the farmer to name something
      // a corn stand has no word for; "item" says what the price is already for. It is the same
      // EMPTY choice wearing a better word — the value must stay "" so nothing is stored, which
      // is what keeps "$5 for 3" rendering without an invented unit.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, items: [] }}
        />,
      );

      await user.type(screen.getByLabelText(/what do you usually sell/i), "corn");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.click(screen.getByRole("switch", { name: /add prices/i }));

      const unit = screen.getByLabelText(/unit for corn/i);
      expect(unit).toHaveValue("");
      expect(
        within(unit).getByRole("option", { name: "item" }),
        "the resting option should read 'item'",
      ).toHaveValue("");
      // And it is not a unit the farmer can state: no option carries the WORD as a value.
      expect(within(unit).queryByRole("option", { name: "unit" })).toBeNull();

      await user.type(screen.getByLabelText(/^price for corn$/i), "5");
      await user.selectOptions(screen.getByLabelText(/price basis for corn/i), "for");
      await user.clear(screen.getByLabelText(/how many corn/i));
      await user.type(screen.getByLabelText(/how many corn/i), "3");

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));
      expect(posted(fetchMock).items).toEqual([
        { name: "corn", price: { amount: "5", quantity: "3", unit: null, basis: "for" } },
      ]);
    });

    it("prefills a stored unitless bundle back into its controls", async () => {
      // The B-037 shape for the new price form: a price the form cannot show is a price the
      // next save deletes, and a unitless bundle is exactly the shape the old code could not
      // hold. The unit control comes back as the MENU, empty — there is no word to show.
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...PLACED,
            pricesPublic: true,
            items: [
              {
                name: "Corn",
                price: { amount: "5.00", quantity: "3.00", unit: null, basis: "for" },
              },
            ],
          }}
        />,
      );

      expect(screen.getByLabelText(/^price for Corn$/i)).toHaveValue("5.00");
      expect(screen.getByLabelText(/price basis for Corn/i)).toHaveValue("for");
      expect(screen.getByLabelText(/how many Corn/i)).toHaveValue("3.00");
      const unit = screen.getByLabelText(/unit for Corn/i);
      expect(unit.tagName).toBe("SELECT");
      expect(unit).toHaveValue("");
    });

    it("prefills a stored price, so an edit cannot silently drop it", async () => {
      // B-037 in the UI. `saveOnboardingListing` writes every item row on every save, so a
      // price the form could not show is a price the next save deletes.
      //
      // A stand that HAS prices arrives with the switch already on — otherwise the line holding
      // them would be hidden, and the farmer would have to rediscover a feature they already
      // turned on to see the values they already set.
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...PLACED,
            pricesPublic: true,
            items: [
              {
                name: "Eggs",
                price: { amount: "6.00", quantity: "1.00", unit: "dozen", basis: "per" },
              },
              { name: "Flowers", price: null },
            ],
          }}
        />,
      );

      expect(screen.getByRole("switch", { name: /add prices/i })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      // Each part on its own control, so a prefill that dropped the unit but kept the number
      // fails here rather than passing on the amount alone.
      expect(screen.getByLabelText(/^price for Eggs$/i)).toHaveValue("6.00");
      expect(screen.getByLabelText(/unit for Eggs/i)).toHaveValue("dozen");
      expect(screen.getByLabelText(/^price for Flowers$/i)).toHaveValue("");
    });

    it("round-trips an untouched priced listing unchanged", async () => {
      // The whole B-037 shape in one assertion: open the form, change nothing, save. What
      // comes back out must be what went in.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      const items = [
        {
          name: "Eggs",
          price: { amount: "6.00", quantity: "1.00", unit: "dozen", basis: "per" as const },
        },
        { name: "Flowers", price: null },
      ];
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{ ...PLACED, pricesPublic: true, items }}
        />,
      );

      await user.click(screen.getByRole("button", { name: /submit|save changes/i }));

      const body = posted(fetchMock);
      expect(body.items).toEqual(items);
      // The switch itself round-trips too. Sending `false` from a form that showed prices would
      // be B-037's shape one level up: the stand's own flag reset by an untouched save.
      expect(body.pricesPublic).toBe(true);
    });
  });

  describe("select all, on the days-open field (max 2026-08-08)", () => {
    it("ticks every weekday in one tap, and sends all seven", async () => {
      // Most stands on the island are open every day it is light, so "all seven" is the
      // common answer and was seven taps.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
      await placeStand(user);
      await user.click(await revealField(user, /open every day/i));
      await submitListing(user);

      // The VALUE, in weekday order — a control that ticked the boxes without the state
      // following would pass any assertion made on the checkboxes alone.
      expect(posted(fetchMock).openDays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it("clears them all when tapped again, so it is a toggle and not a trap", async () => {
      // A farmer who taps it by accident must be able to undo it in the same place. Without
      // this they would have to untick seven boxes to get back.
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
      await placeStand(user);
      const all = await revealField(user, /open every day/i);
      await user.click(all);
      await user.click(all);
      await submitListing(user);

      // `null`, not `[]` — "stated no days" is how this form has always sent an empty set,
      // and the boundary distinguishes it from a farmer who never answered.
      expect(posted(fetchMock).openDays).toBeNull();
    });

    it("reflects days ticked one at a time, without needing the toggle", () => {
      // The control must describe the state rather than own it: a farmer who ticks all seven
      // individually has said the same thing, and the toggle should show that.
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...EDIT_DEFAULTS,
            availability: {
              ...EDIT_DEFAULTS.availability,
              openDays: [0, 1, 2, 3, 4, 5, 6],
            },
          }}
        />,
      );

      expect(screen.getByLabelText(/open every day/i)).toBeChecked();
    });

    it("is NOT offered on the restocking days, which is a different question", async () => {
      // Restocking every day is rare — the common answers there are "it varies" and a couple
      // of days. A select-all would be a control nobody taps, and the cadence dropdown above
      // already offers "Every day" as its own choice.
      const user = userEvent.setup();
      // The address lookup is stubbed because `placeStand` performs one; this test does not
      // submit, so nothing asserts on the listing response.
      stubFetch({ ok: true });
      render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

      await user.click(screen.getByLabelText(/I deliver, or coordinate/i));
      await placeStand(user);
      // Reveal the step the day pickers live on. Anchored to the select-all checkbox rather
      // than the fieldset's legend, which is not a label and which `getByLabelText` will not
      // find.
      await revealField(user, /open every day/i);
      await user.selectOptions(screen.getByLabelText(/how often do you restock/i), "specific_days");

      // One select-all on the page, and it belongs to the open days.
      expect(screen.getAllByLabelText(/open every day/i)).toHaveLength(1);
    });
  });

  describe("prefilling what VIGA already holds (F-090)", () => {
    it("shows an invited farmer their farm's seeded listing rather than a blank form", async () => {
      /*
        max's point 3, and it is a DEFECT rather than a convenience.

        Nearly every invited farm is one VIGA already seeded: measured against the real
        corpus, 47 of 48 stands carry an address, 48 carry hours, 37 a season, and 36 items
        are standing claims. A blank onboarding form asked those farmers to retype all of it
        — and because `saveOnboardingListing` replaces the WHOLE listing, submitting the form
        they were shown would have overwritten VIGA's data with the blanks. That is B-037
        exactly, on the door where it does the most damage.
      */
      render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
          defaults={{
            ...EDIT_DEFAULTS,
            visitability: "visitable" as const,
            publicAddress: "12345 Vashon Highway SW",
            latitude: 47.4471,
            longitude: -122.4594,
            hoursText: "Dawn to dusk",
            pricesPublic: true,
            items: [
              {
                name: "Eggs",
                price: { amount: "6.00", quantity: "1.00", unit: "dozen", basis: "per" },
              },
            ],
          }}
        />,
      );

      expect(screen.getByLabelText(/your farm address/i)).toHaveValue(
        "12345 Vashon Highway SW",
      );
      expect(screen.getByLabelText(/anything else about your hours/i)).toHaveValue(
        "Dawn to dusk",
      );
      expect(screen.getByLabelText(/^price for Eggs$/i)).toHaveValue("6.00");
      expect(screen.getByLabelText(/unit for Eggs/i)).toHaveValue("dozen");
    });

    it("still starts a genuinely new farm blank", async () => {
      // A farm VIGA has nothing on. Prefilling must not invent values, so the absence of
      // defaults still produces an empty form.
      render(
        <ListingStep
          credential={{ kind: "invitation", token: TOKEN }}
          farmName="Test Farm"
        />,
      );

      expect(screen.getByLabelText(/your farm address/i)).toHaveValue("");
      expect(screen.getByLabelText(/anything else about your hours/i)).toHaveValue("");
    });
  });

  describe("the inventory builder is one self-contained section", () => {
    /** Onboarding, on the step that asks what the stand sells, with `count` items added. */
    async function withItems(user: ReturnType<typeof userEvent.setup>, ...names: string[]) {
      render(
        <ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />,
      );
      const box = await revealField(user, /what do you usually sell/i);
      for (const name of names) {
        await user.clear(box);
        await user.type(box, name);
        await user.click(screen.getByRole("button", { name: /add item/i }));
      }
    }

    it("wraps the question, the add box and the rows in ONE region", async () => {
      // max's ask (2026-08-08): the section should feel self-contained. It used to be four
      // siblings loose among the form's other fields — a label, an add row, a list and two
      // notes — so nothing said where "what you sell" started or stopped, and the rows read
      // as belonging to the paragraph box that follows them.
      //
      // A real `group` with an accessible name, not a styled `div`: the boundary has to exist
      // for a screen reader too, which is the whole difference between structure and a border.
      const user = userEvent.setup();
      await withItems(user, "eggs");

      const section = screen.getByRole("group", { name: /what do you usually sell/i });
      expect(section).toHaveClass("farmer-listing-inventory-highlighted");
      const payments = screen.getByRole("group", { name: "How can people pay?" });
      expect(section.compareDocumentPosition(payments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The question, the way in, and what has been added so far — all inside it.
      expect(section).toContainElement(screen.getByLabelText(/what do you usually sell/i));
      expect(section).toContainElement(screen.getByRole("button", { name: /add item/i }));
      expect(section).toContainElement(screen.getByText("eggs"));

      // And the NEXT question is outside it, which is what makes it a boundary rather than a
      // wrapper that happens to start in the right place.
      expect(section).not.toContainElement(
        screen.getByLabelText(/anything else people should know/i),
      );
    });

    it("drops the trailing explanation of what the list means", async () => {
      // Deleted outright (max 2026-08-08) rather than reworded. It explained the F-066 split
      // — standing mix versus today's stock — to a farmer who has not yet been asked about
      // today's stock, and it sat below the rows where it read as a footnote to the last item.
      // The per-row toggle now carries that distinction where it can be acted on.
      const user = userEvent.setup();
      await withItems(user, "eggs");

      expect(
        screen.queryByText(/you will text what is actually in stock/i),
      ).not.toBeInTheDocument();
    });

    it("gives each item ONE row, split into identity and price", async () => {
      // The row is the unit of meaning: everything about one item lives in one `<li>`, and two
      // items are two rows however many lines each takes. What line a control sits on is
      // max's 2026-08-08 split — name and stock above, price below — but the containment is
      // the property that must not break, because a control landing in the wrong row would
      // still look right and edit somebody else's item.
      const user = userEvent.setup();
      await withItems(user, "eggs", "kale");
      await user.click(screen.getByRole("switch", { name: /add prices/i }));

      const rows = screen.getAllByRole("listitem");
      expect(rows).toHaveLength(2);

      // Each row holds its OWN controls, anchored per item rather than counted globally: a
      // price landing on the wrong row would pass a count and fail this.
      for (const name of ["eggs", "kale"]) {
        const row = rows.find((entry) => entry.textContent?.includes(name));
        if (row === undefined) throw new Error(`no row for ${name}`);
        expect(row).toContainElement(
          screen.getByLabelText(new RegExp(`^price for ${name}$`, "i")),
        );
        expect(row).toContainElement(
          screen.getByLabelText(new RegExp(`unit for ${name}`, "i")),
        );
        expect(row).toContainElement(screen.getByRole("switch", { name: `${name} in stock` }));
        expect(row).toContainElement(screen.getByRole("button", { name: `Remove ${name}` }));
      }
    });

    it("shows NO price controls until the section's switch is on", async () => {
      // max's call (2026-08-08): one switch for the section rather than a control on every row.
      // Pricing is the exception at an honor-system stand, so the default row stays the compact
      // single line — a farmer who prices nothing never meets four controls they do not want.
      const user = userEvent.setup();
      await withItems(user, "eggs");

      expect(screen.queryByLabelText(/^price for eggs$/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/unit for eggs/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole("switch", { name: /add prices/i }));

      expect(screen.getByLabelText(/^price for eggs$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/unit for eggs/i)).toBeInTheDocument();
    });

    it("governs EVERY row with the one switch, not the row it was clicked beside", async () => {
      // The whole point of hoisting it to the section. A switch that only opened one row's
      // price would be a per-row control wearing a section's clothes.
      const user = userEvent.setup();
      await withItems(user, "eggs", "kale");

      await user.click(screen.getByRole("switch", { name: /add prices/i }));

      for (const name of ["eggs", "kale"]) {
        expect(screen.getByLabelText(new RegExp(`^price for ${name}$`, "i"))).toBeInTheDocument();
      }
    });

    it("keeps the currency mark in view while the farmer types", async () => {
      // max's ask (2026-08-08): the kind of hint that STAYS, not a placeholder that vanishes at
      // the first keystroke. So it is page furniture beside the box rather than text inside it,
      // and it is still there with a value typed.
      const user = userEvent.setup();
      await withItems(user, "eggs");
      await user.click(screen.getByRole("switch", { name: /add prices/i }));

      const section = screen.getByRole("group", { name: /what do you usually sell/i });
      expect(within(section).getByText("$")).toBeInTheDocument();

      await user.type(screen.getByLabelText(/^price for eggs$/i), "6");
      expect(within(section).getByText("$")).toBeInTheDocument();
    });

    it("says prices are optional once for the section, not once per row", async () => {
      // The fact is the same on every row, so stating it per row would repeat it as many times
      // as the farmer has items. The switch's own explanatory line carries it for all of them.
      const user = userEvent.setup();
      await withItems(user, "eggs", "kale");
      await user.click(screen.getByRole("switch", { name: /add prices/i }));

      const section = screen.getByRole("group", { name: /what do you usually sell/i });
      expect(within(section).getAllByText(/leave any of them blank/i)).toHaveLength(1);
    });

    it("states today's stock as a TOGGLE rather than a sentence to read", async () => {
      // Was a checkbox labelled "eggs are on the table right now" — a full sentence per item,
      // which is what forced the second line. A switch says the same thing in the control's
      // own shape, and `role="switch"` is what carries on/off to a screen reader; a checkbox
      // styled to look like a toggle would announce the wrong thing.
      const user = userEvent.setup();
      await withItems(user, "eggs");

      const toggle = screen.getByRole("switch", { name: /eggs in stock/i });
      // ON at rest on this door (max, 2026-08-08) — see "starts a newly added item IN STOCK".
      expect(toggle).toHaveAttribute("aria-checked", "true");

      // It is a real switch, so it moves BOTH ways rather than being a default that sticks.
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-checked", "false");
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-checked", "true");

      // The prose it replaced is gone, not merely restyled.
      expect(screen.queryByText(/on the table right now/i)).not.toBeInTheDocument();
    });

    it("still sends the standing mix and today's stock as SEPARATE facts", async () => {
      // The redesign is presentation. F-066's split is the thing underneath it, and a toggle
      // that wrote into `items` instead of `currentStock` would look identical on screen while
      // publishing "we always have eggs" from a farmer who said "today".
      const user = userEvent.setup();
      const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
      render(
        <ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />,
      );

      await placeStand(user);
      await user.click(screen.getByLabelText(/yes — there is a stand/i));
      const box = await revealField(user, /what do you usually sell/i);
      await user.type(box, "eggs");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      await user.type(box, "rhubarb");
      await user.click(screen.getByRole("button", { name: /add item/i }));
      // Both start in stock, so turning ONE off is what makes the two lists differ — and a
      // toggle wired to `items` rather than `currentStock` would drop rhubarb from both.
      await user.click(screen.getByRole("switch", { name: /rhubarb in stock/i }));
      await submitListing(user);

      const body = posted(fetchMock);
      expect(body.items).toEqual([
        { name: "eggs", price: null },
        { name: "rhubarb", price: null },
      ]);
      expect(body.currentStock).toEqual([{ itemName: "eggs" }]);
    });

    it("offers no per-item stock toggle on the edit door, which has its own stock update", async () => {
      // An onboarded farmer reports today's stock on the status tab, through the confirmation
      // gate. Two ways to do one thing is what the zen desk refuses.
      render(
        <ListingStep
          credential={{ kind: "stand_link", token: TOKEN }}
          farmName="Test Farm"
          // Carries an item deliberately: `EDIT_DEFAULTS` has none, and an empty list would
          // satisfy "no stock toggle" by having no rows at all.
          defaults={{
            ...EDIT_DEFAULTS,
            pricesPublic: true,
            items: [{ name: "Eggs", price: null }],
          }}
        />,
      );

      // Named rather than counted: the SECTION's price switch is also a `switch`, and this door
      // does have that one. A bare `queryAllByRole("switch")` count would fail for the wrong
      // reason and hide the thing being asserted.
      expect(screen.queryByRole("switch", { name: /eggs in stock/i })).toBeNull();
      expect(screen.getByRole("switch", { name: /add prices/i })).toBeInTheDocument();
      // The rest of the row survives, so this is a control that is absent rather than a row
      // that failed to render.
      expect(screen.getByLabelText(/^price for Eggs$/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove Eggs" })).toBeInTheDocument();
    });
  });

});
describe("both onboarding doors ask the same things (F-098)", () => {
  /*
    THE REGRESSION THIS PINS, and why it is not cosmetic.

    `JOIN <token>` was removed 2026-08-07 and farm identity moved to a phone the farmer states
    on the onboarding form. The grandfathered door was never given that field — every control
    in the "Staying in touch" step was gated on `credential.kind === "invitation"` — so when the
    form became a wizard the next day, that door rendered a fourth step holding its heading, the
    nav buttons, and nothing else.

    The farmer could publish a listing and then never finish onboarding: no phone recorded means
    no inbound START can ever be attributed to them. max's call (2026-08-09) is that the two
    doors ask the SAME questions, so this asserts the step has real content on both.
  */
  it("asks the grandfathered farmer for a phone, an agreement and a schedule", async () => {
    const user = userEvent.setup();
    render(
      <ListingStep credential={{ kind: "grandfathered", farmId: FARM_ID }} farmName="Test Farm" />,
    );

    // Walk to the last step rather than asserting on a hidden fieldset: `hidden` is what the
    // farmer's empty screen actually was, so the test has to reach the step the way they do.
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByLabelText(/your phone number/i)).toBeVisible();
    expect(screen.getByTestId("sms-agreement")).toBeVisible();
    expect(screen.getByText("Step 4 of 4")).toBeVisible();
  });

  it("still asks the invited farmer the same things", () => {
    render(<ListingStep credential={{ kind: "invitation", token: TOKEN }} farmName="Test Farm" />);

    expect(screen.getByText("Step 1 of 4")).toBeVisible();
  });

  it("sends the grandfathered farmer's selected stock with their listing", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ ok: true, body: { status: "saved" } });
    render(
      <ListingStep
        credential={{ kind: "grandfathered", farmId: FARM_ID }}
        farmName="Test Farm"
      />,
    );

    await placeStand(user);
    await user.click(screen.getByLabelText(/yes — there is a stand/i));
    const itemInput = await revealField(user, /what do you usually sell/i);
    await user.type(itemInput, "eggs");
    await user.click(screen.getByRole("button", { name: /add item/i }));

    expect(screen.getByRole("switch", { name: /eggs in stock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await submitListing(user);
    expect(posted(fetchMock).currentStock).toEqual([{ itemName: "eggs" }]);
  });

  it("does not ask a RETURNING farmer any of it — they are already onboarded", () => {
    // The editing door is the one door where these questions are wrong: the farmer's phone is
    // recorded, their consent is written, and their schedule lives on the stock tab.
    render(
      <ListingStep
        credential={{ kind: "stand_link", token: TOKEN }}
        farmName="Test Farm"
        defaults={EDIT_DEFAULTS}
      />,
    );

    expect(screen.queryByLabelText(/your phone number/i)).toBeNull();
    expect(screen.queryByTestId("sms-agreement")).toBeNull();
  });
});
describe("the confirmation links the word 'map' (F-098)", () => {
  // max, 2026-08-09: a farmer who reads "live on the map!" has nowhere to go and see it. The
  // word itself is the link, so the sentence stays one sentence.
  /** Answers the address lookup, the agreement stamp, and the submit. */
  function stubPublish() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
        return { ok: true, status: 200, json: async () => ({ status: "saved" }) };
      }) as unknown as typeof fetch,
    );
  }

  async function publish(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByLabelText(/yes . there is a stand/i));
    await placeStand(user);
    await submitListing(user);
  }

  it("points the word at the public map", async () => {
    const user = userEvent.setup();
    stubPublish();
    render(
      <ListingStep
        credential={{ kind: "grandfathered", farmId: FARM_ID }}
        farmName="Test Farm"
        mapUrl="https://www.vigavashon.org/farm-stand-map#map"
      />,
    );

    await publish(user);

    const link = await screen.findByRole("link", { name: "map" });
    expect(link).toHaveAttribute("href", "https://www.vigavashon.org/farm-stand-map#map");
    expect(link).toHaveClass("farmer-listing-map-link");
    // Opens away from a form the farmer just completed, so Back does not return them to a
    // submitted page — and the new tab cannot reach back into this one.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("still states the good news when no map URL is configured", async () => {
    // `PUBLIC_MAP_URL` is required in production, but a door rendered without it must say the
    // farm is live rather than break over a missing link.
    const user = userEvent.setup();
    stubPublish();
    render(
      <ListingStep credential={{ kind: "grandfathered", farmId: FARM_ID }} farmName="Test Farm" />,
    );

    await publish(user);

    expect(await screen.findByRole("status")).toHaveTextContent(/live on the map/i);
    expect(screen.queryByRole("link", { name: "map" })).toBeNull();
  });
});
