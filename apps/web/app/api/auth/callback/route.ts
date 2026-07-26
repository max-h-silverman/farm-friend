import {
  ADMIN_SESSION_TTL_MS,
  hashSessionToken,
  issueSessionToken,
  verifyMagicToken,
} from "@farm-friend/core";
import { createAdminSession, findAdministratorByEmail } from "@farm-friend/db";
import { publicReadContext } from "../../../../lib/public-context";
import { serializeSessionCookie } from "../../../../lib/admin-auth";

// The magic-link callback: a verified email becomes a durable, revocable session (F-025a).
//
// The order here is the security of the whole admin surface, so it is worth stating:
//
//   1. Verify the signature and expiry of the link. A forged or stale link stops here.
//   2. Look the email up in `administrators`. **This is the authorization step.** Holding a
//      valid link proves you control an email address; it does NOT make you an operator.
//      Only a row someone deliberately created does that.
//   3. Mint session material and store only its hash.
//
// Step 2 is why login is not first-user-wins: on a public URL that would let whoever arrives
// first grant themselves authority over every farm's published state. Administrators are
// provisioned in the database (docs/RUNBOOK.md §bootstrap the first administrator).
//
// A non-administrator gets the same 401 as a bad token — the response never reveals whether
// an address is an operator's.

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const secret = process.env.MAGIC_LINK_SECRET;
  if (secret === undefined || secret.trim() === "") {
    // Fail closed: without a configured secret every signature check is against a guessable
    // default, which is an open door to the approval surface.
    return Response.json({ authenticated: false }, { status: 503 });
  }

  const verified = verifyMagicToken(token, secret, { now: () => new Date() });
  if (!verified.ok) {
    return Response.json({ authenticated: false }, { status: 401 });
  }

  const { db, clock } = publicReadContext();
  const administrator = await findAdministratorByEmail(db, verified.email);
  if (administrator === null) {
    // Deliberately indistinguishable from an invalid token.
    return Response.json({ authenticated: false }, { status: 401 });
  }

  const sessionToken = issueSessionToken();
  const issuedAt = clock.now();
  const created = await createAdminSession(db, {
    tokenHash: hashSessionToken(sessionToken),
    administratorId: administrator.administratorId,
    issuedAt,
  });
  if (created.status !== "created") {
    return Response.json({ authenticated: false }, { status: 401 });
  }

  // The token reaches the browser exactly once, in the Set-Cookie header, and is never put
  // in the body — a JSON credential is one copied curl command away from a shared secret.
  return new Response(null, {
    status: 303,
    headers: {
      location: "/admin",
      "set-cookie": serializeSessionCookie(sessionToken, ADMIN_SESSION_TTL_MS),
    },
  });
}
