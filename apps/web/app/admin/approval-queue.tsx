"use client";

import { useState } from "react";
import { AdminRecoveryError } from "./admin-shell";

// The approval queue's interactive half. It renders what the server already decided the
// viewer may see and posts decisions back to `/api/admin/farms`, which re-checks authority
// server-side — this component's state is convenience, never authorization.

export interface ApprovalRow {
  farmId: string;
  name: string;
  approved: boolean;
  approvedAt: string | null;
  approvedByEmail: string | null;
}

function formatApproved(row: ApprovalRow): string {
  if (!row.approved) return "Not approved yet";
  const when =
    row.approvedAt === null
      ? ""
      : ` ${new Date(row.approvedAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })}`;
  const who = row.approvedByEmail === null ? "" : ` by ${row.approvedByEmail}`;
  return `Approved${when}${who}`;
}

export function ApprovalQueue({ farms }: { farms: ApprovalRow[] }) {
  const [rows, setRows] = useState(farms);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // F-067 — an EMPTY queue is the normal, healthy state rather than an absence of work.
  // Invited farmers approve themselves by redeeming, so this fills only from the three paths
  // that still need a person: a bare uninvited SIGNUP, an invitation naming no farm, and one
  // whose agreement was never ticked. Empty-state copy reading "nothing to do YET" invited an
  // operator to wonder what had gone wrong.
  const waiting = rows.filter((row) => !row.approved);
  const approved = rows.filter((row) => row.approved);

  async function decide(farmId: string, action: "approve" | "revoke") {
    setPending(farmId);
    setError(null);
    setSessionExpired(false);
    setSuccess(null);
    try {
      const response = await fetch("/api/admin/farms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ farmId, action }),
      });
      if (!response.ok) {
        // Say what happened rather than silently reverting: an operator who thinks they
        // approved a farm that is still blocked is worse off than one who sees an error.
        if (response.status === 403) setSessionExpired(true);
        else setError("That change did not go through. Reload and try again.");
        return;
      }
      // Reflect the committed decision. The authoritative record is the database's; this is
      // the optimistic view of the answer it just gave.
      setRows((current) =>
        current.map((row) =>
          row.farmId === farmId
            ? {
                ...row,
                approved: action === "approve",
                approvedAt: action === "approve" ? new Date().toISOString() : null,
                approvedByEmail: action === "approve" ? row.approvedByEmail : null,
              }
            : row,
        ),
      );
      const farmName = rows.find((row) => row.farmId === farmId)?.name ?? "Farm";
      setSuccess(
        action === "approve"
          ? `${farmName} is approved. Its stands can appear on Farm Friend.`
          : `${farmName}'s approval was removed. Existing map listings stay as they are.`,
      );
      setRemoving(null);
    } catch {
      setError("That change did not go through. Reload and try again.");
    } finally {
      setPending(null);
    }
  }

  if (rows.length === 0) {
    return <p className="admin-note">No farms yet.</p>;
  }

  return (
    <>
      {error !== null && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {sessionExpired && (
        <AdminRecoveryError>Your session expired before the change was saved.</AdminRecoveryError>
      )}
      {success !== null && (
        <p className="admin-success" role="status">
          {success}
        </p>
      )}
      {waiting.length === 0 ? (
        <p className="admin-empty-state">
          Nothing waiting. Invited farmers are approved automatically when they sign up.
        </p>
      ) : (
      <ul className="admin-farms">
        {waiting.map((row) => (
          <li key={row.farmId} className="admin-farm">
            <div>
              <h2>{row.name}</h2>
              <p className={row.approved ? "admin-approved" : "admin-unapproved"}>
                {formatApproved(row)}
              </p>
            </div>
            <button
              type="button"
              disabled={pending === row.farmId}
              onClick={() => decide(row.farmId, row.approved ? "revoke" : "approve")}
            >
              {pending === row.farmId
                ? "Saving…"
                : row.approved
                  ? "Remove approval"
                  : "Approve farm"}
            </button>
          </li>
        ))}
      </ul>
      )}
      {approved.length > 0 && (
        <details className="admin-secondary-disclosure">
          <summary>Approved farms ({approved.length})</summary>
          <ul className="admin-farms">
            {approved.map((row) => (
              <li key={row.farmId} className="admin-farm">
                <div>
                  <h2>{row.name}</h2>
                  <p className="admin-approved">{formatApproved(row)}</p>
                </div>
                <button
                  type="button"
                  disabled={pending === row.farmId}
                  onClick={() => setRemoving(row.farmId)}
                >
                  Remove approval
                </button>
                {removing === row.farmId && (
                  <div className="admin-inline-confirm" role="group" aria-label={`Remove approval for ${row.name}`}>
                    <p>Existing map listings will stay visible. Remove approval anyway?</p>
                    <button type="button" disabled={pending === row.farmId} onClick={() => void decide(row.farmId, "revoke")}>
                      {pending === row.farmId ? "Saving…" : "Remove approval"}
                    </button>
                    <button type="button" disabled={pending === row.farmId} onClick={() => setRemoving(null)}>Cancel</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
