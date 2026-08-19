"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CONTACT_CARD_PATH } from "@farm-friend/core/vcard";
import {
  ISLAND_VIEWBOX,
  projectToIsland,
} from "@farm-friend/core/island-projection";
import {
  applyStandFilters,
  buildMapView,
  mapMarkerKind,
  hoistStand,
  numberStands,
  sortStandsByNumber,
  standListingLines,
  type FilteredStand,
  type MapViewStand,
  type PublicStandPayload,
  type StandFilters,
} from "../lib/map-view";
import { standCardSections, type StandCardSection } from "../lib/stand-card";
import {
  filterSellers,
  type SellerListEntry,
} from "../lib/seller-list";
import {
  markerTipBox,
  markerTipUnitScale,
  sellerSeasonBadge,
  sellerStandLinks,
  sellerOpenState,
  standSellerLinks,
  standsForSeller,
  type SellerStandLink,
} from "../lib/stand-seller-graph";
import { IslandArtwork } from "./island-artwork";
import { mapFollowOffset } from "../lib/map-follow";
import { useTransientOrigin } from "./use-transient-origin";
import farmMapLogo from "../../../assets/viga-farm-map.png";
import vigaWheelbarrow from "../../../assets/viga_wheelbarrow.png";

// The public stand map (F-017, F-042, F-043).
//
// Design intent, in one line: this page's job is to be TRUSTED, not to look busy. A customer
// standing in their kitchen deciding whether to drive to a stand needs three things in this
// order — what is there, how long ago a farmer confirmed it, and how far away it is. Recency
// is therefore a first-class visual element on every card rather than a footnote, and a
// stale listing is styled as *caution*, never hidden.
//
// It is model-free by construction: the data arrives from `GET /api/public/stands`, which
// takes db + clock and has no model seam, and everything below is arithmetic and markup.
//
// F-043 — TWO ARRANGEMENTS OF ONE COMPONENT. Phone (primary): map on top at fixed aspect,
// filter row, list below. Wide (≥56rem): map pinned left, list scrolling right. Same markup,
// same selection state; CSS decides the arrangement. The map is mobile-first by design —
// checked outdoors, one-handed, deciding whether to drive somewhere.
//
// WHAT DECIDES WHAT: `applyStandFilters` and `standListingLines` are pure functions in
// `map-view.ts` with sabotage-verified tests. This file prints their answers and chooses
// nothing. That split is deliberate and load-bearing — the rules that could make the map
// dishonest (a stand hidden for a fact nobody stated, a timestamp beside a seeded tag) cannot
// live in a conditional chain inside JSX that no test renders.

/** Plain-language labels for what the map can say about a stand right now (F-043). */
const OPEN_STATE_LABEL: Record<FilteredStand["openState"], string | null> = {
  // `open` gets no badge: the whole list is "what's here", and badging the normal case adds
  // noise to every card to say nothing.
  open: null,
  farmer_closed: "Closed by farmer",
  closed: "Closed right now",
  closed_today: "Closed today",
  out_of_season: "Closed for the season",
  by_appointment: "By appointment",
  // The honest one, and now the LAST resort rather than the first. A stand that stated which
  // weekdays it is open says so instead — see `openStateLabel` below. This remains for a stand
  // that genuinely stated nothing, so "shown" never silently becomes "shown as open".
  unknown: "Hours not listed",
};

/*
  F-118 — the marker tooltip's box, in ISLAND VIEWBOX UNITS.

  A `foreignObject` clips to the box it is given rather than growing to its content, so the box
  has to be computed from the number of sellers in it. These two numbers are that arithmetic's
  only inputs, stated here beside the map's other drawing constants rather than buried in the
  memo that uses them: they are a drawing fact, and the CSS that lays the tooltip out has to
  agree with them.
*/
const MARKER_TIP_ROW = 46;
const MARKER_TIP_PADDING = 34;
/* 40% of the island's width. Wide enough for a farm name at a legible size, narrow enough that
   `markerTipBox` can still slide it clear of both shores on a 1000-unit map. */
const MARKER_TIP_WIDTH = 400;

const DAY_ABBREVIATION = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAME = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_NAME = [
  "",
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
];

function dateLabel(month: number, day: number): string {
  return `${MONTH_NAME[month]} ${day}`;
}

function timeLabel(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const period = hour >= 12 ? "PM" : "AM";
  const clockHour = hour % 12 || 12;
  return `${clockHour}${minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`} ${period}`;
}

function seasonLabel(availability: PublicStandPayload["availability"]): string | null {
  const season = availability.season;
  if (season === undefined) return null;
  if (season.kind === "year_round") return "Year-round";
  if (season.kind === "date_range") {
    return `${dateLabel(season.startMonth, season.startDay)}–${dateLabel(season.endMonth, season.endDay)}`;
  }
  if (season.kind === "open_ended") {
    return `From ${dateLabel(season.startMonth, season.startDay)}`;
  }
  return season.names.map((name) => name.charAt(0).toUpperCase() + name.slice(1)).join(", ");
}

function hoursLabel(availability: PublicStandPayload["availability"]): string | null {
  const hours = availability.hours;
  if (hours === undefined) return null;
  if (hours.kind === "dawn_to_dusk") return "Dawn to dusk";
  if (hours.kind === "daylight_hours") return "Daylight hours";
  if (hours.kind === "all_day") return "All day";
  if (hours.kind === "by_appointment") return "By appointment";
  if (hours.kind === "until_dusk") return `From ${timeLabel(hours.fromMinutes)} until dusk`;
  return `${timeLabel(hours.fromMinutes)}–${timeLabel(hours.untilMinutes)}`;
}

function daysLabel(days: number[] | undefined): string | null {
  if (days === undefined || days.length === 0) return null;
  return days.length === 7 ? "Every day" : days.map((day) => DAY_NAME[day]).join(", ");
}

function restockingLabel(availability: PublicStandPayload["availability"]): string | null {
  switch (availability.stockingCadence) {
    case "daily":
      return "Daily";
    case "specific_days":
      return daysLabel(availability.stockingDays);
    case "variable":
      return "Varies";
    case "as_needed":
      return "As needed";
    case "intermittent":
      return "Intermittently";
    default:
      return null;
  }
}

/**
 * What the card says about when a stand is open (B-039).
 *
 * WHY THIS IS NOT JUST `OPEN_STATE_LABEL[openState]`. `openNow` answers `unknown` for a stand
 * that named its DAYS but no clock times, and that answer is correct — without times nothing can
 * say whether the stand is open at this minute. But rendering it as "Hours not listed" told a
 * customer the farm said nothing, when the farm had said "All days". 13 of 35 stands read that
 * way, 9 of them having stated something.
 *
 * So an `unknown` stand with a day set states its days. Every other state is unchanged: a stand
 * that is closed today, out of season, or by appointment already has a truer thing to say, and
 * a stand that stated nothing still says so.
 */
function openStateLabel(stand: FilteredStand & MapViewStand): string | null {
  const days = stand.availability?.days;
  if (stand.openState !== "unknown" || days === undefined || days.length === 0) {
    return OPEN_STATE_LABEL[stand.openState];
  }
  if (days.length === 7) return "Open daily";
  // The farmer's own days, in week order from Sunday, so a customer reads them as a schedule
  // rather than as the set the database happens to store.
  return `Open ${days.map((day) => DAY_ABBREVIATION[day]).join(", ")}`;
}

type ToggleFilterKey =
  | "openNow"
  | "confirmedRecently"
  | "acceptsFarmBucks"
  | "flowersOnly";

const FILTER_GROUPS: ReadonlyArray<{
  title: string;
  filters: ReadonlyArray<{ key: ToggleFilterKey; label: string }>;
}> = [
  {
    title: "Availability",
    filters: [
      { key: "openNow", label: "Open now" },
      { key: "confirmedRecently", label: "Confirmed recently" },
    ],
  },
  {
    title: "Stand details",
    filters: [
      { key: "acceptsFarmBucks", label: "Accepts VIGA Bucks" },
      { key: "flowersOnly", label: "Flowers only" },
    ],
  },
];

function FilterOption({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "filter-option filter-option-active" : "filter-option"}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

type DetailIconKind = "inventory" | "offerings" | "participants" | "schedule" | "payment" | "information" | "directions" | "website";

function DetailIcon({ kind }: { kind: DetailIconKind }) {
  const paths: Record<DetailIconKind, React.ReactNode> = {
    inventory: <><path d="M4 9h16v10H4z" /><path d="M7 9V6h10v3M8 13h8M9 4l1.5 2M15 4l-1.5 2" /></>,
    offerings: <><path d="M4 10h16l-2 10H6z" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 3v4M9 5l3 2 3-2" /></>,
    participants: <><path d="M4 10h16v10H4z" /><path d="M6 10V7h12v3M7 14h10M8 20v-4M16 20v-4" /><path d="M8 5h8" /></>,
    schedule: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16M8 14h3" /></>,
    payment: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></>,
    information: <><circle cx="12" cy="12" r="8" /><path d="M12 11v5M12 8h.01" /></>,
    directions: <><path d="M12 21s6-5.4 6-11a6 6 0 1 0-12 0c0 5.6 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></>,
    website: <><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16" /></>,
  };

  return <svg className="detail-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[kind]}</svg>;
}

function DetailSectionHeading({
  icon,
  children,
  className = "",
}: {
  icon: DetailIconKind;
  children: React.ReactNode;
  className?: string;
}) {
  return <h3 className={`detail-section-heading ${className}`}><DetailIcon kind={icon} />{children}</h3>;
}

/*
  F-118 — WHO SELLS HERE, FROM ONE SOURCE AT A TIME.

  A stand carries two answers to that question, and they are genuinely different facts:

    `sellers`         modelled rows with identities, from `stand_providers`. Crossable — each
                      has a card in the seller list to go to.
    `alsoSellingHere` display strings a stand owner typed, from `sales_location_participants`,
                      which DATA_RECORDS retires as display-only history. No identity, so no
                      card, so nothing to cross to.

  Rendering both would put most sellers on the card twice — once as a link and once as a dead
  name beside it. So the modelled list WINS wherever it exists, and the typed names appear only
  for a stand that has no modelled sellers at all, which is the only case they still answer
  anything. One question, one answer, and the fallback disappears as the data catches up.
*/
function StandSellers({
  stand,
  credited,
  onGoToSeller,
}: {
  stand: PublicStandPayload;
  /** The sellers an item line already named — see the filter below. */
  credited: ReadonlySet<string>;
  onGoToSeller: (sellerId: string) => void;
}) {
  const links = standSellerLinks(stand)
    /*
      ONLY THE SELLERS NO ITEM ALREADY CREDITED.

      An item line names the seller who brings it, and that credit is itself the crossing — it
      is where the customer's eye already is. Listing the same person again below is a second
      name for one fact, which is the redundancy this section was quietly creating.

      What is left is the case the roster exists for: someone selling at the stand who has
      published nothing, whom no item can credit and who would otherwise be at a stand whose
      card never mentions them.

      The STAND'S OWN SELLER is excluded outright. Their name is the card's heading and their
      goods are its uncredited lines — a roster entry for them would say a third time what the
      top of the card already says.
    */
    .filter(
      (link) =>
        link.relation !== "own" &&
        !credited.has(link.sellerId),
    );

  if (links.length > 0) {
    return (
      <section className="stand-sellers" aria-label="Who sells here">
        <DetailSectionHeading icon="participants">Who sells here</DetailSectionHeading>
        <ul className="stand-seller-links">
          {links.map((link) => (
            <li className="stand-seller-link" key={link.sellerId}>
              {/*
                LABELLED EXPLICITLY. The button's own text is a name followed by a relation
                chip, which read aloud concatenates into a sentence nobody wrote; the label
                says what pressing it does.
              */}
              <button
                type="button"
                className="stand-seller-go"
                aria-label={`Go to ${link.sellerName}`}
                onClick={() => onGoToSeller(link.sellerId)}
              >
                <span className="stand-seller-name">{link.sellerName}</span>
                {link.relation === "own" ? (
                  <span className="stand-seller-relation">Runs this stand</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  /*
    THE FALLBACK IS FOR A STAND WITH NO MODELLED **GUEST** — not for one whose roster happened to
    filter to empty, and not for one whose only modelled seller is itself.

    The rule suppresses typed names because a stand whose sellers are modelled has already named
    them, ON THE ITEM LINES, and printing the typed strings beside those would restore the
    double-naming this section exists to end. That reasoning holds for a GUEST, who earns an item
    credit. It does not hold for the stand's own seller, who is never credited — the credit IS the
    crossing, and a stand does not cross to itself.

    B-085: `0042` gave EVERY stand a self-pointer, which made "has modelled sellers" true
    everywhere and quietly turned this into "never show typed names". Morgan Hill lost all four of
    its names to its own native row, with nothing replacing them.

    **A stand with named hosted sellers and no seller profiles for them is a SUPPORTED case**, not
    a migration leftover. `sales_location_participants` is exactly that: display strings a stand
    owner typed, no identity, no handset, no inventory of their own. Morgan Hill's four are
    decorative rather than operational (max, 2026-08-18) — one `source: 'viga'` revision holds 17
    pooled items nobody can attribute to any of them. The two shapes coexist; only a real guest
    displaces the typed list.
  */
  if ((stand.sellers ?? []).some((seller) => !seller.describesOwnStand)) return null;
  if (stand.alsoSellingHere.length === 0) return null;

  return (
    <section className="stand-participants" aria-label="Also selling here">
      <DetailSectionHeading icon="participants">Also selling here</DetailSectionHeading>
      <ul className="participant-names">
        {stand.alsoSellingHere.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </section>
  );
}

type PosterIndicator = {
  kind: "no-viga-bucks" | "year-round" | "late-november";
  label: string;
};

/**
 * The static poster used three small dots as a directory key. Keep their meaning in one
 * data-derived function: a dot is never inferred from a farm name or from today's opening
 * state. "Late November" deliberately needs an explicit date range ending Nov 20–30; a
 * vague named season such as "fall" cannot honestly make that promise.
 */
function posterIndicators(stand: PublicStandPayload): PosterIndicator[] {
  const indicators: PosterIndicator[] = [];
  if (stand.farmBucksAccepted === false) {
    indicators.push({ kind: "no-viga-bucks", label: "Does not accept VIGA Bucks" });
  }

  const season = stand.availability.season;
  if (season?.kind === "year_round") {
    indicators.push({ kind: "year-round", label: "Open year-round" });
  } else if (
    season?.kind === "date_range" &&
    season.endMonth === 11 &&
    season.endDay >= 20
  ) {
    indicators.push({ kind: "late-november", label: "Open until late November" });
  }
  return indicators;
}

const DESCRIPTION_LINK = /(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|org|farm)\b)[^\s]*/gi;

function PublicDescription({
  description,
  label = "Additional information",
}: {
  description?: string;
  label?: string;
}) {
  if (description === undefined || description.trim() === "") return null;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of description.matchAll(DESCRIPTION_LINK)) {
    const start = match.index ?? 0;
    const raw = match[0];
    if (start > cursor) parts.push(description.slice(cursor, start));

    const trailing = raw.match(/[.,;:!?)]*$/)?.[0] ?? "";
    const visible = trailing === "" ? raw : raw.slice(0, -trailing.length);
    const href = visible.startsWith("www.") ? `https://${visible}` :
      visible.startsWith("http://") || visible.startsWith("https://")
        ? visible
        : `https://${visible}`;
    parts.push(
      <a key={`${start}-${raw}`} href={href} target="_blank" rel="noreferrer noopener">
        {visible}
      </a>,
    );
    if (trailing !== "") parts.push(trailing);
    cursor = start + raw.length;
  }
  if (cursor < description.length) parts.push(description.slice(cursor));

  return (
    <section className="stand-description" aria-label={label}>
      <DetailSectionHeading icon="information">{label}</DetailSectionHeading>
      <p className="description-text">{parts}</p>
    </section>
  );
}

