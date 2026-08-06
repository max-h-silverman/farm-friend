"use client";

import { useState } from "react";

/**
 * F-073 — an already-onboarded farmer asks for their own update link.
 *
 * Their farm is already on Farm Friend, so there is nothing to set up: what they need is the
 * private link they already have a right to. They enter the number they onboarded with and Farm
 * Friend texts it to them.
 *
 * **The answer goes to the handset, never to this screen.** Whatever the farmer types, this form
 * says the same thing — a match and a miss are indistinguishable here. That is deliberate: a
 * page that said "no farmer with that number" would be a way to ask whether any number on the
 * island belongs to a farmer. It also means the copy must set the expectation honestly, which
 * is why it says "if that number is on file" rather than promising a text.
 */
export function PhoneStep({
  farmId,
  farmName,
}: {
  farmId: string;
  farmName: string;
}) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || phone.trim() === "") return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/farmer/link-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ farmId, phone }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(
          body.error === "rate_limited"
            ? "Too many tries just now. Wait a minute and try again."
            : body.error === "invalid_request"
              ? "That does not look like a phone number. Check it and try again."
              : "That did not go through. Try again in a moment.",
        );
        return;
      }
      setSent(true);
    } catch {
      setError("That did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p className="farmer-form-published" role="status">
        If that number is on file for {farmName}, we just texted your private update link to it.
        It can take a minute to arrive.
      </p>
    );
  }

  return (
    <form className="farmer-picker-next" onSubmit={submit}>
      <p>
        {farmName} is already on Farm Friend. Enter the phone number you set it up with and we
        will text you your update link.
      </p>
      <label className="farmer-field" htmlFor="farmer-phone">
        <span className="farmer-field-label">Your phone number</span>
        <input
          id="farmer-phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          placeholder="(206) 555-0143"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
      </label>
      {error === null ? null : (
        <p className="farmer-form-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="farmer-primary-action"
        type="submit"
        disabled={busy || phone.trim() === ""}
      >
        {busy ? "Sending…" : "Text me my link"}
      </button>
      <p className="farmer-onboarding-note">
        Not your farm, or lost the number? Text SIGNUP to Farm Friend and VIGA will help.
      </p>
    </form>
  );
}
