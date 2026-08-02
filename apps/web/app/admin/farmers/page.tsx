import { headers } from "next/headers";
import Link from "next/link";
import {
  listFarmerAuthorizations,
  listFarmsForApproval,
  listOpenFarmerOnboardingRequests,
  listUsersForAdministration,
} from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { FarmerQueue } from "./farmer-queue";
import { AdminShell, SignedOutAdmin } from "../admin-shell";
import { UserList } from "../user-list";

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
  const [requests, authorizations, farms, users] = await Promise.all([
    listOpenFarmerOnboardingRequests(db),
    listFarmerAuthorizations(db),
    listFarmsForApproval(db),
    listUsersForAdministration(db),
  ]);

  return (
    <AdminShell
      currentPath="/admin/farmers"
      title="People"
      signedInAs={administrator.email}
    >
      <p className="admin-note">
        See who has contacted Farm Friend and who can update a farm. Phone numbers are partly
        hidden.
      </p>

      <section className="admin-priority" aria-labelledby="farmer-access-heading">
        <h2 id="farmer-access-heading" className="admin-section-title">Farmer access</h2>
        <p className="admin-note">
          Give access only after confirming the person runs the farm. Having a phone does not
          prove that. A farm also needs <Link href="/admin">approval</Link> before it appears on
          the map.
        </p>
        <FarmerQueue
          requests={requests.map((request) => ({
            requestId: request.requestId,
            senderMask: request.senderMask,
            requestedAt: request.requestedAt.toISOString(),
          }))}
          authorizations={authorizations.map((authorization) => ({
            authorizationId: authorization.authorizationId,
            farmId: authorization.farmId,
            farmName: authorization.farmName,
            senderMask: authorization.senderMask,
            authorizedAt: authorization.authorizedAt.toISOString(),
            revokedAt: authorization.revokedAt?.toISOString() ?? null,
            hasLiveLink: authorization.hasLiveLink,
            stands: authorization.stands,
            liveLinkStand: authorization.liveLinkStand,
          }))}
          farms={farms.map((farm) => ({ farmId: farm.farmId, name: farm.name }))}
        />
      </section>

      <section aria-labelledby="people-list-heading">
        <h2 id="people-list-heading" className="admin-section-title">People who contacted us</h2>
        <p className="admin-note">Filter by whether they can currently update a farm.</p>
        <UserList users={users} />
      </section>
    </AdminShell>
  );
}
