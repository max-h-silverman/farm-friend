import { headers } from "next/headers";
import Link from "next/link";
import { hasRole } from "@farm-friend/core";
import { listFlagsForReview } from "@farm-friend/db";
import { resolvePrincipal } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { FlagQueue } from "./flag-queue";

// The flag review surface (F-030).
//
// Server-rendered per request, and the authorization check happens HERE on the server. A
// caller without a live administrator session sees the signed-out page and no flag data,
// because the data is never fetched for them in the first place — the same shape as `/admin`.

export const dynamic = "force-dynamic";

export default async function FlagsPage() {
  const cookie = headers().get("cookie") ?? "";
  const principal = await resolvePrincipal(
    new Request("https://farm-friend.internal/admin/flags", {
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
  const flags = await listFlagsForReview(db, { status: "all" });

  return (
    <main className="admin">
      <header className="admin-header">
        <h1>Flag review</h1>
        <p className="admin-note">Signed in as {principal.personId}</p>
      </header>

      <nav className="admin-nav">
        <Link href="/admin">Farm approval</Link>
        <Link href="/admin/reports">Stock-out reports</Link>
        <Link href="/admin/stand-data">Stand data</Link>
      </nav>

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
    </main>
  );
}
