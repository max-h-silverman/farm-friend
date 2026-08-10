"use client";

import { useState } from "react";
import { AdminRecoveryError } from "./admin-shell";
import { copyText } from "../../lib/copy-text";
import { StandDetails, type AdminStandCard } from "./stand-list";

/**
 * One farm, and everything VIGA can do about it.
 *
 * This replaces six separate presentations of the same entity — the approval queue, the stand
 * index, the test-farm toggle, the "farms with no one to update them" list, the farmer-access
 * roster, and the invite form's farm dropdown — each of which lived on its own screen with its
 * own vocabulary. An operator asking "what is going on with Misty Hollow Farm?" had to visit
 * four lists and cross-reference them by name.
 *
 * The organizing rule: **the card that owns the farm owns every result about the farm.** A
 * link minted here appears here; a decision recorded here reports here. Nothing an operator
 * starts on this card finishes somewhere else on the page, which is the failure that made the
 * old screens feel like "did that work? where did it go?".
 *
 * Every mutation still posts to a guarded route that re-checks authority server-side; this
 * component's state is convenience, never authorization. No phone number reaches it — the
 * server masks at the query boundary and hands down `senderMask` only.
 */

export interface FarmAccessRow {
  authorizationId: string;
  senderMask: string;
  authorizedAt: string;
  revokedAt: string | null;
  stands: Array<{ salesLocationId: string; name: string }>;
  hasLiveLink: boolean;
  liveLinkStand: { salesLocationId: string; name: string } | null;
}

