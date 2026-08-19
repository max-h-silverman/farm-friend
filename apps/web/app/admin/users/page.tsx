import { headers } from "next/headers";
import { listUsersForAdministration } from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { AdminShell, SignedOutAdmin } from "../admin-shell";
import { UserList } from "../user-list";

// Everyone who has texted Farm Friend, and what they can do.
//
// This is the PEOPLE surface: a phone that reached us, whether it may publish for a farm, and
// which farm. It is deliberately not a profile — no number, no hash, no message text, no
// timestamps (Golden Rule #5). The masking happens at the query boundary, so this page could
// not leak a phone number even if it tried to render one.
//
// **Inviting a farmer moved to Stands & Sellers** (max, 2026-08-19). It sat here on the reading
// that an invitation is about a PERSON; in practice an operator inviting a farmer is adding a
// stand or seller to the roster, and the roster is the other screen's whole subject. What is
// left here is the one thing this screen is actually for: who has texted us, and what they can do.
//
// Same server-side authorization shape as every other admin page.

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin/users", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const users = await listUsersForAdministration(db);

  return (
    <AdminShell currentPath="/admin/users">
      <h2 className="admin-section-title">Everyone who has texted us</h2>
      <UserList users={users} />
    </AdminShell>
  );
}
