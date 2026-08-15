import {
  approveFarm,
  restoreFarm,
  retireFarm,
  revokeFarmApproval,
  saveFarmDetails,
  setTestFarm,
} from "@farm-friend/db";
import { requireAdministrator } from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

// The farm approval surface (F-025a) — the write nothing in the product could previously
// perform. Publication refuses with `not_approved` unless a live `seller_approvals` row
// exists, and until this route the only way to create one was hand-written SQL.
//
// The mutation resolves the administrator server-side through the shared `requireAdministrator`
// guard (lib/admin-guard.ts), which every admin route uses. Identity is never read from the
// request; see lib/auth.ts.
//
// Note what this route does NOT do: it never touches inventory, ranking, or any published
// listing. Approval gates whether a farm may publish; the farmer still owns what it says
// (Golden Rule #1).

export const dynamic = "force-dynamic";

/** Approve or revoke a farm. The acting administrator comes from the session, never the body. */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: {
    farmId?: unknown;
    action?: unknown;
    name?: unknown;
    description?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const farmId = typeof body.farmId === "string" ? body.farmId : null;
  // F-074 adds two more actions here rather than a route of their own: marking a farm as a
  // test farm is the same KIND of act as approving one — VIGA recording a decision about a
  // farm — and a second route would be a second place to remember the session guard. Taking
  // a farm down and correcting its details join for the same reason.
  const action =
    body.action === "approve" ||
    body.action === "revoke" ||
    body.action === "mark_test" ||
    body.action === "unmark_test" ||
    body.action === "retire" ||
    body.action === "restore" ||
    body.action === "save_details"
      ? body.action
      : null;
  if (farmId === null || action === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Only `save_details` carries a payload, and it is read here rather than inside the
  // dispatch so an unparseable name fails before any authority is claimed.
  const name = typeof body.name === "string" ? body.name : null;
  const description =
    typeof body.description === "string"
      ? body.description
      : body.description === null
        ? null
        : undefined;
  if (action === "save_details" && (name === null || description === undefined)) {
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
      : action === "revoke"
        ? await revokeFarmApproval(db, {
            farmId,
            administratorId: caller.administratorId,
            occurredAt,
          })
        : action === "retire"
          ? await retireFarm(db, {
              farmId,
              administratorId: caller.administratorId,
              occurredAt,
            })
          : action === "restore"
            ? await restoreFarm(db, {
                farmId,
                administratorId: caller.administratorId,
                occurredAt,
              })
            : action === "save_details"
              ? await saveFarmDetails(db, {
                  farmId,
                  administratorId: caller.administratorId,
                  name: name as string,
                  description: description as string | null,
                  occurredAt,
                })
              : await setTestFarm(db, {
                  farmId,
                  isTestFarm: action === "mark_test",
                  administratorId: caller.administratorId,
                  occurredAt,
                });

  const status =
    result.status === "approved" ||
    result.status === "revoked" ||
    result.status === "marked" ||
    result.status === "unmarked" ||
    result.status === "retired" ||
    result.status === "restored" ||
    result.status === "saved"
      ? 200
      : result.status === "unknown_farm"
        ? 404
        : result.status === "not_an_administrator"
          ? 403
          : // A blank name is the caller's mistake, not a conflict: 422 lets the screen say
            // which field is wrong rather than offering a reload that would not help.
            result.status === "invalid_name"
            ? 422
            : 409;
  return Response.json({ status: result.status }, { status });
}
