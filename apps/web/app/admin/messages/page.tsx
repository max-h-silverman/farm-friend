import { headers } from "next/headers";
import {
  listFlagsForReview,
  listStandDataFlags,
  listStockOutReports,
} from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { FlagQueue } from "../flags/flag-queue";
import { ReportQueue } from "../reports/report-queue";
import { StandDataQueue } from "../stand-data/stand-data-queue";
import { AdminShell, SignedOutAdmin } from "../admin-shell";

// Everything a person sent us, on one screen.
//
// The three queues here were three separate destinations — "Customer reports", "Stock
// reports", and an unreachable `/admin/stand-data` — with names a volunteer could not tell
// apart: a stock-out report IS a customer report, and neither name said which was which.
//
// They are the same shape: an inbound signal, a required note, a recorded decision that
// changes nothing customers see. All three already carried the same boundary disclaimer.
// One screen, three sections, one nav entry.
//
// Same server-side authorization shape as every other admin page.

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin/messages", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const [flags, standDataFlags, reports] = await Promise.all([
    listFlagsForReview(db, { status: "open" }),
    listStandDataFlags(db, { status: "open" }),
    listStockOutReports(db, { status: "open" }),
  ]);

  return (
    <AdminShell currentPath="/admin/messages">
      <section aria-labelledby="flags-heading">
        <h2 id="flags-heading" className="admin-section-title">
          Messages needing review
        </h2>
        <FlagQueue
          flags={flags.map((flag) => ({
            flagId: flag.flagId,
            senderMask: flag.senderMask,
            reasonCode: flag.reasonCode,
            status: flag.status,
            dispositionCode: flag.dispositionCode,
            disposedByEmail: flag.disposedByEmail,
            disposedAt: flag.disposedAt?.toISOString() ?? null,
            createdAt: flag.createdAt.toISOString(),
            reporterEmail: flag.reporterEmail,
            reporterEmailMask: flag.reporterEmailMask,
            hasReadableThread: flag.hasReadableThread,
          }))}
        />
      </section>

      <section id="stock-outs" aria-labelledby="stock-outs-heading">
        <h2 id="stock-outs-heading" className="admin-section-title">
          Stock-outs
        </h2>
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
      </section>

      <section id="listing-questions" aria-labelledby="listing-questions-heading">
        <h2 id="listing-questions-heading" className="admin-section-title">
          Questions about our records
        </h2>
        <StandDataQueue
          flags={standDataFlags.map((flag) => ({
            flagId: flag.flagId,
            standName: flag.standName,
            reason: flag.reason,
            sourceText: flag.sourceText,
            resolutionNote: flag.resolutionNote,
            resolvedByEmail: flag.resolvedByEmail,
            createdAt: flag.createdAt.toISOString(),
          }))}
        />
      </section>
    </AdminShell>
  );
}
