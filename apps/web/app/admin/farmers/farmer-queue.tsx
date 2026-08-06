"use client";

import { useState } from "react";
import { AdminRecoveryError } from "../admin-shell";
import { copyText } from "../../../lib/copy-text";
import {
  buildInviteDeliveryUrl,
  inviteMessage,
  normalizeInvitePhone,
  type FarmerInviteChannel,
} from "../../../lib/farmer-invite";

// The farmer access queue's interactive half (F-040). It renders what the server already
// decided the viewer may see and posts decisions back to `/api/admin/farmers`, which
// re-checks authority server-side — this component's state is convenience, never
// authorization.
//
// **No phone number or hash is ever in this component.** A pending request is identified by
// its opaque `requestId`, and the server resolves the phone behind it at the moment VIGA
// authorizes. The operator sees a masked number and nothing else, so the one lookup key for
// a person's phone never reaches a page, a history entry, or a referrer.

/**
 * The farm select's "create one" option (F-067).
 *
 * A sentinel rather than the empty string, which used to mean "assign later". That distinction
 * matters now: an empty value posts no farm at all, and an invitation naming no farm authorizes
 * nothing when redeemed. Naming it here is what lets a brand-new farmer be set up by their own
 * redemption. It cannot collide with a farm id, which is always a UUID.
 */
const NEW_FARM = "new-farm";

