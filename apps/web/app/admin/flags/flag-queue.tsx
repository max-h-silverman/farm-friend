"use client";

import { useState } from "react";
import { AdminRefusal, refusalFromResponse, type AdminRefusalKind } from "../admin-shell";

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
  /** The address a reporter left for a reply (B-091). Reaches the browser only as a mailto. */
  reporterEmail: string | null;
  /** What is DISPLAYED. The raw address is never rendered as text. */
  reporterEmailMask: string;
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
  const [refusal, setRefusal] = useState<AdminRefusalKind | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadMessage[]>>({});
  const [threadLoading, setThreadLoading] = useState<string | null>(null);
  const [threadErrors, setThreadErrors] = useState<Record<string, string>>({});
  const [decision, setDecision] = useState<{ flagId: string; action: "resolve" | "dismiss" } | null>(null);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});

  async function viewThread(flagId: string) {
    if (openThread === flagId) {
      setOpenThread(null);
      return;
    }
    setOpenThread(flagId);
    if (threads[flagId] !== undefined) return;
    setRefusal(null);
    setThreadLoading(flagId);
    setThreadErrors((current) => {
      const next = { ...current };
      delete next[flagId];
      return next;
    });
    try {
      const response = await fetch(`/api/admin/flags/${flagId}/thread`);
      if (!response.ok) {
        const refused = await refusalFromResponse(response.clone());
        if (refused !== null) setRefusal(refused);
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
    const dispositionCode = (decisionNotes[flagId] ?? "").trim();
    if (dispositionCode === "") {
      setError("Add a short note about what you decided before saving.");
      return;
    }

    setPending(flagId);
    setError(null);
    setRefusal(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/admin/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flagId, action, dispositionCode }),
      });
      if (!response.ok) {
        const refused = await refusalFromResponse(response.clone());
        if (refused !== null) setRefusal(refused);
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
      setDecision(null);
    } catch {
      setError("That change did not go through. Reload and try again.");
    } finally {
      setPending(null);
    }
  }

  if (rows.length === 0) {
    return (
      <p className="admin-note">
        Nothing needs review. Messages appear here when a customer asks us to look at one.
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
      <AdminRefusal refusal={refusal} />
      {success !== null && (
        <p className="admin-success" role="status">
          {success}
        </p>
      )}
      <ul className="admin-sellers">
        {rows.map((row) => (
          <li key={row.flagId} className="admin-farm admin-flag">
            <div className="admin-flag-main">
              <h2>{row.senderMask}</h2>
              <p className="admin-note">
                Flagged for review · received {formatWhen(row.createdAt)}
              </p>
              {/*
                B-091 — the reporter ASKED to hear back, so the way to answer them is here.

                The address is shown MASKED and the raw value appears only inside the mail
                link's href, never as page text (Golden Rule #5). A coordinator recognises who
                they are writing to and can write; a screenshot of this queue leaks nothing.

                Absent entirely when no address was left, rather than rendered as an empty
                row: most reporters will not leave one, and a permanent "(no email on file)"
                on every flag is noise on the screen that exists to be scanned.
              */}
              {row.reporterEmail !== null && (
                <p className="admin-note admin-flag-reply">
                  Asked for a reply:{" "}
                  <a href={`mailto:${row.reporterEmail}`}>{row.reporterEmailMask}</a>
                </p>
              )}
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
                        <li className="admin-note">
                          The messages were deleted on their retention schedule. Decide this
                          flag from the record above — the wording is gone for good.
                        </li>
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
                  {decision?.flagId === row.flagId ? (
                    <div className="admin-decision-panel" role="group" aria-label="Record your decision">
                      <label className="admin-field">
                        <span className="admin-control-label">
                          {decision.action === "resolve" ? "What did you do?" : "Why is this not an issue?"}
                        </span>
                        <input
                          aria-label={`Decision note for ${row.senderMask}`}
                          autoFocus
                          type="text"
                          value={decisionNotes[row.flagId] ?? ""}
                          onChange={(event) => setDecisionNotes((current) => ({ ...current, [row.flagId]: event.target.value }))}
                        />
                      </label>
                      <div className="admin-button-row">
                        <button type="button" disabled={pending === row.flagId} onClick={() => void decide(row.flagId, decision.action)}>
                          {pending === row.flagId ? "Saving…" : "Save decision"}
                        </button>
                        <button type="button" disabled={pending === row.flagId} onClick={() => setDecision(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button type="button" onClick={() => setDecision({ flagId: row.flagId, action: "resolve" })}>Resolve</button>
                      <button type="button" onClick={() => setDecision({ flagId: row.flagId, action: "dismiss" })}>Dismiss</button>
                    </>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
