"use client";

import { useState } from "react";
import { ActionMenu } from "./action-menu";
import { TrashIcon } from "./icons";

/**
 * The pause/resume control and Remove, shared by the Stands view and the Sellers view.
 *
 * **One component, two views.** The same arrangement appears under the stand it happens at and
 * under the seller doing the selling, and a volunteer acts wherever they are looking. Two
 * components would be two places for the same three transitions, the same confirmation, and
 * the same refusal copy to drift. What differs between the views is only the SUBJECT — which
 * side of the arrangement the operator is not currently looking at — and that is one prop.
 *
 * **The lists are entities, not states** (max, 2026-08-17). A stand row is a stand and a seller
 * row is a seller; participation is a detail inside the row it belongs to, never a row of its
 * own. That is why an ended arrangement simply leaves: it is not an entity, so there is no row
 * for it to become.
 *
 * **State is the row; Remove is behind the row's menu.** Selling/paused is the one thing an
 * operator flips often, so it stays a single press on the row itself. Ending an arrangement is
 * terminal, so it lives behind the same menu mechanism every other destructive verb uses and
 * still asks before it acts — a red button sitting permanently beside a toggle is a misclick
 * waiting on a real seller's listing.
 *
 * Every mutation posts to `/api/admin/participation`, which re-resolves the administrator
 * server-side and hands the transition to `setProviderParticipation`. This component's state
 * is convenience, never authority.
 */

export interface ParticipationRow {
  providerId: string;
  salesLocationId: string;
  standName: string;
  sellerId: string;
  sellerName: string;
  lifecycleState: "active" | "paused";
  /** This seller owns the stand. Presentation only — see `standFraming` below. */
  nativeSeller: boolean;
  ended: boolean;
}

type View = "stand" | "seller";

/**
 * What the operator is NOT looking at, and therefore what each row must name.
 *
 * On the Stands view the stand is the context and the seller is the variable; on the Sellers
 * view it is the other way round. Deriving it here keeps the two views from each spelling out
 * their own labels.
 */
function subjectOf(view: View, row: ParticipationRow): string {
  return view === "stand" ? row.sellerName : row.standName;
}

/**
 * THE ADAPTING LABEL (max, 2026-08-17).
 *
 * On a stand whose only arrangement is its own seller's, pausing takes the stand's goods off
 * the map — so the toggle says so, because on that stand that is its true effect. It is a
 * presentation rule and nothing more: the control is still that provider's participation, and
 * **no stand-level closed state exists**.
 *
 * The condition is `rows.length === 1 && nativeSeller`, and the second half is what keeps it
 * honest. A stand with a paused native seller and a live guest is NOT closed — its guest is
 * still selling there — and a label saying otherwise is a lie a volunteer would act on. That
 * is the failure this rule exists to prevent, so the framing is computed from the whole set
 * rather than from the row.
 *
 * The seller view never borrows it: there the subject is always the arrangement.
 */
function standFraming(view: View, rows: ParticipationRow[]): boolean {
  return view === "stand" && rows.length === 1 && rows[0]?.nativeSeller === true;
}

function toggleLabel(view: View, row: ParticipationRow, framing: boolean): string {
  if (framing) {
    return row.lifecycleState === "active" ? "Stand is open" : "Stand is closed";
  }
  return `${subjectOf(view, row)} — ${row.lifecycleState === "active" ? "selling" : "paused"}`;
}

/** What a refusal means in the operator's terms, never the seam's vocabulary. */
function refusalText(error: unknown, subject: string): string {
  switch (error) {
    case "provider_not_live":
      return `${subject} no longer sells here. Someone ended this while you were looking at it — reload to see the current list.`;
    case "unknown_provider":
      return `${subject} is no longer here. Reload to see the current list.`;
    case "not_authorized":
      return "You are not signed in as an administrator any more. Sign in again.";
    default:
      return "That did not save. Try again.";
  }
}

