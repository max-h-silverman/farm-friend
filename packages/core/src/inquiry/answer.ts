// Customer inquiry: typed retrieved facts → the code-rendered authoritative answer.
//
// This module is the "code commits" half of Golden Rule #4. The model may interpret the
// request and SELECT or ORDER identifiers from what code retrieved; it never authors the
// factual text. Everything a customer reads about what a stand has, and how fresh that is,
// is rendered here from typed authoritative values.
//
// The division of labour, precisely:
//   - code retrieves    → RetrievedFact[] with stable opaque IDs and asOf timestamps
//   - the model selects → factId[] (and nothing else deliverable)
//   - code validates    → every selected ID must belong to the retrieved set
//   - code renders      → names, items, recency, stale warnings, comparisons
//
// There is deliberately no path by which a model-supplied string becomes customer-facing
// factual text.

import type { Clock } from "../clock";

/** One retrieved sales location with the authoritative values the renderer needs. */
export interface RetrievedFact {
  /** Opaque stable identifier. The only thing the model may hand back. */
  factId: string;
  locationName: string;
  farmName: string;
  publicAddress: string;
  /** The matched items this location currently publishes, in published order. */
  matchedItems: RetrievedItem[];
  /** When the farmer last confirmed this location's inventory. */
  asOf: Date;
}

export interface RetrievedItem {
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/**
 * Inventory older than this is shown with a prominent staleness warning rather than
 * disappearing: unattended honor-system stands are usually right but never certain, and
 * hiding an old listing serves the customer worse than labelling it (PRODUCT_BRIEF).
 */
export const STALE_AFTER_HOURS = 48;

export class AnswerRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerRenderError";
  }
}

/** The model's selection: ordered opaque IDs, or an explicit request to clarify. */
export type FactSelection =
  | { kind: "selection"; factIds: string[] }
  | { kind: "clarification"; question: string };

export type SelectionValidation =
  | { ok: true; value: FactSelection }
  | { ok: false; reason: string };

/**
 * Validate untrusted selection output. Structural validity is NOT grounding: every selected
 * identifier must belong to the exact retrieved set, and no deliverable factual string may
 * appear anywhere in the output.
 */
export function validateFactSelection(
  candidate: unknown,
  retrieved: RetrievedFact[],
): SelectionValidation {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, reason: "selection must be an object" };
  }
  const record = candidate as Record<string, unknown>;
  const keys = Object.keys(record);

  if (record.kind === "clarification") {
    if (keys.length !== 2 || typeof record.question !== "string") {
      return { ok: false, reason: "clarification carries only a question" };
    }
    if (record.question.trim() === "") {
      return { ok: false, reason: "clarification requires a question" };
    }
    return { ok: true, value: { kind: "clarification", question: record.question } };
  }

  if (record.kind !== "selection") {
    return { ok: false, reason: "unsupported selection kind" };
  }
  // A field like `answerText`, `distance`, or `recency` would be the model supplying
  // authoritative content. The answer is code's; the model returns identifiers only.
  if (keys.length !== 2 || !("factIds" in record)) {
    return { ok: false, reason: "selection carries only ordered fact identifiers" };
  }
  if (!Array.isArray(record.factIds)) {
    return { ok: false, reason: "factIds must be an array" };
  }

  const known = new Set(retrieved.map((fact) => fact.factId));
  const seen = new Set<string>();
  for (const factId of record.factIds) {
    if (typeof factId !== "string") {
      return { ok: false, reason: "a fact identifier must be a string" };
    }
    if (!known.has(factId)) {
      // The model invented or hallucinated an identifier: reject the whole selection.
      return { ok: false, reason: `fact ${factId} is not part of the retrieved set` };
    }
    if (seen.has(factId)) {
      return { ok: false, reason: `fact ${factId} is selected more than once` };
    }
    seen.add(factId);
  }

  return { ok: true, value: { kind: "selection", factIds: record.factIds as string[] } };
}

/** Render "updated X ago" from typed values. Never approximated by a model. */
export function renderRecency(asOf: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - asOf.getTime()) / 60_000));
  if (minutes < 60) {
    return minutes <= 1 ? "updated just now" : `updated ${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "updated 1 hour ago" : `updated ${hours} hours ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "updated 1 day ago" : `updated ${days} days ago`;
}

/** True when a fact is old enough that the answer must carry a staleness warning. */
export function isStale(asOf: Date, now: Date): boolean {
  return now.getTime() - asOf.getTime() >= STALE_AFTER_HOURS * 3_600_000;
}

function renderItem(item: RetrievedItem): string {
  const detail =
    item.quantity !== undefined && item.unit !== undefined
      ? `${item.quantity} ${item.unit}`
      : item.quantity !== undefined
        ? `${item.quantity}`
        : item.approximation;

  const parts = [detail, item.priceText].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return parts.length > 0 ? `${item.itemName} (${parts.join(", ")})` : item.itemName;
}

/**
 * The code-rendered honest response when retrieval found nothing. Reached WITHOUT a
 * grounded-selection model call: there is nothing to select from, so asking a model could
 * only invent.
 */
export function renderNoCurrentListing(itemsRequested: string[]): string {
  const subject =
    itemsRequested.length > 0 ? itemsRequested.join(", ") : "that";
  return (
    `No stand has a current listing for ${subject}. ` +
    `Listings show what farmers last confirmed, so something may still be available.`
  );
}

/**
 * Render the authoritative answer from the selected facts, in the model's chosen order.
 * Every value comes from the typed retrieved projection; nothing is model-authored.
 */
export function renderGroundedAnswer(
  selectedFactIds: string[],
  retrieved: RetrievedFact[],
  clock: Clock,
): string {
  const byId = new Map(retrieved.map((fact) => [fact.factId, fact]));
  const now = clock.now();

  const facts = selectedFactIds.map((factId) => {
    const fact = byId.get(factId);
    if (!fact) {
      // Unreachable via validateFactSelection; fail loudly rather than render a gap.
      throw new AnswerRenderError(`fact ${factId} is not in the retrieved set`);
    }
    return fact;
  });

  if (facts.length === 0) return renderNoCurrentListing([]);

  const lines = facts.map((fact) => {
    const items = fact.matchedItems.map(renderItem).join(", ");
    const recency = renderRecency(fact.asOf, now);
    const stale = isStale(fact.asOf, now) ? " - may be out of date" : "";
    const body = items === "" ? fact.locationName : `${fact.locationName}: ${items}`;
    return `${body} (${recency}${stale})`;
  });

  return lines.join("\n");
}
