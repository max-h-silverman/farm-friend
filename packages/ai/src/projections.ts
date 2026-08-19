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
// choosing. Each projection exists only for a seam with a real consumer, including request
// classification, inventory extraction, catalog matching, stock-out item parsing,
// and offering extraction.
//
// When you build a new seam, ADD ITS OWN PROJECTION HERE — copying each permitted field
// explicitly, as below — and add its bypass assertions to safety-boundary.type-test.ts. Do not
// reintroduce a generic entry point; the type test fails if you do. docs/RUNBOOK.md §"Add a
// model seam" walks the full procedure.
//
// The inquiry projection carries the customer's question and unique public catalog names, but
// no stand identifier, association, evidence type, contact, recipient, or other customer's message.

import {
  isLocalDate,
  preflightClosureTiming,
  type ClosureTimingEvidence,
} from "@farm-friend/core";

declare const modelSafeBrand: unique symbol;

/**
 * A model input constructed by a task-specific projection in this module. Branded so the
 * low-level provider call cannot be reached with a record of the caller's choosing.
 */
/**
 * How a seam's prompt is PRESENTED to the model (F-111).
 *
 * Presentation is a property of the seam's task, not of its schema or its transport — those
 * stay shared. A projection declares which framing its task needs; the adapter reads the
 * declaration and never infers one from a seam name or a schema shape, because a name-matching
 * branch would silently re-frame the next seam that happened to be named similarly.
 *
 * - `extraction` (the DEFAULT, and what every pre-F-111 seam uses) — `Task:`, then
 *   `Input (JSON):`, then `Output requirements:`. Suited to "read this record and pull
 *   structured values out of it".
 * - `classification` — the instruction FIRST, then the labelled fields. Suited to "decide what
 *   this message is". Measured: the settled request taxonomy scored 100% over 47 cases in this
 *   framing and 41/47 in the extraction framing, which buries the task under the record.
 *
 * **Field values are JSON-encoded under BOTH framings.** The injection boundary does not vary
 * with presentation: sender text is always a JSON string literal, so a newline and a forged
 * label inside it cannot become a second field.
 */
export type PromptFraming = "extraction" | "classification";

export type ModelSafeContext<T = unknown> = {
  readonly seam: string;
  readonly fields: T;
  readonly outputInstructions: string;
  /** Absent means `extraction` — the framing every seam had before F-111. */
  readonly framing?: PromptFraming;
} & { readonly [modelSafeBrand]: true };

/**
 * Per-seam output contracts (F-024).
 *
 * The first live-model run returned {"smsReply":"..."} from every seam and failed every
 * schema: the projections attached SMS-composition guidance to seams whose output is
 * structured JSON, and nothing told the model what shape was wanted. Every scripted suite
 * stayed green because the stub reads neither the instructions nor the schema — the
 * cooperative-stub blindness the audit warned about, caught by evals/live.ts.
 *
 * Each entry lists example shapes the seam's schema ACCEPTS. `output-contracts.test.ts`
 * parses every example through the real schema, so this prose cannot drift from the
 * validator. Instructions are QUALITY, never enforcement: a model that ignores them meets
 * the same validation and rendering barriers as ever (Golden Rule #6).
 */
