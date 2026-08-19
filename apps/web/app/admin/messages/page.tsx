import { headers } from "next/headers";
import { listFlagsForReview } from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { FlagQueue } from "../flags/flag-queue";
import { AdminShell, SignedOutAdmin } from "../admin-shell";

// Messages a person sent that need a human to read them.
//
// **One queue, not three** (max, 2026-08-19). This screen used to carry stock-outs and
// "Questions about our records" beside the flags, on the reading that all three were inbound
// signals with a recorded decision. They are not the same thing to a volunteer:
//
//   - a FLAG or an issue report is somebody writing to VIGA in words, and a person has to read
//     it. That is this screen;
//   - a stock-out is a signal about a listing, and the FARMER acts on it (Golden Rule #1).
//     Customers still report them and farmers are still told — what went is VIGA's queue, not
//     the feature (max, 2026-08-19);
//   - `stand_data_flags` was never a product surface. The SEEDER writes one when the original
//     VIGA spreadsheet carried availability text a human should check. Production holds four,
//     all resolved, from the initial load, and nothing in the running product creates another.
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
  const flags = await listFlagsForReview(db, { status: "open" });

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

    </AdminShell>
  );
}
