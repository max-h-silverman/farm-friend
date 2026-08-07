"use client";

import { useState } from "react";
// `unprojectFromIsland` is NO LONGER imported: F-077 removed the tap that needed it. It is
// deliberately still exported from the projection module — its own tests use it to prove the
// projection round-trips, which is load-bearing evidence for the FORWARD projection the public
// map depends on.
import { ISLAND_VIEWBOX, projectToIsland } from "@farm-friend/core/island-projection";
// TYPE-ONLY, so nothing in the database package reaches this client bundle. The shape is
// IMPORTED rather than restated: B-037 was a restated `ListingDefaults` drifting out of
// agreement with what the writer stores, and a second hand-written copy of these twelve
// fields is how that happens again.
import type { ListingAvailability } from "@farm-friend/db";
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
 * **The typed address is the ONLY source of a coordinate** (F-077, max 2026-08-06). F-069 made
 * the lookup a draft the farmer confirmed by tapping the island; that tap, that confirm gate,
 * and the whole pin-picker interaction are gone. An address that will not resolve is REFUSED
 * and the farmer is asked to correct it — no approximation, no fallback.
 *
 * What that trades away is real and was chosen deliberately: a stand at the road rather than at
 * the mailing address can no longer be nudged, and rural Vashon is where lookup is weakest. What
 * it buys is that a published coordinate is never something other than the address printed
 * beside it. The map SURVIVES as a read-only display, because a coordinate the farmer never sees
 * is one they cannot sanity-check.
 *
 * The sharp edge this creates, and where it is handled: with no tap and no confirmation,
 * editing the address after a successful lookup must DISCARD the coordinate, or address A's
 * point publishes under address B. See `changeAddress`.
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
  // ONE way to say "while it is light". `daylight_hours` is still a valid enum value and rows
  // already hold it — `open-now` answers it identically to `dawn_to_dusk` (same verdict, same
  // sunrise and sunset), which is exactly why offering both was a choice with no meaning. A
  // farmer picking between two phrasings of one fact splits the data on a distinction no
  // customer can see. Reading stays unchanged; only the form stops asking.
  { value: "dawn_to_dusk", label: "Dawn to dusk" },
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

/**
 * How many days each month offers the day picker.
 *
 * **February is 29.** The season is a recurring month/day pair stored with NO year, so a stand
 * that opens on the 29th in leap years must be stateable; the database allows 1–31 for any
 * month. This list exists to keep a farmer from choosing something that never occurs at all,
 * like February 31 — not to resolve a real calendar date.
 */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** The days a month offers. Every day, 1–31, until a month narrows it. */
function daysForMonth(month: string): number[] {
  const index = Number(month) - 1;
  const count = DAYS_IN_MONTH[index] ?? 31;
  return Array.from({ length: count }, (_, i) => i + 1);
}

/**
 * Opening times as half-hour choices across the whole day.
 *
 * A `<select>` rather than `<input type="time">`: the native control is a fiddly three-part
 * field to operate one-handed, and it invites a farmer to type. The option VALUES stay the
 * same "HH:MM" strings the time input produced, so `minutesOfDay`, `clockValue` and every
 * stored row are unchanged by the swap.
 */
