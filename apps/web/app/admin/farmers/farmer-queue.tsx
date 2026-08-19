"use client";

import { useState } from "react";
import { AdminRefusal, refusalFromResponse, type AdminRefusalKind } from "../admin-shell";
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
  sellers,
}: {
  requests: PendingRequestRow[];
  sellers: FarmOption[];
}) {
  const [pendingRequests, setPendingRequests] = useState(requests);
  const [farmChoice, setFarmChoice] = useState<Record<string, string>>({});
  const [inviteSellerId, setInviteFarmId] = useState(NEW_FARM);
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<AdminRefusalKind | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function post(
    body: Record<string, unknown>,
    key: string,
  ): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
    setBusy(key);
    setError(null);
    setRefusal(null);
    setSuccess(null);
    // Deliberately does NOT clear `invite`. Clearing transient banners on a new request is
    // right; clearing a rendered credential is not. A minted onboarding link cannot be read
    // back from the server, so an unrelated later action — authorizing someone, minting a
    // second invite — used to destroy the only copy of it with no warning. `mintInvite`
    // replaces it, because that is the one act that supersedes it.
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
        const refused = await refusalFromResponse(response.clone());
        if (refused !== null) setRefusal(refused);
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
    const farmName =
      sellers.find((farm) => farm.farmId === farmId)?.name ?? "their farm";
    setPendingRequests((current) =>
      current.filter((request) => request.requestId !== requestId),
    );
    // Names where the record now lives rather than telling the operator to reload. The row
    // vanishing from this list with no destination named read as "the thing disappeared".
    setSuccess(
      `Access given. They can now update ${farmName} — see it on the Farms tab.`,
    );
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

    const creatingFarm = inviteSellerId === NEW_FARM;
    if (creatingFarm && newFarmName.trim() === "") {
      setError("Name the new farm before preparing the invite.");
      return;
    }

    await mintInvite(
      creatingFarm
        ? { newFarmName: newFarmName.trim() }
        : { farmId: inviteSellerId },
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
                value={inviteSellerId}
                onChange={(event) => setInviteFarmId(event.target.value)}
              >
                {/*
                  F-067 — the farm is named HERE, not assigned later. An invitation naming no
                  farm authorizes nothing when the farmer redeems it, which puts them straight
                  back into the queue this work removes.
                */}
                <option value={NEW_FARM}>New farm</option>
                {sellers.map((farm) => (
                  <option key={farm.farmId} value={farm.farmId}>
                    {farm.name}
                  </option>
                ))}
              </select>
            </label>
            {inviteSellerId === NEW_FARM && (
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
                Copy setup link
              </button>
            </div>
            {/*
              The link itself is always on screen, not behind a disclosure. It is shown once
              and cannot be looked up again, and the copy-failure message tells the operator
              to select it by hand — advice that pointed at a collapsed panel. A credential
              the operator may need to read is not a detail to review.
            */}
            <label className="admin-field">
              <span className="admin-control-label">Setup link — expires in 7 days</span>
              <input readOnly value={invite.link} />
            </label>
            <details className="admin-disclosure">
              <summary>See the message we prepared</summary>
              <div className="admin-disclosure-content">
                <p className="admin-note">{invite.message}</p>
              </div>
            </details>
          </div>
        )}
      </section>

      <section className="admin-queue-group" aria-labelledby="waiting-heading">
        <div className="admin-group-heading">
          <div>
            <h3 id="waiting-heading">Open invites</h3>
          </div>
          <span className="admin-count" aria-label={`${pendingRequests.length} open`}>
            {pendingRequests.length}
          </span>
        </div>
        {pendingRequests.length === 0 ? (
          <p className="admin-empty-state">
            No invites are open.
          </p>
        ) : (
          <ul className="admin-sellers">
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
                        {sellers.map((farm) => (
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
    </>
  );
}
