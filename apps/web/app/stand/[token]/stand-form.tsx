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

export function StandForm({
  token,
  initialParticipantNames = [],
}: {
  token: string;
  initialParticipantNames?: string[];
}) {
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "typing" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInactive, setLinkInactive] = useState(false);
  const [participantText, setParticipantText] = useState(
    initialParticipantNames.join("\n"),
  );
  const [participantBusy, setParticipantBusy] = useState(false);
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [participantSaved, setParticipantSaved] = useState<"populated" | "empty" | null>(
    null,
  );
  const [participantLinkInactive, setParticipantLinkInactive] = useState(false);
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

  async function saveParticipants() {
    const participantNames = participantText
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter((name) => name !== "");
    setParticipantBusy(true);
    setParticipantError(null);
    setParticipantSaved(null);
    setParticipantLinkInactive(false);
    try {
      const response = await fetch("/api/farmer/stand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          action: "save_participants",
          participantNames,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) {
        if (response.status === 403) setParticipantLinkInactive(true);
        setParticipantError(
          response.status === 403
            ? "This link is no longer active. Seller names are unchanged."
            : typeof payload.message === "string"
              ? payload.message
              : "That did not go through. Seller names are unchanged — try again.",
        );
        return;
      }
      const activeDisplayNames = Array.isArray(payload.activeDisplayNames)
        ? payload.activeDisplayNames.filter(
            (name): name is string => typeof name === "string",
          )
        : participantNames;
      setParticipantText(activeDisplayNames.join("\n"));
      setParticipantSaved(activeDisplayNames.length === 0 ? "empty" : "populated");
    } catch {
      setParticipantError(
        "That did not go through. Seller names are unchanged — try again.",
      );
    } finally {
      setParticipantBusy(false);
    }
  }

  return (
    <>
      {error !== null && (
        <p className="farmer-form-error" role="alert">
          {error}{" "}
          {linkInactive && (
            <Link href="#new-link-help">How to get a new link</Link>
          )}
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

      <section className="farmer-participants" aria-labelledby="farmer-participants-heading">
        <h2 id="farmer-participants-heading">Also selling here</h2>
        <p id="farmer-participants-help" className="farmer-form-note">
          One farm or business name per line. Only names you add appear here. This does not
          give anyone access to update the stand.
        </p>
        {participantError !== null && (
          <p className="farmer-form-error" role="alert">
            {participantError}{" "}
            {participantLinkInactive && (
              <Link href="#new-link-help">How to get a new link</Link>
            )}
          </p>
        )}
        {participantSaved !== null && (
          <p className="farmer-form-published" role="status">
            {participantSaved === "empty"
              ? "Seller names saved. No other sellers are shown."
              : "Seller names saved. The public stand now shows this list."}
          </p>
        )}
        <label htmlFor="farmer-participant-names">Also selling here</label>
        <textarea
          id="farmer-participant-names"
          aria-describedby="farmer-participants-help"
          value={participantText}
          rows={4}
          onChange={(event) => setParticipantText(event.target.value)}
          placeholder={"Guest Growers\nIsland Apiary"}
        />
        <button
          className="farmer-participants-save"
          type="button"
          disabled={participantBusy}
          onClick={() => void saveParticipants()}
        >
          {participantBusy ? "Saving…" : "Save seller names"}
        </button>
      </section>
    </>
  );
}
