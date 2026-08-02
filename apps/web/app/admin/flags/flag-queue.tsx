"use client";

import { useState } from "react";
import { AdminRecoveryError } from "../admin-shell";

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
  const [sessionExpired, setSessionExpired] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadMessage[]>>({});
  const [threadLoading, setThreadLoading] = useState<string | null>(null);
  const [threadErrors, setThreadErrors] = useState<Record<string, string>>({});

  async function viewThread(flagId: string) {
    if (openThread === flagId) {
      setOpenThread(null);
      return;
    }
    setOpenThread(flagId);
    if (threads[flagId] !== undefined) return;
    setSessionExpired(false);
    setThreadLoading(flagId);
    setThreadErrors((current) => {
      const next = { ...current };
      delete next[flagId];
      return next;
    });
    try {
      const response = await fetch(`/api/admin/flags/${flagId}/thread`);
      if (!response.ok) {
        if (response.status === 403) setSessionExpired(true);
        else
          setThreadErrors((current) => ({
            ...current,
            [flagId]: "That thread could not be loaded. Reload and try again.",
          }));
        return;
      }
      const payload = (await response.json()) as {
        thread: { messages: ThreadMessage[] };
      };
      setThreads((current) => ({ ...current, [flagId]: payload.thread.messages }));
    } catch {
      setThreadErrors((current) => ({
        ...current,
        [flagId]: "That thread could not be loaded. Reload and try again.",
      }));
    } finally {
      setThreadLoading(null);
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
    setSessionExpired(false);
    setSuccess(null);
    try {
      const response = await fetch("/api/admin/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flagId, action, dispositionCode }),
      });
      if (!response.ok) {
        if (response.status === 403) setSessionExpired(true);
        else setError(
          response.status === 409
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
      setSuccess(
      `${action === "resolve" ? "Flag resolved" : "Flag dismissed"}. Older messages can now be deleted on their normal schedule.`,
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
        No FLAG messages need review.
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
          <li key={row.flagId} className="admin-farm admin-flag">
            <div className="admin-flag-main">
              <h2>{row.senderMask}</h2>
              <p className="admin-note">
                FLAG message · received {formatWhen(row.createdAt)}
              </p>
              {row.status !== "open" && (
                <p className="admin-approved">
                  {row.status === "resolved" ? "Resolved" : "Dismissed"}
                  {row.dispositionCode === null ? "" : ` — ${row.dispositionCode}`}
                  {row.disposedByEmail === null ? "" : ` by ${row.disposedByEmail}`}
                </p>
              )}

              {openThread === row.flagId && (
                <div id={`thread-${row.flagId}`} className="admin-thread-panel">
                  <p className="admin-retention-warning">
                    Read this before closing the flag. Once it is closed, older messages can be
                    deleted on their normal schedule.
                  </p>
                  {threadLoading === row.flagId && (
                    <p className="admin-note" role="status">
                      Loading thread…
                    </p>
                  )}
                  {threadErrors[row.flagId] !== undefined && (
                    <p className="admin-error" role="alert">
                      {threadErrors[row.flagId]}
                    </p>
                  )}
                  {threadLoading !== row.flagId && threadErrors[row.flagId] === undefined && (
                    <ol className="admin-thread">
                      {(threads[row.flagId] ?? []).map((message) => (
                        <li
                          key={message.messageId}
                          className={message.isFlagged ? "admin-thread-flagged" : undefined}
                          aria-label={message.isFlagged ? "Flagged message" : undefined}
                        >
                          <span className="admin-note">{formatWhen(message.receivedAt)}</span>{" "}
                          {message.bodyPurged ? (
                            <em className="admin-note">(message deleted on schedule)</em>
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
              )}
            </div>

            <div className="admin-flag-actions">
              <button
                type="button"
                aria-expanded={openThread === row.flagId}
                aria-controls={`thread-${row.flagId}`}
                onClick={() => viewThread(row.flagId)}
              >
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
