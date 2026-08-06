"use client";

import { useState } from "react";
import {
  ISLAND_VIEWBOX,
  projectToIsland,
  unprojectFromIsland,
} from "@farm-friend/core/island-projection";
import { IslandArtwork } from "../../../island-artwork";

/**
 * F-067 / F-069 — the listing details a farmer fills in while onboarding.
 *
 * **The visitability question is this form's structure, not a field on it.** The database
 * refuses a `visitable` stand without an address and a complete coordinate pair, and refuses a
 * `contact_only` one that has any of them (`sales_locations_coherent_visitability`, F-038 /
 * B-024). Inventing an address for a farm with no stand to visit puts a pin on the map that
 * sends a customer driving to a place with nothing to buy. So the form ASKS first, and the
 * address and pin only exist once the farmer says there is somewhere to go.
 *
 * **The pin is a DRAFT the farmer confirms, never a lookup's answer** (F-069, max reopened the
 * no-geocoder boundary for onboarding on 2026-08-05). Typing an address offers a suggested spot;
 * the farmer confirms it or taps to move it, and only the confirmed coordinate is submitted. The
 * geocoder cannot be the authority: rural Vashon is where address lookup is weakest, and a farm
 * stand is often at the road rather than at the mailing address — which only the farmer knows.
 * Every lookup failure falls back to tapping the map, which is how this worked before F-069.
 *
 * **Payment methods are a closed set with a free-text tail** (F-069). They were one comma box
 * into an unconstrained column, so "venmo" and "Venmo" became two values no filter could join —
 * the unfilterable shape Farm Friend exists to replace. VIGA Farm Bucks is deliberately NOT
 * offered: it is a VIGA eligibility fact with its own admin workflow, and a farmer cannot grant
 * themselves eligibility by ticking a box.
 *
 * **Season, hours and stocking are structured** (F-069) into F-035's existing filterable
 * columns, with `hoursText` surviving beside them as the farmer's own words. "Dawn to dusk" is a
 * real value rather than missing clock times — dusk on Vashon moves ~6 hours across the season.
 *
 * **What they usually sell is F-066's STANDING state** — the mix, not a dated confirmation.
 * "I usually sell eggs" is a different claim from "eggs were on the table today", and this
 * form may only make the first. Their own words are kept verbatim: normalization is case and
 * surrounding whitespace only, never singular/plural or synonyms.
 */

/** What the form may offer as checkboxes. NOT VIGA Farm Bucks — see the note above. */
const PAYMENT_OPTIONS = [
  "Cash",
  "Check",
  "Venmo",
  "PayPal",
  "Cash App",
  "Zelle",
  "Credit card",
] as const;

/** Sunday-first, matching the weekday numbering the admin reader and the columns use. */
const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
] as const;

/**
 * The hours a farmer can state, in the words they would use.
 *
 * The clockless options are first because they are the honest answer for an unattended stand:
 * most are open whenever it is light, and a fixed pair of clock times would claim a precision
 * the farmer does not have.
 */
const HOURS_OPTIONS = [
  { value: "dawn_to_dusk", label: "Dawn to dusk" },
  { value: "daylight_hours", label: "Daylight hours" },
  { value: "all_day", label: "All day, every day (24 hours)" },
  { value: "clock_range", label: "Set hours…" },
  { value: "until_dusk", label: "From a set time until dusk…" },
  { value: "by_appointment", label: "By appointment" },
] as const;

const SEASON_OPTIONS = [
  { value: "year_round", label: "Open all year" },
  { value: "date_range", label: "Between two dates…" },
  { value: "open_ended", label: "From a date, with no end yet…" },
  { value: "named_season", label: "Certain seasons…" },
] as const;

const STOCKING_OPTIONS = [
  { value: "daily", label: "Every day" },
  { value: "specific_days", label: "Certain days…" },
  { value: "variable", label: "It varies" },
  { value: "as_needed", label: "When it runs low" },
  { value: "intermittent", label: "Now and then" },
] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

type SeasonKind = (typeof SEASON_OPTIONS)[number]["value"];
type HoursKind = (typeof HOURS_OPTIONS)[number]["value"];
type StockingKind = (typeof STOCKING_OPTIONS)[number]["value"];

