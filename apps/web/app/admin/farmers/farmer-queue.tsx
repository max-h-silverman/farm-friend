"use client";

import { useState } from "react";
import { AdminRecoveryError } from "../admin-shell";

// The farmer access queue's interactive half (F-040). It renders what the server already
// decided the viewer may see and posts decisions back to `/api/admin/farmers`, which
// re-checks authority server-side — this component's state is convenience, never
// authorization.
//
// **No phone number or hash is ever in this component.** A pending request is identified by
// its opaque `requestId`, and the server resolves the phone behind it at the moment VIGA
// authorizes. The operator sees a masked number and nothing else, so the one lookup key for
// a person's phone never reaches a page, a history entry, or a referrer.

export interface PendingRequestRow {
  requestId: string;
  /** The last four digits, already masked by the server. Never the number. */
  senderMask: string;
  requestedAt: string;
}

export interface AuthorizationRow {
  authorizationId: string;
  farmId: string;
  farmName: string;
  senderMask: string;
  authorizedAt: string;
  revokedAt: string | null;
  stands: Array<{ salesLocationId: string; name: string }>;
  hasLiveLink: boolean;
  liveLinkStand: { salesLocationId: string; name: string } | null;
}

export interface FarmOption {
  farmId: string;
  name: string;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function FarmerQueue({
  requests,
  authorizations,
  farms,
}: {
  requests: PendingRequestRow[];
  authorizations: AuthorizationRow[];
  farms: FarmOption[];
}) {
  const [pendingRequests, setPendingRequests] = useState(requests);
  const [rows, setRows] = useState(authorizations);
  const [farmChoice, setFarmChoice] = useState<Record<string, string>>({});
  const [standChoice, setStandChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  /**
   * A freshly minted link, held only in this component's state and only until the operator
   * navigates away. It is never re-readable from the server, which is correct for a standing
   * credential — so the copy below says so rather than letting an operator assume otherwise.
   */
  const [freshLink, setFreshLink] = useState<{ id: string; link: string } | null>(
    null,
  );

  async function post(
    body: Record<string, unknown>,
    key: string,
  ): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
    setBusy(key);
    setError(null);
    setSessionExpired(false);
    setSuccess(null);
    try {
      const response = await fetch("/api/admin/farmers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) {
        // Say what happened rather than silently reverting: an operator who believes they
        // revoked a link that is still live is worse off than one who sees an error.
        if (response.status === 403) setSessionExpired(true);
        else setError("That change did not go through. Reload and try again.");
        return { ok: false, payload };
      }
      return { ok: true, payload };
    } catch {
      setError("That change did not go through. Reload and try again.");
      return { ok: false, payload: {} };
    } finally {
      setBusy(null);
    }
  }

  async function authorize(requestId: string) {
    const farmId = farmChoice[requestId];
    if (farmId === undefined || farmId === "") {
      setError("Choose which farm this person runs before authorizing them.");
      return;
    }
    const { ok } = await post({ action: "authorize", requestId, farmId }, requestId);
    if (!ok) return;
    // The authoritative record is the database's; this reflects the answer it just gave.
    // A reload shows the new authorization in the list below.
    setPendingRequests((current) =>
      current.filter((request) => request.requestId !== requestId),
    );
    setSuccess("Farmer access given. Reload to see their access record.");
  }

  async function revoke(authorizationId: string) {
    const { ok } = await post({ action: "revoke", authorizationId }, authorizationId);
    if (!ok) return;
    setRows((current) =>
      current.map((row) =>
        row.authorizationId === authorizationId
          ? {
              ...row,
              revokedAt: new Date().toISOString(),
              // Revoking a farmer's access revokes their links too, in the same
              // transaction. Showing "link live" here afterwards would be a lie.
              hasLiveLink: false,
              liveLinkStand: null,
            }
          : row,
      ),
    );
    if (freshLink?.id === authorizationId) setFreshLink(null);
    setSuccess("Farmer access removed. Their private link no longer works.");
  }

  async function issueLink(row: AuthorizationRow) {
    const salesLocationId =
      standChoice[row.authorizationId] ??
      row.liveLinkStand?.salesLocationId ??
      (row.stands.length === 1 ? row.stands[0]?.salesLocationId : undefined);
    if (salesLocationId === undefined) {
      setError("Choose the exact stand this private link can update.");
      return;
    }
    const { ok, payload } = await post(
      { action: "issue_link", authorizationId: row.authorizationId, salesLocationId },
      row.authorizationId,
    );
    if (!ok || typeof payload.link !== "string") return;
    setFreshLink({ id: row.authorizationId, link: payload.link });
    const selectedStand = row.stands.find(
      (stand) => stand.salesLocationId === salesLocationId,
    ) ?? null;
    setRows((current) =>
      current.map((currentRow) =>
        currentRow.authorizationId === row.authorizationId
          ? { ...currentRow, hasLiveLink: true, liveLinkStand: selectedStand }
          : currentRow,
      ),
    );
    setSuccess("Private link created. Copy it now — it will not be shown again.");
  }

  async function copyFreshLink() {
    if (freshLink === null) return;
    try {
      await navigator.clipboard.writeText(freshLink.link);
      setSuccess("Private link copied.");
    } catch {
      setError("Copy failed. Select the private link and copy it before leaving this page.");
    }
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

      <h2>Farmers waiting to join</h2>
      {pendingRequests.length === 0 ? (
        <p className="admin-note">
          No requests right now. Farmers can text <strong>SIGNUP</strong> to get started.
        </p>
      ) : (
        <ul className="admin-farms">
          {pendingRequests.map((request) => (
            <li key={request.requestId} className="admin-farm">
              <div>
                <h3>{request.senderMask}</h3>
                <p className="admin-note">
                  Asked {formatDate(request.requestedAt)}
                </p>
              </div>
              <div>
                <label>
                  <span className="admin-control-label">Which farm do they run?</span>
                  <select
                    value={farmChoice[request.requestId] ?? ""}
                    onChange={(event) =>
                      setFarmChoice((current) => ({
                        ...current,
                        [request.requestId]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Choose a farm…</option>
                    {farms.map((farm) => (
                      <option key={farm.farmId} value={farm.farmId}>
                        {farm.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy === request.requestId}
                  onClick={() => void authorize(request.requestId)}
                >
                  {busy === request.requestId ? "Saving…" : "Give access"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>Current farmer access</h2>
      {rows.length === 0 ? (
        <p className="admin-note">No one has farmer access yet.</p>
      ) : (
        <ul className="admin-farms">
          {rows.map((row) => {
            const revoked = row.revokedAt !== null;
            return (
              <li key={row.authorizationId} className="admin-farm">
                <div>
                  <h3>{row.farmName}</h3>
                  <p className={revoked ? "admin-unapproved" : "admin-approved"}>
                    {row.senderMask} ·{" "}
                    {revoked
                      ? `Revoked ${formatDate(row.revokedAt as string)}`
                      : `Authorized ${formatDate(row.authorizedAt)}`}
                  </p>
                  <p className="admin-note">
                    {revoked
                      ? "Access was removed, so their private link no longer works."
                      : row.hasLiveLink && row.liveLinkStand !== null
                        ? `Private link works for ${row.liveLinkStand.name}.`
                        : "No private link yet. They can text LINK whenever they need one."}
                  </p>
                  {freshLink?.id === row.authorizationId && (
                    <div className="admin-link-reveal" role="group" aria-label="New private link">
                      <p className="admin-note">
                        <strong>Copy this now — we only show it once.</strong>
                      </p>
                      <input aria-label="Private link" readOnly value={freshLink.link} />
                      <button type="button" onClick={() => void copyFreshLink()}>
                        Copy private link
                      </button>
                    </div>
                  )}
                </div>
                {!revoked && (
                  <div>
                    <label>
                      <span className="admin-control-label">Which stand can this link update?</span>
                      <select
                        value={
                          standChoice[row.authorizationId] ??
                          row.liveLinkStand?.salesLocationId ??
                          (row.stands.length === 1
                            ? row.stands[0]?.salesLocationId ?? ""
                            : "")
                        }
                        onChange={(event) =>
                          setStandChoice((current) => ({
                            ...current,
                            [row.authorizationId]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Choose a stand…</option>
                        {row.stands.map((stand) => (
                          <option key={stand.salesLocationId} value={stand.salesLocationId}>
                            {stand.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy === row.authorizationId}
                      onClick={() => void issueLink(row)}
                    >
                      {row.hasLiveLink ? "Replace link" : "Create link"}
                    </button>
                    <button
                      type="button"
                      disabled={busy === row.authorizationId}
                      onClick={() => void revoke(row.authorizationId)}
                    >
                      {busy === row.authorizationId ? "Saving…" : "Remove access"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
