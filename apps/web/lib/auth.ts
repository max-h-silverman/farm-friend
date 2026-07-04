import { verifyMagicToken, type Principal, type Role } from "@farm-friend/core";

// Server-side principal resolution for web routes. In a full build this reads the session
// cookie, looks up the person + their roles in the DB (server-side, never client-supplied),
// and returns a Principal. Phase 0 wires the shape + the magic-link verification; the DB
// role lookup lands with auth-backed features. requireRole (from core) is called by each route.

const secret = () => process.env.MAGIC_LINK_SECRET ?? "dev-only-change-me";

/** Resolve the caller into a Principal, or null if unauthenticated. Server-side only. */
export async function resolvePrincipal(req: Request): Promise<Principal | null> {
  // Session token via cookie or Authorization header; verified with the code-enforced signature.
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;

  const verified = verifyMagicToken(token, secret(), { now: () => new Date() });
  if (!verified.ok) return null;

  // NOTE: roles MUST be looked up server-side (DB) — never taken from the token/client.
  // Phase 0 returns a minimal principal; the DB-backed role lookup lands with F-009/F-005.
  const roles: Role[] = [];
  return { personId: verified.email, tenantId: "viga", roles };
}
