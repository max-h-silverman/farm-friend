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
    <AdminShell
      currentPath="/admin/reports"
      title="Stock-out reports"
      signedInAs={administrator.email}
    >
      <p className="admin-note">
        Customers report privately when something looks sold out. These are{" "}
        <strong>signals, not corrections</strong> — marking one reviewed records that you
        looked, and changes nothing a customer sees. Only the farmer&apos;s own confirmed
        update changes a listing. If reports pile up for one stand, chase the farmer.
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
