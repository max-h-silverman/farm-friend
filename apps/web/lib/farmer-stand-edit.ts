import type { InventoryInterpretation } from "@farm-friend/core";

// The boundary parser for a STRUCTURED inventory edit posted by the farmer's web form.
//
// The form's chips express edits structurally — removing a chip already *is*
// `removals: [{entryId}]` — so they post that shape rather than a sentence for the model to
// parse back into it.
//
// **This is untrusted public input.** The typed shape it produces is the same one the model
// produces, and it meets the same `validateInterpretation` against the same retrieved
// snapshot afterwards. That check owns MEMBERSHIP — whether an entry id belongs to this
// stand. This function owns SHAPE, and refuses anything it does not recognise rather than
// coercing it: an unknown key is a refusal, not a field to strip, because "the client sent
// something we do not understand" must never be silently reinterpreted as a valid edit.
//
// Deliberately no `clear_all`: emptying a stand from the web is expressible by removing
// every chip, and a distinct one-shot "delete everything" verb reachable from a parsed
// request body is a sharper edge than the interface needs.

const APPROXIMATIONS = new Set(["some", "limited", "plentiful"]);

/** An entry id is opaque here; membership is `validateInterpretation`'s job, not shape's. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const ITEM_KEYS = ["itemName", "quantity", "unit", "priceText", "approximation"] as const;

/**
 * Read the optional detail fields shared by additions and changes.
 *
 * Returns `null` for anything malformed. `undefined` and a missing key mean the same thing —
 * "not stated" — so a farmer who never set a price is not distinguished from one who cleared
 * it; clearing is not expressible here, and inventing that distinction at the boundary would
 * commit to a semantics the writer does not implement.
 */
function readDetail(
  record: Record<string, unknown>,
): { quantity?: number; unit?: string; priceText?: string; approximation?: "some" | "limited" | "plentiful" } | null {
  const detail: {
    quantity?: number;
    unit?: string;
    priceText?: string;
    approximation?: "some" | "limited" | "plentiful";
  } = {};

  if (record.quantity !== undefined) {
    if (typeof record.quantity !== "number" || !Number.isFinite(record.quantity)) return null;
    detail.quantity = record.quantity;
  }
  if (record.unit !== undefined) {
    if (typeof record.unit !== "string") return null;
    detail.unit = record.unit;
  }
  if (record.priceText !== undefined) {
    if (typeof record.priceText !== "string") return null;
    detail.priceText = record.priceText;
  }
  if (record.approximation !== undefined) {
    if (typeof record.approximation !== "string" || !APPROXIMATIONS.has(record.approximation)) {
      return null;
    }
    detail.approximation = record.approximation as "some" | "limited" | "plentiful";
  }
  return detail;
}

/**
 * Parse a posted structured edit, or return `null` to refuse it.
 *
 * `null` is the ONLY failure signal: the caller answers a refusal identically to any other
 * malformed request, so a probing client learns nothing about which field it got wrong.
 */
export function parseStructuredEdit(
  value: unknown,
): Extract<InventoryInterpretation, { kind: "edits" }> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["additions", "changes", "removals"])) return null;

  const { additions, changes, removals } = record;
  if (!Array.isArray(additions) || !Array.isArray(changes) || !Array.isArray(removals)) {
    return null;
  }

  const parsedAdditions: Extract<InventoryInterpretation, { kind: "edits" }>["additions"] = [];
  for (const entry of additions) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (!hasOnlyKeys(item, ITEM_KEYS)) return null;
    if (!isNonEmptyString(item.itemName)) return null;
    const detail = readDetail(item);
    if (detail === null) return null;
    parsedAdditions.push({ itemName: item.itemName.trim(), ...detail });
  }

  const parsedChanges: Extract<InventoryInterpretation, { kind: "edits" }>["changes"] = [];
  for (const entry of changes) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (!hasOnlyKeys(item, ["entryId", ...ITEM_KEYS])) return null;
    if (!isNonEmptyString(item.entryId)) return null;
    // A change that states nothing would compose to a no-op that still opens a proposal.
    if (item.itemName === undefined && readDetail(item) !== null && Object.keys(item).length === 1) {
      return null;
    }
    const detail = readDetail(item);
    if (detail === null) return null;
    if (item.itemName !== undefined && !isNonEmptyString(item.itemName)) return null;
    parsedChanges.push({
      entryId: item.entryId,
      ...(item.itemName !== undefined ? { itemName: (item.itemName as string).trim() } : {}),
      ...detail,
    });
  }

  const parsedRemovals: Extract<InventoryInterpretation, { kind: "edits" }>["removals"] = [];
  for (const entry of removals) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (!hasOnlyKeys(item, ["entryId"])) return null;
    if (!isNonEmptyString(item.entryId)) return null;
    parsedRemovals.push({ entryId: item.entryId });
  }

  // An edit that changes nothing must not open a proposal the farmer would then confirm.
  if (
    parsedAdditions.length === 0 &&
    parsedChanges.length === 0 &&
    parsedRemovals.length === 0
  ) {
    return null;
  }

  return {
    kind: "edits",
    additions: parsedAdditions,
    changes: parsedChanges,
    removals: parsedRemovals,
  };
}
