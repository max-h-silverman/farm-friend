import {
  activateWebProposal,
  type Db,
} from "@farm-friend/db";
import { appContext } from "../../../../lib/composition";
import {
  confirmFromLink,
  proposeFromLink,
  resolveStandFromToken,
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
    text?: unknown;
    proposalId?: unknown;
    confirmationText?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : null;
  const action =
    body.action === "propose" || body.action === "confirm" || body.action === "decline"
      ? body.action
      : null;
  if (token === null || action === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const context = appContext();
  const deps = {
    db: context.db,
    interpreter: context.interpreter,
    clock: context.clock,
  };

  // Resolved before anything else, and the refusal is the SAME for a revoked link, a
  // fabricated one, and a malformed one — a distinct answer would tell a holder whether a
  // token they have is real and merely withdrawn.
  const stand = await resolveStandFromToken(context.db, token);
  if (stand === null) {
    return Response.json({ error: "not_authorized" }, { status: 403 });
  }

  if (action === "propose") {
    const text = typeof body.text === "string" ? body.text : null;
    if (text === null || text.trim() === "") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const proposed = await proposeFromLink(deps, { token, taskText: text });
    if (proposed.outcome === "not_authorized") {
      return Response.json({ error: "not_authorized" }, { status: 403 });
    }
    if (proposed.outcome === "proposed") {
      return Response.json({
        outcome: "proposed",
        proposalId: proposed.proposalId,
        // The snapshot the farmer confirms, rendered by CODE from the validated
        // interpretation — never model prose.
        confirmationText: proposed.confirmationText,
      });
    }
    if (proposed.outcome === "clarification") {
      return Response.json({
        outcome: "clarification",
        question: proposed.question,
      });
    }
    // Code refused the model's output. The farmer is asked again rather than shown a reason
    // that would only describe our own internals.
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
    return Response.json({ status: "refused", reason: result.reason }, { status: 409 });
  }
  return Response.json({ status: result.status });
}
