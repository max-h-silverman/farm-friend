// Task-specific model input projections — the two enforcement barriers for model calls.
// See docs/AI_ARCHITECTURE.md §"The code-enforced safety boundary and its verification."
//
// BARRIER 1 — static provenance. `ModelSafeContext` is branded and the brand symbol is not
// exported, so the ONLY way to obtain one is a projection in this module. The low-level
// provider call accepts only a `ModelSafeContext` and is not exported from this package, so
// ordinary code in core/db/sms/apps cannot reach a model at all except through a named seam.
// This proves PROVENANCE — where a value came from. It does NOT prove content: `tsc` cannot
// inspect a runtime string.
//
// BARRIER 2 — runtime enforcement. Each projection below CONSTRUCTS one explicit minimal
// record from named arguments, copying field by field. It does not accept, spread, or forward
// a caller's object, so a wider record cannot widen the model's view even if a caller holds
// one. Other actors' data, consent/auth/admin/audit state, internal notes, and secrets are
// absent because nothing here reads them — not because a scanner removed them.
//
// WHAT IS DELIBERATELY NOT CLAIMED: this is not a DLP system, taint tracker, or universal
// detector for emails, addresses, or secrets. A sender may voluntarily type anything into
// their own current task text, and that text must reach the seam for the seam to work at all.
// The one named fail-closed content rule is raw phone numbers in Farm Friend-HELD facts
// (below), because a raw phone in our own retrieved data is our bug, not the sender's speech.
//
// EACH SEAM GETS ITS OWN PROJECTION; THERE IS NO GENERIC ONE. `assembleContext(seam, fields)`
// was deleted in F-015 precisely because it let any caller hand the model a record of its own
// choosing. Four projections exist, for the seams that have real consumers: inventory
// extraction (F-015), and inquiry interpretation, grounded fact selection, and stock-out item
// parsing (F-013). Message classification remains unbuilt and unprojected — F-012's, and it
// has no caller.
//
// When you build a new seam, ADD ITS OWN PROJECTION HERE — copying each permitted field
// explicitly, as below — and add its bypass assertions to safety-boundary.type-test.ts. Do not
// reintroduce a generic entry point; the type test fails if you do. docs/RUNBOOK.md §"Add a
// model seam" walks the full procedure.
//
// Note what the two INQUIRY projections deliberately do NOT contain. Interpretation sees the
// customer's question but NO retrieved facts — it decides what to look up, so giving it the
// answer set would invite it to answer. Grounded selection sees the retrieved facts but NOT
// the customer's raw text — it picks from what code found, and the raw request is where an
// injection would live. Neither ever sees a farmer's contact, a recipient, or another
// customer's message.

declare const modelSafeBrand: unique symbol;

/**
 * A model input constructed by a task-specific projection in this module. Branded so the
 * low-level provider call cannot be reached with a record of the caller's choosing.
 */
export type ModelSafeContext<T = unknown> = {
  readonly seam: string;
  readonly fields: T;
  readonly outputInstructions?: string;
} & { readonly [modelSafeBrand]: true };

export const COORDINATOR_SMS_OUTPUT_INSTRUCTIONS =
  "Write a concise SMS reply. Prefer one GSM-7 segment (160 septets) when practical. " +
  "Use plain ASCII punctuation and no emoji unless the content intentionally requires one. " +
  "Preserve important details and user-provided names, addresses, and meaning; never truncate " +
  "useful information solely to meet the one-segment preference.";

/** A projection refused to build a context. Fail closed: no model call happens. */
export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

// The named raw-phone class, matching the outbound guard. Applied to Farm Friend-held facts
// only. Deliberately broad: this is a refuse-to-proceed rule, not a formatter.
const RAW_PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/;

/**
 * Assert that a HUMAN-READABLE value Farm Friend retrieved (rather than one the current
 * sender typed) carries no raw phone number. A raw phone in our own published text is a Farm
 * Friend bug, so it fails closed here rather than reaching the model.
 *
 * Apply this to display text ONLY — names, item labels, addresses. Do NOT apply it to opaque
 * identifiers: a UUID contains long digit runs and matches the raw-phone pattern by chance
 * (observed at roughly 1 in 4 in the integration suite), which would randomly refuse to serve
 * a legitimate request. An identifier has no phone-number semantics to protect, so scanning
 * one is a false positive with no upside. `assertOpaqueId` below is its counterpart.
 */
function assertNoRawPhone(value: string, field: string): string {
  if (RAW_PHONE_RE.test(value)) {
    throw new ProjectionError(
      `Refusing to build model context: raw phone number in retrieved fact "${field}".`,
    );
  }
  return value;
}

/**
 * Assert that an opaque identifier is what it claims to be. The guarantee an ID needs is that
 * it is an ID — not free text smuggled through an identifier field — so this checks shape
 * rather than scanning content. UUIDs and the short slugs used in tests both qualify.
 */
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertOpaqueId(value: string, field: string): string {
  if (!OPAQUE_ID_RE.test(value)) {
    throw new ProjectionError(
      `Refusing to build model context: "${field}" is not an opaque identifier.`,
    );
  }
  return value;
}

/** A retrieved entry as the inventory seam is permitted to see it: an opaque id and a name. */
export interface RetrievedEntryRef {
  entryId: string;
  itemName: string;
}

/** The complete permitted input for the inventory-extraction seam. */
export interface InventoryExtractionFields {
  /** The current farmer's own message text, verbatim. */
  readonly taskText: string;
  /** Opaque stable identifiers plus the public item names needed to resolve a reference. */
  readonly currentEntries: readonly RetrievedEntryRef[];
}

