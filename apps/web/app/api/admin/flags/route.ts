import { disposeFlag } from "@farm-friend/db";
import {
  requireAdministrator,
  statusForWriteResult,
} from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

// The flag review queue (F-030) — the FLAG safety rail's human half.
//
// This route used to return `{ flags: [] }` and read nothing. FLAG is a registered 10DLC
// commitment, so a flag no human could act on made the rail nominal; it was also why F-026's
// retention exemption never terminated, since nothing moved a flag out of `open`.
//
// The mutation resolves the administrator server-side through `requireAdministrator`. The acting
// administrator comes from the SESSION, never the request body — a caller who names someone
// else must not be able to act as them, and the audit trail records who really decided.
//
// Note what this route cannot do: nothing here touches inventory, ranking, or any published
// listing (Golden Rule #1). Disposing a flag records that a person reviewed a message.

export const dynamic = "force-dynamic";

/** Resolve or dismiss a flag. Both dispositions end the retention exemption. */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: {
    flagId?: unknown;
    action?: unknown;
    dispositionCode?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const flagId = typeof body.flagId === "string" ? body.flagId : null;
  const disposition =
    body.action === "resolve"
      ? ("resolved" as const)
      : body.action === "dismiss"
        ? ("dismissed" as const)
        : null;
  // A disposition with no reason is an audit record that does not say why, so it is refused
  // rather than defaulted — a default would be the route inventing the operator's reasoning.
  const dispositionCode =
    typeof body.dispositionCode === "string" && body.dispositionCode.trim() !== ""
      ? body.dispositionCode.trim()
      : null;

  if (flagId === null || disposition === null || dispositionCode === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { db, clock } = publicReadContext();
  const result = await disposeFlag(db, {
    flagId,
    administratorId: caller.administratorId,
    disposition,
    dispositionCode,
    occurredAt: clock.now(),
  });

  return Response.json(
    { status: result.status },
    { status: statusForWriteResult(result.status) },
  );
}