export interface AdminFarmCard {
  farmId: string;
  name: string;
  description: string | null;
  approved: boolean;
  approvedAt: string | null;
  approvedByEmail: string | null;
  isTestFarm: boolean;
  retired: boolean;
  /** Nobody can publish for this farm yet, and the state of its most recent invitation. */
  invitationState: "none" | "open" | "expired" | "not_applicable";
  invitationExpiresAt: string | null;
  access: FarmAccessRow[];
  stands: AdminStandCard[];
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * What this farm needs from an operator right now, in one phrase, or null when it needs
 * nothing. Shown on the collapsed summary so a long list can be scanned without opening
 * every card — the question "which of these needs me?" is the one an operator arrives with.
 */
function needsAttention(farm: AdminFarmCard): string | null {
  if (farm.retired) return null;
  if (!farm.approved) return "Waiting for approval";
  if (farm.access.every((row) => row.revokedAt !== null)) {
    if (farm.invitationState === "expired") return "Setup link expired";
    if (farm.invitationState === "none") return "Nobody can update it";
    if (farm.invitationState === "open") return "Waiting for the farmer";
  }
  return null;
}

export function FarmList({ farms }: { farms: AdminFarmCard[] }) {
  const [rows, setRows] = useState(farms);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  /**
   * Keyed by farm, and rendered inside the card it belongs to — never once at the top of the
   * page. A message about the thirtieth farm shown above the first one is a message the
   * operator does not see.
   */
  const [note, setNote] = useState<Record<string, { kind: "ok" | "bad"; text: string }>>({});
  const [editing, setEditing] = useState<Record<string, { name: string; description: string }>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  /**
   * A freshly minted setup link, held only in this component's state and only until the
   * operator navigates away. It is never re-readable from the server, which is correct for a
   * standing credential — so it renders on the farm's own card, with the copy saying so.
   */
  const [freshLink, setFreshLink] = useState<Record<string, string>>({});

  function say(farmId: string, kind: "ok" | "bad", text: string) {
    setNote((current) => ({ ...current, [farmId]: { kind, text } }));
  }

  async function post(
    farmId: string,
    body: Record<string, unknown>,
    endpoint = "/api/admin/farms",
  ): Promise<Record<string, unknown> | null> {
    setBusy(farmId);
    setSessionExpired(false);
    setNote((current) => {
      const next = { ...current };
      delete next[farmId];
      return next;
    });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 403) setSessionExpired(true);
        else if (response.status === 422) {
          say(farmId, "bad", "A farm needs a name.");
        } else say(farmId, "bad", "That did not save. Try again.");
        return null;
      }
      return payload;
    } catch {
      say(farmId, "bad", "That did not save. Try again.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function setApproved(farm: AdminFarmCard, approved: boolean) {
    const payload = await post(farm.farmId, {
      farmId: farm.farmId,
      action: approved ? "approve" : "revoke",
    });
    if (payload === null) return;
    setRows((current) =>
      current.map((row) => (row.farmId === farm.farmId ? { ...row, approved } : row)),
    );
    say(
      farm.farmId,
      "ok",
      approved
        ? "Approved. This farmer can publish updates."
        : "Approval removed. This farmer can no longer publish updates.",
    );
  }

  async function setRetired(farm: AdminFarmCard, retired: boolean) {
    const payload = await post(farm.farmId, {
      farmId: farm.farmId,
      action: retired ? "retire" : "restore",
    });
    setConfirming(null);
    if (payload === null) return;
    setRows((current) =>
      current.map((row) =>
        row.farmId === farm.farmId
          ? {
              ...row,
              retired,
              // The nested stands must move with the farm, or the card contradicts itself:
              // "Removed" at the top while every stand below still reads "Visible to
              // customers". A stand carrying its OWN retirement keeps it — that decision was
              // not this one's to reverse, which is the same rule the writer enforces.
              stands: row.stands.map((stand) =>
                stand.retiredWithFarm || !stand.retired
                  ? { ...stand, retired, retiredWithFarm: retired }
                  : stand,
              ),
            }
          : row,
      ),
    );
    say(
      farm.farmId,
      "ok",
      retired
        ? "Removed. Customers no longer see this farm or its stands. Everything it published is kept."
        : "Back on the map. Any stand you removed on its own is still off.",
    );
  }

  async function saveDetails(farm: AdminFarmCard) {
    const draft = editing[farm.farmId];
    if (draft === undefined) return;
    const payload = await post(farm.farmId, {
      farmId: farm.farmId,
      action: "save_details",
      name: draft.name,
      description: draft.description.trim() === "" ? null : draft.description,
    });
    if (payload === null) return;
    setRows((current) =>
      current.map((row) =>
        row.farmId === farm.farmId
          ? {
              ...row,
              name: draft.name.trim(),
              description: draft.description.trim() === "" ? null : draft.description.trim(),
            }
          : row,
      ),
    );
    setEditing((current) => {
      const next = { ...current };
      delete next[farm.farmId];
      return next;
    });
    say(farm.farmId, "ok", "Saved.");
  }

  async function setTestFarm(farm: AdminFarmCard, isTestFarm: boolean) {
    const payload = await post(farm.farmId, {
      farmId: farm.farmId,
      action: isTestFarm ? "mark_test" : "unmark_test",
    });
    if (payload === null) return;
    setRows((current) =>
      current.map((row) => (row.farmId === farm.farmId ? { ...row, isTestFarm } : row)),
    );
    say(
      farm.farmId,
      "ok",
      isTestFarm
        ? "Marked as a test farm. Customers will not see it."
        : "No longer a test farm. Customers can see it.",
    );
  }

  /**
   * Mint a setup link for this farm, and show it ON THIS CARD.
   *
   * The old screen rendered the result up in a separate "Invite a farmer" panel, so the
   * operator pressed a button on one farm and the only copy of an unrecoverable link appeared
   * somewhere else entirely.
   */
  async function createSetupLink(farm: AdminFarmCard) {
    const payload = await post(
      farm.farmId,
      { action: "create_invite", farmId: farm.farmId, channel: "sms" },
      "/api/admin/farmers",
    );
    if (payload === null) return;
    if (typeof payload.link !== "string") {
      say(farm.farmId, "bad", "That link was not created. Try again.");
      return;
    }
    const link = payload.link;
    setFreshLink((current) => ({ ...current, [farm.farmId]: link }));
    setRows((current) =>
      current.map((row) =>
        row.farmId === farm.farmId
          ? { ...row, invitationState: "open" as const }
          : row,
      ),
    );
    // Copying is the point of the button, so it happens without a second press. The copy
    // below still shows the link itself, because a clipboard write can silently fail.
    if (await copyText(link)) {
      say(farm.farmId, "ok", "New setup link copied. It is shown below — we only show it once.");
      return;
    }
    say(farm.farmId, "bad", "Link created, but copying failed. Copy it from the box below before you leave.");
  }

  async function revokeAccess(farm: AdminFarmCard, authorizationId: string) {
    const payload = await post(
      farm.farmId,
      { action: "revoke", authorizationId },
      "/api/admin/farmers",
    );
    if (payload === null) return;
    setRows((current) =>
      current.map((row) =>
        row.farmId === farm.farmId
          ? {
              ...row,
              access: row.access.map((entry) =>
                entry.authorizationId === authorizationId
                  ? {
                      ...entry,
                      revokedAt: new Date().toISOString(),
                      hasLiveLink: false,
                      liveLinkStand: null,
                    }
                  : entry,
              ),
            }
          : row,
      ),
    );
    say(farm.farmId, "ok", "Access removed. Their update link no longer works.");
  }

  const needle = filter.trim().toLowerCase();
  const visible =
    needle === ""
      ? rows
      : rows.filter(
          (farm) =>
            farm.name.toLowerCase().includes(needle) ||
            farm.stands.some((stand) => stand.name.toLowerCase().includes(needle)),
        );

  return (
    <>
      {sessionExpired && (
        <AdminRecoveryError>Your session expired before that was saved.</AdminRecoveryError>
      )}

      <div className="admin-directory-toolbar">
        <label className="admin-field">
          <span className="admin-control-label">Find a farm or stand</span>
          <input
            type="search"
            value={filter}
            placeholder="Start typing a name…"
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="admin-empty-state">
          {rows.length === 0 ? "No farms yet." : "No farms match what you typed."}
        </p>
      ) : (
        <ul className="admin-farms">
          {visible.map((farm) => {
            const attention = needsAttention(farm);
            const draft = editing[farm.farmId];
            const rowNote = note[farm.farmId];
            const live = farm.access.filter((row) => row.revokedAt === null);
            return (
              <li key={farm.farmId} className="admin-farm admin-farm-card">
                <details>
                  {/*
                    The scan row. Four columns, each answering one question an operator arrives
                    with: which farm, how big, who runs it, does it need me. The disclosure
                    caret and the farm glyph occupy fixed leading columns so every row's name
                    starts at the same x — a ragged left edge is what makes a long list read as
                    a pile rather than a table.
                  */}
                  <summary className="admin-row">
                    <span className="admin-row-caret" aria-hidden="true" />
                    <span className="admin-row-glyph" aria-hidden="true">
                      {/* A barn, not a generic box: it names the row's subject at a glance. */}
                      <svg viewBox="0 0 24 24" width="18" height="18" role="presentation">
                        <path
                          d="M3 10.2 12 5l9 5.2V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M9 21v-6h6v6M3.5 13.5h17"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <span className="admin-row-identity">
                      <strong>{farm.name}</strong>
                      <span className="admin-row-sub">
                        {farm.stands.length === 1
                          ? "1 stand"
                          : `${farm.stands.length} stands`}
                      </span>
                    </span>
                    <span className="admin-row-meta">
                      {live.length === 0
                        ? "No farmer yet"
                        : live.length === 1
                          ? `Updated by ${live[0]?.senderMask}`
                          : `${live.length} people can update`}
                    </span>
                    <span className="admin-row-states" aria-label={`State for ${farm.name}`}>
                      {farm.retired ? (
                        <span className="admin-pill admin-pill--muted">Removed</span>
                      ) : (
                        <>
                          {attention !== null && (
                            <span className="admin-pill admin-pill--attention">{attention}</span>
                          )}
                          {farm.approved && attention === null && (
                            <span className="admin-pill admin-pill--ok">Approved</span>
                          )}
                          {farm.isTestFarm && (
                            <span className="admin-pill admin-pill--muted">Test farm</span>
                          )}
                        </>
                      )}
                    </span>
                  </summary>

                  <div className="admin-stand-detail-groups">
                    {rowNote !== undefined && (
                      <p
                        className={rowNote.kind === "ok" ? "admin-success" : "admin-error"}
                        role={rowNote.kind === "ok" ? "status" : "alert"}
                      >
                        {rowNote.text}
                      </p>
                    )}

                    {freshLink[farm.farmId] !== undefined && (
                      <div className="admin-link-reveal" role="group" aria-label={`New setup link for ${farm.name}`}>
                        <p className="admin-note">
                          <strong>Copy this now — we only show it once.</strong> Send it to the
                          farmer. It lets them set up their listing and expires in 7 days.
                        </p>
                        <input aria-label="Setup link" readOnly value={freshLink[farm.farmId]} />
                      </div>
                    )}

                    <section className="admin-stand-detail-section" aria-label={`Details for ${farm.name}`}>
                      <h3>Farm details</h3>
                      {draft === undefined ? (
                        <>
                          <dl>
                            <div>
                              <dt>Name</dt>
                              <dd>{farm.name}</dd>
                            </div>
                            <div>
                              <dt>Description</dt>
                              <dd>{farm.description ?? "Not stated"}</dd>
                            </div>
                            <div>
                              <dt>Approval</dt>
                              <dd>
                                {farm.approved
                                  ? `Approved${farm.approvedAt === null ? "" : ` ${formatDate(farm.approvedAt)}`}${farm.approvedByEmail === null ? "" : ` by ${farm.approvedByEmail}`}`
                                  : "Not approved — this farmer cannot publish updates"}
                              </dd>
                            </div>
                          </dl>
                          <div className="admin-button-row">
                            <button
                              className="admin-action-secondary"
                              type="button"
                              onClick={() =>
                                setEditing((current) => ({
                                  ...current,
                                  [farm.farmId]: {
                                    name: farm.name,
                                    description: farm.description ?? "",
                                  },
                                }))
                              }
                            >
                              Edit details
                            </button>
                            <button
                              className={farm.approved ? "admin-action-secondary" : "admin-action-primary"}
                              type="button"
                              disabled={busy === farm.farmId}
                              onClick={() => void setApproved(farm, !farm.approved)}
                            >
                              {farm.approved ? "Remove approval" : "Approve farm"}
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="admin-decision-panel" role="group" aria-label={`Edit ${farm.name}`}>
                          <label className="admin-field">
                            <span className="admin-control-label">Farm name</span>
                            <input
                              aria-label={`Farm name for ${farm.name}`}
                              value={draft.name}
                              onChange={(event) =>
                                setEditing((current) => ({
                                  ...current,
                                  [farm.farmId]: { ...draft, name: event.target.value },
                                }))
                              }
                            />
                          </label>
                          <label className="admin-field">
                            <span className="admin-control-label">Description</span>
                            <textarea
                              aria-label={`Description for ${farm.name}`}
                              rows={3}
                              value={draft.description}
                              onChange={(event) =>
                                setEditing((current) => ({
                                  ...current,
                                  [farm.farmId]: { ...draft, description: event.target.value },
                                }))
                              }
                            />
                          </label>
                          <p className="admin-note">
                            This is VIGA’s own record of the farm. What a stand has and when it
                            is open is the farmer’s to change, not yours.
                          </p>
                          <div className="admin-button-row">
                            <button
                              className="admin-action-primary"
                              type="button"
                              disabled={busy === farm.farmId}
                              onClick={() => void saveDetails(farm)}
                            >
                              {busy === farm.farmId ? "Saving…" : "Save details"}
                            </button>
                            <button
                              className="admin-action-secondary"
                              type="button"
                              onClick={() =>
                                setEditing((current) => {
                                  const next = { ...current };
                                  delete next[farm.farmId];
                                  return next;
                                })
                              }
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </section>

                    <section className="admin-stand-detail-section" aria-label={`Who can update ${farm.name}`}>
                      <h3>Who can update this farm</h3>
                      {live.length === 0 ? (
                        <>
                          <p className="admin-note">
                            Nobody can publish updates for this farm yet.
                            {farm.invitationState === "open" &&
                              farm.invitationExpiresAt !== null &&
                              ` A setup link is out, expiring ${formatDate(farm.invitationExpiresAt)}.`}
                            {farm.invitationState === "expired" &&
                              farm.invitationExpiresAt !== null &&
                              ` The last setup link expired ${formatDate(farm.invitationExpiresAt)}.`}
                            {farm.invitationState === "none" && " No setup link has been sent."}
                          </p>
                          <p className="admin-note">
                            A new link replaces any earlier one. Earlier links cannot be looked up.
                          </p>
                          <button
                            className="admin-action-primary"
                            type="button"
                            aria-label={`New setup link for ${farm.name}`}
                            disabled={busy === farm.farmId}
                            onClick={() => void createSetupLink(farm)}
                          >
                            {busy === farm.farmId ? "Preparing…" : "New setup link"}
                          </button>
                        </>
                      ) : (
                        <ul className="admin-farms">
                          {live.map((row) => (
                            <li key={row.authorizationId} className="admin-access-card">
                              <div className="admin-card-person">
                                <strong>{row.senderMask}</strong>
                                <p className="admin-approved">
                                  Can update since {formatDate(row.authorizedAt)}
                                </p>
                                <p className="admin-note">
                                  {row.hasLiveLink && row.liveLinkStand !== null
                                    ? `Has an update link for ${row.liveLinkStand.name}`
                                    : "No update link"}
                                </p>
                              </div>
                              <button
                                className="admin-action-danger"
                                type="button"
                                disabled={busy === farm.farmId}
                                onClick={() => void revokeAccess(farm, row.authorizationId)}
                              >
                                Remove access
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    {/*
                      The stands are the only thing on this card a customer ever sees, so they
                      get the card's one filled group. Everything else here is VIGA's own
                      bookkeeping about the farm.
                    */}
                    <section
                      className="admin-stand-detail-section admin-stand-detail-section--stands"
                      aria-label={`Stands at ${farm.name}`}
                    >
                      <h3>
                        {farm.stands.length === 1 ? "1 stand" : `${farm.stands.length} stands`}
                      </h3>
                      {farm.stands.length === 0 ? (
                        <p className="admin-note">This farm has no stands.</p>
                      ) : (
                        // Keyed on the farm's retirement so a take-down remounts the list.
                        // `StandDetails` snapshots its prop into state (it owns per-stand
                        // saves), so without this the stands keep rendering the state they
                        // had when the card opened while the farm above them says "Removed".
                        <StandDetails
                          key={`${farm.farmId}-${farm.retired}`}
                          stands={farm.stands}
                        />
                      )}
                    </section>

                    <section className="admin-stand-detail-section admin-stand-retirement" aria-label={`Remove ${farm.name}`}>
                      <h3>Remove this farm</h3>
                      <p className="admin-note">
                        {farm.retired
                          ? "Customers cannot see this farm or any of its stands. Everything it published is kept, and you can put it back."
                          : "Removes this farm and all its stands from the map and from text answers. Nothing it already published is deleted, and you can put it back."}
                      </p>
                      <div className="admin-button-row">
                        {farm.retired ? (
                          <button
                            className="admin-action-secondary"
                            type="button"
                            disabled={busy === farm.farmId}
                            onClick={() => void setRetired(farm, false)}
                          >
                            {busy === farm.farmId ? "Saving…" : "Put this farm back"}
                          </button>
                        ) : confirming === farm.farmId ? (
                          <div className="admin-inline-confirm" role="group" aria-label={`Remove ${farm.name}`}>
                            <p>
                              Remove {farm.name} and its{" "}
                              {farm.stands.length === 1 ? "stand" : `${farm.stands.length} stands`}?
                              Customers will stop seeing all of it.
                            </p>
                            <button
                              className="admin-action-danger"
                              type="button"
                              disabled={busy === farm.farmId}
                              onClick={() => void setRetired(farm, true)}
                            >
                              {busy === farm.farmId ? "Saving…" : "Yes, remove this farm"}
                            </button>
                            <button
                              className="admin-action-secondary"
                              type="button"
                              onClick={() => setConfirming(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            className="admin-action-danger"
                            type="button"
                            disabled={busy === farm.farmId}
                            onClick={() => setConfirming(farm.farmId)}
                          >
                            Remove this farm
                          </button>
                        )}
                        <button
                          className="admin-action-secondary"
                          type="button"
                          disabled={busy === farm.farmId}
                          onClick={() => void setTestFarm(farm, !farm.isTestFarm)}
                        >
                          {farm.isTestFarm ? "Not a test farm" : "Mark as test farm"}
                        </button>
                      </div>
                    </section>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
