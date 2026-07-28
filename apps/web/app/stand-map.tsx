"use client";

import { useMemo } from "react";
import { PROXIMITY_BASIS_LABEL } from "@farm-friend/core/proximity";
import { buildMapView, type PublicStandPayload } from "../lib/map-view";
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

              {stand.items.length > 0 ? (
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
              ) : stand.updated !== undefined ? (
                <p className="items-empty">
                  The farmer confirmed this stand is empty right now.
                </p>
              ) : (
                // No items AND no confirmation are a different fact from a confirmed-empty
                // stand, and saying "the farmer confirmed" here would invent the one thing
                // B-002's zero-inventory seed exists to avoid: a confirmation nobody made.
                <p className="items-empty">
                  No listing yet — this stand hasn’t been updated through Farm Friend. It may
                  still have produce out.
                </p>
              )}

              {stand.updated !== undefined ? (
                <p className={stand.stale ? "recency recency-stale" : "recency"}>
                  {stand.stale ? <strong>May be out of date — </strong> : null}
                  {stand.updated}
                </p>
              ) : null}

              <p className="address">{stand.address}</p>
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
      </footer>
    </main>
  );
}
