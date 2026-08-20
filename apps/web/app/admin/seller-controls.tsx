"use client";

import { useState } from "react";
import { copyText } from "../../lib/copy-text";
import type { ActionMenuItem } from "./action-menu";
import { LinkIcon, PencilIcon, TrashIcon, UnpinIcon } from "./icons";

/**
 * Everything VIGA does *about* a seller, on the seller's own card.
 *
 * These controls used to live on a Farms screen. F-101 removed that screen: VIGA's job is to
 * view and edit stands and sellers (max, 2026-08-17), so correcting a farm's name, taking it
 * off the map, moving it to the trash and minting its setup link are all things an operator
 * does *while looking at the seller* — not destinations of their own.
 *
 * **Approval and test-farm marking are gone** (F-124, max 2026-08-19). Onboarding redemption
 * auto-approves, so the only unapproved farm was one VIGA had explicitly revoked — and with the
 * toggle gone nobody can revoke. Publication still refuses with `not_approved`, so the gate
 * itself is untouched; what went is the console's ability to reach it. Marking a test farm
 * becomes a script-only operation, which max was told and accepted. Both writers still exist
 * and both are still called from elsewhere; the route no longer honours either action.
 *
 * **The verbs are a menu, the results are the card.** The card header owns the one way in; this
 * hook supplies the items and owns everything that happens after one is chosen — the editor,
 * the confirmation, the minted link, the outcome note. Splitting it that way is what keeps a
 * card at rest to a name and its states, and it is why `menuItems` and `panel` come from one
 * hook rather than from two components that would each hold half the state.
 *
 * **The card that owns the seller owns every result about the seller.** A link minted here
 * appears here; a decision recorded here reports here. Nothing an operator starts on this card
 * finishes somewhere else on the page — that was the failure that made the old screens feel
 * like "did that work? where did it go?".
 *
 * Every mutation posts to a guarded route that re-checks authority server-side. This hook's
 * state is convenience, never authorization.
 */

export interface SellerControlsRow {
  farmId: string;
  name: string;
  description?: string | null;
  approved: boolean;
  retired: boolean;
  isTestFarm: boolean;
}

