import {
  renderClarificationRequest,
  type Clock,
  type InventoryInterpreter,
} from "@farm-friend/core";
import type {
  CustomerMessageIntentModel,
  FarmerMessageIntentModel,
  InquiryModel,
  StockOutModel,
} from "@farm-friend/ai";
import {
  hasLiveFarmerAuthorization,
  isPrivilegedSender,
  resolveFarmerTarget,
  type Db,
} from "@farm-friend/db";
import { answerInquiry } from "./inquiry";
import { applyInterpretedInventory } from "./interpretation";
import { renderFarmerTargetMenu } from "./farmer-targeting";
import { recordStockOutReport } from "./stockout";
import type { RoutedReply } from "./routing";

// The free-text branch of inbound routing (F-023) — the ONE path a model may run on.
//
// Deterministic parsing has already completed and found no keyword or token. What remains
// is sender-dependent, and WHO the sender is decides which seam sees the message:
//
//   - an authorized farmer → finite intent classification → inventory proposal or inquiry
//   - anyone else          → customer inquiry → grounded answer
//
// That resolution is CODE's, from `farmer_authorizations`, and never a model's: letting a
// model decide "this looks like a farmer" would let a customer's text publish inventory,
// which is Golden Rule #1's exact failure mode.
//
// Both branches queue replies rather than sending. Nothing here sends an SMS.

export interface FreeTextDeps {
  db: Db;
  farmerIntent: FarmerMessageIntentModel;
  /**
   * The customer-side route signal (F-104): is this a question, or is someone telling us
   * something sold out? A sibling of `farmerIntent`, in the same position on the other
   * branch — not a field on the inquiry seam, which every working answer depends on.
   */
  customerIntent: CustomerMessageIntentModel;
  /** Reads a report's free text into an item reference, once a stand is bound in code. */
  stockOut: StockOutModel;
  interpreter: InventoryInterpreter;
  inquiry: InquiryModel;
  clock: Clock;
}

/**
 * What a customer is asked when their report does not identify a stand.
 *
 * Code-rendered and deliberately plain. A customer has no farm affiliation, so there is
 * nothing to infer from and nobody to disambiguate against — the honest move is to ask
 * (max, 2026-08-10). Answering it is an ordinary next message, which arrives here with the
 * stand named and resolves deterministically.
 */
export const STOCK_OUT_STAND_QUESTION =
  "Thanks for letting us know. Which stand are you at?";

/** The stand was named but the item was not readable. Ask; do not record an empty report. */
export const STOCK_OUT_UNCLEAR_ITEM =
  "Thanks for letting us know. What was sold out?";

/**
 * The reply to a recorded report — deliberately opaque about what happened next.
 *
 * It does NOT say the farmer was told. Two reasons, and the second is the stronger one:
 * saying so would reveal whether a farmer is reachable and has consented (Golden Rule #5),
 * and it would often be FALSE — an alert to a farmer without active consent is suppressed at
 * dispatch, and a stand between farmers has nobody to alert at all. A stranger gets thanks,
 * which is honest in every case.
 */
export const STOCK_OUT_THANKS = "Thanks for letting us know.";

export const FARMER_INTENT_CLARIFICATION =
  "Are you updating your inventory or asking what a farm stand has? Reply UPDATE or QUESTION.";

