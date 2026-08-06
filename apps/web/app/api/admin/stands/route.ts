import {
  restoreStand,
  retireStand,
  saveFarmBucksStatus,
  type FarmBucksStatus,
} from "@farm-friend/db";
import { requireAdministrator } from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

// The per-stand administrator surface. Two acts live here because they are the same KIND of
// act — VIGA recording a decision about one stand — and a second route would be a second
// place to remember the session guard.
//
// Note what this route does NOT do, deliberately: it never touches inventory, a listing, or a
// published revision. Retiring a stand takes it off the public surfaces and closes it to new
// publication; what the farmer already published stays exactly as they published it
// (Golden Rule #1).

export const dynamic = "force-dynamic";

/**
 * Record a Farm Bucks decision, or retire/restore a stand.
 *
 * The acting administrator comes from the SESSION, never the request body: a caller naming
 * someone else must not be able to act as them, and the audit trail records who really did it.
 * Each act re-reads that authority inside its own transaction.
 */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: { standId?: unknown; farmBucksStatus?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const standId = typeof body.standId === "string" ? body.standId : null;
  if (standId === null) return Response.json({ error: "invalid_request" }, { status: 400 });

  const { db, clock } = publicReadContext();
  const occurredAt = clock.now();

  if (body.action !== undefined) {
    const action =
      body.action === "retire" || body.action === "restore" ? body.action : null;
    if (action === null) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const result =
      action === "retire"
        ? await retireStand(db, {
            salesLocationId: standId,
            administratorId: caller.administratorId,
            occurredAt,
          })
        : await restoreStand(db, {
            salesLocationId: standId,
            administratorId: caller.administratorId,
            occurredAt,
          });
    return Response.json(result, { status: retirementStatusFor(result.status) });
  }

  const status = ["accepts", "does_not_accept", "not_eligible"].includes(body.farmBucksStatus as string)
    ? body.farmBucksStatus as FarmBucksStatus
    : null;
  if (status === null) return Response.json({ error: "invalid_request" }, { status: 400 });

  const result = await saveFarmBucksStatus(db, {
    standId,
    administratorId: caller.administratorId,
    status,
    occurredAt,
  });
  const httpStatus = result.status === "saved" ? 200 : result.status === "unknown_stand" ? 404 : 403;
  return Response.json(result, { status: httpStatus });
}

/**
 * One status table for both retirement acts, so a new one cannot answer inconsistently.
 *
 * `already_retired` / `not_retired` are 409 rather than 200: the caller's decision was NOT
 * recorded, and answering 200 would be a lie about an audit record.
 */
function retirementStatusFor(status: string): number {
  switch (status) {
    case "retired":
    case "restored":
      return 200;
    case "unknown_stand":
      return 404;
    case "not_an_administrator":
      return 403;
    default:
      return 409;
  }
}
