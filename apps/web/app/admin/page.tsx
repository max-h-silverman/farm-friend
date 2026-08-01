import { headers } from "next/headers";
import { hasRole } from "@farm-friend/core";
import { listFarmsForApproval } from "@farm-friend/db";
import { resolvePrincipal } from "../../lib/auth";
import { publicReadContext } from "../../lib/public-context";
import { ApprovalQueue } from "./approval-queue";
import { AdminShell, SignedOutAdmin } from "./admin-shell";

// The VIGA operator surface (F-025a): sign in, see every farm, approve or revoke.
//
// Server-rendered per request, and the authorization check happens HERE on the server — not
// in the browser component, which can only ever be a convenience. A caller without a live
// administrator session sees the signed-out page and no farm data, because the data is never
// fetched for them in the first place.
//
// Deliberately not a general admin console. Three screens, each one decision: may this farm
// publish (here), what happened with this flag (/admin/flags), did anyone look at this report
// (/admin/reports).

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Next's server components do not hand a Request to a page, so the incoming cookie header
  // is rebuilt into one for the same `resolvePrincipal` every API route uses. One code path
  // resolves a principal, not two that could drift apart.
  const cookie = headers().get("cookie") ?? "";
  const principal = await resolvePrincipal(
    new Request("https://farm-friend.internal/admin", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (principal === null || !hasRole(principal, "admin")) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const farms = await listFarmsForApproval(db);

  return (
    <AdminShell currentPath="/admin" title="Farm approval" signedInAs={principal.personId}>
      <p className="admin-note">
        Only approved farms publish publicly. Approval is <strong>your act</strong>, recorded
        separately from a farmer completing onboarding — verify the farm is real, is a VIGA
        participant, and that the person who onboarded is authorized to act for it.
      </p>

      <ApprovalQueue
        farms={farms.map((farm) => ({
          farmId: farm.farmId,
          name: farm.name,
          approved: farm.approved,
          approvedAt: farm.approvedAt?.toISOString() ?? null,
          approvedByEmail: farm.approvedByEmail,
        }))}
      />
    </AdminShell>
  );
}
