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

/**
 * What kind of claim a retrieved fact supports (F-045).
 *
 * `confirmed` — a farmer published this inventory at `asOf`. Carries recency, and goes
 * stale.
 * `offering` — a standing description of what the stand typically stocks. Nobody confirmed
 * anything, so it carries NO timestamp and never goes stale: attaching an elapsed phrase
 * would manufacture a confirmation that never happened.
 *
 * The distinction is the same one the public map draws between its confirmed line and its
 * "Usually sells" line (F-042). Two surfaces, one rule.
 */
export type FactBasis = "confirmed" | "offering";

/**
 * One retrieved sales location with the authoritative values the renderer needs.
 *
 * There is exactly ONE fact type, deliberately (F-046). Selection validation and page
 * rendering used to take near-identical shapes differing only in whether the address could be
 * null — and the nullable half was the true one, which is how F-045 shipped the literal word
 * "null" to customers past a compiler that was satisfied.
 */
export interface RetrievedFact {
  /** Opaque stable identifier. The only thing the model may hand back. */
  factId: string;
  locationName: string;
  farmName: string;
  /**
   * Nullable, because the column is: two real stands carry no public address. A stand with no
   * address is still a real answer to "who has lamb?" — it just cannot be navigated to.
   */
  publicAddress: string | null;
  /** The matched items this location publishes, in published order. */
  matchedItems: RetrievedItem[];
  /**
   * When the farmer last confirmed this location's inventory. For an `offering` this
   * orders candidates but is never rendered — nothing was confirmed.
   */
  asOf: Date;
  basis: FactBasis;
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

/**
 * The model's selection: ordered opaque IDs, or a bare signal that it cannot choose.
 *
 * `clarification` carries no `question` (F-018). Like the interpretation seam's ambiguity
 * signal, it was a field model prose travelled through to the customer; code renders the
 * words via `renderClarificationRequest`.
 */
export type FactSelection =
  | { kind: "selection"; factIds: string[] }
  | { kind: "clarification" };

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
    // Exactly `kind`. No permitted field means no prose channel to smuggle through.
    if (keys.length !== 1) {
      return { ok: false, reason: "clarification is a signal and carries no other field" };
    }
    return { ok: true, value: { kind: "clarification" } };
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

/**
 * Render the bare elapsed phrase — "4 hours ago", "just now" — from typed values.
 *
 * The verb is the CALLER's, because two surfaces say it differently: the SMS answer says
 * "updated 4 hours ago" and the public map's confirmed line says "Confirmed 4 hours ago"
 * (F-042). The arithmetic behind both is stated once, here, so web and SMS cannot come to
 * disagree about how fresh the same row is.
 */
export function renderElapsed(asOf: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - asOf.getTime()) / 60_000));
  if (minutes < 60) {
    return minutes <= 1 ? "just now" : `${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Render "updated X ago" from typed values. Never approximated by a model. */
export function renderRecency(asOf: Date, now: Date): string {
  return `updated ${renderElapsed(asOf, now)}`;
}

/** True when a fact is old enough that the answer must carry a staleness warning. */
export function isStale(asOf: Date, now: Date): boolean {
  return now.getTime() - asOf.getTime() >= STALE_AFTER_HOURS * 3_600_000;
}

/**
 * Render one published item — "Kale (6 bunches, $4)" — from typed values.
 *
 * Exported so the page renderer shares it (F-046). A second copy in `paging.ts` would be two
 * places a quantity could come to be formatted differently for the same row.
 */
export function renderItem(item: RetrievedItem): string {
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
 * The code-rendered question asked when the model signals it could not pin down what the
 * customer wants. The model contributes the SIGNAL; this supplies the words (F-018).
 *
 * Model-authored prose used to travel here in an `ambiguous.question` field, which made
 * this the one path where a model could put arbitrary text — a recipe, canning advice, a
 * link — in front of a customer with every check passing. Rendering it in code removes the
 * channel rather than inspecting what flows through it.
 */
export function renderClarificationRequest(): string {
  return (
    "Sorry, I did not catch which item or farm you meant. " +
    "Reply with what you are looking for and I will check what stands have it."
  );
}

/**
 * The code-rendered response to a request outside what launch answers — recipes, cooking
 * or preservation instructions, and food-safety guidance (F-018).
 *
 * Farm Friend answers the grounded availability half of such a request from typed facts and
 * then states this boundary. It is a scope statement, not a disclaimer attached to generated
 * content: no recipe or safety text is produced anywhere for it to qualify.
 */
export const RECIPE_SCOPE_STATEMENT =
  "Farm Friend does not provide recipes, cooking or preservation instructions, " +
  "or food-safety guidance.";

/**
 * The public web map. The one place a customer is sent for anything needing their position.
 *
 * It is a constant rather than configuration because it is a product fact stated in customer
 * copy, and a wrong or empty value would be delivered as an SMS to a real person.
 */
export const PUBLIC_MAP_URL = "https://www.vigavashon.org/farm-stand-map";

/**
 * The code-rendered response to a request that needs the customer's own position (F-017).
 *
 * Launch resolves no arbitrary origin over SMS — no geocoder, no address lookup, no
 * device location in a text message. The approved boundary keeps origin-aware proximity on
 * the public web, where the browser can offer a transient position with permission.
 *
 * So this says what Farm Friend cannot do and where the customer can do it, and it claims
 * NO distance, direction, or travel time. The alternative failure modes this exists to
 * prevent are both dishonest: inventing a proximity answer, or silently returning an
 * unranked list as though it had answered "which is closest?".
 *
 * Like the recipe scope statement, the model contributes only a boolean signal; every word
 * here is code's.
 */
export const ORIGIN_LIMITATION_STATEMENT =
  "Farm Friend cannot work out which stand is closest to you over text. " +
  `The map at ${PUBLIC_MAP_URL} can sort stands by distance if you allow location access.`;

