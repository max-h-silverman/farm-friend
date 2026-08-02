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
    <section className="admin-users" aria-label="Users">
      <label className="admin-user-filter">
        <span className="admin-control-label">User type</span>
        <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
          <option value="all">All users</option>
          <option value="farmer">Farmers</option>
          <option value="not_farmer">Not farmers</option>
        </select>
      </label>
      {visible.length === 0 ? (
        <p className="admin-note">No users match this filter.</p>
      ) : (
        <ul className="admin-user-list">
          {visible.map((user) => (
            <li key={user.userId}>
              <span>{user.senderMask}</span>
              <span>{user.isFarmer ? `Farmer — ${user.farms.join(", ")}` : "Not a farmer"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
