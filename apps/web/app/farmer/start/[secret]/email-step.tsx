"use client";

import { useState } from "react";

/**
 * F-079 — prove you control an address VIGA has on file for this farm.
 *
 * **Whatever the farmer types, this screen says the same thing.** On file or not, one answer:
 * the truth arrives in their inbox. A page that said "we have no such address for this farm"
 * would be a way to ask which address VIGA holds, farm by farm. That is the same discipline as
 * `phone-step.tsx`'s "if that number is on file", and it is why the copy promises a code only
 * conditionally rather than stating one was sent.
 *
 * Every refusal on the code step is likewise one message. Wrong, expired, already used, out of
 * attempts — an attacker grinding six digits must never learn which.
 */
export function EmailStep({
  farmId,
  farmName,
  onVerified,
}: {
  farmId: string;
  farmName: string;
  onVerified: () => void;
}) {
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || email.trim() === "") return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/farmer/verify-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ farmId, email }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(
          body.error === "rate_limited"
            ? "Too many tries just now. Wait a minute and try again."
            : body.error === "invalid_request"
              ? "That does not look like an email address. Check it and try again."
              : "That did not go through. Try again in a moment.",
        );
        return;
      }
      // Advances regardless of whether the address was on file — the uniform answer.
      setStage("code");
    } catch {
      setError("That did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || code.trim() === "") return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/farmer/verify-submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ farmId, code }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(
          body.error === "rate_limited"
            ? "Too many tries just now. Wait a minute and try again."
            : // ONE message for every refusal. Naming the reason would tell someone guessing
              // codes whether they were close.
              "That code did not work. Check it and try again, or request a new one.",
        );
        return;
      }
      onVerified();
    } catch {
      setError("That did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (stage === "code") {
    return (
      <form className="farmer-picker-next" onSubmit={submitCode}>
        <p role="status">
          If that address is on file for {farmName}, we just emailed a six-digit code to it. It
          is in the subject line, so you may not need to open the message.
        </p>
        <label className="farmer-field" htmlFor="farmer-code">
          <span className="farmer-field-label">Your code</span>
          <input
            id="farmer-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value)}
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
          disabled={busy || code.trim() === ""}
        >
          {busy ? "Checking…" : "Confirm it is me"}
        </button>
        <p className="farmer-onboarding-note">
          No code? Check your spam folder, or contact VIGA and they will help.
        </p>
      </form>
    );
  }

  return (
    <form className="farmer-picker-next" onSubmit={requestCode}>
      <p>
        To make sure it is you, enter the email address VIGA has on file for {farmName}. We will
        send you a code.
      </p>
      <label className="farmer-field" htmlFor="farmer-email">
        <span className="farmer-field-label">Your email address</span>
        <input
          id="farmer-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
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
        disabled={busy || email.trim() === ""}
      >
        {busy ? "Sending…" : "Email me a code"}
      </button>
    </form>
  );
}
