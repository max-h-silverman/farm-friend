// Customer inquiry: validating the model's interpretation, and the general ranking layer.
//
// Golden Rule #4 in two halves. The model interprets an open-ended request — which items,
// which farm if any, and HOW the customer wants results ordered. Code validates that
// interpretation and executes it.
//
// There is deliberately NO food vocabulary, produce taxonomy, or farm name in this file.
// Item names are opaque strings this layer never interprets: what "kale" means, and whether
// "beets" answers a request for root vegetables, is the model's problem; what a farm
// publishes is the database's. Neither is application policy.
//
// Since F-045 this layer does not decide which items ANSWER a request at all. It orders
// candidates and bounds how many the selection seam sees. Comparing strings to answer a
// question about meaning is what made every category question a false negative.
//
// Ranking is likewise a small set of general OPERATIONS over typed facts, not a semantic
// strategy catalog: "freshest", "coverage", and "any" describe what code does with rows, not
// what a customer might mean. An interpretation naming an operation code cannot perform is
// REFUSED rather than silently downgraded, so an unexecutable intent never masquerades as an
// executed one.

/** A ranking operation code can actually perform over typed rows. */
export type RankingOperation = "freshest" | "coverage" | "any";

const RANKING_OPERATIONS = new Set<string>(["freshest", "coverage", "any"]);

/**
 * What the interpretation seam may conclude.
 *
 * `ambiguous` is a SIGNAL, not a message (F-018). It carried a model-authored `question`
 * that was delivered to the customer verbatim — the one channel through which model prose
 * became customer-facing text in this path. A model asked for a recipe answered with the
 * recipe in that field, canning instructions and links included, and every check passed.
 * The field is gone rather than scanned: code renders what the customer reads, so there is
 * no content to police and nothing to defeat by rewording.
 */
export type InterpretedIntent =
  | {
      kind: "lookup";
      items: string[];
      farmScope?: string;
      ranking: RankingOperation;
      /**
       * The model's read that the request also asked for something launch does not answer:
       * a recipe, cooking or preservation instructions, food-safety guidance (F-018).
       *
       * A BOOLEAN, deliberately. Understanding that "what can I make with kale?" is a
       * recipe request is meaning, which is the model's job — hard-coding a food or
       * request vocabulary here would be exactly the taxonomy-as-policy the architecture
       * forbids. But a flag carries no words: code renders the scope statement, so the
       * model can classify the request without composing a syllable of the reply.
       */
      outOfScopeRequest: boolean;
      /**
       * The model's read that the request needs the customer's own position to answer —
       * "what's closest to me?", "the nearest stand to Burton" (F-017).
       *
       * A BOOLEAN, for exactly F-018's reason. Recognizing that a request is
       * origin-dependent is meaning, which is the model's job; but launch resolves no
       * arbitrary origin over SMS, so the reply is a code-rendered limitation plus the
       * public-map link. A flag carries no geography, so a model cannot answer "you are 2.3
       * miles from Provo Farms" through it — there is no field for a distance, a
       * coordinate, or a direction anywhere in this type.
       *
       * The customer still gets the grounded availability half of their question. Only the
       * proximity claim we cannot support is replaced by an honest statement.
       */
      originDependent: boolean;
    }
  | { kind: "ambiguous" };

