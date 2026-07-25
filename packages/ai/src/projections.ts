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
// ONLY ONE PROJECTION EXISTS, AND THAT IS DELIBERATE. AI_ARCHITECTURE.md approves five seams;
// `inventory-extraction` is the only one with a real consumer today. Stock-out item parsing and
// grounded fact selection are F-013's, message classification is F-012's — building their
// projections now would mean near-duplicate mechanisms with nobody calling them, against the
// zen-desk rule ("every addition earns its place, now, for a real consumer that exists").
//
// This is why there is NO generic `assembleContext(seam, fields)` to fall back on: it was
// deleted in F-015 precisely because it let any caller hand the model a record of its own
// choosing. When you build one of the remaining seams, ADD ITS OWN PROJECTION HERE — copying
// each permitted field explicitly, as below — and add its bypass assertions to
// safety-boundary.type-test.ts. Do not reintroduce a generic entry point; the type test fails
// if you do. docs/RUNBOOK.md §"Add a model seam" walks the full procedure.

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
 * Assert that a value Farm Friend RETRIEVED (rather than one the current sender typed)
 * carries no raw phone number. A raw phone in our own published data is a Farm Friend bug,
 * so it fails closed here rather than reaching the model.
 */
function assertNoRawPhone(value: string, field: string): string {
  if (RAW_PHONE_RE.test(value)) {
    throw new ProjectionError(
      `Refusing to build model context: raw phone number in retrieved fact "${field}".`,
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
      entryId: assertNoRawPhone(entry.entryId, `currentEntries[${index}].entryId`),
      itemName: assertNoRawPhone(entry.itemName, `currentEntries[${index}].itemName`),
    })),
  };

  return {
    seam: "inventory-extraction",
    fields,
    outputInstructions: COORDINATOR_SMS_OUTPUT_INSTRUCTIONS,
  } as ModelSafeContext<InventoryExtractionFields>;
}
