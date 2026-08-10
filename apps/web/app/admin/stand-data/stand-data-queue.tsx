"use client";

import { useState } from "react";
import { AdminRecoveryError } from "../admin-shell";

// The stand-data queue's interactive half (F-037).
//
// One action: resolve, with a REQUIRED note saying what was decided. There is deliberately
// no action that edits the listing — resolution is a recorded decision, not a correction —
// and no dismiss-without-a-word, because an unexplained disposal of a data contradiction
// leaves the next operator exactly where this queue started: guessing.

export interface StandDataFlagItem {
  flagId: string;
  standName: string;
  reason: string;
  sourceText: string;
  resolutionNote: string | null;
  resolvedByEmail: string | null;
  createdAt: string;
}

/** The seeder's reason codes, said in words an operator can act on. */
const REASON_LABELS: Record<string, string> = {
  contradictory_hours: "States two different opening times",
  season_unresolved: "Season could not be understood",
  unparsed_availability: "Availability text could not be understood",
  possibly_closed: "A dated note says the stand closed",
  address_unresolved: "Address could not be placed on the map",
};

/**
 * A reason code with no label yet, made readable rather than shown raw.
 *
 * The old fallback printed the enum value itself, so a reason added later would show a
 * volunteer `season_unresolved`. This is not a substitute for a real label — it is what keeps
 * an unlabelled code from looking like a bug on the operator's screen.
 */
function reasonLabel(reason: string): string {
  const known = REASON_LABELS[reason];
  if (known !== undefined) return known;
  const words = reason.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function StandDataQueue({ flags }: { flags: StandDataFlagItem[] }) {
  const [rows, setRows] = useState(flags);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  /**
   * Keyed by row, and rendered inside the row it belongs to.
   *
   * A single banner at the top of the list put "add a note before closing this question"
   * above every question on the screen, while the empty box that caused it could be well
   * below the fold. The message now sits with the control it is about.
   */
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [sessionExpired, setSessionExpired] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  function clearRowError(flagId: string) {
    setRowError((current) => {
      const next = { ...current };
      delete next[flagId];
      return next;
    });
  }

  async function resolve(flagId: string) {
    const note = (notes[flagId] ?? "").trim();
    if (note === "") {
      setRowError((current) => ({
        ...current,
        [flagId]: "Write what you found out before closing this question.",
      }));
      return;
    }
    setPending(flagId);
    clearRowError(flagId);
    setSessionExpired(false);
    setSuccess(null);
    try {
      const response = await fetch("/api/admin/stand-data-flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flagId, note }),
      });
      if (!response.ok) {
        if (response.status === 403) setSessionExpired(true);
        else
          setRowError((current) => ({
            ...current,
            [flagId]:
              response.status === 409
                ? "Someone else already answered this question. Reload to see what they wrote."
                : "That did not save. Try again.",
          }));
        return;
      }
      setRows((current) =>
        current.map((row) =>
          row.flagId === flagId ? { ...row, resolutionNote: note } : row,
        ),
      );
      // The resolved row now renders its own note back to the operator, which is the real
      // confirmation. The banner says only what the row cannot: that it is closed for good.
      setSuccess("Answer recorded. This question is closed.");
    } catch {
      setRowError((current) => ({
        ...current,
        [flagId]: "That did not save. Try again.",
      }));
    } finally {
      setPending(null);
    }
  }

  if (rows.length === 0) {
    return (
      <p className="admin-note">
        No listing questions right now.
      </p>
    );
  }

  return (
    <>
      {/*
        Says what recording DOES as well as what it does not. The note previously stated only
        the boundary ("does not change the map"), which left the obvious question unanswered:
        if it changes nothing, why type anything? Both halves are true and the operator needs
        the first one to act.
      */}
      <p className="admin-boundary-note">
        These are questions about what VIGA’s own records say — write down what you found out.
        Your note closes the question and is kept as the record. Changing what a listing says
        is the farmer’s, not yours.
      </p>
      {sessionExpired && (
        <AdminRecoveryError>Your session expired before the decision was saved.</AdminRecoveryError>
      )}
      {success !== null && (
        <p className="admin-success" role="status">
          {success}
        </p>
      )}
      <ul className="admin-farms">
        {rows.map((row) => (
          <li key={row.flagId} className="admin-farm">
            <div>
              <h2>{row.standName}</h2>
              <p className="admin-note">
                {reasonLabel(row.reason)} · raised {formatWhen(row.createdAt)}
              </p>
              <blockquote className="admin-note">{row.sourceText}</blockquote>
              {row.resolutionNote !== null && (
                <p className="admin-approved">
                  Resolved{row.resolvedByEmail === null ? "" : ` by ${row.resolvedByEmail}`}:{" "}
                  {row.resolutionNote}
                </p>
              )}
            </div>
            {row.resolutionNote === null && (
              <div className="admin-flag-actions">
                {/*
                  A visible label, not a placeholder standing in for one. The placeholder is
                  now an EXAMPLE — a question ("What did you decide?") in the box told the
                  operator what to type but never what typing it would do.
                */}
                <label className="admin-field">
                  <span className="admin-control-label">What did you find out?</span>
                  <input
                    aria-label={`Resolution note for ${row.standName}`}
                    type="text"
                    placeholder="e.g. called the farmer — open 9–5 Saturdays"
                    value={notes[row.flagId] ?? ""}
                    onChange={(event) =>
                      setNotes((current) => ({
                        ...current,
                        [row.flagId]: event.target.value,
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={pending === row.flagId}
                  onClick={() => resolve(row.flagId)}
                >
                  {pending === row.flagId ? "Saving…" : "Record decision"}
                </button>
                {rowError[row.flagId] !== undefined && (
                  <p className="admin-error" role="alert">
                    {rowError[row.flagId]}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
