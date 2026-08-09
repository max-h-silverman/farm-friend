"use client";

import Link from "next/link";
import { useState } from "react";

export interface ReminderLocation {
  salesLocationId: string;
  locationName: string;
  selected: boolean;
  cadence: "every_2_days" | "weekly" | "every_2_weeks" | "paused" | null;
}

type Cadence = Exclude<ReminderLocation["cadence"], null>;

/*
  HOW OFTEN FARM FRIEND ASKS — on the stock tab, under the widget that answers it (F-098).

  max's call (2026-08-09). This was the "Inventory reminders" block inside the settings panel
  on the OTHER tab, which put "how often do we text you asking what you have" a tab away from
  the thing the farmer does when they get that text. The schedule is a property of the stock
  errand, not of the listing, and it now sits beside it.

  It saves ITSELF rather than joining the details tab's one Save. That is not an exception to
  F-098's one-commit rule — it is the same rule applied per tab: the control lives on the
  stock tab now, and a button on the details tab cannot commit a control the farmer cannot
  see. The stock form's own Save publishes an inventory revision through the proposal gate,
  which is a different act with a different provenance, so folding a cadence write into it
  would put a settings change behind an inventory confirmation.

  Writes through `/api/farmer/settings` — the same endpoint and the same payload shape the
  settings panel used. Only the placement moved.
*/
export function ReminderSchedules({
  token,
  locations,
}: {
  token: string;
  locations: ReminderLocation[];
}) {
  /** The stand's name only earns a line when there is more than one to tell apart. */
  const hasSeveralStands = locations.length > 1;
  const [cadences, setCadences] = useState<Record<string, Cadence | "">>(
    Object.fromEntries(
      locations.map((location) => [location.salesLocationId, location.cadence ?? ""]),
    ),
  );
  /**
   * What was on screen when the page loaded, so Save writes only what CHANGED.
   *
   * Held rather than re-read: posting every stand's cadence on every press would write
   * schedules the farmer never touched, and each write is a settings change on a record they
   * did not open.
   */
  const [savedCadences, setSavedCadences] = useState(cadences);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInactive, setLinkInactive] = useState(false);

  const changed = locations.filter(
    (location) =>
      (cadences[location.salesLocationId] ?? "") !== "" &&
      cadences[location.salesLocationId] !== savedCadences[location.salesLocationId],
  );

  async function save() {
    if (changed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    setLinkInactive(false);
    try {
      for (const location of changed) {
        try {
          const response = await fetch("/api/farmer/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              token,
              salesLocationId: location.salesLocationId,
              cadence: cadences[location.salesLocationId],
            }),
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            if (response.status === 403) setLinkInactive(true);
            setError(
              response.status === 403
                ? "This link is no longer active. Your reminder schedule is unchanged."
                : typeof payload.message === "string"
                  ? payload.message
                  : "That did not go through. Your reminder schedule is unchanged — try again.",
            );
            return;
          }
        } catch {
          setError(
            "That did not go through. Your reminder schedule is unchanged — try again.",
          );
          return;
        }
        // Marked saved one stand at a time, so a failure part-way leaves a retry sending only
        // what is still outstanding rather than rewriting what already landed.
        setSavedCadences((current) => ({
          ...current,
          [location.salesLocationId]: cadences[location.salesLocationId] ?? "",
        }));
      }
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="farmer-settings-section" aria-labelledby="reminders-heading">
      <h3 id="reminders-heading">Inventory reminders</h3>
      <p className="farmer-form-note">
        We text you at 10am to ask what you have. Pausing reminders does not stop your other
        texts or change your SMS consent.
      </p>

      {error !== null && (
        <p className="farmer-form-error" role="alert">
          {error} {linkInactive && <Link href="#new-link-help">How to get a new link</Link>}
        </p>
      )}
      {saved && (
        <p className="farmer-form-published" role="status">
          Reminder schedule saved.
        </p>
      )}

      {locations.map((location) => (
        <div className="farmer-settings-schedule" key={`schedule-${location.salesLocationId}`}>
          {hasSeveralStands && <h4>{location.locationName}</h4>}
          <label htmlFor={`cadence-${location.salesLocationId}`}>Reminder schedule</label>
          <select
            id={`cadence-${location.salesLocationId}`}
            value={cadences[location.salesLocationId] ?? ""}
            onChange={(event) => {
              setCadences((current) => ({
                ...current,
                [location.salesLocationId]: event.target.value as Cadence | "",
              }));
              setSaved(false);
            }}
          >
            <option value="" disabled>
              Choose a schedule
            </option>
            <option value="every_2_days">Every 2 days</option>
            <option value="weekly">Weekly</option>
            <option value="every_2_weeks">Every 2 weeks</option>
            <option value="paused">Don&apos;t remind me</option>
          </select>
        </div>
      ))}

      <button type="button" disabled={busy || changed.length === 0} onClick={() => void save()}>
        {busy ? "Saving…" : "Save reminder schedule"}
      </button>
    </section>
  );
}