export function useSellerControls({
  seller,
  canUpdate,
  fetcher = fetch,
}: {
  seller: SellerControlsRow;
  /** Somebody can already publish for this seller. */
  canUpdate: boolean;
  fetcher?: typeof fetch;
}): { row: SellerControlsRow; menuItems: Array<ActionMenuItem | null>; panel: React.ReactNode } {
  const [row, setRow] = useState(seller);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  /**
   * WHICH destructive-looking act is being confirmed, or null.
   *
   * One state rather than a boolean per act: retiring and trashing ask the same question in the
   * same place, and a second `confirmingTrash` boolean would make "both open at once" a state
   * the panel had to rule out rather than one it cannot represent.
   */
  const [confirming, setConfirming] = useState<"retire" | "trash" | null>(null);
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null);
  /**
   * A freshly minted setup link, held only in this hook's state and only until the operator
   * navigates away. It is never re-readable from the server, which is correct for a standing
   * credential — so it renders on the seller's own card, with the copy saying so.
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

  async function setRetired(retired: boolean) {
    const payload = await post({ farmId: row.farmId, action: retired ? "retire" : "restore" });
    setConfirming(null);
    if (payload === null) return;
    setRow((current) => ({ ...current, retired }));
    setNote({
      kind: "ok",
      text: retired
        ? "Removed. Customers no longer see this farm or its stands. Everything it published is kept."
        : "Back on the map. Any stand you removed on its own is still off.",
    });
  }

  /**
   * Move this seller to the trash: out of VIGA's list entirely, and restorable from the Trash
   * section (F-124).
   *
   * The row stays on screen carrying the outcome note rather than vanishing. The list this card
   * sits in is the server's, and a card that removed itself would be claiming an authority it
   * does not have — a refused trash would look identical to a successful one.
   */
  async function moveToTrash() {
    const payload = await post({ farmId: row.farmId, action: "trash" });
    setConfirming(null);
    if (payload === null) return;
    setRow((current) => ({ ...current, retired: true }));
    setNote({
      kind: "ok",
      text: `${row.name} is in the trash. Reload to update the list, or put it back from Trash.`,
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
    // Copying is the point of the item, so it happens without a second press. The link is
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

  /*
    The verbs, in the order an operator reaches for them: correct it, decide about it, hand it
    over, mark it — then, last and alone, take it off the map.

    **A setup link is absent, not disabled, for a farm that already has one.** Offering it would
    invite the operator to solve a problem that farm does not have; `null` is how the menu says
    "not offered here".
  */
  const menuItems: Array<ActionMenuItem | null> = [
    {
      key: "edit",
      label: "Edit details",
      icon: <PencilIcon />,
      onSelect: () => {
        setConfirming(null);
        setEditing({ name: row.name, description: row.description ?? "" });
      },
    },
    canUpdate
      ? null
      : {
          key: "setup-link",
          label: "Send new setup link",
          icon: <LinkIcon />,
          onSelect: () => void createSetupLink(),
        },
    row.retired
      ? // One click back, no confirmation: restoring is reversible and refusing to make it
        // easy only strands the operator (F-071).
        {
          key: "restore",
          label: "Put back on the map",
          icon: <UnpinIcon />,
          onSelect: () => void setRetired(false),
        }
      : {
          key: "retire",
          label: "Take off the map",
          icon: <UnpinIcon />,
          danger: true,
          onSelect: () => {
            setEditing(null);
            setConfirming("retire");
          },
        },
    // LAST, and after the map controls: trash is the one that takes the record out of VIGA's
    // list altogether, so it sits below the everyday reversible hide rather than beside it.
    {
      key: "trash",
      label: "Move to trash",
      icon: <TrashIcon />,
      danger: true,
      onSelect: () => {
        setEditing(null);
        setConfirming("trash");
      },
    },
  ];

  const panel = (
    <div className="admin-seller-controls">
      {confirming === "retire" && (
        <div className="admin-confirm" role="group" aria-label={`Take ${row.name} off the map`}>
          <p>Customers no longer see this farm or its stands. Everything it published is kept.</p>
          <div className="admin-confirm-actions">
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
              onClick={() => setConfirming(null)}
            >
              Keep
            </button>
          </div>
        </div>
      )}

      {confirming === "trash" && (
        <div className="admin-confirm" role="group" aria-label={`Move ${row.name} to trash`}>
          {/*
            Says what happens AND that it is reversible. The second half is what makes the
            control safe to reach for — an operator who believes this destroys the farm's
            history will not use it, and will ask VIGA for a database repair instead.
          */}
          <p>
            This farm leaves your list and customers stop seeing it. Nothing is deleted — every
            listing, update and report is kept, and you can put it back from Trash.
          </p>
          <div className="admin-confirm-actions">
            <button
              type="button"
              className="admin-action-danger"
              disabled={busy}
              onClick={() => void moveToTrash()}
            >
              Move to trash
            </button>
            <button
              type="button"
              className="admin-action-secondary"
              onClick={() => setConfirming(null)}
            >
              Keep
            </button>
          </div>
        </div>
      )}

      {editing !== null && (
        <div className="admin-seller-edit">
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
          <div className="admin-confirm-actions">
            <button
              type="button"
              className="admin-action-primary"
              disabled={busy}
              onClick={() => void saveDetails()}
            >
              Save
            </button>
            <button
              type="button"
              className="admin-action-secondary"
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {freshLink !== null && (
        <p className="admin-fresh-link">
          <span>Setup link — expires in 7 days. We only show it once:</span>
          <code>{freshLink}</code>
        </p>
      )}

      {!canUpdate && freshLink === null && (
        <p className="admin-banner admin-banner--info">
          Nobody can update this listing yet. A new setup link expires in 7 days — earlier links
          cannot be looked up, so send the one you mint here.
        </p>
      )}

      {note !== null && (
        <p
          className={note.kind === "ok" ? "admin-success" : "admin-error"}
          role={note.kind === "ok" ? "status" : "alert"}
        >
          {note.text}
        </p>
      )}
    </div>
  );

  return { row, menuItems, panel };
}