export const SEAM_OUTPUT_SHAPES = {
  "inventory-extraction": [
    '{"kind":"edits","additions":[{"itemName":"ITEM_NAME","quantity":12,"unit":"UNIT","priceText":"PRICE","approximation":"plentiful"}],"changes":[{"entryId":"ENTRY_ID","quantity":6}],"removals":[{"entryId":"ENTRY_ID"}],"closure":{"result":"close","closureKind":"temporary","startsOn":"START_DATE","closedThrough":"END_DATE"}}',
    '{"kind":"clear_all"}',
    '{"kind":"closure","closure":{"result":"close","closureKind":"seasonal","startsOn":"START_DATE"}}',
    '{"kind":"closure","closure":{"result":"reopen"}}',
    '{"kind":"clarification","question":"Could you list what your stand has right now?"}',
  ],
  "catalog-match": ['{"matches":["bok choy","butter lettuce"]}', '{"matches":[]}'],
  "stock-out-parse": [
    '{"kind":"listed","entryId":"e1"}',
    '{"kind":"unlisted","itemText":"strawberries"}',
    '{"kind":"unclear"}',
  ],
  "offering-extraction": ['{"items":["eggs","bok choy","cut flowers"]}'],
  "request-classification": [
    '{"kind":"search_stands","request":{"operation":"inventory","originDependent":false,"outOfScopeRequest":false}}',
    '{"kind":"search_stands","request":{"operation":"broad","originDependent":false}}',
    '{"kind":"search_stands","request":{"operation":"payment"}}',
    '{"kind":"search_stands","request":{"operation":"hours"}}',
    '{"kind":"search_stands","request":{"operation":"clarification"}}',
    '{"kind":"stand_lookup","request":{"operation":"inventory","originDependent":false,"outOfScopeRequest":false}}',
    '{"kind":"stand_lookup","request":{"operation":"payment"}}',
    '{"kind":"stand_lookup","request":{"operation":"hours"}}',
    '{"kind":"stand_lookup","request":{"operation":"location"}}',
    '{"kind":"stand_lookup","request":{"operation":"overview"}}',
    '{"kind":"stand_lookup","request":{"operation":"clarification"}}',
    '{"kind":"inventory_report"}',
    '{"kind":"system_inquiry"}',
    '{"kind":"issue_report"}',
    '{"kind":"chitchat"}',
    '{"kind":"unclear"}',
  ],
} as const;

type SeamName = keyof typeof SEAM_OUTPUT_SHAPES;

/**
 * Seam-specific guidance beside the shapes. Semantic help only — nothing here is relied on:
 * ranking membership, ID membership, and field allow-lists are all re-validated in code.
 */
