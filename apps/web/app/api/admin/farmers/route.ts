import {
  authorizeFarmer,
  issueFarmerLink,
  listFarmerAuthorizations,
  listOpenFarmerOnboardingRequests,
  revokeFarmerAuthorization,
} from "@farm-friend/db";
import { farmerLinkUrl } from "@farm-friend/core";
import { requireAdministrator } from "../../../../lib/admin-guard";
import { resolvePublicBaseUrl } from "../../../../lib/composition";
import { publicReadContext } from "../../../../lib/public-context";

// The farmer authorization surface (F-040) — VIGA's half of onboarding.
//
// **VIGA always approves.** A phone number proves possession of a phone, not ownership of a
// farm, so no automated path anywhere grants a farmer authority: a farmer's SIGNUP text only
// joins the queue this route reads, and the grant itself happens here, behind the session
// guard every admin route shares.
//
// This is also the "VIGA can SEE and REVOKE every farmer's access" half of the standing
// link's safety net. max chose a link that never expires, so revocation is the only thing
// standing between a leaked link and a farmer's listing — which makes this route part of the
// security design rather than an operator convenience.
//
// What this route does NOT do, deliberately: it never touches inventory, a listing, or a
// published record. Authorization gates whether a farmer MAY publish; the farmer still owns
// what their listing says, and still confirms every change (Golden Rule #1).

export const dynamic = "force-dynamic";

/** The queue: farmers waiting on VIGA, plus every authorization live or withdrawn. */
export async function GET(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  const { db } = publicReadContext();
  const [requests, authorizations] = await Promise.all([
    listOpenFarmerOnboardingRequests(db),
    listFarmerAuthorizations(db),
  ]);

  return Response.json({
    requests: requests.map((request) => ({
      requestId: request.requestId,
      // Masked at the query. A request carries no message text at all, so there is nothing
      // else here that could leak.
      senderMask: request.senderMask,
      requestedAt: request.requestedAt.toISOString(),
    })),
    authorizations: authorizations.map((authorization) => ({
      authorizationId: authorization.authorizationId,
      farmId: authorization.farmId,
      farmName: authorization.farmName,
      senderMask: authorization.senderMask,
      authorizedAt: authorization.authorizedAt.toISOString(),
      revokedAt: authorization.revokedAt?.toISOString() ?? null,
      // Whether a live link EXISTS — never the link. The queue must not become a place to
      // read a farmer's standing credential off a screen.
      hasLiveLink: authorization.hasLiveLink,
      stands: authorization.stands,
      liveLinkStand: authorization.liveLinkStand,
    })),
  });
}

/**
 * Authorize a farmer, revoke one, or issue a fresh standing link.
 *
 * The acting administrator comes from the SESSION, never the request body: a caller naming
 * someone else must not be able to act as them, and the audit trail records who really did
 * it. Every one of these three is re-checked inside its own transaction.
 *
 * **`issue_link` returns the token exactly once, in this response, and nowhere else.** It is
 * never stored raw and never appears in the queue — so an operator who navigates away has to
 * issue a new one, which is correct for a credential with no password behind it. In the
 * normal flow the farmer texts LINK and never involves an operator at all; this exists for
 * the farmer who cannot, and for VIGA setting someone up in person.
 */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: {
    action?: unknown;
    farmId?: unknown;
    requestId?: unknown;
    authorizationId?: unknown;
    salesLocationId?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const action =
    body.action === "authorize" ||
    body.action === "revoke" ||
    body.action === "issue_link"
      ? body.action
      : null;
  if (action === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { db, clock } = publicReadContext();
  const occurredAt = clock.now();

  if (action === "authorize") {
    const farmId = typeof body.farmId === "string" ? body.farmId : null;
    const requestId = typeof body.requestId === "string" ? body.requestId : null;
    if (farmId === null || requestId === null) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const result = await authorizeFarmer(db, {
      farmId,
      requestId,
      administratorId: caller.administratorId,
      occurredAt,
    });
    return Response.json({ status: result.status }, { status: statusFor(result.status) });
  }

  const authorizationId =
    typeof body.authorizationId === "string" ? body.authorizationId : null;
  if (authorizationId === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  if (action === "revoke") {
    const result = await revokeFarmerAuthorization(db, {
      authorizationId,
      administratorId: caller.administratorId,
      occurredAt,
    });
    return Response.json({ status: result.status }, { status: statusFor(result.status) });
  }

  const salesLocationId =
    typeof body.salesLocationId === "string" ? body.salesLocationId : null;
  if (salesLocationId === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const issued = await issueFarmerLink(db, {
    authorizationId,
    salesLocationId,
    occurredAt,
  });
  if (issued.status !== "issued") {
    return Response.json(
      { status: issued.status },
      { status: statusFor(issued.status) },
    );
  }
  // The one and only time this value is readable. It is not stored raw, so it cannot be
  // recovered from the database or shown again by reloading the queue.
  //
  // Returned as the finished URL rather than the bare token, built against the CONFIGURED
  // origin — the same rule the texted link follows. An operator copying a token and pasting
  // it into a hand-assembled URL is one typo away from handing a farmer a dead link, and one
  // wrong host away from handing it to somewhere else entirely.
  return Response.json({
    status: "issued",
    link: farmerLinkUrl(resolvePublicBaseUrl(process.env), issued.token),
  });
}

/** One status table for all three actions, so a new one cannot answer inconsistently. */
function statusFor(status: string): number {
  switch (status) {
    case "authorized":
    case "revoked":
    case "issued":
      return 200;
    case "unknown_farm":
    case "unknown_request":
      return 404;
    case "not_an_administrator":
      return 403;
    // `already_authorized` / `not_authorized`: the caller's decision was NOT recorded, and
    // answering 200 would be a lie about an audit record.
    default:
      return 409;
  }
}
