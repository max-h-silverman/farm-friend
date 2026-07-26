import {
  approveFarm,
  listFarmsForApproval,
  revokeFarmApproval,
} from "@farm-friend/db";
import { requireAdministrator } from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

// The farm approval surface (F-025a) — the write nothing in the product could previously
// perform. Publication refuses with `not_approved` unless a live `farm_approvals` row
// exists, and until this route the only way to create one was hand-written SQL.
//
// Both handlers resolve the principal server-side through the shared `requireAdministrator`
// guard (lib/admin-guard.ts), which every admin route uses. The role is never read from the
// request; see lib/auth.ts.
//
// Note what this route does NOT do: it never touches inventory, ranking, or any published
// listing. Approval gates whether a farm may publish; the farmer still owns what it says
// (Golden Rule #1).

export const dynamic = "force-dynamic";

/** The approval queue: every farm and its current approval state. */
export async function GET(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  const { db } = publicReadContext();
  const farms = await listFarmsForApproval(db);
  return Response.json({
    farms: farms.map((farm) => ({
      farmId: farm.farmId,
      name: farm.name,
      approved: farm.approved,
      approvedAt: farm.approvedAt?.toISOString() ?? null,
      approvedByEmail: farm.approvedByEmail,
    })),
  });
}

/** Approve or revoke a farm. The acting administrator comes from the session, never the body. */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: { farmId?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const farmId = typeof body.farmId === "string" ? body.farmId : null;
  const action = body.action === "approve" || body.action === "revoke" ? body.action : null;
  if (farmId === null || action === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { db, clock } = publicReadContext();
  const occurredAt = clock.now();
  // The administrator is the session's, never the request body's: a caller cannot act as
  // someone else by naming them, and the audit trail records who really did it.
  const result =
    action === "approve"
      ? await approveFarm(db, {
          farmId,
          administratorId: caller.administratorId,
          occurredAt,
        })
      : await revokeFarmApproval(db, {
          farmId,
          administratorId: caller.administratorId,
          occurredAt,
        });

  const status =
    result.status === "approved" || result.status === "revoked"
      ? 200
      : result.status === "unknown_farm"
        ? 404
        : result.status === "not_an_administrator"
          ? 403
          : 409;
  return Response.json({ status: result.status }, { status });
}
