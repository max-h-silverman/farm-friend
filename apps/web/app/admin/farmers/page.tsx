import { headers } from "next/headers";
import {
  listFarmsForApproval,
  listOpenFarmerOnboardingRequests,
} from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { FarmerQueue } from "./farmer-queue";
import { AdminShell, SignedOutAdmin } from "../admin-shell";

// The farmer authorization surface (F-040). Same server-side authorization shape as every
// other admin page: an unauthenticated caller is never handed queue data, because it is
// never fetched for them.
//
// Two decisions live here, and they are different in kind:
//
//   - **Who may publish for a farm.** VIGA always approves. A phone proves possession of a
//     phone, not ownership of a farm, so nothing automates this.
//   - **Whether a standing link is still live.** max chose a link that never expires, so
//     revoking it is the only safety net there is — which makes this page part of the
//     security design, not an operator convenience.

export const dynamic = "force-dynamic";

export default async function FarmersPage() {
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin/farmers", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const [requests, farms] = await Promise.all([
    listOpenFarmerOnboardingRequests(db),
    listFarmsForApproval(db),
  ]);

  return (
    <AdminShell currentPath="/admin/farmers">
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
        // Retired farms are not offered: inviting a farmer to take over a farm VIGA has
        // taken down would produce a link that onboards someone onto nothing.
        farms={farms
          .filter((farm) => !farm.retired)
          .map((farm) => ({ farmId: farm.farmId, name: farm.name }))}
      />
    </AdminShell>
  );
}
