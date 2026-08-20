import { standItemKey } from "./item-key";
import type { Clock } from "../clock";
import {
  projectClosure,
  renderClosureStatus,
  validateClosureInstruction,
  type ClosureInstruction,
} from "../public/closure";

export type { ClosureInstruction } from "../public/closure";

// The inventory publication proposal (F-014).
//
// Farmer language is patch-like — add this, drop that, it's all gone — but the pending
// proposal is ONE COMPLETE SNAPSHOT bound to the base revision it was computed from.
// Omission preserves an item; it never deletes one. `YES` publishes exactly the snapshot
// the farmer was shown, so there is no durable delta, patch log, or replay mechanism.
//
// These functions are pure. They decide nothing about authority, VIGA approval, consent,
// recipients, or delivery — those are the caller's transaction (Golden Rule #3).

/** An item in a published revision. `entryId` is the stable identifier edits refer to. */
export interface SnapshotEntry {
  entryId: string;
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/** The current published inventory for a sales location. */
export interface PublishedSnapshot {
  revisionId: string;
  entries: SnapshotEntry[];
}

/** A new item the farmer described. It has no entry ID until it is published. */
export interface ProposedAddition {
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/** An edit to an existing entry, selected by its stable identifier. */
export interface ProposedChange {
  entryId: string;
  itemName?: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/** A direct editor can distinguish clearing a visible field from leaving it untouched. */
export interface DirectProposedChange
  extends Omit<ProposedChange, "quantity" | "unit" | "priceText" | "approximation"> {
  quantity?: number | null;
  unit?: string | null;
  priceText?: string | null;
  approximation?: "some" | "limited" | "plentiful" | null;
}

export interface ProposedRemoval {
  entryId: string;
}

/**
 * What the interpreter may conclude. Either typed edits over the current snapshot,
 * an unambiguous clear-all, or a request for clarification. There is deliberately no
 * "publish" or "replace everything with exactly this" outcome: ambiguous replacement
 * intent asks the farmer rather than guessing.
 */
export type InventoryInterpretation =
  | {
      kind: "edits";
      additions: ProposedAddition[];
      changes: ProposedChange[];
      removals: ProposedRemoval[];
      /** Optional second section; both sections publish in the same confirmation transaction. */
      closure?: ClosureInstruction;
    }
  | { kind: "clear_all"; closure?: ClosureInstruction }
  | { kind: "closure"; closure: ClosureInstruction }
  | { kind: "clarification"; question: string };

/** The model-free web editor's input contract; null clears an optional visible detail. */
export type StructuredInventoryEdit =
  | {
      kind: "edits";
      additions: ProposedAddition[];
      changes: DirectProposedChange[];
      removals: ProposedRemoval[];
    }
  | { kind: "clear_all" };

/** The minimal projection the interpreter port receives. */
export interface InventoryInterpretationRequest {
  /** The farmer's own current message text. */
  taskText: string;
  /** Opaque stable identifiers plus the item names needed to interpret a reference. */
  currentEntries: { entryId: string; itemName: string }[];
  /** Current or pending location-wide instruction, never an arbitrary note. */
  currentClosure: ClosureInstruction | null;
  /** Code-supplied current calendar date in Vashon's reviewed timezone. */
  currentLocalDate: string;
}

/**
 * The typed interpreter seam. F-014 tests this contract with deterministic fakes;
 * the live model adapter and its privacy boundary are F-015.
 */
export interface InventoryInterpreter {
  interpret(
    request: InventoryInterpretationRequest,
  ): Promise<InventoryInterpretation>;
}

/** The complete pending snapshot, bound to the base it was computed from. */
export interface ProposedSnapshot {
  entries: SnapshotEntry[];
  baseRevisionId: string | null;
  isFirstPublication: boolean;
  /**
   * Names of base items this proposal drops, for confirmation only.
   *
   * `entries` remains the whole authority on what publishes — nothing reads this to decide
   * a consequence, and `confirmInventoryPublication` never consults it. It exists because a
   * removal is otherwise expressed purely as ABSENCE from the result, and absence is what a
   * farmer skimming a text does not see. Names, not IDs: this is confirmation copy.
   */
  removedItemNames: string[];
}

/** Published state or the sender's complete pending result, used as the next edit base. */
export type InventoryCompositionBase = PublishedSnapshot | ProposedSnapshot | null;

/** Code-owned issuer for identifiers that exist only inside a pending proposal. */
export type DraftEntryIdIssuer = () => string;

export class InventoryEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryEditError";
  }
}

const APPROXIMATIONS = new Set(["some", "limited", "plentiful"]);

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalApproximation(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && APPROXIMATIONS.has(value));
}

