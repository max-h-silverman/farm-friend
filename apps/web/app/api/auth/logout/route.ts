import { hashSessionToken } from "@farm-friend/core";
import { revokeAdminSession } from "@farm-friend/db";
import { publicReadContext } from "../../../../lib/public-context";
import {
  clearSessionCookie,
  sessionTokenFromRequest,
} from "../../../../lib/admin-auth";
import { isTrustedAdminMutationSource } from "../../../../lib/admin-guard";

// Ending a session (F-025a). Two things must happen, and only one of them is the browser's:
// the durable record is revoked server-side, and the cookie is cleared. Clearing the cookie
// alone would leave a working credential behind for anyone who had copied it.
//
// No role check: ending your own session is not a privileged act, and requiring authority to
// log out would strand a caller whose administrator was just revoked.

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!isTrustedAdminMutationSource(req)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const token = sessionTokenFromRequest(req);
  if (token !== null) {
    const { db, clock } = publicReadContext();
    await revokeAdminSession(db, {
      tokenHash: hashSessionToken(token),
      occurredAt: clock.now(),
    });
  }
  // Always clear the cookie, and always answer the same way: whether a session existed is
  // not information this endpoint needs to reveal.
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearSessionCookie() },
  });
}
