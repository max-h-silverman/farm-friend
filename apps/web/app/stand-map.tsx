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

function ParticipantNames({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null;
  return (
    <section className="stand-participants" aria-label="Also selling here">
      <DetailSectionHeading icon="participants">Also selling here</DetailSectionHeading>
      <ul className="participant-names">
        {names.map((name) => (
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
function StandListings({ stand }: { stand: FilteredStand }) {
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
 return (
   <div className="stand-summary-meta">
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
}: {
  stand: FilteredStand & MapViewStand;
  showDestination?: boolean;
}) {
  const isMarket = stand.locationKind === "farmers_market";
  const description = stand.description;
  const links = stand.links ?? [];
  const stateLabel =
    stand.closure?.state === "active" ? stand.closure.label : openStateLabel(stand);

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
          <StandListings stand={stand} />
          <ParticipantNames names={stand.alsoSellingHere} />
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

export function StandMap({ stands }: { stands: PublicStandPayload[] }) {
  const { state, request, clear } = useTransientOrigin();
  const origin = state.status === "ready" ? state.origin : null;
  const [filters, setFilters] = useState<StandFilters>({});
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // WHICH SURFACE made the selection, because the two want opposite movement: a card tap moves
  // the map to the card, a pin tap moves the card to the reader. Kept beside the selection
  // rather than in a ref so the follow effect re-runs when it changes.
  const [selectedFrom, setSelectedFrom] = useState<"map" | "list">("list");
  const cardRefs = useRef(new Map<string, HTMLLIElement>());
  const mapRef = useRef<HTMLElement | null>(null);
  const mapColumnRef = useRef<HTMLDivElement | null>(null);
  const listColumnRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);

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
          farms can guarantee product availability.
        </p>
      </div>

      {/*
      F-043 — the filters. All client-side over data already served: no request, no
      model call, instant on a phone outdoors.
      */}
      <section className="filters" aria-labelledby="stand-finder-title">
        <header className="filter-header">
          <h2 id="stand-finder-title">Find a stand</h2>
          <p className="filter-results" aria-live="polite">
            {visible.length === view.stands.length
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
                placeholder="Search eggs, flowers, Bart's Cart…"
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
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  role="button"
                  tabIndex={0}
                  aria-label={`${stand.standNumber}. ${stand.locationName}, ${stand.farmName}`}
                  aria-pressed={isSelected}
                  onClick={() => select(stand.id, "map")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      select(stand.id, "map");
                    }
                  }}
                >
                  {isSelected ? (
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
            F-043 — an empty filter result SAYS SO rather than rendering blank, and says which
            control emptied it. A blank column reads as a broken page.
          */}
          {visible.length === 0 ? (
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
                        <StandDetailBody stand={stand} showDestination={false} />
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

          <StandDetailBody stand={selectedStand} showDestination={false} />
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
