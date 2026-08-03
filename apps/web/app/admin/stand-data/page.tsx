import { headers } from "next/headers";
import { listStandDataFlags } from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { StandDataQueue } from "./stand-data-queue";
import { AdminShell, SignedOutAdmin } from "../admin-shell";

// The stand-data flag surface (F-037). Same server-side authorization shape as `/admin`:
// an unauthenticated caller is never handed queue data, because it is never fetched.

export const dynamic = "force-dynamic";

export default async function StandDataPage() {
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin/stand-data", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const flags = await listStandDataFlags(db, { status: "open" });

  return (
    <AdminShell currentPath="/admin/stand-data">
      <header className="admin-page-intro">
        <h1>Listing questions</h1>
        <p className="admin-note">Record what VIGA decided. This does not change the map.</p>
      </header>
      <StandDataQueue
        flags={flags.map((flag) => ({
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
