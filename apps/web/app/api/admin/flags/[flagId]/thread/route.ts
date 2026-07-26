import { readFlaggedThread } from "@farm-friend/db";
import { requireAdministrator } from "../../../../../../lib/admin-guard";
import { publicReadContext } from "../../../../../../lib/public-context";

// The thread viewer (F-030): the retained context of a flagged thread.
//
// This is the surface the documented retention exemption exists FOR — a body whose thread
// carries an open flag is kept readable precisely so a person can review it here. Once the
// flag is disposed of, the next retention pass clears those bodies and this view honestly
// reports them as purged rather than as empty messages.
//
// Privacy (Golden Rule #5): the sender is masked at the QUERY, so the raw E.164 never leaves
// the database and this route never becomes a second reader of the send path's one column.
// What the sender voluntarily typed is shown verbatim — that text is the thing under review,
// and redacting it would defeat the rail.

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: { flagId: string } },
): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  const { db } = publicReadContext();
  const thread = await readFlaggedThread(db, { flagId: context.params.flagId });
  if (thread === null) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({
    thread: {
      flagId: thread.flagId,
      senderMask: thread.senderMask,
      status: thread.status,
      reasonCode: thread.reasonCode,
      createdAt: thread.createdAt.toISOString(),
      messages: thread.messages.map((message) => ({
        messageId: message.messageId,
        receivedAt: message.receivedAt.toISOString(),
        body: message.body,
        bodyPurged: message.bodyPurged,
        isFlagged: message.isFlagged,
      })),
    },
  });
}
