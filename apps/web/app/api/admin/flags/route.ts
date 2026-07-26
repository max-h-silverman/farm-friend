import { AuthorizationError, requireRole, type Principal } from "@farm-friend/core";
import { resolvePrincipal } from "../../../../lib/auth";

// The flag-review queue's guard. The QUEUE ITSELF IS NOT BUILT — it is F-030, along with
// stock-out report visibility. This route currently proves only the server-side role check,
// and returns an empty list rather than pretending to be a review surface.
//
// Do not read the empty array as "there are no flags": nothing here reads the `flags` table.
// Until F-030 ships, a flag that arrives is durable and unreviewable, and F-026's retention
// exemption therefore retains its thread indefinitely (CLAUDE.md "Current State").

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  let principal: Principal | null;
  try {
    principal = await resolvePrincipal(req);
    requireRole(principal, "admin");
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    throw e;
  }
  return Response.json({ flags: [], viewer: principal!.personId });
}
