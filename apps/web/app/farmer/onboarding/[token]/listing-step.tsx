"use client";

import { useState } from "react";
import {
  ISLAND_VIEWBOX,
  projectToIsland,
  unprojectFromIsland,
} from "@farm-friend/core/island-projection";
import { IslandArtwork } from "../../../island-artwork";

/**
 * F-067 — the listing details a farmer fills in while onboarding.
 *
 * **The visitability question is this form's structure, not a field on it.** The database
 * refuses a `visitable` stand without an address and a complete coordinate pair, and refuses a
 * `contact_only` one that has any of them (`sales_locations_coherent_visitability`, F-038 /
 * B-024). Inventing an address for a farm with no stand to visit puts a pin on the map that
 * sends a customer driving to a place with nothing to buy. So the form ASKS first, and the
 * address and pin only exist once the farmer says there is somewhere to go.
 *
 * **The pin is dropped, not looked up.** There is no geocoder in Farm Friend and there
 * deliberately never will be — a runtime geocoder/map package is a named non-goal, and every
 * address-lookup service bills per call to place pins in the wrong driveway. The farmer taps
 * the island they live on, which they know better than any lookup does, and the tap is read
 * back through the SAME projection that draws every other pin.
 *
 * **What they usually sell is F-066's STANDING state** — the mix, not a dated confirmation.
 * "I usually sell eggs" is a different claim from "eggs were on the table today", and this
 * form may only make the first. Their own words are kept verbatim: normalization is case and
 * surrounding whitespace only, never singular/plural or synonyms.
 */