function hasOnlyKeys(value: object, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validItemFields(value: object): boolean {
  const record = value as Record<string, unknown>;
  return (
    isOptionalString(record.itemName) &&
    isOptionalNumber(record.quantity) &&
    isOptionalString(record.unit) &&
    isOptionalString(record.priceText) &&
    isOptionalApproximation(record.approximation)
  );
}

export type InterpretationValidation =
  | { ok: true; value: InventoryInterpretation }
  | { ok: false; reason: string };

/**
 * Does the farmer's message actually name this item?
 *
 * Case-folded substring, matching the tolerance the public map's search already uses: the
 * listing's words come from VIGA's form text and the message from a farmer's own SMS, and
 * nothing normalizes casing between them. Substring rather than exact so "potatoes are gone"
 * matches a listing of "Potatoes" and "bok choy is done" matches "Bok choy".
 *
 * Deliberately permissive about WHICH direction it is loose in. A false positive here leaves
 * the farmer a removal they can see and reject on the confirmation; a false negative silently
 * ignores a real "sold out". The confirmation step catches the first and nothing catches the
 * second, so this errs toward letting a named removal through.
 */
function messageNamesEntry(taskText: string, itemName: string): boolean {
  return taskText.toLowerCase().includes(itemName.trim().toLowerCase());
}

/**
 * The number-words a farmer actually writes. Presence only — never a value.
 *
 * NOT a vocabulary the model reasons over and NOT policy. Nothing about produce, farms or
 * listings appears here; this is a list of English words that mean "a number was stated".
 */
const QUANTITY_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "dozen",
  "couple",
  "pair",
  "few",
  "half",
  "several",
  "hundred",
]);

/**
 * Did the farmer's message state any quantity at all? (B-092)
 *
 * FOUND LIVE (max, 2026-08-19). "We have kale" — a message carrying no number anywhere —
 * produced `quantity: 12` in three of eight runs against the real model and `quantity: 1` in
 * three more. The `1` renders as the unreadable `- Kale (1)` max reported; the `12` is worse,
 * because it publishes a specific false claim about how much a farmer has.
 *
 * Exactly the class of defect an unauthorized removal is, and settled the same way: the
 * message is the authority, code holds both it and the output, and a number from a message
 * that contains no numbers is not a fact. The seam note already says "include only details the
 * message states, never invented ones" and the model ignores it — Golden Rule #6.
 *
 * **PRESENCE, never the value.** An earlier shape checked whether the message stated THAT
 * number and was wrong against the real model, which read "6 dozen eggs today" as
 * `quantity: 72` — correct arithmetic over the farmer's own words that the guard then threw
 * away. The live mirror fixture caught it. Code cannot re-derive the model's reading without
 * becoming a second interpreter, and it does not need to: the distinction that matters is
 * between a message with numbers in it and a message with none. Reading "6 dozen" as 72 or as
 * 6 is interpretation, which the model owns; manufacturing a number from a message that has
 * none is invention, which it does not.
 */
function messageStatesAnyQuantity(taskText: string): boolean {
  // A number carrying a currency symbol is a PRICE, and price is its own field. "kale by the
  // bunch, $3" states no quantity, and counting its 3 would re-admit exactly the invented
  // number this guard exists to drop.
  const withoutPrices = taskText.toLowerCase().replace(/[$£€]\s*\d[\d.,]*/g, " ");
  const words = withoutPrices.match(/[a-z]+|\d/g) ?? [];
  return words.some((word) => /\d/.test(word) || QUANTITY_WORDS.has(word));
}

/** Strip a quantity the message never stated, keeping every detail it did. */
function withoutInventedQuantity<T extends { quantity?: unknown }>(
  item: T,
  taskText: string | undefined,
): T {
  if (taskText === undefined) return item;
  if (typeof item.quantity !== "number") return item;
  if (messageStatesAnyQuantity(taskText)) return item;
  const { quantity: _invented, ...rest } = item;
  return rest as T;
}

