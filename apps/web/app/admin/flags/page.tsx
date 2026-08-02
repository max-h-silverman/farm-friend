import { headers } from "next/headers";
import { listFlagsForReview } from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { FlagQueue } from "./flag-queue";
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
  const flags = await listFlagsForReview(db, { status: "all" });

  return (
    <AdminShell currentPath="/admin/flags" title="Flag review" signedInAs={administrator.email}>
      <p className="admin-note">
        Someone texted <strong>FLAG</strong>. Read the thread, take whatever action is needed
        outside the system, then record what you did. Phone numbers are shown masked.
        Resolving or dismissing a flag also releases its messages to the normal deletion
        schedule, so review the thread before you close it.
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
    </AdminShell>
  );
}
