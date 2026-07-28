import { listStandDataFlags, resolveStandDataFlag } from "@farm-friend/db";
import {
  requireAdministrator,
  statusForWriteResult,
} from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

// The stand-data flag queue (F-037): the seeder's unresolved questions about VIGA's export.
//
// The seeder raises one of these when the source data needs a human decision — contradictory
// hours, an unresolvable season, a possible closure — and until this route the three real
// flags were visible only by SQL. Resolution records the operator's decision and nothing
// else: there is deliberately no action here that edits hours, season, offerings, or any
// other listing fact, because an operator edit to a listing is a separate capability with
// its own authority story, and "fix it while I'm here" is how a decision queue becomes an
// unaudited editing surface.

export const dynamic = "force-dynamic";

/** The queue. `?status=all` includes flags already resolved. */
export async function GET(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  const status =
    new URL(req.url).searchParams.get("status") === "all" ? "all" : "open";
  const { db } = publicReadContext();
  const flags = await listStandDataFlags(db, { status });

  return Response.json({
    flags: flags.map((flag) => ({
      flagId: flag.flagId,
      salesLocationId: flag.salesLocationId,
      standName: flag.standName,
      reason: flag.reason,
      sourceText: flag.sourceText,
      resolutionNote: flag.resolutionNote,
      resolvedByEmail: flag.resolvedByEmail,
      resolvedAt: flag.resolvedAt?.toISOString() ?? null,
      createdAt: flag.createdAt.toISOString(),
    })),
  });
}

/** Resolve a flag with the operator's note. The actor comes from the session, never the body. */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: { flagId?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const flagId = typeof body.flagId === "string" ? body.flagId : null;
  // The note is REQUIRED and non-blank: a resolution with no recorded decision would make
  // this queue a dismiss button, and the decision is the thing the audit trail is for.
  const note =
    typeof body.note === "string" && body.note.trim() !== ""
      ? body.note.trim()
      : null;
  if (flagId === null || note === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { db, clock } = publicReadContext();
  const result = await resolveStandDataFlag(db, {
    flagId,
    administratorId: caller.administratorId,
    resolutionNote: note,
    occurredAt: clock.now(),
  });

  return Response.json(
    { status: result.status },
    { status: statusForWriteResult(result.status) },
  );
}