/**
 * Validate untrusted interpreter output before anything acts on it: the shape must be
 * one of the permitted outcomes, carry no extra consequential fields, and every selected
 * entry ID must belong to the base snapshot.
 *
 * A REMOVAL MUST ALSO NAME ITS ITEM IN `taskText` (max, 2026-08-10). Found live: "no eggs left
 * at Pinecone Gardens" returned a removal of kale — a real entry ID for an item the farmer
 * never mentioned. Membership validation cannot catch that, because the ID *is* in the
 * snapshot; what is missing is any authority in the message to delete it.
 *
 * The seam note was given an explicit rule and still failed the live sentence against the real
 * model, which is the argument for deciding it here: a removal destroys a farmer's published
 * produce, and code holds both the snapshot and the text, so it can settle this with certainty
 * and no model call. Golden Rule #6 — what must not fail is a deterministic guarantee, not a
 * prompt instruction.
 *
 * Unauthorized removals are DROPPED, not rejected (max, 2026-08-10): the farmer confirms every
 * proposal before it publishes, so the removal simply never reaches the "Taking off:" line
 * while everything they genuinely said still goes through. `taskText` is optional because the
 * structured direct editor has no message to check — a farmer clicking a delete control has
 * already named the item by clicking it.
 */
export function validateInterpretation(
  candidate: unknown,
  base: InventoryCompositionBase,
  taskText?: string,
): InterpretationValidation {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, reason: "interpretation must be an object" };
  }
  const record = candidate as Record<string, unknown>;

  if (record.kind === "clear_all") {
    if (!hasOnlyKeys(record, ["kind", "closure"])) {
      return { ok: false, reason: "clear_all carries no other fields" };
    }
    const closure =
      record.closure === undefined
        ? undefined
        : validateClosureInstruction(record.closure);
    if (closure !== undefined && !closure.ok) return closure;
    return {
      ok: true,
      value: {
        kind: "clear_all",
        ...(closure?.ok ? { closure: closure.value } : {}),
      },
    };
  }

  if (record.kind === "closure") {
    if (!hasOnlyKeys(record, ["kind", "closure"])) {
      return { ok: false, reason: "closure carries only its typed instruction" };
    }
    const closure = validateClosureInstruction(record.closure);
    return closure.ok
      ? { ok: true, value: { kind: "closure", closure: closure.value } }
      : closure;
  }

  if (record.kind === "clarification") {
    if (!hasOnlyKeys(record, ["kind", "question"])) {
      return { ok: false, reason: "clarification carries only a question" };
    }
    if (typeof record.question !== "string" || record.question.trim() === "") {
      return { ok: false, reason: "clarification requires a question" };
    }
    return {
      ok: true,
      value: { kind: "clarification", question: record.question },
    };
  }

  if (record.kind !== "edits") {
    return { ok: false, reason: `unsupported interpretation kind` };
  }
  if (!hasOnlyKeys(record, ["kind", "additions", "changes", "removals", "closure"])) {
    // A field like `publish` or `recipientHash` is a consequence the model never owns.
    return { ok: false, reason: "edits carry no consequential fields" };
  }

  const { additions, changes, removals } = record;
  if (!Array.isArray(additions) || !Array.isArray(changes) || !Array.isArray(removals)) {
    return { ok: false, reason: "edits require additions, changes, and removals" };
  }

  const known = new Set((base?.entries ?? []).map((entry) => entry.entryId));
  // The names behind those IDs, for the removal-authorization check below.
  const nameByEntryId = new Map(
    (base?.entries ?? []).map((entry) => [entry.entryId, entry.itemName]),
  );
  const closure =
    record.closure === undefined
      ? undefined
      : validateClosureInstruction(record.closure);
  if (closure !== undefined && !closure.ok) return closure;

  for (const addition of additions) {
    if (typeof addition !== "object" || addition === null) {
      return { ok: false, reason: "an addition must be an object" };
    }
    if (!hasOnlyKeys(addition, ["itemName", "quantity", "unit", "priceText", "approximation"])) {
      return { ok: false, reason: "an addition carries no other fields" };
    }
    const named = addition as Record<string, unknown>;
    if (typeof named.itemName !== "string" || named.itemName.trim() === "") {
      return { ok: false, reason: "an addition requires an item name" };
    }
    if (!validItemFields(addition)) {
      return { ok: false, reason: "an addition has an invalid field" };
    }
  }

  for (const change of changes) {
    if (typeof change !== "object" || change === null) {
      return { ok: false, reason: "a change must be an object" };
    }
    if (
      !hasOnlyKeys(change, [
        "entryId",
        "itemName",
        "quantity",
        "unit",
        "priceText",
        "approximation",
      ])
    ) {
      return { ok: false, reason: "a change carries no other fields" };
    }
    const named = change as Record<string, unknown>;
    if (typeof named.entryId !== "string") {
      return { ok: false, reason: "a change requires an entry id" };
    }
    if (!known.has(named.entryId)) {
      return {
        ok: false,
        reason: `entry ${named.entryId} is not part of the base snapshot`,
      };
    }
    if (!validItemFields(change)) {
      return { ok: false, reason: "a change has an invalid field" };
    }
  }

  for (const removal of removals) {
    if (typeof removal !== "object" || removal === null) {
      return { ok: false, reason: "a removal must be an object" };
    }
    if (!hasOnlyKeys(removal, ["entryId"])) {
      return { ok: false, reason: "a removal carries only an entry id" };
    }
    const named = removal as Record<string, unknown>;
    if (typeof named.entryId !== "string") {
      return { ok: false, reason: "a removal requires an entry id" };
    }
    if (!known.has(named.entryId)) {
      return {
        ok: false,
        reason: `entry ${named.entryId} is not part of the base snapshot`,
      };
    }
  }

  // Every removal above is shape-valid and a real snapshot member. This last pass asks the
  // separate question membership cannot: did the farmer's message actually name the item?
  // An entry whose name is absent from the text is dropped — the farmer authorized no such
  // deletion, and the confirmation they read must not offer one.
  const authorizedRemovals =
    taskText === undefined
      ? (removals as ProposedRemoval[])
      : (removals as ProposedRemoval[]).filter((removal) => {
          const entry = nameByEntryId.get(removal.entryId);
          // An entry in `known` always has a name; a missing one would mean the snapshot and
          // the ID set disagreed, and dropping is the safe reading of that contradiction.
          return entry !== undefined && messageNamesEntry(taskText, entry);
        });

  return {
    ok: true,
    value: {
      kind: "edits",
      additions: (additions as ProposedAddition[]).map((addition) =>
        withoutInventedQuantity(addition, taskText),
      ),
      changes: (changes as ProposedChange[]).map((change) =>
        withoutInventedQuantity(change, taskText),
      ),
      removals: authorizedRemovals,
      ...(closure?.ok ? { closure: closure.value } : {}),
    },
  };
}

