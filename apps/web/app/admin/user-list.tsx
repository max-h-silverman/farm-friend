"use client";

import { useState } from "react";

export interface AdminUserRow {
  userId: string;
  senderMask: string;
  isFarmer: boolean;
  farms: string[];
}

export function UserList({ users }: { users: AdminUserRow[] }) {
  const [filter, setFilter] = useState<"all" | "farmer" | "not_farmer">("all");
  const visible = users.filter(
    (user) => filter === "all" || (filter === "farmer" ? user.isFarmer : !user.isFarmer),
  );

  return (
    <section className="admin-users" aria-label="People directory">
      <div className="admin-directory-toolbar">
        <div>
          <p className="admin-kicker">Browse</p>
          <p className="admin-note">Filter by the access they have today.</p>
        </div>
        <label className="admin-user-filter">
          <span className="admin-control-label">Show</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="all">Everyone</option>
            <option value="farmer">Farmer access</option>
            <option value="not_farmer">No access yet</option>
          </select>
        </label>
      </div>
      <p className="admin-directory-count">
        {visible.length} {visible.length === 1 ? "person" : "people"}
      </p>
      {visible.length === 0 ? (
        <p className="admin-empty-state">No people match this filter.</p>
      ) : (
        <ul className="admin-user-list">
          {visible.map((user) => (
            <li key={user.userId}>
              <div className="admin-person-identity">
                <strong>{user.senderMask}</strong>
                <span>Masked contact</span>
              </div>
              <div className="admin-person-access">
                <span className={`admin-access-pill${user.isFarmer ? " admin-access-pill--active" : ""}`}>
                  {user.isFarmer ? "Farmer access" : "No access yet"}
                </span>
                <span>
                  {user.isFarmer
                    ? `Can update: ${user.farms.join(", ")}`
                    : "Invite them above to get started."}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