export type IntentValidation =
  | { ok: true; value: InterpretedIntent }
  | { ok: false; reason: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Validate untrusted interpretation output. It may describe WHAT to look up and HOW to
 * order it; it may never carry an answer, a fact, or a recipient.
 */
export function validateInterpretedIntent(candidate: unknown): IntentValidation {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, reason: "intent must be an object" };
  }
  const record = candidate as Record<string, unknown>;
  const keys = new Set(Object.keys(record));

  if (record.kind === "ambiguous") {
    // Exactly `kind` and nothing else. A model with no permitted field to write into
    // cannot smuggle prose past this, whatever it names the field.
    if (keys.size !== 1) {
      return { ok: false, reason: "ambiguous is a signal and carries no other field" };
    }
    return { ok: true, value: { kind: "ambiguous" } };
  }

  if (record.kind !== "lookup") {
    return { ok: false, reason: "unsupported intent kind" };
  }

  // Any field beyond these would be the model supplying content or a consequence. Note what
  // is absent and stays absent: `latitude`, `origin`, `distanceMiles`, `nearest`. SMS
  // resolves no arbitrary origin at launch, so model-supplied geography has nowhere to land
  // and is refused here rather than partially honoured (F-017).
  const allowed = new Set([
    "kind",
    "items",
    "farmScope",
    "ranking",
    "outOfScopeRequest",
    "originDependent",
  ]);
  for (const key of keys) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `intent carries no field "${key}"` };
    }
  }

  if (!isStringArray(record.items) || record.items.length === 0) {
    return { ok: false, reason: "lookup requires at least one item" };
  }
  if (record.farmScope !== undefined && typeof record.farmScope !== "string") {
    return { ok: false, reason: "farmScope must be a string when present" };
  }
  if (typeof record.ranking !== "string" || !RANKING_OPERATIONS.has(record.ranking)) {
    // Refuse rather than downgrade: an intent code cannot execute is not an intent it may
    // pretend to have executed.
    return { ok: false, reason: "ranking names an operation code cannot execute" };
  }
  if (record.outOfScopeRequest !== undefined && typeof record.outOfScopeRequest !== "boolean") {
    // A string here would be prose wearing a flag's name.
    return { ok: false, reason: "outOfScopeRequest must be a boolean when present" };
  }
  if (record.originDependent !== undefined && typeof record.originDependent !== "boolean") {
    // A string here would be model-authored geography wearing a flag's name (F-017).
    return { ok: false, reason: "originDependent must be a boolean when present" };
  }

  return {
    ok: true,
    value: {
      kind: "lookup",
      items: record.items,
      ...(record.farmScope !== undefined ? { farmScope: record.farmScope } : {}),
      ranking: record.ranking as RankingOperation,
      outOfScopeRequest: record.outOfScopeRequest === true,
      originDependent: record.originDependent === true,
    },
  };
}

/**
 * The most candidates one selection call may consider.
 *
 * A STATED bound, not an inherited one. Since F-045 code no longer narrows candidates by
 * item name, so without a cap the size of a model call would be whatever the corpus happens
 * to be — fine at 34 stands, silently not fine later. Candidates are ordered before
 * truncation, so the cap drops the least useful rather than an arbitrary slice.
 */
export const MAX_INQUIRY_CANDIDATES = 60;

/** A retrieved candidate location, before selection and rendering. */
export interface InquiryCandidate {
  factId: string;
  farmName: string;
  locationName: string;
  /** The published item names this location carries, whether confirmed or typical. */
  matchedItemNames: string[];
  asOf: Date;
}

export interface RankingRequest {
  ranking: RankingOperation;
  items: string[];
  farmScope?: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Order the candidates a selection call will see, and bound how many there are.
 *
 * This layer ORDERS and CAPS; since F-045 it no longer decides which items answer the
 * request. It used to drop every candidate whose published names did not exactly equal a
 * requested word, which meant "leafy greens" could never reach a stand publishing "butter
 * lettuce" and "root vegetables" could never reach "beets" — code was answering a question
 * about meaning by comparing strings, and answering it wrong. The only layer that
 * understands that relationship is the model, and it sat downstream of the filter.
 *
 * The alternative — a synonym table here — is the food-taxonomy-as-policy CLAUDE.md
 * forbids, and no finite list would cover an open corpus of farmer-authored item names.
 *
 * Grounding is untouched: code still retrieves the facts, still validates every identifier
 * the model returns against the retrieved set, and still renders every word. What moved is
 * RECALL, which is a quality property, not an authority one.
 *
 * Farm scope stays a code filter: a farm name is an identifier the customer named, which
 * code can compare exactly, and it is applied BEFORE the cap so a scoped question can never
 * be truncated away.
 *
 * Ordering is total and stable, so the same inputs always produce the same call.
 */
export function rankCandidates(
  candidates: InquiryCandidate[],
  request: RankingRequest,
): InquiryCandidate[] {
  const wanted = new Set(request.items.map(normalize));
  const scope = request.farmScope !== undefined ? normalize(request.farmScope) : undefined;

  // Exact name overlap is now an ORDERING hint rather than a gate: when it hits it puts the
  // obvious answers first, and when it misses it costs nothing, because nobody is dropped.
  const coverageOf = (candidate: InquiryCandidate): number =>
    new Set(
      candidate.matchedItemNames.map(normalize).filter((name) => wanted.has(name)),
    ).size;

  const inScope =
    scope === undefined
      ? candidates
      : candidates.filter((candidate) => normalize(candidate.farmName) === scope);

  const byRecency = (a: InquiryCandidate, b: InquiryCandidate) =>
    b.asOf.getTime() - a.asOf.getTime();

  const ordered =
    request.ranking === "coverage"
      ? [...inScope].sort((a, b) => coverageOf(b) - coverageOf(a) || byRecency(a, b))
      : // "freshest" and "any" both order by recency: a customer asking generally is best
        // served by the most recently confirmed listing, and this keeps ordering total.
        [...inScope].sort(byRecency);

  return ordered.slice(0, MAX_INQUIRY_CANDIDATES);
}
