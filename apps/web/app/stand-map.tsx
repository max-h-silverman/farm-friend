"use client";

import { useMemo } from "react";
import { PROXIMITY_BASIS_LABEL } from "@farm-friend/core/proximity";
import { CONTACT_CARD_PATH } from "@farm-friend/core/vcard";
import {
  buildMapView,
  standListingLines,
  type PublicStandPayload,
} from "../lib/map-view";
import { useTransientOrigin } from "./use-transient-origin";

// The public stand map (F-017).
//
// Design intent, in one line: this page's job is to be TRUSTED, not to look busy. A customer
// standing in their kitchen deciding whether to drive to a stand needs three things in this
// order — what is there, how long ago a farmer confirmed it, and how far away it is. Recency
// is therefore a first-class visual element on every card rather than a footnote, and a
// stale listing is styled as *caution*, never hidden.
//
// It is model-free by construction: the data arrives from `GET /api/public/stands`, which
// takes db + clock and has no model seam, and everything below is arithmetic and markup.

export function StandMap({ stands }: { stands: PublicStandPayload[] }) {
  const { state, request, clear } = useTransientOrigin();
  const origin = state.status === "ready" ? state.origin : null;
  const view = useMemo(() => buildMapView(stands, origin), [stands, origin]);

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">Vashon Island Growers Association</p>
        <h1>Farm stands, right now</h1>
        <p className="lede">
          What island farmers have confirmed at their stands. Most are unattended and
          honor-system, so we show <strong>when each was last confirmed</strong> rather than
          promising what is there.
        </p>
      </header>

      <section className="locate" aria-live="polite">
        {state.status !== "ready" ? (
          <>
            <button
              type="button"
              className="locate-button"
              onClick={request}
              disabled={state.status === "locating"}
            >
              {state.status === "locating" ? "Finding you…" : "Sort by distance"}
            </button>
            <p className="locate-note">
              {state.status === "unavailable"
                ? state.reason
                : "Optional. Your location stays on your device and is never sent to us."}
            </p>
          </>
        ) : (
          <>
            <p className="locate-active">
              Sorted by distance. <span className="basis">{PROXIMITY_BASIS_LABEL}</span>
            </p>
            <button type="button" className="locate-clear" onClick={clear}>
              Stop using my location
            </button>
          </>
        )}
      </section>

      {view.staleCount > 0 ? (
        <p className="stale-summary" role="note">
          {view.staleCount === 1
            ? "One listing below has not been confirmed recently."
            : `${view.staleCount} listings below have not been confirmed recently.`}{" "}
          They are still shown, marked, because old information beats none.
        </p>
      ) : null}

      {view.stands.length === 0 ? (
        <p className="empty">
          No stand has a current listing right now. Farmers update these themselves, so check
          back — and stands may still have produce out.
        </p>
      ) : (
        <ul className="stands">
          {view.stands.map((stand) => (
            <li key={stand.id} className={stand.stale ? "stand stand-stale" : "stand"}>
              <div className="stand-head">
                <h2>{stand.locationName}</h2>
                {stand.distanceLabel !== undefined ? (
                  <span className="distance">{stand.distanceLabel}</span>
                ) : null}
              </div>
              <p className="farm">{stand.farmName}</p>

              {/*
                F-042 — WHICH LINES a stand gets is decided by `standListingLines`, not here.
                This block prints them and chooses nothing.

                That split is the whole design. The copy max approved rests on one rule — a
                "Usually sells" line NEVER carries a timestamp, because a date beside it reads
                as a confirmation nobody made — and a rule that load-bearing cannot live in a
                conditional chain inside JSX that no test renders. It lives in a pure function
                with a sabotage-verified test on exactly that property.

                So: no `stand.updated`, no `stand.items.length`, and no `visitability` checks
                below. Reintroducing one would put the decision back in two places, and the
                copy would be one careless edit from claiming a confirmation.
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
                `stand.updated` here as well would state the same confirmation twice. What has
                no other home is the warning: a listing old enough to be doubted must say so
                prominently, which is why a stale stand stays on the map at all instead of
                disappearing. Keyed on `stale`, never on `updated` — an unconfirmed stand has
                nothing to be stale about, and `stale` is absent rather than false there
                precisely so this cannot render for it (B-013).
              */}
              {stand.stale === true ? (
                <p className="recency recency-stale">
                  <strong>May be out of date — </strong>
                  {stand.updated}
                </p>
              ) : null}

              {/*
                F-038 — a farm you contact rather than visit says so, in place of an address.
                Rendering `stand.address` unconditionally printed an EMPTY line here, which
                reads as a stand whose address nobody bothered to fill in. Open Gate Lamb has
                no stand at all; saying that plainly is the honest version, and it is the whole
                reason these farms are listed rather than hidden.
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