const SEAM_OUTPUT_NOTES: Record<SeamName, string> = {
  "inventory-extraction":
    "EVERY independent fact in the farmer message MUST survive in one result. If the message " +
    "contains both inventory and closure facts, return kind edits with the inventory changes " +
    "and its closure field; closure-only output would discard inventory and is wrong. " +
    "For edits, all three arrays (additions, changes, removals) are REQUIRED, each possibly " +
    "empty. additions are items not currently listed; changes and removals refer to listed " +
    "entries and their entryId MUST be one of the currentEntries ids. " +
    "OMISSION IS NOT REMOVAL. A listed item the message does not mention STAYS - do not put " +
    "it in removals. Remove an entry ONLY when the message says it is gone (sold out, all " +
    "out, done, finished, took it down) or explicitly replaces the whole listing (\"all we " +
    "have now is X\", \"just X today\", \"only X left\"). A bare list of items - \"we have " +
    "eggs and bok choy\" - is an update about THOSE items, not a statement about the ones it " +
    "leaves out. When you genuinely cannot tell whether the farmer is adding to their " +
    "listing or replacing it, return the clarification shape and ask - never guess a " +
    "removal. quantity is always a " +
    'NUMBER - write "a dozen" as 12 - and goes with unit ("lb", "dozen") or is omitted; ' +
    "include only details the message states, never invented ones. If the message is not a " +
    "readable inventory or stand-status update, return the clarification shape with one short " +
    "plain-ASCII question (it is sent by SMS). A location-wide close uses result close, kind " +
    "temporary or seasonal, and an exact local YYYY-MM-DD startsOn; temporary may have an " +
    "inclusive closedThrough. Reopening uses result reopen and no dates. Put closure on edits " +
    "for a mixed message, or use kind closure when inventory is unchanged. closureTiming is " +
    "computed by code before this call. For a close, copy its kind and dates EXACTLY; never " +
    "calculate, substitute, or invent dates. A future closure that conflicts with " +
    "currentClosure requires clarification.",
  "catalog-match":
    "The operation is already fixed. Match taskText against values and return every matching " +
    "value copied exactly. For inventory, match by meaning, including categories such as " +
    "leafy greens. For payment, match equivalent payment wording. When nothing matches, return " +
    "an empty matches array. Never copy a requested value that is absent from values. Never " +
    "classify the request, return an operation, or return factual prose.",
  "stock-out-parse":
    "If the text names an item matching one of listedItems, return listed with that " +
    "entryId. If it names an item that is not in listedItems, return unlisted with the " +
    "item's name as itemText - an item being absent from listedItems is NOT a reason to " +
    "return unclear, and a short message naming one product (\"no eggs left\") is a clear " +
    "report about that product. Correct obvious misspellings against listedItems " +
    "(\"kayle\" -> the listed \"kale\"). Return unclear ONLY when no product word is " +
    "identifiable at all.",
  "offering-extraction":
    "items are short customer-facing product tags - at most four words each - for what the " +
    "text says the stand offers. Exclude farming practices, certifications, schedules, " +
    "contact details, and commentary. When the text names no products, return an empty " +
    "items array.",
  /*
    The FIRST-PASS request classifier. This text is the one measured at 100% over 47 cases x 3
    runs (2026-08-13, docs/plans/REQUEST_CLASSIFICATION_REFACTOR.md) and is reproduced verbatim
    from the plan, with ONE documented deviation: the settled text ended "Return only the
    category name", and the transport here is JSON, so the closing line is supplied by
    `outputInstructionsFor` and the shapes above instead.

    EDITING THIS RE-OPENS THE MEASUREMENT. Every clause below closed a specific measured
    failure, and several look redundant until you know which one:

      - "whether or not a stand is named" — without it, "no eggs left" and "out of kale" fell
        to unclear 3/3. That is the shape a farmer texts about their own stand and the shape a
        customer texts before we ask which stand.
      - the bare-product and bare-stand rules — "tomatoes?" and "Pinecone Gardens" were both
        unclear without them.
      - "including its location" — "where is Pinecone Gardens" was unclear without it.
      - the service-name rule, paired with the projected `systemName` — "what is farm friend",
        "what can farm friend do" and "who are you" were all unclear without it.

    There is deliberately NO update-vs-report split. That distinction was measured and FAILED:
    a farmer reporting another stand's stock-out classified as their own update 3/3, which is
    B-053 reintroduced. Who may act on an inventory_report is an ACCESS question, decided
    downstream in code from `farmer_authorizations` — never here.
  */
  "request-classification":
    "Classify the message into exactly one top-level category. For search_stands and " +
    "stand_lookup, also classify exactly one request operation.\n\n" +
    "search_stands: asking which stand(s) meet a need or asking generally about stands, " +
    "including availability, payment, hours, or other stand information.\n" +
    "stand_lookup: asking for information about one specific stand.\n" +
    "inventory_report: stating that items are available, unavailable, sold out, or coming " +
    "soon, whether or not a stand is named.\n" +
    "system_inquiry: asking what the service is, how it works, what it can do, or about the " +
    "map.\n" +
    "issue_report: reporting that something is wrong with the service or its information - " +
    "incorrect listing or hours, a wrong or missing map location, a stand that has closed, a " +
    "reply that was wrong or made no sense, or a complaint.\n" +
    "chitchat: greeting, thanks, acknowledgement, or small talk.\n" +
    "unclear: none of the above.\n\n" +
    "Rules:\n" +
    "- A bare product or item name is search_stands.\n" +
    "- A bare stand name is stand_lookup.\n" +
    "- Questions about stands generally are search_stands.\n" +
    "- Questions about a specific stand, including its location, are stand_lookup.\n" +
    "- A named stand does not imply stand_lookup when the message is an inventory statement.\n" +
    "- Use inventory_report for statements about a stand's inventory regardless of who sent " +
    "them.\n" +
    "- An inventory statement with no stand named is still inventory_report.\n" +
    "- A message naming the service is system_inquiry when it asks what the service is or " +
    "does.\n" +
    "- Unqualified you / your refers to the service when the question is about the recipient " +
    "itself, its identity, capabilities, operation, or availability. Do not apply this rule " +
    "when the message is clearly asking about farm-stand inventory, payment, or other stand " +
    "information.\n" +
    "- Use issue_report when the message says our information or our reply is WRONG, not " +
    "merely that a stand lacks an item. A statement that a stand is out of something is " +
    "inventory_report; a statement that our listing or map misrepresents a stand is " +
    "issue_report.\n" +
    "- Use unclear only when no other category reasonably fits.\n\n" +
    "Operations for search_stands:\n" +
    "- payment: asks which stands accept a payment method.\n" +
    "- hours: asks which stands are open now.\n" +
    "- broad: asks generally what is available, without requesting a product or category that meaningfully narrows the inventory.\n" +
    "- inventory: requests a specific product or a product category that meaningfully narrows the inventory.\n" +
    "- clarification: no supported search operation can be identified.\n\n" +
    "Operations for stand_lookup:\n" +
    "- payment: asks whether the named stand accepts a payment method.\n" +
    "- hours: asks for the named stand's hours or schedule.\n" +
    "- location: asks for the named stand's address or location.\n" +
    "- overview: names one stand without requesting a narrower fact. Asking what one stand has, sells, or is carrying — including “what’s in stock at NAME?”, “what does NAME have?”, “what’s NAME got today?” — is overview, because it names no product to narrow by.\n" +
    "- inventory: asks whether the named stand has a SPECIFIC product or product category, e.g. “does NAME have peaches?”, “any greens at NAME?”.\n" +
    "- clarification: no supported lookup operation can be identified.\n\n" +
    "Inventory vs broad:\n" +
    "- Choose inventory only when the requested product/category would meaningfully filter the available inventory to a subset.\n" +
    "- Generic inventory words do NOT make a request inventory. Examples: produce, food, items, products, stuff, selection, inventory, anything.\n" +
    "- Examples of broad: “what’s available?”, “what produce do you have?”, “anything for sale?”, “what can I buy?”, “show me what’s out there.”\n" +
    "- Examples of inventory: “any tomatoes?”, “what greens do you have?”, “any leafy greens?”, “who has eggs?”, “do you have flowers?”\n" +
    "- Decide broad vs inventory from the sender's request first. No catalog is provided.\n\n" +
    "originDependent is true only when an inventory or broad request requires the customer's " +
    "position. outOfScopeRequest is true only when an inventory request also asks for recipe, " +
    "preparation, preservation, or food-safety help.",
};

