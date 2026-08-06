import { headers } from "next/headers";
import { listFlagsForReview, listStandDataFlags } from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { FlagQueue } from "./flag-queue";
import { StandDataQueue } from "../stand-data/stand-data-queue";
import { AdminShell, SignedOutAdmin } from "../admin-shell";

// The flag review surface (F-030).
//
// Server-rendered per request, and the authorization check happens HERE on the server. A
// caller without a live administrator session sees the signed-out page and no flag data,
// because the data is never fetched for them in the first place — the same shape as `/admin`.

export const dynamic = "force-dynamic";

export default async function FlagsPage() {
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin/flags", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const [flags, standDataFlags] = await Promise.all([
    listFlagsForReview(db, { status: "open" }),
    listStandDataFlags(db, { status: "open" }),
  ]);

  return (
    <AdminShell currentPath="/admin/flags">
      <h2 className="admin-section-title">Messages needing review</h2>
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
          hasReadableThread: flag.hasReadableThread,
        }))}
      />

      <h2 className="admin-section-title">Listing questions</h2>
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
    </AdminShell>
  );
}
