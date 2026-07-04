import { AuthorizationError, requireRole, type Principal } from "@farm-friend/core";
import { resolvePrincipal } from "../../../../lib/auth";

// Example admin route: the flag-review queue (built out in F-009). Demonstrates the
// server-side role check EVERY protected route performs: resolve the principal server-side,
// then requireRole. Never trust a client-supplied role.

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  let principal: Principal | null;
  try {
    principal = await resolvePrincipal(req);
    requireRole(principal, "staff"); // admins pass by implication
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    throw e;
  }
  // Phase 0: the queue itself lands in F-009; this proves the guard.
  return Response.json({ flags: [], viewer: principal!.personId });
}
