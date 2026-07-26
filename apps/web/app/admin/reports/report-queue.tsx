"use client";

import { useState } from "react";

// The stock-out report queue's interactive half (F-030).
//
// The only two actions are "reviewed" and "dismissed". There is deliberately NO action here
// that changes a listing: a customer's report never edits a farmer's inventory, not even
// through an operator (Golden Rule #1). If a stand really is out, the farmer's own confirmed
// update is what changes the map — an operator's job is to notice and, if needed, chase.

export interface ReportRow {
  reportId: string;
  farmName: string;
  salesLocationName: string;
  itemText: string;
  status: "open" | "reviewed" | "dismissed";
  reviewedByEmail: string | null;
  reportedAt: string;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ReportQueue({ reports }: { reports: ReportRow[] }) {
  const [rows, setRows] = useState(reports);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(reportId: string, action: "review" | "dismiss") {
    setPending(reportId);
    setError(null);
    try {
      const response = await fetch("/api/admin/stock-out-reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reportId, action }),
      });
      if (!response.ok) {
        setError(
          response.status === 403
            ? "Your session is no longer authorized. Sign in again."
            : response.status === 409
              ? "Someone else already triaged this report. Reload to see their decision."
              : "That change did not go through. Reload and try again.",
        );
        return;
      }
      setRows((current) =>
        current.map((row) =>
          row.reportId === reportId
            ? { ...row, status: action === "review" ? "reviewed" : "dismissed" }
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
        No stock-out reports yet. Customers file these privately from a stand&apos;s QR code.
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
          <li key={row.reportId} className="admin-farm">
            <div>
              <h2>{row.itemText}</h2>
              <p className="admin-note">
                {row.farmName} · {row.salesLocationName} · reported{" "}
                {formatWhen(row.reportedAt)}
              </p>
              {row.status !== "open" && (
                <p className="admin-approved">
                  {row.status === "reviewed" ? "Reviewed" : "Dismissed"}
                  {row.reviewedByEmail === null ? "" : ` by ${row.reviewedByEmail}`}
                </p>
              )}
            </div>
            {row.status === "open" && (
              <div className="admin-flag-actions">
                <button
                  type="button"
                  disabled={pending === row.reportId}
                  onClick={() => decide(row.reportId, "review")}
                >
                  {pending === row.reportId ? "Saving…" : "Mark reviewed"}
                </button>
                <button
                  type="button"
                  disabled={pending === row.reportId}
                  onClick={() => decide(row.reportId, "dismiss")}
                >
                  Dismiss
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
