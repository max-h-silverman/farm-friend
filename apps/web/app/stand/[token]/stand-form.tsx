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

  /*
    The chips' working state, held until the farmer previews.

    A stand listing is a SET OF SHORT STRINGS, so removing an item should be a tap rather
    than a sentence a model has to read back into the removal we already had. These two
    pieces of state ARE the edit: `removedIds` and `added` compose directly into the typed
    shape the interpreter would otherwise produce.

    Nothing here publishes. The tap marks an intention; `propose` turns it into the same
    proposal the typed path opens, and the farmer still confirms the rendered result.
  */
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [added, setAdded] = useState<{ itemName: string }[]>([]);
  const [draftItem, setDraftItem] = useState("");

  const removed = new Set(removedIds);
  const hasChanges = removedIds.length > 0 || added.length > 0;

  function addDraftItem() {
    const itemName = draftItem.trim();
    if (itemName === "") return;
    setAdded((current) => [...current, { itemName }]);
    setDraftItem("");
  }

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

  /**
   * Open a proposal from whichever description the farmer gave.
   *
   * Chips post a STRUCTURED edit and skip the model — it is already the shape the model
   * would return. Free text posts `text` for interpretation. Never both: the server refuses
   * a request carrying two descriptions of one change rather than picking a winner.
   */
  async function propose(source: "chips" | "text") {
    if (source === "text" && text.trim() === "") return;
    if (source === "chips" && !hasChanges) return;
    // A publication, decline, or clarification describes the request that just ended.
    // Once another proposal starts, keeping that terminal message beside a new failure
    // would make two contradictory claims about the current request.
    setStage({ step: "typing" });
    const payload = await post(
      source === "chips"
        ? {
            action: "propose",
            edit: {
              additions: added,
              changes: [],
              removals: removedIds.map((entryId) => ({ entryId })),
            },
          }
        : { action: "propose", text },
    );
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
    if (accept) {
      // The chips described a change that is now published, so the marks that described it
      // are spent. Leaving them would show a farmer their next visit's listing as already
      // half-edited against a listing that has since moved on.
      setText("");
      setRemovedIds([]);
      setAdded([]);
      setDraftItem("");
    }
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
            THE LISTING, DIRECTLY EDITABLE.

            A stand listing is a set of short strings, so the farmer manipulates it rather
            than composing a sentence about it: tap × to take something off, type to add.
            That removes the whole class of confusion this screen used to have — there is no
            "does typing this add or replace?" question when the farmer can see the set and
            act on its members. Items they do not touch are visibly untouched.

            Nothing here publishes. The marks compose into the same typed edit the model
            would produce, open the same proposal, and reach the same confirmation.
          */}
          <section className="farmer-current" aria-labelledby="farmer-current-heading">
            <h2 id="farmer-current-heading">Your stand is showing now</h2>
            {currentEntries.length === 0 && added.length === 0 ? (
              <p className="farmer-current-empty">
                Nothing listed yet. What you add below will be your first listing.
              </p>
            ) : (
              <ul className="farmer-chips">
                {currentEntries.map((entry) => {
                  const isRemoved = removed.has(entry.entryId);
                  return (
                    <li
                      key={entry.entryId}
                      className={isRemoved ? "farmer-chip farmer-chip--removed" : "farmer-chip"}
                    >
                      <span className="farmer-chip-label">{describeEntry(entry)}</span>
                      {isRemoved ? (
                        <button
                          type="button"
                          className="farmer-chip-action"
                          onClick={() =>
                            setRemovedIds((ids) => ids.filter((id) => id !== entry.entryId))
                          }
                        >
                          Undo
                          <span className="sr-only"> removing {entry.itemName}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="farmer-chip-action"
                          aria-label={`Remove ${entry.itemName}`}
                          onClick={() => setRemovedIds((ids) => [...ids, entry.entryId])}
                        >
                          <span aria-hidden="true">×</span>
                        </button>
                      )}
                    </li>
                  );
                })}
                {added.map((item, index) => (
                  <li key={`added-${item.itemName}`} className="farmer-chip farmer-chip--added">
                    <span className="farmer-chip-label">{item.itemName}</span>
                    <button
                      type="button"
                      className="farmer-chip-action"
                      aria-label={`Remove ${item.itemName}`}
                      onClick={() =>
                        setAdded((current) => current.filter((_, at) => at !== index))
                      }
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="farmer-chip-add">
              <label htmlFor="farmer-add-item">Add something</label>
              <div className="farmer-chip-add-row">
                <input
                  id="farmer-add-item"
                  type="text"
                  value={draftItem}
                  placeholder="plum jam"
                  maxLength={120}
                  onChange={(event) => setDraftItem(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter adds the item rather than submitting a form the farmer has not
                    // finished building.
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addDraftItem();
                    }
                  }}
                />
                <button
                  type="button"
                  className="farmer-chip-add-button"
                  disabled={draftItem.trim() === ""}
                  onClick={addDraftItem}
                >
                  Add
                </button>
              </div>
            </div>

            <button
              type="button"
              className="farmer-chip-preview"
              disabled={busy || !hasChanges}
              onClick={() => void propose("chips")}
            >
              {busy ? "Checking…" : "Preview update"}
            </button>
          </section>

          {/*
            The escape hatch, deliberately secondary.

            The chips cover the common case — what is on the table is a set of items. They
            cannot express "closed through Sunday", "half the eggs are gone", or a price
            change stated in passing, and those are exactly what the model seam is for. A
            farmer who wants to write it out still can; they are just not made to.
          */}
          <label className="farmer-form-freetext-label" htmlFor="farmer-form-text">
            Or write it in your own words
          </label>
          <textarea
            ref={textRef}
            id="farmer-form-text"
            value={text}
            rows={4}
            onChange={(event) => setText(event.target.value)}
            placeholder="a dozen eggs, lots of kale, plum jam $6"
          />
          {/*
            Named for its own input, not "Preview update" a second time: two controls with
            one label is ambiguous to a farmer skimming and to a screen reader listing
            buttons, and they send genuinely different requests.
          */}
          <button
            className="farmer-form-freetext-button"
            type="button"
            disabled={busy || text.trim() === ""}
            onClick={() => void propose("text")}
          >
            {busy ? "Checking…" : "Preview what I wrote"}
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
          {/* The one control that publishes, marked as such rather than inferred from being
              first in the document — see `.farmer-form-affirmative`. */}
          <button
            className="farmer-form-affirmative"
            type="button"
            disabled={busy}
            onClick={() => void settle(true)}
          >
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
