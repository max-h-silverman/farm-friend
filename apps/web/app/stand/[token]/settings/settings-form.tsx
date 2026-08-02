"use client";

import Link from "next/link";
import { useState } from "react";

interface SettingsLocation {
  salesLocationId: string;
  locationName: string;
  selected: boolean;
}

export function SettingsForm({
  token,
  locations,
}: {
  token: string;
  locations: SettingsLocation[];
}) {
  const initial = locations.find((location) => location.selected)?.salesLocationId
    ?? locations[0]?.salesLocationId
    ?? "";
  const [salesLocationId, setSalesLocationId] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkInactive, setLinkInactive] = useState(false);

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
    } catch {
      setError("That did not go through. Your default stand is unchanged — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="default-stand-heading">
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
    </section>
  );
}
