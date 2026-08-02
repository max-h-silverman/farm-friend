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
 * Native disclosure keeps every card usable before JavaScript loads. It also gives a mouse
 * user one clear target — the card summary — instead of making a small text link look separate
 * from the control that actually opens the card.
 */
export function StandList({ stands }: { stands: AdminStandCard[] }) {
  if (stands.length === 0) return <p className="admin-note">No stands yet.</p>;

  return (
    <ul className="admin-stands">
      {stands.map((stand) => (
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
              <span className="admin-stand-toggle">
                <span className="admin-stand-show">Show details</span>
                <span className="admin-stand-hide">Hide details</span>
              </span>
            </summary>
            <dl className="admin-stand-details">
              {stand.metadata.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </li>
      ))}
    </ul>
  );
}
