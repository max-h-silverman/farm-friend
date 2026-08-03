import { saveFarmBucksStatus, type FarmBucksStatus } from "@farm-friend/db";
import { requireAdministrator } from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

export const dynamic = "force-dynamic";

/** Save VIGA's reviewed Farm Bucks status for one stand. */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: { standId?: unknown; farmBucksStatus?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const standId = typeof body.standId === "string" ? body.standId : null;
  const status = ["accepts", "does_not_accept", "not_eligible"].includes(body.farmBucksStatus as string)
    ? body.farmBucksStatus as FarmBucksStatus
    : null;
  if (standId === null || status === null) return Response.json({ error: "invalid_request" }, { status: 400 });

  const { db, clock } = publicReadContext();
  const result = await saveFarmBucksStatus(db, {
    standId,
    administratorId: caller.administratorId,
    status,
    occurredAt: clock.now(),
  });
  const httpStatus = result.status === "saved" ? 200 : result.status === "unknown_stand" ? 404 : 403;
  return Response.json(result, { status: httpStatus });
}
