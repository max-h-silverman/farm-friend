"use client";

import { useEffect, useRef, useState } from "react";
// `unprojectFromIsland` is NO LONGER imported: F-077 removed the tap that needed it. It is
// deliberately still exported from the projection module — its own tests use it to prove the
// projection round-trips, which is load-bearing evidence for the FORWARD projection the public
// map depends on.
import { ISLAND_VIEWBOX, projectToIsland } from "@farm-friend/core/island-projection";
import {
  renderStandItemPrice,
} from "@farm-friend/core/item-price";
// TYPE-ONLY, so nothing in the database package reaches this client bundle. The shape is
// IMPORTED rather than restated: B-037 was a restated `ListingDefaults` drifting out of
// agreement with what the writer stores, and a second hand-written copy of these twelve
// fields is how that happens again.
import type { ListingAvailability, StandingItem } from "@farm-friend/db";
import { useTabCommit } from "../../../stand/[token]/details-panel";
import {
  buildKeywordSmsUrl,
  formatSmsNumberForDisplay,
} from "../../../../lib/farmer-invite";
import { IslandArtwork } from "../../../island-artwork";
import {
  StockInventoryEditor,
  initialStockUnitMode as initialUnitMode,
  stockItemPriceDraftToPrice,
  type StockItemPriceDraft,
} from "../../stock-item-row";

/**
 * One row of the inventory builder, as the FORM holds it (F-092).
 *
 * Every price field is a string because that is what an input's value is, and because the
 * columns behind them are `numeric` — routing money through a JS number on the way to a
 * `numeric` column is how `5.10` becomes `5.0999999999999996`. They are parsed once, at submit.
 */
interface ItemRow {
  name: string;
  priceAmount: string;
  priceQuantity: string;
  priceUnit: string;
  priceBasis: "per" | "for";
  /**
   * WHICH UNIT CONTROL this row is showing — the farmer's choice, held rather than inferred
   * (B-040).
   *
   * It used to be derived by asking whether `priceUnit` was one of `SUGGESTED_UNITS`, and
   * choosing "other" stored a single space so that the answer would be no. Nothing ever cleared
   * the space and nothing the farmer typed was in the list either, so the box never gave the
   * menu back. Any state a control can enter has to be one it can leave, and a value is the
   * wrong place to record a choice about a control.
   */
  unitMode: "menu" | "custom";
  inStock: boolean;
}

/**
 * The units the menu offers, and NOT a vocabulary the system understands (F-092).
 *
 * These are a shortcut for the common case, never a closed set: the menu's last entry opens a
 * box for the farmer's own word, and `price_unit` is free text precisely so a stand selling by
 * the half-flat or the cord can say so. No business code may branch on what is in this list —
 * it is a list of suggestions, and the day it becomes policy is the day it becomes a produce
 * taxonomy the architecture refuses.
 */
function priceDraft(row: ItemRow): StockItemPriceDraft {
  return {
    amount: row.priceAmount,
    quantity: row.priceQuantity,
    unit: row.priceUnit,
    basis: row.priceBasis,
    unitMode: row.unitMode,
  };
}

/**
 * One row's four boxes as the price the writer stores, or `null` (F-092).
 *
 * **A half-filled price is NOT a price**, and this is where that is decided for the form. An
 * amount with no unit, or a unit with no amount, is a farmer part-way through a thought — it
 * travels as "not stated" rather than as an object the database would refuse.
 *
 * `pricesPublic` gates it because max's call was that hidden means hidden (2026-08-08). The
 * values stay in React state either way, so the switch is reversible on screen; what this stops
 * is them reaching the database — and therefore any customer — while the farmer has prices off.
 */
function rowPrice(
  row: ItemRow,
  pricesPublic: boolean,
): { amount: string; quantity: string; unit: string | null; basis: "per" | "for" } | null {
  if (!pricesPublic) return null;
  return stockItemPriceDraftToPrice(priceDraft(row));
}

/**
 * F-067 / F-069 — the listing details a farmer fills in while onboarding.
 *
 * **EVERY farm is placed, and the visit question decides what the map INVITES** (F-088, max
 * 2026-08-07). The address comes first and is asked of everyone.
 *
 * It used to be the other way round: the visitability question came first and gated the address,
 * because `coherentVisitability` refused to store an address or a pin on a farm with no stand
 * (F-038 / B-024). Asking first would have collected a value the database then threw away.
 *
 * That constraint was relaxed to the shape it always meant — a location is complete or absent,
 * whoever it belongs to. The original defect was never the coordinate but the UNLABELLED
 * coordinate: a pin that silently implied "come here". A farm with no stand now renders with its
 * own marker ("Farm, no stand"), a card saying so, and NO directions link, so being findable and
 * being drivable-to have come apart. Every farmer gets found; only some invite the drive.
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
 * the unfilterable shape Farm Friend exists to replace. VIGA Farm Bucks remains a separate
 * boolean: VIGA grants eligibility, then an eligible farmer states whether they accept it.
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

/** Ordinary payment methods; VIGA Bucks has its own eligibility-gated toggle. */
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

/**
 * The wizard's steps, in the order a farmer answers them (F-090).
 *
 * The order is the farmer's, not the schema's: where the farm is, when it is open, what it
 * sells, and how to reach you. Each step is a question someone would actually ask in that
 * sequence, which is why the phone and the SMS agreement sit together at the end — they are
 * both about staying in touch, and the agreement gates Submit.
 *
 * A step is a VIEW over one always-mounted form (see `onStep`), so adding one here changes
 * what is on screen and never what is sent.
 */
const WIZARD_STEPS = ["farm", "open", "sell", "contact"] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

/** What each step calls itself at the top of the card, so a farmer knows where they are. */
const STEP_HEADINGS: Record<WizardStep, string> = {
  farm: "Your farm",
  open: "When you are open",
  sell: "What you sell",
  contact: "Staying in touch",
};

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
 * How much of the island stays in frame once the view settles on a resolved stand.
 *
 * **The coastline is the only thing there is to check a pin against.** Farm Friend draws the
 * island from its own artwork and has no map tiles — that is the "no permanent map package"
 * boundary, still shut. So a frame tight enough to crop the shoreline away leaves a dot on an
 * empty field: a confident-looking picture carrying no information, which is worse than no
 * picture at all.
 *
 * A third of the island's width keeps a recognisable stretch of shore beside the pin while
 * still being a real zoom. The `listing-step` suite asserts both halves of that — narrower
 * than the whole island, and not so narrow the coast is gone.
 */
const ZOOM_FRACTION = 1 / 3;

/**
 * The viewBox that frames a resolved stand, clamped to stay over the drawing.
 *
 * Clamping rather than centring blindly: a stand near a corner of the island would otherwise
 * be framed half off the artwork, filling the box with blank space exactly where the farmer
 * is looking for the shoreline.
 */
function zoomedFrame(point: { x: number; y: number }): Frame {
  const width = ISLAND_VIEWBOX.width * ZOOM_FRACTION;
  const height = ISLAND_VIEWBOX.height * ZOOM_FRACTION;
  const x = Math.min(
    ISLAND_VIEWBOX.width - width,
    Math.max(0, point.x - width / 2),
  );
  const y = Math.min(
    ISLAND_VIEWBOX.height - height,
    Math.max(0, point.y - height / 2),
  );
  return { x, y, width, height };
}

/** A viewBox as its four numbers, so two frames can be interpolated between. */
interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WHOLE_FRAME: Frame = {
  x: 0,
  y: 0,
  width: ISLAND_VIEWBOX.width,
  height: ISLAND_VIEWBOX.height,
};

function frameAttribute(frame: Frame): string {
  return `${frame.x} ${frame.y} ${frame.width} ${frame.height}`;
}

/** The inverse of `frameAttribute`, so the animation can read its target from its dependency. */
function parseFrame(attribute: string): Frame {
  const [x, y, width, height] = attribute.split(/\s+/).map(Number);
  return { x: x!, y: y!, width: width!, height: height! };
}

