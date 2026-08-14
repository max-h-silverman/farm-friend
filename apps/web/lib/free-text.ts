import {
  isFuzzyNameMatch,
  meetsDistinctiveWordBar,
  renderClarificationRequest,
  PUBLIC_MAP_URL,
  type Clock,
  type InventoryInterpreter,
} from "@farm-friend/core";
import type {
  CatalogMatcher,
  RequestClassificationModel,
  SearchStandRequest,
  StandLookupRequest,
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
// Deterministic parsing has already completed and found no keyword or token. What remains is
// classified ONCE, by shape, and then handled by code per arm (F-111).
//
//   deterministic routing steps 1–10   (body only — see routing.ts)
//     → open stock-out clarification   (B-065, code, below the deterministic steps)
//       → REQUEST CLASSIFIER           (one call, one enum out)
//         → per-arm handling; a stand is resolved only where an arm needs one
//
// **WHO the sender is no longer picks the classifier.** Two seams split by sender used to ask
// the same question in two taxonomies, and the split leaked into language: a farmer reporting
// ANOTHER stand's stock-out classified as their own inventory update (measured 3/3), which is
// B-053 reintroduced. One taxonomy now asks what the message IS; code asks separately, from
// `farmer_authorizations`, what the sender may DO about it.
//
// **Authority stays code-owned and absent from the model's input.** The classifier receives the
// message text and nothing else — no sender type, no stand roster — so there is no field
// through which a manipulated model could claim a sender may publish. Golden Rules #1 and #3.
//
// Every branch queues replies rather than sending. Nothing here sends an SMS.

export interface FreeTextDeps {
  db: Db;
  /**
   * The first-pass request classifier (F-111) — one call, one enum, above everything else that
   * interprets an inbound message. It replaced `farmer-message-intent` and
   * `customer-message-intent`, which are deleted rather than left beside it.
   */
  classifier: RequestClassificationModel;
  /** Reads a report's free text into an item reference, once a stand is bound in code. */
  stockOut: StockOutModel;
  interpreter: InventoryInterpreter;
  catalogMatcher: CatalogMatcher;
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

/**
 * The reply to a message Farm Friend genuinely cannot handle (F-111, the `unclear` arm).
 *
 * **This blames nothing and claims nothing.** It does not say "no stand has that", which would
 * be a factual claim about a corpus nothing searched, and it does not offer a keyword the
 * sender did not ask about. It states the scope and points at the map, which is true whatever
 * the message was.
 */
export const UNCLEAR_REQUEST_REPLY =
  "Sorry, I did not catch that. Ask what a farm stand has, or tell us something is sold out. " +
  `The map at ${PUBLIC_MAP_URL} lists every stand.`;

/**
 * The reply when the classifier could not be reached or returned nothing usable (F-111).
 *
 * **A DIFFERENT message from `UNCLEAR_REQUEST_REPLY`, and the difference is the point.** That
 * one says the sender's message was unhandleable; this one says OUR side failed. Telling a
 * customer whose question was never classified that we did not catch it blames their wording
 * for our outage and asks them to retype something that was already fine — B-049 established
 * exactly this for the interpreter, and this extends that one pattern rather than adding a
 * concept.
 *
 * It claims nothing about any stand, and points at the map, which does not depend on the model
 * being up.
 */
export const CLASSIFIER_UNAVAILABLE_REPLY =
  "Sorry, we ran into an issue handling your message. Please try again in a minute. " +
  `The map at ${PUBLIC_MAP_URL} is always up to date.`;

/**
 * The answer to "where's the farm stand map?" (F-111, the `system_inquiry` arm).
 *
 * `MAP` has always worked as a bare keyword; no free-text phrasing of the same question reached
 * it, so "where's the farm stand map?" fell through to the generic clarification. This arm is
 * that phrasing's home.
 *
 * The URL comes from the SAME `PUBLIC_MAP_URL` constant the `MAP` keyword's reply is validated
 * against — stated once, so the two answers cannot drift apart.
 */
export const SYSTEM_INQUIRY_REPLY =
  "Farm Friend keeps Vashon farm-stand listings current. " +
  `Ask what a stand has, or tell us something is sold out. The map: ${PUBLIC_MAP_URL}`;

/**
 * How a farmer commits or discards the update they were just shown (max, 2026-08-14).
 *
 * The proposal prompt listed the resulting stand and stopped, so a farmer was asked to approve
 * a change without being told approval was needed or which word gives it. Nothing published
 * without a YES — the gate was never open — so the defect was a dead end, not an unsafe write.
 *
 * **Added HERE, at the SMS reply, rather than inside `renderProposedFarmerUpdate`.** That
 * renderer is shared with the web form, where the same snapshot text is stored as the audit
 * record of what the farmer's button already published; an instruction to reply YES would be
 * false on that surface and would then be quoted back in the audit trail.
 *
 * NO is offered alongside YES because a farmer who sees a wrong listing needs the reject path
 * more urgently than the accept one, and `commands.ts` already routes both.
 */
export const PROPOSAL_CONFIRMATION_PROMPT = "Reply YES to publish, or NO to discard.";

/**
 * VIGA owns the changing distribution details; Farm Friend links to their live answer rather
 * than copying pickup locations that can drift. Source reviewed 2026-08-13:
 * https://www.vigavashon.org/food-access-partnership
 */
export const VIGA_BUCKS_INQUIRY_REPLY =
  "VIGA Farm Bucks help islanders buy fresh local food. No application is required. " +
  "Current pickup options: https://www.vigavashon.org/food-access-partnership";

/**
 * The reply to a greeting (F-111, the `chitchat` arm).
 *
 * Answers the person and says what the service is for, in one line. A greeting that fell into
 * product retrieval used to be answered "no stand has a current listing for hi", which is a
 * claim about the corpus in reply to a message that was never about the corpus.
 */
/*
  NO EMOJI (max, 2026-08-14). The plant that used to close this line cost a whole extra
  segment: one non-GSM-7 character re-encodes the entire message to UCS-2, dropping capacity
  per segment from 153 to 67, so 73 characters of text billed as two. `reply-encoding.test.ts`
  holds this for every code-owned reply.
*/
export const CHITCHAT_REPLY =
  "Ask me what a Vashon farm stand has, or tell us if something is sold out.";

async function handleCustomerInquiry(
  deps: FreeTextDeps,
  input: {
    mode: "search_stands";
    request: SearchStandRequest;
    topic?: "viga_bucks";
    senderHash: string;
    taskText: string;
    providerEventId: string;
    occurredAt: Date;
  } | {
    mode: "stand_lookup";
    request: StandLookupRequest;
    topic?: "viga_bucks";
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
  // receives the fixed operation and, only for inventory/payment, selects public catalog values.
  const common = {
    ...(input.topic !== undefined ? { topic: input.topic } : {}),
    taskText: input.taskText,
    // F-046: an answer too long for one message saves its remainder against this sender,
    // and the expiry runs from the message's own time rather than the pass's.
    senderHash: input.senderHash,
    occurredAt: input.occurredAt,
    scope: { includeTestFarms },
  };
  const answer = input.mode === "search_stands"
    ? await answerInquiry(
        { db: deps.db, matcher: deps.catalogMatcher, clock: deps.clock },
        { ...common, mode: "search_stands", request: input.request },
      )
    : await answerInquiry(
        { db: deps.db, matcher: deps.catalogMatcher, clock: deps.clock },
        { ...common, mode: "stand_lookup", request: input.request },
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
      const words = distinctiveWords(stand as Record<string, unknown>);
      const value = score(words);
      if (value === 0) continue;
      /*
        F-111 Phase 2b — the bar. A score of 1 used to count as identification, so the word
        `open` inside "Open Gate Lamb and Grazing" bound every message containing that ordinary
        English word to that farm. The rule and the corpus measurement behind it live with the
        other name-matching logic in `stand-name-match.ts`; scoring stays here because it needs
        the rows.
      */
      if (!meetsDistinctiveWordBar(value, words.length)) continue;
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
 * A farmer updating a stand they hold — the publish path.
 *
 * Opens or revises the sender's ONE pending proposal and returns the confirmation prompt for
 * the outbox. The proposal is activated by the outbound worker once Telnyx accepts that
 * prompt — until then no token can consume it, which is what makes "a token predating its
 * prompt cannot commit" true.
 *
 * **Reached only through the access fork**, and only where `farmer_authorizations` already
 * said this sender holds a live target. Nothing a model returns can reach it directly: the
 * classifier's `inventory_report` is one arm for everyone, and code decides who may publish.
 */
async function handleFarmerInventoryUpdate(
  deps: FreeTextDeps,
  input: {
    senderHash: string;
    taskText: string;
    providerEventId: string;
    occurredAt: Date;
  },
): Promise<FreeTextResult> {
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
            body: `${outcome.confirmationText}\n\n${PROPOSAL_CONFIRMATION_PROMPT}`,
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
  return handleCustomerInquiry(deps, {
    ...input,
    mode: "search_stands",
    request: { operation: "inventory" },
  });
}

/**
 * The `inventory_report` access fork — where B-053 lives now (F-111).
 *
 * The classifier says only that SOMEONE asserted a stand's inventory needs updating. Who may
 * act on that is an **access** question, and it is answered here in code, from
 * `farmer_authorizations`:
 *
 * | sender | access to the resolved stand | flow |
 * |---|---|---|
 * | customer | — | customer-style report; private signal to that stand's farmer |
 * | farmer | **has** access | direct inventory update flow (proposal + confirmation) |
 * | farmer | **no** access | customer-style report — B-053's case |
 *
 * **Why this is code and not a classifier arm.** A prompt-level split was measured and failed:
 * "no eggs left at Pinecone Gardens" from a farmer handset classified as the farmer's OWN
 * update 3/3, which would route a stranger's stock-out into that farmer's publish path. A
 * hostile classifier cannot reach around this, because there is no category meaning "this
 * sender may publish" for it to return.
 *
 * **A stand resolves here and not before.** Resolution runs on the message text, so it must sit
 * below classification — running it first is what let the word `open` inside "Open Gate Lamb
 * and Grazing" bind an ordinary question to a farm.
 *
 * No stand resolved → the existing B-065 clarification, unchanged: hold the report and ask.
 */
async function handleInventoryReport(
  deps: FreeTextDeps,
  input: {
    senderHash: string;
    taskText: string;
    providerEventId: string;
    occurredAt: Date;
  },
  isFarmer: boolean,
): Promise<FreeTextResult> {
  // A customer's report never consults ownership — every stand is someone else's — so the
  // lookup runs only for a farmer. `handleCustomerStockOut` resolves the stand again for
  // itself, including the no-match clarification this deliberately does not duplicate.
  if (!isFarmer) return handleCustomerStockOut(deps, input);

  const stand = await resolveReportedStand(deps.db, input.taskText, false);
  if (stand === null) {
    /*
      A farmer whose message names no stand is updating their OWN listing — the common case,
      and the one the farmer path has always served. There is nothing to check access against
      and nothing ambiguous about it: their authorization names the target.
    */
    return handleFarmerInventoryUpdate(deps, input);
  }

  const ownsIt = await standBelongsToSender(deps.db, {
    senderHash: input.senderHash,
    salesLocationId: stand.id,
    occurredAt: input.occurredAt,
  });

  // Their own stand → publish path. Someone else's → they are a reporter like anyone else,
  // and this can only ever move a farmer's message AWAY from publishing, never toward
  // publishing someone else's (Golden Rule #1).
  return ownsIt
    ? handleFarmerInventoryUpdate(deps, input)
    : handleCustomerStockOut(deps, input);
}

/**
 * Handle a message that is not a deterministic command.
 *
 * Classification happens ONCE, here, and selects a code path. See the file header for the
 * ordering and why each step sits where it does.
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

  /*
    B-065 — a clarifying question Farm Friend asked, and the answer to it.

    This runs ABOVE classification on purpose. The reply to "Which stand are you at?" is a bare
    stand name: it states nothing about stock and names no item, so a classifier correctly calls
    it a lookup and the report is lost. The pending row is what makes it an answer instead.

    It runs BELOW all of deterministic routing, which is the load-bearing placement. STOP, HELP,
    FLAG and the confirmation tokens are decided by `parseCommand` from the body alone, so no
    held context can reinterpret one (Golden Rule #2).

    It applies to any sender. A farmer standing at someone else's stand can answer a
    clarification too, and the held row carries the report either way.
  */
  const resolved = await resolveClarification(deps, input);
  if (resolved !== null) return resolved;

  /*
    Authority is code-owned and resolved from `farmer_authorizations` BEFORE the model runs —
    and it is deliberately NOT sent to it. The classifier's projection carries the message text
    and nothing else, so there is no field through which a manipulated model could assert that a
    sender may publish. It is read here, and used only by the access fork below.
  */
  const isFarmer = await hasLiveFarmerAuthorization(deps.db, {
    senderHash: input.senderHash,
    occurredAt: input.occurredAt,
  });

  const classification = await deps.classifier.classify({ taskText: input.taskText });

  if (!classification.ok) {
    /*
      The model could not be reached, or returned nothing valid. There is deliberately NO
      fallback arm: guessing one would either blame the sender's wording for our outage
      (`unclear`) or answer "no stand has a current listing" — a claim about a corpus nothing
      searched. We say what happened instead.
    */
    return {
      replies: [{
        body: CLASSIFIER_UNAVAILABLE_REPLY,
        category: "inquiry_reply",
        logicalKey: `classify-unavailable-${input.providerEventId}`,
      }],
      handled: "none",
    };
  }

  switch (classification.kind) {
    case "inventory_report":
      return handleInventoryReport(deps, input, isFarmer);

    case "search_stands":
      return handleCustomerInquiry(deps, {
        ...input,
        mode: "search_stands",
        request: classification.request,
        ...(classification.topic !== undefined ? { topic: classification.topic } : {}),
      });

    case "stand_lookup":
      return handleCustomerInquiry(deps, {
        ...input,
        mode: "stand_lookup",
        request: classification.request,
        ...(classification.topic !== undefined ? { topic: classification.topic } : {}),
      });

    case "system_inquiry":
      // The map, answered from the same constant the MAP keyword's URL is validated against.
      return {
        replies: [{
          body:
            classification.topic === "viga_bucks"
              ? VIGA_BUCKS_INQUIRY_REPLY
              : SYSTEM_INQUIRY_REPLY,
          category: "inquiry_reply",
          logicalKey: `system-inquiry-${input.providerEventId}`,
        }],
        handled: "customer",
      };

    case "chitchat":
      return {
        replies: [{
          body: CHITCHAT_REPLY,
          category: "inquiry_reply",
          logicalKey: `chitchat-${input.providerEventId}`,
        }],
        handled: "customer",
      };

    case "unclear":
      // Their message, honestly unhandled — a different fact from the outage reply above, and
      // different words for it.
      return {
        replies: [{
          body: UNCLEAR_REQUEST_REPLY,
          category: "inquiry_reply",
          logicalKey: `unclear-${input.providerEventId}`,
        }],
        handled: "customer",
      };
  }
}
