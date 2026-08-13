// The acceptance-question matcher (F-111): "who takes X?" is a search across stands, decided
// by CODE from the sentence's shape.
//
// WHY THIS IS CODE. "who takes viga bucks?" is a real customer question, and the classifier
// stably returned `system_inquiry` for it — VIGA is an organisation name, so the model read the
// message as being about the organisation rather than about which stands accept its currency.
// Two attempts to fix that in the instruction BOTH made things worse: a rule mentioning payment
// gets applied to any message containing the payment word, so "what are viga bucks" flipped
// from `system_inquiry` to `search_stands` and an unrelated case destabilised. Measured, twice.
//
// The distinction is SYNTACTIC — who is the subject of the accepting? — and syntax is exactly
// what code decides better than a prompt. It also survives a model swap, which no instruction
// wording does.
//
// WHAT THIS DELIBERATELY DOES NOT KNOW. No farm names, no organisation names, no currency or
// payment vocabulary. It matches a SHAPE: an unspecified-stand subject, a verb of acceptance,
// and an object. "who takes bottle caps" matches; "viga bucks" alone does not. VIGA renaming
// its currency cannot break it, which is the whole reason it is shaped this way
// (CLAUDE.md: no business code hard-codes what the model can understand).

/**
 * Subjects meaning "any stand, unspecified" — the population, never one member.
 *
 * A SPECIFIC stand is deliberately absent: "does Pinecone take viga bucks" is a question about
 * Pinecone and must reach the model, which classifies it `stand_lookup`. That boundary is the
 * matcher's most important silence.
 */
const ANY_STAND_SUBJECT =
  String.raw`(?:who|whos|who\s+is|anyone|any\s?one|anybody|somebody|` +
  String.raw`(?:which|what|any)\s+(?:farm\s?)?stands?|(?:which|what|any)\s+farms?)`;

/**
 * Verbs of acceptance, finite forms only.
 *
 * Narrow on purpose: "have" and "sell" are about inventory, and admitting them would swallow
 * "who has eggs?" — a search the model already classifies correctly, and one whose answer comes
 * from a different retrieval path.
 */
const ACCEPT_VERB = String.raw`(?:takes?|accepts?|honou?rs?)`;

/**
 * The same verbs as gerunds. Kept SEPARATE because a gerund is admitted only after an explicit
 * auxiliary — see the pattern below.
 */
const ACCEPT_GERUND = String.raw`(?:taking|accepting|honou?ring)`;

/**
 * The acceptance-question pattern.
 *
 * **Anchored at the start** (after optional politeness), so a subject buried mid-sentence
 * cannot trigger it: "tell me who takes viga bucks" and "the stand that takes viga bucks is
 * closed" are both silent. **An object is required**, so a truncated "who takes" is silent.
 *
 * Two admitted forms:
 *   1. optional `do`/`does` + subject + finite verb — "who takes X", "does anyone take X"
 *   2. REQUIRED `is`/`are` + subject + gerund       — "is anyone taking X"
 *
 * Form 2's auxiliary is load-bearing rather than tidy: with the gerund in the main alternation,
 * "anyone taking donations" matched on a bare subject, and so would any noun phrase whose last
 * word happened to be a subject word.
 */
const ACCEPTANCE_QUESTION = new RegExp(
  String.raw`^\s*(?:hi|hey|hello)?[,\s]*(?:` +
    String.raw`(?:do(?:es)?\s+)?` +
    ANY_STAND_SUBJECT +
    String.raw`\s+(?:still\s+)?` +
    ACCEPT_VERB +
    String.raw`|` +
    String.raw`(?:is|are)\s+` +
    ANY_STAND_SUBJECT +
    String.raw`\s+(?:still\s+)?` +
    ACCEPT_GERUND +
    String.raw`)\s+\S`,
  "i",
);

/**
 * Whether a message asks which stands accept something.
 *
 * `true` means the request classifier may answer `search_stands` without a model call. It is a
 * SHORTCUT to a category the model can also produce — never a route to a consequence the
 * model's own output could not reach.
 */
export function isAcceptanceQuestion(message: string): boolean {
  return ACCEPTANCE_QUESTION.test(message.trim());
}
