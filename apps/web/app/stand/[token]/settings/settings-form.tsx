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

/*
  THE SETTINGS PANEL, after F-097's pass (max, 2026-08-08).

  What it looked like before, and why each part moved:

    * THREE save buttons — "Save default stand", "Save reminder" (one per stand), and "Save
      seller names" — for what a farmer reads as one screen of settings. Each wrote through a
      different endpoint, which is a real distinction in the code and none at all to the
      person looking at it. There is now ONE "Save settings" that writes everything that
      changed, and it names what it is saving rather than which endpoint it reaches.

    * "SUBMIT" as a label. That is onboarding's word — the act of handing in a form for the
      first time — and it read as though this page were being filed somewhere. A farmer
      changing a setting is saving, not submitting.

    * "ALSO SELLING HERE" at the very bottom, below the reminder schedules, so a question
      about WHO SELLS at a stand sat underneath a question about HOW OFTEN WE TEXT. It now
      sits directly under the stand it describes, which is where the farmer is already
      looking when they think about it.

    * THE DEFAULT-STAND PICKER shown to everyone. A farmer with one stand was asked to choose
      between one option — a radio group with a single radio, which cannot be answered wrongly
      and therefore should not be asked. It appears only when there is a genuine choice.

  The three endpoints are unchanged. Combining the SCREEN is not the same as combining the
  writers, and merging those would have put the participant save — which has its own audit
  event and its own public-text refusal — behind the same request as a cadence change.
*/
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
  /**
   * Whether the farmer has a real choice of default stand.
   *
   * One stand is not a choice, and a radio group holding a single radio asks a question with
   * one answer. `STAND` (the SMS keyword) has the same shape and already says "if you have
   * more than one" — this is that rule on the web surface.
   */
  const hasSeveralStands = locations.length > 1;
  const [salesLocationId, setSalesLocationId] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInactive, setLinkInactive] = useState(false);
  const [cadences, setCadences] = useState<Record<string, Cadence | "">>(
    Object.fromEntries(locations.map((location) => [location.salesLocationId, location.cadence ?? ""])),
  );
  /**
   * What was on screen when the page loaded, so one Save can write only what CHANGED.
   *
   * Held rather than re-read: with one button covering three writers, sending all of them on
   * every press would file a participant audit event every time a farmer touched their
   * reminder schedule — an event claiming the seller list was edited when it was not.
   */
  const [savedCadences, setSavedCadences] = useState(cadences);
  const [savedDefault, setSavedDefault] = useState(initial);
  const [participantNames, setParticipantNames] = useState(participantNamesByLocation);
  const [participantText, setParticipantText] = useState(
    (participantNamesByLocation[initial] ?? []).join("\n"),
  );
  const [savedParticipantText, setSavedParticipantText] = useState(participantText);

  /** The stand the seller-name box is about — the default, or the only one there is. */
  const participantLocationId = savedDefault;
  const participantLocationName =
    locations.find((location) => location.salesLocationId === participantLocationId)
      ?.locationName ?? "this stand";

  const defaultChanged = salesLocationId !== savedDefault;
  const changedCadences = locations.filter(
    (location) =>
      (cadences[location.salesLocationId] ?? "") !== "" &&
      cadences[location.salesLocationId] !== savedCadences[location.salesLocationId],
  );
  const participantsChanged = participantText !== savedParticipantText;
  const nothingToSave =
    !defaultChanged && changedCadences.length === 0 && !participantsChanged;

  /** One request, described by what it failed to change rather than by which route it hit. */
  async function post(
    url: string,
    body: Record<string, unknown>,
    unchanged: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 403) setLinkInactive(true);
        setError(
          response.status === 403
            ? `This link is no longer active. ${unchanged} is unchanged.`
            : typeof payload.message === "string"
              ? payload.message
              : `That did not go through. ${unchanged} is unchanged — try again.`,
        );
        return null;
      }
      return payload;
    } catch {
      setError(`That did not go through. ${unchanged} is unchanged — try again.`);
      return null;
    }
  }

  /**
   * Save everything the farmer changed, in one press.
   *
   * **Stops at the first failure rather than pressing on.** A partial save reported as success
   * is the shape of lie this codebase refuses: the farmer would read "saved" over a screen
   * where one of their three changes silently did not take. What has already been written
   * stays written and is marked as saved, so a retry sends only what is still outstanding.
   */
  async function save() {
    if (nothingToSave || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    setLinkInactive(false);
    try {
      if (defaultChanged) {
        const payload = await post(
          "/api/farmer/settings",
          { salesLocationId },
          "Your default stand",
        );
        if (payload === null) return;
        setSavedDefault(salesLocationId);
        // The seller-name box follows the default stand, so it reloads onto the new one —
        // and its baseline moves with it, or the next Save would post one stand's names
        // against another's.
        const names = (participantNames[salesLocationId] ?? []).join("\n");
        setParticipantText(names);
        setSavedParticipantText(names);
      }

      for (const location of changedCadences) {
        const payload = await post(
          "/api/farmer/settings",
          {
            salesLocationId: location.salesLocationId,
            cadence: cadences[location.salesLocationId],
          },
          "Your reminder schedule",
        );
        if (payload === null) return;
        setSavedCadences((current) => ({
          ...current,
          [location.salesLocationId]: cadences[location.salesLocationId] ?? "",
        }));
      }

      // Only when the default did NOT move: that branch already reset the box to the new
      // stand's names, and posting here would write those names against a stand the farmer
      // never edited them for.
      if (participantsChanged && !defaultChanged) {
        const names = participantText
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter((name) => name !== "");
        const payload = await post(
          "/api/farmer/stand",
          { action: "save_participants", participantNames: names },
          "Seller names",
        );
        if (payload === null) return;
        const stored = Array.isArray(payload.activeDisplayNames)
          ? payload.activeDisplayNames.filter((name): name is string => typeof name === "string")
          : names;
        setParticipantNames((current) => ({
          ...current,
          [participantLocationId]: stored,
        }));
        setParticipantText(stored.join("\n"));
        setSavedParticipantText(stored.join("\n"));
      }

      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="farmer-settings-content" aria-labelledby="settings-heading">
      <h2 id="settings-heading" className="farmer-settings-heading">
        Settings
      </h2>

      {error !== null && (
        <p className="farmer-form-error" role="alert">
          {error}{" "}
          {linkInactive && <Link href="#new-link-help">How to get a new link</Link>}
        </p>
      )}
      {saved && (
        <p className="farmer-form-published" role="status">
          Settings saved.
        </p>
      )}

      {/*
        THE DEFAULT STAND, asked only when there is more than one (max 2026-08-08). A single
        stand makes this a question with one answer, which is noise on a settings screen.
      */}
      {hasSeveralStands && (
        <div className="farmer-settings-section">
          <h3>Which stand your texts are about</h3>
          <p id="default-stand-help" className="farmer-form-note">
            When you text an update without saying which stand, we use this one. You can
            switch any time by texting STAND.
          </p>
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
                    setSaved(false);
                  }}
                />
                <span>{location.locationName}</span>
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {/*
        WHO ELSE SELLS AT THIS STAND — moved up from the bottom of the panel (max 2026-08-08).

        It belongs beside the stand it describes rather than below the reminder schedules: a
        farmer thinking about who sells at their stand is not thinking about how often they
        get texted, and the old order put the two questions in that sequence.
      */}
      <div className="farmer-settings-section">
        <h3>Also selling here</h3>
        <p id="seller-names-help" className="farmer-form-note">
          Anyone else whose goods are on the table at {participantLocationName}, one name per
          line. These names show on your public listing and give nobody permission to update
          it.
        </p>
        <label htmlFor="farmer-participant-names" className="sr-only">
          Seller names
        </label>
        <textarea
          id="farmer-participant-names"
          aria-describedby="seller-names-help"
          value={participantText}
          rows={4}
          onChange={(event) => {
            setParticipantText(event.target.value);
            setSaved(false);
          }}
        />
      </div>

      <div className="farmer-settings-section">
        <h3>Inventory reminders</h3>
        <p className="farmer-form-note">
          We text you at 10am to ask what you have. Pausing reminders does not stop your other
          texts or change your SMS consent.
        </p>
        {locations.map((location) => (
          <div className="farmer-settings-schedule" key={`schedule-${location.salesLocationId}`}>
            {/* The stand's name only earns a line when there is more than one to tell apart. */}
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
              <option value="" disabled>Choose a schedule</option>
              <option value="every_2_days">Every 2 days</option>
              <option value="weekly">Weekly</option>
              <option value="every_2_weeks">Every 2 weeks</option>
              <option value="paused">Don&apos;t remind me</option>
            </select>
          </div>
        ))}
      </div>

      {/*
        ONE button for the whole panel, and it says SAVE — never "Submit", which is
        onboarding's word for handing a form in the first time.
      */}
      <button type="button" disabled={busy || nothingToSave} onClick={() => void save()}>
        {busy ? "Saving…" : "Save settings"}
      </button>
    </section>
  );
}