/** A pin, and whether the farmer has accepted it. A suggestion is not an answer. */
interface DraftPin {
  latitude: number;
  longitude: number;
  /** `false` while it is a lookup's suggestion awaiting the farmer's confirmation. */
  confirmed: boolean;
}

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
  const [pin, setPin] = useState<DraftPin | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [hoursText, setHoursText] = useState("");
  const [payments, setPayments] = useState<string[]>([]);
  const [otherPayment, setOtherPayment] = useState("");
  const [items, setItems] = useState("");

  const [seasonKind, setSeasonKind] = useState<SeasonKind | "">("");
  const [seasonStartMonth, setSeasonStartMonth] = useState("");
  const [seasonStartDay, setSeasonStartDay] = useState("");
  const [seasonEndMonth, setSeasonEndMonth] = useState("");
  const [seasonEndDay, setSeasonEndDay] = useState("");
  const [seasonNames, setSeasonNames] = useState("");
  const [hoursKind, setHoursKind] = useState<HoursKind | "">("");
  const [openFrom, setOpenFrom] = useState("");
  const [openUntil, setOpenUntil] = useState("");
  const [openDays, setOpenDays] = useState<number[]>([]);
  const [stockingKind, setStockingKind] = useState<StockingKind | "">("");
  const [stockingDays, setStockingDays] = useState<number[]>([]);

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
   *
   * A tap always CONFIRMS: the farmer touching the map is them stating where their stand is,
   * whether or not a lookup suggested something first.
   */
  function drop(event: React.MouseEvent<SVGSVGElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * ISLAND_VIEWBOX.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * ISLAND_VIEWBOX.height;
    const point = unprojectFromIsland({ x, y });
    setPin({ ...point, confirmed: true });
    setLookupNote(null);
  }

  /**
   * Offer a spot for the typed address, as an UNCONFIRMED draft.
   *
   * Every failure — no result, off the island, no geocoder configured, a network error — leaves
   * the farmer tapping the map, which is the behaviour that predates this lookup. The suggestion
   * can only save work; it can never place a stand on its own.
   */
  async function findAddress(): Promise<void> {
    if (lookingUp || address.trim() === "") return;
    setLookingUp(true);
    setLookupNote(null);
    try {
      const response = await fetch("/api/farmer/address-lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, address }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        status?: string;
        latitude?: number;
        longitude?: number;
      };
      if (
        response.ok &&
        body.status === "found" &&
        typeof body.latitude === "number" &&
        typeof body.longitude === "number"
      ) {
        // UNCONFIRMED. The farmer has to say this is right before it can be submitted.
        setPin({
          latitude: body.latitude,
          longitude: body.longitude,
          confirmed: false,
        });
        setLookupNote(
          "Is this the right spot? Tap the map to move it, or say it looks right.",
        );
        return;
      }
      setLookupNote(
        body.status === "off_island"
          ? "That address does not look like it is on the island. Tap the map to show " +
              "where your stand is."
          : "We could not find that address. Tap the map to show where your stand is.",
      );
    } catch {
      setLookupNote(
        "We could not look that up. Tap the map to show where your stand is.",
      );
    } finally {
      setLookingUp(false);
    }
  }

  /** Split a farmer's comma-separated list into their own words, blanks dropped. */
  function list(value: string): string[] {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }

  function toggleDay(
    days: number[],
    setDays: (next: number[]) => void,
    day: number,
  ): void {
    setDays(
      days.includes(day)
        ? days.filter((entry) => entry !== day)
        : [...days, day].sort((a, b) => a - b),
    );
  }

  /** A whole number from a picker, or null. Never coerced — "" must not become 0. */
  function digits(value: string): number | null {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }

  /**
   * Minutes since midnight from an `<input type="time">` value ("08:30").
   *
   * Returns null for a blank or malformed value rather than 0, which is midnight — a real time.
   */
  function minutesOfDay(value: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (match === null) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  const visitable = visitability === "visitable";
  // A pin the farmer has not confirmed does not count. This is what makes the lookup a draft.
  const placed = pin !== null && pin.confirmed;
  const ready =
    standName.trim() !== "" &&
    visitability !== null &&
    (!visitable || (address.trim() !== "" && placed));

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
          // Only the detail the chosen kind carries is sent. The boundary strips the rest too,
          // but sending stale dates for a season the farmer changed would be this form asking
          // to be refused over a field it no longer shows.
          seasonKind: seasonKind === "" ? null : seasonKind,
          ...(seasonKind === "date_range" || seasonKind === "open_ended"
            ? {
                seasonStartMonth: digits(seasonStartMonth),
                seasonStartDay: digits(seasonStartDay),
              }
            : {}),
          ...(seasonKind === "date_range"
            ? {
                seasonEndMonth: digits(seasonEndMonth),
                seasonEndDay: digits(seasonEndDay),
              }
            : {}),
          ...(seasonKind === "named_season"
            ? { seasonNames: list(seasonNames) }
            : {}),
          openHoursKind: hoursKind === "" ? null : hoursKind,
          ...(hoursKind === "clock_range" || hoursKind === "until_dusk"
            ? { openFromMinutes: minutesOfDay(openFrom) }
            : {}),
          ...(hoursKind === "clock_range"
            ? { openUntilMinutes: minutesOfDay(openUntil) }
            : {}),
          openDays: openDays.length > 0 ? openDays : null,
          stockingCadence: stockingKind === "" ? null : stockingKind,
          ...(stockingKind === "specific_days"
            ? { stockingDays: stockingDays.length > 0 ? stockingDays : null }
            : {}),
          paymentMethods: [...payments, ...list(otherPayment)],
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
              : body.error === "incoherent_availability"
                ? "Some of your season, hours, or restocking answers are incomplete. " +
                  "Check the ones where you chose a time or a set of days."
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

  const pinPoint =
    pin === null ? null : projectToIsland({ latitude: pin.latitude, longitude: pin.longitude });

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
            The lookup OFFERS a spot; it never sets one. `type="button"` matters — inside a form
            a bare button submits, which would try to publish the listing on a lookup.
          */}
          <button
            type="button"
            className="farmer-listing-lookup"
            onClick={() => void findAddress()}
            disabled={lookingUp || address.trim() === ""}
          >
            {lookingUp ? "Looking…" : "Find this address on the map"}
          </button>

          {/*
            The pin. A lookup can suggest it, but only the farmer's confirmation commits it —
            they know whether the stand is at the house or down at the road.
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
                  className={
                    placed ? "farmer-listing-pin" : "farmer-listing-pin-draft"
                  }
                />
              </g>
            )}
          </svg>
          {lookupNote === null ? null : (
            <p className="farmer-form-note" role="status">
              {lookupNote}
            </p>
          )}
          {/*
            The confirmation. Present ONLY while a suggested pin is unconfirmed, so the farmer
            cannot publish a looked-up coordinate they never looked at.
          */}
          {pin !== null && !pin.confirmed ? (
            <button
              type="button"
              className="farmer-listing-confirm"
              onClick={() => {
                setPin({ ...pin, confirmed: true });
                setLookupNote(null);
              }}
            >
              That spot looks right
            </button>
          ) : null}
          {placed ? (
            <p className="farmer-form-note" role="status">
              Spot chosen. Tap again to move it.
            </p>
          ) : pin === null ? (
            <p className="farmer-form-note">No spot chosen yet.</p>
          ) : null}
        </>
      ) : null}

      {/* ── Season ─────────────────────────────────────────────────────────────────────── */}
      <label htmlFor="season-kind">When is your stand open in the year?</label>
      <select
        id="season-kind"
        value={seasonKind}
        onChange={(event) => setSeasonKind(event.target.value as SeasonKind | "")}
      >
        {/* "Not stated" stays a real choice: it is a different fact from "open all year". */}
        <option value="">Rather not say</option>
        {SEASON_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {seasonKind === "date_range" || seasonKind === "open_ended" ? (
        <div className="farmer-listing-row">
          <label htmlFor="season-start-month">Opens</label>
          <select
            id="season-start-month"
            value={seasonStartMonth}
            onChange={(event) => setSeasonStartMonth(event.target.value)}
          >
            <option value="">Month</option>
            {MONTHS.map((month, index) => (
              <option key={month} value={index + 1}>
                {month}
              </option>
            ))}
          </select>
          <label htmlFor="season-start-day" className="farmer-listing-inline-label">
            day
          </label>
          <input
            id="season-start-day"
            type="number"
            min={1}
            max={31}
            value={seasonStartDay}
            onChange={(event) => setSeasonStartDay(event.target.value)}
          />
        </div>
      ) : null}

      {seasonKind === "date_range" ? (
        <div className="farmer-listing-row">
          <label htmlFor="season-end-month">Closes</label>
          <select
            id="season-end-month"
            value={seasonEndMonth}
            onChange={(event) => setSeasonEndMonth(event.target.value)}
          >
            <option value="">Month</option>
            {MONTHS.map((month, index) => (
              <option key={month} value={index + 1}>
                {month}
              </option>
            ))}
          </select>
          <label htmlFor="season-end-day" className="farmer-listing-inline-label">
            day
          </label>
          <input
            id="season-end-day"
            type="number"
            min={1}
            max={31}
            value={seasonEndDay}
            onChange={(event) => setSeasonEndDay(event.target.value)}
          />
        </div>
      ) : null}

      {seasonKind === "named_season" ? (
        <>
          <label htmlFor="season-names">Which seasons?</label>
          <input
            id="season-names"
            type="text"
            value={seasonNames}
            onChange={(event) => setSeasonNames(event.target.value)}
            placeholder="berry season, pumpkin season"
            maxLength={500}
          />
        </>
      ) : null}

      {/* ── Hours ──────────────────────────────────────────────────────────────────────── */}
      <label htmlFor="hours-kind">When are you usually open?</label>
      <select
        id="hours-kind"
        value={hoursKind}
        onChange={(event) => setHoursKind(event.target.value as HoursKind | "")}
      >
        <option value="">Rather not say</option>
        {HOURS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {hoursKind === "clock_range" || hoursKind === "until_dusk" ? (
        <div className="farmer-listing-row">
          <label htmlFor="open-from">Opens at</label>
          <input
            id="open-from"
            type="time"
            value={openFrom}
            onChange={(event) => setOpenFrom(event.target.value)}
          />
          {hoursKind === "clock_range" ? (
            <>
              <label htmlFor="open-until" className="farmer-listing-inline-label">
                until
              </label>
              <input
                id="open-until"
                type="time"
                value={openUntil}
                onChange={(event) => setOpenUntil(event.target.value)}
              />
            </>
          ) : null}
        </div>
      ) : null}

      <fieldset className="farmer-listing-days">
        <legend>Which days are you open?</legend>
        {WEEKDAYS.map((day) => (
          <label key={day.value} className="farmer-listing-day">
            <input
              type="checkbox"
              checked={openDays.includes(day.value)}
              onChange={() => toggleDay(openDays, setOpenDays, day.value)}
            />
            <span>{day.label}</span>
          </label>
        ))}
      </fieldset>

      <label htmlFor="stand-hours">Anything else about your hours?</label>
      <input
        id="stand-hours"
        type="text"
        value={hoursText}
        onChange={(event) => setHoursText(event.target.value)}
        placeholder="Weekends when available"
        maxLength={500}
      />
      <p className="farmer-form-note">
        In your own words. This shows on your listing exactly as you write it.
      </p>

      {/* ── Restocking ─────────────────────────────────────────────────────────────────── */}
      <label htmlFor="stocking-kind">How often do you restock?</label>
      <select
        id="stocking-kind"
        value={stockingKind}
        onChange={(event) => setStockingKind(event.target.value as StockingKind | "")}
      >
        <option value="">Rather not say</option>
        {STOCKING_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {stockingKind === "specific_days" ? (
        <fieldset className="farmer-listing-days">
          <legend>Which days do you restock?</legend>
          {WEEKDAYS.map((day) => (
            <label key={day.value} className="farmer-listing-day">
              <input
                type="checkbox"
                checked={stockingDays.includes(day.value)}
                onChange={() => toggleDay(stockingDays, setStockingDays, day.value)}
              />
              <span>{day.label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {/* ── Payment ────────────────────────────────────────────────────────────────────── */}
      {/*
        Checkboxes over the closed set, so "venmo" and "Venmo" cannot become two values a
        filter fails to join. VIGA Farm Bucks is absent on purpose: acceptance depends on an
        eligibility only VIGA grants, and a farmer must not be able to claim it here.
      */}
      <fieldset className="farmer-listing-payments">
        <legend>How can people pay?</legend>
        {PAYMENT_OPTIONS.map((method) => (
          <label key={method} className="farmer-listing-choice">
            <input
              type="checkbox"
              checked={payments.includes(method)}
              onChange={() =>
                setPayments(
                  payments.includes(method)
                    ? payments.filter((entry) => entry !== method)
                    : [...payments, method],
                )
              }
            />
            <span>{method}</span>
          </label>
        ))}
      </fieldset>

      <label htmlFor="other-payment">Anything else you take?</label>
      <input
        id="other-payment"
        type="text"
        value={otherPayment}
        onChange={(event) => setOtherPayment(event.target.value)}
        placeholder="trade for eggs"
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
