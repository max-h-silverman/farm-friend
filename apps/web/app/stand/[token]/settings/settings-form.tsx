"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTabCommit } from "../details-panel";

interface SettingsLocation {
  salesLocationId: string;
  locationName: string;
  selected: boolean;
  cadence: "every_2_days" | "weekly" | "every_2_weeks" | "paused" | null;
}

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
  /**
   * What was on screen when the page loaded, so one Save can write only what CHANGED.
   *
   * Held rather than re-read: sending every writer on every press would file a participant
   * audit event whenever a farmer touched an unrelated setting — an event claiming the
   * seller list was edited when it was not.
   */
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
  const participantsChanged = participantText !== savedParticipantText;
  const nothingToSave = !defaultChanged && !participantsChanged;

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
  async function save(): Promise<boolean> {
    // Nothing to write is a SUCCESSFUL save from the caller's point of view: the tab's one
    // button must not report failure because this panel happened to be untouched.
    if (nothingToSave) return true;
    if (busy) return false;
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
        if (payload === null) return false;
        setSavedDefault(salesLocationId);
        // The seller-name box follows the default stand, so it reloads onto the new one —
        // and its baseline moves with it, or the next Save would post one stand's names
        // against another's.
        const names = (participantNames[salesLocationId] ?? []).join("\n");
        setParticipantText(names);
        setSavedParticipantText(names);
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
        if (payload === null) return false;
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
      return true;
    } finally {
      setBusy(false);
    }
  }

  /*
    HAND THE SAVE UP, so the tab's one button can run this panel's writers (F-098).

    Through a ref read at call time rather than by re-registering on every render: `save`
    closes over this render's state, and a parent holding a stale copy would post the values
    the farmer saw when the tab mounted rather than what is on screen now.
  */
  const tab = useTabCommit();
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    tab?.registerSave(() => saveRef.current());
  }, [tab]);

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
      {saved && tab === null && (
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

      {/*
        ONE button for the whole panel, and it says SAVE — never "Submit", which is
        onboarding's word for handing a form in the first time.

        HIDDEN when the panel is embedded in a tab that commits for it (F-098, max's call):
        the returning farmer's "Details & settings" tab has a single "Save changes", and a
        second button beside it asks which one counted. The standalone `/stand/[token]/settings`
        page — which a farmer may have bookmarked and which Farm Friend's own SMS replies name —
        has no such button of its own, so there it still renders.
      */}
      {tab === null && (
        <button type="button" disabled={busy || nothingToSave} onClick={() => void save()}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      )}
    </section>
  );
}
