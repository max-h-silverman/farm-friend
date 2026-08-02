import { renderClarificationRequest, type Clock } from "@farm-friend/core";
import { confirmInventoryPublication, type Db } from "@farm-friend/db";
import type { RoutedReply } from "./routing";

/** Confirm an identical revision only through an active full-snapshot scheduled subject. */
export async function handleScheduledSame(
  deps: { db: Db; clock: Clock },
  input: { senderHash: string; occurredAt: Date; providerEventId: string },
): Promise<{ replies: RoutedReply[]; status: string }> {
  const open = await deps.db.sql`
    select proposal.id
    from inventory_publication_proposals as proposal
    join scheduled_inventory_prompt_subjects as subject
      on subject.proposal_id = proposal.id
    where proposal.sender_hash = ${input.senderHash}
      and proposal.state = 'open'
      and subject.offers_same
  `;
  const proposalId = open[0]?.id as string | undefined;
  if (proposalId === undefined) return { replies: [], status: "no_active_prompt" };

  const result = await confirmInventoryPublication(deps.db, {
    proposalId,
    senderHash: input.senderHash,
    token: "same",
    occurredAt: input.occurredAt,
    providerEventId: input.providerEventId,
    clock: deps.clock,
  });
  if (result.status === "published") return { replies: [], status: result.status };
  return {
    status: result.status,
    replies: [{
      body: renderClarificationRequest(),
      category: "inquiry_reply",
      logicalKey: `same-${result.status}-${input.providerEventId}`,
    }],
  };
}
