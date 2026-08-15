import { headers } from "next/headers";
import {
  listOpenFarmerOnboardingRequests,
  listFarmsForApproval,
  listUsersForAdministration,
} from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { AdminShell, SignedOutAdmin } from "../admin-shell";
import { FarmerQueue } from "../farmers/farmer-queue";
import { UserList } from "../user-list";

// Everyone who has texted Farm Friend, and what they can do.
//
// This is the PEOPLE surface: a phone that reached us, whether it may publish for a farm, and
// which farm. It is deliberately not a profile — no number, no hash, no message text, no
// timestamps (Golden Rule #5). The masking happens at the query boundary, so this page could
// not leak a phone number even if it tried to render one.
//
// Inviting a farmer and deciding an access request live here too, because both are about a
// PERSON rather than about a farm: an access request arrives from a handset with no farm
// attached, and an invitation is addressed to someone who is not yet in this list at all.
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
  const [users, requests, sellers] = await Promise.all([
    listUsersForAdministration(db),
    listOpenFarmerOnboardingRequests(db),
    listFarmsForApproval(db),
  ]);

  return (
    <AdminShell currentPath="/admin/users">
      <h2 className="admin-section-title">Invite a farmer</h2>
      <p className="admin-boundary-note">Only give access to a verified farm operator.</p>
      <FarmerQueue
        requests={requests.map((request) => ({
          requestId: request.requestId,
          senderMask: request.senderMask,
          requestedAt: request.requestedAt.toISOString(),
          farmId: request.farmId,
          farmName: request.farmName,
        }))}
        // Retired sellers are not offered: inviting a farmer to take over a farm VIGA has taken
        // down would produce a link that onboards someone onto nothing.
        sellers={sellers
          .filter((farm) => !farm.retired)
          .map((farm) => ({ farmId: farm.farmId, name: farm.name }))}
      />

      <h2 className="admin-section-title">Everyone who has texted us</h2>
      <UserList users={users} />
    </AdminShell>
  );
}