async function handleCustomerInquiry(
  deps: FreeTextDeps,
  input: {
    senderHash: string;
    taskText: string;
    providerEventId: string;
    occurredAt: Date;
  },
): Promise<FreeTextResult> {
  // F-074 — whether this sender may see test farms, resolved by CODE from the sender hash
  // BEFORE the model runs. The model never receives this boolean and never sees the hash; it
  // selects from whatever retrieval returned, so a test farm the filter excluded cannot be
  // named however directly the question asks for it.
  //
  // It grants visibility and nothing else. Being listed does not reach the farmer branch above
  // — that is still `farmer_authorizations` and nothing here consults this list.
  const includeTestFarms = await isPrivilegedSender(deps.db, {
    senderHash: input.senderHash,
  });

  // Not an authorized farmer, or an authorized farmer who explicitly asked a question.
  // Every factual word of the reply is rendered by code from retrieved rows; the model only
  // interprets and orders identifiers.
  const answer = await answerInquiry(
    { db: deps.db, model: deps.inquiry, clock: deps.clock },
    {
      taskText: input.taskText,
      // F-046: an answer too long for one message saves its remainder against this sender,
      // and the expiry runs from the message's own time rather than the pass's.
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
      scope: { includeTestFarms },
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
  // The sender gets a code-rendered question; nothing model-authored is delivered.
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

/**
 * Resolve which stand a customer's report is about, deterministically, from their own words.
 *
 * **Code matches; the model never names a stand.** This is Golden Rule #1 at the door: a
 * customer's report must not be able to land on a farmer they did not identify, and a model
 * that could choose a location could route a stranger's report at any farm on the island.
 * So the match runs in SQL against real rows, and it is exact-substring — not fuzzy, not
 * ranked, not "closest". A near-miss is an ambiguity to ask about, never a guess to act on.
 *
 * Returns the single unambiguous match, or `null` when zero or several stands match. Both of
 * those mean the same thing to the caller: ask which stand they are at.
 */
async function resolveReportedStand(
  db: Db,
  taskText: string,
): Promise<{ id: string } | null> {
  // Normalized on both sides so "plum forest" matches "Plum Forest Stand". The customer's
  // text is the HAYSTACK and the stand name is the NEEDLE: a customer writes a sentence, and
  // we are asking which known stand appears inside it.
  const rows = await db.sql`
    select id from sales_locations
    where retired_at is null
      and position(lower(name) in lower(${taskText})) > 0
  `;
  // Exactly one, or we ask. Two stands whose names both appear is genuinely ambiguous, and
  // picking the first would be a silent guess against a farmer.
  return rows.length === 1 ? { id: rows[0]?.id as string } : null;
}

/**
 * A customer reporting that something is sold out (F-104).
 *
 * The stand is bound in CODE before anything durable happens. When it cannot be resolved the
 * customer is asked which stand they are at and nothing is recorded — no report, no alert,
 * and no stored half-finished state to expire or leak.
 */
async function handleCustomerStockOut(
  deps: FreeTextDeps,
  input: {
    senderHash: string;
    taskText: string;
    providerEventId: string;
    occurredAt: Date;
  },
): Promise<FreeTextResult> {
  const stand = await resolveReportedStand(deps.db, input.taskText);

  if (stand === null) {
    return {
      replies: [
        {
          body: STOCK_OUT_STAND_QUESTION,
          // Answering the customer's own message; it creates no durable consent.
          category: "inquiry_reply",
          logicalKey: `stock-out-which-stand-${input.providerEventId}`,
        },
      ],
      handled: "customer",
    };
  }

  const outcome = await recordStockOutReport(
    { db: deps.db, model: deps.stockOut, clock: deps.clock },
    {
      salesLocationId: stand.id,
      taskText: input.taskText,
      // The inbound event id makes a redelivered message one report and one farmer text.
      reportKey: input.providerEventId,
    },
  );

  if (outcome.outcome !== "recorded") {
    // The text named a stand but no item we could identify. Ask rather than record a report
    // that says nothing a farmer could act on.
    return {
      replies: [
        {
          body: STOCK_OUT_UNCLEAR_ITEM,
          category: "inquiry_reply",
          logicalKey: `stock-out-which-item-${input.providerEventId}`,
        },
      ],
      handled: "customer",
    };
  }

  return {
    replies: [
      {
        body: STOCK_OUT_THANKS,
        category: "inquiry_reply",
        logicalKey: `stock-out-thanks-${input.providerEventId}`,
      },
    ],
    handled: "customer",
  };
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

  // Authority is code-owned and checked before the classifier. A customer must never be
  // able to steer a model into the farmer path, and an authorized farmer's question must not
  // create a stand-selection menu before we know it is an update.
  const isFarmer = await hasLiveFarmerAuthorization(deps.db, {
    senderHash: input.senderHash,
    occurredAt: input.occurredAt,
  });

  if (!isFarmer) {
    // F-104 — the customer branch now has a route signal of its own. `farm_stand_question`
    // is both the other arm and the fallback, so an unreachable or refused model leaves this
    // path exactly as it was before the seam existed.
    const customerIntent = await deps.customerIntent.classify({
      taskText: input.taskText,
    });
    if (customerIntent.kind === "stock_out_report") {
      return handleCustomerStockOut(deps, input);
    }
    return handleCustomerInquiry(deps, input);
  }

  const intent = await deps.farmerIntent.classify({ taskText: input.taskText });
  if (intent.kind === "farm_stand_question") {
    return handleCustomerInquiry(deps, input);
  }
  if (intent.kind === "unclear") {
    return {
      replies: [{
        body: FARMER_INTENT_CLARIFICATION,
        category: "inquiry_reply",
        logicalKey: `farmer-intent-clarify-${input.providerEventId}`,
      }],
      handled: "none",
    };
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
  // Authority can be revoked between the identity check and target resolution. Fail toward
  // the read-only inquiry path; never interpret or persist an update without a live target.
  return handleCustomerInquiry(deps, input);
}