export function SellerParticipation({
  view,
  rows,
  fetcher = fetch,
}: {
  view: View;
  rows: ParticipationRow[];
  fetcher?: typeof fetch;
}) {
  const [live, setLive] = useState(rows);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /**
   * Keyed by arrangement and rendered inside the row it belongs to. A message about the third
   * seller shown above the first is a message the operator does not see.
   */
  const [note, setNote] = useState<Record<string, string>>({});

  const framing = standFraming(view, live);

  async function send(row: ParticipationRow, transition: "pause" | "resume" | "end") {
    setBusy(row.providerId);
    setNote((current) => {
      const next = { ...current };
      delete next[row.providerId];
      return next;
    });
    try {
      const response = await fetcher("/api/admin/participation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: row.providerId, transition }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setNote((current) => ({
          ...current,
          [row.providerId]: refusalText(payload.error, subjectOf(view, row)),
        }));
        return;
      }
      // An ended arrangement is not an entity, so it leaves rather than becoming a dead row
      // wearing live controls.
      if (transition === "end") {
        setLive((current) => current.filter((entry) => entry.providerId !== row.providerId));
        return;
      }
      setLive((current) =>
        current.map((entry) =>
          entry.providerId === row.providerId
            ? { ...entry, lifecycleState: transition === "pause" ? "paused" : "active" }
            : entry,
        ),
      );
    } catch {
      setNote((current) => ({
        ...current,
        [row.providerId]: "That did not save. Try again.",
      }));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  function renderRow(row: ParticipationRow) {
    const paused = row.lifecycleState === "paused";
    const subject = subjectOf(view, row);
    const label = toggleLabel(view, row, framing);
    return (
      <div className="admin-participation-row" key={row.providerId}>
        <div className="admin-participation-line">
          {/*
            The whole line is the toggle. A dot the operator can read at a glance, the subject,
            and the state as a word — so a long list is scannable by colour and still says what
            it means without it.
          */}
          <button
            type="button"
            role="switch"
            aria-checked={!paused}
            aria-label={label}
            className="admin-participation-toggle"
            disabled={busy === row.providerId}
            onClick={() => void send(row, paused ? "resume" : "pause")}
          >
            <span className="admin-participation-dot" aria-hidden="true" />
            <span className="admin-participation-subject">{framing ? label : subject}</span>
            {!framing && (
              <span className="admin-chip admin-chip--state" aria-hidden="true">
                {paused ? "Paused" : "Selling"}
              </span>
            )}
          </button>

          {/*
            NAMES THE ARRANGEMENT, not the place. On a stand whose only seller owns it the two
            share a name, so "More for Bank Road Gardens" collided with the stand's own menu
            beside it — two identical buttons doing different things.
          */}
          <ActionMenu
            compact
            label={
              view === "stand"
                ? `More for ${subject} selling here`
                : `More for selling at ${subject}`
            }
            disabled={busy === row.providerId}
            items={[
              {
                key: "end",
                label: `Remove ${subject}`,
                icon: <TrashIcon />,
                danger: true,
                onSelect: () => setConfirming(row.providerId),
              },
            ]}
          />
        </div>

        {confirming === row.providerId && (
          <div className="admin-confirm" role="group" aria-label={`Remove ${subject}`}>
            {/* Terminal, and the copy says so: there is no restore, only a fresh invitation. */}
            <p>
              {subject} stops selling here. This cannot be undone — coming back needs a new
              invitation.
            </p>
            <div className="admin-confirm-actions">
              <button
                type="button"
                className="admin-action-danger"
                disabled={busy === row.providerId}
                onClick={() => void send(row, "end")}
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

        {note[row.providerId] !== undefined && (
          <p className="admin-error" role="alert">
            {note[row.providerId]}
          </p>
        )}
      </div>
    );
  }

  if (live.length === 0) {
    return (
      <p className="admin-note">
        {view === "stand" ? "Nobody sells here yet." : "This farm sells at no stands yet."}
      </p>
    );
  }

  // THE SINGULAR CASE IS NOT A LIST. One arrangement is a plain fact with its control — no
  // list chrome for a volunteer to read as "one of several".
  if (live.length === 1) {
    return <div className="admin-participation">{renderRow(live[0] as ParticipationRow)}</div>;
  }

  return (
    <ul className="admin-participation">
      {live.map((row) => (
        <li key={row.providerId}>{renderRow(row)}</li>
      ))}
    </ul>
  );
}
