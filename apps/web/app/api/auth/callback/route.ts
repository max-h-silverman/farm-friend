import { verifyMagicToken } from "@farm-friend/core";

// Magic-link callback. Verifies the signed, expiring token (code-enforced — never trusted from
// the client) and, in a full build, establishes a session. Phase 0 proves the verification path.

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const secret = process.env.MAGIC_LINK_SECRET ?? "dev-only-change-me";

  const result = verifyMagicToken(token, secret, { now: () => new Date() });
  if (!result.ok) {
    return Response.json({ authenticated: false, reason: result.reason }, { status: 401 });
  }
  // A full build sets a session cookie here; Phase 0 confirms the verified identity.
  return Response.json({ authenticated: true, email: result.email });
}
