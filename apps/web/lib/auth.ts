import { hashSessionToken, type Principal } from "@farm-friend/core";
import { resolveAdminSession } from "@farm-friend/db";
import { publicReadContext } from "./public-context";
import { sessionTokenFromRequest } from "./admin-auth";

// Server-side principal resolution for web routes (F-025a).
//
// This used to verify a magic-link token and then return an EMPTY role list, so `hasRole`
// denied everything and no admin route could ever work. It now resolves the durable session
// against the database on every request.
//
// Two properties matter and are load-bearing:
//
//   - **Roles are looked up server-side, never taken from the token or the client.** The
//     cookie carries opaque random material and nothing else — no email, no role, no claim.
//     Everything about who the caller is comes from the database row the token's hash finds.
//   - **The lookup is per-request, so revocation is immediate.** Revoking an administrator
//     or a session takes effect on their next request rather than whenever a self-contained
//     token would have expired. That is the reason a session is a record, not a signature.
//
// `requireRole` (from core) is called by each protected route; this only says who the caller
// is, never what they may do.

/** Resolve the caller into a Principal, or null if unauthenticated. Server-side only. */
export async function resolvePrincipal(req: Request): Promise<Principal | null> {
  const token = sessionTokenFromRequest(req);
  if (token === null) return null;

  const { db, clock } = publicReadContext();
  // Only the hash is ever sent to the database, and only the hash is stored there.
  return resolveAdminSession(db, {
    tokenHash: hashSessionToken(token),
    now: clock.now(),
  });
}
