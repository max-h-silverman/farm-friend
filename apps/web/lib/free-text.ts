import {
  isFuzzyNameMatch,
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
  clearPendingStockOutReport,
  hasLiveFarmerAuthorization,
  isPrivilegedSender,
  readPendingStockOutReport,
  resolveFarmerTarget,
  savePendingStockOutReport,
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
 * (max, 2026-08-10).
 *
 * The answer is held against the sender until it arrives (B-065). This once read "answering
 * it is an ordinary next message, which arrives here with the stand named and resolves
 * deterministically" — which was false, and the defect: a bare stand name carries no item, so
 * it classified as a question and the report was dropped after the customer answered
 * correctly.
 */
export const STOCK_OUT_STAND_QUESTION =
  "Thanks for letting us know. Which stand are you at?";

/** The stand was named but the item was not readable. Ask; do not record an empty report. */
export const STOCK_OUT_UNCLEAR_ITEM =
  "Thanks for letting us know. What was sold out?";

/**
 * The reply to a recorded report — it names the consequence (max, 2026-08-11).
 *
 * The earlier copy thanked the reporter and said nothing about what would happen, to avoid
 * two things: the sentence is not literally true when the farmer has no active consent (the
 * alert is suppressed at dispatch) or when the stand is between farmers and there is nobody
 * to alert, and stating it tells a stranger something about that farmer's reachability.
 *
 * Max chose this wording anyway, and the tradeoff is narrow: the leak is one bit about a
 * business's contactability, inferable only by a reporter who already knows the alert should
 * have produced a restock. What it buys is a reporter who knows their message went somewhere
 * — the thing that makes reporting feel worth doing at all.
 *
 * It describes INTENT, not delivery. Nothing downstream may read it as a promise that a text
 * was sent: dispatch consent remains the only authority on that (Golden Rule #5).
 */
export const STOCK_OUT_THANKS = "Thanks, we'll let the farmer know.";

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
 * So the match runs against real rows, in code.
 *
 * **A cold message is matched exactly** — not fuzzily, not ranked, not "closest". A near-miss
 * is an ambiguity to ask about, never a guess to act on (max, 2026-08-11). The one exception
 * is an open clarification, where Farm Friend has already asked which stand and the reply is
 * presumed to be the answer; `allowFuzzy` is that context and nothing else grants it (B-065).
 *
 * Returns the single unambiguous match, or `null` when zero or several stands match. Both of
 * those mean the same thing to the caller: ask which stand they are at.
 */
async function standBelongsToSender(
  db: Db,
  input: { senderHash: string; salesLocationId: string; occurredAt: Date },
): Promise<boolean> {
  const rows = await db.sql`
    select 1
    from sales_locations l
    join farmer_authorizations a on a.farm_id = l.owner_farm_id
    join contacts c on c.id = a.contact_id
    where l.id = ${input.salesLocationId}
      and c.phone_hash = ${input.senderHash}
      and a.revoked_at is null
      and a.phone_verified_at is not null
      and a.authorized_at <= ${input.occurredAt}
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Fold a string to the form both sides of the stand-name match are compared in (F-106).
 *
 * Lowercase, strip everything that is not a letter, digit or space, then collapse runs of
 * whitespace. "Bart's Cart" and "barts cart" both become `barts cart`, because nobody types
 * the apostrophe in a text message.
 *
 * **This widens the SPELLINGS one name accepts, never the set of names a message can reach.**
 * It is still an exact substring match, just computed over folded text — not fuzzy, not
 * ranked, not "closest". Two stands still folding into one message is still ambiguous and
 * still asks.
 *
 * Deliberately not `unaccent` or a similarity metric: those need an extension or a threshold,
 * and a threshold is the guess this function exists to avoid.
 */
function foldForMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Words that appear in so many stand names they identify nobody (F-106).
 *
 * Scoring counts how much of a stand's name the customer actually typed, so a word almost
 * every stand shares must not count — otherwise "the farm stand is out of eggs" scores a hit
 * against most of the island and the highest score wins by accident.
 *
 * Derived from the live corpus, not invented: "farm"/"farms" appear in more than half the 36
 * live stand names, and "garden(s)"/"stand" in several more. It is a stop-list for SCORING
 * only — a stand named entirely from these words is still matchable by tier 1, which compares
 * whole names.
 */
const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set([
  "farm",
  "farms",
  "farmstand",
  "stand",
  "garden",
  "gardens",
  "the",
  "and",
]);

/**
 * Resolve a stand from a PARTIAL name — "barts" for "Bart's Cart" (F-106).
 *
 * Scores each stand by how many of its own distinctive words the customer typed, and returns
 * the single highest scorer. A tie is ambiguous and returns null, exactly as two whole-name
 * matches do.
 *
 * **Why this is code and not a model call.** Measured against the 36 live stands on
 * 2026-08-11: a single best score picked the right stand for every realistic partial message
 * tried, and tied (so asked) for the two genuinely ambiguous ones. Adding a model here would
 * mean a seam, a projection, a validation path and an eval to reproduce an answer a set
 * intersection already gets right — and would put a model between a stranger's words and a
 * farmer's handset for no measured gain. Golden Rule #4 permits a model to select from
 * retrieved options; it does not require one where code decides.
 *
 * **What it deliberately cannot do:** spelling. "pinecome" scores zero against "pinecone" and
 * falls through to the question. Fuzzy matching is the one part that needs a model, and a
 * model's guess would need a confirmation step before it could reach a farmer (max,
 * 2026-08-11: leave it here and ask when unclear).
 */
async function resolveStandByDistinctiveWords(
  db: Db,
  foldedText: string,
  /**
   * Whether the fuzzy tier may run (B-065). TRUE only when Farm Friend has already asked
   * "Which stand are you at?" and this is the reply — see `resolveClarifiedStand`.
   */
  allowFuzzy = false,
): Promise<{ id: string } | null> {
  const messageWords = [...new Set(foldedText.split(" ").filter((word) => word !== ""))];
  if (messageWords.length === 0) return null;

  const stands = await db.sql`
    select id, btrim(regexp_replace(
             regexp_replace(lower(name), '[^a-z0-9 ]', '', 'g'),
             '\\s+', ' ', 'g')) as folded_name
    from sales_locations
    where retired_at is null
  `;

  const distinctiveWords = (stand: Record<string, unknown>) =>
    (stand.folded_name as string)
      .split(" ")
      .filter((word) => word !== "" && !GENERIC_NAME_WORDS.has(word));

  /** Highest scorer, or null when nothing scored or two stands tied for the lead. */
  const winner = (
    score: (words: string[]) => number,
  ): { id: string } | null => {
    let best: { id: string; score: number } | null = null;
    let bestIsTied = false;
    for (const stand of stands) {
      const value = score(distinctiveWords(stand as Record<string, unknown>));
      if (value === 0) continue;
      if (best === null || value > best.score) {
        best = { id: stand.id as string, score: value };
        bestIsTied = false;
      } else if (value === best.score) {
        bestIsTied = true;
      }
    }
    // A tie means two stands are equally named by these words. Picking either would be the
    // silent guess against a farmer that this whole path exists to refuse.
    return best !== null && !bestIsTied ? { id: best.id } : null;
  };

  const exact = winner((words) => words.filter((word) => messageWords.includes(word)).length);
  if (exact !== null || !allowFuzzy) {
    /*
      The exact tier's verdict is FINAL whenever it found anything at all — including a tie,
      which returns null here and asks. Falling through to fuzzy on an exact tie would let a
      looser comparison overturn a stricter one's ambiguity, which is backwards.

      Returning null on a tie is also why `exact !== null` cannot be replaced by "did any
      stand score": those are different questions, and only the second one is asked here.
    */
    return exact;
  }

  /*
    B-065's fuzzy tier. Reached ONLY when the exact tier matched no stand at all AND we are
    inside an open clarification, so the reply is presumed to be an attempt at the answer.

    Measured against all 36 live stands 2026-08-12: pinecome/pinecon/pinecoen/pinecomb all
    reach Pinecone Gardens; "eggs", "kale" and "idk" reach nothing, so a customer who changed
    the subject is released rather than captured; and "holmstead" ties Handpicked Homestead
    against Holmestead Farms and asks, because those two are one edit apart and no code
    should choose between them.
  */
  return winner(
    (words) =>
      messageWords.filter((typed) => words.some((word) => isFuzzyNameMatch(typed, word)))
        .length,
  );
}

async function resolveReportedStand(
  db: Db,
  taskText: string,
  /**
   * B-065 — see `resolveStandByDistinctiveWords`. Stated at every call site rather than
   * defaulted: a default here would be dead (all three callers pass it) while reading like
   * the guard, which is exactly the kind of protection that looks present and is not.
   */
  allowFuzzy: boolean,
): Promise<{ id: string } | null> {
  // Folded on both sides so "plum forest" matches "Plum Forest Stand" and "barts cart"
  // matches "Bart's Cart". The customer's text is the HAYSTACK and the stand name is the
  // NEEDLE: a customer writes a sentence, and we ask which known stand appears inside it.
  //
  // The customer's side is folded HERE and bound as an ordinary parameter; the stand name is
  // folded in SQL by the same rules. Keeping the expression identical on both sides is the
  // whole correctness argument, so the two must be read together.
  //
  // The empty-name guard matters: a name that folds to nothing (punctuation only) folds to
  // `''`, and `position('' in …)` is 1 — it would match EVERY message and silently bind every
  // report to that stand.
  //
  // `'\\s+'` is doubled ON PURPOSE. This is a JS template literal, so a single backslash is
  // consumed before Postgres ever sees it and the pattern arrives as `s+` — which strips the
  // letter "s" from every stand name and folds "Bart's Cart" to "bart   cart". It matched
  // nothing and looked like a matching bug rather than an escaping one.
  const folded = foldForMatching(taskText);
  if (folded === "") return null;

  const rows = await db.sql`
    select id from sales_locations
    where retired_at is null
      and btrim(regexp_replace(
            regexp_replace(lower(name), '[^a-z0-9 ]', '', 'g'),
            '\\s+', ' ', 'g')) <> ''
      and position(
            btrim(regexp_replace(
              regexp_replace(lower(name), '[^a-z0-9 ]', '', 'g'),
              '\\s+', ' ', 'g'))
            in ${folded}
          ) > 0
  `;
  // Exactly one, or we ask. Two stands whose names both appear is genuinely ambiguous, and
  // picking the first would be a silent guess against a farmer.
  if (rows.length === 1) return { id: rows[0]?.id as string };
  // More than one whole name inside the message stays ambiguous. Scoring cannot improve on
  // that: both names are fully present, so both would score their maximum.
  if (rows.length > 1) return null;

  return resolveStandByDistinctiveWords(db, folded, allowFuzzy);
}

/**
 * How long an answer to a stock-out clarifying question may still land (B-065).
 *
 * Long enough for a customer standing at a stand to type a reply; short enough that a
 * forgotten context cannot swallow an unrelated question later in the day. Run from the
 * MESSAGE's own time, never `now()`.
 */
export const PENDING_STOCK_OUT_TTL_MINUTES = 15;

/**
 * A customer reporting that something is sold out (F-104).
 *
 * The stand is bound in CODE before anything durable happens. When it cannot be resolved the
 * customer is asked which stand they are at, and the report is held (B-065) so their answer
 * has somewhere to land — before that, the question was asked and the report thrown away, so
 * a customer who answered correctly was told "Sorry, I did not catch which item or farm you
 * meant." The held row carries no consent, teaches no token, and expires.
 */
async function handleCustomerStockOut(
  deps: FreeTextDeps,
  input: {
    senderHash: string;
    taskText: string;
    providerEventId: string;
    occurredAt: Date;
  },
  /**
   * Whether this text is the answer to a clarification we already asked (B-065), which is
   * the only context where the fuzzy name tier may run. Off for every cold message.
   */
  allowFuzzy = false,
): Promise<FreeTextResult> {
  const stand = await resolveReportedStand(deps.db, input.taskText, allowFuzzy);
  const reportText = input.taskText;

  if (stand === null) {
    await savePendingStockOutReport(deps.db, {
      senderHash: input.senderHash,
      reportText,
      awaiting: "stand",
      occurredAt: input.occurredAt,
      ttlMinutes: PENDING_STOCK_OUT_TTL_MINUTES,
    });
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
      taskText: reportText,
      // The inbound event id makes a redelivered message one report and one farmer text.
      reportKey: input.providerEventId,
    },
  );

  if (outcome.outcome !== "recorded") {
    // The text named a stand but no item we could identify. Ask rather than record a report
    // that says nothing a farmer could act on — and hold the bound stand, so the answer
    // completes the report instead of starting over.
    await savePendingStockOutReport(deps.db, {
      senderHash: input.senderHash,
      reportText,
      awaiting: "item",
      salesLocationId: stand.id,
      occurredAt: input.occurredAt,
      ttlMinutes: PENDING_STOCK_OUT_TTL_MINUTES,
    });
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

  // Recorded. Whatever clarification was open is answered and must not outlive it.
  await clearPendingStockOutReport(deps.db, { senderHash: input.senderHash });

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
 * Answer an open stock-out clarification with the message that just arrived (B-065).
 *
 * Returns `null` when there is nothing open, or when the message plainly is not an answer —
 * both of which mean "handle this as an ordinary new message", exactly as before this
 * existed.
 *
 * **The release rule.** A reply that resolves no stand at all releases the held report and
 * falls through. Inside a clarification a reply is presumed to be an attempt at the answer
 * (max, 2026-08-12), which is why the fuzzy tier runs here and only here — but a customer who
 * changed the subject must still get a real answer, and "eggs" resolves to no stand, so it is
 * released. Releasing is recoverable; capturing a real question is another dead end.
 *
 * **No model decides any of this.** The stand is resolved by the same code the cold path
 * uses, and the item still comes from the stock-out seam selecting an identifier out of a
 * list code built.
 */
async function resolveClarification(
  deps: FreeTextDeps,
  input: {
    senderHash: string;
    taskText: string;
    providerEventId: string;
    occurredAt: Date;
  },
): Promise<FreeTextResult | null> {
  const pending = await readPendingStockOutReport(deps.db, {
    senderHash: input.senderHash,
    occurredAt: input.occurredAt,
  });
  if (pending === null) return null;

  /*
    Both arms combine the two messages into one report text, and that is deliberate: one
    mechanism, not two. Whichever half was missing, the pair together says what a single
    message would have said, and `handleCustomerStockOut` then does exactly what it does for
    a message that arrived complete — resolve the stand from the text, read the item from it.

    Order is original-then-reply because the original is the sentence with the grammar in it
    ("Pinecome is out of eggs" + "Pinecone"); nothing downstream depends on the order, but a
    reader of the stored report should see the report first.
  */
  const combined = `${pending.reportText} ${input.taskText}`;

  if (pending.awaiting === "item") {
    // The stand is already bound and named in the original text, so the combined message
    // still resolves to it — no separate id needs threading through.
    return handleCustomerStockOut(deps, { ...input, taskText: combined }, true);
  }

  /*
    Awaiting a stand. Checked against the REPLY alone rather than the combined text: the
    original is the message that already failed to name a stand, and folding it in would let
    its words vote. "Pinecome is out of eggs" plus "Pinecone" must resolve because of the
    reply, not because the pair happens to contain a near-duplicate.
  */
  if ((await resolveReportedStand(deps.db, input.taskText, true)) === null) {
    // Not an answer we can use. Release, and let the message be whatever it is.
    await clearPendingStockOutReport(deps.db, { senderHash: input.senderHash });
    return null;
  }

  return handleCustomerStockOut(deps, { ...input, taskText: combined }, true);
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

  /*
    A farmer naming SOMEONE ELSE'S stand is reporting a stock-out, not updating their listing
    (max, 2026-08-11). Found live: "no eggs left at Pinecone Gardens" from a farmer handset
    returned the farmer stand-menu, because authority alone decided the branch.

    **The discriminator is whose stand was named, and it is resolved in CODE.** Ownership comes
    from `farmer_authorizations`, and the stand from the same unique-substring match the
    customer path uses — so no model decides whether a message is about the sender's own farm.
    That keeps Golden Rule #1 intact: this can only ever move a farmer's message AWAY from
    publishing their inventory, never toward publishing someone else's.

    Deliberately narrow. Naming no stand, or naming their own, leaves the farmer path exactly
    as it was — an ambiguous or unnamed message is still an update, which is the common case.
  */
  const namedStand = isFarmer
    ? await resolveReportedStand(deps.db, input.taskText, false)
    : null;
  const namedSomeoneElsesStand =
    namedStand !== null &&
    !(await standBelongsToSender(deps.db, {
      senderHash: input.senderHash,
      salesLocationId: namedStand.id,
      occurredAt: input.occurredAt,
    }));

  if (namedSomeoneElsesStand) {
    return handleCustomerStockOut(deps, input);
  }

  if (!isFarmer) {
    /*
      B-065 — a clarifying question Farm Friend asked, and the answer to it.

      This runs BEFORE the intent seam on purpose. The reply to "Which stand are you at?" is
      a bare stand name: it states nothing about stock and names no item, so the classifier
      correctly calls it a question (measured 3/3 against the live model) and the report is
      lost. The pending row is what makes it an answer instead.

      It runs BELOW all of deterministic routing, which is the load-bearing placement. STOP,
      HELP, FLAG and the confirmation tokens are decided by `parseCommand` from the body
      alone, so no held context can reinterpret one (Golden Rule #2).
    */
    const resolved = await resolveClarification(deps, input);
    if (resolved !== null) return resolved;

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
