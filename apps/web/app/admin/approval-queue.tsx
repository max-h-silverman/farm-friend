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
  if (!row.approved) return "Not approved";
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
          ? `${farmName} is approved for publication.`
          : `${farmName}'s approval is revoked. Existing publication is unchanged.`,
      );
    } catch {
      setError("That change did not go through. Reload and try again.");
    } finally {
      setPending(null);
    }
  }

  if (rows.length === 0) {
    return <p className="admin-note">No farms yet. Seed listing data first.</p>;
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
      <ul className="admin-farms">
        {rows.map((row) => (
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
                  ? "Revoke approval"
                  : "Approve"}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
