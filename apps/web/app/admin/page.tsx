import { headers } from "next/headers";
import Link from "next/link";
import {
  listFarmsAwaitingOnboarding,
  listFarmsForApproval,
  listFlagsForReview,
  listOpenFarmerOnboardingRequests,
  listStandDataFlags,
  listStockOutReports,
} from "@farm-friend/db";
import { resolveAdministrator } from "../../lib/auth";
import { publicReadContext } from "../../lib/public-context";
import { AdminShell, SignedOutAdmin } from "./admin-shell";

// The VIGA operator surface (F-025a): sign in, then see what needs deciding.
//
// Server-rendered per request, and the authorization check happens HERE on the server — not
// in the browser component, which can only ever be a convenience. A caller without a live
// administrator session sees the signed-out page and no farm data, because the data is never
// fetched for them in the first place.

export const dynamic = "force-dynamic";

/**
 * The desk: what needs a decision, and nothing else.
 *
 * Reference records — the farms, their stands, the test-farm flags — moved to `/admin/farms`,
 * where one card owns everything about a farm. This page had grown into a dashboard that
 * mixed pending work with browsable records, so an operator arriving with a task had to know
 * which disclosure hid it.
 */
export default async function AdminPage() {
  // Next's server components do not hand a Request to a page, so the incoming cookie header
  // is rebuilt into one for the same `resolveAdministrator` every API route uses. One code path
  // resolves administrator identity, not two that could drift apart.
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db, clock } = publicReadContext();
  const [farms, farmerRequests, flags, listingQuestions, stockReports, awaiting] =
    await Promise.all([
      listFarmsForApproval(db),
      listOpenFarmerOnboardingRequests(db),
      listFlagsForReview(db, { status: "open" }),
      listStandDataFlags(db, { status: "open" }),
      listStockOutReports(db, { status: "open" }),
      listFarmsAwaitingOnboarding(db, clock.now()),
    ]);
  const work = [
    // F-067 — approval is now the EXCEPTION, not the routine step. An invited farmer's farm is
    // approved by their own redemption, so anything landing here arrived by one of the two
    // paths that still need a person: an invitation naming no farm, or one whose agreement was
    // never ticked. (A bare uninvited SIGNUP was a third until F-080 removed the keyword.)
    { label: "Farms waiting for approval", count: farms.filter((farm) => !farm.approved && !farm.retired).length, href: "/admin/farms", description: "Only farms that signed up without an invitation. Invited farmers are approved automatically." },
    // Counted here for the first time. This is the queue that is routinely NOT empty, and it
    // was reachable only by navigating to a screen that did not say it had work waiting.
    { label: "Farms nobody can update", count: awaiting.length, href: "/admin/farms", description: "Send the farmer a setup link so they can take over their own listing." },
    { label: "Farmer access requests", count: farmerRequests.length, href: "/admin/farmers", description: "Give verified farm operators access to update their stands." },
    { label: "Messages", count: flags.length + listingQuestions.length, href: "/admin/messages", description: "Customer messages and questions about VIGA’s own records." },
    { label: "Stock-outs", count: stockReports.length, href: "/admin/messages#stock-outs", description: "Customers reporting a stand looked empty." },
  ];
  const totalWork = work.reduce((total, item) => total + item.count, 0);

  return (
    <AdminShell currentPath="/admin">
      <section className="admin-work" aria-labelledby="needs-attention-heading">
        <h2 id="needs-attention-heading" className="admin-section-title">Needs attention</h2>
        {totalWork === 0 ? (
          <p className="admin-empty-state">Nothing needs a decision right now.</p>
        ) : (
          <ul className="admin-work-list">
            {work.filter((item) => item.count > 0).map((item) => (
              <li key={item.label}>
                <Link href={item.href}>
                  <span>
                    <strong>{item.label}</strong>
                    <span>{item.description}</span>
                  </span>
                  <span className="admin-count" aria-label={`${item.count} ${item.label.toLowerCase()}`}>{item.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

    </AdminShell>
  );
}
