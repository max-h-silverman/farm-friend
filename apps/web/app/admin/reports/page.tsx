import { headers } from "next/headers";
import { listStockOutReports } from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { ReportQueue } from "./report-queue";
import { AdminShell, SignedOutAdmin } from "../admin-shell";

// The stock-out report surface (F-030). Same server-side authorization shape as `/admin`:
// an unauthenticated caller is never handed report data, because it is never fetched.

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin/reports", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const reports = await listStockOutReports(db, { status: "all" });

  return (
    <AdminShell currentPath="/admin/reports">
      <p className="admin-note">
        Customers can let us know when an item may be sold out. Take a look, then contact the
        farmer if a stand needs an update. These reports never change the map.
      </p>

      <ReportQueue
        reports={reports.map((report) => ({
          reportId: report.reportId,
          farmName: report.farmName,
          salesLocationName: report.salesLocationName,
          itemText: report.itemText,
          status: report.status,
          reviewedByEmail: report.reviewedByEmail,
          reportedAt: report.reportedAt.toISOString(),
        }))}
      />
    </AdminShell>
  );
}