export type StructuredEditValidation =
  | { ok: true; value: StructuredInventoryEdit }
  | { ok: false; reason: string };

/**
 * Validate the direct editor with the same membership and shape rules as model output, while
 * reserving explicit null-clears for this model-free boundary only.
 */
export function validateStructuredInventoryEdit(
  candidate: unknown,
  base: InventoryCompositionBase,
): StructuredEditValidation {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { ok: false, reason: "structured edit must be an object" };
  }
  const record = candidate as Record<string, unknown>;
  if (record.kind === "clear_all") {
    const validated = validateInterpretation(candidate, base);
    if (!validated.ok) return validated;
    return validated.value.kind === "clear_all"
      ? { ok: true, value: { kind: "clear_all" } }
      : { ok: false, reason: "structured edit must contain edits" };
  }
  if (record.kind !== "edits" || !Array.isArray(record.changes)) {
    return { ok: false, reason: "structured edit must contain edits" };
  }

  const changesForSharedValidation = record.changes.map((change) => {
    if (typeof change !== "object" || change === null || Array.isArray(change)) return change;
    return Object.fromEntries(
      Object.entries(change).filter(
        ([key, value]) =>
          value !== null ||
          !["quantity", "unit", "priceText", "approximation"].includes(key),
      ),
    );
  });
  const validated = validateInterpretation(
    { ...record, changes: changesForSharedValidation },
    base,
  );
  if (!validated.ok) return validated;
  if (validated.value.kind !== "edits") {
    return { ok: false, reason: "structured edit must contain edits" };
  }
  return { ok: true, value: candidate as StructuredInventoryEdit };
}

