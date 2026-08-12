// B-061 defect 4 — "what do you have" is the most ordinary question a customer can send, and
// the model answers it with "Sorry, I did not catch which item or farm you meant."
//
// WHY THIS IS CODE AND NOT AN INSTRUCTION. Measured live 2026-08-11: the phrase came back
// `ambiguous` 10 runs out of 10 while that exact phrase was written into the interpretation
// instruction as a broad lookup that is "never ambiguous". Enumerating the failing phrasings
// lifted the rest of the family (5/21 -> 15/21) but never reached this one, and three earlier
// instruction edits had each moved WHICH phrasings passed while regressing others. The model
// matches the instruction's vocabulary rather than its concept, so prose is the wrong lever:
// the property has to hold whichever model is installed (Golden Rule: swap the brain, which
// properties survive?), and "the customer can ask what there is to buy" is one of those.
//
// WHAT THIS DOES NOT DO. It is not a produce taxonomy and holds no food or farm vocabulary —
// CLAUDE.md forbids hard-coding what the model can understand, and `broad-request.test.ts`
// asserts against this file's own source that no crop word appears here. It recognizes
// SHOPPING-INTENT GRAMMAR: an open question about having, selling, or buying that names no
// product. A message that names a product is left entirely alone, because a named item still
// needs the model's semantic matching ("leafy greens" -> "butter lettuce") which the broad
// paging path deliberately skips.
//
// It only ever OVERRIDES `ambiguous`, and only toward answering. A model that already returned
// a lookup keeps its interpretation.

/** Open interrogatives that begin a request for the whole set. */
const OPEN_SUBJECT = /\b(what|whats|which|who|anything|something|any)\b/;

/**
 * Verbs of commerce and possession. Grammar, not menu: these describe the TRANSACTION the
 * customer is asking about, and none of them is a thing anyone grows.
 */
const COMMERCE_VERB =
  /\b(have|has|have you got|got|sell|selling|sells|sale|buy|buying|available|carry|carrying|stock|stocking|offer|offering|out there|in season|open)\b/;

/**
 * A product noun would follow the verb. We cannot list nouns without becoming a taxonomy, so
 * this instead recognizes the SHAPE of a message that carries a specific target: a preposition
 * or determiner introducing an object ("do you have ANY EGGS", "what do you have FOR tomatoes",
 * "is PROVO FARMS open"). The precise test is done by the caller in `isBroadAvailabilityRequest`
 * — see the trailing-content rule there.
 */
const OBJECT_INTRODUCER = /\b(any|some|for|of|about|got any|with)\b/;

/**
 * Filler that carries no product: time words, politeness, and the open-set pronouns. Stripping
 * these is what lets "what do you have TODAY" and "what do you have RIGHT NOW" read as broad
 * while "what do you have FOR TOMATOES" does not.
 */
const FILLER =
  /\b(you|your|yall|y'all|u|do|does|did|is|are|am|can|could|would|should|will|the|a|an|there|here|today|todays|tonight|now|right|currently|current|at|in|on|this|that|these|those|it|guys|folks|people|anyone|anybody|everyone|somebody|someone|stands?|stand|me|i|we|us|good|nice|fresh|worth|stopping|selling|sale|out|around|nearby|local|please|thanks|thank|hi|hey|hello|show|tell|know|see|get|going|left|still|much|many|kind|kinds|sort|sorts|stuff|things?|else|new|up|by|from|to|and|or|but|so|just|really|actually|today's)\b/g;

/**
 * Does this message ask, in any wording, what there is to buy?
 *
 * Returns false for anything that names a product or a farm — those stay on the model's
 * semantic path — and for greetings and chat, which are genuinely ambiguous.
 */
export function isBroadAvailabilityRequest(text: string): boolean {
  const normalized = text
    .toLowerCase()
    // Possessives and contractions collapse so "what's" and "what is" are one shape.
    .replace(/['’]s\b/g, " is")
    .replace(/['’]re\b/g, " are")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized === "") return false;
  if (!OPEN_SUBJECT.test(normalized)) return false;

  // A commerce verb is the usual signal, but the shortest real requests have none: "anything
  // good today?" is an open pronoun plus evaluative filler. Those are still unmistakably a
  // request for the whole set, and the residue test below is what keeps them honest — a
  // message naming any target fails it regardless of which branch let it through here.
  const OPEN_PRONOUN_ONLY = /\b(anything|something|any)\b/.test(normalized);
  if (!COMMERCE_VERB.test(normalized) && !OPEN_PRONOUN_ONLY) return false;

  // The decisive test: after removing the interrogative, the commerce verb, and pure filler,
  // is there a CONTENT WORD left? If so the customer named something specific — a product, a
  // farm, a person — and this is not a request for the whole set. This is why no vocabulary is
  // needed: an unknown leftover word is treated as a named target precisely BECAUSE it is
  // unknown, so a crop nobody has heard of still routes to the model.
  const residue = normalized
    .replace(new RegExp(OPEN_SUBJECT.source, "g"), " ")
    .replace(new RegExp(COMMERCE_VERB.source, "g"), " ")
    .replace(new RegExp(OBJECT_INTRODUCER.source, "g"), " ")
    .replace(FILLER, " ")
    .replace(/\s+/g, " ")
    .trim();

  return residue === "";
}
