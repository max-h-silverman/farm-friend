import { setProviderParticipation } from "@farm-friend/db";
import { requireAdministrator } from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

// F-101 — VIGA pauses, resumes, or ends one seller's participation at one stand.
//
// This is the first production caller of `setProviderParticipation`, which F-115 built with
// every consequence tested and nothing able to reach it. The route is deliberately thin: it
// resolves the administrator, validates the transition name, and hands both to the seam.
//
// **It never writes `stand_providers` itself.** The seam owns the lock ordering, the authority
// resolution, the idempotence, and the invalidation of that provider's open confirmations —
// and only that provider's. A route that updated the row directly would be a second writer
// that re-earned none of it.
//
// The administrator comes from the session, never the body: VIGA reaches all three transitions
// through `administratorId`, and a caller cannot act as someone else by naming them.
//
// The authority ASYMMETRY the seam enforces — a seller may pause, a host may only end — does
// not arise on this route, because VIGA reaches every transition. It is the farmer-facing
// caller that meets it, and it is enforced in the seam either way.

export const dynamic = "force-dynamic";

const TRANSITIONS = ["pause", "resume", "end"] as const;

export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: { providerId?: unknown; transition?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const providerId = typeof body.providerId === "string" ? body.providerId : null;
  const transition = TRANSITIONS.find((candidate) => candidate === body.transition) ?? null;
  if (providerId === null || transition === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { db, clock } = publicReadContext();
  const result = await setProviderParticipation(db, {
    providerId,
    transition,
    administratorId: caller.administratorId,
    occurredAt: clock.now(),
  });

  // Each refusal keeps its own status, because the views say different things about them: an
  // unknown provider is a stale screen, while `provider_not_live` is a relationship someone
  // else ended while this operator was looking at it.
  switch (result.status) {
    case "unknown_provider":
      return Response.json({ error: "unknown_provider" }, { status: 404 });
    case "provider_not_live":
      return Response.json({ error: "provider_not_live" }, { status: 409 });
    case "not_authorized":
      return Response.json({ error: "not_authorized" }, { status: 403 });
    default:
      return Response.json(result, { status: 200 });
  }
}
