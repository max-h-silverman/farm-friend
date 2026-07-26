"use client";

import { useState } from "react";

// The flag queue's interactive half (F-030). Like the approval queue, this renders what the
// server already decided the viewer may see and posts decisions back to `/api/admin/flags`,
// which re-checks authority server-side — this component's state is convenience, never
// authorization.
//
// The sender is shown as an already-masked string the server produced. This component never
// sees a phone number, so it cannot leak one.

export interface FlagRow {
  flagId: string;
  senderMask: string;
  reasonCode: string;
  status: "open" | "resolved" | "dismissed";
  dispositionCode: string | null;
  disposedByEmail: string | null;
  disposedAt: string | null;
  createdAt: string;
  hasReadableThread: boolean;
}

export interface ThreadMessage {
  messageId: string;
  receivedAt: string;
  body: string | null;
  bodyPurged: boolean;
  isFlagged: boolean;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function FlagQueue({ flags }: { flags: FlagRow[] }) {
  const [rows, setRows] = useState(flags);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadMessage[]>>({});

  async function viewThread(flagId: string) {
    if (openThread === flagId) {
      setOpenThread(null);
      return;
    }
    setOpenThread(flagId);
    if (threads[flagId] !== undefined) return;
    try {
      const response = await fetch(`/api/admin/flags/${flagId}/thread`);
      if (!response.ok) {
        setError("That thread could not be loaded. Reload and try again.");
        return;
      }
      const payload = (await response.json()) as {
        thread: { messages: ThreadMessage[] };
      };
      setThreads((current) => ({ ...current, [flagId]: payload.thread.messages }));
    } catch {
      setError("That thread could not be loaded. Reload and try again.");
    }
  }

  async function decide(flagId: string, action: "resolve" | "dismiss") {
    // The reason is required by the route: an audit record that does not say why is not much
    // of an audit record. Asking here keeps the operator's own words in the trail.
    const dispositionCode = window.prompt(
      action === "resolve"
        ? "What did you do about this flag? (recorded in the audit trail)"
        : "Why is this being dismissed? (recorded in the audit trail)",
    );
    if (dispositionCode === null || dispositionCode.trim() === "") return;

    setPending(flagId);
    setError(null);
    try {
      const response = await fetch("/api/admin/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flagId, action, dispositionCode }),
      });
      if (!response.ok) {
        setError(
          response.status === 403
            ? "Your session is no longer authorized. Sign in again."
            : response.status === 409
              ? "Someone else already reviewed this flag. Reload to see their decision."
              : "That change did not go through. Reload and try again.",
        );
        return;
      }
      setRows((current) =>
        current.map((row) =>
          row.flagId === flagId
            ? {
                ...row,
                status: action === "resolve" ? "resolved" : "dismissed",
                dispositionCode,
                disposedAt: new Date().toISOString(),
              }
            : row,
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
        No open flags. A customer or farmer who texts <strong>FLAG</strong> appears here for
        review.
      </p>
    );
  }

  return (
    <>
      {error !== null && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <ul className="admin-farms">
        {rows.map((row) => (
          <li key={row.flagId} className="admin-farm admin-flag">
            <div className="admin-flag-main">
              <h2>{row.senderMask}</h2>
              <p className="admin-note">
                {row.reasonCode} · flagged {formatWhen(row.createdAt)}
              </p>
              {row.status !== "open" && (
                <p className="admin-approved">
                  {row.status === "resolved" ? "Resolved" : "Dismissed"}
                  {row.dispositionCode === null ? "" : ` — ${row.dispositionCode}`}
                  {row.disposedByEmail === null ? "" : ` by ${row.disposedByEmail}`}
                </p>
              )}

              {openThread === row.flagId && (
                <ol className="admin-thread">
                  {(threads[row.flagId] ?? []).map((message) => (
                    <li
                      key={message.messageId}
                      className={message.isFlagged ? "admin-thread-flagged" : undefined}
                    >
                      <span className="admin-note">{formatWhen(message.receivedAt)}</span>{" "}
                      {message.bodyPurged ? (
                        <em className="admin-note">
                          (message content deleted on its retention schedule)
                        </em>
                      ) : (
                        message.body
                      )}
                    </li>
                  ))}
                  {(threads[row.flagId] ?? []).length === 0 && (
                    <li className="admin-note">No retained messages in this thread.</li>
                  )}
                </ol>
              )}
            </div>

            <div className="admin-flag-actions">
              <button type="button" onClick={() => viewThread(row.flagId)}>
                {openThread === row.flagId ? "Hide thread" : "View thread"}
              </button>
              {row.status === "open" && (
                <>
                  <button
                    type="button"
                    disabled={pending === row.flagId}
                    onClick={() => decide(row.flagId, "resolve")}
                  >
                    {pending === row.flagId ? "Saving…" : "Resolve"}
                  </button>
                  <button
                    type="button"
                    disabled={pending === row.flagId}
                    onClick={() => decide(row.flagId, "dismiss")}
                  >
                    Dismiss
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
