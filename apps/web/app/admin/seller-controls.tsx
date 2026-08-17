"use client";

import { useState } from "react";
import { copyText } from "../../lib/copy-text";

/**
 * Everything VIGA does *about* a seller, on the seller's own card.
 *
 * These six controls used to live on a Farms screen. F-101 removed that screen: VIGA's job is
 * to view and edit stands and sellers (max, 2026-08-17), so approving a farm, taking it off the
 * map, correcting its name, marking it a test farm and minting its setup link are all things an
 * operator does *while looking at the seller* — not destinations of their own.
 *
 * **The card that owns the seller owns every result about the seller.** A link minted here
 * appears here; a decision recorded here reports here. Nothing an operator starts on this card
 * finishes somewhere else on the page — that was the failure that made the old screens feel
 * like "did that work? where did it go?".
 *
 * Every mutation posts to a guarded route that re-checks authority server-side. This
 * component's state is convenience, never authorization.
 */

export interface SellerControlsRow {
  farmId: string;
  name: string;
  description?: string | null;
  approved: boolean;
  retired: boolean;
  isTestFarm: boolean;
}

/**
 * A setup link hands the listing to a farmer who does not have it yet. Offering one to a farm
 * that already has a live authorization invites the operator to solve a problem that farm does
 * not have — so the control is ABSENT rather than disabled, and the copy explains the absence.
 */