/**
 * Project the inventory-extraction seam's input: the farmer's own current message plus the
 * opaque identifiers and public item names of their location's currently published entries.
 *
 * Nothing else is readable here — no sender hash or raw phone, no other farmer's or
 * customer's text, no earlier thread history, no consent/auth/admin/audit state, no internal
 * note, no secret. The projection copies each permitted field explicitly, so passing a wider
 * row does not widen the context, and it copies rather than aliases, so a later mutation of
 * the caller's array cannot reach a context already built.
 */
export function projectInventoryExtraction(input: {
  taskText: string;
  currentEntries: readonly RetrievedEntryRef[];
}): ModelSafeContext<InventoryExtractionFields> {
  const fields: InventoryExtractionFields = {
    // The sender's own words return only to the sender; they are not vetted here.
    taskText: input.taskText,
    currentEntries: input.currentEntries.map((entry, index) => ({
      entryId: assertOpaqueId(entry.entryId, `currentEntries[${index}].entryId`),
      itemName: assertNoRawPhone(entry.itemName, `currentEntries[${index}].itemName`),
    })),
  };

  return {
    seam: "inventory-extraction",
    fields,
    outputInstructions: COORDINATOR_SMS_OUTPUT_INSTRUCTIONS,
  } as ModelSafeContext<InventoryExtractionFields>;
}

/** The complete permitted input for the inquiry-interpretation seam. */
export interface InquiryInterpretationFields {
  /** The current customer's own question, verbatim. */
  readonly taskText: string;
}

/**
 * Project the inquiry-interpretation seam: the customer's own question and nothing else.
 *
 * Deliberately NO retrieved facts. This call decides *what to look up*; handing it the
 * answer set would invite it to answer from context instead of interpreting the request,
 * which is exactly the grounding failure code owns. Retrieval runs after this returns.
 */
export function projectInquiryInterpretation(input: {
  taskText: string;
}): ModelSafeContext<InquiryInterpretationFields> {
  return {
    seam: "inquiry-interpretation",
    fields: { taskText: input.taskText },
    outputInstructions: COORDINATOR_SMS_OUTPUT_INSTRUCTIONS,
  } as ModelSafeContext<InquiryInterpretationFields>;
}

/** A retrieved fact as the selection seam is permitted to see it. */
export interface RetrievedFactRef {
  factId: string;
  farmName: string;
  locationName: string;
  matchedItemNames: readonly string[];
  /** Age in hours, derived in code. A clock is code's, never the model's to infer. */
  ageHours: number;
}

/** The complete permitted input for the grounded fact-selection seam. */
export interface FactSelectionFields {
  /** The validated items code actually retrieved against. */
  readonly items: readonly string[];
  readonly ranking: string;
  /** Opaque identifiers plus the public facts needed to order them. */
  readonly facts: readonly RetrievedFactRef[];
}

/**
 * Project the grounded fact-selection seam: the validated interpreted intent plus the exact
 * typed facts code retrieved.
 *
 * Deliberately NO raw customer text. This call selects and orders identifiers from a fixed
 * set; the customer's free text is where a prompt injection would live, and this seam has no
 * need of it. It also carries no address, phone, or recipient — selection does not choose who
 * hears anything, and the renderer dereferences the authoritative values afterward.
 */
export function projectFactSelection(input: {
  items: readonly string[];
  ranking: string;
  facts: readonly RetrievedFactRef[];
}): ModelSafeContext<FactSelectionFields> {
  const fields: FactSelectionFields = {
    items: input.items.map((item) => item),
    ranking: input.ranking,
    facts: input.facts.map((fact, index) => ({
      factId: assertOpaqueId(fact.factId, `facts[${index}].factId`),
      farmName: assertNoRawPhone(fact.farmName, `facts[${index}].farmName`),
      locationName: assertNoRawPhone(fact.locationName, `facts[${index}].locationName`),
      matchedItemNames: fact.matchedItemNames.map((name, itemIndex) =>
        assertNoRawPhone(name, `facts[${index}].matchedItemNames[${itemIndex}]`),
      ),
      ageHours: fact.ageHours,
    })),
  };

  return {
    seam: "grounded-fact-selection",
    fields,
    outputInstructions: COORDINATOR_SMS_OUTPUT_INSTRUCTIONS,
  } as ModelSafeContext<FactSelectionFields>;
}

/** A listed item the stock-out surface may offer as a match. */
export interface ListedItemRef {
  entryId: string;
  itemName: string;
}

/** The complete permitted input for the stock-out item-parsing seam. */
export interface StockOutParseFields {
  /** The reporter's own free text describing what was missing. */
  readonly taskText: string;
  /** Public listed items for the CODE-BOUND location, for matching only. */
  readonly listedItems: readonly ListedItemRef[];
}

/**
 * Project the stock-out item-parsing seam: the reporter's text plus the public listed items
 * of the location the *surface* bound in code.
 *
 * The sales-location identifier is deliberately absent from both input and output. Code binds
 * the location from the QR/web surface and resolves the farmer recipient from it; a model that
 * could name a location could route a stranger's report to an unrelated farmer.
 */
export function projectStockOutParse(input: {
  taskText: string;
  listedItems: readonly ListedItemRef[];
}): ModelSafeContext<StockOutParseFields> {
  const fields: StockOutParseFields = {
    taskText: input.taskText,
    listedItems: input.listedItems.map((item, index) => ({
      entryId: assertOpaqueId(item.entryId, `listedItems[${index}].entryId`),
      itemName: assertNoRawPhone(item.itemName, `listedItems[${index}].itemName`),
    })),
  };

  return {
    seam: "stock-out-parse",
    fields,
    outputInstructions: COORDINATOR_SMS_OUTPUT_INSTRUCTIONS,
  } as ModelSafeContext<StockOutParseFields>;
}
