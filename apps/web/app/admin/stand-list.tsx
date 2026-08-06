"use client";

import { useState } from "react";

export interface AdminStandCard {
  standId: string;
  name: string;
  farmName: string;
  status: string;
  openState: string;
  approved: boolean;
  /** F-071 — VIGA took this stand down. It keeps every record it published. */
  retired: boolean;
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
 * Native disclosure keeps every card usable before JavaScript loads. It also gives a mouse
 * user one clear target — the card summary — instead of making a small text link look separate
 * from the control that actually opens the card.
 */
export function StandList({ stands }: { stands: AdminStandCard[] }) {
  const [rows, setRows] = useState(stands);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The stand whose retirement is waiting on a confirmation, if any. */
  const [confirmingRetire, setConfirmingRetire] = useState<string | null>(null);

  async function saveFarmBucks(standId: string, status: AdminStandCard["farmBucksStatus"]) {
    setSaving(standId);
    setError(null);
    try {
      const response = await fetch("/api/admin/stands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ standId, farmBucksStatus: status }),
      });
      if (!response.ok) throw new Error("save failed");
      setRows((current) => current.map((row) => row.standId === standId ? { ...row, farmBucksStatus: status } : row));
    } catch {
      setError("That change did not go through. Reload and try again.");
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
    setError(null);
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
    } catch {
      setError(
        retired
          ? "That stand was not taken off the map. Reload and try again."
          : "That stand was not put back on the map. Reload and try again.",
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
      {error !== null ? <p className="admin-error" role="alert">{error}</p> : null}
      <ul className="admin-stands">
      {rows.map((stand) => (
        <li key={stand.standId} className="admin-stand">
          <details>
            <summary className="admin-stand-summary">
              <span className="admin-stand-name">
                <strong>{stand.name}</strong>
                <span>{stand.farmName}</span>
              </span>
              <span className="admin-stand-states" aria-label={`State for ${stand.name}`}>
                {/*
                  A retired stand's `status` and `openState` describe a listing nobody is being
                  shown, so leading with them would be misleading. "Off the map" replaces them
                  rather than joining them.
                */}
                {stand.retired ? (
                  <span className="admin-stand-retired">Off the map</span>
                ) : (
                  <>
                    <span>{stand.status}</span>
                    <span>{stand.openState}</span>
                  </>
                )}
                <span>{stand.approved ? "Approved" : "Not approved"}</span>
              </span>
            </summary>
            <div className="admin-stand-detail-groups">
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
                <h3 id={`stand-${stand.standId}-retirement`}>Take off the map</h3>
                <p className="admin-note">
                  {stand.retired
                    ? "Customers cannot see this stand, and the farmer cannot publish updates to it. Everything it published before is kept."
                    : "Removes this stand from the map and from text answers, and stops the farmer publishing updates to it. Nothing it already published is deleted, and you can put it back."}
                </p>
                {stand.retired ? (
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