function outputInstructionsFor(
  seam: SeamName,
  inventoryFacts?: {
    currentLocalDate: string;
    closureTiming: ClosureTimingEvidence;
  },
): string {
  return [
    SEAM_OUTPUT_NOTES[seam],
    ...(seam === "inventory-extraction" && inventoryFacts !== undefined
      ? [
          `The exact current Vashon date is ${inventoryFacts.currentLocalDate}.`,
          `The deterministic closureTiming is ${JSON.stringify(inventoryFacts.closureTiming)}.`,
        ]
      : []),
    "Return ONLY one JSON object matching one template below. Template strings such as " +
      "ITEM_NAME, ENTRY_ID, START_DATE, and END_DATE are placeholders, never values to copy.",
    ...SEAM_OUTPUT_SHAPES[seam],
  ].join("\n");
}

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
  /** Opaque published or draft identifiers plus item names needed to resolve a reference. */
  readonly currentEntries: readonly RetrievedEntryRef[];
  readonly currentClosure: import("@farm-friend/core").ClosureInstruction | null;
  /** Current Vashon calendar date supplied by code, never inferred by the model. */
  readonly currentLocalDate: string;
  /** Closure dates and kind already resolved by deterministic code. */
  readonly closureTiming: ClosureTimingEvidence;
}

function copyClosureTiming(timing: ClosureTimingEvidence): ClosureTimingEvidence {
  if (timing.kind === "none" || timing.kind === "reopen") {
    return { kind: timing.kind };
  }
  return {
    kind: "close",
    closureKind: timing.closureKind,
    startsOn: timing.startsOn,
    ...(timing.closedThrough !== undefined
      ? { closedThrough: timing.closedThrough }
      : {}),
  };
}

