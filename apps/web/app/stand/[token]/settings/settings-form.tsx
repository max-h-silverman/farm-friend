"use client";

import Link from "next/link";
import { useState } from "react";

interface SettingsLocation {
  salesLocationId: string;
  locationName: string;
  selected: boolean;
  cadence: "every_2_days" | "weekly" | "every_2_weeks" | "paused" | null;
}

type Cadence = Exclude<SettingsLocation["cadence"], null>;

export function SettingsForm({
  token,
  locations,
  participantNamesByLocation = {},
}: {
  token: string;
  locations: SettingsLocation[];
  participantNamesByLocation?: Record<string, string[]>;
}) {
  const initial = locations.find((location) => location.selected)?.salesLocationId
    ?? locations[0]?.salesLocationId
    ?? "";
  const [salesLocationId, setSalesLocationId] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkInactive, setLinkInactive] = useState(false);
  const [cadences, setCadences] = useState<Record<string, Cadence | "">>(
    Object.fromEntries(locations.map((location) => [location.salesLocationId, location.cadence ?? ""])),
  );
  const [scheduleBusy, setScheduleBusy] = useState<string | null>(null);
  const [savedSchedule, setSavedSchedule] = useState<string | null>(null);
  const [participantLocationId, setParticipantLocationId] = useState(initial);
  const [participantNames, setParticipantNames] = useState(participantNamesByLocation);
  const [participantText, setParticipantText] = useState(
    (participantNamesByLocation[initial] ?? []).join("\n"),
  );
  const [participantBusy, setParticipantBusy] = useState(false);
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [participantSaved, setParticipantSaved] = useState(false);
  const [participantLinkInactive, setParticipantLinkInactive] = useState(false);

  async function save() {
    if (salesLocationId === "") return;
    setBusy(true);
    setSavedName(null);
    setError(null);
    setLinkInactive(false);
    try {
      const response = await fetch("/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, salesLocationId }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 403) setLinkInactive(true);
        setError(
          response.status === 403
            ? "This link is no longer active. Your default stand is unchanged."
            : "That did not go through. Your default stand is unchanged — try again.",
        );
        return;
      }
      setSavedName(
        typeof payload.locationName === "string" ? payload.locationName : "your stand",
      );
      setParticipantLocationId(salesLocationId);
      setParticipantText((participantNames[salesLocationId] ?? []).join("\n"));
      setParticipantSaved(false);
      setParticipantError(null);
    } catch {
      setError("That did not go through. Your default stand is unchanged — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveCadence(location: SettingsLocation) {
    const cadence = cadences[location.salesLocationId] ?? "";
    if (cadence === "") return;
    setScheduleBusy(location.salesLocationId);
    setSavedSchedule(null);
    setError(null);
    try {
      const response = await fetch("/api/farmer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, salesLocationId: location.salesLocationId, cadence }),
      });
      if (!response.ok) {
        if (response.status === 403) setLinkInactive(true);
        setError(response.status === 403
          ? "This link is no longer active. Your reminder schedule is unchanged."
          : "That did not go through. Your reminder schedule is unchanged — try again.");
        return;
      }
      setSavedSchedule(location.locationName);
    } catch {
      setError("That did not go through. Your reminder schedule is unchanged — try again.");
    } finally {
      setScheduleBusy(null);
    }
  }

  async function saveParticipants() {
    const names = participantText
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter((name) => name !== "");
    setParticipantBusy(true);
    setParticipantError(null);
    setParticipantSaved(false);
    setParticipantLinkInactive(false);
    try {
      const response = await fetch("/api/farmer/stand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, action: "save_participants", participantNames: names }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 403) setParticipantLinkInactive(true);
        setParticipantError(
          response.status === 403
            ? "This link is no longer active. Seller names are unchanged."
            : typeof payload.message === "string"
              ? payload.message
              : "That did not go through. Seller names are unchanged - try again.",
        );
        return;
      }
      const saved = Array.isArray(payload.activeDisplayNames)
        ? payload.activeDisplayNames.filter((name): name is string => typeof name === "string")
        : names;
      setParticipantNames((current) => ({
        ...current,
        [participantLocationId]: saved,
      }));
      setParticipantText(saved.join("\n"));
      setParticipantSaved(true);
    } catch {
      setParticipantError("That did not go through. Seller names are unchanged - try again.");
    } finally {
      setParticipantBusy(false);
    }
  }

  return (
    <section className="farmer-settings-content" aria-labelledby="default-stand-heading">
      <h2 id="default-stand-heading" className="farmer-settings-heading">
        Default SMS stand
      </h2>
      <p id="default-stand-help" className="farmer-form-note">
        You can switch again anytime by texting STAND.
      </p>

      {error !== null && (
        <p className="farmer-form-error" role="alert">
          {error}{" "}
          {linkInactive && <Link href="#new-link-help">How to get a new link</Link>}
        </p>
      )}
      {savedName !== null && (
        <p className="farmer-form-published" role="status">
          Saved. Text updates now use {savedName}.
        </p>
      )}

      <fieldset className="farmer-settings-options" aria-describedby="default-stand-help">
        <legend className="sr-only">Choose your default SMS stand</legend>
        {locations.map((location) => (
          <label className="farmer-settings-choice" key={location.salesLocationId}>
            <input
              type="radio"
              name="default-stand"
              value={location.salesLocationId}
              checked={salesLocationId === location.salesLocationId}
              onChange={() => {
                setSalesLocationId(location.salesLocationId);
                setSavedName(null);
              }}
            />
            <span>{location.locationName}</span>
          </label>
        ))}
      </fieldset>

      <button type="button" disabled={busy || salesLocationId === ""} onClick={() => void save()}>
        {busy ? "Saving…" : "Save default stand"}
      </button>

      <div className="farmer-settings-reminders">
        <h2 className="farmer-settings-heading">Inventory reminders</h2>
        <p className="farmer-form-note">
          Farm Friend sends the complete current listing at 10:00 AM local time. Pausing
          reminders does not change your SMS consent.
        </p>
        {savedSchedule !== null && (
          <p className="farmer-form-published" role="status">
            Saved reminder schedule for {savedSchedule}.
          </p>
        )}
        {locations.map((location) => (
          <section className="farmer-settings-schedule" key={`schedule-${location.salesLocationId}`}>
            <h3>{location.locationName}</h3>
            <label htmlFor={`cadence-${location.salesLocationId}`}>Reminder schedule</label>
            <select
              id={`cadence-${location.salesLocationId}`}
              value={cadences[location.salesLocationId] ?? ""}
              onChange={(event) => {
                setCadences((current) => ({
                  ...current,
                  [location.salesLocationId]: event.target.value as Cadence | "",
                }));
                setSavedSchedule(null);
              }}
            >
              <option value="" disabled>Choose a schedule</option>
              <option value="every_2_days">Every 2 days</option>
              <option value="weekly">Weekly</option>
              <option value="every_2_weeks">Every 2 weeks</option>
              <option value="paused">Paused</option>
            </select>
            <button
              type="button"
              disabled={scheduleBusy !== null || (cadences[location.salesLocationId] ?? "") === ""}
              onClick={() => void saveCadence(location)}
            >
              {scheduleBusy === location.salesLocationId ? "Saving…" : "Save reminder"}
            </button>
          </section>
        ))}
      </div>

      <section className="farmer-settings-reminders" aria-labelledby="seller-names-heading">
        <h2 id="seller-names-heading" className="farmer-settings-heading">Also selling here</h2>
        <p id="seller-names-help" className="farmer-form-note">
          Add one farm or business name per line for{
            " "
          }{locations.find((location) => location.salesLocationId === participantLocationId)?.locationName
            ?? "this stand"}. These names do not give anyone permission to update it.
        </p>
        {participantError !== null && (
          <p className="farmer-form-error" role="alert">
            {participantError}{" "}
            {participantLinkInactive && <Link href="#new-link-help">How to get a new link</Link>}
          </p>
        )}
        {participantSaved && (
          <p className="farmer-form-published" role="status">
            Seller names saved. The public stand now shows this list.
          </p>
        )}
        <label htmlFor="farmer-participant-names">Seller names</label>
        <textarea
          id="farmer-participant-names"
          aria-describedby="seller-names-help"
          value={participantText}
          rows={4}
          onChange={(event) => {
            setParticipantText(event.target.value);
            setParticipantSaved(false);
          }}
        />
        <button type="button" disabled={participantBusy} onClick={() => void saveParticipants()}>
          {participantBusy ? "Saving..." : "Save seller names"}
        </button>
      </section>
    </section>
  );
}
