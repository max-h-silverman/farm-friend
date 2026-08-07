"use client";

import { useState } from "react";

/**
 * The consent step: what the farmer is agreeing to, the tick, then the prepared text.
 *
 * **The order is the point.** The prepared `JOIN` text is not reachable until the server
 * has recorded the agreement, because that stamp is what turns the inbound message into an
 * informed opt-in. A farmer who could send it first would spend the invitation, receive
 * no consent record, and be authorized into permanent silence — the exact dead end this
 * step exists to close.
 *
 * The tick is not consent and this component does not claim it is. Consent is written when
 * the message arrives from the handset; the copy below is what the carrier-registered
 * opt-in receipt says the farmer was shown, which is why the disclosures are asserted by
 * test rather than left to review.
 */
export function AgreementStep({
  token,
  joinUrl,
}: {
  token: string;
  joinUrl: string | null;
}) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(checked: boolean) {
    setError(null);
    if (!checked) {
      // Withdrawing the tick hides the text again. The stamp already recorded is provenance
      // of what was shown and accepted — nothing was sent, and no consent exists until the
      // farmer texts.
      setAgreed(false);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/farmer/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The token travels in the body, never a query string: a credential in a URL lands
        // in server logs and browser history by default.
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        setError(
          "This invitation is no longer available. Ask the VIGA coordinator who invited " +
            "you for a new link.",
        );
        return;
      }
      setAgreed(true);
    } catch {
      setError("That did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="farmer-onboarding-agreement" data-testid="sms-agreement">
        {/*
          The tick leads and the disclosure follows it, because the tick is the action and the
          disclosure is its terms. The four facts the carrier receipt claims were shown —
          frequency, rates, STOP, HELP — are registered copy and are asserted by test; only
          their framing is ours. The list replaces a five-line paragraph in which the three
          message kinds and the four disclosures ran together as one wall.
        */}
        <label className="farmer-onboarding-agree">
          <input
            type="checkbox"
            checked={agreed}
            disabled={busy}
            onChange={(nextEvent) => void toggle(nextEvent.target.checked)}
          />
          <span>I agree to receive texts from VIGA Farm Friend.</span>
        </label>
        <div className="farmer-onboarding-terms">
          <p>Farm Friend texts you about your stand:</p>
          <ul>
            <li>Reminders to update what you have</li>
            <li>Confirmations of what you publish</li>
            <li>Notices when a customer reports something sold out</li>
          </ul>
          <p>
            Message frequency varies. Message and data rates may apply. Reply STOP any time to
            stop all messages, or HELP for help.
          </p>
        </div>
        {error === null ? null : (
          <p className="farmer-form-error" role="alert">
            {error}
          </p>
        )}
      </div>

      {agreed ? (
        joinUrl === null ? (
          <p className="farmer-onboarding-instruction">
            Text <strong>JOIN {token}</strong> to the Farm Friend number from your
            invitation.
          </p>
        ) : (
          <a className="farmer-primary-link" href={joinUrl}>
            Text JOIN to verify this phone
          </a>
        )
      ) : null}
    </>
  );
}