/**
 * Project the inventory-extraction seam's input: the farmer's own current message plus the
 * opaque identifiers and item names from their pending snapshot, or published state when none.
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
  currentClosure?: import("@farm-friend/core").ClosureInstruction | null;
  currentLocalDate: string;
}): ModelSafeContext<InventoryExtractionFields> {
  if (!isLocalDate(input.currentLocalDate)) {
    throw new ProjectionError(
      "Refusing to build model context: currentLocalDate is not an exact local date.",
    );
  }
  const timing = preflightClosureTiming(input.taskText, input.currentLocalDate);
  if (timing.kind === "clarification") {
    throw new ProjectionError(
      "Refusing to build model context: closure timing requires clarification.",
    );
  }
  const fields: InventoryExtractionFields = {
    // The sender's own words return only to the sender; they are not vetted here.
    taskText: input.taskText,
    currentLocalDate: input.currentLocalDate,
    closureTiming: copyClosureTiming(timing.evidence),
    currentEntries: input.currentEntries.map((entry, index) => ({
      entryId: assertOpaqueId(entry.entryId, `currentEntries[${index}].entryId`),
      itemName: assertNoRawPhone(entry.itemName, `currentEntries[${index}].itemName`),
    })),
    currentClosure:
      input.currentClosure === undefined || input.currentClosure === null
        ? null
        : input.currentClosure.result === "reopen"
          ? { result: "reopen" }
          : input.currentClosure.closureKind === "seasonal"
            ? {
                result: "close",
                closureKind: "seasonal",
                startsOn: input.currentClosure.startsOn,
              }
            : {
                result: "close",
                closureKind: "temporary",
                startsOn: input.currentClosure.startsOn,
                ...(input.currentClosure.closedThrough !== undefined
                  ? { closedThrough: input.currentClosure.closedThrough }
                  : {}),
              },
  };

  return {
    seam: "inventory-extraction",
    fields,
    outputInstructions: outputInstructionsFor("inventory-extraction", {
      currentLocalDate: fields.currentLocalDate,
      closureTiming: fields.closureTiming,
    }),
  } as ModelSafeContext<InventoryExtractionFields>;
}

export type CatalogType = "inventory" | "payment";

/** The complete public vocabulary for one already-classified matching job. */
export interface CatalogMatchFields {
  readonly taskText: string;
  readonly catalogType: CatalogType;
  /** Unique public values only; which stands carry them stays behind the code boundary. */
  readonly values: readonly string[];
}

function uniquePublicNames(values: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === "" || seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return names;
}

/**
 * Project one post-classification catalog match (B-069).
 *
 * The model sees each public catalog name once and no stand association. It can decide which
 * values answer the request, but it cannot change the already-fixed operation, inconsistently
 * include two stands carrying the same value, or choose evidence type.
 */
export function projectCatalogMatch(input: {
  taskText: string;
  catalogType: CatalogType;
  values: readonly string[];
}): ModelSafeContext<CatalogMatchFields> {
  const fields: CatalogMatchFields = {
    taskText: input.taskText,
    catalogType: input.catalogType,
    values: uniquePublicNames(input.values).map((name, index) =>
      assertNoRawPhone(name, `values[${index}]`),
    ),
  };
  return {
    seam: "catalog-match",
    fields,
    outputInstructions: outputInstructionsFor("catalog-match"),
  } as ModelSafeContext<CatalogMatchFields>;
}

/**
 * The complete permitted input for the first-pass request classifier: ONE field.
 *
 * **Field NAMES are part of what was measured**, because under the classification framing each
 * becomes a labelled line the model reads. The text is called `message` rather than `taskText`
 * — the name it carried through the measurement.
 *
 * A `systemName` field carrying "Farm Friend" was here briefly and was **removed after
 * measurement** (max, 2026-08-13). It was added when the *harness* framing needed it — without
 * it, "what is farm friend", "what can farm friend do" and "who are you" all classified as
 * `unclear` 3/3 there. Under production transport an ablation showed it contributed nothing:
 * all four service-name cases pass without it, and removing it *improved* the baseline by
 * fixing "when does Plum Forest restock". A field that earns its place in one framing and not
 * another is not a field; it is a workaround for the framing.
 */
export interface RequestClassificationFields {
  /** The sender's own current message, verbatim — the only thing being classified. */
  readonly message: string;
}

/**
 * Project the first-pass request classifier: the sender's message, and nothing else.
 *
 * **Deliberately NO stand roster.** Max proposed passing the ~34 live stand names as
 * classification context, which is safe (a one-field output cannot leak a roster) and was a
 * reasonable idea. It was MEASURED and it made the classifier WORSE — twice, on two different
 * taxonomies: 94%→85% on the first, 87%→63% on the second. The failure was legible: with the
 * roster present, `Pinecone Gardens`, `where is Pinecone Gardens` and `does Misty Isle have
 * flowers` all returned `unclear` across every run, as though the model were checking the name
 * against the list and bailing rather than reading the sentence's shape. A classifier that
 * never sees the corpus also cannot drift as VIGA adds or removes sellers.
 *
 * **Deliberately NO sender type.** Whether the sender may publish is an access question code
 * answers downstream from `farmer_authorizations`. Absent here, it cannot be reasoned around.
 *
 * **Deliberately NO service name** — see `RequestClassificationFields`. Measured out.
 */
