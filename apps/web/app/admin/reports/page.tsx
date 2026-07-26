import { headers } from "next/headers";
import Link from "next/link";
import { hasRole } from "@farm-friend/core";
import { listStockOutReports } from "@farm-friend/db";
import { resolvePrincipal } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { ReportQueue } from "./report-queue";

// The stock-out report surface (F-030). Same server-side authorization shape as `/admin`:
// an unauthenticated caller is never handed report data, because it is never fetched.

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const cookie = headers().get("cookie") ?? "";
  const principal = await resolvePrincipal(
    new Request("https://farm-friend.internal/admin/reports", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (principal === null || !hasRole(principal, "admin")) {
    return (
      <main className="admin">
        <h1>Farm Friend admin</h1>
        <p>
          You are not signed in. Open the magic link sent to your VIGA email address to
          continue.
        </p>
      </main>
    );
  }

  const { db } = publicReadContext();
  const reports = await listStockOutReports(db, { status: "all" });

  return (
    <main className="admin">
      <header className="admin-header">
        <h1>Stock-out reports</h1>
        <p className="admin-note">Signed in as {principal.personId}</p>
      </header>

      <nav className="admin-nav">
        <Link href="/admin">Farm approval</Link>
        <Link href="/admin/flags">Flag review</Link>
      </nav>

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
    </main>
  );
}
