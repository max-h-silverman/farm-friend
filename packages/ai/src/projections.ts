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
// choosing. Six projections exist, for the seams that have real consumers: farmer-message
// intent, inventory extraction (F-015), inquiry interpretation, grounded fact selection,
// stock-out item parsing (F-013), and offering extraction (F-035).
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
  "farmer-message-intent": [
    '{"kind":"inventory_update"}',
    '{"kind":"farm_stand_question"}',
    '{"kind":"unclear"}',
  ],
  "customer-message-intent": [
    '{"kind":"stock_out_report"}',
    '{"kind":"farm_stand_question"}',
  ],
  "inventory-extraction": [
    '{"kind":"edits","additions":[{"itemName":"ITEM_NAME","quantity":12,"unit":"UNIT","priceText":"PRICE","approximation":"plentiful"}],"changes":[{"entryId":"ENTRY_ID","quantity":6}],"removals":[{"entryId":"ENTRY_ID"}],"closure":{"result":"close","closureKind":"temporary","startsOn":"START_DATE","closedThrough":"END_DATE"}}',
    '{"kind":"clear_all"}',
    '{"kind":"closure","closure":{"result":"close","closureKind":"seasonal","startsOn":"START_DATE"}}',
    '{"kind":"closure","closure":{"result":"reopen"}}',
    '{"kind":"clarification","question":"Could you list what your stand has right now?"}',
  ],
  "inquiry-interpretation": [
    '{"kind":"lookup","items":["bok choy","green beans"],"farmScope":"Provo Farms","ranking":"freshest","broad":false,"outOfScopeRequest":false,"originDependent":false}',
    '{"kind":"ambiguous"}',
  ],
  "grounded-fact-selection": [
    '{"kind":"selection","factIds":["loc-1","loc-2"],"matchedItems":{"loc-1":["butter lettuce"],"loc-2":["kale"]}}',
    '{"kind":"selection","factIds":[]}',
    '{"kind":"clarification"}',
  ],
  "stock-out-parse": [
    '{"kind":"listed","entryId":"e1"}',
    '{"kind":"unlisted","itemText":"strawberries"}',
    '{"kind":"unclear"}',
  ],
  "offering-extraction": ['{"items":["eggs","bok choy","cut flowers"]}'],
  "request-classification": [
    '{"kind":"search_stands"}',
    '{"kind":"stand_lookup"}',
    '{"kind":"inventory_report"}',
    '{"kind":"system_inquiry"}',
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
  "farmer-message-intent":
    "Classify the authorized farmer's message as inventory_update when they are reporting " +
    "what a stand has, sold out of, or will have - a statement about THEIR OWN stock. " +
    "Classify it as farm_stand_question when they are asking what a stand has, where a stand " +
    "is, when it is open, or looking for a product to buy - a request for information. A " +
    "message that merely names or asks after a product (\"looking for nigella\", \"anyone " +
    "have plums\", \"nigella?\") is a question, not an update: a farmer also shops at other " +
    "stands. When you cannot clearly tell, choose farm_stand_question - it answers from real " +
    "listings and is safe for either sender. Use unclear only as a last resort, when the " +
    "message says nothing about stock and asks nothing at all. Return only the classification " +
    "signal. Do not interpret the inventory, choose a stand, or write a reply.",
  "customer-message-intent":
    "Classify the customer's message as stock_out_report when they are telling you an item " +
    "is gone, sold out, empty, or unavailable at a stand they visited - a statement about " +
    "what they FOUND. Classify it as farm_stand_question when they are asking what a stand " +
    "has, where a stand is, when it is open, or anything else - a request for information. " +
    "A message that merely names a product is a question, not a report. When you cannot " +
    "clearly tell, choose farm_stand_question. Return only the classification signal. Do " +
    "not name a stand or farm, choose a recipient, interpret the inventory, or write a reply.",
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
  "inquiry-interpretation":
    "items are the product words the customer asks about, as plain nouns. Correct obvious " +
    'misspellings ("tomatos" -> "tomatoes", "kayle" -> "kale"). A message that is only a ' +
    'product word is a request for it ("garlic?" -> items ["garlic"]), and so is one that ' +
    "asks about price, cost, or availability of a product - answer the product half and let " +
    "code state what it cannot answer. ranking MUST be " +
    'exactly "freshest", "coverage", or "any": "coverage" when they want places carrying ' +
    'the most of their items, "freshest" when recency matters most, "any" otherwise. ' +
    "farmScope only when they name a specific farm; when they name a farm and no product, " +
    'set farmScope and use the broad item ["produce"] so the whole stand can answer. ' +
    "Set broad true whenever they ask what is generally available with no named product, " +
    'whether or not they name a farm; use ["produce"] for that request. broad is false for ' +
    "a named product or category, even when many stands may carry it. outOfScopeRequest is " +
    "true when they " +
    "also ask for a recipe, preparation, or food-safety guidance. originDependent is true " +
    "whenever answering depends on where the customer is (nearest, closest, distance, " +
    'directions), INCLUDING when they name no product - "what is closest to me?" is ' +
    'originDependent with items ["produce"], never ambiguous. Return the ambiguous shape ' +
    "ONLY for a message that asks for no product, names no farm, and makes no availability " +
    'request at all - a greeting, a thank-you, or chat ("hi", "thanks", "are you a robot").',
  "grounded-fact-selection":
    "factIds MUST be values from facts, ordered best match first; select only facts that " +
    "answer the request. Code no longer pre-filters by item name, so facts includes stands " +
    "that do not answer the request at all - judge each one. Match by MEANING, not spelling: " +
    'a request for a category selects the facts whose items belong to it (a request for ' +
    '"leafy greens" selects a stand listing "butter lettuce"; "root vegetables" selects one ' +
    'listing "beets"), and a request for a specific item selects stands listing it under any ' +
    'wording ("lamb" selects "frozen lamb"). basis is "confirmed" when a farmer confirmed the ' +
    'stock and "offering" when the stand merely lists it as typical; select BOTH kinds when ' +
    "both answer the request, ordering confirmed facts first. If the request is clear but " +
    "nothing here sells it, return the selection shape with an EMPTY factIds array - that is " +
    "how you say nobody carries it. Reserve the clarification shape for a request you cannot " +
    "interpret at all; returning it for an item nobody stocks tells the customer they mistyped " +
    "when they did not. " +
    "Also return matchedItems: an object keyed by each selected factId, whose value lists " +
    "WHICH of that fact's matchedItemNames answered the request - copy those names EXACTLY as " +
    'given ("butter lettuce" for a leafy-greens request, "frozen lamb" for lamb). Include only ' +
    "names present in that fact's own matchedItemNames; never invent an item, and never move " +
    "an item from one fact to another.",
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
    "Classify the message into exactly one category.\n\n" +
    "search_stands: asking which stand(s) meet a need or asking generally about stands, " +
    "including availability, payment, hours, or other stand information.\n" +
    "stand_lookup: asking for information about one specific stand.\n" +
    "inventory_report: stating that items are available, unavailable, sold out, or coming " +
    "soon, whether or not a stand is named.\n" +
    "system_inquiry: asking what the service is, how it works, what it can do, or about the " +
    "map.\n" +
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
    "- Use unclear only when no other category reasonably fits.",
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

/** The complete permitted input for the inquiry-interpretation seam. */
export interface InquiryInterpretationFields {
  /** The current customer's own question, verbatim. */
  readonly taskText: string;
}

/** The complete permitted input for the authorized-farmer message-intent seam. */
export interface FarmerMessageIntentFields {
  /** The authorized farmer's own current message, verbatim. */
  readonly taskText: string;
}

/** Project only the authorized farmer's current message for route classification. */
export function projectFarmerMessageIntent(input: {
  taskText: string;
}): ModelSafeContext<FarmerMessageIntentFields> {
  return {
    seam: "farmer-message-intent",
    fields: { taskText: input.taskText },
    outputInstructions: outputInstructionsFor("farmer-message-intent"),
  } as ModelSafeContext<FarmerMessageIntentFields>;
}

/** The complete permitted input for the customer message-intent seam. */
export interface CustomerMessageIntentFields {
  /** The customer's own current message, verbatim. */
  readonly taskText: string;
}

/**
 * Project only the customer's current message for route classification.
 *
 * Deliberately NO stand list, no farm names, and no sender hash. This call decides whether a
 * message is a report or a question; handing it stands would let it name one, and which stand
 * a report belongs to is code's from the customer's own answer (Golden Rule #1).
 */
export function projectCustomerMessageIntent(input: {
  taskText: string;
}): ModelSafeContext<CustomerMessageIntentFields> {
  return {
    seam: "customer-message-intent",
    fields: { taskText: input.taskText },
    outputInstructions: outputInstructionsFor("customer-message-intent"),
  } as ModelSafeContext<CustomerMessageIntentFields>;
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
 * never sees the corpus also cannot drift as VIGA adds or removes farms.
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
    outputInstructions: outputInstructionsFor("inquiry-interpretation"),
  } as ModelSafeContext<InquiryInterpretationFields>;
}

/** A retrieved fact as the selection seam is permitted to see it. */
export interface RetrievedFactRef {
  factId: string;
  farmName: string;
  locationName: string;
  matchedItemNames: readonly string[];
  /**
   * Age in hours, derived in code. A clock is code's, never the model's to infer.
   * Omitted for an `offering`, which nobody confirmed and which therefore has no age.
   */
  ageHours?: number;
  /**
   * Whether a farmer confirmed this inventory or the stand merely lists it as typical
   * (F-045). The model needs it to rank — a confirmed listing is the better answer — and
   * code needs it to render the right voice. It is a closed enum code assigns, never text.
   */
  basis: "confirmed" | "offering";
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
      // Copied only when code derived one. An offering carries no age, and sending a
      // fabricated zero would invite the model to read it as "just confirmed".
      ...(fact.ageHours !== undefined ? { ageHours: fact.ageHours } : {}),
      basis: fact.basis,
    })),
  };

  return {
    seam: "grounded-fact-selection",
    fields,
    outputInstructions: outputInstructionsFor("grounded-fact-selection"),
  } as ModelSafeContext<FactSelectionFields>;
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
