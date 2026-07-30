import { headers } from "next/headers";
import Link from "next/link";
import { hasRole } from "@farm-friend/core";
import { listStandDataFlags } from "@farm-friend/db";
import { resolvePrincipal } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { StandDataQueue } from "./stand-data-queue";

// The stand-data flag surface (F-037). Same server-side authorization shape as `/admin`:
// an unauthenticated caller is never handed queue data, because it is never fetched.

export const dynamic = "force-dynamic";

export default async function StandDataPage() {
  const cookie = headers().get("cookie") ?? "";
  const principal = await resolvePrincipal(
    new Request("https://farm-friend.internal/admin/stand-data", {
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
  const flags = await listStandDataFlags(db, { status: "all" });

  return (
    <main className="admin">
      <header className="admin-header">
        <h1>Stand data questions</h1>
        <p className="admin-note">Signed in as {principal.personId}</p>
      </header>

      <nav className="admin-nav">
        <Link href="/admin">Farm approval</Link>
        <Link href="/admin/flags">Flag review</Link>
        <Link href="/admin/reports">Stock-out reports</Link>
        <Link href="/admin/farmers">Farmer access</Link>
      </nav>

      <p className="admin-note">
        When VIGA&apos;s stand data contradicts itself — two different opening times, a season
        nobody can pin down, a note saying the stand closed — the loader records the question
        here instead of guessing. Resolving one records <strong>your decision</strong> for the
        record; it does not edit the listing. If the listing itself needs correcting, that
        happens through the farmer or a listing edit, not here.
      </p>

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
    </main>
  );
}
