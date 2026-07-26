// Customer inquiry: validating the model's interpretation, and the general ranking layer.
//
// Golden Rule #4 in two halves. The model interprets an open-ended request — which items,
// which farm if any, and HOW the customer wants results ordered. Code validates that
// interpretation and executes it.
//
// There is deliberately NO food vocabulary, produce taxonomy, or farm name in this file.
// Items are opaque strings compared to opaque strings; a location either publishes a
// matching item name or it does not. What "kale" means is the model's problem, and what a
// farm currently has is the database's — neither is application policy.
//
// Ranking is likewise a small set of general OPERATIONS over typed facts, not a semantic
// strategy catalog: "freshest", "coverage", and "any" describe what code does with rows, not
// what a customer might mean. An interpretation naming an operation code cannot perform is
// REFUSED rather than silently downgraded, so an unexecutable intent never masquerades as an
// executed one.

/** A ranking operation code can actually perform over typed rows. */
export type RankingOperation = "freshest" | "coverage" | "any";

const RANKING_OPERATIONS = new Set<string>(["freshest", "coverage", "any"]);

/** What the interpretation seam may conclude. */
export type InterpretedIntent =
  | {
      kind: "lookup";
      items: string[];
      farmScope?: string;
      ranking: RankingOperation;
    }
  | { kind: "ambiguous"; question: string };

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
    if (keys.size !== 2 || typeof record.question !== "string") {
      return { ok: false, reason: "ambiguous carries only a question" };
    }
    if (record.question.trim() === "") {
      return { ok: false, reason: "ambiguous requires a question" };
    }
    return { ok: true, value: { kind: "ambiguous", question: record.question } };
  }

  if (record.kind !== "lookup") {
    return { ok: false, reason: "unsupported intent kind" };
  }

  // Any field beyond these would be the model supplying content or a consequence.
  const allowed = new Set(["kind", "items", "farmScope", "ranking"]);
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

  return {
    ok: true,
    value: {
      kind: "lookup",
      items: record.items,
      ...(record.farmScope !== undefined ? { farmScope: record.farmScope } : {}),
      ranking: record.ranking as RankingOperation,
    },
  };
}

/** A retrieved candidate location, before selection and rendering. */
export interface InquiryCandidate {
  factId: string;
  farmName: string;
  locationName: string;
  /** The published item names this location currently carries that matched the request. */
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
 * Filter to locations carrying a requested item, then order them by the requested
 * operation. Ordering is total and stable: coverage ties break by recency, so the same
 * inputs always produce the same ordering regardless of input order.
 */
export function rankCandidates(
  candidates: InquiryCandidate[],
  request: RankingRequest,
): InquiryCandidate[] {
  const wanted = new Set(request.items.map(normalize));
  const scope = request.farmScope !== undefined ? normalize(request.farmScope) : undefined;

  const coverageOf = (candidate: InquiryCandidate): number =>
    new Set(
      candidate.matchedItemNames.map(normalize).filter((name) => wanted.has(name)),
    ).size;

  const matching = candidates.filter((candidate) => {
    if (scope !== undefined && normalize(candidate.farmName) !== scope) return false;
    return coverageOf(candidate) > 0;
  });

  const byRecency = (a: InquiryCandidate, b: InquiryCandidate) =>
    b.asOf.getTime() - a.asOf.getTime();

  if (request.ranking === "coverage") {
    return [...matching].sort(
      (a, b) => coverageOf(b) - coverageOf(a) || byRecency(a, b),
    );
  }
  // "freshest" and "any" both order by recency: a customer asking generally is best served
  // by the most recently confirmed listing, and this keeps ordering total for "any".
  return [...matching].sort(byRecency);
}
