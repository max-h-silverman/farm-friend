export interface AdminStandCard {
  standId: string;
  name: string;
  farmName: string;
  status: string;
  openState: string;
  approved: boolean;
  sections: AdminStandDetailSection[];
}

export interface AdminStandDetailSection {
  title: string;
  prominent?: boolean;
  items: Array<readonly [label: string, value: string, emphasis?: "primary"]>;
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
            <div className="admin-stand-detail-groups">
              {stand.sections.map((section, index) => {
                const headingId = `stand-${stand.standId}-section-${index}`;
                return (
                  <section
                    key={section.title}
                    className={section.prominent ? "admin-stand-detail-section admin-stand-detail-section--prominent" : "admin-stand-detail-section"}
                    aria-labelledby={headingId}
                  >
                    <h3 id={headingId}>{section.title}</h3>
                    <dl>
                      {section.items.map(([label, value, emphasis]) => (
                        <div key={label} className={emphasis === "primary" ? "admin-stand-detail-item--primary" : undefined}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
