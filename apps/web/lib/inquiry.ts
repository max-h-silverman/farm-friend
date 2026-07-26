import {
  rankCandidates,
  renderClarificationRequest,
  renderGroundedAnswer,
  renderNoCurrentListing,
  validateFactSelection,
  validateInterpretedIntent,
  RECIPE_SCOPE_STATEMENT,
  type Clock,
  type InquiryCandidate,
  type RetrievedFact,
} from "@farm-friend/core";
import type { InquiryModel } from "@farm-friend/ai";
import type { Db } from "@farm-friend/db";

// Customer inquiry: question → code-rendered grounded answer.
//
// The sequence is fixed and code-owned (docs/AI_ARCHITECTURE.md §"Retrieval and ranking"):
//
//   1. deterministic routing has already run (compliance/confirmation never reach here)
//   2. MODEL interprets the question — what to look up, and how to order it
//   3. CODE validates that interpretation and retrieves authoritative facts
//   4. MODEL selects and orders identifiers from exactly those facts
//   5. CODE validates membership, dereferences values, and renders the answer
//
// Empty retrieval short-circuits at step 3: with nothing to select from, a model call could
// only invent, so the honest "no current listing" is rendered without one.

export interface InquiryDeps {
  db: Db;
  model: InquiryModel;
  clock: Clock;
}

export type InquiryOutcome =
  /** A code-rendered authoritative answer, ready for the outbox. */
  | { outcome: "answered"; body: string; selectedFactIds: string[] }
  /** A code-controlled question back to the customer. */
  | { outcome: "clarification"; question: string }
  /** Model output code refused; nothing is delivered as fact. */
  | { outcome: "rejected"; reason: string };

interface LocationRow {
  factId: string;
  farmName: string;
  locationName: string;
  publicAddress: string;
  asOf: Date;
  items: {
    itemName: string;
    quantity?: number;
    unit?: string;
    priceText?: string;
    approximation?: "some" | "limited" | "plentiful";
  }[];
}

/**
 * Retrieve every public location's current published inventory. Retrieval is deliberately
 * general — it selects rows, and the ranking layer filters and orders them. There is no food
 * vocabulary or farm name in this query.
 */
async function retrieveCurrentListings(db: Db): Promise<LocationRow[]> {
  const rows = await db.sql`
    select
      l.id as location_id,
      l.name as location_name,
      l.public_address as public_address,
      f.name as farm_name,
      r.published_at as published_at,
      e.item_name as item_name,
      e.quantity as quantity,
      e.unit as unit,
      e.price_text as price_text,
      e.approximation as approximation,
      e.sort_order as sort_order
    from sales_locations l
    join farms f on f.id = l.farm_id
    join inventory_revisions r
      on r.sales_location_id = l.id and r.is_current
    join inventory_entries e on e.inventory_revision_id = r.id
    where l.is_public
    order by l.id asc, e.sort_order asc
  `;

  const byLocation = new Map<string, LocationRow>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const locationId = row.location_id as string;

    let entry = byLocation.get(locationId);
    if (!entry) {
      entry = {
        factId: locationId,
        farmName: row.farm_name as string,
        locationName: row.location_name as string,
        publicAddress: row.public_address as string,
        asOf: row.published_at as Date,
        items: [],
      };
      byLocation.set(locationId, entry);
    }

    entry.items.push({
      itemName: row.item_name as string,
      ...(row.quantity !== null ? { quantity: Number(row.quantity) } : {}),
      ...(row.unit !== null ? { unit: row.unit as string } : {}),
      ...(row.price_text !== null ? { priceText: row.price_text as string } : {}),
      ...(row.approximation !== null
        ? { approximation: row.approximation as "some" | "limited" | "plentiful" }
        : {}),
    });
  }

  return [...byLocation.values()];
}

/**
 * Answer a customer inquiry. Every factual word returned is rendered by code from typed
 * authoritative values; the model contributes interpretation and ordering only.
 */