function MarkerLegend() {
  const [open, setOpen] = useState(true);
  const entries = [
    ["year-round", "Year-round"],
    ["seasonal", "Seasonal"],
    ["flower-only", "Flowers-only"],
    ["contact-only", "Farm, no stand"],
    ["farmers-market", "VIGA Farmers Market"],
  ] as const;

  useEffect(() => {
    setOpen(window.matchMedia("(min-width: 56rem)").matches);
  }, []);

  return (
    <details
      className="marker-key"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Map key</summary>
      <ul className="marker-legend" aria-label="Map marker key">
        {entries.map(([kind, label]) => (
          <li key={kind} className="marker-legend-item">
            <span className={`marker-legend-symbol marker-legend-${kind}`} aria-hidden="true">
              {kind === "flower-only" ? "✿" : kind === "contact-only" ? "●" : ""}
            </span>
            <span>{label}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PosterIndicators({
  stand,
  compact = false,
}: {
  stand: PublicStandPayload;
  compact?: boolean;
}) {
  const indicators = posterIndicators(stand);
  if (indicators.length === 0) return null;

  return (
    <ul className="poster-indicators" aria-label="Stand details">
      {indicators.map((indicator) => (
        <li
          key={indicator.kind}
          className={`poster-indicator poster-indicator-${indicator.kind}`}
          aria-label={compact ? indicator.label : undefined}
        >
          <span className="poster-dot" aria-hidden="true" />
          {compact ? null : indicator.label}
        </li>
      ))}
    </ul>
  );
}

/*
  THE CARD'S HEADLINE (max, 2026-08-06).

  What a customer came for is what is there right now, so the inventory leads the card and the
  two facts on it are told in two different VOICES — the distinction F-042 established, now
  carried by shape rather than by two nearly-identical chip styles:

    a confirmation → CHIPS. Discrete, countable things a farmer vouched for, dated by a caption
                     directly BELOW them so the timestamp attaches to the items it covers.
    a specialty    → a plain grey SENTENCE. No chip, no border, no box — nothing that gives it
                     the shape of a countable stock list, and no visual slot where a date would
                     look at home. The no-timestamp rule lives in `standListingLines`; this
                     styling refuses to leave a place to put one.

  The recency is its own line rather than part of the label. `standListingLines` renders
  "Confirmed 4 hours ago:" as one string for the SMS-shaped surfaces; this card reads the
  separately rendered `cardRecency` instead of slicing a verb off that sentence — the failure
  mode `confirmedElapsed` exists to prevent — and states it in the browsed-card's own words
  ("Last updated 3 weeks ago", or "No recent update" past four weeks).
*/
/*
  F-114 C.5 — ITEM-FIRST, WITH SELLERS NESTED.

  A stand now has several sellers publishing independently, so an item's row is a heading and
  its supporting sellers are the lines beneath it: each with its own price and its own
  freshness. Three sellers carrying tomatoes is ONE `Tomatoes` row with three lines under it,
  never three rows.

  WHERE THE RECENCY SITS MOVED, and that is the honest part. It used to caption the whole
  In-stock heading, because one stand had one confirmation. It now sits on the SELLER LINE,
  attached to the goods it actually covers — a stand-wide caption would date Zoe's greens by
  Kelsey's venison. The heading keeps the stand's freshest live confirmation as a summary,
  which is the honest stand-level answer to "how current is this".

  A NESTED LINE FOR THE STAND'S OWN SELLER CARRIES NO NAME. `credit` is absent for it — by
  self-pointer, never a name match — so there is no string to print and nothing that would
  merely echo the stand's own heading back at the reader.
*/
function StandItemSections({
  stand,
  sections,
  onGoToSeller,
}: {
  stand: FilteredStand;
  sections: readonly StandCardSection[];
  onGoToSeller: (sellerId: string) => void;
}) {
  return (
    <>
      {sections.map((section) => (
        <section
          className={
            section.register === "usual" ? "detail-usual-offerings" : "detail-inventory"
          }
          aria-label={
            section.register === "usual"
              ? "Typical offerings"
              : "In-stock status and inventory"
          }
          key={section.register}
        >
          <div className={`listing listing-${section.register}`}>
            {section.register === "confirmed" ? (
              <DetailSectionHeading icon="inventory" className="detail-inventory-heading">
                <span>In stock</span>
                {stand.cardRecency === undefined ? null : (
                  <span
                    className={
                      stand.stale === true
                        ? "listing-recency listing-recency-aged"
                        : "listing-recency"
                    }
                  >
                    ({stand.cardRecency})
                  </span>
                )}
              </DetailSectionHeading>
            ) : (
              <DetailSectionHeading icon="offerings">Typical offerings</DetailSectionHeading>
            )}
            <ul className="items items-nested">
              {section.items.map((item) => (
                <li className="item-group" key={`${section.register}-${item.itemName}`}>
                  <span className="item-name">{item.itemName}</span>
                  <ul className="item-sellers">
                    {item.providers.map((provider) => (
                      <li className="item-seller" key={provider.providerId}>
                        {/*
                          F-118 — THE CREDIT IS THE CROSSING.

                          It is already the one place a customer's eye lands on a seller's name
                          on this card, so it is the name that carries the door — rather than a
                          second roster below repeating everyone. A stand's OWN seller has no
                          credit by design (`credit` is absent by self-pointer), so this renders
                          nothing for them and there is no button where a bare line belongs.
                        */}
                        {provider.credit === undefined ? null : (
                          <button
                            type="button"
                            className="item-seller-name item-seller-go"
                            aria-label={`Go to ${provider.credit}`}
                            onClick={() => onGoToSeller(provider.sellerId)}
                          >
                            {provider.credit}
                          </button>
                        )}
                        {provider.quantity !== undefined ||
                        provider.approximation !== undefined ? (
                          <span className="item-detail">
                            {provider.quantity !== undefined
                              ? `${provider.quantity}${provider.unit !== undefined ? ` ${provider.unit}` : ""}`
                              : provider.approximation}
                          </span>
                        ) : null}
                        {provider.priceText !== undefined ? (
                          <span className="item-price">{provider.priceText}</span>
                        ) : null}
                        {/*
                          NO RECENCY ON A USUAL LINE, EVER. `standCardSections` leaves the field
                          absent there rather than trusting this to omit it, so there is nothing
                          to print even if this branch were written wrongly.
                        */}
                        {provider.recency === undefined ? null : (
                          <span
                            className={
                              provider.stale === true
                                ? "item-seller-recency item-seller-recency-aged"
                                : "item-seller-recency"
                            }
                          >
                            {provider.recency}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ))}
    </>
  );
}

function StandListings({
  stand,
  onGoToSeller,
}: {
  stand: FilteredStand;
  onGoToSeller: (sellerId: string) => void;
}) {
  /*
    ONE DECISION: DOES THIS PAYLOAD CARRY PER-SELLER ATTRIBUTION?

    When it does, the card is item-first with sellers nested — the only shape that can state
    two sellers' different prices and different freshnesses for one item.

    When it does not, the sentence-shaped lines render exactly as they always have. That is not
    a second rendering of the same state: `standCardSections` returns nothing precisely when
    there is nothing to attribute — no sellers, sellers claiming nothing, or a shutdown making
    none of it buyable — and the cases below are the ones `standListingLines` already owns
    ("Nothing confirmed recently.", the contact-only wording, "No listing yet", and a confirmed
    list on a payload built without seller facts).
  */
  const sections = standCardSections(stand);
  if (sections.length > 0) {
    return (
      <StandItemSections stand={stand} sections={sections} onGoToSeller={onGoToSeller} />
    );
  }

  return (
    <>
      {standListingLines(stand).map((line) => (
        <section
          className={line.kind === "usual" ? "detail-usual-offerings" : "detail-inventory"}
          aria-label={line.kind === "usual" ? "Typical offerings" : "In-stock status and inventory"}
          key={line.kind}
        >
        <div className={`listing listing-${line.kind}`}>
          {line.items === undefined ? (
            <>
              <DetailSectionHeading icon="inventory">In stock</DetailSectionHeading>
              <p className="listing-note">{line.label}</p>
            </>
          ) : line.kind === "confirmed" ? (
            <>
              <DetailSectionHeading icon="inventory" className="detail-inventory-heading">
                <span>In stock</span>
                <span
                  className={stand.stale === true ? "listing-recency listing-recency-aged" : "listing-recency"}
                >
                  ({stand.cardRecency ?? `Last updated ${line.detail}`})
                </span>
              </DetailSectionHeading>
              <ul className="items">
                {stand.items.map((item, index) => (
                  <li key={`${stand.id}-${index}`}>
                    <span className="item-name">{item.itemName}</span>
                    {item.quantity !== undefined || item.approximation !== undefined ? (
                      <span className="item-detail">
                        {item.quantity !== undefined
                          ? `${item.quantity}${item.unit !== undefined ? ` ${item.unit}` : ""}`
                          : item.approximation}
                      </span>
                    ) : null}
                    {item.priceText !== undefined ? (
                      <span className="item-price">{item.priceText}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <DetailSectionHeading icon="offerings">Typical offerings</DetailSectionHeading>
              <p className="items-usual">{line.items.join(", ")}</p>
            </>
          )}
        </div>
        </section>
      ))}
    </>
  );
}

function StandSchedule({
  availability,
  stateLabel,
  openState,
  upcomingLabel,
}: {
  availability: PublicStandPayload["availability"];
  stateLabel: string | null;
  openState: FilteredStand["openState"];
  upcomingLabel?: string;
}) {
  const details = [
    ["Season", seasonLabel(availability)],
    ["Hours", hoursLabel(availability)],
    ["Open days", daysLabel(availability.days)],
    ["Hours note", availability.hoursText ?? null],
    ["Restocking", restockingLabel(availability)],
  ].filter((detail): detail is [string, string] => detail[1] !== null && detail[1] !== "");

  if (details.length === 0 && stateLabel === null && upcomingLabel === undefined) return null;

  return (
    <section className="detail-schedule" aria-label="Stand schedule">
      <div className="schedule-heading">
        <DetailSectionHeading icon="schedule">Visit / stand schedule</DetailSectionHeading>
        {upcomingLabel !== undefined ? (
          <p className="open-state open-state-upcoming">{upcomingLabel}</p>
        ) : null}
        {stateLabel !== null ? (
          <p className={`open-state open-state-${openState}`}>{stateLabel}</p>
        ) : null}
      </div>
      {details.length > 0 ? (
        <dl>
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/**
 * One hierarchy for both the expanded directory row and the phone map sheet.
 *
 * The address and a staleness warning only. The website moved into `StandDetailBody`, where it
 * appears once a stand is selected: here it added a line to every collapsed row of a directory
 * meant to be scanned by eye.
 */
function StandSummaryMeta({ stand }: { stand: FilteredStand & MapViewStand }) {
 /*
   F-118 — HOW MANY SELLERS, ON THE COLLAPSED CARD.

   A stand carrying three sellers looked identical to a stand carrying one until it was opened,
   and "several farms in one stop" is among the strongest reasons to choose a stand — it is the
   place-side mirror of the seller card's own "3 stands" chip.

   ONE SELLER GETS NO CHIP. Badging the ordinary case adds a mark to every card in the list to
   say nothing, which is the rule the open-state badge already follows. `sellers` absent and
   `sellers` of length one are the same answer to this question, so both are silent.
 */
 const sellerCount = (stand.sellers ?? []).length;
 return (
   <div className="stand-summary-meta">
     {sellerCount > 1 ? (
       <span className="stand-seller-count">{sellerCount} sellers</span>
     ) : null}
     {/*
       The same three states as the detail card (F-088). `?? "No farm stand to visit"` claimed
       there was nowhere to go for any stand without an address text — which since F-088
       includes stands that ARE on the map, with a pin, whose farmer simply withheld the
       street address.
     */}
     <p className="stand-summary-address">
       {stand.address ??
         (stand.latitude !== undefined && stand.longitude !== undefined
           ? "See the map pin — no street address listed"
           : "No farm stand to visit")}
     </p>
   </div>
 );
}

function StandDetailBody({
  stand,
  showDestination = true,
  onGoToSeller,
}: {
  stand: FilteredStand & MapViewStand;
  showDestination?: boolean;
  /**
   * Cross to a seller's card in the other list (F-118).
   *
   * REQUIRED, not optional. The card is rendered by two callers — the directory row and the
   * phone sheet — and an optional handler would let one of them silently render seller names
   * that do nothing when pressed. There is only one crossing, and both surfaces make it.
   */
  onGoToSeller: (sellerId: string) => void;
}) {
  const isMarket = stand.locationKind === "farmers_market";
  const description = stand.description;
  const links = stand.links ?? [];
  const stateLabel =
    stand.closure?.state === "active" ? stand.closure.label : openStateLabel(stand);
  /*
    Whom the item lines already named (F-118).

    Read back from the SECTIONS rather than from `stand.sellers`, because the sections are what
    actually renders: a seller whose items a stand shutdown suppressed publishes nothing the
    customer can see, so no credit names them and the roster below must. Deriving this from the
    raw seller list would call them credited on a card that never printed their name.
  */
  const credited = new Set(
    standCardSections(stand).flatMap((section) =>
      section.items.flatMap((item) =>
        item.providers
          .filter((provider) => provider.credit !== undefined)
          .map((provider) => provider.sellerId),
      ),
    ),
  );

  return (
    <div className="stand-detail-body">
      {/*
        STOCK LEADS (max, 2026-08-06). What is there right now is why a customer opened the
        card, so it is the first thing under the farm's name — the address and the way to get
        there follow it, because those only matter once the answer to "is it worth the drive"
        is yes. This section used to sit third, below the visit block and the status band.
      */}
      {isMarket ? null : (
        <>
          <StandListings stand={stand} onGoToSeller={onGoToSeller} />
          <StandSellers
            stand={stand}
            credited={credited}
            onGoToSeller={onGoToSeller}
          />
        </>
      )}

      {isMarket ? null : (
        <StandSchedule
          availability={stand.availability}
          stateLabel={stateLabel}
          openState={stand.openState}
          upcomingLabel={stand.closure?.state === "upcoming" ? stand.closure.label : undefined}
        />
      )}

      {showDestination ? (
        <section
          className="detail-visit"
          aria-label={isMarket ? "Visit the market" : "Plan your visit"}
        >
          <DetailSectionHeading icon="directions">
            {isMarket ? "Visit the market" : "Plan your visit"}
          </DetailSectionHeading>
          {/*
            THREE states, not two (F-088). A missing address used to mean exactly one thing —
            there is nowhere to go — so it rendered "No stand to visit". A farmer can now hide
            their address while keeping the stand ON the map, and telling a customer there is
            nothing to visit while a pin sits on the map beside that sentence is simply false.

            The coordinate is what tells them apart: a placed stand has one, a contact-only farm
            has none. The hidden-address wording deliberately does not apologise or invite the
            customer to ask for the address — the farmer withheld it on purpose.
          */}
          {stand.address !== undefined ? (
            <p className="address">{stand.address}</p>
          ) : stand.latitude !== undefined && stand.longitude !== undefined ? (
            <p className="address address-hidden">
              Find this stand by its pin on the map — the farm has not listed a street address.
            </p>
          ) : (
            <p className="address address-contact-only">
              <strong>No stand to visit</strong> — order by contacting this farm.
            </p>
          )}
        </section>
      ) : null}

      {links.length > 0 || stand.routingLink !== null ? (
        <section className="detail-action-region" aria-label="Visit actions">
        {links.length > 0 || stand.routingLink !== null ? (
          // Both the sheet and directory row use one semantic action list. The sheet still owns
          // its visit-address copy above; the actions themselves must not diverge by surface.
          <ul className="detail-actions">
            {stand.routingLink !== null ? (
              <li>
                <a
                  className="directions"
                  href={stand.routingLink}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <DetailIcon kind="directions" />
                  {isMarket ? "Directions to market" : "Get directions"}
                </a>
              </li>
            ) : null}
            {links.map((link) => (
              <li key={link.url}>
                <a
                  className="stand-website"
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <DetailIcon kind="website" />
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        </section>
      ) : null}

      {stand.farmBucksAccepted === true || (stand.paymentMethods ?? []).length > 0 ? (
        <section className="detail-payment" aria-label="Payment methods">
          <DetailSectionHeading icon="payment">Payment</DetailSectionHeading>
          {stand.farmBucksAccepted === true ? (
            <p className="payment-status">Accepts VIGA Bucks</p>
          ) : null}
          {/*
            F-061 — the stand's other payment methods, from the table that had no reader.
            VIGA Bucks is deliberately NOT in this list: it has its own column, its own badge
            above, and its own filter. One fact, one home.
          */}
          {(stand.paymentMethods ?? []).length > 0 ? (
            <p className="payment-status payment-methods">
              Also accepts {(stand.paymentMethods ?? []).join(", ")}
            </p>
          ) : null}
        </section>
      ) : null}

      {isMarket ? (
        <PublicDescription
          description={description}
          label="Market schedule and information"
        />
      ) : (
        <PublicDescription description={description} />
      )}
    </div>
  );
}

/*
  F-118 — THE SELLER CARD.

  It is the STAND card's shape — the same `li.stand`, the same heading button, the same
  expand-on-tap — because two card vocabularies on one surface make a customer re-learn the list
  every time they switch tabs. What differs is what a seller HAS:

    a stand answers  "what is out here, is it open, how do I get there"
    a seller answers "what does she make, and where do I catch her"

  ## At rest: the name, then one row of two derived facts (max, 2026-08-18)

  **How many of her stands are open right now**, and **how long she runs**. Neither is a fact the
  seller record carries — a seller has no hours and no season of her own, she has PLACES, and
  each place has both. Both are derived in `stand-seller-graph.ts` where a test can hold them to
  account, and neither is ever guessed: a stand that stated no hours is not counted open, and a
  seller whose stands stated no qualifying season gets no badge at all.

  ## Opened: it depends on how many stands she has

  **One stand** → the STAND's own detail body, the same one the stand list renders. Her answer to
  "where do I find her" has exactly one entry, and a list of one row is a step that asks the
  customer to pick the only option.

  **Several** → the list of stands, each carrying that stand's pin number and what she brings
  there. Now the choice is real, so the choice is what the card shows; tapping one goes to it.

  Either way, choosing her lights her stands on the map.

  NOTHING HERE IS DATED. These are standing claims about what she carries; what is out RIGHT NOW
  is the stand card's question, and it is the one surface that states it with its own per-seller
  recency.
*/
function SellerCard({
  seller,
  stands,
  chosen,
  onToggle,
  onGoToSeller,
}: {
  seller: SellerListEntry;
  stands: readonly (FilteredStand & MapViewStand)[];
  chosen: boolean;
  onToggle: () => void;
  onGoToSeller: (sellerId: string) => void;
}) {
  /*
    WHICH OF HER STANDS IS OPEN ON THIS CARD, if any.

    Card-local state, and that is deliberate: it is a detail of how ONE card is being read, not
    a fact about the map. Lifting it beside `selectedSellerId` would make the parent hold a
    second selection that means something different — and would leave a stand expanded on a card
    nobody has open.

    It is CLEARED when the card closes, explicitly rather than by unmounting: a collapsed card
    stays mounted in the list, so its state survives being closed unless something drops it.
    Without that, reopening a seller showed whichever stand somebody last looked at instead of
    her stands.
  */
  const [expandedStandId, setExpandedStandId] = useState<string | null>(null);
  if (!chosen && expandedStandId !== null) setExpandedStandId(null);

  const links = sellerStandLinks(seller, stands);
  const openState = sellerOpenState(seller, stands);
  const season = sellerSeasonBadge(seller, stands);
  // Does this card hold BOTH kinds? Only then does naming a row's relation distinguish anything
  // — see `SellerStandRow`.
  const ownCount = links.filter((link) => link.relation === "own").length;
  const mixedRelations = ownCount > 0 && ownCount < links.length;
  /*
    A SELLER AT ONE STAND OPENS THAT STAND. The single link is only useful if the map is showing
    the stand — `soleStand` is the stand itself, so the card can render its real body rather
    than a row pointing at it.
  */
  const soleStand =
    links.length === 1
      ? stands.find((stand) => stand.id === links[0]!.standId)
      : undefined;

  return (
    <li
      className={chosen ? "stand stand-no-pin stand-selected" : "stand stand-no-pin"}
      /*
        THE WHOLE CARD IS THE TARGET, exactly as it is on a stand card. The name is a small
        target on a phone, and a card that responds only to its heading reads as broken to
        someone who tapped the obvious thing. Controls INSIDE the card keep their own meaning —
        a tap on a stand row is going to that stand, not collapsing the card that offered it.
      */
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a, button")) {
          return;
        }
        onToggle();
      }}
    >
      <div className="stand-content">
        <div className="stand-head stand-head-no-pin">
          {/*
            NO PIN NUMBER, and the head says so structurally. `.stand-head` is a grid whose
            first column is the pin number and `.stand` reserves its own first column for the
            poster dots — a seller has neither, so without the modifier her name was laid out in
            a 1.65rem gutter and wrapped one word per line.
          */}
          <div className="stand-heading-copy">
            <h2>
              <button
                type="button"
                className="stand-summary-toggle"
                aria-expanded={chosen}
                onClick={onToggle}
              >
                {seller.sellerName}
              </button>
            </h2>

            {/*
              THE SUMMARY ROW. Two facts, both about her stands, both derived — see the note
              above. The season badge is absent rather than guessed, so a card can carry one
              fact or two and reads the same either way.
            */}
            <div className="seller-summary">
              {/*
                OPEN OR CLOSED, NOT A FRACTION (max, 2026-08-18). "1 of 1 stand open" makes the
                reader do arithmetic to reach a yes. The question is "can I buy from her right
                now", which has two answers; the count still DECIDES it — one open stand out of
                three is Open — but the card states the answer rather than the working.
              */}
              <span className={`seller-open-state seller-open-state-${openState}`}>
                {openState === "open"
                  ? "Open"
                  : openState === "closed"
                    ? "Closed"
                    : "Hours unknown"}
              </span>
              {season === undefined ? null : (
                <span className={`seller-season seller-season-${season}`}>
                  <span className="poster-dot" aria-hidden="true" />
                  {season === "year-round" ? "Year-round" : "Thru Nov"}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="stand-details">
          {!chosen ? null : soleStand !== undefined ? (
            /*
              ONE STAND — the stand's OWN body, identical to the stand list's. `showDestination`
              is on here, unlike the stand list's inline card: there the address already sits in
              the collapsed summary above, and here nothing has said where to go yet.
            */
            <StandDetailBody stand={soleStand} onGoToSeller={onGoToSeller} />
          ) : (
            <div className="seller-detail-body">
              {seller.description === undefined ? null : (
                <p className="seller-browse-description">{seller.description}</p>
              )}
              <section className="seller-stands" aria-label="Where to find this seller">
                <DetailSectionHeading icon="directions">
                  Where to find them
                </DetailSectionHeading>
                <ul className="seller-stand-links">
                  {links.map((link) => (
                    <SellerStandRow
                      key={link.standId}
                      link={link}
                      stand={stands.find((entry) => entry.id === link.standId)}
                      expanded={link.standId === expandedStandId}
                      showRelation={mixedRelations}
                      // Pressing the open row again puts it away, as every other row on these
                      // two lists does.
                      onToggle={() =>
                        setExpandedStandId((current) =>
                          current === link.standId ? null : link.standId,
                        )
                      }
                      onGoToSeller={onGoToSeller}
                    />
                  ))}
                </ul>
              </section>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * One stand a seller sells at, as a row that EXPANDS IN PLACE.
 *
 * **The stand's detail opens here rather than on the stand list** (max, 2026-08-18). Sending the
 * reader to View stands answered the question and threw their place away: they were reading
 * about a seller, and the surface they were reading vanished under them. So the row is an
 * expander, exactly like every other row on these two lists, and the stand's own body — hours,
 * stock, directions — opens beneath it.
 *
 * **The pin number moved INSIDE the row** for the same reason. Outside, it was a label beside a
 * link; inside an expander it is part of the thing being opened, which is what lets the row read
 * as one object rather than a number and a separate button next to it.
 *
 * **A stand the map is not showing is named but not offered.** It stays on the card, because
 * dropping it would quietly shorten "sells at 2 stands" to one — but it does not expand, because
 * there is no stand in the visible set to render. Saying "not on the map right now" is the honest
 * version of a door that cannot open; a dead expander is not.
 */
function SellerStandRow({
  link,
  stand,
  expanded,
  showRelation,
  onToggle,
  onGoToSeller,
}: {
  link: SellerStandLink;
  /** The stand itself, when the map is showing it — the source of the expanded body. */
  stand?: FilteredStand & MapViewStand;
  expanded: boolean;
  /**
   * Whether to name this row's relation — TRUE ONLY ON A MIXED CARD.
   *
   * "Their own stand" exists to tell one row apart from another: she runs this one and is a
   * guest at that one. On a card where every stand is the same kind, the summary chip already
   * said it once, and repeating it per row adds a line to every row to say nothing new.
   */
  showRelation: boolean;
  onToggle: () => void;
  onGoToSeller: (sellerId: string) => void;
}) {
  const heading = (
    <>
      {/*
        The stand's OWN pin number, the same one on its pin and its card — the token that ties
        the three surfaces together, so a customer reading her card can find the pin without
        reading a name twice. Decorative because the row names the stand beside it; a screen
        reader gains nothing from a bare digit.
      */}
      <span className="stand-number-ref" aria-hidden="true">
        {link.standNumber ?? "–"}
      </span>
      <span className="seller-stand-copy">
        <span className="seller-stand-name">{link.locationName}</span>
        {showRelation && link.relation === "own" ? (
          <span className="seller-stand-relation">Their own stand</span>
        ) : null}
        {link.usualItems.length > 0 ? (
          <span className="seller-stand-items">{link.usualItems.join(", ")}</span>
        ) : null}
      </span>
    </>
  );

  if (stand === undefined) {
    return (
      <li className="seller-stand-link seller-stand-link-off-map">
        <span className="seller-stand-head">
          {heading}
          <span className="seller-stand-off-map">Not on the map right now</span>
        </span>
      </li>
    );
  }

  return (
    <li className={expanded ? "seller-stand-link seller-stand-link-open" : "seller-stand-link"}>
      <button
        type="button"
        className="seller-stand-head seller-stand-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {heading}
      </button>
      {expanded ? (
        <div className="seller-stand-detail">
          <StandDetailBody stand={stand} onGoToSeller={onGoToSeller} />
        </div>
      ) : null}
    </li>
  );
}

export function StandMap({
  stands,
  sellers,
}: {
  stands: PublicStandPayload[];
  /*
    The island's sellers, for the list's second tab (max, 2026-08-18).

    OPTIONAL, and that is load-bearing: this component is embedded in VIGA's Squarespace page
    and rendered by a route that must keep working if the seller read is ever unavailable. With
    no sellers there is no tab at all — the map degrades to exactly what it was, rather than
    offering a tab onto an empty list.
  */
  sellers?: readonly SellerListEntry[];
}) {
  const { state, request, clear } = useTransientOrigin();
  const origin = state.status === "ready" ? state.origin : null;
  const [filters, setFilters] = useState<StandFilters>({});
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // WHICH SURFACE made the selection, because the two want opposite movement: a card tap moves
  // the map to the card, a pin tap moves the card to the reader. Kept beside the selection
  // rather than in a ref so the follow effect re-runs when it changes.
  const [selectedFrom, setSelectedFrom] = useState<"map" | "list">("list");
  /*
    WHICH LIST the customer is looking at, and — on the seller tab — whose stands are lit.

    Stands is the default because the map is a map of stands; the seller list is the second
    view onto the same island, not a peer destination. `sellerTab` exists only when there are
    sellers to show, so the whole feature is absent rather than empty.
  */
  const [listTab, setListTab] = useState<"stands" | "sellers">("stands");
  const [selectedSellerId, setSelectedSellerId] = useState<string | null>(null);
  /*
    F-118 — THE PIN'S ANSWER WHILE SELLERS ARE SHOWING.

    A pin tap in stand mode selects the stand. In seller mode that is the wrong subject: the
    customer is reading a list of PEOPLE, and a tap that swaps the list out from under them
    answers a question they did not ask. So the pin answers "who sells here" instead, in a
    tooltip on the map, and every name in it is a door into the list they are already reading.

    Its own state rather than a mode of `selectedId`, because it is a different question with a
    different answer. Sharing one field would make "which stand is open" and "which stand am I
    peeking at" the same fact, and they are not.
  */
  const [markerTipStandId, setMarkerTipStandId] = useState<string | null>(null);
  const sellerTab = sellers !== undefined && sellers.length > 0;
  // Sellers are only ever shown on their own tab, so a tab that does not exist cannot be open.
  const showingSellers = sellerTab && listTab === "sellers";
  /*
    The stands the chosen seller sells at, as ids.

    A SET rather than a search per pin: the pin layer runs this for every stand on every render.
    Empty whenever no seller is chosen, which is what makes "no highlight" the resting state
    rather than a special case.
  */
  const highlightedStandIds = useMemo(() => {
    if (!showingSellers || selectedSellerId === null) return new Set<string>();
    return standsForSeller(sellers?.find((entry) => entry.sellerId === selectedSellerId));
  }, [showingSellers, selectedSellerId, sellers]);

  /*
    ONE SEARCH BOX, TWO CORPORA (max, 2026-08-18).

    The seller list used to carry its own field, on the reasoning that a stand is found by what
    is out and where it is while a seller is found by her name and her goods. That is true of the
    CORPUS and false of the question: the customer is asking "what am I looking for" once, and
    two boxes in one header leave them working out which one the list below is listening to.

    So the map's own `sells` term feeds both, and the LIST decides what the word means —
    `applyStandFilters` for stands, `filterSellers` for sellers, each keeping its own rule about
    what is in its haystack.
  */
  const shownSellers = useMemo(
    () => (sellers === undefined ? [] : filterSellers(sellers, filters.sells ?? "")),
    [sellers, filters.sells],
  );

  const cardRefs = useRef(new Map<string, HTMLLIElement>());
  const mapRef = useRef<HTMLElement | null>(null);
  const mapColumnRef = useRef<HTMLDivElement | null>(null);
  const listColumnRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const islandRef = useRef<SVGSVGElement | null>(null);
  /*
    B-088 — THE MAP'S RENDERED SCALE, in real pixels per island unit.

    The tooltip is a `foreignObject`, so everything inside it is measured in viewBox units and
    shrinks with the drawing. Knowing the actual scale is what lets its geometry counter-scale so
    the text lands at a fixed size on a phone and a desktop alike.

    `object-fit: contain` under a `max-height` means WIDTH IS NOT ENOUGH — on a tall narrow phone
    the height is what binds, and the drawing is letterboxed inside the box the element occupies.
    So the scale is the smaller of the two ratios, which is exactly what `contain` picks.
  */
  const [mapScale, setMapScale] = useState(1);

  // The moment the filters are evaluated against, captured once per render rather than read
  // inside the predicate. `openNow` computes the real sun for the date, so the answer must
  // come from one instant — sampling the clock per stand could put two stands on opposite
  // sides of sunset in the same list.
  const moment = useMemo(
    () => ({ at: new Date(), utcOffsetMinutes: -new Date().getTimezoneOffset() }),
    // Recomputed when the filters change, which is when it matters. A ticking clock here
    // would rerender the whole list every second to move one boundary twice a day.
    [filters],
  );

  const view = useMemo(() => buildMapView(stands, origin), [stands, origin]);

  // F-043 — the poster's numbered pins. Numbered over the FULL set before filtering, not over
  // `visible`: a number that renumbers when a filter narrows the list would mean a different
  // farm from one tap to the next. `numberStands` keys the number to the farm alphabetically,
  // so neither filtering nor the distance sort can move it. See the note there.
  const numbered = useMemo(() => numberStands(view.stands), [view.stands]);
  const visible = useMemo(
    () => applyStandFilters(numbered, filters, moment),
    [numbered, filters, moment],
  );
  const ordered = useMemo(
    () => (view.sortedByDistance ? visible : sortStandsByNumber(visible)),
    [view.sortedByDistance, visible],
  );

  // A PIN TAP BRINGS ITS CARD TO THE TOP, so the expanded detail sits beside the map that
  // produced it rather than wherever the stand happened to fall in the directory. Only for
  // selections made from the map: a card tap is answered by the map sliding to meet the card,
  // and reordering the list under the customer's finger as well would move both at once.
  const listVisible = useMemo(
    () => (selectedFrom === "map" ? hoistStand(ordered, selectedId) : ordered),
    [ordered, selectedFrom, selectedId],
  );

  // THE SELECTED PIN IS DRAWN LAST, so it and its halo sit in front of the pins around it.
  // SVG has no `z-index`; the last element painted is the one on top. Without this the pin a
  // customer just tapped can stay buried under its neighbours — worst in the dense clusters
  // where the selection is exactly what they are trying to pick out.
  const pinned = useMemo(
    () => hoistStand(visible, selectedId, "end"),
    [visible, selectedId],
  );

  /*
    F-118 — WHAT THE MARKER TOOLTIP SAYS, and where it sits.

    Derived rather than stored: the only state is WHICH pin is open, so a stand that a filter
    has just removed cannot leave a tooltip hanging over an island it is no longer on. It is
    read from `visible`, the same set the pins come from, which is what guarantees that.

    THE HEIGHT IS COMPUTED because a `foreignObject` does not size to its content — it clips to
    the box it is given, and a box sized for two sellers silently cuts the third off a stand
    that has three. The arithmetic is in the map's own units: a heading, a row per seller, and
    the padding around them.
  */
  useEffect(() => {
    const svg = islandRef.current;
    if (svg === null) return;
    const measure = (): void => {
      const box = svg.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      // `contain` fits by whichever axis runs out first — the same rule the browser applied.
      setMapScale(
        Math.min(box.width / ISLAND_VIEWBOX.width, box.height / ISLAND_VIEWBOX.height),
      );
    };
    measure();
    /*
      GUARDED, not stubbed in the test setup. `ResizeObserver` is absent in jsdom and in older
      browsers, and a tooltip that renders at its designed size is a fine outcome there — a
      hard reference would instead throw during render and take the whole map down. The initial
      `measure()` above has already run, so the scale is correct for the size the map loads at
      even when nothing can watch it change.
    */
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => {
      observer.disconnect();
    };
  }, []);

  const markerTip = useMemo(() => {
    if (!showingSellers || markerTipStandId === null) return undefined;
    const stand = visible.find((entry) => entry.id === markerTipStandId);
    if (stand === undefined) return undefined;
    if (stand.latitude === undefined || stand.longitude === undefined) return undefined;

    const links = standSellerLinks(stand);
    /*
      COUNTER-SCALED so the tooltip renders at a fixed REAL size (B-088). Its contents are
      viewBox units, so a map drawn at 0.39x made "Runs this stand" 6.6 real pixels — text that
      shrank as the screen did. Spanning more units at a smaller scale cancels that exactly.
    */
    const unitScale = markerTipUnitScale(mapScale);
    const size = {
      width: MARKER_TIP_WIDTH * unitScale,
      height:
        (MARKER_TIP_PADDING + MARKER_TIP_ROW * (1 + Math.max(links.length, 1))) * unitScale,
    };
    return {
      stand,
      sellers: links,
      size,
      // Placed by `markerTipBox`, which keeps the box ON the island — the figure clips, and a
      // box centred on a shore pin loses whatever hangs past the edge.
      box: markerTipBox(
        projectToIsland({ latitude: stand.latitude, longitude: stand.longitude }),
        size,
        ISLAND_VIEWBOX,
      ),
    };
  }, [showingSellers, markerTipStandId, visible, mapScale]);

  const advancedFilterCount =
    (filters.openNow === true ? 1 : 0) +
    (filters.confirmedRecently === true ? 1 : 0) +
    (filters.acceptsFarmBucks === true ? 1 : 0) +
    (filters.flowersOnly === true ? 1 : 0) +
    (filters.season !== undefined && filters.season !== "" ? 1 : 0);
  const anyFilterActive =
    advancedFilterCount > 0 ||
    (filters.sells !== undefined && filters.sells.trim() !== "");

  const advancedFiltersVisible = showAdvancedFilters;

  const locationLabel =
    state.status === "ready"
      ? "Nearest first"
      : state.status === "locating"
        ? "Finding you…"
        : "Near me";


  /**
   * THE MAP FOLLOWS A CARD-TAP SELECTION (wide screens only).
   *
   * The directory is a long column beside a short map. Without this the map stays at the top
   * while the customer reads a stand far below it, and the pin they just tapped — or are about
   * to look for — is off screen. So the map slides down to sit beside the selected card, and
   * stops at the bottom of its column when the selection is near the end of the list.
   *
   * ONLY FOR SELECTIONS MADE FROM THE LIST. A pin tap is the opposite situation: the customer
   * is already looking at the map, so it is the CARD that needs to come to them — `select`
   * scrolls it into view instead. Sliding the map on a pin tap also moved it toward the far end
   * of a long directory, which on a 30-stand list carried it out of the visible area entirely.
   *
   * Runs as an effect rather than inside `select` because the offset depends on the card's
   * LAID-OUT position, and selecting a stand expands it: reading the geometry in the click
   * handler would measure the collapsed card and land the map in the wrong place. The effect
   * runs after React has committed the expanded card.
   *
   * PHONE IS UNTOUCHED. There the map is above the list at full width, and translating it
   * would push it off screen or open a gap where it was. The phone's answer to the same
   * problem is the detail sheet, which is already built.
   */
  useEffect(() => {
    const column = mapColumnRef.current;
    if (column === null) return;

    // The transform is a wide-screen affordance. On a phone the map must sit where the
    // document put it, so any offset from a previous wide layout is cleared.
    const isWide = window.matchMedia("(min-width: 56rem)").matches;
    if (!isWide || selectedId === null) {
      column.style.transform = "";
      return;
    }

    // FROM A PIN — the map returns to the top of its column, where `.list-column-hoisted` has
    // just put the selected card. The two are then aligned by LAYOUT rather than by measuring,
    // which is what lets this path work inside VIGA's content-sized iframe.
    //
    // Alignment is not the same as visibility, though. A customer who has scrolled down a long
    // directory ends up with the pair correctly lined up far above the fold — measured in a
    // browser at scrollY 880: map top -580, card top -564, neither on screen. So the page is
    // brought to them.
    //
    // Scrolling to the LAYOUT, not to the card, is what makes this safe. Earlier versions
    // scrolled to the card wherever it sat and dragged the map out of view; the card has
    // already been moved to the layout's top, so this lands on a fixed position that holds
    // both. Verified in a real browser: map fully visible at top 0, card at 16.
    if (selectedFrom === "map") {
      column.style.transform = "";
      layoutRef.current?.scrollIntoView({ block: "start" });
      return;
    }

    const card = cardRefs.current.get(selectedId);
    const list = listColumnRef.current;
    const map = mapRef.current;
    if (card === undefined || list === null || map === null) return;

    const listBox = list.getBoundingClientRect();
    const offset = mapFollowOffset({
      // Measured against the LIST's own top rather than the page's, so the number means the
      // same thing whether or not the page above the columns has grown.
      cardOffset: card.getBoundingClientRect().top - listBox.top,
      mapHeight: map.getBoundingClientRect().height,
      columnHeight: listBox.height,
      // Viewport coordinates, so the map can be kept on screen and not merely inside the
      // column. `getBoundingClientRect` is already relative to the visible area, so the list's
      // own top IS the offset the clamp needs — negative once scrolled past.
      columnTop: listBox.top,
      viewportHeight: window.innerHeight,
    });

    column.style.transform = offset === 0 ? "" : `translateY(${offset}px)`;
  }, [selectedId, selectedFrom, listVisible]);

  /**
   * Selecting from either surface writes the SAME state — one selection, two renderers.
   *
   * WHAT HAPPENS NEXT DEPENDS ON THE VIEWPORT, and that is the design rather than a
   * responsive afterthought:
   *
   *   WIDE — the thing the customer is NOT looking at is the thing that moves. From a card,
   *   the map slides to meet it (the follow effect above). From a pin, the page brings the
   *   expanded card into view: their eyes are already on the map, and sliding it there instead
   *   moved it toward the end of a long directory and out of the visible area.
   *
   *   PHONE — the list is BELOW the map, so scrolling to a card throws away the map the
   *   customer was just reading, and they have to scroll back to tap anything else. Instead
   *   the selected stand rises over the map as a sheet: the detail is one thumb-reach from
   *   the pin that produced it, and dismissing it returns to the view they had. The only
   *   movement is bringing the MAP into the part of the screen the sheet does not cover.
   *
   * Deliberately NOT "hide every other listing" — that would leave the map as the only way
  * back to the full set, and a customer who then changed a filter would see nothing happen.
  */
  function select(id: string, source: "map" | "list" = "map"): void {
    if (selectedId === id) {
      setSelectedId(null);
      return;
    }

    setSelectedId(id);
    setSelectedFrom(source);

    if (source === "list") return;

    // WIDE — bringing the card into view is handled by the follow effect above, after React
    // has committed the expanded card. Scrolling here would measure the COLLAPSED card and stop
    // short of the detail the tap was asking to see.
    const isWide = window.matchMedia("(min-width: 56rem)").matches;
    if (isWide) return;

    // PHONE — bring the unchanged map to the top before the sheet overlays its lower portion.
    // The map must not resize when selection changes: shrinking it moves every marker under
    // the customer's finger and destroys the spatial context they just used to choose a pin.
    // Anchoring the same map instead keeps its scale stable and leaves its upper portion visible.
    //
    // `instant`, not smooth: this is a correction that should feel like the sheet arriving,
    // not a second animation competing with it.
    mapRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  /*
    F-118 — CROSSING FROM THE STAND LIST TO THE SELLER LIST.

    ONE crossing, in one direction. There used to be a matching `goToStand` for the seller card's
    stand rows, but those rows now expand the stand IN PLACE (max, 2026-08-18) — a reader looking
    at a seller stays looking at her — so nothing calls it and it is gone rather than kept
    against a future caller.
  */

  /**
   * What a marker tap means, WHICH DEPENDS ON THE LIST BESIDE IT.
   *
   * The map is a map of stands either way — its pins never change subject. What changes is the
   * question the customer is holding. Reading stands, a pin means "show me this place". Reading
   * sellers, it means "who sells here" — and answering with the stand card would replace the
   * list they are reading with the other one, which is the disorientation the two-list design
   * exists to avoid.
   */
  function tapMarker(standId: string): void {
    if (!showingSellers) {
      select(standId, "map");
      return;
    }

    /*
      THE TOOLTIP IS A DISAMBIGUATION, so a stand with ONE seller does not get one (max,
      2026-08-18). A menu of one asks the customer to confirm what their tap already said. It
      goes straight to her card — which is exactly what the tooltip's single row would have
      done, one tap sooner.

      Read from the same `sellers` list the pins come from, so a stand whose only seller the
      list is not showing falls through to the tooltip and says so, rather than crossing to a
      card that is not there.
    */
    const stand = visible.find((entry) => entry.id === standId);
    const sole = stand === undefined ? [] : standSellerLinks(stand);
    if (sole.length === 1) {
      goToSeller(sole[0]!.sellerId);
      return;
    }

    // Tapping the open pin again closes its tooltip, so the map comes back without hunting for
    // another control — the same gesture that collapses a chosen seller's card.
    setMarkerTipStandId((current) => (current === standId ? null : standId));
  }

  /** Show the seller list with `sellerId` chosen — which lights their stands on the map. */
  function goToSeller(sellerId: string): void {
    setListTab("sellers");
    setSelectedSellerId(sellerId);
    setMarkerTipStandId(null);
    // The stand selection belongs to the other list. Left standing it would keep a stand card
    // expanded and a pin haloed underneath a list about somebody else.
    setSelectedId(null);
  }

  const selectedStand =
    selectedId === null
      ? undefined
      : visible.find((stand) => stand.id === selectedId);

  const toggle = (key: ToggleFilterKey) => () =>
    setFilters((current) => ({ ...current, [key]: current[key] !== true }));

  const clearAllFilters = () => {
    setFilters({});
  };

  return (
    <main className={selectedStand !== undefined ? "page sheet-open" : "page"}>
      <div className="map-intro">
        <header className="farm-map-masthead">
          <img src={farmMapLogo.src} alt="VIGA Farm Map" />
        </header>
      {/*
      F-043 — NO TITLE AND NO EYEBROW (max, 2026-07-30). This page is embedded in VIGA's own
      Squarespace page, which already carries the association's name and its own heading; a
      second "Vashon Island Growers Association / Farm stands, right now" inside the frame is
      the page introducing itself to someone already reading it.

      The honor-system line STAYS, shortened. It is not decoration: it is why every listing
      says "confirmed 4 hours ago" instead of claiming what is in stock right now, and
      dropping it leaves the recency wording looking like hedging rather than the point. Kept
      as a caption above the filters rather than a lede under a title.
      */}
        <p className="map-note">
          Note: This map may contain recent inventory updates, but neither VIGA nor individual
          sellers can guarantee product availability.
        </p>
      </div>

      {/*
      F-043 — the filters. All client-side over data already served: no request, no
      model call, instant on a phone outdoors.
      */}
      {/*
        The section keeps its accessible name even though the heading that used to carry it is
        gone: an unnamed region is one a screen reader cannot announce. `aria-label` states it
        directly rather than pointing at a visible element that no longer exists.
      */}
      <section className="filters" aria-label="Find a stand">
        <header className="filter-header">
          {/*
            THE VIEW TOGGLE, WHERE THE HEADING WAS (max, 2026-08-18).

            "Find a stand" was a heading with tabs beside it, saying the same thing twice — the
            heading named the list and the tab named it again. The toggle IS the label now, and
            its words say what you are looking at rather than what to do.

            The map is a map of STANDS, and a seller who sells only at other people's stands has
            no pin on it — that is why a seller view has to exist at all. It used to be a whole
            separate page, so answering "who sells bread?" meant leaving the map and losing
            every filter on the way back. Two ways of looking at one island, so: one list.

            The stands half shows even with no sellers to switch to, because it is the label. The
            sellers half is absent then, rather than a tab onto an empty list.
          */}
          <div className="list-tabs" role="tablist" aria-label="Stands or sellers">
            {(["stands", ...(sellerTab ? (["sellers"] as const) : [])] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                className="list-tab"
                aria-selected={listTab === tab}
                onClick={() => {
                  setListTab(tab);
                  // The chosen seller belongs to the seller tab. Leaving it lit while the
                  // stand list is up would mark pins for somebody nobody is looking at.
                  setSelectedSellerId(null);
                }}
              >
                {tab === "stands" ? "View stands" : "View sellers"}
              </button>
            ))}
          </div>
          <p className="filter-results" aria-live="polite">
            {showingSellers
              ? `${shownSellers.length} ${shownSellers.length === 1 ? "seller" : "sellers"} shown`
              : visible.length === view.stands.length
                ? `${visible.length} ${visible.length === 1 ? "stand" : "stands"} shown`
                : `${visible.length} of ${view.stands.length} stands shown`}
          </p>
        </header>

        <div className="filter-command-bar">
          <label className="field field-search">
            <span className="sr-only">What they sell, or a farm or stand name</span>
            <span className="field-control">
              <svg className="field-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4 4" />
              </svg>
              <input
                type="search"
                className="field-input"
                placeholder="e.g. “eggs”, “flowers”, stand name…"
                value={filters.sells ?? ""}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    sells: event.target.value,
                  }))
                }
              />
            </span>
          </label>

          <div className="filter-actions">
            <button
              type="button"
              className={state.status === "ready" ? "location-button location-button-on" : "location-button"}
              onClick={state.status === "ready" ? clear : request}
              disabled={state.status === "locating"}
              aria-label={
                state.status === "ready"
                  ? "Nearest first — stop nearby sorting"
                  : locationLabel
              }
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 21s6-5.4 6-11a6 6 0 1 0-12 0c0 5.6 6 11 6 11Z" />
                <circle cx="12" cy="10" r="2" />
              </svg>
              <span>{locationLabel}</span>
              {state.status === "ready" ? (
                <svg className="location-clear-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m7 7 10 10M17 7 7 17" />
                </svg>
              ) : null}
            </button>

            <button
              type="button"
              className={advancedFiltersVisible ? "filter-drawer-button filter-drawer-button-open" : "filter-drawer-button"}
              aria-expanded={advancedFiltersVisible}
              aria-controls="filter-panel"
              aria-label={
                advancedFilterCount > 0
                  ? `Filters, ${advancedFilterCount} active`
                  : "Filters"
              }
              onClick={() => setShowAdvancedFilters((current) => !current)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" />
              </svg>
              <span>Filters</span>
              {advancedFilterCount > 0 ? (
                <span className="filter-drawer-count" aria-hidden="true">
                  {advancedFilterCount}
                </span>
              ) : null}
            </button>
          </div>
        </div>

        {advancedFiltersVisible ? (
          <div className="filter-panel" id="filter-panel" role="group" aria-label="Filter stands">
            {FILTER_GROUPS.map((group) => (
              <fieldset className="filter-panel-group" key={group.title}>
                <legend>{group.title}</legend>
                <div className="filter-panel-options">
                  {group.filters.map((filter) => (
                    <FilterOption
                      key={filter.key}
                      active={filters[filter.key] === true}
                      label={filter.label}
                      onClick={toggle(filter.key)}
                    />
                  ))}
                </div>
              </fieldset>
            ))}

            {/*
              Season answers a DIFFERENT question from Open now — "what is here later in the
              year" — and is meaningful mainly when Open now is off, since out-of-season
              stands are already excluded by that filter. Disabled rather than hidden when
              Open now is on, so the control does not vanish and reappear under the reader's
              thumb.
            */}
            <fieldset className="filter-panel-group filter-panel-season">
              <legend>Season</legend>
              <label className="field field-season">
                <span className="sr-only">Season</span>
                <select
                  className="field-input season-select"
                  value={filters.season ?? ""}
                  disabled={filters.openNow === true}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      season: event.target.value,
                    }))
                  }
                >
                  <option value="">Any season</option>
                  <option value="spring">Spring</option>
                  <option value="summer">Summer</option>
                  <option value="fall">Fall</option>
                  <option value="winter">Winter</option>
                </select>
              </label>
              {anyFilterActive ? (
                <button
                  type="button"
                  className="filter-clear"
                  onClick={clearAllFilters}
                >
                  Clear all
                </button>
              ) : null}
            </fieldset>
          </div>
        ) : null}
      </section>

      <div className="layout" ref={layoutRef}>
        <div className="map-column" ref={mapColumnRef}>
          {/*
          F-043 — the island, drawn rather than tiled. No mapping provider, no per-view
          billing, no runtime seam; `maps/README.md` records that there deliberately is none.
          Pins are projected from real coordinates through the SAME projection that draws the
          coastline, so a pin cannot drift away from the shore it belongs to.
          */}
          <figure className="island" ref={mapRef}>
          <MarkerLegend />
          <svg
            ref={islandRef}
            viewBox={`0 0 ${ISLAND_VIEWBOX.width} ${ISLAND_VIEWBOX.height}`}
            className="island-svg"
            role="img"
            aria-label="Map of Vashon and Maury Islands showing farm stand locations"
          >
            <IslandArtwork />
            <g className="pin-layer">
            {pinned.map((stand) => {
              // F-038 — a contact-only farm has no coordinate and gets NO PIN. It stays in
              // the list beside the map, because "no stand to visit" is a fact about how to
              // buy from them, not a reason to disappear.
              if (stand.latitude === undefined || stand.longitude === undefined) {
                return null;
              }
              const { x, y } = projectToIsland({
                latitude: stand.latitude,
                longitude: stand.longitude,
              });
              const isSelected = stand.id === selectedId;
              const markerKind = mapMarkerKind(stand);
              return (
                <g
                  key={stand.id}
                  className={[
                    "pin",
                    `pin-${markerKind}`,
                    `pin-${stand.openState}`,
                    isSelected ? "pin-selected" : "",
                    // Dimmed rather than hidden while a seller is chosen: the other stands are
                    // still real places, and removing them would redraw the island under a
                    // customer who is only asking where one baker sells.
                    highlightedStandIds.size > 0 && !highlightedStandIds.has(stand.id)
                      ? "pin-seller-dimmed"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-stand-id={stand.id}
                  {...(highlightedStandIds.has(stand.id)
                    ? { "data-seller-highlighted": "true" }
                    : {})}
                  role="button"
                  tabIndex={0}
                  aria-label={`${stand.standNumber}. ${stand.locationName}, ${stand.farmName}`}
                  aria-pressed={showingSellers ? stand.id === markerTipStandId : isSelected}
                  onClick={() => tapMarker(stand.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      tapMarker(stand.id);
                    }
                  }}
                >
                  {/*
                    ONE MARK FOR "YOU PICKED THIS", BOTH LISTS (max, 2026-08-18). A chosen stand
                    and a chosen seller's stands wear the SAME halo — the seller highlight used
                    to draw a thin stroke on the pin shape instead, so the same map said "picked"
                    two different ways depending on which list was open.
                  */}
                  {isSelected || highlightedStandIds.has(stand.id) ? (
                    <circle
                      cx={x}
                      cy={y - 34}
                      r={58}
                      className="pin-selection-halo"
                      aria-hidden="true"
                    />
                  ) : null}
                  {markerKind === "flower-only" ? (
                    <g
                      className="pin-flower-glyph"
                      transform={`translate(${x} ${y - 34})`}
                      aria-hidden="true"
                    >
                      <circle className="pin-flower-petal" cx="0" cy="-24" r="18" />
                      <circle className="pin-flower-petal" cx="23" cy="-7" r="18" />
                      <circle className="pin-flower-petal" cx="14" cy="20" r="18" />
                      <circle className="pin-flower-petal" cx="-14" cy="20" r="18" />
                      <circle className="pin-flower-petal" cx="-23" cy="-7" r="18" />
                      <circle className="pin-flower-center" cx="0" cy="0" r="17" />
                    </g>
                  ) : (
                    <path
                      className={
                        markerKind === "farmers-market"
                          ? "pin-market-shape"
                          : "pin-shape"
                      }
                      d="M 0 0 C -20 -24 -30 -34 -30 -48 A 30 30 0 1 1 30 -48 C 30 -34 20 -24 0 0 Z"
                      transform={`translate(${x} ${y})`}
                      aria-hidden="true"
                    />
                  )}
                  {/*
                  The poster's numbered pin. `pointer-events: none` in CSS — the number sits
                  ON the circle, and without it a tap landing on the digits would miss the
                  button underneath, which is most of the pin's tappable area.

                  The number is decorative HERE because the circle's `aria-label` already
                  reads it; a screen reader meeting both would hear the number twice.
                  */}
                  <text x={x} y={y - 34} className="pin-number" aria-hidden="true">
                    {stand.standNumber}
                  </text>
                </g>
              );
            })}
            </g>
            {/*
              F-118 — THE MARKER TOOLTIP, ANCHORED IN THE MAP'S OWN COORDINATES.

              Inside the SVG rather than layered over it in HTML, and that is load-bearing: the
              island is drawn to a viewBox and rendered `object-fit: contain` under a `max-height`
              on phones, so the pixel box the figure occupies is NOT the box the artwork fills.
              An HTML overlay positioned from a projected point would sit correctly on a desktop
              and drift away from its pin on exactly the device this map is built for. A
              `foreignObject` is placed by the same coordinate system that placed the pin, so it
              cannot come apart from it.

              Drawn AFTER the pin layer so it paints over the pins around it — SVG has no
              `z-index`, and the tooltip must not be buried by the cluster it is explaining.
            */}
            {markerTip === undefined ? null : (
              <foreignObject
                className="marker-tip-anchor"
                x={markerTip.box.x}
                y={markerTip.box.y}
                width={markerTip.size.width}
                height={markerTip.size.height}
              >
                <div className="marker-tip">
                  <p className="marker-tip-stand">{markerTip.stand.locationName}</p>
                  {markerTip.sellers.length === 0 ? (
                    /*
                      A stand can have no seller rows at all — a venue nobody has been invited
                      to. Saying so is the honest answer to "who sells here"; an empty tooltip
                      reads as a broken one.
                    */
                    <p className="marker-tip-empty">No seller listed here yet.</p>
                  ) : (
                    <ul className="marker-tip-sellers">
                      {markerTip.sellers.map((link) => (
                        <li key={link.sellerId}>
                          <button
                            type="button"
                            className="marker-tip-seller"
                            onClick={() => goToSeller(link.sellerId)}
                          >
                            {link.sellerName}
                          </button>
                          {link.relation === "own" ? (
                            <span className="marker-tip-owner">Runs this stand</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </foreignObject>
            )}
            <g className="pin-label-layer" aria-hidden="true">
              {visible.map((stand) => {
                if (stand.id !== selectedId) return null;
                if (stand.latitude === undefined || stand.longitude === undefined) return null;
                const { x, y } = projectToIsland({
                  latitude: stand.latitude,
                  longitude: stand.longitude,
                });
                return (
                  <text key={stand.id} x={x} y={y - 88} className="pin-label">
                    {stand.farmName}
                  </text>
                );
              })}
            </g>
          </svg>
          <img
            className="island-viga-logo"
            src={vigaWheelbarrow.src}
            alt="Vashon Island Growers Association"
          />
          <figcaption className="island-caption">
            {visible.length === view.stands.length
              ? `${view.stands.length} farm stands`
              : `${visible.length} of ${view.stands.length} farm stands`}
          </figcaption>
          </figure>
        </div>

        {/*
          When a pin tap hoists a card to the top of the directory, the preamble above the list
          is demoted below it so the card sits level with the map — see `.list-column-hoisted`.
        */}
        <div
          className={
            selectedFrom === "map" && selectedId !== null
              ? "list-column list-column-hoisted"
              : "list-column"
          }
          ref={listColumnRef}
        >
          <div className="farm-map-key" aria-label="Farm map key">
            <span className="poster-indicator poster-indicator-no-viga-bucks">
              <span className="poster-dot" aria-hidden="true" />
              Doesn't take VIGA Bucks
            </span>
            <span className="poster-indicator poster-indicator-year-round">
              <span className="poster-dot" aria-hidden="true" />
              Year-round
            </span>
            <span className="poster-indicator poster-indicator-late-november">
              <span className="poster-dot" aria-hidden="true" />
              Thru late November
            </span>
          </div>

          {/*
            THE SELLER LIST, in the same column the stand cards use (max, 2026-08-18). It reads
            the map's OWN search term — see `shownSellers` — so the header carries one box and
            one question rather than two fields the customer has to tell apart.
          */}
          {showingSellers ? (
            <div className="seller-browse">
              {shownSellers.length === 0 ? (
                /*
                  A search that matched nothing says so. It must never fall back to the whole
                  list, which would look like working search and answer every question with
                  "everyone" — the seller directory's own rule, kept here.
                */
                <p className="empty">
                  No seller matches “{(filters.sells ?? "").trim()}”. Try a different word, or
                  switch to View stands.
                </p>
              ) : (
                /*
                  THE STAND CARD'S OWN LIST, carrying sellers (max, 2026-08-18).

                  Same `ul.stands`, same `li.stand`, same heading button and expand-on-tap. Two
                  card vocabularies on one surface would make a customer re-learn the list every
                  time they switched tabs, and would give every future card change two homes.
                  What differs is the METADATA, because that is the only thing that actually
                  differs: a seller has no pin, no hours and no confirmed stock — she has a
                  place she sells and a list of what she usually brings.
                */
                <ul className="stands">
                  {shownSellers.map((seller) => (
                    <SellerCard
                      key={seller.sellerId}
                      seller={seller}
                      // The VISIBLE stands, not every numbered one: the card counts how many of
                      // her stands are open and offers them as destinations, and a filtered-out
                      // stand is one the customer cannot get to from this list right now.
                      stands={visible}
                      chosen={seller.sellerId === selectedSellerId}
                      // Pressing the chosen seller again clears the highlight, so the island
                      // comes back without hunting for another control.
                      onToggle={() =>
                        seller.sellerId === selectedSellerId
                          ? setSelectedSellerId(null)
                          : goToSeller(seller.sellerId)
                      }
                      onGoToSeller={goToSeller}
                    />
                  ))}
                </ul>
              )}
            </div>
          ) : /*
            F-043 — an empty filter result SAYS SO rather than rendering blank, and says which
            control emptied it. A blank column reads as a broken page.
          */
          visible.length === 0 ? (
            <p className="empty">
              {view.stands.length === 0
                ? "No stand has a current listing right now. Farmers update these themselves, so check back — and stands may still have produce out."
                : "No stands match these filters. Try clearing one — stands with no listed hours are always shown, so this means the ones we know about are ruled out."}
            </p>
          ) : (
            <ul className="stands">
              {listVisible.map((stand) => (
                <li
                  key={stand.id}
                  ref={(node) => {
                    if (node) cardRefs.current.set(stand.id, node);
                    else cardRefs.current.delete(stand.id);
                  }}
                  className={[
                    "stand",
                    stand.id === selectedId ? "stand-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={(event) => {
                    if (event.target instanceof Element && event.target.closest("a, button")) {
                      return;
                    }
                    select(stand.id, "list");
                  }}
                >
                  <PosterIndicators stand={stand} compact />
                  <div className="stand-content">
                    <div className="stand-head">
                    {/*
                    The number matching this stand's pin (F-043). Marked decorative because
                    the heading beside it already names the stand — a screen reader gains
                    nothing from a bare digit, while a sighted customer uses it to find the
                    pin. It is `aria-hidden` for the same reason the pin's is.
                    */}
                    <span className="stand-number" aria-hidden="true">
                      {stand.standNumber})
                    </span>
                    <div className="stand-heading-copy">
                      <h2>
                        <button
                          type="button"
                          className="stand-summary-toggle"
                          aria-expanded={stand.id === selectedId}
                          onClick={() => select(stand.id, "list")}
                        >
                          {stand.locationName}
                        </button>
                      </h2>
                      {stand.locationKind !== "farmers_market" &&
                      stand.locationName !== stand.farmName ? (
                        <p className="farm">{stand.farmName}</p>
                      ) : null}
                      <StandSummaryMeta stand={stand} />
                    </div>
                    {stand.distanceLabel !== undefined ? (
                      <span className="distance">{stand.distanceLabel}</span>
                    ) : null}
                    </div>
                    <div className="stand-details">
                      {stand.id === selectedId ? (
                        <StandDetailBody
                          stand={stand}
                          showDestination={false}
                          onGoToSeller={goToSeller}
                        />
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/*
        F-043 — THE SELECTED STAND, ON A PHONE.

        Rendered only in the phone arrangement (CSS hides it wide, where the list is already
        beside the map). Tapping a pin used to scroll the page ~800px to a card, which threw
        away the map the customer was reading and left them scrolling back to tap anything
        else — spatial disorientation on the one screen that is meant to orient them.

        A sheet instead: the map stays exactly where it was, the detail rises over it within
        thumb reach, and dismissing it returns to the same view. This is a SUMMARY, not a
        second copy of the card — name, farm, open state, address, directions. The full card
        is still in the list below, so nothing here is the only route to anything.
      */}
      {selectedStand !== undefined ? (
        <div
          className="sheet"
          role="dialog"
          aria-modal="false"
          aria-label={`${selectedStand.locationName} details`}
        >
          <div className="sheet-grip" aria-hidden="true" />
          <div className="sheet-head">
            <div>
              <h2 className="sheet-title">
                <span className="stand-number" aria-hidden="true">
                  {selectedStand.standNumber}
                </span>
                {/*
                The name is its own element rather than a bare text node. The badge beside it
                is `aria-hidden`, so assistive tech already skips it — but the heading's TEXT
                still concatenates to "12Holmestead Farms", which is what anything reading the
                accessible name as a string gets. Wrapping keeps the two separable.
                */}
                <span className="sheet-title-name">
                  {selectedStand.locationName}
                </span>
              </h2>
              {selectedStand.locationKind !== "farmers_market" &&
              selectedStand.locationName !== selectedStand.farmName ? (
                <p className="sheet-farm">{selectedStand.farmName}</p>
              ) : null}
              <PosterIndicators stand={selectedStand} />
              <p className="sheet-address">
                <DetailIcon kind="directions" />
                {selectedStand.address ??
                  (selectedStand.latitude !== undefined && selectedStand.longitude !== undefined
                    ? "See the map pin — no street address listed"
                    : "No stand to visit — order by contacting this farm")}
              </p>
            </div>
            <button
              type="button"
              className="sheet-close"
              onClick={() => setSelectedId(null)}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <StandDetailBody
            stand={selectedStand}
            showDestination={false}
            onGoToSeller={goToSeller}
          />
        </div>
      ) : null}

      <footer className="foot contact-card-footer">
        {/*
          F-039 — the one-tap way to save the number instead of copying it off a sign.

          THE COPY IS COMPLIANCE-RELEVANT. Saving a contact is a device-local act: it grants
          nothing, records nothing, and is NOT `JOIN`. So this link says only what it does —
          "saves the number" — and states plainly that it does not sign anyone up. It
          deliberately names no consent keyword: putting JOIN next to a "save" button invites a
          reader to conflate the two acts, which is the misrepresentation this wording avoids.
          The card itself carries the same boundary, asserted in `core/src/public/vcard.ts`.

          `download` is a hint, not the mechanism — the served `Content-Type` and
          `Content-Disposition` are what open the native add-contact sheet.
        */}
        <p className="contact-card-cta">
          <a className="contact-card-link" href={CONTACT_CARD_PATH} download>
            <svg
              className="contact-card-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
              <circle cx="8" cy="9.5" r="2.25" />
              <path d="M4.75 16c.45-2.1 1.55-3.15 3.25-3.15S10.8 13.9 11.25 16" />
              <path d="M14.5 9h3.5M14.5 13h3.5" />
            </svg>
            Save Farm Friend Contact
          </a>
          <span className="contact-card-note">
            Adds the VIGA Farm Friend number to your phone&apos;s contacts. This does not sign
             you up for messages.
          </span>
        </p>
      </footer>
    </main>
  );
}