export function projectRequestClassification(input: {
  taskText: string;
}): ModelSafeContext<RequestClassificationFields> {
  return {
    seam: "request-classification",
    fields: { message: input.taskText },
    outputInstructions: outputInstructionsFor("request-classification"),
    // Declared here, at the seam that needs it — see `PromptFraming`. The default framing
    // costs this seam 6 of 47 cases; the adapter must not have to guess that.
    framing: "classification",
  } as ModelSafeContext<RequestClassificationFields>;
}

/**
 * A listed item the stock-out surface may offer as a match.
 *
 * Deliberately carries no source: code assembles these from the stand's published inventory
 * AND its usual offerings (B-057), and the model is not told which is which. It has no use for
 * the distinction — it selects an opaque identifier — and telling it would invite it to reason
 * about which kind of reference to prefer, a decision code owns.
 */
export interface ListedItemRef {
  entryId: string;
  itemName: string;
}

/** The complete permitted input for the stock-out item-parsing seam. */
export interface StockOutParseFields {
  /** The reporter's own free text describing what was missing. */
  readonly taskText: string;
  /**
   * Public listed items for the CODE-BOUND location, for matching only — what the stand
   * currently publishes plus what it usually carries, as one flat list (B-057).
   */
  readonly listedItems: readonly ListedItemRef[];
}

/**
 * Project the stock-out item-parsing seam: the reporter's text plus the public listed items
 * of the location the *surface* bound in code.
 *
 * Every name here is farmer-authored and already published to customers, which is why widening
 * the list to the stand's usual offerings changes nothing about the seam's trust: the model
 * still receives only Farm Friend-held facts, and still returns only an identifier from them.
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
    outputInstructions: outputInstructionsFor("stock-out-parse"),
  } as ModelSafeContext<StockOutParseFields>;
}

export interface OfferingExtractionFields {
  /** One stand's free-form description of what it typically carries. */
  readonly sourceText: string;
}

/**
 * Project the offering-extraction seam (F-035/F-036): one stand's "Generally Offers" prose.
 *
 * WHY THIS SEAM EXISTS. A regex can split "eggs, plant starts, veggies" but not
 * "Specializing in Asian vegetables, including gailan, bok choy, perilla" — and the failures
 * are not cosmetic, because every extracted item becomes a customer-facing filter tag. A
 * deterministic draft produced tags like "rotational grazing for chickens", "special
 * occasions...etc..", and "plums ijuly)". Deciding that "Asian vegetables" is an offering and
 * "but following organic practices" is not requires reading the sentence.
 *
 * WHAT IT IS TRUSTED WITH, AND WHAT IT IS NOT. It proposes item TAGS from text VIGA already
 * publishes. It never writes them: the seeder records proposals for human review and code
 * commits what was approved (Golden Rule #3). Proposed tags describe what a stand USUALLY
 * carries — they are never current stock, which only a farmer's own confirmed SMS establishes.
 *
 * The projection carries the description ALONE. No farm name, no location id, no contact, no
 * neighbouring stand's text. A model that could name a farm could attach one farm's produce to
 * another's listing, and the extraction task does not need the name to do its job.
 *
 * Note this seam is reachable from a build-time ingest script and, if F-036's farmer web form
 * lands, from a farmer editing their OWN listing. It is never reachable from anonymous public
 * discovery — that would be the model-backed web inquiry surface F-019 removed.
 */
export function projectOfferingExtraction(input: {
  sourceText: string;
}): ModelSafeContext<OfferingExtractionFields> {
  const fields: OfferingExtractionFields = {
    sourceText: assertNoRawPhone(input.sourceText, "sourceText"),
  };

  return {
    seam: "offering-extraction",
    fields,
    outputInstructions: outputInstructionsFor("offering-extraction"),
  } as ModelSafeContext<OfferingExtractionFields>;
}