/** Ease-out cubic — quick to leave, gentle to arrive, which is how a camera settles. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

const ZOOM_MS = 520;

/**
 * The animated frame, travelling toward wherever the pin currently puts it.
 *
 * **Animated here rather than in CSS**, because `viewBox` is an SVG attribute: the CSS
 * `view-box` property that would transition it is too thinly supported to depend on, and where
 * it is absent the frame snaps — losing the travel that is the whole point. A `requestAnimation
 * Frame` loop behaves identically everywhere.
 *
 * The motion is what carries the meaning — a farmer watching the view arrive at the north end
 * has checked "right end of the island?" before reading the pin — so `prefers-reduced-motion`
 * lands on the SAME settled frame instantly rather than on a different one. No movement, no
 * information lost.
 */
function useZoomedViewBox(pinPoint: { x: number; y: number } | null): string {
  const target = pinPoint === null ? WHOLE_FRAME : zoomedFrame(pinPoint);
  const [frame, setFrame] = useState<Frame>(target);
  const fromRef = useRef<Frame>(target);
  /*
    The target as its four numbers, and the effect's ONLY dependency.

    `target` itself is a fresh object on every render, so depending on it would tear down and
    restart the travel on each animated frame — the view would jitter at the start and never
    arrive. The string is the same for equal frames, so the effect re-runs exactly when the
    destination really changes.

    It is also what the effect READS, via `parseFrame`. Deriving `to` from the dependency
    rather than closing over `target` is what keeps the two from drifting.
  */
  const targetKey = frameAttribute(target);

  useEffect(() => {
    const to = parseFrame(targetKey);
    const from = fromRef.current;
    if (frameAttribute(from) === frameAttribute(to)) return;

    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof requestAnimationFrame !== "function") {
      fromRef.current = to;
      setFrame(to);
      return;
    }

    const started = performance.now();
    let raf = 0;
    const step = (now: number): void => {
      const progress = Math.min(1, (now - started) / ZOOM_MS);
      const eased = easeOut(progress);
      const next: Frame = {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        width: from.width + (to.width - from.width) * eased,
        height: from.height + (to.height - from.height) * eased,
      };
      setFrame(next);
      if (progress < 1) {
        raf = requestAnimationFrame(step);
        return;
      }
      fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [targetKey]);

  return frameAttribute(frame);
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
  /**
   * F-088 — whether the address is shown to customers. B-037's rule again: the writer sets this
   * column on every save, so an edit form that could not see it would republish an address the
   * farmer had deliberately hidden.
   */
  addressPublic: boolean;
  /**
   * F-092 — whether this stand shows prices at all. B-037's rule once more: the writer sets this
   * column on every save, so a form that could not see it would switch a farmer's prices back
   * off the next time they edited their hours.
   */
  pricesPublic: boolean;
  /** VIGA controls eligibility; the farmer only states whether they accept it. */
  /**
    * Whether the SELLER takes VIGA Farm Bucks (F-125). Hers, applying at every stand she
    * sells at — there is no per-stand eligibility grant behind it any more.
    */
  farmBucksAccepted?: boolean;
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
  /**
   * What the stand usually sells, each with its optional price (F-090).
   *
   * B-037's rule for the newest field: `saveOnboardingListing` rewrites every item row on
   * every save, so a price this form could not see would be deleted by the next edit — with
   * nothing failing, because the writer would be doing exactly what it says it does.
   */
  items: StandingItem[];
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

/**
 * Where a farmer sells (F-117), as the one question she is actually asked.
 *
 * The four answers are the crossing of the two facts stored underneath — whether her own place
 * can be visited, and whether she sells at somebody else's stand. Naming the crossing rather
 * than the two axes is what lets the form ask once.
 */
type SellsWhere = "own_only" | "host_only" | "both" | "neither";

/** What each answer means for `visitability` — a fact about HER place, and nothing else. */
const VISITABILITY_OF: Record<SellsWhere, "visitable" | "contact_only"> = {
  own_only: "visitable",
  both: "visitable",
  // She has no stand of her own to visit. Selling at somebody else's does not make one:
  // `visitability` describes this farm's place, and the host's stand is a different record.
  host_only: "contact_only",
  neither: "contact_only",
};

/**
 * The answer a prefilled listing implies.
 *
 * Only `visitability` is prefilled, so this recovers the two answers that fact determines and
 * never guesses at a host arrangement. A returning farmer who sells at somebody else's stand
 * sees "just my own stand" until she says otherwise — understating an arrangement she can
 * restate, rather than inventing one she never made.
 */
function sellsWhereFromDefaults(
  visitability: "visitable" | "contact_only" | null | undefined,
): SellsWhere | null {
  if (visitability === "visitable") return "own_only";
  if (visitability === "contact_only") return "neither";
  return null;
}

export function ListingStep({
  credential,
  farmName,
  defaults,
  description: initialDescription,
  smsNumber,
  mapUrl,
  hostStandChoices = [],
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
  /**
   * The public map, so the confirmation's own word points at it (max, 2026-08-09).
   *
   * Passed in rather than read here: this is a client component, and `PUBLIC_MAP_URL` is
   * server configuration. Optional because a door rendered without it must still state that
   * the farm is live — the link is an improvement on the sentence, not a condition of it.
   */
  mapUrl?: string;
  /**
   * Farm Friend's own SMS number, for the "text VIGA to finish" hand-off.
   *
   * **The farmer texts US, and that direction is forced.** `isProactiveSendPermitted` allows a
   * send to a number with no consent record only for `required_reply` — the carrier-required
   * answer to that recipient's own message — and `authorizeDispatch` suppresses everything
   * else. So Farm Friend cannot send the first text, and their inbound message is what serves
   * as both the possession proof and the opt-in.
   *
   * Absent on a door that has no hand-off to announce (the edit form, where the farmer is
   * already set up).
   */
  smsNumber?: string;
  /**
   * The stands she may say she sells at (F-117), from `listHostStandChoices`.
   *
   * **A picker, never free text** (max, 2026-08-17): a typed name would be ambiguous about
   * which stand was meant and would make the host Farm Friend then texts a guess. Picking a
   * real stand makes the host unambiguous.
   *
   * Empty or absent asks the question at all — an island with no stands to pick is a question
   * with no answers, and asking it would invite a farmer to tick something she cannot finish.
   */
  hostStandChoices?: { standId: string; name: string }[];
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
  /*
    F-117 — WHERE SHE SELLS. One question, four answers (max, 2026-08-17).

    Underneath it is still two independent facts: `visitability` says whether HER place can be
    visited, and the host arrangement says where else she sells. They stay two columns, because
    they are two different kinds of fact and one of them is about a record that is not hers.

    But they were also two QUESTIONS on the form, and that was wrong. A farmer does not hold
    "is my place visitable?" and "do I also sell elsewhere?" as separate thoughts — she holds
    one: where do I sell? The four answers below are the crossing of the two columns, which is
    exactly the set she can actually be in. Asking it as one question means she picks the
    sentence that describes her, and the form works out which columns that implies.
  */
  const [sellsWhere, setSellsWhere] = useState<SellsWhere | null>(
    defaults === undefined ? null : sellsWhereFromDefaults(defaults.visitability),
  );
  const [hostStandId, setHostStandId] = useState("");

  /* The two columns, derived. Neither is stored twice — this IS where each one comes from. */
  const visitability = sellsWhere === null ? null : VISITABILITY_OF[sellsWhere];
  const sellsAtHostStand = sellsWhere === "host_only" || sellsWhere === "both";
  const [address, setAddress] = useState(defaults?.publicAddress ?? "");
  // F-088 — public unless the farmer says otherwise, matching the column default and every row
  // that predates it. `!== false` rather than `?? true` so a door that omits it cannot hide an
  // address by accident.
  const [addressPublic, setAddressPublic] = useState(defaults?.addressPublic !== false);
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
  const [farmBucksAccepted, setFarmBucksAccepted] = useState(
    defaults?.farmBucksAccepted === true,
  );
  /*
    Whether this door may state what is on the table TODAY.

    Onboarding only. An already-onboarded farmer reports today's stock on their status tab,
    through the proposal-and-confirmation gate — offering it here as well would be two ways
    to make one claim, by two different routes, with two different provenances.

    Declared ABOVE the item rows because it is what they default `inStock` to.
  */
  const isOnboardingDoor = credential.kind !== "stand_link";
  const asksForCurrentStock = isOnboardingDoor;

  /*
    WHAT THE STAND USUALLY SELLS, one row per item (F-090).

    Was a single comma-separated string. Each item now carries an optional price and, during
    onboarding, whether it is on the table today — neither of which fits in a comma list
    without inventing a syntax the farmer has to learn.

    `inStock` lives here rather than in its own parallel array for the same reason the price
    does: two lists indexed against each other drift the moment one is filtered.
  */
  const [itemRows, setItemRows] = useState<ItemRow[]>(
    (defaults?.items ?? []).map((item) => ({
      name: item.name,
      // The price as FOUR FIELDS, all strings, because an input's value must be one. They are
      // mapped back to a price object — or to null — on submit. A stored null and a farmer's
      // cleared boxes are the same fact, not stated, so collapsing them here is right.
      //
      // The defaults are what an unpriced row starts with: a quantity of one and the `per`
      // basis, which together are the sentence "$_ / _" waiting for its two blanks. Starting
      // `for` or with an empty quantity would make the common case the one needing work.
      priceAmount: item.price?.amount ?? "",
      priceQuantity: item.price?.quantity ?? "1",
      priceUnit: item.price?.unit ?? "",
      priceBasis: item.price?.basis ?? "per",
      // The ONE place the suggestion list decides a control (B-040). A farmer's own word — "cord",
      // "half-flat" — has to arrive in the box that can show it; after that the row holds the mode.
      unitMode: initialUnitMode(item.price?.unit),
      // IN STOCK BY DEFAULT wherever the control is offered (max, 2026-08-08) — same rule as a
      // newly typed row below, so a farmer whose listing VIGA already prefilled does not see
      // half their items on and half off. The edit door never asks, so this is always false
      // there and is never sent.
      inStock: asksForCurrentStock,
    })),
  );
  const [draftItem, setDraftItem] = useState("");
  /**
   * F-092 — whether this stand prices anything, one switch for the whole section.
   *
   * max's call (2026-08-08): one decision rather than one per row. A farmer either prices their
   * goods or does not, and asking per item would put the same question in front of them as many
   * times as they have items.
   *
   * OFF HIDES THE LINE AND WITHHOLDS THE PRICES, but never clears them: the amounts stay in
   * state and stay saved, so a farmer who switches it off and on again finds their work. That is
   * the same shape `addressPublic` has — the fact is stored, and one boolean decides whether it
   * is shown.
   */
  const [pricesPublic, setPricesPublic] = useState(defaults?.pricesPublic === true);

  /** Add whatever is in the draft box, ignoring blanks and exact repeats. */
  function addItem(): void {
    const name = draftItem.trim();
    if (name === "") return;
    // Case-insensitively already present is a no-op rather than a second row: the database's
    // unique index folds case and surrounding whitespace, so two rows differing only in case
    // would silently collapse on save and lose one farmer's price.
    const already = itemRows.some(
      (row) => row.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (!already) {
      setItemRows((rows) => [
        ...rows,
        {
          name,
          priceAmount: "",
          // The same starting shape a prefilled unpriced row gets — see the state above.
          priceQuantity: "1",
          priceUnit: "",
          priceBasis: "per",
          unitMode: "menu",
          /*
            IN STOCK BY DEFAULT, on the door that asks (max, 2026-08-08).

            A farmer setting up their stand is describing what is on the table as they type it,
            so "yes, it is there" is the answer they already mean — and a toggle they must
            switch ON is one they leave off by omission, which publishes a stand with nothing
            on it. `asksForCurrentStock` is what keeps this to onboarding: the edit door never
            renders the control, so there is nothing there to default.

            It still publishes nothing on its own. The claim is held on the invitation until
            the farmer's VIGA text proves the handset, because a dated claim needs someone to
            stand behind it.
          */
          inStock: asksForCurrentStock,
        },
      ]);
    }
    setDraftItem("");
  }

  function setItemPrice(index: number, price: StockItemPriceDraft): void {
    setItemRows((rows) =>
      rows.map((row, at) =>
        at === index
          ? {
              ...row,
              priceAmount: price.amount,
              priceQuantity: price.quantity,
              priceUnit: price.unit,
              priceBasis: price.basis,
              unitMode: price.unitMode,
            }
          : row,
      ),
    );
  }

  function toggleItemStock(index: number): void {
    setItemRows((rows) =>
      rows.map((row, at) => (at === index ? { ...row, inStock: !row.inStock } : row)),
    );
  }

  function removeItem(index: number): void {
    setItemRows((rows) => rows.filter((_, at) => at !== index));
  }
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

  /*
    THE PHONE THE FARMER WILL TEXT FROM, and the confirmation of it (max 2026-08-07).

    This replaces `JOIN <token>`. That grammar asked the farmer to hand-copy 64 hex characters
    from this page into a text message, where a single transcription slip failed identically and
    silently — the token matched no invitation, and nothing could distinguish "you mistyped"
    from "no invitation exists". Stating the phone here moves the farm identity onto a field the
    farmer is already filling in, so the message they send is one carrier-registered word.

    **Asked only where it can be acted on.** An invited farmer is the one whose invitation has a
    column to hold it; a farmer editing an existing listing already has a verified handset, and
    asking again would invite a change this form has no power to make.

    `confirming` holds the submission open while the modal shows the number back. A mistyped
    number is otherwise INVISIBLE: the farmer texts VIGA from their real phone, matches
    nothing, and waits, with nothing on screen wrong. Reading it back is the only check
    available before the message is sent.
  */
  /*
    THE TWO PRESENTATIONS, and the single fact that chooses between them (F-090, max
    2026-08-08).

    Onboarding is a WIZARD: one thing at a time, in order, because a farmer setting up is
    doing it once and should not face every field at once. Editing is FLAT — the caller
    wraps it in tabs — because a farmer who came back for one field must not be marched
    through five screens to reach it.

    **Both render the same fields from the same state, and every field stays MOUNTED.** The
    step only decides what is VISIBLE. Unmounting would drop the farmer's answers on every
    Back, and `saveOnboardingListing` replaces the whole listing — so a field the form could
    not see would be a field the save deletes (B-037's shape, which this codebase has now
    hit twice).
  */
  const steps = credential.kind === "stand_link" ? null : WIZARD_STEPS;
  /**
   * Whether this door EDITS a listing that already exists, rather than publishing a new one.
   *
   * Separate from `steps === null` even though today they agree: one is about whether the
   * form is paginated, the other about what the farmer is doing. Conflating them is what put
   * an onboarding "Submit" on the returning farmer's tab (F-098).
   */
  const isEditingDoor = credential.kind === "stand_link";
  /**
   * The tab this form is composed into, when it is composed into one (F-098).
   *
   * `null` on every onboarding door and on the standalone listing page — there is no companion
   * panel there, and this form's button commits only itself.
   */
  const tabCommit = useTabCommit();
  const [step, setStep] = useState(0);
  const onStep = (which: WizardStep): boolean =>
    steps === null || steps[step] === which;

  const asksForPhone = !isEditingDoor;
  const [phone, setPhone] = useState("");
  const [confirming, setConfirming] = useState(false);

  /*
    THE SMS AGREEMENT, now INSIDE this form and directly above Submit (max 2026-08-07).

    It was a separate card below the whole form, which read as a second errand: a farmer could
    fill in every field and submit having never scrolled to the disclosures. Folding it in makes
    agreeing a condition of submitting, which is what it always was in substance.

    **The tick is not consent and this component does not claim it is.** It stamps provenance —
    these disclosures were shown on this invitation and accepted at this time — and that stamp
    is what the carrier receipt claims we collect and what gates authorization when the farmer's
    `VIGA` arrives. Consent itself is written only by that inbound message, because a tick on a
    web page says nothing about who holds the handset.

    Stamped on the TICK rather than at submit, deliberately: the stamp must exist before the
    listing publishes, and doing it here means a farmer who ticks and then abandons the form has
    still recorded what they were shown — which is the honest record of what happened.

    Withdrawing the tick does not un-stamp. The stamp is provenance of a disclosure being
    accepted, and rewriting history because someone changed their mind would falsify it; what
    the untick does is re-block Submit.
  */
  const asksForAgreement = !isEditingDoor;
  const [agreed, setAgreed] = useState(false);
  const [agreeing, setAgreeing] = useState(false);
  const [agreeError, setAgreeError] = useState<string | null>(null);
  const [showCompletionIssues, setShowCompletionIssues] = useState(false);

  /*
    HOW OFTEN WE WILL TEXT THEM, asked where they agree to be texted (max, 2026-08-08).

    Every farmer was put on `weekly` by `seedDefaultPromptPreference` and told nothing about
    it. The setting existed on the stand page's settings tab — behind a link they receive
    after this — so the first a farmer learned of their own reminder schedule was a text
    arriving, which is exactly the surprise the SMS agreement above is meant to prevent.

    Directly below the agreement and above Submit, because it is the same subject: the tick
    says "you may text me", and this says "this often". Asking it anywhere else would separate
    a consequence from the consent it follows from.

    Defaulted to `weekly` rather than blank, because that IS what the farmer gets today — a
    blank choice would be a required field invented out of a default nobody complained about.
    The value only rides along if this door can hold it: it lands on the invitation and is
    applied when their `VIGA` text creates the authorization the preference row needs.
  */
  const asksForCadence = !isEditingDoor;
  const [promptCadence, setPromptCadence] = useState<
    "every_2_days" | "weekly" | "every_2_weeks" | "paused"
  >("weekly");

  async function toggleAgreement(checked: boolean): Promise<void> {
    setAgreeError(null);
    if (!checked) {
      setAgreed(false);
      return;
    }
    /*
      THE GRANDFATHERED DOOR HAS NOTHING TO STAMP YET (F-098).

      The pre-stamp writes `agreed_to_sms_at` onto a row that already exists — an invitation
      VIGA issued. On the self-issued door that row is CREATED at submit, so there is nothing
      to write to while the farmer is still filling the form; the agreement rides in the submit
      body and is stamped as the claim is written.

      Ticking is therefore local here. The guarantee is unchanged either way: no tick, no
      submit — and on this door no claim row at all, so a farmer who abandons the form has
      recorded nothing to be attributed to.
    */
    if (credential.kind === "grandfathered") {
      setAgreed(true);
      return;
    }
    if (agreeing) return;
    setAgreeing(true);
    try {
      const response = await fetch("/api/farmer/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The token travels in the BODY, never a query string — a credential in a URL lands in
        // server logs and browser history by default.
        body: JSON.stringify(credentialBody(credential)),
      });
      if (!response.ok) {
        setAgreeError(
          "This invitation is no longer available. Ask the VIGA coordinator who invited you " +
            "for a new link.",
        );
        return;
      }
      setAgreed(true);
    } catch {
      setAgreeError("That did not go through. Check your connection and try again.");
    } finally {
      setAgreeing(false);
    }
  }

  /*
    The pin's place on the drawing, and the frame that travels toward it.

    Both computed HERE, above the `saved` early return, because `useZoomedViewBox` is a hook:
    below that return it would be skipped whenever the form is in its saved state, which is a
    conditional hook call and a real bug rather than a lint complaint.
  */
  const pinPoint =
    pin === null
      ? null
      : projectToIsland({ latitude: pin.latitude, longitude: pin.longitude });
  const mapViewBox = useZoomedViewBox(pinPoint);

  /**
   * Whether the address on screen is one the farmer could usefully press Save on.
   *
   * "Saved" is `pin !== null`, and that is not a shortcut — a coordinate exists exactly when
   * it was derived from the characters currently in the field. `changeAddress` discards the
   * pin on every keystroke, so the two can never disagree; and an edit form arrives holding
   * the coordinate stored beside the address it is showing, which is the same state reached
   * by a different door.
   *
   * So this covers all three of the button's off states with one expression: nothing typed,
   * the typed address already resolved, and a lookup in flight. A refusal clears the pin, so
   * the button comes back on by itself for a farmer who needs to try again.
   */
  const addressSaved = pin !== null;
  const canSaveAddress = !lookingUp && !addressSaved && address.trim() !== "";

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
    // The same condition the button is disabled on, enforced here too because `Enter` reaches
    // this without passing through the button at all. Without it the key would re-run a lookup
    // on an address already resolved, spending a geocoder call to reach the state on screen.
    if (!canSaveAddress) return;
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
      /*
        Refusals. Each says what to do — correct the address — because that is now the only
        thing that CAN be done. A failure leaves the stand unpublishable rather than placed
        approximately, which is the whole of max's call on this.

        These branches used to clear the pin as well, defensively. They no longer can: this
        function only runs when `canSaveAddress`, which requires there to be no pin — so by the
        time a refusal lands there is nothing to clear, and the clearing was a second mechanism
        asserting a fact `changeAddress` already owns outright. One place, not two.
      */
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
      // No `setPin(null)` here either, and for the same reason as the refusal branch above.
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

  // F-077 — a stand needs an address that RESOLVED. The pin is cleared whenever the
  // address text changes, so `pin !== null` means "this address, as currently typed, has a
  // coordinate" rather than merely "a coordinate was found at some point".
  /*
    F-088 — EVERY farm is placed, so the address requirement no longer depends on the answer.

    It used to read `!visitable || (…)`: an address was required of a visitable stand and
    forbidden of anything else, because the database refused to store one. Now every farm gives
    an address and a resolved pin, and the visit question only decides what the map INVITES —
    the marker, the warning line, the suppressed directions link.

    `pin !== null` still means "this address, as currently typed, resolved" (F-077), so an
    address the geocoder cannot place still cannot be published by anyone.
  */
  /*
    A US/CA number, by the same rule `normalizePhone` applies at the boundary.

    Ten digits, or eleven starting with 1 — punctuation and spacing ignored, because a farmer
    types what their thumbs produce and the shape is the boundary's job to normalize. Checked
    here as well so the refusal happens on the form, in place, rather than after a round trip
    that reads as "that did not save".
  */
  function phoneLooksReal(value: string): boolean {
    const digits = value.replace(/\D/g, "");
    return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  }

  const farmDetailsReady =
    standName.trim() !== "" &&
    visitability !== null &&
    address.trim() !== "" &&
    pin !== null &&
    // F-117 — a ticked box with no stand chosen is half an answer: she said she sells somewhere
    // else and named nowhere, so the host Farm Friend would text is nobody. It gates Submit for
    // the same reason the SMS agreement does — the alternative is discoverable only by absence.
    !(sellsAtHostStand && hostStandId === "");
  const contactDetailsReady =
    // The phone is what ties the handset to the farm, so an invited farmer without a usable one
    // has no way to finish. Blocking here beats publishing a listing they cannot complete.
    (!asksForPhone || phoneLooksReal(phone)) &&
    /*
      No tick, no submit. Without `agreed_to_sms_at` the redemption authorizes NOBODY — so a
      farmer who published without it would text VIGA, get enrolled for messages, and find no
      farm set up, with nothing on screen or in the reply explaining why.

      Blocking here is what keeps that from being discoverable only by its absence.
    */
    (!asksForAgreement || agreed);
  const completionIssue = (step: WizardStep, message: string) => ({ step, message });
  const completionIssues: { step: WizardStep; message: string }[] = [
    ...(standName.trim() === ""
      ? [completionIssue("farm", "Enter your farm's name.")]
      : []),
    ...(address.trim() === ""
      ? [completionIssue("farm", "Enter your farm address.")]
      : pin === null
        ? [completionIssue("farm", "Find your farm on the map.")]
        : []),
    ...(visitability === null
      ? [completionIssue("farm", "Choose whether people can visit your stand.")]
      : []),
    // F-117 — she said she sells somewhere else and named nowhere, so the host we would text
    // is nobody. Half an answer is exactly the mis-pick the confirmation exists to catch.
    ...(sellsAtHostStand && hostStandId === ""
      ? [completionIssue("farm", "Choose the stand where you sell.")]
      : []),
    ...(asksForPhone && !phoneLooksReal(phone)
      ? [completionIssue("contact", "Enter a valid phone number.")]
      : []),
    ...(asksForAgreement && !agreed
      ? [completionIssue("contact", "Agree to receive texts from VIGA Farm Friend.")]
      : []),
  ];
  const visibleCompletionIssues =
    steps === null
      ? completionIssues
      : completionIssues.filter((issue) => issue.step === steps[step]);
  const firstIncompleteStep: WizardStep | null = !farmDetailsReady
    ? "farm"
    : !contactDetailsReady
      ? "contact"
      : null;
  const ready = firstIncompleteStep === null;

  /**
   * Submitting the form, which on the invited door OPENS THE CONFIRMATION rather than posting.
   *
   * The gate is here rather than inside `send` so that nothing — no network call, no published
   * listing — happens until the farmer has read their number back. `send` is what the modal's
   * confirm button calls.
   */
  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (busy) return;
    if (!ready) {
      if (steps !== null && firstIncompleteStep !== null) {
        setStep(WIZARD_STEPS.indexOf(firstIncompleteStep));
      }
      setError(null);
      setShowCompletionIssues(true);
      return;
    }
    setShowCompletionIssues(false);
    if (asksForPhone) {
      setError(null);
      setConfirming(true);
      return;
    }
    void send();
  }

  async function send(): Promise<void> {
    if (busy || !ready) return;
    setConfirming(false);
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
          // F-088 — the location is sent for EVERY farm, not only a visitable one. It used to
          // be conditional because the database refused an address on a farm with no stand;
          // that is what changed. `visitability` still travels beside it and is what decides
          // the marker, the "no stand to visit" line, and whether directions are offered.
          // F-117 — sent only when she said she sells somewhere else AND picked where. Always
          // sending it would attach every onboarding farmer to whichever stand was first.
          ...(sellsAtHostStand && hostStandId !== ""
            ? { hostStandId }
            : {}),
          publicAddress: address,
          // F-088 — sent with the address it governs. Always sent, never conditional on being
          // false: the writer sets this column on every save, so omitting it would reset a
          // hidden address back to public on the farmer's next edit.
          addressPublic,
          // F-092 — sent on every save for the same reason `addressPublic` is: the writer sets
          // this column unconditionally, so omitting it would switch a farmer's prices back off
          // the next time they edited anything else.
          pricesPublic,
          latitude: pin?.latitude ?? null,
          longitude: pin?.longitude ?? null,
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
          farmBucksAccepted,
          // F-090 / F-092 — name and price as one pair per item. A price that is not fully
          // stated travels as `null`, never as a half-filled object: the database refuses that
          // shape, and "not stated" is a different fact from a price of nothing.
          items: itemRows.map((row) => ({
            name: row.name,
            price: rowPrice(row, pricesPublic),
          })),
          /*
            TODAY'S STOCK, sent only by a door that asked (F-090).

            Omitted entirely rather than sent empty, and the difference is load-bearing: an
            empty array would be the farmer stating their stand is EMPTY today, which the
            boundary and the column both refuse. Absent means they said nothing about today.

            This does NOT publish here. It is held on the invitation until the farmer's
            VIGA proves the handset, because a dated claim needs someone to stand behind
            it — see `recordFarmerInvitationPendingStock`.
          */
          ...(asksForCurrentStock && itemRows.some((row) => row.inStock)
            ? {
                currentStock: itemRows
                  .filter((row) => row.inStock)
                  .map((row) => {
                    // `inventory_entries.price_text` is STILL FREE TEXT — F-092 restructured
                    // `stand_items` only. So today's stock carries the rendered sentence rather
                    // than the parts, which is also the honest shape for that column: it holds
                    // what a farmer said about one day, not a price list to compute over.
                    const rendered = renderStandItemPrice(rowPrice(row, pricesPublic));
                    return {
                      itemName: row.name,
                      ...(rendered === null ? {} : { priceText: rendered }),
                    };
                  }),
              }
            : {}),
          // Always sent, even when blank: an empty box means the farmer CLEARED the paragraph,
          // which the boundary distinguishes from a door that states nothing about it.
          description,
          // The phone the farmer will text VIGA from, sent RAW for the boundary to normalize
          // and hash. Only the invited door asks for it, and only that door has a column to
          // hold it — omitted means "this door states nothing about a phone", never "clear it".
          ...(asksForPhone ? { phone } : {}),
          // F-097 — the reminder schedule, sent only by the door that asked. Omitted means
          // "this door states nothing about it", and the farmer keeps the default.
          ...(asksForCadence ? { promptCadence } : {}),
          /*
            THE AGREEMENT, sent by the door whose claim row does not exist yet (F-098).

            The invited door stamps `agreed_to_sms_at` on its invitation the moment the farmer
            ticks, so its submit says nothing about it. The self-issued door has no row to stamp
            until this request creates one — so the tick travels with it, and the writer refuses
            a phone that arrives without it.
          */
          ...(credential.kind === "grandfathered" && asksForPhone
            ? { agreedToSms: agreed }
            : {}),
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

      /*
        THE COMPANION PANEL, saved by the same press (F-098).

        The editing tab shows this form and the settings panel as one screen, so it commits as
        one. The panel keeps its own writers — merging them would put the participant save,
        which has its own audit event and its own public-text refusal, behind the listing
        request — but the FARMER presses once.

        Runs only after the listing write succeeded, and its failure is reported HERE rather
        than swallowed: "Your changes are saved." over a screen where the seller names did not
        take is the shape of lie this codebase refuses.
      */
      if (tabCommit !== null) {
        const companionSaved = await tabCommit.alsoSave();
        if (!companionSaved) {
          setError(
            "Your stand details saved, but your settings did not. Check the settings below " +
              "and try again.",
          );
          return;
        }
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
    // A door that PUBLISHES a stand rather than editing one: the invited form and F-079's
    // migration door both put a farm on the map for the first time.
    return (
      <div className="farmer-listing-saved" role="status">
        {/*
          THE WORD "MAP" IS THE LINK (max, 2026-08-09). A farmer who reads "live on the map!"
          has nowhere to go and confirm it; linking the noun keeps the sentence one sentence
          rather than appending a second one pointing back at it.

          `target="_blank"` because they just submitted a form: Back would return them to a
          completed page. `rel` carries `noopener` — a tab this opens must not reach back into
          the page that opened it.
        */}
        <p className="farmer-form-published">
          {isOnboardingDoor ? (
            <>
              Your farm is live on the{" "}
              {mapUrl === undefined ? (
                "map"
              ) : (
                <a
                  className="farmer-listing-map-link"
                  href={mapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  map
                </a>
              )}
              !
            </>
          ) : (
            "Your changes are saved."
          )}
        </p>

        {/*
          THE HAND-OFF, and the step VIGA used to perform by hand. The page this replaces said
          "contact VIGA and they will finish setting you up" — a coordinator doing what the
          farmer can do themselves in one text.

          Directly under the good news (max, 2026-08-08), moved here from the confirm modal. It
          sits ABOVE the summary rather than after it: a farmer who reads "live on the map" and
          stops has done everything except the one step that turns on texting for them, so the
          errand cannot wait below a list they may not scroll.

          The word is VIGA, never JOIN or CONFIRM. Telnyx treats it as a registered opt-in
          keyword and sends the phone-confirmation receipt. START remains the carrier recovery
          keyword for a farmer who has opted out, but new onboarding teaches VIGA.

          `sms:` rather than plain text so a farmer reading this on a phone taps once and the
          message is composed for them. The LINK keeps the raw E.164 — that is what a handset
          dials — while the visible text is the readable form; formatting the href would be a
          dead link. The number is shown as well, because this page is also read on a laptop
          where the link does nothing.
        */}
        {isOnboardingDoor ? (
          <div className="farmer-listing-saved-reminder">
            {/*
              The number is CONFIGURATION and can be absent (`TELNYX_FROM_NUMBER` unset), but
              the instruction must not be: gating the whole block on it left a farmer with no
              last step named at all on a screen that otherwise reads as finished. Without a
              number they are told to text VIGA and where to find it; with one, they tap.
            */}
            {smsNumber === undefined ? (
              <p>
                One last step: text <strong>VIGA</strong> to VIGA Farm Friend from the phone
                you want to use.
              </p>
            ) : (
              <p>
                One last step: text <strong>VIGA</strong> to{" "}
                <a href={buildKeywordSmsUrl(smsNumber, "VIGA")}>
                  {formatSmsNumberForDisplay(smsNumber)}
                </a>
                .
              </p>
            )}
            {/*
              WHY it must be that handset — joined to the instruction it explains (max
              2026-08-08). These were two paragraphs separated by the whole summary list and
              the "Change something" button: the farmer read "text VIGA" at the top, and the
              reason it had to come from a particular phone somewhere below the fold, minutes
              later or never. One errand, one block.
            */}
            <p>
              It has to come from the phone you will send stand updates from — we cannot text
              you until it does.
            </p>
            <hr className="farmer-listing-saved-reminder-divider" />
          </div>
        ) : null}

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
              {/* Says which choice was recorded, so a farmer who ticked the box can see it took. */}
              <dd>{addressPublic ? address : `${address} — hidden from customers`}</dd>
            </div>
          )}
          {itemRows.length === 0 ? null : (
            <div>
              <dt>Usually sells</dt>
              {/*
                Priced items read back WITH their price, through the same renderer the public
                card uses — so what the farmer confirms here is character for character what a
                customer will see, rather than a second formatting of the same parts.
              */}
              <dd>
                {itemRows
                  .map((row) => {
                    const rendered = renderStandItemPrice(rowPrice(row, pricesPublic));
                    return rendered === null ? row.name : `${row.name} ${rendered}`;
                  })
                  .join(", ")}
              </dd>
            </div>
          )}
          {itemRows.some((row) => row.inStock) ? (
            <div>
              <dt>In stock</dt>
              {/*
                Says what will happen rather than claiming it already has. This is held
                until the farmer's VIGA text arrives, and a summary implying it is already
                public would be the form making a claim the system has not made.
              */}
              <dd>
                {itemRows
                  .filter((row) => row.inStock)
                  .map((row) => row.name)
                  .join(", ")}{" "}
                — goes live when you text VIGA
              </dd>
            </div>
          ) : null}
        </dl>

        {/*
          NO "CHANGE SOMETHING" BUTTON (max, 2026-08-08).

          It reopened the form in place, and it was the wrong offer at the wrong moment: the
          farmer's next action is the one text that turns their texting on, and a second control
          competing with it costs completions. Changing a listing is a real errand with a real
          home — the stand page, reached by the link they are about to be sent — so this screen
          does not need to be a second door onto it.
        */}

        {/*
          HOW THE FARMER RUNS THEIR STAND FROM A PHONE (F-093).

          The gap this closes: `STAND` and `SETTINGS` appeared in no farmer-facing copy at all,
          and `LINK` only as an aside in one text. A farmer finished onboarding knowing one
          word — VIGA — and everything after that was undiscoverable except by guessing.

          It sits BELOW the summary and after the VIGA instruction on purpose. The screen's
          first job is getting that one text sent; a reference competing with it costs
          completions, which is the mistake the note further down this file already records.

          `MORE`, `YES`/`NO` and `SAME` are deliberately absent — each answers a message Farm
          Friend sends, and the message that needs one teaches it in context.
        */}
        <div className="farmer-listing-saved-keywords">
          <p>Once you are set up, you run everything by text:</p>
          <dl>
            <div>
              <dt>Text what you have</dt>
              <dd>e.g. we have tomatoes and eggs. no greens right now</dd>
            </div>
            <div>
              <dt>LINK</dt>
              <dd>a link back to this page, to change your listing</dd>
            </div>
            <div>
              <dt>SETTINGS</dt>
              <dd>change how often we text you</dd>
            </div>
            <div>
              <dt>STAND</dt>
              <dd>pick which stand you mean, if you have more than one</dd>
            </div>
          </dl>
        </div>
      </div>
    );
  }

  return (
    <form className="farmer-listing" onSubmit={submit}>
      {/*
        WHERE THE FARMER IS, when there are steps to be at.

        Stated as text rather than as a progress bar: "Step 2 of 4" answers both "how far in
        am I" and "how much is left", which is the whole question, and it survives at phone
        width where a bar of segments does not.
      */}
      {steps !== null && (
        <div className="farmer-listing-progress">
          <p className="farmer-listing-step-count">{`Step ${step + 1} of ${steps.length}`}</p>
          <h3 className="farmer-listing-step-heading">
            {STEP_HEADINGS[steps[step]!]}
          </h3>
        </div>
      )}

      {showCompletionIssues && visibleCompletionIssues.length > 0 ? (
        <div className="farmer-form-error" role="alert">
          <p>Finish these before submitting:</p>
          <ul>
            {visibleCompletionIssues.map((issue) => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        Each step is a `hidden` FIELDSET over one always-mounted form, never a branch that
        unmounts. `hidden` is what makes `toBeVisible` false for a field the farmer cannot
        currently see while its state — and its value on submit — survives untouched.
      */}
      <fieldset className="farmer-listing-step" hidden={!onStep("farm")}>
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

      <label htmlFor="stand-name">What is your farm called?</label>
      <input
        id="stand-name"
        type="text"
        value={standName}
        onChange={(event) => setStandName(event.target.value)}
        maxLength={120}
      />

      {/*
        WHERE THE FARM IS — asked of EVERY farm, before the visit question (F-088).

        This used to sit BEHIND the visit question, because the database refused an address on
        a farm with no stand: asking first would have collected a value it then had to throw
        away. max reopened that (2026-08-07), so every farm is placed and the dependency that
        forced the old order is gone.

        Asking first is what the farmer expects — the address is the one fact they know cold —
        and it means the visit question below narrows what an already-placed farm SHOWS rather
        than deciding whether to collect anything at all.
      */}
        {/*
          The label names the FIELD; the instruction lives in the placeholder, where the
          farmer is about to type (max 2026-08-07). It used to be the question "Where is it?"
          with the example address as the placeholder — a heading asking one thing and a hint
          showing another, when there is only one thing to say.
        */}
        <label htmlFor="stand-address">Your farm address</label>
        {/*
          The lookup sits INSIDE the field rather than on its own row below it. It is one
          action on one value, and a full-width button underneath read as a second step —
          the address and the thing that resolves it now occupy one line.

          `Enter` runs the lookup too. A farmer who finishes typing an address and presses
          the key their phone keyboard offers should not have to go find a control; and
          without this the keypress would SUBMIT the whole form, which is the same accident
          `type="button"` prevents on the button.
        */}
        <div className="farmer-listing-address">
          <input
            id="stand-address"
            type="text"
            value={address}
            // Editing DISCARDS the coordinate the previous text resolved to — see
            // `changeAddress`. This is what stops one address publishing under another.
            onChange={(event) => changeAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void findAddress();
            }}
            placeholder="Enter your farm address"
            maxLength={300}
          />
          {/*
            `type="button"` matters — inside a form a bare button submits, which would try to
            publish the listing on a lookup, with no coordinate and a refusal the farmer did
            not ask for.

            IT SAYS WHAT IT DOES, IN WORDS (max 2026-08-07). It was a map-pin glyph with the
            sentence carried in `aria-label`, which asked a sighted farmer to infer from a
            picture what a screen reader was told outright.

            It says Save because that is the farmer's one action after entering an address.
            It is disabled once the address has a matching map pin — see `canSaveAddress`.
          */}
          <button
            type="button"
            className="farmer-listing-lookup farmer-listing-primary"
            onClick={() => void findAddress()}
            disabled={!canSaveAddress}
          >
            {lookingUp ? (
              <>
                {/*
                  The spinner is decorative, so it carries the name in text a screen reader
                  reads and CSS hides. Without this the button loses its accessible name for
                  exactly as long as the lookup runs.
                */}
                <span className="farmer-listing-lookup-busy" aria-hidden="true" />
                <span className="sr-only">
                  {isEditingDoor ? "Finding address on map" : "Saving address"}
                </span>
              </>
            ) : (
              isEditingDoor ? "Find on map" : "Save"
            )}
          </button>
        </div>
        {lookupNote === null ? null : (
          <p className="farmer-form-note" role="status">
            {lookupNote}
          </p>
        )}

        {/*
          F-088 — hiding the address WITHOUT hiding the stand.

          Offered here rather than as a third answer to "can people come to your stand?",
          because it answers a different question. Visitability decides whether there is
          somewhere to go; this decides whether the street address is printed. Folding them
          into one list would make "don't show my address" look like "I have no stand", which
          is what the map says today for the sellers that prompted this.

          **Directly BELOW the address field it governs** (max 2026-08-07). It used to render
          after the map, where a tall block sat between the choice and the thing it applies to
          — far enough that the choice read as being about the map.

          The note states the consequence plainly, including what still happens — the pin
          stays. A farmer who wants no location shown at all wants the other answer below, and
          saying so here is what stops this being mistaken for it. "By default" is what tells
          them the current state is a default they may change.
        */}
        <label className="farmer-listing-choice farmer-listing-address-privacy">
          <input
            type="checkbox"
            checked={!addressPublic}
            onChange={() => setAddressPublic(!addressPublic)}
          />
          <span>Don&apos;t show my address in the live listing</span>
        </label>
        <p className="farmer-form-note">
          {addressPublic
            ? "Your address shows on your listing by default, with a link to directions."
            : "Your stand still shows on the map, and people can find it by its pin — " +
              "but your address and the directions link stay hidden."}
        </p>

        {/*
          The map is a READ-ONLY DISPLAY of where the address resolved (F-077). It carries no
          click handler: there is no placement for a farmer to make, because the address is
          the only thing that decides the coordinate.

          It is not merely decoration, though, which is why it survived the pin picker. A
          coordinate published without ever being shown is one the farmer cannot sanity-check
          — and a geocoder putting a Vashon Highway address at the wrong end of the island is
          exactly the mistake a glance catches and no validation can.

          **It is present from the moment the address is asked for, pin or no pin.** It used
          to render only on a successful lookup, so a found address made a large block appear
          mid-form and push every field below it down the page — on a phone that lands the
          farmer's thumb somewhere other than where they aimed it. Always rendering turns
          that into a swap inside a box whose height never changes.

          The frame is the WHOLE ISLAND until an address resolves, then travels to the
          stand's neighbourhood. Starting wide is what makes the zoom informative: the coarse
          check a farmer actually performs is "is this the right end of the island?", and
          watching the view arrive there answers it before they read the pin. The coastline
          stays in frame at rest for the same reason — see `ZOOM_FRACTION`.
        */}
        <p className="farmer-listing-map-label" id="pin-instruction">
          {pinPoint === null
            ? "Your stand will show here once we find your address."
            : "Found it. This is where people will be sent — check it looks right."}
        </p>
        <svg
          className="farmer-listing-map"
          viewBox={mapViewBox}
          role="img"
          aria-describedby="pin-instruction"
          aria-label={
            pinPoint === null
              ? "Map of Vashon and Maury Island. Your stand is not placed yet."
              : "Map of Vashon and Maury Island, showing your stand's location."
          }
          // Faint until there is something real to show, so an empty map reads as waiting
          // rather than as a placed stand.
          data-placed={pinPoint === null ? "no" : "yes"}
        >
          <IslandArtwork />
          {pinPoint === null ? null : (
            <g>
              <circle
                cx={pinPoint.x}
                cy={pinPoint.y}
                /*
                  Sized against the CURRENT frame, not the drawing.

                  An `r` in fixed viewBox units is a fixed fraction of the frame, so as the
                  view narrows the pin swells on screen — it would balloon through the zoom
                  and settle three times too large. Scaling with the frame's width holds it
                  at one apparent size from the first frame to the last.

                  The base radius is deliberately LARGE (max 2026-08-07): the dot is the
                  answer to "did it find the right place?", and at its old size it read as a
                  speck rather than as a located stand. Its apparent size is asserted as a
                  fraction of the settled frame, never as this number — see the suite.
                */
                r={34 * (Number(mapViewBox.split(/\s+/)[2]) / ISLAND_VIEWBOX.width)}
                className="farmer-listing-pin"
              />
            </g>
          )}
        </svg>
      {/*
        WHERE SHE SELLS. One question, asked before anything that depends on it and deliberately
        not pre-answered: whether there is a place to drive to is the one fact nobody may invent
        on a farmer's behalf, so "not answered yet" stays a state she can see she is in.

        This replaces two questions — "do you have a stand people can visit?" and "do you also
        sell at someone else's?" — that a farmer had to combine in her head to describe herself.
        The four options ARE that combination, so she picks the sentence that is true of her.

        The two host answers are dropped when the island offers no stands to pick: they would be
        answers she could select and then not complete. The two that describe only her own place
        always stay, because "a farm with no public stand" must remain sayable.
      */}
      <fieldset className="farmer-listing-branch">
        <legend>Where do you sell?</legend>
        {(
          [
            ["own_only", "Just my own stand — people can visit it"],
            ...(hostStandChoices.length > 0
              ? ([["host_only", "Only at someone else's stand"]] as const)
              : []),
            ...(hostStandChoices.length > 0
              ? ([["both", "Both — my own stand, and someone else's"]] as const)
              : []),
            ["neither", "I have a farm, but no stand people can visit"],
          ] as const
        ).map(([value, label]) => (
          <label className="farmer-listing-choice" key={value}>
            <input
              type="radio"
              name="sells-where"
              checked={sellsWhere === value}
              onChange={() => {
                setSellsWhere(value);
                // Clearing the pick with the answer, so an answer that names no host cannot
                // leave a stand id behind for the payload to carry.
                if (value !== "host_only" && value !== "both") setHostStandId("");
              }}
            />
            <span>{label}</span>
          </label>
        ))}

        {sellsAtHostStand && (
          <>
            <label htmlFor="host-stand">Which stand?</label>
            {/*
              A SELECT of real stands. Free text would make the host we then text a guess, and
              this flow's whole safeguard is that the host is unambiguous.
            */}
            <select
              id="host-stand"
              value={hostStandId}
              onChange={(event) => setHostStandId(event.target.value)}
            >
              <option value="">Choose a stand</option>
              {hostStandChoices.map((choice) => (
                <option key={choice.standId} value={choice.standId}>
                  {choice.name}
                </option>
              ))}
            </select>
            <p className="farmer-listing-note">
              We will text the person who runs that stand to let them know. You are listed
              there straight away.
            </p>
          </>
        )}
      </fieldset>

      </fieldset>

      <fieldset className="farmer-listing-step" hidden={!onStep("open")}>
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
            placeholder="e.g. berry season, pumpkin season"
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
        {/*
          SELECT ALL (max 2026-08-08). Most stands on the island are open whenever it is
          light, so "all seven" is the common answer and it was seven taps.

          **It DESCRIBES the state rather than owning it.** `checked` is derived from the days
          themselves, so a farmer who ticks all seven one at a time sees this fill in too, and
          there is no second piece of state that can disagree with the boxes. That is also why
          it toggles off: tapping it again clears them, so a mistap is undone where it was
          made rather than by unticking seven boxes.

          Placed FIRST, ahead of the days: it is the shortcut past them, and a shortcut found
          after the work is done is not one. Its label says "open" because the hours dropdown
          above already offers "All day, every day" — a bare "every day" beside it would read
          as the same answer asked twice.
        */}
        <label className="farmer-listing-day farmer-listing-day-all">
          <input
            type="checkbox"
            checked={openDays.length === WEEKDAYS.length}
            onChange={() =>
              setOpenDays(
                openDays.length === WEEKDAYS.length
                  ? []
                  : WEEKDAYS.map((day) => day.value),
              )
            }
          />
          <span>Open every day</span>
        </label>
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
        placeholder="e.g. Weekends when available"
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

      </fieldset>

      <fieldset className="farmer-listing-step" hidden={!onStep("sell")}>
      <StockInventoryEditor
        kind="usual"
        items={itemRows.map((row, index) => ({
          key: String(index),
          name: row.name,
          inStock: asksForCurrentStock ? row.inStock : undefined,
          price: priceDraft(row),
        }))}
        pricesEnabled={pricesPublic}
        draftItem={draftItem}
        onPricesEnabledChange={() => setPricesPublic(!pricesPublic)}
        onDraftItemChange={setDraftItem}
        onAddItem={addItem}
        onStockChange={(key) => toggleItemStock(Number(key))}
        onPriceChange={(key, price) => setItemPrice(Number(key), price)}
        onRemoveItem={(key) => removeItem(Number(key))}
        highlighted={isOnboardingDoor}
      />

      {/* ── Payment ────────────────────────────────────────────────────────────────────── */}
      {/*
        Checkboxes keep payment names consistent while VIGA Bucks saves separately.

        F-125 — this asks about the FARMER, not about this stand. She states it once and it
        applies everywhere she sells, so the legend says "pay you" and the note says so
        outright: a farmer setting up her second stand who reads a per-stand question will
        answer for that stand, and the writer would replace her whole answer with it.
      */}
      <fieldset className="farmer-listing-payments">
        <legend>How can people pay you?</legend>
        <p className="farmer-form-note">
          This applies everywhere you sell, so you only say it once.
        </p>
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
        <label className="farmer-listing-choice">
          <input
            type="checkbox"
            checked={farmBucksAccepted}
            onChange={(event) => setFarmBucksAccepted(event.target.checked)}
          />
          <span>VIGA Bucks</span>
        </label>
      </fieldset>

      <label htmlFor="other-payment">Anything else you accept as payment?</label>
      <input
        id="other-payment"
        type="text"
        value={otherPayment}
        onChange={(event) => setOtherPayment(event.target.value)}
        placeholder="e.g. trade for eggs"
        maxLength={500}
      />

      {/*
        THE FARM'S OWN PARAGRAPH, and the first farmer-facing surface that can change it.
        `sellers.description` renders on the public card and was seeded from VIGA's forms with no
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
        placeholder="e.g. We put a sign at the bottom of the driveway when the stand is open."
        maxLength={2000}
      />
      <p className="farmer-form-note">
        This shows on your card. Hours, payments and what you sell are already covered above —
        this is for anything they do not say.
      </p>

      {/*
        THE PHONE, and the last step stated BEFORE the farmer submits.

        Announced here rather than only on the saved screen: the farmer is about to type the
        number that decides which handset can finish their setup, and "you will text VIGA to
        this number" is the fact that makes the field make sense. Discovering it afterwards is
        how a farmer fills in a number they cannot actually text from.

        `type="tel"` with `inputMode` and `autoComplete`, matching `PhoneStep` — it summons the
        numeric keypad and lets a phone offer its own number, which is the difference between
        one tap and typing ten digits outdoors.
      */}
      </fieldset>

      <fieldset className="farmer-listing-step" hidden={!onStep("contact")}>
      {asksForPhone && (
        <>
          <label htmlFor="farmer-phone">Your phone number</label>
          <input
            id="farmer-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="e.g. (206) 555-0143"
            maxLength={40}
          />
          <p className="farmer-form-note">
            {smsNumber === undefined ? (
              <>
                The phone you will send stand updates from. After you submit, you will text{" "}
                <strong>VIGA</strong> from it to finish setting up.
              </>
            ) : (
              <>
                After you submit, text <strong>VIGA</strong> to{" "}
                <strong>{formatSmsNumberForDisplay(smsNumber)}</strong> from this phone to
                finish setting up. We cannot
                text you until you do.
              </>
            )}
          </p>
        </>
      )}

      {/*
        THE AGREEMENT, directly above the button it gates.

        The tick leads and the disclosure follows it, because the tick is the action and the
        disclosure is its terms. The four facts the carrier receipt claims were shown —
        frequency, rates, STOP, HELP — are REGISTERED COPY and are asserted by test; only their
        framing is ours. The list replaces a five-line paragraph in which the three message
        kinds and the four disclosures ran together as one wall.
      */}
      {asksForAgreement && (
        <div className="farmer-onboarding-agreement" data-testid="sms-agreement">
          <label className="farmer-onboarding-agree">
            <input
              type="checkbox"
              checked={agreed}
              disabled={agreeing}
              onChange={(event) => void toggleAgreement(event.target.checked)}
            />
            <span>I agree to receive texts from VIGA Farm Friend.</span>
          </label>
          <div className="farmer-onboarding-terms">
            <p>Farm Friend texts you about your stand:</p>
            <ul>
              <li>Reminders to update what you have</li>
              <li>Confirmations of what you publish</li>
              <li>Notices when a customer reports something sold out</li>
            </ul>
            <p>
              Message frequency varies. Message and data rates may apply. Reply STOP any time to
              stop all messages, or HELP for help.
            </p>
          </div>
          {agreeError === null ? null : (
            <p className="farmer-form-error" role="alert">
              {agreeError}
            </p>
          )}
        </div>
      )}

      {/*
        THE REMINDER SCHEDULE, directly under the agreement it follows from (max 2026-08-08).

        Not gated on the tick: a farmer who has not yet agreed can still say how often they
        would want reminding, and disabling the control would make the page feel broken at the
        moment they are deciding. What the choice cannot do without the tick is take effect —
        no agreement means no authorization, and no authorization means no schedule at all.

        "Paused" is offered here, exactly as it is in settings. A farmer who wants no reminders
        should be able to say so before the first one arrives rather than after.
      */}
      {asksForCadence && (
        <div className="farmer-onboarding-cadence">
          <label htmlFor="prompt-cadence">How often should we remind you to update?</label>
          <select
            id="prompt-cadence"
            value={promptCadence}
            onChange={(event) =>
              setPromptCadence(
                event.target.value as "every_2_days" | "weekly" | "every_2_weeks" | "paused",
              )
            }
          >
            <option value="every_2_days">Every 2 days</option>
            <option value="weekly">Weekly</option>
            <option value="every_2_weeks">Every 2 weeks</option>
            <option value="paused">Don&apos;t remind me</option>
          </select>
          <p className="farmer-form-note">
            We text at 10am. You can change this any time by texting{" "}
            <strong>SETTINGS</strong>.
          </p>
        </div>
      )}

      </fieldset>

      {error === null ? null : (
        <p className="farmer-form-error" role="alert">
          {error}
        </p>
      )}

      {/*
        NAVIGATION, and why Submit exists only on the last step.

        A Submit button visible on step one would let a farmer publish a listing they have
        not finished describing — and because the writer replaces the WHOLE listing, the
        fields they never reached would be written as empty rather than left alone. The flat
        door has no steps and shows Submit throughout, which is what it has always done.

        Both nav buttons are `type="button"`: inside a form a bare button submits, which
        would publish the listing on a Next.
      */}
      {steps !== null && (
        <div className="farmer-listing-nav">
          {step > 0 && (
            <button
              type="button"
              className="farmer-listing-back"
              onClick={() => {
                setStep((at) => at - 1);
              }}
              disabled={busy}
            >
              Back
            </button>
          )}
          {step < steps.length - 1 && (
            <button
              type="button"
              className="farmer-primary-action"
              onClick={() => {
                setStep((at) => at + 1);
              }}
            >
              Next
            </button>
          )}
        </div>
      )}

      {/*
        THE ONE COMMIT BUTTON, and why its WORD depends on the door (F-098).

        "Submit" is onboarding's word — handing a form in for the first time, which is what
        the invited and grandfathered doors genuinely do. A farmer changing their hours is
        saving, and F-097 already removed that word from the settings panel beside this one.

        Naming it by the door rather than by the step is also what keeps ONE button on the
        editing tab: `steps === null` is true for a stand link, so this used to render an
        onboarding Submit directly above the settings panel's Save.
      */}
      {(steps === null || step === steps.length - 1) && (
        <button type="submit" disabled={busy}>
          {busy
            ? isEditingDoor
              ? "Saving…"
              : "Submitting…"
            : isEditingDoor
              ? "Save changes"
              : "Submit"}
        </button>
      )}

      {/*
        THE CONFIRMATION, and why a modal rather than a note beside the field.

        A mistyped phone number is the one error on this form with NO feedback anywhere. The
        listing saves, the farmer texts VIGA from their real phone, it matches no invitation,
        and they wait — with every field on screen looking correct. Nothing in the system can
        detect it, because a number that is ten valid digits is indistinguishable from the right
        ten digits.

        So the farmer is made to read it back before anything is sent. It is deliberately
        interruptive: a passive note beside the field is exactly what a farmer scrolls past.

        `role="dialog"` with `aria-modal` and a label, so a screen reader announces it as the
        thing now demanding an answer. Both buttons are `type="button"` — inside a form a bare
        button submits, which would post the listing twice.
      */}
      {confirming && (
        <div
          className="farmer-listing-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-phone-heading"
        >
          <div className="farmer-listing-confirm-card">
            <h3 id="confirm-phone-heading">Is this your number?</h3>
            {/*
              The number as the farmer typed it, not normalized. They are checking it against
              the phone in their hand, and reformatting it into +1XXXXXXXXXX would make them
              compare two differently-shaped strings.
            */}
            <p className="farmer-listing-confirm-number">{phone}</p>
            {/*
              ONE QUESTION, and the errand is not it (max, 2026-08-08).

              This used to name VIGA and the number here as well. That asked the farmer to
              check ten digits and absorb an instruction at the same moment, when only the
              first is actionable — and the instruction is repeated on the screen they land on
              a second later, where it is the thing to act on. What stays is the reason the
              digits matter: this has to be the handset they are holding.
            */}
            <p>It has to be the phone you have with you.</p>
            <div className="farmer-listing-confirm-actions">
              <button
                type="button"
                className="farmer-primary-action"
                onClick={() => void send()}
                disabled={busy}
              >
                Yes, that is my number
              </button>
              <button
                type="button"
                className="farmer-listing-change"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Go back and change it
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