export function SellerControls({
  seller,
  canUpdate,
  fetcher = fetch,
}: {
  seller: SellerControlsRow;
  /** Somebody can already publish for this seller. */
  canUpdate: boolean;
  fetcher?: typeof fetch;
}) {
  const [row, setRow] = useState(seller);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null);
  /**
   * A freshly minted setup link, held only in this component's state and only until the
   * operator navigates away. It is never re-readable from the server, which is correct for a
   * standing credential — so it renders on the seller's own card, with the copy saying so.
   */
  const [freshLink, setFreshLink] = useState<string | null>(null);

  async function post(
    body: Record<string, unknown>,
    endpoint = "/api/admin/sellers",
  ): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setNote({ kind: "bad", text: "That did not save. Try again." });
        return null;
      }
      return payload;
    } catch {
      setNote({ kind: "bad", text: "That did not save. Try again." });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function setApproved(approved: boolean) {
    const payload = await post({ farmId: row.farmId, action: approved ? "approve" : "revoke" });
    if (payload === null) return;
    setRow((current) => ({ ...current, approved }));
    setNote({
      kind: "ok",
      text: approved
        ? "Approved. This farmer can publish updates."
        : "Approval removed. This farmer can no longer publish updates.",
    });
  }

  async function setRetired(retired: boolean) {
    const payload = await post({ farmId: row.farmId, action: retired ? "retire" : "restore" });
    setConfirmingRetire(false);
    if (payload === null) return;
    setRow((current) => ({ ...current, retired }));
    setNote({
      kind: "ok",
      text: retired
        ? "Removed. Customers no longer see this farm or its stands. Everything it published is kept."
        : "Back on the map. Any stand you removed on its own is still off.",
    });
  }

  async function setTestFarm(isTestFarm: boolean) {
    const payload = await post({
      farmId: row.farmId,
      action: isTestFarm ? "mark_test" : "unmark_test",
    });
    if (payload === null) return;
    setRow((current) => ({ ...current, isTestFarm }));
    setNote({
      kind: "ok",
      text: isTestFarm
        ? "Marked as a test farm. Customers will not see it."
        : "No longer a test farm. Customers can see it.",
    });
  }

  async function saveDetails() {
    if (editing === null) return;
    const payload = await post({
      farmId: row.farmId,
      action: "save_details",
      name: editing.name,
      description: editing.description.trim() === "" ? null : editing.description,
    });
    if (payload === null) return;
    setRow((current) => ({
      ...current,
      name: editing.name.trim(),
      description: editing.description.trim() === "" ? null : editing.description.trim(),
    }));
    setEditing(null);
    setNote({ kind: "ok", text: "Saved." });
  }

  /**
   * Mint a setup link for this farm, and show it ON THIS CARD.
   *
   * **"Setup link", never "link"** (F-100). A volunteer could not tell the setup link from the
   * update link: both were called "link", both shown once, both saying "copy it now" — but one
   * expires in 7 days and starts onboarding while the other never expires and updates one named
   * stand. The lifetime is in the label for the same reason.
   */
  async function createSetupLink() {
    const payload = await post(
      { action: "create_invite", farmId: row.farmId, channel: "sms" },
      "/api/admin/farmers",
    );
    if (payload === null) return;
    if (typeof payload.link !== "string") {
      setNote({ kind: "bad", text: "That link was not created. Try again." });
      return;
    }
    const link = payload.link;
    setFreshLink(link);
    // Copying is the point of the button, so it happens without a second press. The link is
    // still shown below, because a clipboard write can silently fail.
    if (await copyText(link)) {
      setNote({ kind: "ok", text: "New setup link copied. It is shown below — we only show it once." });
      return;
    }
    setNote({
      kind: "bad",
      text: "Link created, but copying failed. Copy it from the box below before you leave.",
    });
  }

  return (
    <section className="admin-seller-controls">
      {editing === null ? (
        <div className="admin-button-row">
          <button
            type="button"
            disabled={busy}
            className="admin-action-secondary"
            onClick={() => setEditing({ name: row.name, description: row.description ?? "" })}
          >
            Edit details
          </button>

          <button
            type="button"
            className={row.approved ? "admin-action-secondary" : "admin-action-primary"}
            disabled={busy}
            onClick={() => void setApproved(!row.approved)}
          >
            {row.approved ? "Remove approval" : "Approve"}
          </button>

          {canUpdate ? null : (
            <button
              type="button"
              className="admin-action-primary"
              disabled={busy}
              aria-label={`New setup link for ${row.name}`}
              onClick={() => void createSetupLink()}
            >
              New setup link
            </button>
          )}

          <button
            type="button"
            className="admin-action-secondary"
            disabled={busy}
            onClick={() => void setTestFarm(!row.isTestFarm)}
          >
            {row.isTestFarm ? "No longer a test farm" : "Mark as a test farm"}
          </button>

          {row.retired ? (
            // One click back, no confirmation: restoring is reversible and refusing to make it
            // easy only strands the operator (F-071).
            <button
              type="button"
              className="admin-action-secondary"
              disabled={busy}
              onClick={() => void setRetired(false)}
            >
              Put back on the map
            </button>
          ) : confirmingRetire ? (
            <span className="admin-seller-confirm" role="group">
              <span>
                Customers no longer see this farm or its stands. Everything it published is kept.
              </span>
              <button
                type="button"
                className="admin-action-danger"
                disabled={busy}
                onClick={() => void setRetired(true)}
              >
                Remove
              </button>
              <button
                type="button"
                className="admin-action-secondary"
                onClick={() => setConfirmingRetire(false)}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="admin-action-danger"
              disabled={busy}
              onClick={() => setConfirmingRetire(true)}
            >
              Take off the map
            </button>
          )}
        </div>
      ) : (
        <div className="admin-seller-edit admin-button-row">
          <label htmlFor={`name-${row.farmId}`}>Farm name</label>
          <input
            id={`name-${row.farmId}`}
            value={editing.name}
            onChange={(event) =>
              setEditing((current) =>
                current === null ? current : { ...current, name: event.target.value },
              )
            }
          />
          <label htmlFor={`description-${row.farmId}`}>Description</label>
          <textarea
            id={`description-${row.farmId}`}
            value={editing.description}
            onChange={(event) =>
              setEditing((current) =>
                current === null ? current : { ...current, description: event.target.value },
              )
            }
          />
          <button
            type="button"
            className="admin-action-primary"
            disabled={busy}
            onClick={() => void saveDetails()}
          >
            Save
          </button>
          <button type="button" className="admin-action-secondary" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      )}

      {freshLink !== null && (
        <p className="admin-fresh-link">
          <span>Setup link — expires in 7 days. We only show it once:</span>
          <code>{freshLink}</code>
        </p>
      )}

      {!canUpdate && freshLink === null && (
        <p className="admin-note">
          Nobody can update this listing yet. A new setup link expires in 7 days — earlier links
          cannot be looked up, so send the one you mint here.
        </p>
      )}

      {note !== null && (
        <p
          className={note.kind === "ok" ? "admin-ok" : "admin-error"}
          role={note.kind === "ok" ? "status" : "alert"}
        >
          {note.text}
        </p>
      )}
    </section>
  );
}
