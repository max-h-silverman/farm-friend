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
  numberStands,
  sortStandsByNumber,
  standListingLines,
  type FilteredStand,
  type MapViewStand,
  type PublicStandPayload,
  type StandFilters,
} from "../lib/map-view";
import { IslandArtwork } from "./island-artwork";
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
  // The honest one. Shown whenever a stand is displayed under a filter it could not be judged
  // against, so "shown" never silently becomes "shown as open".
  unknown: "Hours not listed",
};

type ToggleFilterKey =
  | "openNow"
  | "confirmedRecently"
  | "visitable"
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
      { key: "visitable", label: "Has a stand to visit" },
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

function ParticipantNames({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="stand-participants">
      <p className="stand-participants-label">Also selling here</p>
      <ul className="participant-names">
        {names.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </div>
  );
}

type PosterIndicator = {
  kind: "no-viga-bucks" | "year-round" | "late-november" | "contact-only";
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
  if (stand.visitability === "contact_only") {
    indicators.push({ kind: "contact-only", label: "No farm stand to visit" });
  }
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
    <div className="stand-description">
      <p className="listing-label">{label}</p>
      <p className="description-text">{parts}</p>
    </div>
  );
}

function splitWebsite(description: string | undefined): {
  description: string | undefined;
  website: string | undefined;
} {
  if (description === undefined) return { description: undefined, website: undefined };

  let website: string | undefined;
  const remaining = description.split("\n").filter((line) => {
    if (website !== undefined) return true;
    const match = line.match(/^\s*Website:\s*((?:https?:\/\/|www\.)\S+)\s*$/i);
    if (match === null) return true;
    const visible = match[1]!.replace(/[.,;:!?)]*$/, "");
    website = /^www\./i.test(visible) ? `https://${visible}` : visible;
    return false;
  });
  const remainingDescription = remaining.join("\n").trim();
  return {
    description: remainingDescription === "" ? undefined : remainingDescription,
    website,
  };
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

function StandListings({ stand }: { stand: FilteredStand }) {
  return (
    <section className="detail-inventory" aria-label="Availability and inventory">
      {standListingLines(stand).map((line) => (
        <div className={`listing listing-${line.kind}`} key={line.kind}>
          {line.items === undefined ? (
            <p className="listing-note">{line.label}</p>
          ) : (
            <>
              <p className="listing-label">{line.label}</p>
              <ul className={line.kind === "confirmed" ? "items" : "items items-usual"}>
                {line.kind === "confirmed"
                  ? stand.items.map((item, index) => (
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
                    ))
                  : line.items.map((item) => (
                      <li key={item}>
                        <span className="item-name">{item}</span>
                      </li>
                    ))}
              </ul>
            </>
          )}
        </div>
      ))}
    </section>
  );
}