export function ListingStep({
  token,
  farmName,
}: {
  token: string;
  farmName: string;
}) {
  const [standName, setStandName] = useState(farmName);
  const [visitability, setVisitability] = useState<
    "visitable" | "contact_only" | null
  >(null);
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState<{ latitude: number; longitude: number } | null>(
    null,
  );
  const [hoursText, setHoursText] = useState("");
  const [payments, setPayments] = useState("");
  const [items, setItems] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * Read a tap as a coordinate.
   *
   * The SVG's own user-space is the artwork's viewBox, so a click's `offsetX`/`offsetY` would
   * be in CSS pixels and wrong at every size but one. `getBoundingClientRect` plus the
   * viewBox ratio converts once, here, rather than assuming the drawing is displayed at its
   * intrinsic size — it never is, since it scales to the phone.
   */
  function drop(event: React.MouseEvent<SVGSVGElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * ISLAND_VIEWBOX.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * ISLAND_VIEWBOX.height;
    setPin(unprojectFromIsland({ x, y }));
  }

  /** Split a farmer's comma-separated list into their own words, blanks dropped. */
  function list(value: string): string[] {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }

  const visitable = visitability === "visitable";
  const ready =
    standName.trim() !== "" &&
    visitability !== null &&
    (!visitable || (address.trim() !== "" && pin !== null));

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || !ready) return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/farmer/listing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The token travels in the body, never a query string: a credential in a URL lands
        // in server logs and browser history by default.
        body: JSON.stringify({
          token,
          standName,
          visitability,
          // Everything a farmer might sell is `produce` unless they say otherwise. The other
          // two values describe stands VIGA seeded (a service business, an order-only farm)
          // and are not questions worth putting to someone setting up a farm stand.
          offeringType: "produce",
          ...(visitable
            ? {
                publicAddress: address,
                latitude: pin?.latitude ?? null,
                longitude: pin?.longitude ?? null,
              }
            : {}),
          hoursText,
          paymentMethods: list(payments),
          items: list(items),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(
          body.error === "off_island"
            ? "That spot is off the island. Tap your stand's location on the map."
            : body.error === "incomplete_location"
              ? "A stand people can visit needs both an address and a spot on the map."
              : body.error === "invitation_unavailable"
                ? "This invitation is no longer available. Ask the VIGA coordinator who " +
                  "invited you for a new link."
                : "That did not save. Check your answers and try again.",
        );
        return;
      }
      setSaved(true);
    } catch {
      setError("That did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <p className="farmer-form-published" role="status">
        Your stand is on the map. You can change any of this later by texting SETTINGS.
      </p>
    );
  }

  const pinPoint = pin === null ? null : projectToIsland(pin);

  return (
    <form className="farmer-listing" onSubmit={(event) => void submit(event)}>
      <label htmlFor="stand-name">What is your stand called?</label>
      <input
        id="stand-name"
        type="text"
        value={standName}
        onChange={(event) => setStandName(event.target.value)}
        maxLength={120}
      />

      {/*
        THE BRANCH. Asked before anything that depends on it, and deliberately not
        pre-answered: whether there is a place to drive to is the one fact nobody may invent
        on a farmer's behalf. Radio buttons rather than a checkbox, so "not answered yet" is
        a state the farmer can see they are in.
      */}
      <fieldset className="farmer-listing-branch">
        <legend>Can people come to your stand?</legend>
        <label className="farmer-listing-choice">
          <input
            type="radio"
            name="visitability"
            checked={visitability === "visitable"}
            onChange={() => setVisitability("visitable")}
          />
          <span>Yes — there is a stand to visit</span>
        </label>
        <label className="farmer-listing-choice">
          <input
            type="radio"
            name="visitability"
            checked={visitability === "contact_only"}
            onChange={() => setVisitability("contact_only")}
          />
          <span>No — I deliver, or people arrange it with me</span>
        </label>
      </fieldset>

      {visitable ? (
        <>
          <label htmlFor="stand-address">Where is it?</label>
          <input
            id="stand-address"
            type="text"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="12345 Vashon Highway SW"
            maxLength={300}
          />

          {/*
            The pin. No geocoder exists to place it from the address above, so the farmer
            places it themselves — and they know where their own stand is better than an
            address lookup would.
          */}
          <p className="farmer-listing-map-label" id="pin-instruction">
            Tap the map to show where your stand is.
          </p>
          <svg
            className="farmer-listing-map"
            viewBox={`0 0 ${ISLAND_VIEWBOX.width} ${ISLAND_VIEWBOX.height}`}
            role="img"
            aria-describedby="pin-instruction"
            aria-label="Map of Vashon and Maury Island. Tap to place your stand."
            onClick={drop}
          >
            <IslandArtwork />
            {pinPoint === null ? null : (
              <g>
                <circle
                  cx={pinPoint.x}
                  cy={pinPoint.y}
                  r={14}
                  className="farmer-listing-pin"
                />
              </g>
            )}
          </svg>
          {pin === null ? (
            <p className="farmer-form-note">No spot chosen yet.</p>
          ) : (
            <p className="farmer-form-note" role="status">
              Spot chosen. Tap again to move it.
            </p>
          )}
        </>
      ) : null}

      <label htmlFor="stand-hours">When are you usually open?</label>
      <input
        id="stand-hours"
        type="text"
        value={hoursText}
        onChange={(event) => setHoursText(event.target.value)}
        placeholder="Daylight hours, most days"
        maxLength={500}
      />

      <label htmlFor="stand-payments">How can people pay?</label>
      <input
        id="stand-payments"
        type="text"
        value={payments}
        onChange={(event) => setPayments(event.target.value)}
        placeholder="cash, Venmo"
        maxLength={500}
      />

      {/*
        The farmer's OWN WORDS, and they stay that way. "tomato", "tomatoes" and "love apple"
        remain three items — folding them would be a produce taxonomy, which no business code
        may hard-code.
      */}
      <label htmlFor="stand-items">What do you usually sell?</label>
      <input
        id="stand-items"
        type="text"
        value={items}
        onChange={(event) => setItems(event.target.value)}
        placeholder="eggs, plant starts, flowers"
        maxLength={500}
      />
      <p className="farmer-form-note">
        Separate them with commas. This is what you usually have — you will text what is
        actually in stock as it changes.
      </p>

      {error === null ? null : (
        <p className="farmer-form-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy || !ready}>
        {busy ? "Saving…" : "Put my stand on the map"}
      </button>
    </form>
  );
}
