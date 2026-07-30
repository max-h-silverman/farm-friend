"use client";

import { useState } from "react";

// The farmer's stand form (F-040) — two steps, never one.
//
// **The confirmation step is not a UI nicety, it is the gate.** The farmer types what they
// have, sees the complete resulting listing rendered by code, and only then confirms. The
// server enforces this independently (a proposal must exist and be confirmed through
// `confirmInventoryPublication`), so nothing here is load-bearing for correctness — but the
// screen has to make the two steps obvious, or a farmer will believe typing published.
//
// The token lives in this component's props and is posted in the request BODY, never a query
// string: a standing credential must not end up in proxy logs or analytics.

type Stage =
  | { step: "typing" }
  | { step: "confirming"; proposalId: string; confirmationText: string }
  | { step: "asked"; question: string }
  | { step: "published" }
  | { step: "declined" };

export function StandForm({ token }: { token: string }) {
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "typing" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/farmer/stand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) {
        setError(
          response.status === 403
            ? "This link is no longer active. Text LINK to VIGA Farm Friend for a new one."
            : "That did not go through. Your listing is unchanged — try again.",
        );
        return null;
      }
      return payload;
    } catch {
      setError("That did not go through. Your listing is unchanged — try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function propose() {
    if (text.trim() === "") return;
    const payload = await post({ action: "propose", text });
    if (payload === null) return;

    if (payload.outcome === "proposed") {
      setStage({
        step: "confirming",
        proposalId: payload.proposalId as string,
        confirmationText: payload.confirmationText as string,
      });
      return;
    }
    if (payload.outcome === "clarification") {
      setStage({ step: "asked", question: payload.question as string });
      return;
    }
    setError("We could not read that. Try listing the items plainly, like: eggs, kale, jam.");
  }

  async function settle(accept: boolean) {
    if (stage.step !== "confirming") return;
    const payload = await post({
      action: accept ? "confirm" : "decline",
      proposalId: stage.proposalId,
      confirmationText: stage.confirmationText,
    });
    if (payload === null) return;
    setStage({ step: accept ? "published" : "declined" });
    if (accept) setText("");
  }

  return (
    <>
      {error !== null && (
        <p className="farmer-form-error" role="alert">
          {error}
        </p>
      )}

      {(stage.step === "typing" ||
        stage.step === "asked" ||
        stage.step === "published" ||
        stage.step === "declined") && (
        <>
          {stage.step === "published" && (
            <p className="farmer-form-published" role="status">
              Your stand is updated. Thank you!
            </p>
          )}
          {stage.step === "declined" && (
            <p className="farmer-form-note" role="status">
              Nothing changed. Your listing is as it was.
            </p>
          )}
          {stage.step === "asked" && (
            <p className="farmer-form-note" role="status">
              {stage.question}
            </p>
          )}

          <label htmlFor="farmer-form-text">What does your stand have today?</label>
          <textarea
            id="farmer-form-text"
            value={text}
            rows={4}
            onChange={(event) => setText(event.target.value)}
            placeholder="a dozen eggs, lots of kale, plum jam $6"
          />
          <button type="button" disabled={busy || text.trim() === ""} onClick={() => void propose()}>
            {busy ? "Checking…" : "See what it will say"}
          </button>
        </>
      )}

      {stage.step === "confirming" && (
        <>
          <p className="farmer-form-note">
            <strong>This is exactly what people will see.</strong> Nothing has changed yet.
          </p>
          {/* Code-rendered from the validated snapshot — never model prose. */}
          <pre className="farmer-form-snapshot">{stage.confirmationText}</pre>
          <button type="button" disabled={busy} onClick={() => void settle(true)}>
            {busy ? "Publishing…" : "Yes, publish this"}
          </button>
          <button type="button" disabled={busy} onClick={() => void settle(false)}>
            No, leave it alone
          </button>
        </>
      )}
    </>
  );
}
