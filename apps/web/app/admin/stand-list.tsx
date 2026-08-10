"use client";

import { useState } from "react";

export interface AdminStandCard {
  standId: string;
  name: string;
  farmName: string;
  status: string;
  openState: string;
  approved: boolean;
  /** F-071 — this stand is off the map, by its own retirement or its farm's. */
  retired: boolean;
  /** Off the map only because its FARM is down. The control that reverses it is the farm's. */
  retiredWithFarm: boolean;
  farmBucksStatus: "accepts" | "does_not_accept" | "not_eligible";
  sections: AdminStandDetailSection[];
}

export interface AdminStandDetailSection {
  title: string;
  prominent?: boolean;
  items: Array<readonly [label: string, value: string, emphasis?: "primary"]>;
}

function farmBucksDetail(status: AdminStandCard["farmBucksStatus"]): string {
  switch (status) {
    case "accepts":
      return "Accepted";
    case "does_not_accept":
      return "Does not accept";
    default:
      return "Not reviewed";
  }
}

/**
 * The stands belonging to one farm, rendered inside that farm's card.
 *
 * Stands stopped being a top-level list of their own: an operator looking for a stand was
 * looking for a farm, and the flat index made them hold the farm→stand relationship in their
 * head. This is the same card body the old index rendered, minus the farm name on every row —
 * redundant once the enclosing card names the farm.
 *
 * Native disclosure keeps every card usable before JavaScript loads.
 */
