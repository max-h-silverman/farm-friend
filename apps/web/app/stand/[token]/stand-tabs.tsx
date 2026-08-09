"use client";

import { useState, type ReactNode } from "react";

/**
 * F-090 — the farmer's own stand page, as two tabs.
 *
 * **This replaces a nav of two links below the status form.** "Stand details" and "Stand
 * settings" were separate pages, headed "Change your stand's details" and sitting underneath
 * the update the farmer was mid-way through — so the two commonest return errands were each a
 * navigation away from the screen they landed on, and coming back meant losing whatever was
 * half-typed.
 *
 * max asked for tabs here and a wizard for onboarding (2026-08-08), and the difference is the
 * point: setting up happens once and is linear, so it leads; coming back is an errand, and an
 * errand should be one tap from arrival.
 *
 * **Both panels stay MOUNTED and one is `hidden`.** A farmer who types half an update, switches
 * to check their hours, and switches back must find their work — unmounting would discard it
 * silently, which is exactly the failure the old two-page nav had.
 *
 * The tab list is deliberately not a router: these are two views of one stand, and putting them
 * in the URL would make the browser's Back button undo a tab switch rather than leave the page,
 * which is not what a farmer means by Back.
 */
export function StandTabs({
  statusPanel,
  detailsPanel,
}: {
  /** Today's stock — the recurring errand, and the landing tab. */
  statusPanel: ReactNode;
  /** The listing, plus settings and message preferences. */
  detailsPanel: ReactNode;
}) {
  const [tab, setTab] = useState<"status" | "details">("status");

  const tabs = [
    { id: "status" as const, label: "Stock today" },
    { id: "details" as const, label: "Details & settings" },
  ];

  return (
    <div className="farmer-stand-tabs">
      {/*
        `role="tablist"` with real `role="tab"` buttons, rather than styled links. The roles
        are what tell a screen reader that these control one region — two buttons that merely
        toggle a div announce no relationship at all.
      */}
      <div className="farmer-stand-tablist" role="tablist" aria-label="Your stand">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`stand-tab-${entry.id}`}
            aria-controls={`stand-panel-${entry.id}`}
            aria-selected={tab === entry.id}
            className={
              tab === entry.id
                ? "farmer-stand-tab farmer-stand-tab--current"
                : "farmer-stand-tab"
            }
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tabs.map((entry) => (
        <div
          key={entry.id}
          role="tabpanel"
          id={`stand-panel-${entry.id}`}
          aria-labelledby={`stand-tab-${entry.id}`}
          hidden={tab !== entry.id}
          className="farmer-stand-panel"
        >
          {entry.id === "status" ? statusPanel : detailsPanel}
        </div>
      ))}
    </div>
  );
}