function withoutNullish(entry: SnapshotEntry | DirectProposedChange): SnapshotEntry {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }
  return result as unknown as SnapshotEntry;
}

/**
 * Apply typed edits to the current published snapshot, producing the complete resulting
 * snapshot. Omitted items are preserved. A `clarification` never reaches this function —
 * it queues a question instead of creating or revising a proposal.
 */
export function applyInventoryEdits(
  base: InventoryCompositionBase,
  interpretation:
    | Extract<InventoryInterpretation, { kind: "edits" | "clear_all" }>
    | StructuredInventoryEdit,
  issueDraftEntryId: DraftEntryIdIssuer,
): ProposedSnapshot {
  const baseRevisionId =
    base === null
      ? null
      : "baseRevisionId" in base
        ? base.baseRevisionId
        : base.revisionId;
  const isFirstPublication =
    base === null
      ? true
      : "isFirstPublication" in base
        ? base.isFirstPublication
        : false;

  if (interpretation.kind === "clear_all") {
    return {
      entries: [],
      baseRevisionId,
      isFirstPublication,
      removedItemNames: (base?.entries ?? []).map((entry) => entry.itemName),
    };
  }

  const known = new Set((base?.entries ?? []).map((entry) => entry.entryId));
  for (const { entryId } of [...interpretation.changes, ...interpretation.removals]) {
    if (!known.has(entryId)) {
      throw new InventoryEditError(
        `entry ${entryId} is not part of the base snapshot`,
      );
    }
  }

  const removed = new Set(interpretation.removals.map((removal) => removal.entryId));
  const changeById = new Map(
    interpretation.changes.map((change) => [change.entryId, change]),
  );

  // Every surviving base entry stays, in its published order — omission preserves.
  const entries: SnapshotEntry[] = [];
  const removedItemNames: string[] = [];
  for (const entry of base?.entries ?? []) {
    if (removed.has(entry.entryId)) {
      removedItemNames.push(entry.itemName);
      continue;
    }
    const change = changeById.get(entry.entryId);
    entries.push(change ? withoutNullish({ ...entry, ...change }) : entry);
  }

  // B-092. An addition naming an item the stand ALREADY lists reaffirms that item; it does
  // not create a second row. Found live: "We have kale" against a stand listing Kale came
  // back as an addition in 8 of 8 runs against the real model, and the farmer read a
  // confirmation showing Kale twice. The seam note already tells the model "additions are
  // items not currently listed" and the model ignores it, so the guarantee is code's.
  //
  // `standItemKey` is the arbiter — the same rule `stand_items_one_per_location_name`
  // applies, so the draft and the database cannot disagree about what "same item" means.
  // The surviving entry keeps its entryId and its published position; the addition's stated
  // details are merged over it, because "plenty of bok choy at $3" about a listed item is a
  // real update. A removed entry is NOT a merge target: the message deleted it, so an
  // addition of that name is genuinely new.
  const indexByItemKey = new Map<string, number>();
  entries.forEach((entry, index) => {
    indexByItemKey.set(standItemKey(entry.itemName), index);
  });

  for (const addition of interpretation.additions) {
    const existing = indexByItemKey.get(standItemKey(addition.itemName));
    if (existing !== undefined) {
      const target = entries[existing]!;
      entries[existing] = withoutNullish({
        ...target,
        ...addition,
        // The farmer's published spelling wins: VIGA's listing is not restyled by an SMS.
        itemName: target.itemName,
      } as SnapshotEntry);
      continue;
    }
    const entryId = issueDraftEntryId();
    if (entryId === "" || known.has(entryId)) {
      throw new InventoryEditError("draft entry id must be non-empty and unique");
    }
    known.add(entryId);
    entries.push(
      withoutNullish({ entryId, ...addition } as SnapshotEntry),
    );
    indexByItemKey.set(standItemKey(addition.itemName), entries.length - 1);
  }

  return { entries, baseRevisionId, isFirstPublication, removedItemNames };
}

/**
 * Render the complete resulting inventory for confirmation. The farmer confirms exactly
 * what will publish, so this lists every surviving item rather than describing a change.
 *
 * **Removals are the one exception, and they earn it.** Everything a farmer ADDS or CHANGES
 * is visible in the result they are reading; an item they drop is visible only as a gap,
 * which is precisely what nobody notices in a text message. "we have eggs and bok choy"
 * against a stand listing eggs and kale is a deletion, and the farmer must be able to catch
 * it before confirming — so the loss is named after the result, never instead of it.
 */