export interface PendingRequestRow {
  requestId: string;
  /** The last four digits, already masked by the server. Never the number. */
  senderMask: string;
  requestedAt: string;
  farmId?: string | null;
  farmName?: string | null;
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

/** A farm nobody can publish for yet, and the state of its most recent invitation (F-071). */
export interface AwaitingOnboardingRow {
  farmId: string;
  farmName: string;
  invitationState: "none" | "open" | "expired";
  invitationExpiresAt: string | null;
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
  awaitingOnboarding = [],
}: {
  requests: PendingRequestRow[];
  authorizations: AuthorizationRow[];
  farms: FarmOption[];
  awaitingOnboarding?: AwaitingOnboardingRow[];
}) {
  const [pendingRequests, setPendingRequests] = useState(requests);
  const [rows, setRows] = useState(authorizations);
  const [farmChoice, setFarmChoice] = useState<Record<string, string>>({});
  const [inviteFarmId, setInviteFarmId] = useState(NEW_FARM);
  const [newFarmName, setNewFarmName] = useState("");
  const [inviteChannel, setInviteChannel] = useState<FarmerInviteChannel>("sms");
  const [inviteDestination, setInviteDestination] = useState("");
  const [invite, setInvite] = useState<{
    link: string;
    /** Absent when the invite was minted from the waiting list, where no address was typed. */
    deliveryUrl?: string;
    channel: FarmerInviteChannel;
    message: string;
    farmName: string | null;
  } | null>(null);
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
  const [replacingLink, setReplacingLink] = useState<string | null>(null);

  async function post(
    body: Record<string, unknown>,
    key: string,
  ): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
    setBusy(key);
    setError(null);
    setSessionExpired(false);
    setSuccess(null);
    setInvite(null);
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
    const farmId = farmChoice[requestId] ?? pendingRequests.find(
      (request) => request.requestId === requestId,
    )?.farmId ?? "";
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

  async function createInvite() {
    const destination =
      inviteChannel === "sms"
        ? normalizeInvitePhone(inviteDestination)
        : inviteDestination.trim();
    if (
      destination === null ||
      destination === "" ||
      (inviteChannel === "email" && !/^\S+@\S+\.\S+$/.test(destination))
    ) {
      setError(
        inviteChannel === "sms"
          ? "Enter a valid US or Canada phone number."
          : "Enter a valid email address.",
      );
      return;
    }

    const creatingFarm = inviteFarmId === NEW_FARM;
    if (creatingFarm && newFarmName.trim() === "") {
      setError("Name the new farm before preparing the invite.");
      return;
    }

    await mintInvite(
      creatingFarm
        ? { newFarmName: newFarmName.trim() }
        : { farmId: inviteFarmId },
      inviteChannel,
      destination,
      "create_invite",
    );
  }

  /**
   * Mint an invitation and show the ready panel. One writer for both the invite form and the
   * "new onboarding link" button on a waiting farm (F-071), because they are the same act —
   * the second is not a recovery of the first, it is another invitation for the same farm.
   *
   * `destination` may be null: re-issuing from the waiting list has no address typed into it,
   * so there is no pre-filled message to open, only a link to copy.
   */
  async function mintInvite(
    farm: { farmId: string } | { newFarmName: string },
    channel: FarmerInviteChannel,
    destination: string | null,
    key: string,
  ) {
    const { ok, payload } = await post(
      { action: "create_invite", ...farm, channel },
      key,
    );
    if (!ok) return;
    if (
      typeof payload.link !== "string" ||
      (payload.farmName !== null && typeof payload.farmName !== "string") ||
      (payload.channel !== "sms" && payload.channel !== "email")
    ) {
      setError("The invitation was created without a usable link. Reload and try again.");
      return;
    }
    const message = inviteMessage({ farmName: payload.farmName, link: payload.link });
    setInvite({
      link: payload.link,
      ...(destination === null
        ? {}
        : { deliveryUrl: buildInviteDeliveryUrl(payload.channel, destination, message) }),
      channel: payload.channel,
      message,
      farmName: payload.farmName,
    });
    // The ready panel is the success state. Keeping a second banner above the form makes
    // the operator scan two places for the same result.
    setSuccess(null);
  }

  async function copyInviteLink() {
    if (invite === null) return;
    if (await copyText(invite.link)) {
      setSuccess("Onboarding link copied.");
      return;
    }
    setError("Copy failed. Select the onboarding link and copy it before leaving this page.");
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
    setReplacingLink(null);
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
    if (await copyText(freshLink.link)) {
      setSuccess("Private link copied.");
      return;
    }
    setError("Copy failed. Select the private link and copy it before leaving this page.");
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

      <section className="admin-invite-card" aria-labelledby="invite-farmer-heading">
        <div className="admin-invite-card-header">
          <div>
            <h3 id="invite-farmer-heading">Invite a farmer to join</h3>
          </div>
        </div>
        <form
          className="admin-invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createInvite();
          }}
        >
          <fieldset className="admin-invite-step admin-invite-step--contact">
            <legend>
              <span>Contact</span>
            </legend>
            <div className="admin-channel-options">
              <label className="admin-channel-option">
                <input
                  aria-label="Text message"
                  type="radio"
                  name="invite-channel"
                  value="sms"
                  checked={inviteChannel === "sms"}
                  onChange={() => setInviteChannel("sms")}
                />
                <span className="admin-channel-option-copy">
                  <strong>Text message</strong>
                </span>
              </label>
              <label className="admin-channel-option">
                <input
                  aria-label="Email"
                  type="radio"
                  name="invite-channel"
                  value="email"
                  checked={inviteChannel === "email"}
                  onChange={() => setInviteChannel("email")}
                />
                <span className="admin-channel-option-copy">
                  <strong>Email</strong>
                </span>
              </label>
            </div>
            <label className="admin-field">
              <span className="admin-control-label">
                {inviteChannel === "sms" ? "Phone number" : "Email address"}
              </span>
              <input
                type={inviteChannel === "sms" ? "tel" : "email"}
                inputMode={inviteChannel === "sms" ? "tel" : "email"}
                autoComplete={inviteChannel === "sms" ? "tel" : "email"}
                value={inviteDestination}
                onChange={(event) => setInviteDestination(event.target.value)}
                placeholder={inviteChannel === "sms" ? "(206) 555-0123" : "farmer@example.com"}
              />
            </label>
          </fieldset>

          <fieldset className="admin-invite-step admin-invite-step--farm">
            <legend>
              <span>Farm</span>
              <span className="admin-optional">Optional</span>
            </legend>
            <label className="admin-field">
              <span className="sr-only">Farm</span>
              <select
                value={inviteFarmId}
                onChange={(event) => setInviteFarmId(event.target.value)}
              >
                {/*
                  F-067 — the farm is named HERE, not assigned later. An invitation naming no
                  farm authorizes nothing when the farmer redeems it, which puts them straight
                  back into the queue this work removes.
                */}
                <option value={NEW_FARM}>New farm</option>
                {farms.map((farm) => (
                  <option key={farm.farmId} value={farm.farmId}>
                    {farm.name}
                  </option>
                ))}
              </select>
            </label>
            {inviteFarmId === NEW_FARM && (
              <label className="admin-field">
                <span className="admin-control-label">New farm name</span>
                <input
                  value={newFarmName}
                  onChange={(event) => setNewFarmName(event.target.value)}
                  placeholder="Misty Hollow Farm"
                />
              </label>
            )}
          </fieldset>

          <div className="admin-invite-actions">
            <button
              className="admin-action-primary"
              type="submit"
              aria-busy={busy === "create_invite"}
              disabled={busy === "create_invite"}
            >
              {busy === "create_invite" ? "Preparing invite…" : "Prepare invite"}
            </button>
          </div>
        </form>
        {invite !== null && (
          <div className="admin-invite-result" role="status" aria-labelledby="invite-ready-heading">
            <div className="admin-invite-result-heading">
              <h4 id="invite-ready-heading">Your invite is ready</h4>
              <p className="admin-note">
                {invite.farmName === null
                  ? "No farm attached — you will assign it from the waiting list."
                  : `For ${invite.farmName}.`}
              </p>
            </div>
            <div className="admin-invite-result-actions">
              {invite.deliveryUrl !== undefined && (
                <a className="admin-action-primary" href={invite.deliveryUrl}>
                  Open {invite.channel === "sms" ? "text message" : "email"}
                </a>
              )}
              <button className="admin-action-secondary" type="button" onClick={() => void copyInviteLink()}>
                Copy link
              </button>
            </div>
            <details className="admin-disclosure">
              <summary>Review invite details</summary>
              <div className="admin-disclosure-content">
                <label className="admin-field">
                  <span className="admin-control-label">Onboarding link</span>
                  <input readOnly value={invite.link} />
                </label>
                <p className="admin-note">Message preview: {invite.message}</p>
              </div>
            </details>
          </div>
        )}
      </section>

      <section className="admin-queue-group" aria-labelledby="awaiting-onboarding-heading">
        <div className="admin-group-heading">
          <div>
            <h3 id="awaiting-onboarding-heading">Farms with no one to update them</h3>
          </div>
          <span
            className="admin-count"
            aria-label={`${awaitingOnboarding.length} farms with no one to update them`}
          >
            {awaitingOnboarding.length}
          </span>
        </div>
        {awaitingOnboarding.length === 0 ? (
          <p className="admin-empty-state">Every farm has someone who can update it.</p>
        ) : (
          <>
            {/*
              The link a farmer was originally sent CANNOT be shown again — it is stored
              scrambled and shown once, the same way a site sends a password reset rather than
              your old password. So the offer here is a new link, and the copy says which it is
              rather than letting an operator believe they are retrieving the old one.
            */}
            <p className="admin-note">
              Nobody can publish updates for these farms yet. A new link replaces any earlier
              one; earlier links cannot be looked up.
            </p>
            <ul className="admin-farms">
              {awaitingOnboarding.map((row) => (
                <li key={row.farmId} className="admin-farm admin-request-card">
                  <div className="admin-card-person">
                    <h4>{row.farmName}</h4>
                    <p className="admin-note">
                      {row.invitationState === "none"
                        ? "Never invited"
                        : row.invitationState === "open"
                          ? `Link expires ${formatDate(row.invitationExpiresAt as string)}`
                          : `Link expired ${formatDate(row.invitationExpiresAt as string)}`}
                    </p>
                  </div>
                  <div className="admin-request-decision">
                    <button
                      className="admin-action-primary"
                      type="button"
                      aria-label={`New onboarding link for ${row.farmName}`}
                      disabled={busy === `reinvite-${row.farmId}`}
                      onClick={() =>
                        void mintInvite(
                          { farmId: row.farmId },
                          "sms",
                          null,
                          `reinvite-${row.farmId}`,
                        )
                      }
                    >
                      {busy === `reinvite-${row.farmId}`
                        ? "Preparing…"
                        : "New onboarding link"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="admin-queue-group" aria-labelledby="waiting-heading">
        <div className="admin-group-heading">
          <div>
            <h3 id="waiting-heading">Waiting for your decision</h3>
          </div>
          <span className="admin-count" aria-label={`${pendingRequests.length} waiting`}>
            {pendingRequests.length}
          </span>
        </div>
        {pendingRequests.length === 0 ? (
          <p className="admin-empty-state">No requests.</p>
        ) : (
          <ul className="admin-farms">
            {pendingRequests.map((request) => (
              <li key={request.requestId} className="admin-farm admin-request-card">
                <div className="admin-card-person">
                  <h4>{request.senderMask}</h4>
                  <p className="admin-note">Asked {formatDate(request.requestedAt)}</p>
                </div>
                <div className="admin-request-decision">
                  {request.farmName !== null && request.farmName !== undefined ? (
                    <div className="admin-request-farm">
                      <span className="admin-control-label">Invited to</span>
                      <strong>{request.farmName}</strong>
                    </div>
                  ) : (
                    <label className="admin-field">
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
                  )}
                  <button
                    className="admin-action-primary"
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
      </section>

      <section className="admin-queue-group" aria-labelledby="current-access-heading">
        <div className="admin-group-heading">
          <div>
            <h3 id="current-access-heading">People with farmer access</h3>
          </div>
          <span className="admin-count" aria-label={`${rows.length} people with farmer access`}>
            {rows.length}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="admin-empty-state">No one has farmer access yet.</p>
        ) : (
          <ul className="admin-farms">
            {rows.map((row) => {
              const revoked = row.revokedAt !== null;
              return (
                <li key={row.authorizationId} className="admin-farm admin-access-card">
                  <div className="admin-card-person">
                    <h4>{row.farmName}</h4>
                    <p className={revoked ? "admin-unapproved" : "admin-approved"}>
                      {row.senderMask} ·{" "}
                      {revoked
                        ? `Revoked ${formatDate(row.revokedAt as string)}`
                        : `Authorized ${formatDate(row.authorizedAt)}`}
                    </p>
                    {!revoked ? (
                      <p className="admin-note">
                        {row.hasLiveLink && row.liveLinkStand !== null
                          ? `Private link: ${row.liveLinkStand.name}`
                          : "No private link"}
                      </p>
                    ) : null}
                    {freshLink?.id === row.authorizationId && (
                      <div className="admin-link-reveal" role="group" aria-label="New private link">
                        <p className="admin-note">
                          <strong>Copy this now — we only show it once.</strong>
                        </p>
                        <input aria-label="Private link" readOnly value={freshLink.link} />
                        <button className="admin-action-secondary" type="button" onClick={() => void copyFreshLink()}>
                          Copy private link
                        </button>
                      </div>
                    )}
                  </div>
                  {!revoked && (
                    <div className="admin-access-actions">
                      <label className="admin-field">
                        <span className="admin-control-label">Stand this link can update</span>
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
                      <div className="admin-button-row">
                        <button
                          className="admin-action-primary"
                          type="button"
                          disabled={busy === row.authorizationId}
                          onClick={() => row.hasLiveLink ? setReplacingLink(row.authorizationId) : void issueLink(row)}
                        >
                          {row.hasLiveLink ? "Replace link" : "Create link"}
                        </button>
                        <button
                          className="admin-action-danger"
                          type="button"
                          disabled={busy === row.authorizationId}
                          onClick={() => void revoke(row.authorizationId)}
                        >
                          {busy === row.authorizationId ? "Saving…" : "Remove access"}
                        </button>
                      </div>
                      {replacingLink === row.authorizationId && (
                        <div className="admin-inline-confirm" role="group" aria-label={`Replace private link for ${row.farmName}`}>
                          <p>Create a new private link? The old link will stop working.</p>
                          <button
                            className="admin-action-primary"
                            type="button"
                            disabled={busy === row.authorizationId}
                            onClick={() => void issueLink(row)}
                          >
                            {busy === row.authorizationId ? "Saving…" : "Create new private link"}
                          </button>
                          <button
                            className="admin-action-secondary"
                            type="button"
                            disabled={busy === row.authorizationId}
                            onClick={() => setReplacingLink(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
