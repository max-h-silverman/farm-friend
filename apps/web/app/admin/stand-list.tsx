"use client";

import { useState } from "react";

export interface AdminStandCard {
  standId: string;
  name: string;
  farmName: string;
  status: string;
  openState: string;
  approved: boolean;
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
                <span>{stand.status}</span>
                <span>{stand.openState}</span>
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
            </div>
          </details>
        </li>
      ))}
      </ul>
    </>
  );
}