export function renderProposedSnapshot(proposed: ProposedSnapshot): string {
  const removalLine =
    proposed.removedItemNames.length > 0
      ? `Taking off: ${proposed.removedItemNames.join(", ")}.`
      : null;

  if (proposed.entries.length === 0) {
    return [
      "Your stand will show no items currently available.",
      ...(removalLine === null ? [] : [removalLine]),
    ].join("\n");
  }

  const lines = proposed.entries.map((entry) => {
    const details = [
      entry.quantity !== undefined && entry.unit !== undefined
        ? `${entry.quantity} ${entry.unit}`
        : entry.quantity !== undefined
          ? `${entry.quantity}`
          : entry.approximation,
      entry.priceText,
    ].filter((part): part is string => typeof part === "string" && part !== "");

    return details.length > 0
      ? `- ${entry.itemName} (${details.join(", ")})`
      : `- ${entry.itemName}`;
  });

  return [
    `Your stand will show:`,
    ...lines,
    ...(removalLine === null ? [] : [removalLine]),
  ].join("\n");
}

/** Render every section this single confirmation will publish. */
export function renderProposedFarmerUpdate(input: {
  locationName: string;
  inventory?: ProposedSnapshot;
  closure?: ClosureInstruction;
  at: Date;
}): string {
  const sections: string[] = [];
  if (input.closure !== undefined) {
    sections.push(
      input.closure.result === "reopen"
        ? "Your stand will show as open."
        : (renderClosureStatus(projectClosure(input.closure, input.at)) ??
          "Your stand status will be updated."),
    );
  }
  if (input.inventory !== undefined) sections.push(renderProposedSnapshot(input.inventory));
  if (sections.length === 0) throw new Error("a farmer update needs at least one section");
  return [`For ${input.locationName}:`, ...sections].join("\n\n");
}

/** The activation and binding facts a confirmation token is checked against. */
export interface ProposalConfirmationState {
  proposalVersion: number;
  activatedVersion: number | null;
  activatedAt: Date | null;
  expiresAt: Date | null;
  baseRevisionId: string | null;
  /** False for a closure-only proposal, whose inventory must not create a false conflict. */
  hasInventory?: boolean;
}

export interface ConfirmationContext {
  /** Provider occurrence time of the token, which must follow prompt activation. */
  occurredAt: Date;
  /** The location's current published revision, or null if nothing is published. */
  currentRevisionId: string | null;
  clock: Clock;
}

export type ConfirmationEligibility =
  | { status: "eligible" }
  /** The current prompt has not been accepted by the provider yet. */
  | { status: "not_activated" }
  /** The proposal was revised; its replacement prompt is not yet accepted. */
  | { status: "awaiting_new_prompt" }
  /** The token's provider time precedes the activation it would consume. */
  | { status: "predates_activation" }
  /** The 12-hour window from provider acceptance has passed. */
  | { status: "expired" }
  /** Published state moved: the snapshot must be regenerated and reconfirmed. */
  | { status: "base_conflict" };

/**
 * Decide whether a confirmation token may consume this proposal. The farmer's `YES` is
 * trusted as a current attestation of the complete displayed snapshot, so there is no
 * observation-age or per-entry freshness rule here — only binding, activation, the
 * 12-hour window, and whether the base it was computed from is still current.
 */
export function confirmationEligibility(
  proposal: ProposalConfirmationState,
  context: ConfirmationContext,
): ConfirmationEligibility {
  if (
    proposal.activatedVersion === null ||
    proposal.activatedAt === null ||
    proposal.expiresAt === null
  ) {
    return { status: "not_activated" };
  }
  if (proposal.activatedVersion !== proposal.proposalVersion) {
    return { status: "awaiting_new_prompt" };
  }
  if (context.occurredAt < proposal.activatedAt) {
    return { status: "predates_activation" };
  }
  if (context.clock.now() >= proposal.expiresAt) {
    return { status: "expired" };
  }
  if (proposal.hasInventory !== false && proposal.baseRevisionId !== context.currentRevisionId) {
    return { status: "base_conflict" };
  }
  return { status: "eligible" };
}
