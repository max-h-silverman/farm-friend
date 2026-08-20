import {
  restoreFarm,
  restoreFarmFromTrash,
  retireFarm,
  saveFarmDetails,
  trashFarm,
} from "@farm-friend/db";
import { requireAdministrator } from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

// VIGA's decisions about one farm: correct its details, take it off the map, put it in the
// trash, put it back.
//
// The mutation resolves the administrator server-side through the shared `requireAdministrator`
// guard (lib/admin-guard.ts), which every admin route uses. Identity is never read from the
// request; see lib/auth.ts.
//
// **Approval and test-farm marking are gone from here** (F-124, max 2026-08-19). What is removed
// is this route's ability to reach them, because the console no longer offers either control.
// Publication still refuses with `not_approved`, so the gate itself is untouched; with no
// toggle, nothing can revoke.
//
// The three writers behind them, and what is true of each after this change (measured, not
// assumed):
//   - `approveFarm` — still called in production, by onboarding redemption (`farmer.ts` inserts
//     `seller_approvals` on redeem). That is why removing the toggle is safe: every farm that
//     onboards is approved without VIGA doing anything.
//   - `setTestFarm` — now reached only from tests and by hand. Marking a farm is a script-only
//     operation from here on, which max was told and accepted. `Josie's Farm` is marked today
//     and deliberately hidden, so the WRITER must stay: it is how that gets undone.
//   - `revokeFarmApproval` — now has NO production caller at all. Kept because it is the only
//     way to reverse an approval should VIGA ever need to, and deleting it would leave the
//     `not_approved` refusal permanently unreachable. Filed as B-094 rather than left silent.
//
// Note what this route does NOT do: it never touches inventory, ranking, or any published
// listing. The farmer still owns what her listing says (Golden Rule #1).

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
  // Every act here is the same KIND — VIGA recording a decision about one farm — so they share
  // a route rather than each getting one, which would be several places to remember the session
  // guard. Trash and its restore join on that reasoning (F-124).
  const action =
    body.action === "retire" ||
    body.action === "restore" ||
    body.action === "trash" ||
    body.action === "restore_from_trash" ||
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
    action === "retire"
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
        : action === "trash"
          ? await trashFarm(db, {
              farmId,
              administratorId: caller.administratorId,
              occurredAt,
            })
          : action === "restore_from_trash"
            ? await restoreFarmFromTrash(db, {
                farmId,
                administratorId: caller.administratorId,
                occurredAt,
              })
            : await saveFarmDetails(db, {
                farmId,
                administratorId: caller.administratorId,
                name: name as string,
                description: description as string | null,
                occurredAt,
              });

  const status =
    result.status === "retired" ||
    result.status === "restored" ||
    result.status === "trashed" ||
    result.status === "saved"
      ? 200
      : // `unknown_subject` is the trash writer's name for what `unknown_farm` names: no such
        // record. One answer for one cause.
        result.status === "unknown_farm" || result.status === "unknown_subject"
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
