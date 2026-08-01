import { headers } from "next/headers";
import Link from "next/link";
import { hasRole } from "@farm-friend/core";
import {
  listFarmerAuthorizations,
  listFarmsForApproval,
  listOpenFarmerOnboardingRequests,
} from "@farm-friend/db";
import { resolvePrincipal } from "../../../lib/auth";
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
  const principal = await resolvePrincipal(
    new Request("https://farm-friend.internal/admin/farmers", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (principal === null || !hasRole(principal, "admin")) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const [requests, authorizations, farms] = await Promise.all([
    listOpenFarmerOnboardingRequests(db),
    listFarmerAuthorizations(db),
    listFarmsForApproval(db),
  ]);

  return (
    <AdminShell
      currentPath="/admin/farmers"
      title="Farmer access"
      signedInAs={principal.personId}
    >
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
        }))}
        farms={farms.map((farm) => ({ farmId: farm.farmId, name: farm.name }))}
      />
    </AdminShell>
  );
}
