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
      title="Users"
      signedInAs={administrator.email}
    >
      <p className="admin-note">
        User records show only a masked phone number, current farmer status, and farm access.
        Filter by whether a person can currently publish as a farmer.
      </p>

      <UserList users={users} />

      <h2 className="admin-section-title">Farmer access</h2>
      <p className="admin-note">
        Authorizing a farmer lets them publish what their stand has — by text, or through
        their own private link. <strong>Check first that the person really runs the farm.</strong>{" "}
        A phone number only proves someone has that phone, so this decision is yours and
        nothing automates it. A farmer still confirms every listing before it goes live, and a
        farm also needs <Link href="/admin">approval</Link> before anything publishes.
      </p>

      <p className="admin-note">
        A farmer&apos;s link keeps working until you revoke it here. If a farmer loses their
        phone, or a link is shared by accident, revoke it — it stops working immediately, and
        they can text <strong>LINK</strong> for a new one.
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
    </AdminShell>
  );
}
