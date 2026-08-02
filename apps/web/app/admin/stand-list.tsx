"use client";

import { useState } from "react";

export interface AdminStandCard {
  standId: string;
  name: string;
  farmName: string;
  status: string;
  openState: string;
  approved: boolean;
  metadata: Array<readonly [label: string, value: string]>;
}

/**
 * The coordinator scans a stand list for its current state, then opens only the one record
 * they need. Native buttons keep the affordance and keyboard behavior explicit while the
 * detail itself remains ordinary, readable markup.
 */
export function StandList({ stands }: { stands: AdminStandCard[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (stands.length === 0) return <p className="admin-note">No stands yet.</p>;

  return (
    <ul className="admin-stands">
      {stands.map((stand) => {
        const isExpanded = expanded === stand.standId;
        const detailsId = `stand-details-${stand.standId}`;
        return (
          <li key={stand.standId} className="admin-stand">
            <button
              className="admin-stand-summary"
              type="button"
              aria-label={isExpanded ? `Hide details for ${stand.name}` : `Show details for ${stand.name}`}
              aria-expanded={isExpanded}
              aria-controls={detailsId}
              onClick={() => setExpanded(isExpanded ? null : stand.standId)}
            >
              <span className="admin-stand-name">
                <strong>{stand.name}</strong>
                <span>{stand.farmName}</span>
              </span>
              <span className="admin-stand-states" aria-label={`State for ${stand.name}`}>
                <span>{stand.status}</span>
                <span>{stand.openState}</span>
                <span>{stand.approved ? "Approved" : "Not approved"}</span>
              </span>
              <span className="admin-stand-toggle" aria-hidden="true">
                {isExpanded ? "Hide details" : "Show details"}
              </span>
            </button>
            {isExpanded && (
              <dl id={detailsId} className="admin-stand-details">
                {stand.metadata.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}
