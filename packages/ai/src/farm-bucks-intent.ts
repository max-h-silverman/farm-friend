// The VIGA Bucks domain resolver (F-111): recognise the service's own currency program in
// CODE, and answer the small set of question shapes it supports.
//
// WHY THIS IS NOT A VIOLATION OF "no business code hard-codes what the model can understand".
// That rule forbids FARM and FOOD vocabulary in behavioural branches — sellers, foods and
// listings are data that changes as VIGA adds stands and seasons turn, and a branch naming one
// of them rots. VIGA Bucks is none of those. It is a FIXED PROGRAM OF THE SERVICE, in the same
// class as MAP or STOP: there is exactly one, it is a stored column (`sellers.farm_bucks_accepted`
// since F-125 moved payment to the seller), and it does not vary per farm. Recognising it here is
// the same act as recognising a keyword (max, 2026-08-13).
//
// WHY CODE RATHER THAN PROMPT. "VIGA" is an organisation name a general model has no context
// for, so messages containing it drift unpredictably: "does Pinecone take VIGA Bucks?" returned
// `system_inquiry` despite naming a stand, and "what is viga" returned `search_stands`. Two
// instruction rewrites each fixed one case and regressed another, because a prompt rule
// mentioning payment gets applied to any message containing the payment word regardless of what
// is being asked. The distinction is syntactic, and syntax is code's.
//
// THE RESOLVER CLAIMS QUESTION SHAPES, NOT THE PHRASE (max, 2026-08-13). Containing "viga
// bucks" is necessary and never sufficient. "no viga bucks left" means the ALLOCATION is
// exhausted — not farm-stand inventory — and the system holds no data and promises no behaviour
// about VIGA Bucks distribution, so it must fall through to the ordinary classifier rather than
// being swept into a payment search or, far worse, into farm inventory handling.

/**
 * The concept, in the spellings people type: `viga` immediately followed by `buck(s)`, plus the
 * bare `farm bucks` the schema itself uses.
 *
 * **The PAIR is required.** Bare `viga` is deliberately not the concept — a question about the
 * organisation ("what is viga") is a different thing and stays with the ordinary classifier.
 *
 * Separator-tolerant (`viga bucks`, `vigabucks`, `Viga-Bucks`) because a text message is typed
 * on a phone, and the concept is what was meant either way.
 */
const FARM_BUCKS = String.raw`(?:viga[\s-]*bucks?|farm[\s-]*bucks?)`;

/** Subjects meaning "any stand, unspecified" — the population rather than one member. */
const ANY_STAND_SUBJECT =
  String.raw`(?:who|whos|who\s+is|anyone|any\s?one|anybody|somebody|` +
  String.raw`(?:which|what|any)\s+(?:farm\s?)?stands?|(?:which|what|any)\s+sellers?)`;

/** Verbs of acceptance, finite and modal-supported forms. */
const ACCEPT_VERB = String.raw`(?:takes?|accepts?|honou?rs?|will\s+take|will\s+accept)`;

/**
 * Optional politeness and the anchor. Every pattern below LEADS with its question shape, so a
 * subject buried mid-sentence ("tell me who takes viga bucks", "the stand that takes viga bucks
 * is closed") is not a question this resolver answers.
 */
const LEAD = String.raw`^\s*(?:hi|hey|hello)?[,\s]*`;

/**
 * "What are VIGA Bucks", "how do I get them", "where do I buy them" — a question about the
 * PROGRAM. Answered from service information, not from any stand's row.
 */
const ABOUT = new RegExp(
  LEAD +
    String.raw`(?:` +
    // what is / what are <phrase>
    String.raw`what\s+(?:is|are|s)\s+(?:a\s+|the\s+|my\s+)?${FARM_BUCKS}` +
    String.raw`|` +
    // how do <phrase> work
    String.raw`how\s+d(?:o|oes)\s+${FARM_BUCKS}\s+work` +
    String.raw`|` +
    // how / where do I get|buy|earn|find <phrase>
    String.raw`(?:how|where)\s+(?:can|do|would)\s+(?:i|we|you)\s+` +
    String.raw`(?:get|buy|earn|find|obtain|purchase)\s+(?:some\s+|more\s+)?${FARM_BUCKS}` +
    String.raw`)`,
  "i",
);

/**
 * "Who takes VIGA Bucks", "where can I spend them" — which stands accept the currency.
 *
 * Two shapes: an any-stand subject with an acceptance verb, or a spend/use question, which
 * carries no subject but means the same request.
 */
const SEARCH = new RegExp(
  LEAD +
    String.raw`(?:` +
    // (do/does) <any-stand subject> take|accept <phrase>
    String.raw`(?:do(?:es)?\s+)?${ANY_STAND_SUBJECT}\s+(?:still\s+)?${ACCEPT_VERB}\s+` +
    String.raw`(?:my\s+|a\s+|the\s+)?${FARM_BUCKS}` +
    String.raw`|` +
    // where can I spend|use <phrase>
    String.raw`(?:where|who)\s+can\s+(?:i|we|you)\s+(?:spend|use|redeem)\s+` +
    String.raw`(?:my\s+|a\s+|the\s+)?${FARM_BUCKS}` +
    String.raw`|` +
    // anywhere I can spend <phrase>
    String.raw`anywhere\s+(?:i|we|you)\s+can\s+(?:spend|use|redeem)\s+` +
    String.raw`(?:my\s+|a\s+|the\s+)?${FARM_BUCKS}` +
    String.raw`)`,
  "i",
);

