import { hashSessionToken } from "@farm-friend/core";
import { resolveAdminSession, type ResolvedAdministrator } from "@farm-friend/db";
import { publicReadContext } from "./public-context";
import { sessionTokenFromRequest } from "./admin-auth";

// Server-side administrator resolution for web routes (F-025a).
//
// Two properties matter and are load-bearing:
//
//   - **Administrator identity is looked up server-side, never taken from the token or the
//     client.** The cookie carries opaque random material and nothing else — no email or claim.
//     Everything about the caller comes from the database row the token's hash finds.
//   - **The lookup is per-request, so revocation is immediate.** Revoking an administrator
//     or a session takes effect on their next request rather than whenever a self-contained
//     token would have expired. That is the reason a session is a record, not a signature.
//
/** Resolve the caller to the one administrator identity, or null. Server-side only. */
export async function resolveAdministrator(
  req: Request,
): Promise<ResolvedAdministrator | null> {
  const token = sessionTokenFromRequest(req);
  if (token === null) return null;

  const { db, clock } = publicReadContext();
  // Only the hash is ever sent to the database, and only the hash is stored there.
  return resolveAdminSession(db, {
    tokenHash: hashSessionToken(token),
    now: clock.now(),
  });
}
