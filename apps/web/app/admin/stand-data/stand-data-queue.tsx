"use client";

import { useState } from "react";

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
};

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
  const [error, setError] = useState<string | null>(null);

  async function resolve(flagId: string) {
    const note = (notes[flagId] ?? "").trim();
    if (note === "") {
      setError("Write what you decided before resolving — the note is the record.");
      return;
    }
    setPending(flagId);
    setError(null);
    try {
      const response = await fetch("/api/admin/stand-data-flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flagId, note }),
      });
      if (!response.ok) {
        setError(
          response.status === 403
            ? "Your session is no longer authorized. Sign in again."
            : response.status === 409
              ? "Someone else already resolved this question. Reload to see their decision."
              : "That change did not go through. Reload and try again.",
        );
        return;
      }
      setRows((current) =>
        current.map((row) =>
          row.flagId === flagId ? { ...row, resolutionNote: note } : row,
        ),
      );
    } catch {
      setError("That change did not go through. Reload and try again.");
    } finally {
      setPending(null);
    }
  }

  if (rows.length === 0) {
    return (
      <p className="admin-note">
        No open questions. The loader raises one when a stand&apos;s source data needs a
        human decision.
      </p>
    );
  }

  return (
    <>
      <p className="admin-boundary-note">
        Resolving a data question records the decision; it does not edit the public listing.
      </p>
      {error !== null && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <ul className="admin-farms">
        {rows.map((row) => (
          <li key={row.flagId} className="admin-farm">
            <div>
              <h2>{row.standName}</h2>
              <p className="admin-note">
                {REASON_LABELS[row.reason] ?? row.reason} · raised{" "}
                {formatWhen(row.createdAt)}
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
                <input
                  aria-label={`Resolution note for ${row.standName}`}
                  type="text"
                  placeholder="What did you decide?"
                  value={notes[row.flagId] ?? ""}
                  onChange={(event) =>
                    setNotes((current) => ({
                      ...current,
                      [row.flagId]: event.target.value,
                    }))
                  }
                />
                <button
                  type="button"
                  disabled={pending === row.flagId}
                  onClick={() => resolve(row.flagId)}
                >
                  {pending === row.flagId ? "Saving…" : "Resolve"}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
