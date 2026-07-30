"use client";

import { useMemo, useRef, useState } from "react";
import { PROXIMITY_BASIS_LABEL } from "@farm-friend/core/proximity";
import { CONTACT_CARD_PATH } from "@farm-friend/core/vcard";
import {
  ISLAND_VIEWBOX,
  projectToIsland,
} from "@farm-friend/core/island-projection";
import {
  applyStandFilters,
  buildMapView,
  standListingLines,
  type FilteredStand,
  type PublicStandPayload,
  type StandFilters,
} from "../lib/map-view";
import { IslandArtwork } from "./island-artwork";
import { useTransientOrigin } from "./use-transient-origin";

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
  closed: "Closed right now",
  closed_today: "Closed today",
  out_of_season: "Closed for the season",
  by_appointment: "By appointment",
  // The honest one. Shown whenever a stand is displayed under a filter it could not be judged
  // against, so "shown" never silently becomes "shown as open".
  unknown: "Hours not listed",
};

export function StandMap({ stands }: { stands: PublicStandPayload[] }) {
  const { state, request, clear } = useTransientOrigin();
  const origin = state.status === "ready" ? state.origin : null;
  const [filters, setFilters] = useState<StandFilters>({});
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
  const visible = useMemo(
    () => applyStandFilters(view.stands, filters, moment),
    [view.stands, filters, moment],
  );

  const anyFilterActive =
    filters.openNow === true ||
    filters.confirmedRecently === true ||
    filters.visitable === true ||
    (filters.sells !== undefined && filters.sells.trim() !== "") ||
    (filters.season !== undefined && filters.season !== "");

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
  function select(id: string): void {
    setSelectedId(id);

    const isWide = window.matchMedia("(min-width: 56rem)").matches;
    if (isWide) {
      cardRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
      return;
    }

    // PHONE — the sheet occupies the lower ~40% of the screen, so bring the MAP up into the
    // part that stays visible. Without this, tapping a pin near the bottom of the island hid
    // the very pin that was tapped behind the sheet, which is the disorientation this whole
    // change exists to remove. Measured in a browser: the sheet's top edge sat at 60% of the
    // viewport with 0px of island showing beneath it.
    //
    // `instant`, not smooth: this is a correction that should feel like the sheet arriving,
    // not a second animation competing with it.
    mapRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  const selectedStand =
    selectedId === null
      ? undefined
      : visible.find((stand) => stand.id === selectedId);

  const toggle = (key: "openNow" | "confirmedRecently" | "visitable") => () =>
    setFilters((current) => ({ ...current, [key]: current[key] !== true }));

  return (
    <main className={selectedStand !== undefined ? "page sheet-open" : "page"}>
      <header className="masthead">
        <p className="eyebrow">Vashon Island Growers Association</p>
        <h1>Farm stands, right now</h1>
        <p className="lede">
          What island farmers have confirmed at their stands. Most are unattended and
          honor-system, so we show <strong>when each was last confirmed</strong> rather than
          promising what is there.
        </p>
      </header>

      {/*
      F-043 — the filters. All client-side over data already served: no request, no
      model call, instant on a phone outdoors.
      */}
      <section className="filters" aria-label="Filter farm stands">
      <div className="filter-row">
        <button
          type="button"
          className={filters.openNow === true ? "chip chip-on" : "chip"}
          aria-pressed={filters.openNow === true}
          onClick={toggle("openNow")}
        >
          Open now
        </button>
        <button
          type="button"
          className={
            filters.confirmedRecently === true ? "chip chip-on" : "chip"
          }
          aria-pressed={filters.confirmedRecently === true}
          onClick={toggle("confirmedRecently")}
        >
          Confirmed recently
        </button>
        <button
          type="button"
          className={filters.visitable === true ? "chip chip-on" : "chip"}
          aria-pressed={filters.visitable === true}
          onClick={toggle("visitable")}
        >
          Has a stand to visit
        </button>
      </div>

      <div className="filter-row">
        <label className="field">
          <span className="field-label">What they sell</span>
          <input
            type="search"
            className="field-input"
            placeholder="eggs, flowers, lamb…"
            value={filters.sells ?? ""}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                sells: event.target.value,
              }))
            }
          />
        </label>

        {/*
          Season answers a DIFFERENT question from Open now — "what is here later in the
          year" — and is meaningful mainly when Open now is off, since out-of-season
          stands are already excluded by that filter. Disabled rather than hidden when
          Open now is on, so the control does not vanish and reappear under the reader's
          thumb.
        */}
        <label className="field">
          <span className="field-label">In season</span>
          <select
            className="field-input"
            value={filters.season ?? ""}
            disabled={filters.openNow === true}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                season: event.target.value,
              }))
            }
          >
            <option value="">Any time of year</option>
            <option value="spring">Spring</option>
            <option value="summer">Summer</option>
            <option value="fall">Fall</option>
            <option value="winter">Winter</option>
          </select>
        </label>
      </div>

      <div className="filter-row filter-row-meta">
        {state.status !== "ready" ? (
          <>
            <button
              type="button"
              className="chip"
              onClick={request}
              disabled={state.status === "locating"}
            >
              {state.status === "locating" ? "Finding you…" : "Sort by distance"}
            </button>
            <span className="locate-note">
              {state.status === "unavailable"
                ? state.reason
                : "Optional. Your location stays on your device and is never sent to us."}
            </span>
          </>
        ) : (
          <>
            <button type="button" className="chip chip-on" onClick={clear}>
              Sorted by distance — stop
            </button>
            <span className="locate-note">{PROXIMITY_BASIS_LABEL}</span>
          </>
        )}
        {anyFilterActive ? (
          <button
            type="button"
            className="chip chip-clear"
            onClick={() => setFilters({})}
          >
            Clear filters
          </button>
        ) : null}
      </div>
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
          <svg
            viewBox={`0 0 ${ISLAND_VIEWBOX.width} ${ISLAND_VIEWBOX.height}`}
            className="island-svg"
            role="img"
            aria-label="Map of Vashon and Maury Islands showing farm stand locations"
          >
            <IslandArtwork />
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
              return (
                <g
                  key={stand.id}
                  className={[
                    "pin",
                    `pin-${stand.openState}`,
                    stand.stale === true ? "pin-stale" : "",
                    isSelected ? "pin-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <circle
                    cx={x}
                    cy={y}
                    r={isSelected ? 15 : 10}
                    className="pin-dot"
                    role="button"
                    tabIndex={0}
                    aria-label={`${stand.locationName}, ${stand.farmName}`}
                    aria-pressed={isSelected}
                    onClick={() => select(stand.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        select(stand.id);
                      }
                    }}
                  />
                  {isSelected ? (
                    <text x={x} y={y - 22} className="pin-label">
                      {stand.locationName}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
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
                ? "One listing below has not been confirmed recently."
                : `${view.staleCount} listings below have not been confirmed recently.`}{" "}
              They are still shown, marked, because old information beats none.
            </p>
          ) : null}

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
              {visible.map((stand) => (
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
                  onClick={() => select(stand.id)}
                >
                  <div className="stand-head">
                    <h2>{stand.locationName}</h2>
                    {stand.distanceLabel !== undefined ? (
                      <span className="distance">{stand.distanceLabel}</span>
                    ) : null}
                  </div>
                  <p className="farm">{stand.farmName}</p>

                  {/*
                    F-043 — the open-state badge, and the honesty rule it carries.

                    A stand shown under "Open now" that we could NOT judge says "Hours not
                    listed" here. That is what makes showing it honest rather than a silent
                    claim that it is open: the filter keeps it because absence of data is not
                    evidence of being shut, and this line says which one it is.

                    NEVER COLOUR ALONE. The badge is words; the class only styles them. The
                    existing three-signal staleness rule holds for the same reason.
                  */}
                  {OPEN_STATE_LABEL[stand.openState] !== null ? (
                    <p className={`open-state open-state-${stand.openState}`}>
                      {OPEN_STATE_LABEL[stand.openState]}
                    </p>
                  ) : null}

                  {/*
                    F-042 — WHICH LINES a stand gets is decided by `standListingLines`, not
                    here. This block prints them and chooses nothing.

                    That split is the whole design. The copy max approved rests on one rule — a
                    "Usually sells" line NEVER carries a timestamp, because a date beside it
                    reads as a confirmation nobody made — and a rule that load-bearing cannot
                    live in a conditional chain inside JSX that no test renders. It lives in a
                    pure function with a sabotage-verified test on exactly that property.

                    So: no `stand.updated`, no `stand.items.length`, and no `visitability`
                    checks below. Reintroducing one would put the decision back in two places,
                    and the copy would be one careless edit from claiming a confirmation.
                  */}
                  {standListingLines(stand).map((line) => (
                    <div className={`listing listing-${line.kind}`} key={line.kind}>
                      {line.items === undefined ? (
                        <p className="listing-note">{line.label}</p>
                      ) : (
                        <>
                          <p className="listing-label">{line.label}</p>
                          {line.kind === "confirmed" ? (
                            // The confirmed line keeps the per-item detail a farmer actually
                            // published — quantity, unit, price. A tag has none of that by
                            // nature: it is a word off a form, so `usual` below renders names
                            // only. Attaching a quantity to a tag would be the same class of
                            // invention as attaching a date to one.
                            <ul className="items">
                              {stand.items.map((item, index) => (
                                <li key={`${stand.id}-${index}`}>
                                  <span className="item-name">{item.itemName}</span>
                                  {item.quantity !== undefined ||
                                  item.approximation !== undefined ? (
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
                          ) : (
                            <ul className="items items-usual">
                              {line.items.map((item) => (
                                <li key={item}>
                                  <span className="item-name">{item}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  ))}

                  {/*
                    F-042 — the STALENESS WARNING, and only that.

                    The date itself moved into the "Confirmed X ago:" heading above, so printing
                    `stand.updated` here as well would state the same confirmation twice. What
                    has no other home is the warning: a listing old enough to be doubted must
                    say so prominently, which is why a stale stand stays on the map at all
                    instead of disappearing. Keyed on `stale`, never on `updated` — an
                    unconfirmed stand has nothing to be stale about, and `stale` is absent
                    rather than false there precisely so this cannot render for it (B-013).
                  */}
                  {stand.stale === true ? (
                    <p className="recency recency-stale">
                      <strong>May be out of date — </strong>
                      {stand.updated}
                    </p>
                  ) : null}

                  {/*
                    F-038 — a farm you contact rather than visit says so, in place of an
                    address. Rendering `stand.address` unconditionally printed an EMPTY line
                    here, which reads as a stand whose address nobody bothered to fill in. Open
                    Gate Lamb has no stand at all; saying that plainly is the honest version,
                    and it is the whole reason these farms are listed rather than hidden.
                  */}
                  {stand.address !== undefined ? (
                    <p className="address">{stand.address}</p>
                  ) : (
                    <p className="address address-contact-only">
                      <strong>No stand to visit</strong> — order by contacting this farm.
                    </p>
                  )}
                  {stand.routingLink !== null ? (
                    <a
                      className="directions"
                      href={stand.routingLink}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Directions
                    </a>
                  ) : null}
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
              <h2 className="sheet-title">{selectedStand.locationName}</h2>
              <p className="sheet-farm">{selectedStand.farmName}</p>
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

          {/* Same honesty rule as the card: a stand we could not judge says so. */}
          {OPEN_STATE_LABEL[selectedStand.openState] !== null ? (
            <p className={`open-state open-state-${selectedStand.openState}`}>
              {OPEN_STATE_LABEL[selectedStand.openState]}
            </p>
          ) : null}

          {/* Decided by the SAME pure function the card uses — never re-derived here. */}
          {standListingLines(selectedStand).map((line) => (
            <div className={`listing listing-${line.kind}`} key={line.kind}>
              {line.items === undefined ? (
                <p className="listing-note">{line.label}</p>
              ) : (
                <>
                  <p className="listing-label">{line.label}</p>
                  <ul className="items items-usual">
                    {line.items.map((item) => (
                      <li key={item}>
                        <span className="item-name">{item}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ))}

          {selectedStand.stale === true ? (
            <p className="recency recency-stale">
              <strong>May be out of date — </strong>
              {selectedStand.updated}
            </p>
          ) : null}

          {selectedStand.address !== undefined ? (
            <p className="address">{selectedStand.address}</p>
          ) : (
            <p className="address address-contact-only">
              <strong>No stand to visit</strong> — order by contacting this farm.
            </p>
          )}

          {selectedStand.routingLink !== null ? (
            <a
              className="directions"
              href={selectedStand.routingLink}
              target="_blank"
              rel="noreferrer noopener"
            >
              Directions
            </a>
          ) : null}
        </div>
      ) : null}

      <footer className="foot">
        <p>
          Farmers keep these listings current by text message. Spotted an empty bin? Use the
          QR code at the stand to tell the farmer privately — it never changes the listing on
          its own.
        </p>

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
            Save the Farm Friend number
          </a>
          <span className="contact-card-note">
            Adds the texting number to your phone&apos;s contacts. This only saves a contact —
            it does not sign you up for messages, and we are not told that you saved it.
          </span>
        </p>
      </footer>
    </main>
  );
}