/**
 * "Does Pinecone take VIGA Bucks?" — an acceptance question whose subject is something
 * stand-like rather than "anyone".
 *
 * **This maps straight to `stand_lookup`; it does NOT depend on the name resolving** (max,
 * 2026-08-13). The classification question is whether the sender is asking about ONE SPECIFIC
 * stand, and "does Blahblah take VIGA Bucks?" is that question whether or not Blahblah exists.
 * Entity resolution is a separate downstream concern with its own established behaviour — the
 * clarification and no-match paths — and folding it in here would make a classification depend
 * on the corpus.
 *
 * The subject is matched as "one to four words that are not an any-stand subject", which is
 * what a stand name looks like in this position.
 */
const STAND_SCOPED = new RegExp(
  LEAD +
    String.raw`(?:do(?:es)?|will|has|have)\s+` +
    String.raw`(?!${ANY_STAND_SUBJECT}\b)` +
    String.raw`((?:[a-z0-9'’-]+\s+){0,3}[a-z0-9'’-]+)\s+` +
    String.raw`(?:still\s+)?${ACCEPT_VERB}\s+(?:my\s+|a\s+|the\s+)?${FARM_BUCKS}`,
  "i",
);

/**
 * A STATEMENT about the currency that is not one of the supported questions — "no viga bucks
 * left", "out of viga bucks", "my viga bucks expired", "I earned viga bucks".
 *
 * **This is the domain override** (max, 2026-08-13). Grammatically "no viga bucks left" is
 * identical to "no eggs left", so the general classifier returns `inventory_report` for it —
 * correctly applying an instruction rule we need for real reports. The model is not wrong; it
 * lacks the domain fact that VIGA Bucks are not stand inventory. The application holds that
 * fact, so the override lives here rather than in prose that would endanger "no eggs left".
 *
 * The two families are the ones that would otherwise be misread:
 *   - a QUANTITY claim ("no …", "out of …", "all out of …", "… left") → reads as inventory
 *   - a POSSESSION or lifecycle claim ("I have …", "I earned …", "my … expired")
 *
 * Deliberately narrow: a bare mention or an opinion ("thanks for the viga bucks", "the viga
 * bucks program is great") carries no such claim and still falls through, because chitchat is
 * the right answer there and this module has no better knowledge to contribute.
 */
const UNSUPPORTED_STATEMENT = new RegExp(
  LEAD +
    String.raw`(?:` +
    // Quantity claims: "no viga bucks left", "out of viga bucks", "all out of farm bucks".
    String.raw`(?:no|out\s+of|all\s+out\s+of|ran\s+out\s+of)\s+(?:more\s+)?${FARM_BUCKS}` +
    String.raw`|` +
    // Possession and lifecycle: "I have/earned/got/spent/used my viga bucks", "my … expired".
    String.raw`(?:i|we)\s+(?:have|earned|got|received|spent|used|lost)\s+` +
    String.raw`(?:some\s+|my\s+|a\s+|the\s+)?${FARM_BUCKS}` +
    String.raw`|` +
    String.raw`my\s+${FARM_BUCKS}\s+(?:expired|ran\s+out|are\s+gone)` +
    String.raw`)`,
  "i",
);

/**
 * What a message says about VIGA Bucks, or `null` when this module holds no domain knowledge
 * that would improve on the ordinary classifier.
 *
 * - `"search"`                — which stands accept, or where to spend them → `search_stands`
 * - `"about"`                 — what they are, or how to get them → `system_inquiry`
 * - `"stand_scoped"`          — acceptance at ONE specific stand → `stand_lookup`, whether or
 *                               not the name resolves; entity resolution is downstream
 * - `"unsupported_statement"` — a claim about the currency that is NOT stand inventory →
 *                               `unclear`, and never `inventory_report`
 * - `null`                    — nothing to claim; the ordinary classifier decides
 */
export type FarmBucksIntent =
  | "search"
  | "about"
  | "stand_scoped"
  | "unsupported_statement";

export function farmBucksIntent(message: string): FarmBucksIntent | null {
  const text = message.trim();
  // Cheap guard first: without the concept there is nothing here to claim.
  if (!new RegExp(FARM_BUCKS, "i").test(text)) return null;

  // `about` is tested before the acceptance shapes: "where do I get viga bucks" and "where can
  // I spend viga bucks" are one word apart, and the getting question is the more specific.
  if (ABOUT.test(text)) return "about";
  if (SEARCH.test(text)) return "search";
  if (STAND_SCOPED.test(text)) return "stand_scoped";
  // Questions first, statements last: a question is what we can answer, and only what is left
  // over needs the override that keeps it out of inventory handling.
  if (UNSUPPORTED_STATEMENT.test(text)) return "unsupported_statement";
  return null;
}
