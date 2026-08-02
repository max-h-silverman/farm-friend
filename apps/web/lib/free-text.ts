import {
  renderClarificationRequest,
  type Clock,
  type InventoryInterpreter,
} from "@farm-friend/core";
import type { InquiryModel } from "@farm-friend/ai";
import { resolveFarmerTarget, type Db } from "@farm-friend/db";
import { answerInquiry } from "./inquiry";
import { applyInterpretedInventory } from "./interpretation";
import { renderFarmerTargetMenu } from "./farmer-targeting";
import type { RoutedReply } from "./routing";

// The free-text branch of inbound routing (F-023) — the ONE path a model may run on.
//
// Deterministic parsing has already completed and found no keyword or token. What remains
// is sender-dependent, and WHO the sender is decides which seam sees the message:
//
//   - a farmer authorized for a sales location → inventory interpretation → one proposal
//   - anyone else                              → customer inquiry → grounded answer
//
// That resolution is CODE's, from `farmer_authorizations`, and never a model's: letting a
// model decide "this looks like a farmer" would let a customer's text publish inventory,
// which is Golden Rule #1's exact failure mode.
//
// Both branches queue replies rather than sending. Nothing here sends an SMS.

export interface FreeTextDeps {
  db: Db;
  interpreter: InventoryInterpreter;
  inquiry: InquiryModel;
  clock: Clock;
}

export interface FreeTextResult {
  replies: RoutedReply[];
  handled: "farmer" | "customer" | "none";
}

/**
 * Handle a message that is not a deterministic command.
 *
 * The farmer branch opens or revises the sender's ONE pending proposal and returns the
 * confirmation prompt for the outbox. The proposal is activated by the outbound worker once
 * Telnyx accepts that prompt — until then no token can consume it, which is what makes
 * "a token predating its prompt cannot commit" true.
 */
export async function handleFreeText(
  deps: FreeTextDeps,
  input: {
    senderHash: string;
    taskText: string;
    providerEventId: string;
    inboxEventId: string;
    /** The inbound message's own time — what a saved result list's expiry runs from (F-046). */
    occurredAt: Date;
  },
): Promise<FreeTextResult> {
  if (input.taskText.trim() === "") {
    // Nothing to interpret. Silence is the honest response to an empty body.
    return { replies: [], handled: "none" };
  }

  // The exact authorization+location pair is code-owned durable context. Resolution
  // revalidates both rows on every message; the model receives neither the menu nor any
  // choice of target. One live target auto-selects, several without a selection issue the
  // same 12-hour numbered menu as STAND.
  const farmer = await resolveFarmerTarget(deps.db, {
    senderHash: input.senderHash,
    occurredAt: input.occurredAt,
    purpose: "update",
  });

  if (farmer.status === "menu") {
    return {
      replies: [{
        body: renderFarmerTargetMenu(farmer.options),
        category: "inquiry_reply",
        logicalKey: `farmer-target-menu-${input.providerEventId}`,
      }],
      handled: "none",
    };
  }

  if (farmer.status === "selected") {
    const outcome = await applyInterpretedInventory(
      {
        db: deps.db,
        interpreter: deps.interpreter,
        clock: deps.clock,
      },
      {
        senderHash: input.senderHash,
        salesLocationId: farmer.target.salesLocationId,
        taskText: input.taskText,
      },
    );

    if (outcome.outcome === "proposed") {
      return {
        replies: [
          {
            body: outcome.confirmationText,
            category: "inventory_confirmation",
            // Bound to the proposal VERSION: a revision produces a new prompt rather than
            // reusing the previous row, so the outbox key tracks what is being confirmed.
            logicalKey: `proposal-prompt-${outcome.proposalId}-${outcome.proposalVersion}`,
          },
        ],
        handled: "farmer",
      };
    }

    if (outcome.outcome === "clarification") {
      return {
        replies: [
          {
            body: outcome.question,
            category: "inquiry_reply",
            logicalKey: `farmer-clarify-${input.providerEventId}`,
          },
        ],
        handled: "farmer",
      };
    }

    // Rejected: the interpretation named something outside the current snapshot. Nothing is
    // proposed, and the farmer is asked rather than left without a reply.
    return {
      replies: [
        {
          body: renderClarificationRequest(),
          category: "inquiry_reply",
          logicalKey: `farmer-rejected-${input.providerEventId}`,
        },
      ],
      handled: "farmer",
    };
  }

  // Not an authorized farmer → a customer question. Every factual word of the reply is
  // rendered by code from retrieved rows; the model only interprets and orders identifiers.
  const answer = await answerInquiry(
    { db: deps.db, model: deps.inquiry, clock: deps.clock },
    {
      taskText: input.taskText,
      // F-046: an answer too long for one message saves its remainder against this sender,
      // and the expiry runs from the message's own time rather than the pass's.
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
    },
  );

  if (answer.outcome === "answered") {
    return {
      replies: [
        {
          body: answer.body,
          // Permitted by the customer's own inbound message; it creates no durable consent
          // and licenses no later proactive follow-up.
          category: "inquiry_reply",
          logicalKey: `inquiry-${input.providerEventId}`,
        },
      ],
      handled: "customer",
    };
  }

  if (answer.outcome === "clarification") {
    return {
      replies: [
        {
          body: answer.question,
          category: "inquiry_reply",
          logicalKey: `inquiry-clarify-${input.providerEventId}`,
        },
      ],
      handled: "customer",
    };
  }

  // Code REFUSED the model's output (a smuggled factual string, an invented identifier).
  // The customer gets a code-rendered question; nothing model-authored is delivered.
  return {
    replies: [
      {
        body: renderClarificationRequest(),
        category: "inquiry_reply",
        logicalKey: `inquiry-rejected-${input.providerEventId}`,
      },
    ],
    handled: "customer",
  };
}