const CLOCK_CHOICES: { value: string; label: string }[] = Array.from(
  { length: 48 },
  (_, slot) => {
    const hours = Math.floor(slot / 2);
    const minutes = slot % 2 === 0 ? 0 : 30;
    const value = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    // 12-hour with am/pm, which is how a farmer on Vashon states their hours. Midnight and
    // noon are named rather than shown as "12:00 am", which reads as ambiguous.
    const suffix = hours < 12 ? "am" : "pm";
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    const label =
      slot === 0
        ? "Midnight"
        : slot === 24
          ? "Noon"
          : `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
    return { value, label };
  },
);

type SeasonKind = (typeof SEASON_OPTIONS)[number]["value"];
/**
 * What the form can HOLD, which is wider than what it offers.
 *
 * `daylight_hours` is no longer in `HOURS_OPTIONS` — it and `dawn_to_dusk` were two phrasings
 * of one fact — but rows already store it. Deriving this from the offered list would make an
 * edit form unable to carry a retired value, blanking a farmer's stated hours the moment they
 * opened the form to change something else. That is B-037's failure, and typecheck caught it.
 */
type HoursKind = (typeof HOURS_OPTIONS)[number]["value"] | "daylight_hours";
type StockingKind = (typeof STOCKING_OPTIONS)[number]["value"];

/**
 * Where the stand is, as resolved from the typed address (F-077).
 *
 * There is no `confirmed` flag any more. A pin exists exactly when the CURRENT address text
 * resolved to a point — editing the address clears it — so "present" and "accepted" collapse
 * into one state rather than two that can disagree.
 */
interface GeocodedPin {
  latitude: number;
  longitude: number;
}

/**
 * Which door this form is being filled in through (F-072).
 *
 * **The form states WHAT is being written; the credential states who may write it.** An invited
 * farmer holds a one-use token that names their farm; a grandfathered farmer picked their farm
 * from the public dropdown and holds nothing. Those are the only two differences, so they are
 * the only thing parameterized — every field, every rule, and every refusal below is shared.
 *
 * Making this a prop rather than forking the component is what stops the two doors drifting
 * into publishing different shapes onto the same map.
 */
export type ListingCredential =
  | { kind: "invitation"; token: string }
  | { kind: "grandfathered"; farmId: string }
  /** F-073 — an already-onboarded farmer editing, via their private stand link. */
  | { kind: "stand_link"; token: string };

/** Where each credential submits, and what it calls itself in the body. */
const LISTING_ENDPOINT: Record<ListingCredential["kind"], string> = {
  invitation: "/api/farmer/listing",
  grandfathered: "/api/farmer/grandfathered-listing",
  stand_link: "/api/farmer/listing-edit",
};

function credentialBody(credential: ListingCredential): Record<string, string> {
  // The token travels in the BODY, never a query string: a credential in a URL lands in server
  // logs and browser history by default. A farm id is not a credential and is not secret, but
  // it rides in the body too so all three doors post one shape.
  return credential.kind === "grandfathered"
    ? { farmId: credential.farmId }
    : { token: credential.token };
}

/**
 * The listing a farmer is EDITING, prefilled (F-073).
 *
 * **The write is whole-listing, so a blank edit form is destructive.** `saveOnboardingListing`
 * replaces everything it is given, which is what lets a farmer drop an item by leaving it out —
 * and would let a farmer who opened the form to change their hours erase their address and
 * payments by omission. Prefilling is therefore load-bearing, not a nicety.
 *
 * **Which means PARTIAL prefill is the same defect, only quieter** (B-037). This interface
 * originally held eight of the listing's fields while the writer set twenty; the four it
 * omitted were the structured availability, so every edit silently cleared the farmer's
 * season, open days and restocking. Nothing failed, because the writer was doing exactly what
 * it says it does. **This type must stay the whole listing** — anything `saveOnboardingListing`
 * writes and this omits is a field the form deletes on the farmer's behalf.
 */
export interface ListingDefaults {
  standName: string;
  visitability: "visitable" | "contact_only";
  publicAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  hoursText: string | null;
  /**
   * B-037 — the structured season / hours / restocking, and the reason this is the WHOLE
   * listing's shape rather than a chosen subset.
   *
   * These were absent, so an edit form initialised them blank while `updateStand` wrote all
   * twelve columns unconditionally on every save. A farmer who opened this to change their
   * hours lost their season, open days, restocking cadence and restocking days, with nothing
   * shown and nothing failing.
   */
  availability: ListingAvailability;
  paymentMethods: string[];
  items: string[];
  /**
   * The farm's own prose, as it renders on the public card under "Additional information".
   *
   * Here for the same B-037 reason as the availability above: `saveOnboardingListing` writes it,
   * so a form that could not see it would clear a farm's paragraph on the next save.
   */
  description: string | null;
}

/**
 * Minutes since midnight rendered back as an `<input type="time">` value — the inverse of
 * `minutesOfDay`.
 *
 * `?? null`, never `|| null`: 0 is MIDNIGHT, a real stated time, and a truthiness check would
 * render it as "not stated" so the next save dropped it. `minutesOfDay` already takes this care
 * on the write direction; the read direction needs exactly the same.
 */
function clockValue(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "";
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** A stored month or day rendered back into its picker. Blank when never stated. */
function numberValue(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function ListingStep({
  credential,
  farmName,
  defaults,
  description: initialDescription,
}: {
  credential: ListingCredential;
  farmName: string;
  /** Present when EDITING an existing listing (F-073). Absent when creating one. */
  defaults?: ListingDefaults;
  /**
   * The farm's stored paragraph, for a door that CREATES a listing over a farm which already
   * has one — F-079's migration door, where VIGA's prose is on the public card today.
   *
   * Separate from `defaults` because those two doors differ: an edit prefills every field, and
   * the migration door deliberately prefills none of them EXCEPT this one, since it is the only
   * field the form would otherwise silently erase. `defaults` wins when both are supplied.
   */
  description?: string;
}) {
  // A stored payment method is either one of the offered checkboxes or something the farmer
  // typed. Split on the closed set so an edit shows "Venmo" ticked rather than as free text —
  // and so re-saving an untouched form writes back what was already there.
  const offered = new Set<string>(PAYMENT_OPTIONS);
  const storedPayments = defaults?.paymentMethods ?? [];

  const [standName, setStandName] = useState(defaults?.standName ?? farmName);
  /*
    The FARM's name, offered only when EDITING.

    It is public on the map beside the stand and, until now, could be changed by nobody —
    not the farmer, not an administrator — because it was written once when the invitation
    was created. A farm named with a typo carried that typo in front of the island forever.

    Not offered during onboarding: the invitation just named the farm, and a second name box
    beside the stand-name box would ask a farmer to distinguish two records they have no
    reason to think of as separate yet. Editing is where the distinction is already visible,
    because both names are already on screen and already differ.
  */
  const [editedFarmName, setEditedFarmName] = useState(farmName);
  const canRenameFarm = credential.kind === "stand_link";
  const [visitability, setVisitability] = useState<
    "visitable" | "contact_only" | null
  >(defaults?.visitability ?? null);
  const [address, setAddress] = useState(defaults?.publicAddress ?? "");
  const [pin, setPin] = useState<GeocodedPin | null>(
    defaults?.latitude != null && defaults.longitude != null
      ? // A stand already on the map has a coordinate, and it belongs to the address stored
        // beside it. Requiring a fresh lookup before an unrelated edit could be saved would
        // make every edit a re-placement — and would strand a farmer whose address has since
        // stopped resolving.
        { latitude: defaults.latitude, longitude: defaults.longitude }
      : null,
  );
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [hoursText, setHoursText] = useState(defaults?.hoursText ?? "");
  const [payments, setPayments] = useState<string[]>(
    storedPayments.filter((method) => offered.has(method)),
  );
  const [otherPayment, setOtherPayment] = useState(
    storedPayments.filter((method) => !offered.has(method)).join(", "),
  );
  const [items, setItems] = useState((defaults?.items ?? []).join(", "));
  // The farm's own paragraph on the public card. Prefilled from what is stored — for a
  // migrating farm that is VIGA's text with its restated facts already stripped, so the farmer
  // sees only what has no column of its own and edits from there.
  const [description, setDescription] = useState(
    defaults?.description ?? initialDescription ?? "",
  );

  // B-037 — every one of the twelve initialised from `defaults`, because `updateStand` writes
  // every one of them on every save. A blank initialiser here is not "unset", it is a deletion
  // the farmer never asked for and never sees.
  const stated = defaults?.availability;
  const [seasonKind, setSeasonKind] = useState<SeasonKind | "">(stated?.seasonKind ?? "");
  const [seasonStartMonth, setSeasonStartMonth] = useState(
    numberValue(stated?.seasonStartMonth),
  );
  const [seasonStartDay, setSeasonStartDay] = useState(numberValue(stated?.seasonStartDay));
  const [seasonEndMonth, setSeasonEndMonth] = useState(numberValue(stated?.seasonEndMonth));
  const [seasonEndDay, setSeasonEndDay] = useState(numberValue(stated?.seasonEndDay));
  const [seasonNames, setSeasonNames] = useState((stated?.seasonNames ?? []).join(", "));
  const [hoursKind, setHoursKind] = useState<HoursKind | "">(stated?.openHoursKind ?? "");
  const [openFrom, setOpenFrom] = useState(clockValue(stated?.openFromMinutes));
  const [openUntil, setOpenUntil] = useState(clockValue(stated?.openUntilMinutes));
  const [openDays, setOpenDays] = useState<number[]>(stated?.openDays ?? []);
  const [stockingKind, setStockingKind] = useState<StockingKind | "">(
    stated?.stockingCadence ?? "",
  );
  const [stockingDays, setStockingDays] = useState<number[]>(stated?.stockingDays ?? []);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * Change the address, and DISCARD any coordinate the old text resolved to (F-077).
   *
   * This is the sharp edge geocode-only placement creates. With no tap and no confirmation
   * gate, a farmer who looks up address A and then edits the text to address B would publish
   * A's coordinate labelled as B — a customer driven to the wrong place, with nothing on
   * screen indicating anything was wrong. Under F-069 a tap re-confirmed and the two could
   * not drift; now the only thing keeping the address and the point in agreement is that
   * ONE of them is derived from the other, and this is where that is enforced.
   */
  function changeAddress(next: string): void {
    setAddress(next);
    setPin(null);
    setLookupNote(null);
  }

  /**
   * Resolve the typed address to the coordinate the stand publishes at (F-077).
   *
   * **The lookup is now the ONLY source of a coordinate**, where F-069 made it a suggestion
   * the farmer confirmed by tapping the island. Every failure — no result, off the island, no
   * geocoder configured, a network error — REFUSES, and asks the farmer to correct the
   * address. There is no fallback, deliberately: the alternative was a coordinate that did not
   * come from the address printed next to it.
   */
  async function findAddress(): Promise<void> {
    if (lookingUp || address.trim() === "") return;
    setLookingUp(true);
    setLookupNote(null);
    try {
      const response = await fetch("/api/farmer/address-lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...credentialBody(credential), address }),
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
        setPin({ latitude: body.latitude, longitude: body.longitude });
        setLookupNote(null);
        return;
      }
      // Refusals. Each says what to do — correct the address — because that is now the only
      // thing that CAN be done. A failure leaves the stand unpublishable rather than placed
      // approximately, which is the whole of max's call on this.
      setPin(null);
      setLookupNote(
        body.status === "off_island"
          ? "That address does not look like it is on Vashon or Maury. Check the address " +
              "and try again."
          : body.status === "not_configured"
            ? "Address lookup is unavailable right now, so a stand people can visit cannot " +
                "be put on the map yet. Contact VIGA and they will sort it out."
            : "We could not find that address. Check the address and try again — a house " +
                "number and street name usually works best.",
      );
    } catch {
      setPin(null);
      setLookupNote(
        "We could not look that up. Check the address and your connection, then try again.",
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

  /**
   * Change a month, and drop the day if that month does not have it.
   *
   * Without this, picking March 31 and then switching to April leaves 31 selected in state and
   * SAVES an April date that does not exist — the picker would show a valid-looking form while
   * holding a day the farmer can no longer see in the list.
   */
  function changeMonth(
    month: string,
    day: string,
    setMonth: (value: string) => void,
    setDay: (value: string) => void,
  ): void {
    setMonth(month);
    const allowed = daysForMonth(month);
    if (day !== "" && !allowed.includes(Number(day))) setDay("");
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
  // F-077 — a visitable stand needs an address that RESOLVED. The pin is cleared whenever the
  // address text changes, so `pin !== null` means "this address, as currently typed, has a
  // coordinate" rather than merely "a coordinate was found at some point".
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
      const response = await fetch(LISTING_ENDPOINT[credential.kind], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...credentialBody(credential),
          standName,
          // Sent only when this door offers renaming. Omitted means "leave the farm's name
          // alone" at the boundary — never "set it to empty".
          ...(canRenameFarm ? { farmName: editedFarmName } : {}),
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
          // Always sent, even when blank: an empty box means the farmer CLEARED the paragraph,
          // which the boundary distinguishes from a door that states nothing about it.
          description,
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
                  : // F-072 — this farm gained a farmer while the form was open. Says what
                    // happened and what to do, rather than reading as the farmer's mistake.
                    body.error === "already_onboarded"
                    ? "Someone has already set this farm up on Farm Friend. If that was not " +
                      "you, contact VIGA."
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
    /*
      A CONFIRMATION, not a replacement.

      This used to return one sentence in place of the entire form. Everything the farmer had
      just typed disappeared, the card collapsed from a full screen to a single line, and the
      phone-verification card that had been below the fold the whole time snapped upward — so
      a save that changed no page read as being thrown onto a different screen, with no way
      to check or fix what had been sent.

      What replaces it says three things in the order a farmer asks them: what happened, what
      was recorded, and what to do next. Onboarding adds the hand-off to the text message,
      because there the next action is on a different device and must be announced rather
      than discovered.
    */
    const isOnboarding = credential.kind === "invitation";
    return (
      <div className="farmer-listing-saved" role="status">
        <p className="farmer-form-published">
          {isOnboarding ? "Your stand is on the map." : "Your changes are saved."}
        </p>

        <dl className="farmer-listing-summary">
          <div>
            <dt>Stand</dt>
            <dd>{standName.trim() === "" ? farmName : standName}</dd>
          </div>
          <div>
            <dt>Visitors</dt>
            <dd>
              {visitability === "visitable"
                ? "People can come to the stand"
                : "No stand to visit — you deliver or sell elsewhere"}
            </dd>
          </div>
          {address.trim() === "" ? null : (
            <div>
              <dt>Address</dt>
              <dd>{address}</dd>
            </div>
          )}
          {items.trim() === "" ? null : (
            <div>
              <dt>Usually sells</dt>
              <dd>{items}</dd>
            </div>
          )}
        </dl>

        <button
          className="farmer-listing-change"
          type="button"
          onClick={() => setSaved(false)}
        >
          Change something
        </button>

        <p className="farmer-listing-saved-next">
          {isOnboarding
            ? "Next: send one text from the phone you want to use for stand updates. It is the last step."
            : "You can change any of this later by texting SETTINGS."}
        </p>
      </div>
    );
  }

  const pinPoint =
    pin === null ? null : projectToIsland({ latitude: pin.latitude, longitude: pin.longitude });

  return (
    <form className="farmer-listing" onSubmit={(event) => void submit(event)}>
      {canRenameFarm && (
        <>
          <label htmlFor="farm-name">What is your farm called?</label>
          <input
            id="farm-name"
            type="text"
            value={editedFarmName}
            onChange={(event) => setEditedFarmName(event.target.value)}
            maxLength={120}
          />
          <p className="farmer-form-note">
            Your farm&apos;s name, shown on the map next to your stand.
          </p>
        </>
      )}

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
            // Editing DISCARDS the coordinate the previous text resolved to — see
            // `changeAddress`. This is what stops one address publishing under another.
            onChange={(event) => changeAddress(event.target.value)}
            placeholder="12345 Vashon Highway SW"
            maxLength={300}
          />
          {/*
            `type="button"` matters — inside a form a bare button submits, which would try to
            publish the listing on a lookup, with no coordinate and a refusal the farmer did
            not ask for.
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
            The map is a READ-ONLY DISPLAY of where the address resolved (F-077). It carries no
            click handler: there is no placement for a farmer to make, because the address is
            the only thing that decides the coordinate.

            It is not merely decoration, though, which is why it survived the pin picker. A
            coordinate published without ever being shown is one the farmer cannot sanity-check
            — and a geocoder putting a Vashon Highway address at the wrong end of the island is
            exactly the mistake a glance catches and no validation can.
          */}
          {pinPoint === null ? null : (
            <>
              <p className="farmer-listing-map-label" id="pin-instruction">
                Found it. This is where people will be sent — check it looks right.
              </p>
              <svg
                className="farmer-listing-map"
                viewBox={`0 0 ${ISLAND_VIEWBOX.width} ${ISLAND_VIEWBOX.height}`}
                role="img"
                aria-describedby="pin-instruction"
                aria-label="Map of Vashon and Maury Island, showing your stand's location."
              >
                <IslandArtwork />
                <g>
                  <circle
                    cx={pinPoint.x}
                    cy={pinPoint.y}
                    r={14}
                    className="farmer-listing-pin"
                  />
                </g>
              </svg>
            </>
          )}
          {lookupNote === null ? null : (
            <p className="farmer-form-note" role="status">
              {lookupNote}
            </p>
          )}
          {pin === null && lookupNote === null ? (
            <p className="farmer-form-note">
              Type your address and look it up, so people can find your stand.
            </p>
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
          <div className="farmer-listing-fields">
            <select
              id="season-start-month"
              value={seasonStartMonth}
              onChange={(event) =>
                changeMonth(
                  event.target.value,
                  seasonStartDay,
                  setSeasonStartMonth,
                  setSeasonStartDay,
                )
              }
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
            <select
              id="season-start-day"
              className="farmer-listing-daynum"
              value={seasonStartDay}
              onChange={(event) => setSeasonStartDay(event.target.value)}
            >
              <option value="">Day</option>
              {daysForMonth(seasonStartMonth).map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {seasonKind === "date_range" ? (
        <div className="farmer-listing-row">
          <label htmlFor="season-end-month">Closes</label>
          <div className="farmer-listing-fields">
            <select
              id="season-end-month"
              value={seasonEndMonth}
              onChange={(event) =>
                changeMonth(event.target.value, seasonEndDay, setSeasonEndMonth, setSeasonEndDay)
              }
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
            <select
              id="season-end-day"
              className="farmer-listing-daynum"
              value={seasonEndDay}
              onChange={(event) => setSeasonEndDay(event.target.value)}
            >
              <option value="">Day</option>
              {daysForMonth(seasonEndMonth).map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {seasonKind === "named_season" ? (
        <>
          <label htmlFor="season-names">Which seasons? (separate with commas)</label>
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
          <div className="farmer-listing-fields">
            <select
              id="open-from"
              className="farmer-listing-time"
              value={openFrom}
              onChange={(event) => setOpenFrom(event.target.value)}
            >
              <option value="">Time</option>
              {CLOCK_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
            {hoursKind === "clock_range" ? (
              <>
                <label htmlFor="open-until" className="farmer-listing-inline-label">
                  until
                </label>
                <select
                  id="open-until"
              className="farmer-listing-time"
                  value={openUntil}
                  onChange={(event) => setOpenUntil(event.target.value)}
                >
                  <option value="">Time</option>
                  {CLOCK_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </div>
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

      {/*
        THE FARM'S OWN PARAGRAPH, and the first farmer-facing surface that can change it.
        `farms.description` renders on the public card and was seeded from VIGA's forms with no
        writer anywhere, so a farmer publishing a clean listing kept stale prose underneath it.

        Prefilled with what is STORED rather than blank: the writer replaces it, so an empty box
        on an edit would erase the paragraph by omission — B-037's failure shape.
      */}
      <label htmlFor="stand-description">Anything else people should know?</label>
      <textarea
        id="stand-description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        rows={4}
        placeholder="We put a sign at the bottom of the driveway when the stand is open."
        maxLength={2000}
      />
      <p className="farmer-form-note">
        This shows on your card. Hours, payments and what you sell are already covered above —
        this is for anything they do not say.
      </p>

      {error === null ? null : (
        <p className="farmer-form-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy || !ready}>
        {busy ? "Submitting…" : "Submit"}
      </button>
    </form>
  );
}
