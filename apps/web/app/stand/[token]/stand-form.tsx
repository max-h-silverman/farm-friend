"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

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

/** What the stand is publishing right now, for display only. */
export interface CurrentEntry {
  entryId: string;
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/** Render one listed item the way the farmer's own confirmation will phrase it. */
function describeEntry(entry: CurrentEntry): string {
  const details = [
    entry.quantity !== undefined && entry.unit !== undefined
      ? `${entry.quantity} ${entry.unit}`
      : entry.quantity !== undefined
        ? `${entry.quantity}`
        : entry.approximation,
    entry.priceText,
  ].filter((part): part is string => typeof part === "string" && part !== "");

  return details.length > 0 ? `${entry.itemName} (${details.join(", ")})` : entry.itemName;
}

export function StandForm({
  token,
  currentEntries,
}: {
  token: string;
  currentEntries: CurrentEntry[];
}) {
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "typing" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInactive, setLinkInactive] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (stage.step === "asked") textRef.current?.focus();
  }, [stage]);

  async function post(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    setLinkInactive(false);
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
        const refusalMessage =
          typeof payload.message === "string" ? payload.message : null;
        if (response.status === 403) setLinkInactive(true);
        setError(
          response.status === 403
            ? "This link is no longer active. Your listing is unchanged."
            : refusalMessage ??
                "That did not go through. Your listing is unchanged — try again.",
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
    // A publication, decline, or clarification describes the request that just ended.
    // Once another proposal starts, keeping that terminal message beside a new failure
    // would make two contradictory claims about the current request.
    setStage({ step: "typing" });
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
          {error}{" "}
          {linkInactive && <Link href="#new-link-help">How to get a new link</Link>}
        </p>
      )}

      {(stage.step === "typing" ||
        stage.step === "asked" ||
        stage.step === "published" ||
        stage.step === "declined") && (
        <>
          {stage.step === "published" && (
            <p className="farmer-form-published" role="status">
              Your stand is updated. Customers can now see this listing.
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

          {/*
            WHAT IS THERE NOW, above the box where they describe a change.

            Without it the farmer is asked "what changed?" against a listing they cannot
            see, and — the sharper problem — cannot tell whether typing "eggs and bok choy"
            adds to their listing or replaces it. Those differ by whether the kale survives.
            The rule the system actually applies (omission preserves) is stated here, beside
            the typing, rather than left to be discovered in the confirmation afterwards.

            Display only: `currentEntries` is rendered, never posted. What publishes is still
            the proposal the server composes and the farmer confirms.
          */}
          <section className="farmer-current" aria-labelledby="farmer-current-heading">
            <h2 id="farmer-current-heading">Your stand is showing now</h2>
            {currentEntries.length === 0 ? (
              <p className="farmer-current-empty">
                Nothing listed yet. What you send below will be your first listing.
              </p>
            ) : (
              <>
                <ul className="farmer-current-list">
                  {currentEntries.map((entry) => (
                    <li key={entry.entryId}>{describeEntry(entry)}</li>
                  ))}
                </ul>
                <p className="farmer-current-rule">
                  Anything you don&apos;t mention stays on your listing. To take something off,
                  say so — like &ldquo;sold out of kale&rdquo;.
                </p>
              </>
            )}
          </section>

          <label htmlFor="farmer-form-text">What changed at your stand today?</label>
          <textarea
            ref={textRef}
            id="farmer-form-text"
            value={text}
            rows={4}
            onChange={(event) => setText(event.target.value)}
            placeholder="a dozen eggs, lots of kale, plum jam $6"
          />
          <button type="button" disabled={busy || text.trim() === ""} onClick={() => void propose()}>
            {busy ? "Checking…" : "Preview update"}
          </button>
        </>
      )}

      {stage.step === "confirming" && (
        <section
          className="farmer-confirmation"
          role="region"
          aria-label="Exact publication preview"
        >
          <p className="farmer-form-note">
            <strong>This is exactly what people will see.</strong>
          </p>
          <p className="farmer-form-note">Nothing has changed yet.</p>
          {/* Code-rendered from the validated snapshot — never model prose. */}
          <pre className="farmer-form-snapshot">{stage.confirmationText}</pre>
          <button type="button" disabled={busy} onClick={() => void settle(true)}>
            {busy ? "Publishing…" : "Confirm and publish"}
          </button>
          <button type="button" disabled={busy} onClick={() => void settle(false)}>
            Decline this update
          </button>
        </section>
      )}

    </>
  );
}