/** One hierarchy for both the expanded directory row and the phone map sheet. */
function StandSummaryMeta({ stand }: { stand: FilteredStand & MapViewStand }) {
  const { website } = splitWebsite(stand.description);

 return (
   <div className="stand-summary-meta">
     <div className="stand-summary-location">
       <p className="stand-summary-address">
         {stand.address ?? "No farm stand to visit"}
       </p>

       {website !== undefined ? (
         <a
           className="stand-summary-website"
           href={website}
           target="_blank"
           rel="noreferrer noopener"
         >
           Website
         </a>
       ) : null}
     </div>

     {stand.stale === true ? (
       <span className="stand-summary-freshness">Needs confirmation</span>
     ) : null}
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
  const { description, website } = splitWebsite(stand.description);
  const stateLabel =
    stand.closure?.state === "active"
      ? stand.closure.label
      : OPEN_STATE_LABEL[stand.openState];

  return (
    <div className="stand-detail-body">
      {showDestination ? (
        <section
          className="detail-visit"
          aria-label={isMarket ? "Visit the market" : "Plan your visit"}
        >
          <h3>{isMarket ? "Visit the market" : "Plan your visit"}</h3>
          {stand.address !== undefined ? (
            <p className="address">{stand.address}</p>
          ) : (
            <p className="address address-contact-only">
              <strong>No stand to visit</strong> — order by contacting this farm.
            </p>
          )}
          {website !== undefined ? (
            <a
              className="stand-website"
              href={website}
              target="_blank"
              rel="noreferrer noopener"
            >
              Website
            </a>
          ) : null}
          {stand.routingLink !== null ? (
            <a
              className="directions"
              href={stand.routingLink}
              target="_blank"
              rel="noreferrer noopener"
            >
              {isMarket ? "Directions to market" : "Get directions"}
            </a>
          ) : null}
        </section>
      ) : stand.routingLink !== null ? (
        <div className="detail-actions">
          <a
            className="directions"
            href={stand.routingLink}
            target="_blank"
            rel="noreferrer noopener"
          >
            {isMarket ? "Directions to market" : "Get directions"}
          </a>
        </div>
      ) : null}

      <div className="detail-status" aria-label="Stand status">
        {stand.closure?.state === "upcoming" ? (
          <p className="open-state open-state-upcoming">{stand.closure.label}</p>
        ) : null}
        {stateLabel !== null ? (
          <p className={`open-state open-state-${stand.openState}`}>{stateLabel}</p>
        ) : null}
        {stand.farmBucksAccepted === true ? (
          <p className="payment-status">Accepts VIGA Bucks</p>
        ) : null}
      </div>

      {isMarket ? (
        <PublicDescription
          description={description}
          label="Market schedule and information"
        />
      ) : (
        <>
          <StandListings stand={stand} />
          <ParticipantNames names={stand.alsoSellingHere} />
        </>
      )}

      {!isMarket && stand.stale === true ? (
        <p className="recency recency-stale">
          <strong>May be out of date — </strong>
          {stand.updated}
        </p>
      ) : null}

      {!isMarket ? <PublicDescription description={description} /> : null}
    </div>
  );
}

export function StandMap({ stands }: { stands: PublicStandPayload[] }) {
  const { state, request, clear } = useTransientOrigin();
  const origin = state.status === "ready" ? state.origin : null;
  const [filters, setFilters] = useState<StandFilters>({});
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLLIElement>());
  const mapRef = useRef<HTMLElement | null>(null);

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
  const listVisible = useMemo(
    () => (view.sortedByDistance ? visible : sortStandsByNumber(visible)),
    [view.sortedByDistance, visible],
  );

  const advancedFilterCount =
    (filters.openNow === true ? 1 : 0) +
    (filters.confirmedRecently === true ? 1 : 0) +
    (filters.visitable === true ? 1 : 0) +
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
   * Selecting from either surface writes the SAME state — one selection, two renderers.
   *
   * WHAT HAPPENS NEXT DEPENDS ON THE VIEWPORT, and that is the design rather than a
   * responsive afterthought:
   *
   *   WIDE — the list is already on screen beside the map, so the card only needs bringing
   *   into view. `smooth` was replaced with an instant scroll: the animation took long enough
   *   that a customer tapping a second pin was still watching the first one travel.
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

    if (source === "list") {
      setSelectedId(id);
      return;
    }

    setSelectedId(id);

    const isWide = window.matchMedia("(min-width: 56rem)").matches;
    if (isWide) {
      cardRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
      return;
    }

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
            <span className="sr-only">What they sell</span>
            <span className="field-control">
              <svg className="field-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4 4" />
              </svg>
              <input
                type="search"
                className="field-input"
                placeholder="Search eggs, flowers, lamb…"
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

      <div className="layout">
        <div className="map-column">
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
            {visible.map((stand) => {
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

        <div className="list-column">
          {view.staleCount > 0 ? (
            <p className="stale-summary" role="note">
              {view.staleCount === 1
                ? "1 listing needs a recent confirmation."
                : `${view.staleCount} listings need a recent confirmation.`}{" "}
              They remain visible and are labeled below.
            </p>
          ) : null}

          <div className="farm-map-key" aria-label="Farm map key">
            <span className="poster-indicator poster-indicator-no-viga-bucks">
              <span className="poster-dot" aria-hidden="true" />
              Does not accept VIGA Bucks
            </span>
            <span className="poster-indicator poster-indicator-year-round">
              <span className="poster-dot" aria-hidden="true" />
              Open year-round
            </span>
            <span className="poster-indicator poster-indicator-late-november">
              <span className="poster-dot" aria-hidden="true" />
              Open until late November
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
                    stand.stale === true ? "stand-stale" : "",
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

          <StandDetailBody stand={selectedStand} />
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
