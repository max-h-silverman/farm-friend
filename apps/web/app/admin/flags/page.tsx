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
    listFlagsForReview(db, { status: "all" }),
    listStandDataFlags(db, { status: "all" }),
  ]);

  return (
    <AdminShell currentPath="/admin/flags" title="Needs attention" signedInAs={administrator.email}>
      <p className="admin-note">
        Someone has asked for help through <strong>FLAG</strong>. Read the conversation, help as
        needed, then leave a note about what happened. Phone numbers are partly hidden.
      </p>

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
      <p className="admin-note">
        These are places where Farm Friend needs a little help reading a listing. Leave a note
        with your decision; it will not change what&apos;s on the map.
      </p>
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