export function StandDetails({ stands }: { stands: AdminStandCard[] }) {
  const [rows, setRows] = useState(stands);
  const [saving, setSaving] = useState<string | null>(null);
  /**
   * Keyed by stand and rendered on the stand it belongs to. A single banner above the list
   * reported the thirtieth stand's outcome above the first stand's card.
   */
  const [note, setNote] = useState<Record<string, { kind: "ok" | "bad"; text: string }>>({});
  /** The stand whose retirement is waiting on a confirmation, if any. */
  const [confirmingRetire, setConfirmingRetire] = useState<string | null>(null);

  function say(standId: string, kind: "ok" | "bad", text: string) {
    setNote((current) => ({ ...current, [standId]: { kind, text } }));
  }

  /**
   * A select that writes on change has no natural "committed" moment, so it says so itself.
   * Without this the control showed the value the operator had just picked whether or not the
   * write landed — indistinguishable from having done nothing.
   */
  async function saveFarmBucks(standId: string, status: AdminStandCard["farmBucksStatus"]) {
    setSaving(standId);
    setNote((current) => {
      const next = { ...current };
      delete next[standId];
      return next;
    });
    try {
      const response = await fetch("/api/admin/stands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ standId, farmBucksStatus: status }),
      });
      if (!response.ok) throw new Error("save failed");
      setRows((current) => current.map((row) => row.standId === standId ? { ...row, farmBucksStatus: status } : row));
      say(standId, "ok", "Farm Bucks saved.");
    } catch {
      say(standId, "bad", "That did not save. Try again.");
    } finally {
      setSaving(null);
    }
  }

  /**
   * Take a stand off the map, or put it back (F-071).
   *
   * The local row is updated from the answer the SERVER gave, never optimistically: an
   * operator who believes a stand is off the map while it is still being served is worse off
   * than one who sees an error.
   */
  async function setRetired(standId: string, retired: boolean) {
    setSaving(standId);
    setNote((current) => {
      const next = { ...current };
      delete next[standId];
      return next;
    });
    try {
      const response = await fetch("/api/admin/stands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ standId, action: retired ? "retire" : "restore" }),
      });
      if (!response.ok) throw new Error("save failed");
      setRows((current) =>
        current.map((row) => (row.standId === standId ? { ...row, retired } : row)),
      );
      say(
        standId,
        "ok",
        retired
          ? "Off the map. Customers no longer see this stand. Everything it published is kept."
          : "Back on the map. Customers can see this stand again.",
      );
    } catch {
      say(
        standId,
        "bad",
        retired
          ? "That stand was not taken off the map. Try again."
          : "That stand was not put back on the map. Try again.",
      );
    } finally {
      // Closed whichever way it went. On failure the row is unchanged and the plain button is
      // back, so a retry is a deliberate act rather than a second click on a stuck dialog.
      setConfirmingRetire(null);
      setSaving(null);
    }
  }

  if (rows.length === 0) return <p className="admin-note">No stands yet.</p>;

  return (
    <>
      <ul className="admin-stands">
      {rows.map((stand) => (
        <li key={stand.standId} className="admin-stand">
          <details>
            <summary className="admin-stand-summary">
              <span className="admin-stand-name">
                <strong>{stand.name}</strong>
              </span>
              <span className="admin-stand-states" aria-label={`State for ${stand.name}`}>
                {/*
                  A retired stand's `status` and `openState` describe a listing nobody is being
                  shown, so leading with them would be misleading. "Off the map" replaces them
                  rather than joining them.

                  A stand that is down only because its FARM is down says so, because the
                  operator's next move differs: this stand has no retirement of its own to
                  undo, and the control that brings it back is on the farm.
                */}
                {stand.retiredWithFarm ? (
                  <span className="admin-stand-retired">Off the map with the farm</span>
                ) : stand.retired ? (
                  <span className="admin-stand-retired">Off the map</span>
                ) : (
                  <>
                    <span>{stand.status}</span>
                    <span>{stand.openState}</span>
                  </>
                )}
              </span>
            </summary>
            <div className="admin-stand-detail-groups">
              {note[stand.standId] !== undefined && (
                <p
                  className={note[stand.standId]?.kind === "ok" ? "admin-success" : "admin-error"}
                  role={note[stand.standId]?.kind === "ok" ? "status" : "alert"}
                >
                  {note[stand.standId]?.text}
                </p>
              )}
              {stand.sections.map((section, index) => {
                const headingId = `stand-${stand.standId}-section-${index}`;
                const items = section.items.map((item) =>
                  item[0] === "Farm Bucks"
                    ? [item[0], farmBucksDetail(stand.farmBucksStatus), item[2]] as AdminStandDetailSection["items"][number]
                    : item,
                );
                return (
                  <section
                    key={section.title}
                    className={section.prominent ? "admin-stand-detail-section admin-stand-detail-section--prominent" : "admin-stand-detail-section"}
                    aria-labelledby={headingId}
                  >
                    <h3 id={headingId}>{section.title}</h3>
                    <dl>
                      {items.map(([label, value, emphasis]) => (
                        <div key={label} className={emphasis === "primary" ? "admin-stand-detail-item--primary" : undefined}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
              <section className="admin-stand-detail-section admin-farm-bucks" aria-labelledby={`stand-${stand.standId}-farm-bucks`}>
                <div className="admin-farm-bucks-head">
                  <div>
                    <h3 id={`stand-${stand.standId}-farm-bucks`}>Farm Bucks</h3>
                  </div>
                </div>
                <div className="admin-farm-bucks-controls">
                  <label className="admin-field">
                    <select
                      aria-label="Farm Bucks decision"
                      disabled={saving === stand.standId}
                      value={stand.farmBucksStatus}
                      onChange={(event) => void saveFarmBucks(
                        stand.standId,
                        event.target.value as AdminStandCard["farmBucksStatus"],
                      )}
                    >
                      <option value="not_eligible">Not reviewed</option>
                      <option value="accepts">Accepts Farm Bucks</option>
                      <option value="does_not_accept">Does not accept Farm Bucks</option>
                    </select>
                  </label>
                </div>
                <p className="admin-farm-bucks-note">Record this only after VIGA confirms the stand’s Farm Bucks policy.</p>
              </section>

              <section
                className="admin-stand-detail-section admin-stand-retirement"
                aria-labelledby={`stand-${stand.standId}-retirement`}
              >
                {/*
                  Named for what an operator ARRIVES looking for. "Take off the map" describes
                  the effect accurately but is not the word anyone searches with, so operators
                  concluded a stand could not be removed at all. The heading says "remove"; the
                  copy and the button still say what actually happens, because this is
                  reversible and calling it "delete" would overstate it.
                */}
                <h3 id={`stand-${stand.standId}-retirement`}>Remove this stand</h3>
                <p className="admin-note">
                  {stand.retiredWithFarm
                    ? "This stand is off the map because the whole farm was removed. Put the farm back to bring it back."
                    : stand.retired
                      ? "Customers cannot see this stand, and the farmer cannot publish updates to it. Everything it published before is kept."
                      : "Removes this stand from the map and from text answers, and stops the farmer publishing updates to it. Nothing it already published is deleted, and you can put it back."}
                </p>
                {/*
                  No control at all for a stand held down by its farm. "Put back on the map"
                  would post a restore for a stand that was never retired, the server would
                  answer `not_retired`, and the stand would stay exactly where it is — a button
                  that visibly does nothing.
                */}
                {stand.retiredWithFarm ? null : stand.retired ? (
                  <button
                    className="admin-action-secondary"
                    type="button"
                    disabled={saving === stand.standId}
                    onClick={() => void setRetired(stand.standId, false)}
                  >
                    {saving === stand.standId ? "Saving…" : "Put back on the map"}
                  </button>
                ) : confirmingRetire === stand.standId ? (
                  <div
                    className="admin-inline-confirm"
                    role="group"
                    aria-label={`Take ${stand.name} off the map`}
                  >
                    <p>Take {stand.name} off the map? Customers will stop seeing it.</p>
                    <button
                      className="admin-action-danger"
                      type="button"
                      disabled={saving === stand.standId}
                      onClick={() => void setRetired(stand.standId, true)}
                    >
                      {saving === stand.standId ? "Saving…" : "Yes, take it off the map"}
                    </button>
                    <button
                      className="admin-action-secondary"
                      type="button"
                      disabled={saving === stand.standId}
                      onClick={() => setConfirmingRetire(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  // Asks before acting. Retirement is reversible, but it removes a farm from
                  // the island's only guide, so a misplaced click must not be enough.
                  <button
                    className="admin-action-danger"
                    type="button"
                    disabled={saving === stand.standId}
                    onClick={() => setConfirmingRetire(stand.standId)}
                  >
                    Take off the map
                  </button>
                )}
              </section>
            </div>
          </details>
        </li>
      ))}
      </ul>
    </>
  );
}
