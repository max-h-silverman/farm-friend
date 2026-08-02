import { triageStockOutReport } from "@farm-friend/db";
import {
  requireAdministrator,
  statusForWriteResult,
} from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

// The stock-out report queue (F-030): the reader these private customer signals never had.
//
// Reports accumulated with nobody able to see them, which meant a farmer's prompt could go
// unanswered and no operator could notice. This route makes them visible and triageable.
//
// Golden Rule #1 is the constraint that shapes it: a customer's report NEVER changes the map,
// answers, or ranking. Triage records that a human looked — reviewed or dismissed — and
// nothing more. The item stays listed until the FARMER's confirmed revision says otherwise.
// A "remove this item" action here would be the customer editing the farmer's listing through
// an operator, which is the failure the whole private-signal design exists to prevent.
//
// A report stores no reporter, so there is nothing to mask: the queue carries farm, stand,
// item, and status, and joins nowhere that could acquire a phone.

export const dynamic = "force-dynamic";

/** Mark a report reviewed or dismissed. The acting administrator comes from the session. */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: { reportId?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const reportId = typeof body.reportId === "string" ? body.reportId : null;
  const status =
    body.action === "review"
      ? ("reviewed" as const)
      : body.action === "dismiss"
        ? ("dismissed" as const)
        : null;
  if (reportId === null || status === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { db, clock } = publicReadContext();
  const result = await triageStockOutReport(db, {
    reportId,
    administratorId: caller.administratorId,
    status,
    occurredAt: clock.now(),
  });

  return Response.json(
    { status: result.status },
    { status: statusForWriteResult(result.status) },
  );
}
