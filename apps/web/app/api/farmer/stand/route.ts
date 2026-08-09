import {
  activateWebProposal,
  type Db,
} from "@farm-friend/db";
import { parseStructuredEdit } from "../../../../lib/farmer-stand-edit";
import { publicReadContext } from "../../../../lib/public-context";
import {
  confirmFromLink,
  proposeStructuredFromLink,
  readCurrentStandEntries,
  resolveStandFromToken,
  saveParticipantsFromLink,
} from "../../../../lib/farmer-stand";

// The farmer's own web surface (F-040) — the HTTP half.
//
// **The token is the credential and it arrives in the request BODY, never the URL.** The page
// at `/stand/<token>` is what the farmer bookmarks, and it hands the token to this route from
// its own form; a query string would put a standing credential into proxy logs, analytics, and
// browser history, which is the same reasoning that keeps the admin session in a cookie rather
// than a URL. The path segment on the page itself is unavoidable — a bookmark has to carry it
// somewhere — and is the one place it appears.
//
// Every request re-resolves the token. There is no session, no cookie, and nothing cached: a
// revocation that commits between two clicks takes effect on the second one.
//
// The route NEVER publishes. It proposes, and it confirms through
// `confirmInventoryPublication` — the same gate SMS lands on, no bypass (Golden Rule #1, #3).

export const dynamic = "force-dynamic";

/** Deliberately narrow: this surface reads its own stand and nothing else. */
function activator(db: Db) {
  return (input: {
    proposalId: string;
    senderHash: string;
    confirmationText: string;
    at: Date;
  }) => activateWebProposal(db, input);
}

export async function POST(req: Request): Promise<Response> {
  let body: {
    token?: unknown;
    action?: unknown;
    /** A structured edit from the direct stock editor. Shape is checked at this boundary. */
    edit?: unknown;
    proposalId?: unknown;
    confirmationText?: unknown;
    participantNames?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : null;
  const action =
    body.action === "propose" ||
    body.action === "confirm" ||
    body.action === "decline" ||
    body.action === "save_participants"
      ? body.action
      : null;
  if (token === null || action === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Structured metadata save: deterministic and model-free, like the stock-edit branch below.
  if (action === "save_participants") {
    if (
      !Array.isArray(body.participantNames) ||
      !body.participantNames.every((name): name is string => typeof name === "string")
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const context = publicReadContext();
    const result = await saveParticipantsFromLink(context, {
      token,
      activeDisplayNames: body.participantNames,
    });
    if (result.status === "saved") return Response.json(result);
    if (result.status === "not_authorized") {
      return Response.json({ error: "not_authorized" }, { status: 403 });
    }
    return Response.json(
      {
        status: result.status,
        reason: result.reason,
        ...(result.message !== undefined ? { message: result.message } : {}),
      },
      { status: result.reason === "invalid_names" ? 400 : 409 },
    );
  }

  // This web path is structurally model-free. Natural-language inventory interpretation remains
  // an SMS capability; the returning-farmer page has one direct editor, not two competing modes.
  const context = publicReadContext();
  const deps = { db: context.db, clock: context.clock };

  // Resolved before anything else, and the refusal is the SAME for a revoked link, a
  // fabricated one, and a malformed one — a distinct answer would tell a holder whether a
  // token they have is real and merely withdrawn.
  const stand = await resolveStandFromToken(context.db, token);
  if (stand === null) {
    return Response.json({ error: "not_authorized" }, { status: 403 });
  }

  if (action === "propose") {
    const edit = parseStructuredEdit(body.edit);
    if (edit === null) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const proposed = await proposeStructuredFromLink(deps, { token, edit });
    if (proposed.outcome === "not_authorized") {
      return Response.json({ error: "not_authorized" }, { status: 403 });
    }
    if (proposed.outcome === "proposed") {
      return Response.json({
        outcome: "proposed",
        proposalId: proposed.proposalId,
        // The exact snapshot the farmer confirms, rendered by code from validated fields.
        confirmationText: proposed.confirmationText,
      });
    }
    return Response.json({ outcome: "rejected" });
  }

  const proposalId = typeof body.proposalId === "string" ? body.proposalId : null;
  const confirmationText =
    typeof body.confirmationText === "string" ? body.confirmationText : null;
  if (proposalId === null || confirmationText === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await confirmFromLink(
    { ...deps, activate: activator(context.db) },
    { token, proposalId, accept: action === "confirm", confirmationText },
  );

  if (result.status === "not_authorized") {
    return Response.json({ error: "not_authorized" }, { status: 403 });
  }
  if (result.status === "refused") {
    // 409: the decision was NOT recorded. Answering 200 would be a lie about whether a
    // farmer's listing changed.
    return Response.json(
      {
        status: "refused",
        reason: result.reason,
        ...(result.message !== undefined ? { message: result.message } : {}),
      },
      { status: 409 },
    );
  }
  if (result.status === "published") {
    return Response.json({
      status: result.status,
      currentEntries: await readCurrentStandEntries(
        context.db,
        stand.salesLocationId,
        stand.senderHash,
      ),
    });
  }
  return Response.json({ status: result.status });
}