export async function answerInquiry(
  deps: InquiryDeps,
  input: { taskText: string },
): Promise<InquiryOutcome> {
  // Step 2 — interpret. This call sees the question and no facts.
  const rawIntent = await deps.model.interpret({ taskText: input.taskText });

  const intent = validateInterpretedIntent(rawIntent);
  if (!intent.ok) {
    return { outcome: "rejected", reason: intent.reason };
  }
  if (intent.value.kind === "ambiguous") {
    // The model signalled; the words are code's.
    return { outcome: "clarification", question: renderClarificationRequest() };
  }

  // F-018. The model may recognize that the request also asked for a recipe, cooking or
  // preservation instructions, or food-safety guidance. Farm Friend still answers the
  // grounded availability half from typed facts, then states the launch boundary — in
  // code-rendered text appended below, never anything the model composed.
  const scopeNote = intent.value.outOfScopeRequest ? RECIPE_SCOPE_STATEMENT : undefined;
  const withScope = (body: string): string =>
    scopeNote === undefined ? body : `${body}\n\n${scopeNote}`;

  // Step 3 — CODE retrieves, then ranks by the validated interpretation.
  const listings = await retrieveCurrentListings(deps.db);
  const candidates: InquiryCandidate[] = listings.map((row) => ({
    factId: row.factId,
    farmName: row.farmName,
    locationName: row.locationName,
    matchedItemNames: row.items.map((item) => item.itemName),
    asOf: row.asOf,
  }));

  const ranked = rankCandidates(candidates, {
    ranking: intent.value.ranking,
    items: intent.value.items,
    ...(intent.value.farmScope !== undefined
      ? { farmScope: intent.value.farmScope }
      : {}),
  });

  if (ranked.length === 0) {
    // No grounded-selection call: there is nothing to select from, so asking a model could
    // only produce invention. The honest answer is code's.
    //
    // A recipe request with nothing available still lands here, and still gets only the
    // code-rendered "no current listing" plus the scope statement — never a model-authored
    // substitute offered in place of the facts we do not have.
    return {
      outcome: "answered",
      body: withScope(renderNoCurrentListing(intent.value.items)),
      selectedFactIds: [],
    };
  }

  // Only the matched items reach the renderer, so an answer about kale does not list eggs.
  const wanted = new Set(intent.value.items.map((item) => item.trim().toLowerCase()));
  const byId = new Map(listings.map((row) => [row.factId, row]));
  const retrieved: RetrievedFact[] = ranked.map((candidate) => {
    const row = byId.get(candidate.factId)!;
    return {
      factId: row.factId,
      locationName: row.locationName,
      farmName: row.farmName,
      publicAddress: row.publicAddress,
      matchedItems: row.items.filter((item) =>
        wanted.has(item.itemName.trim().toLowerCase()),
      ),
      asOf: row.asOf,
    };
  });

  // Step 4 — select. This call sees the retrieved facts and NOT the raw question.
  const now = deps.clock.now();
  const rawSelection = await deps.model.select({
    items: intent.value.items,
    ranking: intent.value.ranking,
    facts: retrieved.map((fact) => ({
      factId: fact.factId,
      farmName: fact.farmName,
      locationName: fact.locationName,
      matchedItemNames: fact.matchedItems.map((item) => item.itemName),
      ageHours: Math.max(
        0,
        Math.floor((now.getTime() - fact.asOf.getTime()) / 3_600_000),
      ),
    })),
  });

  // Step 5 — CODE validates membership and renders.
  if ("kind" in rawSelection && rawSelection.kind === "refused") {
    // The seam refused the model's shape. A rejected shape (typically a smuggled factual
    // string) is reported as such so an attack is observable; a transient provider error
    // asks the customer, because "no current listing" would be a factual claim we cannot
    // support from a failed call.
    return rawSelection.reason === "invalid_output"
      ? { outcome: "rejected", reason: "selection carries only ordered fact identifiers" }
      : {
          outcome: "clarification",
          question: renderClarificationRequest(),
        };
  }

  const selection = validateFactSelection(rawSelection, retrieved);
  if (!selection.ok) {
    return { outcome: "rejected", reason: selection.reason };
  }
  if (selection.value.kind === "clarification") {
    return { outcome: "clarification", question: renderClarificationRequest() };
  }
  if (selection.value.factIds.length === 0) {
    return {
      outcome: "answered",
      body: withScope(renderNoCurrentListing(intent.value.items)),
      selectedFactIds: [],
    };
  }

  return {
    outcome: "answered",
    body: withScope(renderGroundedAnswer(selection.value.factIds, retrieved, deps.clock)),
    selectedFactIds: selection.value.factIds,
  };
}
